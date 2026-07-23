// api/ks/push/migrate.js — Run DB migration: add sale_code column to push_subscriptions
'use strict';
const { Pool } = require('pg');
let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });
  return _pool;
}
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!process.env.DATABASE_URL) return res.status(503).end(JSON.stringify({ ok: false, error: 'no db' }));
  try {
    const db = getPool();
    // Add sale_code column if not exists
    await db.query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS sale_code TEXT`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_push_sub_sale_code ON push_subscriptions(sale_code)`);
    // Show current schema
    const cols = await db.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='push_subscriptions' ORDER BY ordinal_position`);
    return res.end(JSON.stringify({ ok: true, columns: cols.rows }));
  } catch (err) {
    return res.status(500).end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  }
};
