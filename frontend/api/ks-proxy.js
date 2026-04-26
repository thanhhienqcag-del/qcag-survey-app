// api/ks-proxy.js — proxy /api/ks/* requests to Cloud Run backends.
'use strict';

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function unique(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const v = String(item || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

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

function getBackendCandidates(req) {
  return unique([
    process.env.BACKEND_URL,
    process.env.KS_BACKEND_URL,
    process.env.KS_BACKEND_FALLBACK_URL,
    ...splitList(process.env.KS_BACKEND_CANDIDATES),
    ...getLocalDevCandidates(req),
    // Known production backends in this project.
    'https://ks-backend-493469512136.asia-southeast1.run.app',
    'https://qcag-backend-k7disoxmcq-as.a.run.app',
    'https://qcag-backend-bgrkahehra-as.a.run.app'
  ]);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body != null) {
      if (Buffer.isBuffer(req.body)) return resolve(req.body);
      if (typeof req.body === 'string') return resolve(Buffer.from(req.body, 'utf8'));
      return resolve(Buffer.from(JSON.stringify(req.body), 'utf8'));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function copyHeadersFromUpstream(upstream, res) {
  const passHeaders = ['content-type', 'cache-control', 'etag', 'last-modified'];
  for (const h of passHeaders) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    return res.end('');
  }

  const pathPart = String((req.query && req.query.path) || '').replace(/^\/+/, '');
  if (!pathPart) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ ok: false, error: 'missing_path' }));
  }

  const urlObj = new URL(req.url || '', 'http://local');
  const passthroughQuery = new URLSearchParams(urlObj.search);
  passthroughQuery.delete('path');
  const querySuffix = passthroughQuery.toString();

  const upstreamPath = '/api/ks/' + pathPart + (querySuffix ? ('?' + querySuffix) : '');
  const candidates = getBackendCandidates(req);
  if (!candidates.length) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ ok: false, error: 'no_backend_candidates' }));
  }

  const headers = {};
  const contentType = req.headers['content-type'];
  const ifNoneMatch = req.headers['if-none-match'];
  if (contentType) headers['Content-Type'] = String(contentType);
  if (ifNoneMatch) headers['If-None-Match'] = String(ifNoneMatch);

  const method = String(req.method || 'GET').toUpperCase();
  const canHaveBody = !['GET', 'HEAD'].includes(method);
  const body = canHaveBody ? await readRawBody(req) : undefined;

  let lastError = null;

  for (const base of candidates) {
    const upstreamUrl = base + upstreamPath;
    try {
      const upstream = await fetch(upstreamUrl, {
        method,
        headers,
        body: canHaveBody ? body : undefined
      });

      copyHeadersFromUpstream(upstream, res);
      res.statusCode = upstream.status;
      const text = await upstream.text();
      return res.end(text);
    } catch (err) {
      lastError = err;
    }
  }

  res.statusCode = 502;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify({
    ok: false,
    error: 'upstream_unreachable',
    detail: String(lastError && lastError.message ? lastError.message : lastError || 'unknown')
  }));
};
