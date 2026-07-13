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
  res.json({ ok: true, messages: result.rows.reverse() });
});

app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'Archivo requerido' });
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return res.status(503).json({ ok: false, message: 'Cloudinary no está configurado' });
  }

  try {
    const resourceType = req.file.mimetype.startsWith('video/') || req.file.mimetype.startsWith('audio/')
      ? 'video'
      : req.file.mimetype.startsWith('image/') ? 'image' : 'raw';

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: '417-maid-chat', resource_type: resourceType },
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
      },
    });
  } catch (error) {
    console.error('Upload error:', error.message);
    res.status(500).json({ ok: false, message: 'No se pudo subir el archivo' });
  }
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
  socket.join(`user:${userId}`);
  socket.join(`role:${String(socket.auth.role || '').toLowerCase()}`);

  const memberships = await pool.query(
    `SELECT conversation_id FROM conversation_members WHERE user_id=$1`,
    [userId]
  );
  memberships.rows.forEach((row) => socket.join(`conversation:${row.conversation_id}`));

  io.emit('presence:update', { userId, online: true, at: new Date().toISOString() });

  socket.on('conversation:join', async ({ conversationId }, callback = () => {}) => {
    try {
      if (!(await isConversationMember(conversationId, userId))) {
        return callback({ ok: false, message: 'Sin acceso' });
      }
      socket.join(`conversation:${conversationId}`);
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
      const message = {
        ...result.rows[0],
        sender_name: socket.auth.name,
        sender_role: socket.auth.role,
      };

      io.to(`conversation:${conversationId}`).emit('message:new', message);
      callback({ ok: true, message });

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

  socket.on('disconnect', () => {
    io.emit('presence:update', { userId, online: false, at: new Date().toISOString() });
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`417 Maid Chat running on port ${PORT}`);
});
