require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { AccessToken } = require('livekit-server-sdk');

const { pool } = require('./db');
const { signUser, verifyToken, authMiddleware } = require('./auth');
const { createPresignedUpload } = require('./storage');
const { interpretOperationsMessage } = require('./ai');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.APP_ORIGIN || true, credentials: true },
  maxHttpBufferSize: 1e6,
  transports: ['websocket', 'polling'],
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.APP_ORIGIN || true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: '417-maid-chat', timestamp: new Date().toISOString() });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const code = String(req.body.code || '').trim();
    const password = String(req.body.password || '');

    const result = await pool.query(
      `SELECT id, employee_code, display_name, role, password_hash, active, avatar_url
       FROM users WHERE employee_code = $1 LIMIT 1`,
      [code]
    );

    const user = result.rows[0];
    if (!user || !user.active || !user.password_hash) {
      return res.status(401).json({ ok: false, message: 'Código o contraseña incorrectos' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ ok: false, message: 'Código o contraseña incorrectos' });
    }

    res.json({
      ok: true,
      token: signUser(user),
      user: {
        id: user.id,
        code: user.employee_code,
        name: user.display_name,
        role: user.role,
        avatarUrl: user.avatar_url,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, message: 'No se pudo iniciar sesión' });
  }
});

app.get('/api/conversations', authMiddleware, async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.type, c.title, c.metadata, c.updated_at,
            COALESCE(last_message.body, '') AS last_message,
            last_message.created_at AS last_message_at
     FROM conversation_members cm
     JOIN conversations c ON c.id = cm.conversation_id
     LEFT JOIN LATERAL (
       SELECT body, created_at
       FROM messages
       WHERE conversation_id = c.id AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1
     ) last_message ON TRUE
     WHERE cm.user_id = $1
     ORDER BY COALESCE(last_message.created_at, c.updated_at) DESC`,
    [req.user.sub]
  );

  res.json({ ok: true, conversations: result.rows });
});

app.get('/api/conversations/:id/messages', authMiddleware, async (req, res) => {
  const member = await pool.query(
    `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
    [req.params.id, req.user.sub]
  );
  if (!member.rowCount) return res.status(403).json({ ok: false, message: 'Sin acceso' });

  const result = await pool.query(
    `SELECT m.id, m.body, m.message_type, m.metadata, m.reply_to_id, m.created_at,
            u.id AS sender_id, u.display_name AS sender_name, u.role AS sender_role, u.avatar_url
     FROM messages m
     LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
     ORDER BY m.created_at DESC
     LIMIT 100`,
    [req.params.id]
  );

  res.json({ ok: true, messages: result.rows.reverse() });
});

app.post('/api/uploads/presign', authMiddleware, async (req, res) => {
  try {
    const result = await createPresignedUpload({
      userId: req.user.sub,
      fileName: req.body.fileName,
      mimeType: req.body.mimeType,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, message: error.message });
  }
});

app.post('/api/calls/token', authMiddleware, async (req, res) => {
  if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET || !process.env.LIVEKIT_URL) {
    return res.status(503).json({ ok: false, message: 'LiveKit no configurado' });
  }

  const roomName = String(req.body.roomName || '').trim();
  if (!roomName) return res.status(400).json({ ok: false, message: 'roomName requerido' });

  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: req.user.sub,
    name: req.user.name,
  });
  token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

  res.json({ ok: true, url: process.env.LIVEKIT_URL, token: await token.toJwt() });
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    socket.user = verifyToken(token);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', async (socket) => {
  const userId = socket.user.sub;
  socket.join(`user:${userId}`);

  const memberships = await pool.query(
    'SELECT conversation_id FROM conversation_members WHERE user_id = $1',
    [userId]
  );
  memberships.rows.forEach(({ conversation_id }) => socket.join(`conversation:${conversation_id}`));

  io.emit('presence:update', { userId, online: true });

  socket.on('typing:start', ({ conversationId }) => {
    socket.to(`conversation:${conversationId}`).emit('typing:start', {
      conversationId,
      userId,
      name: socket.user.name,
    });
  });

  socket.on('typing:stop', ({ conversationId }) => {
    socket.to(`conversation:${conversationId}`).emit('typing:stop', { conversationId, userId });
  });

  socket.on('message:send', async (payload, ack = () => {}) => {
    try {
      const conversationId = String(payload.conversationId || '');
      const body = String(payload.body || '').trim();
      if (!conversationId || !body) return ack({ ok: false, message: 'Mensaje vacío' });

      const member = await pool.query(
        'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, userId]
      );
      if (!member.rowCount) return ack({ ok: false, message: 'Sin acceso' });

      const inserted = await pool.query(
        `INSERT INTO messages (conversation_id, sender_id, body, message_type, reply_to_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id, conversation_id, sender_id, body, message_type, reply_to_id, metadata, created_at`,
        [conversationId, userId, body, payload.messageType || 'text', payload.replyToId || null, JSON.stringify(payload.metadata || {})]
      );

      const message = {
        ...inserted.rows[0],
        sender_name: socket.user.name,
        sender_role: socket.user.role,
      };

      await pool.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);
      io.to(`conversation:${conversationId}`).emit('message:new', message);
      ack({ ok: true, message });

      setImmediate(async () => {
        try {
          const interpretation = await interpretOperationsMessage(body);
          if (!interpretation) return;

          const action = await pool.query(
            `INSERT INTO ai_actions
             (source_message_id, unit, department, request_type, priority, summary, structured_data, confidence)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
             RETURNING *`,
            [
              message.id,
              interpretation.unit || null,
              interpretation.department || null,
              interpretation.requestType || null,
              interpretation.priority || 'Normal',
              interpretation.summary || body,
              JSON.stringify(interpretation),
              Number(interpretation.confidence || 0),
            ]
          );

          io.to('role:admin').emit('ai-action:new', action.rows[0]);
        } catch (error) {
          console.error('AI interpretation error:', error.message);
        }
      });
    } catch (error) {
      console.error(error);
      ack({ ok: false, message: 'No se pudo enviar el mensaje' });
    }
  });

  socket.on('disconnect', () => {
    io.emit('presence:update', { userId, online: false });
  });
});

server.listen(Number(process.env.PORT || 4100), () => {
  console.log(`417 Maid Chat running on port ${process.env.PORT || 4100}`);
});
