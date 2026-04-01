// api/ks/push/list.js — GET: list push subscriptions (redacted) for debug
// Shows phone, role, created_at without exposing private keys
'use strict';

const { Pool } = require('pg');

let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
  }
  return _pool;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end(JSON.stringify({ ok: false }));

  if (!process.env.DATABASE_URL) {
    return res.status(503).end(JSON.stringify({ ok: false, error: 'DATABASE_URL not configured' }));
  }

  try {
    const db = getPool();
    const rows = await db.query(
      `SELECT id, phone, role, created_at, updated_at,
        LEFT(subscription::text, 80) AS subscription_preview
       FROM push_subscriptions
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 100`
    );
    return res.end(JSON.stringify({ ok: true, count: rows.rows.length, subscriptions: rows.rows }));
  } catch (err) {
    return res.status(500).end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  }
};
