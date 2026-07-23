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
    process.env.BACKEND_URL || process.env.KS_BACKEND_URL ||
    // Default to Cloud Run directly — bypasses Vercel proxy, saves bandwidth.
    'https://ks-backend-493469512136.asia-southeast1.run.app'
  ).trim();
  const backendCandidates = Array.from(new Set([
    explicitBackend,
    String(process.env.KS_BACKEND_FALLBACK_URL || '').trim(),
    ...splitList(process.env.KS_BACKEND_CANDIDATES),
    ...getLocalDevCandidates(req),
    // Known production backend used by this project (fallback when env is missing).
    'https://ks-backend-493469512136.asia-southeast1.run.app'
  ].filter(Boolean)));

  const env = {
    // Preferred backend URL for KS API — points directly to Cloud Run.
    BACKEND_URL: explicitBackend,
    // Additional fallback endpoints for clients to retry automatically.
    BACKEND_URL_CANDIDATES: backendCandidates
  };

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  // Cache 60 s at CDN edge — reduces serverless invocations significantly.
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.status(200).end('window.__env = ' + JSON.stringify(env) + ';');
};
