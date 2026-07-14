require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Server } = require('socket.io');
const { pool } = require('./src/db');
const { signUser, verifyToken, authMiddleware } = require('./src/auth');
const { interpretMessage } = require('./src/ai');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 2 * 1024 * 1024,
  pingInterval: 25000,
  pingTimeout: 20000,
});

const PORT = Number(process.env.PORT || 4100);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024) },
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const onlineUsers = new Map();

function userIsOnline(userId) {
  return Number(onlineUsers.get(String(userId)) || 0) > 0;
}

const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = String(process.env.VAPID_SUBJECT || 'mailto:admin@417maid.com').trim();

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}


function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    code: row.employee_code,
    role: row.role,
    avatarUrl: row.avatar_url || '',
  };
}

function normalizeRole(role) {
  return String(role || '').trim().toLowerCase();
}

function isAdminRole(role) {
  return ['admin','manager','owner','company owner','operations','dispatch'].includes(normalizeRole(role));
}

function configuredAdminCodes() {
  return new Set(
    String(process.env.ADMIN_CODES || process.env.ADMIN_CODE || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

async function fetchOSUser(code) {
  const baseUrl = String(process.env.OS_BASE_URL || 'https://bot-dispatch.onrender.com').replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(`${baseUrl}/login-role?code=${encodeURIComponent(code)}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok || data.active === false) {
      const error = new Error(data.message || 'Código no encontrado en 417 Maid OS');
      error.status = response.status || 401;
      throw error;
    }

    const adminCodes = configuredAdminCodes();
    const role = adminCodes.has(String(data.code || code)) ? 'admin' : String(data.role || 'cleaner');

    return {
      externalId: data.id || null,
      name: String(data.name || code).trim(),
      code: String(data.code || code).trim(),
      role,
      active: data.active !== false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function upsertOSUser(osUser) {
  const result = await pool.query(
    `INSERT INTO users (name, employee_code, pin_hash, role, active, source, external_id)
     VALUES ($1,$2,'', $3,$4,'417-maid-os',$5)
     ON CONFLICT (employee_code)
     DO UPDATE SET
       name=EXCLUDED.name,
       role=EXCLUDED.role,
       active=EXCLUDED.active,
       source='417-maid-os',
       external_id=COALESCE(EXCLUDED.external_id, users.external_id),
       updated_at=NOW()
     RETURNING *`,
    [osUser.name, osUser.code, osUser.role, osUser.active, osUser.externalId]
  );
  return result.rows[0];
}

async function ensureAdminMemberships(adminId) {
  await pool.query(
    `INSERT INTO conversation_members (conversation_id,user_id,member_role)
     SELECT c.id,$1,'admin'
     FROM conversations c
     WHERE c.type='admin_employee'
     ON CONFLICT (conversation_id,user_id)
     DO UPDATE SET member_role='admin'`,
    [adminId]
  );
}

async function ensureEmployeeAdminConversation(employee) {
  if (isAdminRole(employee.role)) {
    await ensureAdminMemberships(employee.id);
    return null;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const created = await client.query(
      `INSERT INTO conversations (name,type,department,created_by,employee_owner_id)
       VALUES ($1,'admin_employee','Administración',$2,$2)
       ON CONFLICT (employee_owner_id) WHERE employee_owner_id IS NOT NULL
       DO UPDATE SET name=EXCLUDED.name, updated_at=NOW()
       RETURNING *`,
      [`${employee.name} · Administración`, employee.id]
    );

    const conversation = created.rows[0];

    await client.query(
      `INSERT INTO conversation_members (conversation_id,user_id,member_role)
       VALUES ($1,$2,'employee')
       ON CONFLICT (conversation_id,user_id)
       DO UPDATE SET member_role='employee'`,
      [conversation.id, employee.id]
    );

    await client.query(
      `INSERT INTO conversation_members (conversation_id,user_id,member_role)
       SELECT $1,u.id,'admin'
       FROM users u
       WHERE u.active=TRUE AND LOWER(u.role) IN ('admin','manager','owner','company owner','operations','dispatch')
       ON CONFLICT (conversation_id,user_id)
       DO UPDATE SET member_role='admin'`,
      [conversation.id]
    );

    await client.query('COMMIT');
    return conversation;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function isConversationMember(conversationId, userId) {
  const result = await pool.query(
    `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  return result.rowCount > 0;
}


async function hydrateMessage(message) {
  if (!message) return message;

  const [replyResult, reactionsResult, receiptsResult] = await Promise.all([
    message.reply_to_id
      ? pool.query(
          `SELECT m.id,m.body,m.message_type,m.attachment_name,u.name AS sender_name
           FROM messages m
           LEFT JOIN users u ON u.id=m.sender_id
           WHERE m.id=$1`,
          [message.reply_to_id]
        )
      : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT emoji,COUNT(*)::int AS count,
              BOOL_OR(user_id=$2) AS reacted_by_me
       FROM message_reactions
       WHERE message_id=$1
       GROUP BY emoji
       ORDER BY emoji`,
      [message.id, message.current_user_id || null]
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered_count,
         COUNT(*) FILTER (WHERE read_at IS NOT NULL)::int AS read_count,
         COUNT(*)::int AS receipt_count
       FROM message_receipts
       WHERE message_id=$1`,
      [message.id]
    ),
  ]);

  const receipts = receiptsResult.rows[0] || {};
  return {
    ...message,
    reply_to: replyResult.rows[0] || null,
    reactions: reactionsResult.rows || [],
    delivered_count: Number(receipts.delivered_count || 0),
    read_count: Number(receipts.read_count || 0),
    receipt_count: Number(receipts.receipt_count || 0),
  };
}

async function createReceipts(messageId, conversationId, senderId) {
  await pool.query(
    `INSERT INTO message_receipts(message_id,user_id,delivered_at,read_at)
     SELECT $1,cm.user_id,
            CASE WHEN $4 THEN NOW() ELSE NULL END,
            NULL
     FROM conversation_members cm
     WHERE cm.conversation_id=$2 AND cm.user_id<>$3
     ON CONFLICT (message_id,user_id) DO NOTHING`,
    [messageId, conversationId, senderId, FALSE]
  );
}


async function markMessageDeliveredToOnlineMembers(messageId, conversationId, senderId) {
  const members = await pool.query(
    `SELECT user_id
     FROM conversation_members
     WHERE conversation_id=$1 AND user_id<>$2`,
    [conversationId, senderId]
  );

  const onlineIds = members.rows
    .map(row => row.user_id)
    .filter(userId => userIsOnline(userId));

  if (!onlineIds.length) return;

  const result = await pool.query(
    `UPDATE message_receipts
     SET delivered_at=COALESCE(delivered_at,NOW())
     WHERE message_id=$1
       AND user_id=ANY($2::uuid[])
     RETURNING user_id,delivered_at`,
    [messageId, onlineIds]
  );

  for (const row of result.rows) {
    io.to(`conversation:${conversationId}`).emit('message:receipt', {
      messageId,
      userId: row.user_id,
      deliveredAt: row.delivered_at,
    });
  }
}

async function markDeliveredForUser(userId) {
  const result = await pool.query(
    `UPDATE message_receipts mr
     SET delivered_at=COALESCE(mr.delivered_at,NOW())
     FROM messages m
     WHERE mr.message_id=m.id
       AND mr.user_id=$1
       AND mr.delivered_at IS NULL
     RETURNING mr.message_id`,
    [userId]
  );

  for (const row of result.rows) {
    const conversation = await pool.query(
      `SELECT conversation_id FROM messages WHERE id=$1`,
      [row.message_id]
    );
    if (conversation.rows[0]) {
      io.to(`conversation:${conversation.rows[0].conversation_id}`).emit('message:receipt', {
        messageId: row.message_id,
        userId,
        deliveredAt: new Date().toISOString(),
      });
    }
  }
}

async function markConversationRead(conversationId, userId) {
  const result = await pool.query(
    `UPDATE message_receipts mr
     SET delivered_at=COALESCE(mr.delivered_at,NOW()),
         read_at=COALESCE(mr.read_at,NOW())
     FROM messages m
     WHERE mr.message_id=m.id
       AND m.conversation_id=$1
       AND mr.user_id=$2
       AND mr.read_at IS NULL
     RETURNING mr.message_id`,
    [conversationId, userId]
  );

  await pool.query(
    `UPDATE conversation_members
     SET last_read_at=NOW()
     WHERE conversation_id=$1 AND user_id=$2`,
    [conversationId, userId]
  );

  const now = new Date().toISOString();
  for (const row of result.rows) {
    io.to(`conversation:${conversationId}`).emit('message:receipt', {
      messageId: row.message_id,
      userId,
      deliveredAt: now,
      readAt: now,
    });
  }

  return result.rowCount;
}

async function sendPushToConversationMembers({ conversationId, senderId, title, body, url }) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;

  const result = await pool.query(
    `SELECT ps.id,ps.user_id,ps.subscription
     FROM push_subscriptions ps
     JOIN conversation_members cm ON cm.user_id=ps.user_id
     WHERE cm.conversation_id=$1 AND ps.user_id<>$2`,
    [conversationId, senderId]
  );

  const payload = JSON.stringify({
    title,
    body,
    url: url || '/',
    conversationId,
  });

  await Promise.all(
    result.rows.map(async row => {
      if (userIsOnline(row.user_id)) return;

      try {
        await webpush.sendNotification(row.subscription, payload);
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await pool.query(`DELETE FROM push_subscriptions WHERE id=$1`, [row.id]);
        } else {
          console.warn('Push error:', error.message);
        }
      }
    })
  );
}

async function saveAiAction(message, user) {
  if (!message.body || message.message_type !== 'text') return null;

  const action = await interpretMessage(message.body);
  const meaningful = action.requestType && action.requestType !== 'MESSAGE';
  if (!meaningful) return null;

  const result = await pool.query(
    `INSERT INTO ai_actions
      (message_id, conversation_id, requester_id, unit, department, request_type, items, priority, summary, confidence, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)
     ON CONFLICT (message_id) DO UPDATE SET
       unit=EXCLUDED.unit,
       department=EXCLUDED.department,
       request_type=EXCLUDED.request_type,
       items=EXCLUDED.items,
       priority=EXCLUDED.priority,
       summary=EXCLUDED.summary,
       confidence=EXCLUDED.confidence,
       raw=EXCLUDED.raw,
       updated_at=NOW()
     RETURNING *`,
    [
      message.id,
      message.conversation_id,
      user.id,
      action.unit,
      action.department,
      action.requestType,
      JSON.stringify(action.items || []),
      action.priority,
      action.summary,
      action.confidence,
      JSON.stringify(action),
    ]
  );

  await pool.query(`UPDATE messages SET ai_processed = TRUE WHERE id = $1`, [message.id]);
  const saved = result.rows[0];
  io.to('role:admin').emit('ai-action:new', saved);
  io.to('role:manager').emit('ai-action:new', saved);
  return saved;
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: '417-maid-chat', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ ok: false, message: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const code = String(req.body.code || '').trim();

    if (!code) {
      return res.status(400).json({ ok: false, message: 'Código requerido' });
    }

    const osUser = await fetchOSUser(code);
    const user = await upsertOSUser(osUser);

    if (!user.active) {
      return res.status(403).json({ ok: false, message: 'Empleado inactivo' });
    }

    await ensureEmployeeAdminConversation(user);

    res.json({ ok: true, token: signUser(user), user: publicUser(user) });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(error.status || 401).json({ ok: false, message: error.message || 'No se pudo iniciar sesión' });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const result = await pool.query(
    `SELECT id,name,employee_code,role,avatar_url FROM users WHERE id=$1 AND active=TRUE`,
    [req.auth.sub]
  );
  if (!result.rows[0]) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
  res.json({ ok: true, user: publicUser(result.rows[0]) });
});

