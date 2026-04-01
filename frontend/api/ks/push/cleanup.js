// api/ks/push/cleanup.js — DELETE fake/test subscriptions from DB
// Only removes rows with obviously fake endpoints (test.example.com, debug.check)
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

  if (!process.env.DATABASE_URL) {
    return res.status(503).end(JSON.stringify({ ok: false, error: 'DATABASE_URL not configured' }));
  }

  try {
    const db = getPool();

    if (req.method === 'DELETE' || req.method === 'POST') {
      // Remove subscriptions with fake/test endpoints
      const result = await db.query(
        `DELETE FROM push_subscriptions
         WHERE subscription LIKE '%test.example.com%'
            OR subscription LIKE '%debug.check%'
            OR phone IN ('test_check', 'debug_check', '0909123456')
         RETURNING id, phone, role`
      );

      // Normalize all phone numbers: strip spaces, +84 → 0
      const allRows = await db.query('SELECT id, phone FROM push_subscriptions WHERE phone IS NOT NULL');
      const normalized = [];
      for (const row of allRows.rows) {
        let p = String(row.phone).replace(/[\s\-\.]+/g, '');
        if (p.startsWith('+84')) p = '0' + p.slice(3);
        else if (p.startsWith('84') && p.length >= 10) p = '0' + p.slice(2);
        if (p !== row.phone) {
          await db.query('UPDATE push_subscriptions SET phone = $1 WHERE id = $2', [p, row.id]);
          normalized.push({ id: row.id, from: row.phone, to: p });
        }
      }

      return res.end(JSON.stringify({ ok: true, deleted: result.rows.length, deleted_rows: result.rows, normalized }));
    }

    // GET: show what would be deleted
    const preview = await db.query(
      `SELECT id, phone, role FROM push_subscriptions
       WHERE subscription LIKE '%test.example.com%'
          OR subscription LIKE '%debug.check%'
          OR phone IN ('test_check', 'debug_check', '0909123456')`
    );
    return res.end(JSON.stringify({ ok: true, would_delete: preview.rows.length, rows: preview.rows }));
  } catch (err) {
    return res.status(500).end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  }
};
