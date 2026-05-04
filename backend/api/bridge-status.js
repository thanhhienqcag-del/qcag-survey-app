// api/bridge-status.js — Vercel Serverless Function
// Route: GET /api/bridge-status?ks_backend_id=xxx
'use strict';

const { query } = require('../db');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', (process.env.ALLOWED_ORIGINS || '*').trim());
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, status, data) {
  res.status(status).json(data);
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });

  try {
    const { ks_backend_id } = req.query;
    if (!ks_backend_id) return sendJson(res, 400, { error: '"ks_backend_id" là bắt buộc' });

    const { rows } = await query(
      `SELECT id, ks_backend_id, quote_status, quote_code, quote_preview_url,
              quote_total, quoted_by, quote_confirmed_at, updated_at
       FROM ks_quote_bridge
       WHERE ks_backend_id = $1`,
      [ks_backend_id],
    );

    if (!rows.length) return sendJson(res, 404, { error: 'Not found' });
    return sendJson(res, 200, { data: rows[0] });
  } catch (err) {
    console.error('[bridge-status] error:', err);
    return sendJson(res, 500, { error: 'Internal server error' });
  }
};