app.get('/api/conversations', authMiddleware, async (req, res) => {
  const result = await pool.query(
    `SELECT c.id,
            CASE WHEN $2 = FALSE THEN 'Administración' ELSE COALESCE(owner.name,c.name) END AS name,
            c.type,c.department,c.unit,c.updated_at,c.employee_owner_id,
            COALESCE(last_message.body,'') AS last_message,
            last_message.created_at AS last_message_at,
            owner.role AS employee_role,
            owner.avatar_url AS employee_avatar
     FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=$1
     LEFT JOIN users owner ON owner.id=c.employee_owner_id
     LEFT JOIN LATERAL (
       SELECT body,created_at FROM messages m
       WHERE m.conversation_id=c.id AND m.deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1
     ) last_message ON TRUE
     WHERE c.type='admin_employee'
     ORDER BY COALESCE(last_message.created_at,c.updated_at) DESC`,
    [req.auth.sub, isAdminRole(req.auth.role)]
  );
  res.json({ ok: true, conversations: result.rows });
});

app.post('/api/conversations', authMiddleware, async (req, res) => {
  if (!isAdminRole(req.auth.role)) {
    return res.status(403).json({ ok: false, message: 'Solo administración puede crear conversaciones' });
  }

  const name = String(req.body.name || '').trim();
  const type = String(req.body.type || 'group').trim();
  const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];

  if (!name) return res.status(400).json({ ok: false, message: 'Nombre requerido' });
  if (!['group','direct','room','department','admin_employee'].includes(type)) {
    return res.status(400).json({ ok: false, message: 'Tipo inválido' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query(
      `INSERT INTO conversations(name,type,department,unit,created_by)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [name, type, req.body.department || null, req.body.unit || null, req.auth.sub]
    );
    const conversation = created.rows[0];
    const allMembers = [...new Set([req.auth.sub, ...memberIds])];
    for (const userId of allMembers) {
      await client.query(
        `INSERT INTO conversation_members(conversation_id,user_id,member_role)
         VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [conversation.id, userId, userId === req.auth.sub ? 'admin' : 'member']
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, conversation });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create conversation error:', error.message);
    res.status(500).json({ ok: false, message: 'No se pudo crear la conversación' });
  } finally {
    client.release();
  }
});

