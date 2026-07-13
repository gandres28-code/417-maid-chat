require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  await pool.query(schema);

  const hash = await bcrypt.hash('1234', 12);
  await pool.query(
    `INSERT INTO users (employee_code, display_name, role, password_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (employee_code) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           role = EXCLUDED.role,
           password_hash = EXCLUDED.password_hash,
           active = TRUE,
           updated_at = NOW()`,
    ['0001', 'Administrador', 'admin', hash]
  );

  const admin = await pool.query('SELECT id FROM users WHERE employee_code = $1', ['0001']);
  const adminId = admin.rows[0].id;

  const existing = await pool.query(
    `SELECT c.id
     FROM conversations c
     WHERE c.type = 'group' AND c.title = 'General'
     LIMIT 1`
  );

  let conversationId = existing.rows[0]?.id;
  if (!conversationId) {
    const created = await pool.query(
      `INSERT INTO conversations (type, title, created_by)
       VALUES ('group', 'General', $1)
       RETURNING id`,
      [adminId]
    );
    conversationId = created.rows[0].id;
  }

  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, member_role)
     VALUES ($1, $2, 'admin')
     ON CONFLICT DO NOTHING`,
    [conversationId, adminId]
  );

  console.log('Database initialized. Demo login: code 0001 / password 1234');
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
