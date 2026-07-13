'use strict';

const webpush = require('web-push');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  // Ensure VAPID keys are configured
  const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    if (req.method === 'GET') return res.end(JSON.stringify({ ok: false, error: 'VAPID keys not configured' }));
    return res.status(500).end(JSON.stringify({ ok: false, error: 'VAPID keys not configured' }));
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  if (req.method === 'GET') {
    return res.end(JSON.stringify({ ok: true, publicKey: VAPID_PUBLIC }));
  }

  if (req.method === 'POST') {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
      const subscription = body.subscription;
      const payload = body.payload || { title: body.title || 'QCAG', body: body.body || 'Test notification' };
      if (!subscription) return res.status(400).end(JSON.stringify({ ok: false, error: 'Missing subscription' }));

      await webpush.sendNotification(subscription, JSON.stringify(payload));
      return res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('push send error', err && err.stack || err);
      return res.status(500).end(JSON.stringify({ ok: false, error: String(err) }));
    }
  }

  res.status(405).end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
};
