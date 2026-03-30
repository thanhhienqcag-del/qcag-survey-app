// api/env.js — runtime config for frontend data SDK
'use strict';

function splitList(raw) {
  return String(raw || '')
    .split(',')
    .map((x) => String(x || '').trim())
    .filter(Boolean);
}

function getLocalDevCandidates(req) {
  const hostHeader = String(
    (req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || ''
  )
    .split(',')[0]
    .trim()
    .toLowerCase();
  const host = hostHeader.replace(/:\d+$/, '');
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
  if (!isLocalHost) return [];
  return [
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3100',
    'http://127.0.0.1:3101',
    'http://127.0.0.1:3102',
    'http://localhost:3000',
    'http://localhost:3100',
    'http://localhost:3101',
    'http://localhost:3102'
  ];
}

module.exports = async function handler(req, res) {
  const explicitBackend = String(
    process.env.BACKEND_URL || process.env.KS_BACKEND_URL || ''
  ).trim();
  const backendCandidates = Array.from(new Set([
    explicitBackend,
    String(process.env.KS_BACKEND_FALLBACK_URL || '').trim(),
    ...splitList(process.env.KS_BACKEND_CANDIDATES),
    ...getLocalDevCandidates(req),
    // Known production backends used by this project (fallback when env is missing).
    'https://qcag-backend-493469512136.asia-southeast1.run.app',
    'https://qcag-backend-k7disoxmcq-as.a.run.app',
    'https://qcag-backend-bgrkahehra-as.a.run.app'
  ].filter(Boolean)));

  const env = {
    // Preferred backend URL for KS API.
    // Keep empty by default so frontend uses same-origin (/api/ks/* proxy).
    BACKEND_URL: explicitBackend,
    // Additional fallback endpoints for clients to retry automatically.
    BACKEND_URL_CANDIDATES: backendCandidates
  };

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).end('window.__env = ' + JSON.stringify(env) + ';');
};