app.get('/api/conversations/:id/messages', authMiddleware, async (req, res) => {
  if (!(await isConversationMember(req.params.id, req.auth.sub))) {
    return res.status(403).json({ ok: false, message: 'Sin acceso' });
  }

  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  const values = [req.params.id, limit];
  let beforeSql = '';

  if (before && !Number.isNaN(before.getTime())) {
    values.push(before.toISOString());
    beforeSql = `AND m.created_at < $3`;
  }

  const result = await pool.query(
    `SELECT m.*,u.name AS sender_name,u.role AS sender_role,u.avatar_url AS sender_avatar
     FROM messages m
     LEFT JOIN users u ON u.id=m.sender_id
     WHERE m.conversation_id=$1 AND m.deleted_at IS NULL ${beforeSql}
     ORDER BY m.created_at DESC LIMIT $2`,
    values
  );

  const messages = [];
  for (const row of result.rows.reverse()) {
    messages.push(await hydrateMessage({ ...row, current_user_id: req.auth.sub }));
  }

  res.json({ ok: true, messages });
});

app.get('/api/conversations/:id/search', authMiddleware, async (req, res) => {
  if (!(await isConversationMember(req.params.id, req.auth.sub))) {
    return res.status(403).json({ ok: false, message: 'Sin acceso' });
  }

  const query = String(req.query.q || '').trim();
  if (!query) return res.json({ ok: true, messages: [] });

  const result = await pool.query(
    `SELECT m.*,u.name AS sender_name
     FROM messages m
     LEFT JOIN users u ON u.id=m.sender_id
     WHERE m.conversation_id=$1
       AND m.deleted_at IS NULL
       AND (
         m.body ILIKE '%' || $2 || '%'
         OR COALESCE(m.attachment_name,'') ILIKE '%' || $2 || '%'
       )
     ORDER BY m.created_at DESC
     LIMIT 100`,
    [req.params.id, query]
  );

  res.json({ ok: true, messages: result.rows });
});

