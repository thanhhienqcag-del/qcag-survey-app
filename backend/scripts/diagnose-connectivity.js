'use strict';

if (!process.env.K_SERVICE) {
  try { require('dotenv').config(); } catch (_) {}
}

const dns = require('dns').promises;
const net = require('net');
const { Pool } = require('pg');

function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkUrl(url, label) {
  try {
    const res = await fetch(url, { method: 'GET' });
    const text = await res.text();
    const body = text.length > 280 ? (text.slice(0, 280) + '...') : text;
    return { ok: !!res.ok, status: res.status, label, url, body };
  } catch (err) {
    return {
      ok: false,
      status: null,
      label,
      url,
      error: String(err && err.message ? err.message : err || 'unknown'),
    };
  }
}

async function checkTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    function done(result) {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      resolve(result);
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ ok: true }));
    socket.once('timeout', () => done({ ok: false, error: 'timeout' }));
    socket.once('error', (err) => done({
      ok: false,
      error: String(err && err.message ? err.message : err || 'socket_error'),
      code: err && err.code ? String(err.code) : null,
    }));

    try {
      socket.connect(port, host);
    } catch (err) {
      done({
        ok: false,
        error: String(err && err.message ? err.message : err || 'connect_error'),
        code: err && err.code ? String(err.code) : null,
      });
    }
  });
}

function parseDbUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    return {
      ok: true,
      host: u.hostname || '',
      port: Number(u.port || 5432),
      db: String(u.pathname || '').replace(/^\/+/, ''),
      protocol: String(u.protocol || '').replace(':', ''),
      hasPooler: /pooler/i.test(u.hostname || ''),
      hasSslmode: u.searchParams.has('sslmode'),
    };
  } catch (_) {
    return { ok: false };
  }
}

function summarizePgError(err) {
  if (!err) return { message: 'unknown_error', codes: [] };
  const codes = [];
  if (err.code) codes.push(String(err.code));
  if (Array.isArray(err.errors)) {
    for (const sub of err.errors) {
      if (sub && sub.code) codes.push(String(sub.code));
    }
  }
  const message = String(err.message || err);
  return { message, codes: Array.from(new Set(codes.filter(Boolean))) };
}

async function checkPgQuery() {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) return { ok: false, error: 'DATABASE_URL is not set' };

  let pool;
  try {
    pool = new Pool({
      connectionString: raw,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 7000,
      idleTimeoutMillis: 7000,
      max: 1,
    });
    const result = await pool.query('SELECT 1 AS ok');
    return { ok: true, row: result && result.rows && result.rows[0] ? result.rows[0] : null };
  } catch (err) {
    const summary = summarizePgError(err);
    return { ok: false, error: summary.message, codes: summary.codes };
  } finally {
    if (pool) {
      try { await pool.end(); } catch (_) {}
    }
  }
}

function printSection(title) {
  console.log('');
  console.log('='.repeat(14) + ' ' + title + ' ' + '='.repeat(14));
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  const localBases = [
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3100',
    'http://127.0.0.1:3101',
    'http://127.0.0.1:3102',
  ];
  const cloudBases = [
    'https://qcag-backend-k7disoxmcq-as.a.run.app',
    'https://qcag-backend-bgrkahehra-as.a.run.app',
  ];

  printSection('Local HTTP Health');
  for (const base of localBases) {
    const out = await checkUrl(base + '/api/ks/health', 'local');
    printJson(out);
  }

  printSection('Cloud Run Health');
  for (const base of cloudBases) {
    const out = await checkUrl(base + '/api/ks/health', 'cloud');
    printJson(out);
  }

  printSection('DATABASE_URL Parse');
  const parsed = parseDbUrl(process.env.DATABASE_URL);
  printJson(parsed);

  if (parsed.ok) {
    printSection('DNS Lookup');
    try {
      const records = await dns.lookup(parsed.host, { all: true });
      printJson({ ok: true, host: parsed.host, records });
    } catch (err) {
      printJson({
        ok: false,
        host: parsed.host,
        error: String(err && err.message ? err.message : err || 'dns_error'),
      });
    }

    printSection('TCP Connectivity');
    const tcp = await checkTcp(parsed.host, parsed.port, 8000);
    printJson({ host: parsed.host, port: parsed.port, ...tcp });
  }

  printSection('Postgres Query');
  const pg = await checkPgQuery();
  printJson(pg);

  printSection('Quick Hints');
  if (parsed.ok) {
    const local3000 = await checkUrl('http://127.0.0.1:3000/api/ks/health', 'local');
    if (!local3000.ok && local3000.status === 404) {
      console.log('- Port 3000 dang co server khac, nhung khong phai KS backend.');
      console.log('- Hay chay backend KS tren 3101/3102 hoac dung localStorage key ks_backend_url de chi dinh URL.');
    }
  }
  if (!parsed.ok) {
    console.log('- DATABASE_URL đang sai format hoặc thiếu.');
  } else if (!pg.ok && Array.isArray(pg.codes) && pg.codes.includes('EACCES')) {
    console.log('- Máy hiện tại đang bị chặn kết nối TCP ra DB (port 5432).');
    console.log('- Kiểm tra firewall/antivirus/VPN/proxy hoặc chính sách mạng công ty.');
    console.log('- Thử đổi mạng khác (4G hotspot) để đối chiếu nhanh.');
  } else if (!pg.ok && Array.isArray(pg.codes) && pg.codes.includes('ENOTFOUND')) {
    console.log('- Không phân giải được DNS host của Neon.');
  } else if (!pg.ok && Array.isArray(pg.codes) && pg.codes.includes('ETIMEDOUT')) {
    console.log('- Kết nối tới Neon bị timeout (mạng chặn hoặc route lỗi).');
  } else if (pg.ok) {
    console.log('- DB query thành công, backend có thể kết nối DB.');
  } else {
    console.log('- Xem mục Postgres Query ở trên để biết lỗi chi tiết.');
  }

  await timeout(50);
}

main().catch((err) => {
  console.error('[diagnose-connectivity] fatal:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
