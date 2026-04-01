// api/ks/push/subscribe.js — POST: save/update a device push subscription in Neon DB
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end('{}');
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ ok: false, error: 'Method not allowed' }));

  try {
    const body = req.body && typeof req.body === 'object'
      ? req.body
      : (req.body ? JSON.parse(req.body) : {});

    const { subscription, role } = body;
    let { phone, saleCode } = body;
    // Normalize phone: strip spaces/dashes, convert +84 → 0
    if (phone) {
      phone = String(phone).replace(/[\s\-\.]+/g, '');
      if (phone.startsWith('+84')) phone = '0' + phone.slice(3);
      else if (phone.startsWith('84') && phone.length >= 10) phone = '0' + phone.slice(2);
    }
    // Normalize saleCode: trim whitespace
    if (saleCode) saleCode = String(saleCode).trim();
    if (!subscription) return res.status(400).end(JSON.stringify({ ok: false, error: 'missing_subscription' }));

    const subStr = typeof subscription === 'string' ? subscription : JSON.stringify(subscription);
    const subObj = typeof subscription === 'object' ? subscription : JSON.parse(subStr);
    const endpoint = String(subObj.endpoint || '');
    if (!endpoint) return res.status(400).end(JSON.stringify({ ok: false, error: 'invalid_subscription' }));

    if (!process.env.DATABASE_URL) {
      return res.status(503).end(JSON.stringify({ ok: false, error: 'DATABASE_URL not configured' }));
    }

    const db = getPool();
    // Look for existing record by matching end of endpoint URL
    const endpointSuffix = endpoint.slice(-40);
    const existing = await db.query(
      'SELECT id FROM push_subscriptions WHERE subscription LIKE $1 LIMIT 1',
      ['%' + endpointSuffix + '%']
    );

    let savedId;
    if (existing.rows.length > 0) {
      await db.query(
        'UPDATE push_subscriptions SET subscription = $1, phone = $2, role = $3, sale_code = $4, updated_at = NOW() WHERE id = $5',
        [subStr, phone || null, role || null, saleCode || null, existing.rows[0].id]
      );
      savedId = existing.rows[0].id;
    } else {
      const ins = await db.query(
        'INSERT INTO push_subscriptions (subscription, phone, role, sale_code, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING id',
        [subStr, phone || null, role || null, saleCode || null]
      );
      savedId = ins.rows[0].id;
    }

    // Auto-dedup: remove older duplicates for same sale_code or same phone
    if (saleCode) {
      await db.query(
        'DELETE FROM push_subscriptions WHERE sale_code = $1 AND id != $2',
        [saleCode, savedId]
      );
    } else if (phone) {
      await db.query(
        'DELETE FROM push_subscriptions WHERE phone = $1 AND sale_code IS NULL AND id != $2',
        [phone, savedId]
      );
    }

    return res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error('[push/subscribe] error:', err && err.message ? err.message : err);
    return res.status(500).end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  }
};