app.get('/api/push/public-key', authMiddleware, (_req, res) => {
  res.json({ ok: true, publicKey: VAPID_PUBLIC_KEY || null });
});

app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  const subscription = req.body.subscription;
  if (!subscription?.endpoint) {
    return res.status(400).json({ ok: false, message: 'Suscripción inválida' });
  }

  await pool.query(
    `INSERT INTO push_subscriptions(user_id,endpoint,subscription)
     VALUES($1,$2,$3::jsonb)
     ON CONFLICT(endpoint)
     DO UPDATE SET
       user_id=EXCLUDED.user_id,
       subscription=EXCLUDED.subscription,
       updated_at=NOW()`,
    [req.auth.sub, subscription.endpoint, JSON.stringify(subscription)]
  );

  res.json({ ok: true });
});

app.post('/api/conversations/:id/read', authMiddleware, async (req, res) => {
  if (!(await isConversationMember(req.params.id, req.auth.sub))) {
    return res.status(403).json({ ok: false, message: 'Sin acceso' });
  }

  const count = await markConversationRead(req.params.id, req.auth.sub);
  res.json({ ok: true, count });
});

app.post('/api/messages/:id/reactions', authMiddleware, async (req, res) => {
  const emoji = String(req.body.emoji || '').trim();
  if (!emoji || emoji.length > 12) {
    return res.status(400).json({ ok: false, message: 'Reacción inválida' });
  }

  const access = await pool.query(
    `SELECT m.conversation_id
     FROM messages m
     JOIN conversation_members cm
       ON cm.conversation_id=m.conversation_id
      AND cm.user_id=$2
     WHERE m.id=$1`,
    [req.params.id, req.auth.sub]
  );

  if (!access.rows[0]) {
    return res.status(403).json({ ok: false, message: 'Sin acceso' });
  }

  const existing = await pool.query(
    `SELECT emoji FROM message_reactions WHERE message_id=$1 AND user_id=$2`,
    [req.params.id, req.auth.sub]
  );

  if (existing.rows[0]?.emoji === emoji) {
    await pool.query(
      `DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2`,
      [req.params.id, req.auth.sub]
    );
  } else {
    await pool.query(
      `INSERT INTO message_reactions(message_id,user_id,emoji)
       VALUES($1,$2,$3)
       ON CONFLICT(message_id,user_id)
       DO UPDATE SET emoji=EXCLUDED.emoji,created_at=NOW()`,
      [req.params.id, req.auth.sub, emoji]
    );
  }

  const reactions = await pool.query(
    `SELECT emoji,COUNT(*)::int AS count
     FROM message_reactions
     WHERE message_id=$1
     GROUP BY emoji
     ORDER BY emoji`,
    [req.params.id]
  );

  io.to(`conversation:${access.rows[0].conversation_id}`).emit('message:reactions', {
    messageId: req.params.id,
    reactions: reactions.rows,
  });

  res.json({ ok: true, reactions: reactions.rows });
});

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);
const MAX_FILES_PER_BATCH = Number(process.env.MAX_FILES_PER_BATCH || 10);
const ALLOWED_UPLOAD_MIME_PREFIXES = ['image/', 'video/', 'audio/'];
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/x-zip-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

