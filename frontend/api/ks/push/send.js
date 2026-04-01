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
  const reqReferer = String(req.headers.referer || '');

  // Same-origin fetch() does NOT send Origin header → check referer instead
  const checkUrl = reqOrigin || reqReferer;
  const isLocalUrl = checkUrl.startsWith('http://localhost') || checkUrl.startsWith('https://localhost') || checkUrl.startsWith('http://127.0.0.1');
  const isConfiguredUrl = configuredOrigins.some(prefix => checkUrl.startsWith(prefix));
  const isVercelUrl = /^https:\/\/[a-z0-9-]+\.vercel\.app/i.test(checkUrl);
  // Also allow when no Origin AND no Referer (Vercel server-to-server or direct API calls)
  const noOriginNoReferer = !req.headers.origin && !req.headers.referer;
  const allowed = isLocalUrl || isConfiguredUrl || isVercelUrl || noOriginNoReferer;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', reqOrigin || (configuredOrigins[0] || '*'));
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end('{}');
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ ok: false }));

  if (!allowed) return res.status(403).end(JSON.stringify({ ok: false, error: 'forbidden', debug: { origin: reqOrigin, referer: reqReferer } }));

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

    const { title, body: msgBody, data, phone, role } = body;
    if (!phone && !role) return res.status(400).end(JSON.stringify({ ok: false, error: 'missing phone or role' }));

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

    const db = getPool();
    // Support role-based broadcast (e.g. notify all 'qcag' subscribers) or phone-specific
    let rows;
    if (phone) {
      rows = await db.query(
        'SELECT subscription FROM push_subscriptions WHERE phone = $1',
        [String(phone)]
      );
    } else {
      rows = await db.query(
        'SELECT subscription FROM push_subscriptions WHERE role = $1',
        [String(role)]
      );
    }

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
        let sub;
        try { sub = JSON.parse(r.subscription); } catch (e) { return Promise.resolve({ skipped: true }); }
        return webpush.sendNotification(sub, payload).catch(async function (err) {
          // 410 Gone or 404 = subscription expired/unregistered, remove from DB
          if (err && (err.statusCode === 410 || err.statusCode === 404)) {
            try {
              const ep = sub.endpoint || '';
              await db.query('DELETE FROM push_subscriptions WHERE subscription LIKE $1', ['%' + ep.slice(-40) + '%']);
            } catch (_) {}
          } else {
            console.error('[push/send] sendNotification error:', err && err.statusCode, err && err.body);
          }
          throw err;
        });
      })
    );

    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    return res.end(JSON.stringify({ ok: true, sent, failed, total: rows.rows.length }));
  } catch (err) {
    console.error('[push/send] error:', err && err.message ? err.message : err);
    return res.status(500).end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  }
};
