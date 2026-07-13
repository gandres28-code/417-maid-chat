require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function adminConfigs() {
  const admins = [];

  for (let index = 1; index <= 3; index += 1) {
    const code = String(process.env[`ADMIN_${index}_CODE`] || '').trim();
    if (!code) continue;

    admins.push({
      name: String(process.env[`ADMIN_${index}_NAME`] || `Admin ${index}`).trim(),
      code,
      pin: String(process.env[`ADMIN_${index}_PIN`] || '1234'),
    });
  }

  if (!admins.length) {
    admins.push({
      name: process.env.ADMIN_NAME || 'Andres',
      code: process.env.ADMIN_CODE || '0001',
      pin: process.env.ADMIN_PIN || '1234',
    });
  }

  return admins;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: bool(process.env.DATABASE_SSL, true) ? { rejectUnauthorized: false } : false,
  });

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  for (const admin of adminConfigs()) {
    const pinHash = await bcrypt.hash(admin.pin, 12);

    const result = await pool.query(
      `INSERT INTO users (name,employee_code,pin_hash,role,active,source)
       VALUES ($1,$2,$3,'admin',TRUE,'local-admin')
       ON CONFLICT (employee_code)
       DO UPDATE SET name=EXCLUDED.name,pin_hash=EXCLUDED.pin_hash,role='admin',active=TRUE,source='local-admin',updated_at=NOW()
       RETURNING id`,
      [admin.name, admin.code, pinHash]
    );

    await pool.query(
      `INSERT INTO conversation_members (conversation_id,user_id,member_role)
       SELECT c.id,$1,'admin'
       FROM conversations c
       WHERE c.type='admin_employee'
       ON CONFLICT (conversation_id,user_id)
       DO UPDATE SET member_role='admin'`,
      [result.rows[0].id]
    );
  }

  console.log('Database initialized for employee-admin chats.');
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