function isAllowedUpload(file) {
  const mime = String(file?.mimetype || '').toLowerCase();
  return ALLOWED_UPLOAD_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix)) || ALLOWED_UPLOAD_MIME_TYPES.has(mime);
}

function cloudinaryResourceType(mime) {
  if (String(mime).startsWith('image/')) return 'image';
  if (String(mime).startsWith('video/') || String(mime).startsWith('audio/')) return 'video';
  return 'raw';
}

app.get('/api/upload/config', authMiddleware, (_req, res) => {
  res.json({
    ok: true,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    maxFilesPerBatch: MAX_FILES_PER_BATCH,
    cloudinaryConfigured: Boolean(process.env.CLOUDINARY_CLOUD_NAME),
  });
});

app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'Archivo requerido' });
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    return res.status(503).json({ ok: false, message: 'Cloudinary no está configurado' });
  }
  if (req.file.size > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ ok: false, message: `El archivo supera el límite de ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB` });
  }
  if (!isAllowedUpload(req.file)) {
    return res.status(415).json({ ok: false, message: 'Este tipo de archivo no está permitido' });
  }

  try {
    const resourceType = cloudinaryResourceType(req.file.mimetype);
    const publicIdBase = `${Date.now()}-${String(req.file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)}`;

    const result = await new Promise((resolve, reject) => {
      const options = {
        folder: `417-maid-chat/${new Date().toISOString().slice(0, 7)}`,
        resource_type: resourceType,
        public_id: publicIdBase,
        overwrite: false,
        unique_filename: true,
        use_filename: false,
        invalidate: false,
        context: `original_filename=${encodeURIComponent(req.file.originalname || 'file')}`,
      };

      const stream = cloudinary.uploader.upload_stream(
        options,
        (error, uploaded) => error ? reject(error) : resolve(uploaded)
      );
      stream.end(req.file.buffer);
    });

    res.json({
      ok: true,
      attachment: {
        url: result.secure_url,
        name: req.file.originalname,
        mime: req.file.mimetype,
        size: req.file.size,
        width: result.width || null,
        height: result.height || null,
        duration: result.duration || null,
        resourceType: result.resource_type || resourceType,
      },
    });
  } catch (error) {
    console.error('Upload error:', error.message);
    res.status(500).json({ ok: false, message: 'No se pudo subir el archivo' });
  }
});

