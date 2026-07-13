const { Pool } = require('pg');

function envBool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: envBool(process.env.DATABASE_SSL, true)
    ? { rejectUnauthorized: false }
    : false,
  max: Number(process.env.DATABASE_POOL_MAX || 20),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL error:', error.message);
});

module.exports = { pool };
