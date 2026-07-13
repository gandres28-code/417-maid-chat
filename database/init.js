require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: bool(process.env.DATABASE_SSL, true)
      ? { rejectUnauthorized: false }
      : false,
  });

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  const name = process.env.ADMIN_NAME || 'Andres';
  const code = process.env.ADMIN_CODE || '0001';
  const pin = process.env.ADMIN_PIN || '1234';
  const pinHash = await bcrypt.hash(pin, 12);

  const userResult = await pool.query(
    `INSERT INTO users (name, employee_code, pin_hash, role, active)
     VALUES ($1, $2, $3, 'admin', TRUE)
     ON CONFLICT (employee_code)
     DO UPDATE SET name = EXCLUDED.name, pin_hash = EXCLUDED.pin_hash, role = 'admin', active = TRUE
     RETURNING id`,
    [name, code, pinHash]
  );

  const adminId = userResult.rows[0].id;

  const conversationResult = await pool.query(
    `INSERT INTO conversations (name, type, department, created_by)
     SELECT 'General', 'group', 'General', $1
     WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE name = 'General' AND type = 'group')
     RETURNING id`,
    [adminId]
  );

  let generalId = conversationResult.rows[0]?.id;
  if (!generalId) {
    const existing = await pool.query(
      `SELECT id FROM conversations WHERE name = 'General' AND type = 'group' LIMIT 1`
    );
    generalId = existing.rows[0].id;
  }

  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, member_role)
     VALUES ($1, $2, 'admin')
     ON CONFLICT DO NOTHING`,
    [generalId, adminId]
  );

  console.log('Database initialized.');
  console.log(`Admin login: ${code} / ${pin}`);
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
