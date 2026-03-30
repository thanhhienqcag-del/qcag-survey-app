// api/ks/push/send.js — POST: look up subscriptions for a phone and send web push
// Called from QCAG desktop client after marking a request as done.
'use strict';

const { Pool } = require('pg');
const webpush = require('web-push');

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
  const configuredOrigins = String(process.env.ALLOWED_ORIGINS || 'https://qcag-survey-app.vercel.app')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const reqOrigin = String(req.headers.origin || '');
  const isLocalOrigin = reqOrigin.startsWith('http://localhost') || reqOrigin.startsWith('https://localhost');
  const isConfiguredOrigin = configuredOrigins.some(prefix => reqOrigin.startsWith(prefix));
  const isVercelPreview = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(reqOrigin);
  const allowOrigin = isLocalOrigin || isConfiguredOrigin || isVercelPreview;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', allowOrigin ? reqOrigin : (configuredOrigins[0] || '*'));
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end('{}');
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ ok: false }));

  // Only allow calls from configured frontend origins.
  const origin = reqOrigin || String(req.headers.referer || '');
  const allowed = allowOrigin || origin.startsWith('http://localhost') || origin.startsWith('https://localhost');
  if (!allowed) return res.status(403).end(JSON.stringify({ ok: false, error: 'forbidden' }));

  const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT     || 'mailto:admin@qcag.vn';

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return res.status(503).end(JSON.stringify({ ok: false, error: 'VAPID not configured' }));
  }
  if (!process.env.DATABASE_URL) {
    return res.status(503).end(JSON.stringify({ ok: false, error: 'DATABASE_URL not configured' }));
  }

  try {
    const body = req.body && typeof req.body === 'object'
      ? req.body
      : (req.body ? JSON.parse(req.body) : {});

    const { title, body: msgBody, data, phone } = body;
    if (!phone) return res.status(400).end(JSON.stringify({ ok: false, error: 'missing phone' }));

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

    const db = getPool();
    const rows = await db.query(
      'SELECT subscription FROM push_subscriptions WHERE phone = $1',
      [String(phone)]
    );

    if (!rows.rows.length) {
      return res.end(JSON.stringify({ ok: true, sent: 0, message: 'no_subscriptions' }));
    }

    const payload = JSON.stringify({
      title: title || 'QCAG',
      body: msgBody || '',
      data: data || {},
    });

    const results = await Promise.allSettled(
      rows.rows.map(r => {
        try {
          return webpush.sendNotification(JSON.parse(r.subscription), payload);
        } catch (e) {
          return Promise.resolve();
        }
      })
    );

    const sent = results.filter(r => r.status === 'fulfilled').length;
    return res.end(JSON.stringify({ ok: true, sent }));
  } catch (err) {
    console.error('[push/send] error:', err && err.message ? err.message : err);
    return res.status(500).end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  }
};