app.use((error, _req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, message: `El archivo supera el límite de ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB` });
  }
  next(error);
});

app.post('/api/admin/sync-memberships', authMiddleware, async (req, res) => {
  if (!isAdminRole(req.auth.role)) {
    return res.status(403).json({ ok: false, message: 'Sin acceso' });
  }

  const admins = await pool.query(
    `SELECT id FROM users WHERE active=TRUE AND LOWER(role) IN ('admin','manager','owner','company owner','operations','dispatch')`
  );

  for (const admin of admins.rows) {
    await ensureAdminMemberships(admin.id);
  }

  res.json({ ok: true, admins: admins.rowCount });
});

app.patch('/api/admin/ai-actions/:id', authMiddleware, async (req, res) => {
  if (!isAdminRole(req.auth.role)) {
    return res.status(403).json({ ok: false, message: 'Sin acceso' });
  }

  const status = String(req.body.status || '').trim().toLowerCase();
  if (!['pending','approved','dismissed','completed'].includes(status)) {
    return res.status(400).json({ ok: false, message: 'Estado inválido' });
  }

  const result = await pool.query(
    `UPDATE ai_actions
     SET status=$1,updated_at=NOW()
     WHERE id=$2
     RETURNING *`,
    [status, req.params.id]
  );

  if (!result.rows[0]) {
    return res.status(404).json({ ok: false, message: 'Acción no encontrada' });
  }

  io.to('role:admin').emit('ai-action:update', result.rows[0]);
  io.to('role:manager').emit('ai-action:update', result.rows[0]);
  res.json({ ok: true, action: result.rows[0] });
});

