// api/ks/push/lookup.js — GET: lookup user profile by endpoint, phone, or sale_code
'use strict';
const { Pool } = require('pg');

let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
  return _pool;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end('{}');

  try {
    const endpoint = String((req.query && req.query.endpoint) || '').trim();
    const phone = String((req.query && (req.query.phone || req.query.sale_phone)) || '').replace(/\D/g, '').trim();
    const saleCode = String((req.query && (req.query.sale_code || req.query.saleCode || req.query.code)) || '').trim();

    if (!endpoint && !phone && !saleCode) {
      return res.status(400).end(JSON.stringify({ ok: false, error: 'missing_lookup_key' }));
    }

    const db = getPool();
    let row = null;

    if (endpoint && endpoint.length >= 20) {
      const endpointSuffix = endpoint.slice(-40);
      const resSub = await db.query(
        `SELECT p.phone, p.role, u.username, u.fullname, u.region, u.ss_name 
         FROM push_subscriptions p 
         LEFT JOIN users u ON (p.user_id = u.id OR p.phone = u.phone)
         WHERE p.subscription LIKE $1 
         ORDER BY p.updated_at DESC LIMIT 1`,
        ['%' + endpointSuffix + '%']
      );
      if (resSub.rows.length > 0) row = resSub.rows[0];
    }

    if (!row && phone && phone.length >= 8) {
      const resPhone = await db.query(
        `SELECT u.username, u.phone, u.fullname, u.region, u.ss_name, u.role
         FROM users u
         WHERE u.phone = $1 OR regexp_replace(u.phone, '\\D', '', 'g') = $1
         ORDER BY u.id DESC LIMIT 1`,
        [phone]
      );
      if (resPhone.rows.length > 0) row = resPhone.rows[0];
    }

    if (!row && saleCode && saleCode.length >= 6) {
      const resCode = await db.query(
        `SELECT u.username, u.phone, u.fullname, u.region, u.ss_name, u.role
         FROM users u
         WHERE u.username = $1 OR u.id = 'USR_SALE_' || $1
         ORDER BY u.id DESC LIMIT 1`,
        [saleCode]
      );
      if (resCode.rows.length > 0) row = resCode.rows[0];
    }

    if (row && (row.phone || row.username)) {
      const codeClean = (row.username && !row.username.startsWith('USR_PHONE_')) ? row.username : (saleCode || '');
      return res.end(JSON.stringify({
        ok: true,
        user: {
          phone: row.phone || phone || '',
          saleCode: codeClean,
          saleName: row.fullname || '',
          role: 'heineken',
          region: row.region || '',
          ssName: row.ss_name || ''
        }
      }));
    }

    return res.end(JSON.stringify({ ok: false, not_found: true }));
  } catch (err) {
    return res.status(500).end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  }
};
