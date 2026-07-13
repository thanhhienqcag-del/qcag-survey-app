// api/push.js — GET: return VAPID public key for client push registration
'use strict';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const publicKey = process.env.VAPID_PUBLIC_KEY || '';
  if (!publicKey) {
    return res.status(503).end(JSON.stringify({ ok: false, error: 'VAPID not configured' }));
  }
  return res.end(JSON.stringify({ ok: true, publicKey }));
};