app.get('/api/admin/ai-actions', authMiddleware, async (req, res) => {
  if (!['admin','manager','owner'].includes(String(req.auth.role).toLowerCase())) {
    return res.status(403).json({ ok: false, message: 'Sin acceso' });
  }
  const result = await pool.query(
    `SELECT a.*,u.name AS requester_name,c.name AS conversation_name
     FROM ai_actions a
     LEFT JOIN users u ON u.id=a.requester_id
     LEFT JOIN conversations c ON c.id=a.conversation_id
     ORDER BY a.created_at DESC LIMIT 200`
  );
  res.json({ ok: true, actions: result.rows });
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    socket.auth = verifyToken(token);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', async (socket) => {
  const userId = socket.auth.sub;
  const userKey = String(userId);
  onlineUsers.set(userKey, Number(onlineUsers.get(userKey) || 0) + 1);
  socket.join(`user:${userId}`);
  socket.join(`role:${String(socket.auth.role || '').toLowerCase()}`);

  const memberships = await pool.query(
    `SELECT conversation_id FROM conversation_members WHERE user_id=$1`,
    [userId]
  );
  memberships.rows.forEach((row) => socket.join(`conversation:${row.conversation_id}`));

  io.emit('presence:update', { userId, online: true, at: new Date().toISOString() });
  markDeliveredForUser(userId).catch(error => console.warn('Delivery mark error:', error.message));

  socket.on('conversation:join', async ({ conversationId }, callback = () => {}) => {
    try {
      if (!(await isConversationMember(conversationId, userId))) {
        return callback({ ok: false, message: 'Sin acceso' });
      }
      socket.join(`conversation:${conversationId}`);
      await markConversationRead(conversationId, userId);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on('typing:start', ({ conversationId }) => {
    socket.to(`conversation:${conversationId}`).emit('typing:update', {
      conversationId,
      userId,
      name: socket.auth.name,
      typing: true,
    });
  });

  socket.on('typing:stop', ({ conversationId }) => {
    socket.to(`conversation:${conversationId}`).emit('typing:update', {
      conversationId,
      userId,
      name: socket.auth.name,
      typing: false,
    });
  });

  socket.on('message:send', async (payload, callback = () => {}) => {
    try {
      const conversationId = String(payload.conversationId || '');
      if (!(await isConversationMember(conversationId, userId))) {
        return callback({ ok: false, message: 'Sin acceso' });
      }

      const body = String(payload.body || '').trim();
      const attachment = payload.attachment || null;
      if (!body && !attachment?.url) {
        return callback({ ok: false, message: 'Mensaje vacío' });
      }

      const type = attachment?.mime?.startsWith('image/') ? 'image'
        : attachment?.mime?.startsWith('video/') ? 'video'
        : attachment?.mime?.startsWith('audio/') ? 'audio'
        : attachment?.url ? 'file' : 'text';

      const result = await pool.query(
        `INSERT INTO messages
          (conversation_id,sender_id,body,message_type,reply_to_id,attachment_url,attachment_name,attachment_mime,attachment_size)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          conversationId,
          userId,
          body,
          type,
          payload.replyToId || null,
          attachment?.url || null,
          attachment?.name || null,
          attachment?.mime || null,
          attachment?.size || null,
        ]
      );

      await pool.query(`UPDATE conversations SET updated_at=NOW() WHERE id=$1`, [conversationId]);

      await pool.query(
        `INSERT INTO message_receipts(message_id,user_id,delivered_at,read_at)
         SELECT $1,cm.user_id,
                CASE WHEN $4 THEN NOW() ELSE NULL END,
                NULL
         FROM conversation_members cm
         WHERE cm.conversation_id=$2 AND cm.user_id<>$3
         ON CONFLICT(message_id,user_id) DO NOTHING`,
        [result.rows[0].id, conversationId, userId, false]
      );

      await markMessageDeliveredToOnlineMembers(result.rows[0].id, conversationId, userId);

      const message = await hydrateMessage({
        ...result.rows[0],
        sender_name: socket.auth.name,
        sender_role: socket.auth.role,
        current_user_id: userId,
      });

      io.to(`conversation:${conversationId}`).emit('message:new', message);
      callback({ ok: true, message });

      sendPushToConversationMembers({
        conversationId,
        senderId: userId,
        title: socket.auth.name || '417 Maid Chat',
        body: body || attachment?.name || 'Nuevo archivo',
        url: `/?conversation=${encodeURIComponent(conversationId)}`,
      }).catch(error => console.warn('Push send error:', error.message));

      setImmediate(() => {
        saveAiAction(message, { id: userId }).catch((error) => {
          console.error('AI action save error:', error.message);
        });
      });
    } catch (error) {
      console.error('Send message error:', error.message);
      callback({ ok: false, message: 'No se pudo enviar el mensaje' });
    }
  });

  socket.on('conversation:read', async ({ conversationId }, callback = () => {}) => {
    try {
      if (!(await isConversationMember(conversationId, userId))) {
        return callback({ ok: false, message: 'Sin acceso' });
      }
      const count = await markConversationRead(conversationId, userId);
      callback({ ok: true, count });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on('disconnect', () => {
    const userKey = String(userId);
    const next = Math.max(0, Number(onlineUsers.get(userKey) || 1) - 1);
    if (next === 0) {
      onlineUsers.delete(userKey);
      io.emit('presence:update', { userId, online: false, at: new Date().toISOString() });
    } else {
      onlineUsers.set(userKey, next);
    }
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`417 Maid Chat running on port ${PORT}`);
});
