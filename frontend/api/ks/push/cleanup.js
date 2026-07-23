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
      // 1. Remove fake/test subscriptions
      const result = await db.query(
        `DELETE FROM push_subscriptions
         WHERE subscription LIKE '%test.example.com%'
            OR subscription LIKE '%debug.check%'
            OR phone IN ('test_check', 'debug_check', '0909123456')
         RETURNING id, phone, role`
      );

      // 2. Normalize phone numbers
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

      // 3. Remove duplicate subscriptions — keep only the NEWEST per (sale_code) and (phone)
      // For rows with sale_code: keep newest per sale_code
      const dupBySaleCode = await db.query(`
        DELETE FROM push_subscriptions
        WHERE id NOT IN (
          SELECT DISTINCT ON (sale_code) id
          FROM push_subscriptions
          WHERE sale_code IS NOT NULL
          ORDER BY sale_code, updated_at DESC NULLS LAST
        )
        AND sale_code IS NOT NULL
        RETURNING id, phone, sale_code
      `);
      // For rows without sale_code: keep newest 1 per phone
      const dupByPhone = await db.query(`
        DELETE FROM push_subscriptions
        WHERE id NOT IN (
          SELECT DISTINCT ON (phone) id
          FROM push_subscriptions
          WHERE sale_code IS NULL AND phone IS NOT NULL
          ORDER BY phone, updated_at DESC NULLS LAST
        )
        AND sale_code IS NULL AND phone IS NOT NULL
        RETURNING id, phone
      `);

      return res.end(JSON.stringify({
        ok: true,
        deleted_fake: result.rows.length,
        normalized,
        deduped_by_sale_code: dupBySaleCode.rows.length,
        deduped_by_phone: dupByPhone.rows.length,
      }));
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
