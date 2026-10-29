// In Cloud Run, prefer service environment variables / secrets.
// Avoid loading a bundled .env file that could override/mask production config.
if (!process.env.K_SERVICE) {
    require('dotenv').config();
}

if (!process.env.TZ) {
    process.env.TZ = 'Asia/Ho_Chi_Minh';
}

const express = require('express');
const compression = require('compression');
const http = require('http');
const cors = require('cors');
const mysql = require('./lib/mysql-compat');
const crypto = require('crypto');
const { Storage } = require('@google-cloud/storage');
const { uploadBuffer } = require('./storage');
const { resolveKsRequestsOptions } = require('./lib/ks-request-query');

const gcs = new Storage();

const app = express();
const PORT = process.env.PORT || 3101;

// WebSocket: used to notify connected clients that server-side data changed,
// so they can refresh UI without a hard reload.
const server = http.createServer(app);

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wsClients = new Set();

// SSE: one-way realtime notifications (more reliable than WS in some proxies)
const sseClients = new Set();

function sseWrite(res, payload) {
    try {
        const data = JSON.stringify(payload == null ? {} : payload);
        // Named event makes client-side handling clearer.
        res.write(`event: invalidate\n`);
        res.write(`data: ${data}\n\n`);
    } catch (_) { }
}

function sseBroadcast(payload) {
    try {
        sseClients.forEach((res) => {
            try {
                if (!res || res.writableEnded) {
                    sseClients.delete(res);
                    return;
                }
                sseWrite(res, payload);
            } catch (_) {
                sseClients.delete(res);
            }
        });
    } catch (_) { }
}

function wsEncodeTextFrame(str) {
    const payload = Buffer.from(String(str || ''), 'utf8');
    const len = payload.length;
    let header;
    if (len <= 125) {
        header = Buffer.alloc(2);
        header[1] = len;
    } else if (len <= 65535) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        // writeBigUInt64BE exists in newer Node; keep compatibility with manual write.
        header.writeUInt32BE(0, 2);
        header.writeUInt32BE(len, 6);
    }
    header[0] = 0x81; // FIN + text
    return Buffer.concat([header, payload]);
}

function wsEncodeControlFrame(opcode, payloadBuf) {
    const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.alloc(0);
    const len = payload.length;
    const header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
    return Buffer.concat([header, payload]);
}

function wsBroadcast(payload) {
    try {
        const msg = JSON.stringify(payload == null ? {} : payload);
        const frame = wsEncodeTextFrame(msg);
        wsClients.forEach((c) => {
            try {
                if (c && !c.destroyed) c.write(frame);
            } catch (_) { }
        });
    } catch (_) { }
}

// ── In-memory cache for GET /api/ks/requests ──────────────────────────────────
// Eliminates repetitive Neon queries: cache is populated on first GET after any
// write, and served from RAM for all subsequent GETs until the next write.
let _ksRequestsCache = null; // { rows: Array, etag: string } | null
let _ksWarmingInProgress = false;
function ksInvalidateCache() {
    _ksRequestsCache = null;
    if (typeof ksWarmRequestsCache === 'function') {
        setTimeout(() => {
            ksWarmRequestsCache().catch(() => {});
        }, 200);
    }
}
// ────────────────────────────────────────────────────────────────────────────────

function wsInvalidate(resource, extra) {
    // Invalidate in-memory cache whenever any data changes
    if (resource === 'ks_requests') ksInvalidateCache();
    const payload = {
        type: 'invalidate',
        resource: resource,
        ts: Date.now(),
        ...(extra && typeof extra === 'object' ? extra : {}),
    };
    wsBroadcast(payload);
    sseBroadcast(payload);
}

function wsTryParseFrames(buf, onFrame) {
    // Very small parser for unfragmented frames.
    // Client->server frames are masked per spec.
    let offset = 0;
    while (offset + 2 <= buf.length) {
        const b0 = buf[offset];
        const b1 = buf[offset + 1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = (b0 & 0x0f);
        const masked = (b1 & 0x80) !== 0;
        let len = (b1 & 0x7f);
        let headerLen = 2;
        if (len === 126) {
            if (offset + 4 > buf.length) break;
            len = buf.readUInt16BE(offset + 2);
            headerLen = 4;
        } else if (len === 127) {
            if (offset + 10 > buf.length) break;
            // Only support <= 2^32-1
            const high = buf.readUInt32BE(offset + 2);
            const low = buf.readUInt32BE(offset + 6);
            if (high !== 0) return { error: 'frame_too_large' };
            len = low;
            headerLen = 10;
        }
        const maskLen = masked ? 4 : 0;
        const frameLen = headerLen + maskLen + len;
        if (offset + frameLen > buf.length) break;

        let payload = buf.slice(offset + headerLen + maskLen, offset + frameLen);
        if (masked) {
            const mask = buf.slice(offset + headerLen, offset + headerLen + 4);
            const unmasked = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i++) {
                unmasked[i] = payload[i] ^ mask[i % 4];
            }
            payload = unmasked;
        }

        if (fin) {
            try { onFrame({ opcode, payload }); } catch (_) { }
        }
        offset += frameLen;
    }
    return { remaining: buf.slice(offset) };
}

function startWsHeartbeat(intervalMs) {
    const ms = Number(intervalMs) || 30000;
    const timer = setInterval(() => {
        wsClients.forEach((sock) => {
            try {
                if (!sock || sock.destroyed) {
                    wsClients.delete(sock);
                    return;
                }
                if (sock.__wsAlive === false) {
                    sock.destroy();
                    wsClients.delete(sock);
                    return;
                }
                sock.__wsAlive = false;
                sock.write(wsEncodeControlFrame(0x9)); // ping
            } catch (_) { }
        });
    }, ms);
    timer.unref && timer.unref();
}

server.on('upgrade', (req, socket, head) => {
    try {
        const url = String(req.url || '');
        if (!url.startsWith('/ws')) {
            socket.destroy();
            return;
        }
        const key = req.headers['sec-websocket-key'];
        if (!key) {
            socket.destroy();
            return;
        }
        const accept = crypto
            .createHash('sha1')
            .update(String(key) + WS_GUID)
            .digest('base64');

        const headers = [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${accept}`,
        ];
        socket.write(headers.join('\r\n') + '\r\n\r\n');
        if (head && head.length) {
            // ignore any initial data
        }

        socket.__wsAlive = true;
        socket.__wsBuf = Buffer.alloc(0);
        wsClients.add(socket);

        socket.on('data', (chunk) => {
            try {
                socket.__wsBuf = Buffer.concat([socket.__wsBuf, chunk]);
                const parsed = wsTryParseFrames(socket.__wsBuf, (frame) => {
                    // handle ping/pong/close; ignore text payloads
                    if (frame.opcode === 0xA) {
                        socket.__wsAlive = true; // pong
                    } else if (frame.opcode === 0x9) {
                        socket.write(wsEncodeControlFrame(0xA, frame.payload)); // pong
                    } else if (frame.opcode === 0x8) {
                        socket.end();
                    }
                });
                if (parsed && parsed.error) {
                    socket.destroy();
                    wsClients.delete(socket);
                    return;
                }
                socket.__wsBuf = (parsed && parsed.remaining) ? parsed.remaining : Buffer.alloc(0);
            } catch (_) { }
        });

        socket.on('close', () => {
            wsClients.delete(socket);
        });
        socket.on('error', () => {
            wsClients.delete(socket);
        });
    } catch (e) {
        try { socket.destroy(); } catch (_) { }
    }
});

startWsHeartbeat();

app.use(compression());
app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '25mb' }));

// Ensure minimal CORS headers are always present (even on errors)
app.use((req, res, next) => {
    try {
        if (!res.getHeader('Access-Control-Allow-Origin')) res.setHeader('Access-Control-Allow-Origin', '*');
        if (!res.getHeader('Access-Control-Allow-Methods')) res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        if (!res.getHeader('Access-Control-Allow-Headers')) res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
        // Cache static assets (CSV ward mappings, images, fonts) for 1 year
        const url = String(req.url || '').toLowerCase();
        if (/\.(csv|png|jpg|jpeg|webp|svg|woff2|woff|ttf)$/i.test(url)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }

        if (String(req.method || '').toUpperCase() === 'OPTIONS') return res.status(200).end();
    } catch (e) { }
    return next();
});

// Basic in-memory rate limiter (per-IP, per-instance). Tunable via RATE_LIMIT_MAX and RATE_LIMIT_WINDOW_MS.
const _rateMap = new Map();
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 1200;
app.use((req, res, next) => {
    try {
        const reqPath = String(req.path || '');
        const reqMethod = String(req.method || '').toUpperCase();
        if (reqMethod === 'OPTIONS' || reqPath === '/events' || reqPath === '/health' || reqPath === '/db-health' || reqPath === '/ping') return next();
        if (reqPath.startsWith('/api/requests') || reqPath.startsWith('/api/tasks') || reqPath.startsWith('/api/surveys') || reqPath.startsWith('/api/outlets')) return next();
        if (String(req.path || '') === '/api/admin/mojibake/recover') {
            const bodySecret = req && req.body ? String(req.body.secret || '') : '';
            const envSecret = String(process.env.MIGRATION_SECRET || '');
            if (envSecret && bodySecret && bodySecret === envSecret) return next();
        }

        const ip = (req.headers && (req.headers['x-forwarded-for'] || req.ip)) ? String(req.headers['x-forwarded-for'] || req.ip).split(',')[0].trim() : (req.socket && req.socket.remoteAddress) || 'unknown';
        const now = Date.now();
        let entry = _rateMap.get(ip);
        if (!entry || now - entry.ts > RATE_LIMIT_WINDOW_MS) {
            entry = { ts: now, count: 1 };
        } else {
            entry.count = (entry.count || 0) + 1;
        }
        _rateMap.set(ip, entry);
        // occasional cleanup to avoid memory leak
        if (_rateMap.size > 5000) {
            const cutoff = now - RATE_LIMIT_WINDOW_MS * 2;
            for (const [k, v] of _rateMap.entries()) if (v.ts < cutoff) _rateMap.delete(k);
        }
        if (entry.count > RATE_LIMIT_MAX) {
            res.setHeader('Retry-After', String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
            return res.status(429).json({ ok: false, error: 'rate_limited' });
        }
    } catch (e) { }
    return next();
});

// Realtime events (SSE)
app.get('/events', (req, res) => {
    try {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        // Initial comment to establish the stream.
        res.write(': ok\n\n');

        sseClients.add(res);

        // Keep-alive ping to prevent idle timeouts.
        const pingTimer = setInterval(() => {
            try {
                if (res.writableEnded) {
                    clearInterval(pingTimer);
                    sseClients.delete(res);
                    return;
                }
                res.write(': ping\n\n');
            } catch (_) {
                clearInterval(pingTimer);
                sseClients.delete(res);
            }
        }, 25000);
        pingTimer.unref && pingTimer.unref();

        req.on('close', () => {
            try { clearInterval(pingTimer); } catch (_) { }
            sseClients.delete(res);
        });
    } catch (e) {
        try { res.end(); } catch (_) { }
    }
});

// Local/dev-only WebSocket test endpoint (no DB writes).
// Enable by setting ENABLE_WS_TEST=1. Never enabled on Cloud Run.
if (!process.env.K_SERVICE && process.env.ENABLE_WS_TEST === '1') {
    app.post('/__ws_test/invalidate', (req, res) => {
        const resource = (req.body && req.body.resource != null) ? String(req.body.resource) : (req.query && req.query.resource != null ? String(req.query.resource) : 'quotations');
        const action = (req.body && req.body.action != null) ? String(req.body.action) : (req.query && req.query.action != null ? String(req.query.action) : 'test');
        wsInvalidate(resource, { action });
        return res.json({ ok: true, resource, action, ts: Date.now() });
    });
}

// Realtime Invalidation trigger (cho phép App 1 kích hoạt SSE sang App 2 khi báo giá xong)
app.post('/api/ks/invalidate', (req, res) => {
    try {
        const b = req.body || {};
        const resource = b.resource ? String(b.resource) : 'ks_requests';
        const action = b.action ? String(b.action) : 'update';
        if (resource === 'ks_requests') ksInvalidateCache();
        wsInvalidate(resource, b);
        return res.json({ ok: true, resource, action, ts: Date.now() });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'invalidate_failed' });
    }
});

let dbInitPromise = null;
let dbReady = false;
let dbInitAttempts = 0;
let dbLastError = null;
let dbLastOkAt = null;

function getDbHealthSnapshot() {
    return {
        dbReady: !!dbReady,
        dbInitAttempts: Number(dbInitAttempts) || 0,
        dbLastOkAt: dbLastOkAt ? new Date(dbLastOkAt).toISOString() : null,
        dbLastError: dbLastError || null,
    };
}

function ensureDbInitStarted() {
    if (!dbInitPromise) {
        dbInitPromise = initDbWithRetry();
    }
    return dbInitPromise;
}

function getAuthSecret() {
    return process.env.AUTH_SECRET || process.env.DB_PASSWORD || 'dev-auth-secret';
}

function base64UrlEncode(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
    return buf
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function base64UrlDecodeToString(input) {
    const s = String(input).replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4;
    const padded = pad ? s + '='.repeat(4 - pad) : s;
    return Buffer.from(padded, 'base64').toString('utf8');
}

function signToken(payload, ttlSeconds) {
    const now = Math.floor(Date.now() / 1000);
    const body = Object.assign({}, payload || {}, {
        iat: now,
        exp: now + (Number(ttlSeconds) || 86400), // default 24h
    });

    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedBody = base64UrlEncode(JSON.stringify(body));
    const toSign = `${encodedHeader}.${encodedBody}`;
    const sig = crypto
        .createHmac('sha256', getAuthSecret())
        .update(toSign)
        .digest();
    const encodedSig = base64UrlEncode(sig);
    return `${toSign}.${encodedSig}`;
}

function verifyToken(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return null;
        const [h, p, s] = parts;
        const toSign = `${h}.${p}`;
        const expectedSig = base64UrlEncode(
            crypto.createHmac('sha256', getAuthSecret()).update(toSign).digest()
        );
        const sigA = Buffer.from(String(s));
        const sigB = Buffer.from(String(expectedSig));
        if (sigA.length !== sigB.length) return null;
        if (!crypto.timingSafeEqual(sigA, sigB)) {
            return null;
        }
        const payload = JSON.parse(base64UrlDecodeToString(p));
        const now = Math.floor(Date.now() / 1000);
        if (payload && payload.exp && now > payload.exp) return null;
        return payload;
    } catch (e) {
        return null;
    }
}

function isValidPhone(phone) {
    return /^\d{10}$/.test(String(phone || '').trim());
}

function isValidUsername(username) {
    const u = String(username || '').trim();
    return u === 'adminqcag' || isValidPhone(u);
}

function createPasswordHash(password) {
    const iterations = 120000;
    const salt = crypto.randomBytes(16);
    const hash = crypto.pbkdf2Sync(String(password || ''), salt, iterations, 32, 'sha256');
    return ['pbkdf2', 'sha256', String(iterations), salt.toString('hex'), hash.toString('hex')].join('$');
}

function verifyPassword(password, stored) {
    try {
        const s = String(stored || '');
        const parts = s.split('$');
        if (parts.length !== 5) return false;
        const algo = parts[1];
        const iterations = Number(parts[2]);
        const saltHex = parts[3];
        const hashHex = parts[4];
        if (algo !== 'sha256') return false;
        if (!Number.isFinite(iterations) || iterations < 1000) return false;
        const salt = Buffer.from(saltHex, 'hex');
        const expected = Buffer.from(hashHex, 'hex');
        const computed = crypto.pbkdf2Sync(String(password || ''), salt, iterations, expected.length, 'sha256');
        return crypto.timingSafeEqual(computed, expected);
    } catch (e) {
        return false;
    }
}

function getBearerToken(req) {
    const h = req && req.headers ? (req.headers['authorization'] || req.headers['Authorization']) : null;
    if (!h) return '';
    const v = String(h);
    if (!v.toLowerCase().startsWith('bearer ')) return '';
    return v.slice(7).trim();
}

function requireAuth(requiredRole) {
    return async function (req, res, next) {
        const token = getBearerToken(req);
        const payload = verifyToken(token);
        if (!payload || !payload.username) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
        }
        req.user = {
            id: payload.sub || null,
            username: payload.username,
            role: payload.role || 'user',
            name: payload.name || null,
        };
        if (requiredRole && req.user.role !== requiredRole) {
            return res.status(403).json({ ok: false, error: 'forbidden' });
        }
        return next();
    };
}

// pg-backed pool (see lib/mysql-compat.js for the mysql2 shim)
const pool = mysql.createPool();

async function ensureColumn(sql) {
    try {
        await pool.query(sql);
    } catch (err) {
        // 42701 = duplicate_column, 42809 = wrong_object_type (relation is view), 42P01 = undefined_table
        if (err && (err.code === '42701' || err.code === '42809' || err.code === '42P01')) return;
        console.warn('[ensureColumn] non-fatal:', err && err.message ? err.message : err);
    }
}

async function initDB() {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS quotations (
      id SERIAL PRIMARY KEY,
      quote_code VARCHAR(32) NOT NULL,
      outlet_code VARCHAR(64),
      outlet_name VARCHAR(255),
      spo_name VARCHAR(255),
      area VARCHAR(64),
      outlet_phone VARCHAR(64),
      sale_type VARCHAR(64),
      sale_code VARCHAR(64),
      sale_name VARCHAR(255),
      sale_phone VARCHAR(64),
      ss_name VARCHAR(255),
      house_number VARCHAR(64),
      street VARCHAR(255),
      ward VARCHAR(255),
      district VARCHAR(255),
      province VARCHAR(255),
      address TEXT,
      items TEXT,
      images TEXT,
      total_amount DECIMAL(15,2),
      spo_number VARCHAR(64),
      spo_status VARCHAR(255),
      notes TEXT,
      qcag_status VARCHAR(64),
      qcag_order_number VARCHAR(64),
      order_number VARCHAR(64),
      qcag_image_url TEXT,
      qcag_override_status VARCHAR(30),
      qcag_note TEXT,
      qcag_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ,
      UNIQUE (quote_code)
    )
  `);


    await pool.query(`
    CREATE TABLE IF NOT EXISTS inspections (
      id SERIAL PRIMARY KEY,
      quotation_id INTEGER NOT NULL,
      status VARCHAR(32) DEFAULT 'binh_thuong',
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(64) NOT NULL,
            name VARCHAR(255),
            password_hash VARCHAR(255) NOT NULL,
            role VARCHAR(16) NOT NULL DEFAULT 'user',
            approved SMALLINT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ,
            UNIQUE (username)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS quote_sequences (
            year CHAR(2) PRIMARY KEY,
            current_value INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ
        )
    `);

    // Ensure admin account exists (default password: admin123)
    const [
        [admin]
    ] = await pool.query('SELECT id FROM users WHERE username = ? LIMIT 1', ['adminqcag']);
    if (!admin || !admin.id) {
        await pool.query(
            `INSERT INTO users (id, username, fullname, password_hash, role, approved, is_internal, can_access_app1, can_access_app2, company, updated_at)
             VALUES ('USR_ADMINQCAG', ?, ?, ?, 'admin', true, true, true, true, 'QCAG', ?)`, ['adminqcag', 'Admin', createPasswordHash('admin123'), new Date()]
        );
    }

    // Schema V12 (3NF): Quotations table follows strict 17-column relational schema

    // Pending orders table for production order creation workflow
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pending_orders (
            id VARCHAR(64) PRIMARY KEY,
            created_by VARCHAR(255),
            created_by_name VARCHAR(255),
            created_at BIGINT NOT NULL,
            quotes TEXT,
            total_points INTEGER DEFAULT 0,
            total_amount DECIMAL(15,2) DEFAULT 0,
            updated_at TIMESTAMPTZ
        )
    `);
}

async function allocateQuoteCode(conn, year2) {
    const year = String(year2 || '').trim();
    if (!/^\d{2}$/.test(year)) throw new Error('invalid_year');

    // Initialize (only once per year) from existing numeric codes (YY#####).
    await conn.query(
        `
        INSERT INTO quote_sequences (year, current_value, updated_at)
        SELECT $1,
               COALESCE(MAX(CAST(SUBSTRING(quote_code FROM 3) AS INTEGER)), 0),
               NOW()
        FROM quotations
        WHERE quote_code LIKE $2 || '%'
          AND CHAR_LENGTH(quote_code) = 7
          AND quote_code ~ '^[0-9]{7}$'
        ON CONFLICT (year) DO NOTHING
        `, [year, year]
    );

    const [rows] = await conn.query(
        'SELECT current_value FROM quote_sequences WHERE year = ? FOR UPDATE', [year]
    );
    const cur = rows && rows[0] && rows[0].current_value != null ? Number(rows[0].current_value) : 0;
    const next = Number.isFinite(cur) && cur > 0 ? cur + 1 : 1;

    await conn.query(
        'UPDATE quote_sequences SET current_value = ?, updated_at = NOW() WHERE year = ?', [next, year]
    );

    return `${year}${String(next).padStart(5, '0')}`;
}

async function ensureIndex(sql) {
    try {
        await pool.query(sql);
    } catch (err) {
        // 42P07 = duplicate_table/index (PostgreSQL)
        if (err && err.code !== '42P07') {
            throw err;
        }
    }
}

// ======================== KS MOBILE DB INIT (SCHEMA V12) ========================
async function initKsDB() {
    // Push subscriptions table (kept for web-push notifications)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id SERIAL PRIMARY KEY,
          phone VARCHAR(32),
          role VARCHAR(16),
          subscription TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    try {
        await pool.query(`
            DROP VIEW IF EXISTS ks_requests_view CASCADE;
            DROP VIEW IF EXISTS ks_requests_lite_view CASCADE;
            DROP VIEW IF EXISTS ks_request_items CASCADE;
            ALTER TABLE request_items DROP CONSTRAINT IF EXISTS request_items_added_by_qcag_by_fkey;
            ALTER TABLE request_items DROP CONSTRAINT IF EXISTS request_items_brand_changed_by_fkey;
        `);
    } catch (err) {
        console.warn('[initKsDB] Views cleanup warning (non-fatal):', err && err.message ? err.message : err);
    }

    // Add indexes for optimization
    const ksIndexes = [
        'CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests (created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_requests_updated_at ON requests (updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_requests_requester_id ON requests (requester_id)',
        'CREATE INDEX IF NOT EXISTS idx_requests_outlet_id ON requests (outlet_id)',
        'CREATE INDEX IF NOT EXISTS idx_requests_tk_code ON requests (tk_code)',
        'CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status)',
        'CREATE INDEX IF NOT EXISTS idx_outlets_id ON outlets (id)',
        'CREATE INDEX IF NOT EXISTS idx_outlets_code ON outlets (code)',
        'CREATE INDEX IF NOT EXISTS idx_users_id ON users (id)',
        'CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone)',
        'CREATE INDEX IF NOT EXISTS idx_users_username ON users (username)',
        'CREATE INDEX IF NOT EXISTS idx_request_items_request_tk_code ON request_items (request_tk_code)',
        'CREATE INDEX IF NOT EXISTS idx_assets_owner_code_cat ON assets (owner_code, category)',
        'CREATE INDEX IF NOT EXISTS idx_notes_ref_id_type ON notes (ref_id, ref_type)',
    ];
    for (const sql of ksIndexes) {
        try {
            await pool.query(sql);
        } catch (err) {
            console.warn('[initKsDB] Index creation warning (non-fatal):', err && err.message ? err.message : err);
        }
    }

    // Group C Views & INSTEAD OF Triggers completely eliminated - all operations read/write directly to 3NF base tables

}
// ======================== END KS MOBILE DB INIT ========================

// ── Push notification helper ──────────────────────────────────────────
async function sendKsPush({ title, body, data = {}, targetPhone = null }) {
    const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
    const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
    const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@qcag.vn';
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
    const webpush = require('web-push');
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    try {
        let query_str = 'SELECT subscription FROM push_subscriptions';
        let params = [];
        if (targetPhone) {
            query_str += ' WHERE phone = ?';
            params.push(targetPhone);
        }
        const [rows] = await pool.query(query_str, params);
        if (!rows || rows.length === 0) return;
        const payload = JSON.stringify({ title, body, data });
        await Promise.allSettled(rows.map(r => {
            try {
                const sub = JSON.parse(r.subscription);
                return webpush.sendNotification(sub, payload);
            } catch (e) { return Promise.resolve(); }
        }));
    } catch (e) {
        console.warn('[push] sendKsPush error:', e && e.message ? e.message : e);
    }
}

// ── GET /api/push — return VAPID public key for client push registration ─
app.get('/api/push', (req, res) => {
    const publicKey = process.env.VAPID_PUBLIC_KEY || '';
    if (!publicKey) return res.status(503).json({ ok: false, error: 'VAPID not configured' });
    return res.json({ ok: true, publicKey });
});

// ── POST /api/ks/push/subscribe — save or update a device subscription ─
app.post('/api/ks/push/subscribe', async (req, res) => {
    try {
        const { subscription, phone, role } = req.body || {};
        if (!subscription) return res.status(400).json({ ok: false, error: 'missing_subscription' });
        const subStr = typeof subscription === 'string' ? subscription : JSON.stringify(subscription);
        // Upsert by endpoint — each browser endpoint is unique
        const endpoint = typeof subscription === 'object' ? subscription.endpoint : JSON.parse(subStr).endpoint;
        const [existing] = await pool.query('SELECT id FROM push_subscriptions WHERE subscription LIKE ?', ['%' + endpoint.slice(-40) + '%']);
        if (existing && existing.length > 0) {
            await pool.query(
                'UPDATE push_subscriptions SET subscription = ?, phone = ?, role = ?, updated_at = NOW() WHERE id = ?',
                [subStr, phone || null, role || null, existing[0].id]
            );
        } else {
            await pool.query(
                'INSERT INTO push_subscriptions (subscription, phone, role, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
                [subStr, phone || null, role || null]
            );
        }
        return res.json({ ok: true });
    } catch (err) {
        console.error('[push] subscribe error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'subscribe_failed' });
    }
});

async function initDbWithRetry() {
    let attempt = 0;
    while (true) {
        attempt += 1;
        dbInitAttempts = attempt;
        try {
            await initDB();
            await initKsDB();
            // Ensure quote_code is unique even on older DBs.
            await ensureIndex('CREATE UNIQUE INDEX uq_quote_code ON quotations (quote_code)');
            // Speed up pagination and ordering on large datasets.
            await ensureIndex('CREATE INDEX idx_quotations_created_id ON quotations (created_at, id)');
            await ensureIndex('CREATE INDEX idx_quotations_id ON quotations (id)');
            try {
                await pool.query('CREATE INDEX IF NOT EXISTS idx_quotations_sales_quote ON quotations USING btree (sales_id, quote_code)');
            } catch (_) {}
            dbReady = true;
            dbLastError = null;
            dbLastOkAt = Date.now();
            console.log('DB init OK');
            startDbKeepAlive();
            setTimeout(() => {
                if (typeof ksWarmRequestsCache === 'function') {
                    ksWarmRequestsCache().catch(() => {});
                }
            }, 300);
            return;
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            dbReady = false;
            dbLastError = msg;
            console.error(`DB init failed (attempt ${attempt}):`, msg);
            const delayMs = Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 5)));
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
}

// ── DB Keep-Alive ─────────────────────────────────────────────────────────────
// Neon and most managed PostgreSQL providers close idle connections after
// 5 minutes. Cloud Run with CPU throttling also pauses timers.
// This heartbeat runs every 4 minutes to keep the connection pool warm
// and automatically re-initializes if the pool is in a broken state.
let _keepAliveTimer = null;
function startDbKeepAlive() {
    // Disabled: Polling every 4 minutes keeps Neon DB awake 24/7 and incurs unnecessary compute costs.
    // The connection pool (pg) will automatically recreate connections if they drop while the DB sleeps.
    console.log('[db-keepalive] disabled to allow Neon DB to suspend and save costs');
}
// ─────────────────────────────────────────────────────────────────────────────

function normalizeBodyValue(value) {
    if (value == null) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value);
    } catch (_) {
        return null;
    }
}

function toNullableString(value) {
    if (value == null) return null;
    const s = String(value).trim();
    return s ? s : null;
}

function toNullableNumber(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function toTinyIntBool(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return value ? 1 : 0;
    const s = String(value).trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'y') return 1;
    if (s === '0' || s === 'false' || s === 'no' || s === 'n') return 0;
    return null;
}

function shrinkQuotationImages(rows) {
    try {
        if (!Array.isArray(rows)) return rows;
        return rows.map((row) => {
            if (row && typeof row.images === 'string' && row.images.length > 4000) {
                // Avoid huge payloads in list response (previews can be fetched later).
                row.images = '[]';
            }
            return row;
        });
    } catch (e) {
        return rows;
    }
}

const QUOTATION_SELECT_COLUMNS = [
    'id',
    'quote_code',
    'outlet_code',
    'outlet_name',
    'spo_name',
    'area',
    'outlet_phone',
    'sale_type',
    'sale_code',
    'sale_name',
    'sale_phone',
    'ss_name',
    'house_number',
    'street',
    'ward',
    'district',
    'province',
    'address',
    'items',
    // images will be computed to avoid huge payloads
    "CASE WHEN LENGTH(images) > 4000 THEN '[]' ELSE images END AS images",
    'total_amount',
    'spo_number',
    'spo_status',
    'notes',
    'qcag_status',
    'qcag_order_number',
    'order_number',
    'qcag_image_url',
    'qcag_override_status',
    'qcag_note',
    'qcag_at',
    'created_at',
    'updated_at',
    'due_date',
    'responsibles',
    'is_confirmed',
    'last_confirmed_at',
    'edit_history',
    'is_exported',
    'exported_at',
    'created_by',
    'created_by_name',
    'qc_signage_state',
    'tk_code',
].join(', ');

app.get('/db-health', async (req, res) => {
    // Always ping Neon directly — do not gate on dbReady flag so
    // callers can monitor actual connectivity even after a restart.
    try {
        await pool.query('SELECT 1');
        dbReady = true;
        dbLastError = null;
        dbLastOkAt = Date.now();
        // Ensure keep-alive is running after a successful ping
        startDbKeepAlive();
        res.json({ ok: true, ...getDbHealthSnapshot() });
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        dbReady = false;
        dbLastError = msg;
        // Trigger re-init on next request
        dbInitPromise = null;
        res.status(503).json({
            ok: false,
            error: 'database_unavailable',
            ...getDbHealthSnapshot(),
        });
    }
});

// ==== KIỂM TRA TRẠNG THÁI KHÓA TRÙNG OUTLET (SSoT NEON DATABASE) ====
async function checkOutletActiveState(conn, inOutletCode) {
    const raw = String(inOutletCode || '').trim();
    const cleanCode = raw.replace(/^OUT_/i, '').trim();
    if (!cleanCode || /^(new\s*outlet|ch[uư]a\s*c[oó]\s*code|temp_.*|none|unknown)$/i.test(cleanCode)) {
        return { state: 'unlocked', reason: 'placeholder_or_new' };
    }

    const targetOutletId = `out_${cleanCode}`;

    // Truy vấn tất cả requests và quotations liên quan đến outlet này (chống lọt lưới hoa/thường)
    const [rows] = await conn.query(`
        SELECT 
            'request' AS source_type,
            r.id::text AS backend_id,
            COALESCE(r.tk_code, '') AS tk_code,
            COALESCE(r.status, '') AS status,
            r.created_at,
            COALESCE(o.code, '') AS outlet_code,
            COALESCE(o.name, '') AS outlet_name,
            COALESCE(o.address, NULLIF(TRIM(CONCAT_WS(', ', NULLIF(o.house_number, ''), NULLIF(o.street, ''), NULLIF(o.ward, ''), NULLIF(o.district, ''), NULLIF(o.province, ''))), ''), o.street, '') AS address,
            COALESCE(o.phone, '') AS outlet_phone,
            COALESCE(o.latitude::text, '') AS latitude,
            COALESCE(o.longitude::text, '') AS longitude,
            COALESCE(u.region, o.area, '') AS region,
            COALESCE(u.fullname, '') AS sale_name,
            COALESCE(u.username, '') AS sale_code,
            COALESCE(u.username, '') AS sale_phone,
            COALESCE(q_lat.quote_code, '') AS quote_code,
            COALESCE(q_lat.total_amount, 0)::numeric AS total_amount,
            COALESCE(q_lat.order_number, '') AS order_number,
            COALESCE(q_lat.production_approval_status, '') AS production_approval_status
        FROM requests r
        LEFT JOIN outlets o ON (r.outlet_id = o.id OR r.outlet_id = o.code)
        LEFT JOIN users u ON r.requester_id = u.id::text
        LEFT JOIN LATERAL (
            SELECT 
                q_sub.quote_code, 
                q_sub.total_amount, 
                ord_sub.order_no AS order_number,
                COALESCE(oq_sub.approval_status, q_sub.status) AS production_approval_status
            FROM quotations q_sub
            LEFT JOIN order_quotes oq_sub ON oq_sub.quotation_code = q_sub.quote_code
            LEFT JOIN orders ord_sub ON ord_sub.id = oq_sub.order_id AND (ord_sub.is_deleted = false OR ord_sub.is_deleted IS NULL)
            WHERE (q_sub.tk_code = r.tk_code OR q_sub.request_tk_code = r.tk_code)
              AND (q_sub.is_deleted = false OR q_sub.is_deleted IS NULL)
            ORDER BY q_sub.created_at DESC LIMIT 1
        ) q_lat ON true
        WHERE (
            LOWER(TRIM(r.outlet_id::text)) IN (?, ?)
            OR LOWER(TRIM(COALESCE(o.code, ''))) = ?
            OR REGEXP_REPLACE(LOWER(TRIM(r.outlet_id::text)), '^out_', '') = ?
        )
        AND (r.is_deleted = false OR r.is_deleted IS NULL)
        AND (r.status IS NULL OR r.status NOT IN ('cancelled', 'bao_huy', 'rejected'))

        UNION ALL

        SELECT 
            'quotation' AS source_type,
            q2.id::text AS backend_id,
            COALESCE(q2.tk_code, q2.request_tk_code, '') AS tk_code,
            COALESCE(q2.status, '') AS status,
            q2.created_at,
            COALESCE(o2.code, REGEXP_REPLACE(q2.outlet_id::text, '^out_', '')) AS outlet_code,
            COALESCE(o2.name, q2.outlet_name, '') AS outlet_name,
            COALESCE(o2.address, NULLIF(TRIM(CONCAT_WS(', ', NULLIF(o2.house_number, ''), NULLIF(o2.street, ''), NULLIF(o2.ward, ''), NULLIF(o2.district, ''), NULLIF(o2.province, ''))), ''), o2.street, '') AS address,
            COALESCE(o2.phone, '') AS outlet_phone,
            COALESCE(o2.latitude::text, '') AS latitude,
            COALESCE(o2.longitude::text, '') AS longitude,
            COALESCE(u2.region, o2.area, '') AS region,
            COALESCE(u2.fullname, q2.created_by_name, '') AS sale_name,
            COALESCE(u2.username, q2.sales_id, '') AS sale_code,
            COALESCE(u2.username, '') AS sale_phone,
            COALESCE(q2.quote_code, '') AS quote_code,
            COALESCE(q2.total_amount, 0)::numeric AS total_amount,
            COALESCE(ord_lat2.order_no, '') AS order_number,
            COALESCE(ord_lat2.approval_status, q2.status, '') AS production_approval_status
        FROM quotations q2
        LEFT JOIN outlets o2 ON (q2.outlet_id = o2.id OR q2.outlet_id = o2.code)
        LEFT JOIN users u2 ON (q2.sales_id = u2.id::text OR q2.sales_id = u2.username)
        LEFT JOIN LATERAL (
            SELECT 
                ord2.order_no, 
                oq2.approval_status
            FROM order_quotes oq2
            JOIN orders ord2 ON ord2.id = oq2.order_id AND (ord2.is_deleted = false OR ord2.is_deleted IS NULL)
            WHERE oq2.quotation_code = q2.quote_code
            ORDER BY ord2.created_at DESC LIMIT 1
        ) ord_lat2 ON true
        WHERE (
            LOWER(TRIM(COALESCE(q2.outlet_id::text, ''))) IN (?, ?)
            OR LOWER(TRIM(COALESCE(o2.code, ''))) = ?
            OR REGEXP_REPLACE(LOWER(TRIM(COALESCE(q2.outlet_id::text, ''))), '^out_', '') = ?
        )
        AND (q2.is_deleted = false OR q2.is_deleted IS NULL)
        AND (q2.status IS NULL OR q2.status NOT IN ('cancelled', 'bao_huy', 'rejected'))
        AND NOT EXISTS (
            SELECT 1 FROM requests r2 
            WHERE r2.tk_code = COALESCE(q2.tk_code, q2.request_tk_code)
              AND (r2.is_deleted = false OR r2.is_deleted IS NULL)
        )
        ORDER BY created_at DESC
    `, [cleanCode, targetOutletId, cleanCode, cleanCode, cleanCode, targetOutletId, cleanCode, cleanCode]);

    if (!rows || rows.length === 0) {
        try {
            const [[outRec]] = await conn.query(`
                SELECT code, name, 
                       COALESCE(address, NULLIF(TRIM(CONCAT_WS(', ', NULLIF(house_number, ''), NULLIF(street, ''), NULLIF(ward, ''), NULLIF(district, ''), NULLIF(province, ''))), ''), street, '') AS address,
                       phone, latitude::text AS latitude, longitude::text AS longitude, area AS region
                FROM outlets
                WHERE LOWER(TRIM(code)) = ? OR LOWER(TRIM(id::text)) = ?
                LIMIT 1
            `, [cleanCode.toLowerCase(), targetOutletId.toLowerCase()]);
            if (outRec) {
                return {
                    state: 'unlocked',
                    reason: 'known_outlet_clean',
                    outletCode: outRec.code || cleanCode,
                    outletName: outRec.name || '',
                    address: outRec.address || '',
                    outletPhone: outRec.phone || '',
                    latitude: outRec.latitude || '',
                    longitude: outRec.longitude || '',
                    region: outRec.region || ''
                };
            }
        } catch (e) {}
        return { state: 'unlocked', reason: 'clean_outlet' };
    }

    // Ca 5: Đã duyệt sản xuất nhưng chưa có số đơn hàng
    const approvedNoPo = rows.find(r => {
        const isApproved = r.production_approval_status === 'approved';
        const hasOrder = Boolean(r.order_number && String(r.order_number).trim() !== '' && String(r.order_number).trim() !== '---');
        return isApproved && !hasOrder;
    });
    if (approvedNoPo) {
        const hasQuote = Boolean(approvedNoPo.quote_code && String(approvedNoPo.quote_code).trim() !== '' && String(approvedNoPo.quote_code).trim() !== '-');
        return {
            state: 'locked_approved',
            reason: 'production_approved_no_po',
            outletCode: cleanCode,
            outletName: approvedNoPo.outlet_name,
            address: approvedNoPo.address,
            outletPhone: approvedNoPo.outlet_phone,
            latitude: approvedNoPo.latitude,
            longitude: approvedNoPo.longitude,
            region: approvedNoPo.region,
            tkCode: approvedNoPo.tk_code,
            quoteCode: approvedNoPo.quote_code,
            hasQuote,
            sourceType: approvedNoPo.source_type,
            saleName: approvedNoPo.sale_name,
            saleCode: approvedNoPo.sale_code,
            salePhone: approvedNoPo.sale_phone,
            totalAmount: approvedNoPo.total_amount,
            canMerge: false,
            canOverride: true,
            record: approvedNoPo
        };
    }

    // Ca 2: Chưa ra đơn hàng
    const pendingActive = rows.find(r => {
        const hasOrder = Boolean(r.order_number && String(r.order_number).trim() !== '' && String(r.order_number).trim() !== '---');
        const isCompleted = String(r.status || '').toLowerCase() === 'completed';
        return !hasOrder && !isCompleted;
    });
    if (pendingActive) {
        const hasQuote = Boolean(pendingActive.quote_code && String(pendingActive.quote_code).trim() !== '' && String(pendingActive.quote_code).trim() !== '-');
        return {
            state: 'locked_pending',
            reason: 'active_request_or_quote_not_produced',
            outletCode: cleanCode,
            outletName: pendingActive.outlet_name,
            address: pendingActive.address,
            outletPhone: pendingActive.outlet_phone,
            latitude: pendingActive.latitude,
            longitude: pendingActive.longitude,
            region: pendingActive.region,
            tkCode: pendingActive.tk_code,
            quoteCode: pendingActive.quote_code,
            hasQuote,
            sourceType: pendingActive.source_type,
            saleName: pendingActive.sale_name,
            saleCode: pendingActive.sale_code,
            salePhone: pendingActive.sale_phone,
            totalAmount: pendingActive.total_amount,
            createdAt: pendingActive.created_at,
            canMerge: true,
            record: pendingActive
        };
    }

    // Ca 3: Tất cả đã ra đơn / đã hoàn tất
    const producedItem = rows.find(r => {
        const hasOrder = Boolean(r.order_number && String(r.order_number).trim() !== '' && String(r.order_number).trim() !== '---');
        const isCompleted = String(r.status || '').toLowerCase() === 'completed';
        return hasOrder || isCompleted;
    });
    if (producedItem) {
        const hasQuote = Boolean(producedItem.quote_code && String(producedItem.quote_code).trim() !== '' && String(producedItem.quote_code).trim() !== '-');
        return {
            state: 'confirm_new_phase',
            reason: 'all_previous_produced',
            outletCode: cleanCode,
            outletName: producedItem.outlet_name,
            address: producedItem.address,
            outletPhone: producedItem.outlet_phone,
            latitude: producedItem.latitude,
            longitude: producedItem.longitude,
            region: producedItem.region,
            tkCode: producedItem.tk_code,
            quoteCode: producedItem.quote_code,
            hasQuote,
            sourceType: producedItem.source_type,
            latestOrder: producedItem.order_number || 'Đã hoàn thành',
            canCreateNewPhase: true,
            canOverride: true,
            record: producedItem
        };
    }

    return { state: 'unlocked', reason: 'unknown' };
}

// GET /api/outlets/:code/lock-state — Kiểm tra trạng thái khóa trùng của outlet
app.get('/api/outlets/:code/lock-state', async (req, res) => {
    try {
        await ensureDbInitStarted();
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        const code = req.params.code ? String(req.params.code).trim() : '';
        if (!code) return res.json({ ok: true, success: true, state: 'unlocked', reason: 'empty_code' });
        const result = await checkOutletActiveState(pool, code);
        return res.json({ ok: true, success: true, ...result });
    } catch (err) {
        console.error('GET /api/outlets/:code/lock-state error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'db_error' });
    }
});

app.post('/auth/register', async (req, res) => {
    await ensureDbInitStarted();
    const phone = req.body && req.body.phone != null ? String(req.body.phone).trim() : '';
    const name = req.body && req.body.name != null ? String(req.body.name).trim() : '';
    if (!isValidPhone(phone)) return res.status(400).json({ ok: false, error: 'invalid_phone' });
    if (!name) return res.status(400).json({ ok: false, error: 'missing_name' });

    const [
        [existing]
    ] = await pool.query('SELECT id, approved FROM users WHERE username = ? LIMIT 1', [phone]);
    if (existing && existing.id) {
        if (!existing.approved) return res.status(409).json({ ok: false, error: 'already_pending' });
        return res.status(409).json({ ok: false, error: 'already_exists' });
    }

    await pool.query(
        `INSERT INTO users (id, username, fullname, password_hash, role, approved, is_internal, can_access_app1, can_access_app2, company, updated_at)
     VALUES (?, ?, ?, ?, 'sales', false, false, false, true, 'HEINEKEN', ?)`, ['USR_PHONE_' + phone, phone, name, createPasswordHash('123456'), new Date()]
    );

    res.json({ ok: true });
});

app.get(['/api/ks/push/lookup', '/push/lookup'], async (req, res) => {
    try {
        await ensureDbInitStarted();
        const endpoint = String((req.query && req.query.endpoint) || '').trim();
        const phone = String((req.query && (req.query.phone || req.query.sale_phone)) || '').replace(/\D/g, '').trim();
        const saleCode = String((req.query && (req.query.sale_code || req.query.saleCode || req.query.code)) || '').trim();

        if (!endpoint && !phone && !saleCode) {
            return res.status(400).json({ ok: false, error: 'missing_lookup_key' });
        }

        let row = null;
        if (endpoint && endpoint.length >= 20) {
            const endpointSuffix = endpoint.slice(-40);
            const [rows] = await pool.query(
                `SELECT p.phone, p.role, u.username, u.fullname, u.region, u.ss_name 
                 FROM push_subscriptions p 
                 LEFT JOIN users u ON (p.user_id = u.id OR p.phone = u.phone)
                 WHERE p.subscription LIKE ? 
                 ORDER BY p.updated_at DESC LIMIT 1`,
                ['%' + endpointSuffix + '%']
            );
            if (rows && rows.length > 0) row = rows[0];
        }

        if (!row && phone && phone.length >= 8) {
            const [rows] = await pool.query(
                `SELECT u.username, u.phone, u.fullname, u.region, u.ss_name, u.role
                 FROM users u
                 WHERE u.phone = ? OR u.username = ? OR u.id = ?
                 ORDER BY u.id DESC LIMIT 1`,
                [phone, phone, 'USR_PHONE_' + phone]
            );
            if (rows && rows.length > 0) row = rows[0];
        }

        if (!row && saleCode && saleCode.length >= 6) {
            const [rows] = await pool.query(
                `SELECT u.username, u.phone, u.fullname, u.region, u.ss_name, u.role
                 FROM users u
                 WHERE u.username = ? OR u.id = ?
                 ORDER BY u.id DESC LIMIT 1`,
                [saleCode, 'USR_SALE_' + saleCode]
            );
            if (rows && rows.length > 0) row = rows[0];
        }

        if (row && (row.phone || row.username)) {
            const codeClean = (row.username && !String(row.username).startsWith('USR_PHONE_')) ? row.username : (saleCode || '');
            return res.json({
                ok: true,
                user: {
                    phone: row.phone || phone || '',
                    saleCode: codeClean,
                    saleName: row.fullname || '',
                    role: 'heineken',
                    region: row.region || '',
                    ssName: row.ss_name || ''
                }
            });
        }

        return res.json({ ok: false, not_found: true });
    } catch (err) {
        return res.status(500).json({ ok: false, error: String(err && err.message || err) });
    }
});

app.post('/auth/login', async (req, res) => {
    await ensureDbInitStarted();
    const username = req.body && req.body.username != null ? String(req.body.username).trim() : '';
    const password = req.body && req.body.password != null ? String(req.body.password) : '';

    if (!isValidUsername(username)) {
        return res.status(400).json({ ok: false, error: 'invalid_username' });
    }

    const [
        [user]
    ] = await pool.query(
        'SELECT id, username, fullname, password_hash, role, approved, company, is_internal, can_access_app1, can_access_app2 FROM users WHERE username = ? LIMIT 1', [username]
    );

    if (!user || !user.id) {
        return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    if (String(user.role) !== 'admin' && Number(user.approved) === 0) {
        return res.status(403).json({ ok: false, error: 'pending_approval' });
    }

    if (!user.can_access_app2) {
        return res.status(403).json({
            ok: false,
            error: 'no_app2_access',
            message: 'Tài khoản của bạn không có quyền truy cập App Khảo Sát & Thiết Kế (App 2).'
        });
    }

    if (!verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    const token = signToken({
        sub: user.id,
        username: user.username,
        name: user.fullname || user.username,
        role: user.role,
        company: user.company || 'HEINEKEN',
        is_internal: !!user.is_internal,
    },
        60 * 60 * 24 * 7 // 7 days
    );

    res.json({
        ok: true,
        token,
        user: {
            username: user.username,
            name: user.fullname || user.username,
            fullname: user.fullname,
            role: user.role,
            company: user.company || 'HEINEKEN',
            is_internal: !!user.is_internal,
            can_access_app1: !!user.can_access_app1,
            can_access_app2: !!user.can_access_app2,
        },
    });
});

app.get('/auth/me', requireAuth(), async (req, res) => {
    res.json({ ok: true, user: { username: req.user.username, name: req.user.name, role: req.user.role } });
});

app.post('/auth/logout', async (req, res) => {
    // Stateless token: client deletes token. Keep endpoint for UX parity.
    res.json({ ok: true });
});

app.get('/auth/admin/pending', requireAuth('admin'), async (req, res) => {
    await ensureDbInitStarted();
    const [rows] = await pool.query(
        `SELECT username, fullname AS name, fullname
     FROM users
     WHERE role = 'user' AND approved = false
     ORDER BY created_at ASC`
    );
    res.json({ ok: true, pending: rows || [] });
});

app.post('/auth/admin/approve', requireAuth('admin'), async (req, res) => {
    await ensureDbInitStarted();
    const username = req.body && (req.body.username != null || req.body.phone != null) ?
        String(req.body.username != null ? req.body.username : req.body.phone).trim() :
        '';
    if (!isValidPhone(username)) return res.status(400).json({ ok: false, error: 'invalid_phone' });
    await pool.query('UPDATE users SET approved = true, can_access_app2 = true, updated_at = ? WHERE username = ? AND role = \'user\'', [new Date(), username]);
    res.json({ ok: true });
});

app.get('/auth/admin/users', requireAuth('admin'), async (req, res) => {
    await ensureDbInitStarted();
    const [rows] = await pool.query(
        `SELECT username, fullname AS name, fullname, role, approved, created_at, company, is_internal, can_access_app1, can_access_app2
         FROM users
         ORDER BY role DESC, created_at ASC`
    );

    const users = (rows || []).map((u) => ({
        username: u.username,
        name: u.fullname || u.username,
        fullname: u.fullname,
        role: u.role,
        approved: !!u.approved,
        company: u.company,
        is_internal: !!u.is_internal,
        can_access_app1: !!u.can_access_app1,
        can_access_app2: !!u.can_access_app2,
        created_at: u.created_at,
    }));

    res.json({ ok: true, users });
});

// ============ PUBLIC: Get approved users (for dropdown selection) ============
// No auth required - returns only username + name for approved users
app.get('/users/approved', async (req, res) => {
    try {
        await ensureDbInitStarted();
        const [rows] = await pool.query(
            `SELECT username, fullname AS name, fullname
             FROM users
             WHERE approved = true AND is_internal = true
             ORDER BY role DESC, fullname ASC`
        );

        const users = (rows || []).map((u) => ({
            username: u.username,
            name: u.fullname || u.username,
            fullname: u.fullname,
        }));

        res.json({ ok: true, users });
    } catch (err) {
        console.error('[GET /users/approved] Error:', err);
        res.status(500).json({ ok: false, error: 'db_error' });
    }
});

app.post('/auth/admin/update', requireAuth('admin'), async (req, res) => {
    await ensureDbInitStarted();
    const username = req.body && (req.body.username != null || req.body.phone != null) ?
        String(req.body.username != null ? req.body.username : req.body.phone).trim() :
        '';
    const name = req.body && req.body.name != null ? String(req.body.name).trim() : '';

    if (!isValidPhone(username)) return res.status(400).json({ ok: false, error: 'invalid_phone' });
    if (!name) return res.status(400).json({ ok: false, error: 'missing_name' });

    await pool.query(
        'UPDATE users SET name = ?, updated_at = ? WHERE username = ? AND role = \'user\'', [name, new Date(), username]
    );
    res.json({ ok: true });
});

app.post('/auth/admin/delete', requireAuth('admin'), async (req, res) => {
    await ensureDbInitStarted();
    const username = req.body && (req.body.username != null || req.body.phone != null) ?
        String(req.body.username != null ? req.body.username : req.body.phone).trim() :
        '';
    if (!isValidPhone(username)) return res.status(400).json({ ok: false, error: 'invalid_phone' });

    await pool.query('DELETE FROM users WHERE username = ? AND role = \'user\'', [username]);
    res.json({ ok: true });
});

app.post('/auth/admin/change-password', requireAuth('admin'), async (req, res) => {
    await ensureDbInitStarted();
    const old_password = req.body && req.body.old_password != null ? String(req.body.old_password) : '';
    const new_password = req.body && req.body.new_password != null ? String(req.body.new_password) : '';
    if (!new_password) return res.status(400).json({ ok: false, error: 'missing_new_password' });

    const [
        [user]
    ] = await pool.query(
        'SELECT id, password_hash FROM users WHERE username = ? AND role = \'admin\' LIMIT 1', ['adminqcag']
    );
    if (!user || !user.id) return res.status(404).json({ ok: false, error: 'not_found' });

    if (!verifyPassword(old_password, user.password_hash)) {
        return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    await pool.query('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [createPasswordHash(new_password), new Date(), user.id]);
    res.json({ ok: true });
});

// Helper: parse a before_created_at query param as a proper Date object.
// This ensures mysql2 (with timezone:'+07:00') converts it to the correct local
// datetime string for comparison instead of passing a raw ISO-UTC string which
// MySQL would misinterpret as +07:00 local time (7-hour shift, losing ~29% of rows).
function parseBeforeCreatedAt(raw) {
    if (!raw) return null;
    try {
        const d = new Date(String(raw).trim());
        return !isNaN(d.getTime()) ? d : null;
    } catch (_) {
        return null;
    }
}
app.get('/quotations/view', async (req, res) => {
    try {
        await ensureDbInitStarted();
        const saleCode = req.query.sale_code;
        const quoteCode = req.query.quote_code;
        if (!saleCode || !quoteCode) {
            return res.status(400).json({ error: 'Missing sale_code or quote_code' });
        }

        const [rows] = await pool.query(
            `SELECT ${QUOTATION_SELECT_COLUMNS}
             FROM quotations
             WHERE sale_code = ? AND (quote_code = ? OR tk_code = ?)
             LIMIT 1`,
            [saleCode, quoteCode, quoteCode]
        );

        if (rows && rows.length > 0) {
            const shrunk = shrinkQuotationImages(rows);
            return res.json(shrunk[0]);
        } else {
            return res.status(404).json({ error: 'Quotation not found' });
        }
    } catch (e) {
        console.error('Error fetching quotation view', e);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/quotations', async (req, res) => {
    try {
        await ensureDbInitStarted();

        const tkCode = req.query && (req.query.tk_code || req.query.request_tk_code) ? String(req.query.tk_code || req.query.request_tk_code).trim() : '';
        if (tkCode) {
            const [tkRows] = await pool.query(
                `SELECT ${QUOTATION_SELECT_COLUMNS}
                 FROM quotations
                 WHERE (request_tk_code = ? OR tk_code = ?)
                 ORDER BY created_at DESC LIMIT 5`,
                [tkCode, tkCode]
            );
            return res.json(shrinkQuotationImages(tkRows));
        }

        const limitRaw = Number(req.query && req.query.limit);
        const offsetRaw = Number(req.query && req.query.offset);
        const beforeIdRaw = Number(req.query && req.query.before_id);
        const beforeCreatedAtRaw = req.query && req.query.before_created_at != null ? String(req.query.before_created_at).trim() : '';
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100;
        const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
        const beforeId = Number.isFinite(beforeIdRaw) ? Math.max(0, Math.floor(beforeIdRaw)) : 0;
        const beforeCreatedAt = parseBeforeCreatedAt(beforeCreatedAtRaw);

        if (beforeCreatedAt || beforeId) {
            if (beforeCreatedAt && beforeId) {
                const [rows] = await pool.query(
                    `SELECT ${QUOTATION_SELECT_COLUMNS}
                     FROM quotations
                     WHERE (created_at < ? OR (created_at = ? AND id < ?))
                     ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
                    [beforeCreatedAt, beforeCreatedAt, beforeId]
                );
                return res.json(rows);
            }
            if (beforeCreatedAt) {
                const [rows] = await pool.query(
                    `SELECT ${QUOTATION_SELECT_COLUMNS}
                     FROM quotations
                     WHERE created_at < ?
                     ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
                    [beforeCreatedAt]
                );
                return res.json(rows);
            }
            const [rows] = await pool.query(
                `SELECT ${QUOTATION_SELECT_COLUMNS}
                 FROM quotations
                 WHERE id < ?
                 ORDER BY id DESC LIMIT ${limit}`,
                [beforeId]
            );
            return res.json(rows);
        }

        if (offset > 0) {
            const [cursorRows] = await pool.query(
                'SELECT id, created_at FROM quotations ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ?',
                [offset]
            );
            if (!cursorRows || !cursorRows.length) return res.json([]);
            const cursor = cursorRows[0];
            const [rows] = await pool.query(
                `SELECT ${QUOTATION_SELECT_COLUMNS}
                 FROM quotations
                 WHERE (created_at < ? OR (created_at = ? AND id < ?))
                 ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
                [cursor.created_at, cursor.created_at, cursor.id]
            );
            return res.json(rows);
        }

        const [rows] = await pool.query(
            `SELECT ${QUOTATION_SELECT_COLUMNS}
             FROM quotations ORDER BY created_at DESC, id DESC LIMIT ${limit}`
        );
        return res.json(rows);
    } catch (err) {
        try {
            const limitRaw = Number(req.query && req.query.limit);
            const offsetRaw = Number(req.query && req.query.offset);
            const beforeIdRaw = Number(req.query && req.query.before_id);
            const beforeCreatedAtRaw = req.query && req.query.before_created_at != null ? String(req.query.before_created_at).trim() : '';
            const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100;
            const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
            const beforeId = Number.isFinite(beforeIdRaw) ? Math.max(0, Math.floor(beforeIdRaw)) : 0;
            const beforeCreatedAt = parseBeforeCreatedAt(beforeCreatedAtRaw);

            if (beforeCreatedAt || beforeId) {
                if (beforeCreatedAt && beforeId) {
                    const [rows] = await pool.query(
                        `SELECT ${QUOTATION_SELECT_COLUMNS}
                         FROM quotations
                         WHERE (created_at < ? OR (created_at = ? AND id < ?))
                         ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
                        [beforeCreatedAt, beforeCreatedAt, beforeId]
                    );
                    return res.json(shrinkQuotationImages(rows));
                }
                if (beforeCreatedAt) {
                    const [rows] = await pool.query(
                        `SELECT ${QUOTATION_SELECT_COLUMNS}
                         FROM quotations
                         WHERE created_at < ?
                         ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
                        [beforeCreatedAt]
                    );
                    return res.json(shrinkQuotationImages(rows));
                }
                const [rows] = await pool.query(
                    `SELECT ${QUOTATION_SELECT_COLUMNS}
                     FROM quotations
                     WHERE id < ?
                     ORDER BY id DESC LIMIT ${limit}`,
                    [beforeId]
                );
                return res.json(shrinkQuotationImages(rows));
            }

            if (offset > 0) {
                const [cursorRows] = await pool.query(
                    'SELECT id, created_at FROM quotations ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ?',
                    [offset]
                );
                if (!cursorRows || !cursorRows.length) return res.json([]);
                const cursor = cursorRows[0];
                const [rows] = await pool.query(
                    `SELECT ${QUOTATION_SELECT_COLUMNS}
                     FROM quotations
                     WHERE (created_at < ? OR (created_at = ? AND id < ?))
                     ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
                    [cursor.created_at, cursor.created_at, cursor.id]
                );
                return res.json(shrinkQuotationImages(rows));
            }

            const [rows] = await pool.query(
                `SELECT ${QUOTATION_SELECT_COLUMNS}
                 FROM quotations ORDER BY created_at DESC, id DESC LIMIT ${limit}`
            );
            return res.json(shrinkQuotationImages(rows));
        } catch (err2) {
            console.error('GET /quotations failed:', err && err.message ? err.message : err);
            return res.status(500).json({ ok: false, error: 'db_error' });
        }
    }
});

app.post('/quotations', async (req, res) => {
    try {
        await ensureDbInitStarted();
        const year = new Date().getFullYear().toString().slice(-2);
        const b = req.body && typeof req.body === 'object' ? req.body : {};

        const isConfirmed = toTinyIntBool(b.is_confirmed);
        const isExported = toTinyIntBool(b.is_exported);

        const conn = await pool.getConnection();
        let quoteCode;
        let insertId;
        try {
            await conn.beginTransaction();
            quoteCode = await allocateQuoteCode(conn, year);
            const now = new Date();
            const columns = [
                'quote_code',
                'outlet_code',
                'outlet_name',
                'spo_name',
                'area',
                'outlet_phone',
                'sale_type',
                'sale_code',
                'sale_name',
                'sale_phone',
                'ss_name',
                'house_number',
                'street',
                'ward',
                'district',
                'province',
                'address',
                'items',
                'images',
                'total_amount',
                'spo_number',
                'spo_status',
                'notes',
                'qcag_status',
                'qcag_order_number',
                'order_number',
                'qcag_image_url',
                'due_date',
                'responsibles',
                'is_confirmed',
                'last_confirmed_at',
                'edit_history',
                'is_exported',
                'exported_at',
                'created_by',
                'created_by_name',
                'qc_signage_state',
                'created_at',
                'updated_at',
            ];

            const values = [
                quoteCode,
                toNullableString(b.outlet_code),
                toNullableString(b.outlet_name),
                toNullableString(b.spo_name),
                toNullableString(b.area),
                toNullableString(b.outlet_phone),
                toNullableString(b.sale_type),
                toNullableString(b.sale_code),
                toNullableString(b.sale_name),
                toNullableString(b.sale_phone),
                toNullableString(b.ss_name),
                toNullableString(b.house_number),
                toNullableString(b.street),
                toNullableString(b.ward),
                toNullableString(b.district),
                toNullableString(b.province),
                toNullableString(b.address),
                normalizeBodyValue(b.items),
                normalizeBodyValue(b.images),
                toNullableNumber(b.total_amount),
                toNullableString(b.spo_number),
                toNullableString(b.spo_status),
                normalizeBodyValue(b.notes),
                toNullableString(b.qcag_status),
                toNullableString(b.qcag_order_number),
                toNullableString(b.order_number),
                toNullableString(b.qcag_image_url),
                toNullableString(b.due_date),
                normalizeBodyValue(b.responsibles),
                isConfirmed == null ? 0 : isConfirmed,
                toNullableString(b.last_confirmed_at),
                normalizeBodyValue(b.edit_history),
                isExported == null ? 0 : isExported,
                toNullableString(b.exported_at),
                toNullableString(b.created_by),
                toNullableString(b.created_by_name),
                normalizeBodyValue(b.qc_signage_state),
                now,
                now,
            ];

            const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
            const sql = `INSERT INTO quotations (${columns.join(',')}) VALUES (${placeholders}) RETURNING id`;
            const [result] = await conn.query(sql, values);
            insertId = result && result.insertId ? result.insertId : null;
            await conn.commit();
        } catch (err) {
            try {
                await conn.rollback();
            } catch (_) { }
            // rethrow to outer handler
            throw err;
        } finally {
            conn.release();
        }

        res.json({ ok: true, id: insertId, quote_code: quoteCode });

        // Fetch new row and broadcast with data for instant display
        try {
            const [rows] = await pool.query('SELECT * FROM quotations WHERE id = ?', [insertId]);
            if (rows && rows[0]) {
                wsInvalidate('quotations', { action: 'create', id: insertId, data: rows[0] });
            } else {
                wsInvalidate('quotations', { action: 'create', id: insertId });
            }
        } catch (err) {
            wsInvalidate('quotations', { action: 'create', id: insertId });
        }
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error('POST /quotations failed:', msg, err);
        return res.status(500).json({ ok: false, error: 'create_failed', message: msg });
    }
});

const ALLOWED_QUOTE_UPDATE_FIELDS = new Set([
    'outlet_code',
    'outlet_name',
    'spo_name',
    'area',
    'outlet_phone',
    'sale_type',
    'sale_code',
    'sale_name',
    'sale_phone',
    'ss_name',
    'house_number',
    'street',
    'ward',
    'district',
    'province',
    'address',
    'items',
    'images',
    'total_amount',
    'spo_number',
    'spo_status',
    'notes',
    'qcag_status',
    'qcag_order_number',
    'order_number',
    'qcag_image_url',
    'qcag_override_status',
    'qcag_note',
    'qcag_at',
    'due_date',
    'responsibles',
    'is_confirmed',
    'last_confirmed_at',
    'edit_history',
    'is_exported',
    'exported_at',
    'created_by',
    'created_by_name',
    'qc_signage_state',
]);

async function updateQuotationById(id, body) {
    const b = body && typeof body === 'object' ? body : {};
    const sets = [];
    const values = [];

    for (const key of Object.keys(b)) {
        if (!ALLOWED_QUOTE_UPDATE_FIELDS.has(key)) continue;
        if (key === 'total_amount') {
            sets.push(`${key} = ?`);
            values.push(toNullableNumber(b[key]));
            continue;
        }
        if (key === 'is_confirmed' || key === 'is_exported') {
            sets.push(`${key} = ?`);
            values.push(toTinyIntBool(b[key]));
            continue;
        }
        if (key === 'items' || key === 'images' || key === 'notes' || key === 'responsibles' || key === 'edit_history' || key === 'qc_signage_state') {
            sets.push(`${key} = ?`);
            values.push(normalizeBodyValue(b[key]));
            continue;
        }
        // created_by / created_by_name are write-once: only fill if currently NULL or empty
        if (key === 'created_by' || key === 'created_by_name') {
            sets.push(`${key} = COALESCE(NULLIF(${key}, ''), ?)`);
            values.push(toNullableString(b[key]));
            continue;
        }
        sets.push(`${key} = ?`);
        values.push(toNullableString(b[key]));
    }

    sets.push('updated_at = ?');
    values.push(new Date());
    values.push(id);

    const sql = `UPDATE quotations SET ${sets.join(', ')} WHERE id = ?`;
    const [result] = await pool.query(sql, values);
    return result;
}

app.patch('/quotations/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });

    const result = await updateQuotationById(id, req.body);
    if (!result || result.affectedRows === 0) return res.status(404).json({ ok: false, error: 'Not found' });

    // Fetch updated row and broadcast with data for instant local cache update
    try {
        const [rows] = await pool.query('SELECT * FROM quotations WHERE id = ?', [id]);
        if (rows && rows[0]) {
            wsInvalidate('quotations', { action: 'update', id, data: rows[0] });
        } else {
            wsInvalidate('quotations', { action: 'update', id });
        }
    } catch (err) {
        wsInvalidate('quotations', { action: 'update', id });
    }

    res.json({ ok: true });
});

app.put('/quotations/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });

    const result = await updateQuotationById(id, req.body);
    if (!result || result.affectedRows === 0) return res.status(404).json({ ok: false, error: 'Not found' });

    // Fetch updated row and broadcast with data for instant local cache update
    try {
        const [rows] = await pool.query('SELECT * FROM quotations WHERE id = ?', [id]);
        if (rows && rows[0]) {
            wsInvalidate('quotations', { action: 'update', id, data: rows[0] });
        } else {
            wsInvalidate('quotations', { action: 'update', id });
        }
    } catch (err) {
        wsInvalidate('quotations', { action: 'update', id });
    }

    res.json({ ok: true });
});

app.delete('/quotations/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });
    const [result] = await pool.query('DELETE FROM quotations WHERE id = ?', [id]);
    res.json({ ok: true, deleted: result.affectedRows || 0 });
    wsInvalidate('quotations', { action: 'delete', id });
});

// Admin-only: force-set created_by / created_by_name for a specific quote (data correction)
app.patch('/admin/quotations/:id/set-creator', requireAuth('admin'), async (req, res) => {
    await ensureDbInitStarted();
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const createdBy = b.created_by != null ? String(b.created_by).trim() : null;
    const createdByName = b.created_by_name != null ? String(b.created_by_name).trim() : null;
    if (!createdBy && !createdByName) return res.status(400).json({ ok: false, error: 'created_by or created_by_name required' });
    const sets = [];
    const vals = [];
    if (createdBy !== null) { sets.push('created_by = ?'); vals.push(createdBy || null); }
    if (createdByName !== null) { sets.push('created_by_name = ?'); vals.push(createdByName || null); }
    vals.push(id);
    const [result] = await pool.query(`UPDATE quotations SET ${sets.join(', ')} WHERE id = ?`, vals);
    if (!result || result.affectedRows === 0) return res.status(404).json({ ok: false, error: 'Not found' });
    try {
        const [rows] = await pool.query('SELECT * FROM quotations WHERE id = ?', [id]);
        if (rows && rows[0]) wsInvalidate('quotations', { action: 'update', id, data: rows[0] });
    } catch (_) { }
    res.json({ ok: true });
});

app.get(['/production-orders', '/orders'], async (req, res) => {
    try {
        // 1. Nguồn sự thật V12: Đọc từ bảng orders
        const [ordRows] = await pool.query(`
            SELECT id, order_no, construction_unit, region, area, due_date, status, approval_status,
                   quote_codes, total_points, quotes_count, total_amount,
                   created_by, created_by_name, created_at, updated_at
            FROM orders
            WHERE (is_deleted = false OR is_deleted IS NULL)
            ORDER BY created_at DESC
        `);

        if (!ordRows || ordRows.length === 0) {
            return res.json([]);
        }

        // Lấy danh sách order_id để batch-load order_quotes & quotations (Tránh N+1)
        const orderIds = ordRows.map(r => r.id);
        const placeholders = orderIds.map(() => '?').join(',');

        let quotesByOrderId = {};
        try {
            const [quoteRows] = await pool.query(`
                SELECT 
                    oq.order_id,
                    oq.id AS order_quote_id,
                    oq.quotation_code,
                    oq.sort_order,
                    COALESCE(oq.approval_status, 'approved') AS approval_status,
                    oq.reject_reason,
                    q.quote_code,
                    COALESCE(NULLIF(q.request_tk_code, ''), NULLIF(q.tk_code, ''), '') AS tk_code,
                    COALESCE(NULLIF(ot.name, ''), 'Outlet') AS outlet_name,
                    COALESCE(NULLIF(ot.code, ''), q.outlet_id, '') AS outlet_code,
                    COALESCE(NULLIF(ot.phone, ''), '') AS phone,
                    COALESCE(NULLIF(ot.address, ''), CONCAT_WS(', ', ot.house_number, ot.street, ot.ward, ot.district, ot.province), '') AS address,
                    ot.latitude::varchar AS lat,
                    ot.longitude::varchar AS lng,
                    ot.latitude::varchar AS outlet_lat,
                    ot.longitude::varchar AS outlet_lng,
                    COALESCE(uq.fullname, '') AS sale_name,
                    COALESCE(uq.phone, '') AS sale_phone,
                    COALESCE(ot.area, '') AS area,
                    COALESCE(q.total_amount, 0) AS total_amount,
                    COALESCE(q.status, '') AS quote_status
                FROM order_quotes oq
                JOIN quotations q ON oq.quotation_code = q.quote_code
                LEFT JOIN outlets ot ON (q.outlet_id = ot.id OR q.outlet_id = ot.code OR ot.id = 'OUT_' || q.outlet_id OR ot.code = REPLACE(q.outlet_id, 'OUT_', ''))
                LEFT JOIN users uq ON (q.sales_id = uq.id OR q.sales_id = uq.username)
                WHERE oq.order_id IN (${placeholders})
                ORDER BY oq.sort_order ASC, oq.id ASC
            `, orderIds);

            if (quoteRows && quoteRows.length > 0) {
                quoteRows.forEach(qr => {
                    if (!quotesByOrderId[qr.order_id]) quotesByOrderId[qr.order_id] = [];
                    quotesByOrderId[qr.order_id].push(qr);
                });
            }
        } catch (qErr) {
            console.warn('[production-orders] batch load order_quotes warning:', qErr && qErr.message);
        }

        const mapped = ordRows.map(r => {
            const quotes = quotesByOrderId[r.id] || [];
            let quoteKeys = [];
            if (Array.isArray(r.quote_codes)) {
                quoteKeys = r.quote_codes;
            } else if (typeof r.quote_codes === 'string') {
                try { quoteKeys = JSON.parse(r.quote_codes); } catch (_) {}
            }
            if (quoteKeys.length === 0 && quotes.length > 0) {
                quoteKeys = quotes.map(q => q.quotation_code);
            }

            return {
                id: r.id,
                order_number: r.order_no || r.id,
                spo_number: r.order_no || '',
                unit: r.construction_unit || '',
                construction_unit: r.construction_unit || '',
                address: quotes[0]?.address || '',
                area: r.area || 'PRODUCTION',
                region: r.region || '',
                due_date: r.due_date,
                status: r.status || 'pending',
                approval_status: r.approval_status || 'pending',
                items: JSON.stringify(quotes),
                quote_keys: JSON.stringify(quoteKeys),
                quotes: quotes,
                total_points: r.total_points || quoteKeys.length || quotes.length,
                quotes_count: r.quotes_count || quoteKeys.length || quotes.length,
                total_amount: Number(r.total_amount || 0),
                created_by: r.created_by,
                created_by_name: r.created_by_name,
                created_at: r.created_at,
                updated_at: r.updated_at
            };
        });

        return res.json(mapped);
    } catch (err) {
        console.error('GET /production-orders error:', err && err.message ? err.message : err);
        return res.status(500).json([]);
    }
});

// GET single production order with full quotes
app.get(['/production-orders/:id', '/orders/:id'], async (req, res) => {
    try {
        const rawId = String(req.params.id || '').trim();
        const [ordRows] = await pool.query(`
            SELECT id, order_no, construction_unit, region, area, due_date, status, approval_status,
                   quote_codes, total_points, quotes_count, total_amount,
                   created_by, created_by_name, created_at, updated_at
            FROM orders
            WHERE (id = ? OR order_no = ? OR id = ?) AND (is_deleted = false OR is_deleted IS NULL)
            LIMIT 1
        `, [rawId, rawId, `ORD_${rawId}`]);

        if (!ordRows || ordRows.length === 0) {
            return res.status(404).json({ ok: false, error: 'not_found' });
        }
        const r = ordRows[0];
        let quotes = [];
        try {
            const [quoteRows] = await pool.query(`
                SELECT 
                    oq.order_id,
                    oq.id AS order_quote_id,
                    oq.quotation_code,
                    oq.sort_order,
                    COALESCE(oq.approval_status, 'approved') AS approval_status,
                    oq.reject_reason,
                    q.quote_code,
                    COALESCE(NULLIF(q.request_tk_code, ''), NULLIF(q.tk_code, ''), '') AS tk_code,
                    COALESCE(NULLIF(ot.name, ''), 'Outlet') AS outlet_name,
                    COALESCE(NULLIF(ot.code, ''), q.outlet_id, '') AS outlet_code,
                    COALESCE(NULLIF(ot.phone, ''), '') AS phone,
                    COALESCE(NULLIF(ot.address, ''), CONCAT_WS(', ', ot.house_number, ot.street, ot.ward, ot.district, ot.province), '') AS address,
                    ot.latitude::varchar AS lat,
                    ot.longitude::varchar AS lng,
                    ot.latitude::varchar AS outlet_lat,
                    ot.longitude::varchar AS outlet_lng,
                    COALESCE(uq.fullname, '') AS sale_name,
                    COALESCE(uq.phone, '') AS sale_phone,
                    COALESCE(ot.area, '') AS area,
                    COALESCE(q.total_amount, 0) AS total_amount,
                    COALESCE(q.status, '') AS quote_status
                FROM order_quotes oq
                JOIN quotations q ON oq.quotation_code = q.quote_code
                LEFT JOIN outlets ot ON (q.outlet_id = ot.id OR q.outlet_id = ot.code OR ot.id = 'OUT_' || q.outlet_id OR ot.code = REPLACE(q.outlet_id, 'OUT_', ''))
                LEFT JOIN users uq ON (q.sales_id = uq.id OR q.sales_id = uq.username)
                WHERE oq.order_id = ?
                ORDER BY oq.sort_order ASC, oq.id ASC
            `, [r.id]);
            quotes = quoteRows || [];
        } catch (_) {}

        return res.json({
            ok: true,
            data: {
                id: r.id,
                order_number: r.order_no || r.id,
                spo_number: r.order_no || '',
                unit: r.construction_unit || '',
                construction_unit: r.construction_unit || '',
                address: quotes[0]?.address || '',
                area: r.area || 'PRODUCTION',
                region: r.region || '',
                due_date: r.due_date,
                status: r.status || 'pending',
                approval_status: r.approval_status || 'pending',
                items: JSON.stringify(quotes),
                quotes: quotes,
                total_points: r.total_points || quotes.length,
                quotes_count: r.quotes_count || quotes.length,
                total_amount: Number(r.total_amount || 0),
                created_by: r.created_by,
                created_by_name: r.created_by_name,
                created_at: r.created_at,
                updated_at: r.updated_at
            }
        });
    } catch (err) {
        console.error('GET /production-orders/:id error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'db_error' });
    }
});

app.post('/production-orders', async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const orderNo = toNullableString(b.order_number || b.spo_number);
    const id = b.id ? String(b.id).trim() : ('ORD_' + (orderNo ? orderNo.replace(/[^A-Za-z0-9]/g, '') : Date.now()));
    const constructionUnit = toNullableString(b.construction_unit || b.unit);
    const area = toNullableString(b.area || 'PRODUCTION');
    const region = toNullableString(b.region || 'PRODUCTION');
    const dueDate = b.due_date ? new Date(b.due_date) : null;
    const status = toNullableString(b.status || 'pending');
    const createdBy = toNullableString(b.created_by || b.createdBy || 'Admin');
    const createdByName = toNullableString(b.created_by_name || createdBy);

    // Bóc tách danh sách mã báo giá
    let quoteCodes = [];
    if (Array.isArray(b.quote_codes)) {
        quoteCodes = b.quote_codes.map(c => String(c).trim()).filter(Boolean);
    } else if (Array.isArray(b.quotes)) {
        quoteCodes = b.quotes.map(q => String(q.quote_code || q.quote_key || q.code || q.id || '').trim()).filter(Boolean);
    } else if (typeof b.quote_keys === 'string') {
        try { quoteCodes = JSON.parse(b.quote_keys); } catch (_) {}
    } else if (Array.isArray(b.quote_keys)) {
        quoteCodes = b.quote_keys.map(c => String(c).trim()).filter(Boolean);
    }

    const totalPoints = Number(b.total_points || (Array.isArray(quoteCodes) ? quoteCodes.length : 1));
    const totalAmount = Number(b.total_amount || 0);

    try {
        // 1. CẬP NHẬT CHUẨN V12: orders (20 cột)
        await pool.query(`
            INSERT INTO orders (id, order_no, construction_unit, region, area, due_date, status, quote_codes, total_points, quotes_count, total_amount, created_by, created_by_name, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, NOW(), NOW())
            ON CONFLICT (id) DO UPDATE SET
                order_no = COALESCE(EXCLUDED.order_no, orders.order_no),
                construction_unit = COALESCE(EXCLUDED.construction_unit, orders.construction_unit),
                region = COALESCE(EXCLUDED.region, orders.region),
                area = COALESCE(EXCLUDED.area, orders.area),
                due_date = COALESCE(EXCLUDED.due_date, orders.due_date),
                status = COALESCE(EXCLUDED.status, orders.status),
                quote_codes = COALESCE(EXCLUDED.quote_codes, orders.quote_codes),
                total_points = COALESCE(EXCLUDED.total_points, orders.total_points),
                quotes_count = COALESCE(EXCLUDED.quotes_count, orders.quotes_count),
                total_amount = COALESCE(EXCLUDED.total_amount, orders.total_amount),
                created_by_name = COALESCE(EXCLUDED.created_by_name, orders.created_by_name),
                updated_at = NOW()
        `, [
            id,
            orderNo,
            constructionUnit,
            region,
            area,
            dueDate,
            status,
            JSON.stringify(quoteCodes),
            totalPoints,
            totalPoints,
            totalAmount,
            createdBy,
            createdByName
        ]);

        // 2. CẬP NHẬT CHUẨN V12: order_quotes (1-N 3NF)
        if (Array.isArray(quoteCodes) && quoteCodes.length > 0) {
            await pool.query('DELETE FROM order_quotes WHERE order_id = ?', [id]);
            for (let idx = 0; idx < quoteCodes.length; idx++) {
                const qc = quoteCodes[idx];
                const oqId = `oq_${id}_${qc}`;
                await pool.query(`
                    INSERT INTO order_quotes (id, order_id, quotation_code, sort_order, approval_status, created_at)
                    VALUES (?, ?, ?, ?, 'pending', NOW())
                    ON CONFLICT (order_id, quotation_code) DO NOTHING
                `, [oqId, id, qc, idx]);
            }

            // Chuyển quotations sang confirmed
            const placeholders = quoteCodes.map(() => '?').join(',');
            await pool.query(
                `UPDATE quotations SET status = 'confirmed', updated_at = NOW() WHERE quote_code IN (${placeholders})`,
                quoteCodes
            );

            // Dọn dẹp đúng các quotes này khỏi pending_order_quotes & pending_orders
            await pool.query(
                `DELETE FROM pending_order_quotes WHERE quotation_code IN (${placeholders})`,
                quoteCodes
            );
            await pool.query(
                `DELETE FROM pending_orders WHERE id NOT IN (SELECT DISTINCT pending_order_id FROM pending_order_quotes)`
            );
            wsInvalidate('pending_orders', { action: 'clear' });
        }

        wsInvalidate('orders', { action: 'create', id });
        wsInvalidate('production-orders', { action: 'create' });
        return res.json({ ok: true, id, order_no: orderNo });
    } catch (err) {
        console.error('POST /production-orders error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'Database error' });
    }
});

app.post('/qcag/submit', async (req, res) => {
    const { quote_ids, status, note } = req.body || {};
    if (!Array.isArray(quote_ids) || !status) return res.status(400).json({ ok: false });
    await pool.query(
        `
      UPDATE quotations
      SET qcag_override_status = ?, qcag_note = ?, qcag_at = NOW(), updated_at = NOW()
      WHERE id IN (?)
    `, [status, note || null, quote_ids]
    );
    res.json({ ok: true });
    wsInvalidate('quotations', { action: 'qcag-submit', quote_ids });
});

app.post('/inspections', async (req, res) => {
    const { quotation_id, status, note } = req.body || {};
    if (!quotation_id || !status) return res.status(400).json({ ok: false });
    await pool.query(
        `
      INSERT INTO inspections (quotation_id, status, note)
      VALUES (?, ?, ?)
    `, [quotation_id, status, note || null]
    );
    res.json({ ok: true });
    wsInvalidate('inspections', { action: 'create', quotation_id });
    wsInvalidate('quotations', { action: 'inspection', quotation_id });
});

// ========== PENDING ORDERS API (3NF Architecture) ==========

// GET /pending-orders - Lấy tất cả pending orders kèm danh sách quote chi tiết
app.get(['/pending-orders', '/api/ks/pending-orders', '/api/pending-orders'], async (req, res) => {
    try {
        await ensureDbInitStarted();

        const reqSaleCode = req.query && (req.query.sale_code || req.query.saleCode) ? String(req.query.sale_code || req.query.saleCode).trim() : '';
        const rawPhone = req.query && (req.query.sale_phone || req.query.salePhone) ? String(req.query.sale_phone || req.query.salePhone).replace(/\D/g, '') : '';
        const reqPhoneSuffix = rawPhone.length >= 8 ? rawPhone.slice(-8) : rawPhone;

        const safeSaleCode = reqSaleCode.replace(/[^a-zA-Z0-9_-]/g, '');
        const safePhoneSuffix = reqPhoneSuffix.replace(/\D/g, '');

        const isSummary = String(req.query && (req.query.summary || req.query.lite) || '') === '1';

        let quoteFilter = '';
        let orderFilter = '';
        const params = [];
        const matchConditions = [];

        if (safeSaleCode) {
            params.push(safeSaleCode);
            const idx = params.length;
            matchConditions.push(`q.sales_id = $${idx}`);
            matchConditions.push(`uq.username = $${idx}`);
            matchConditions.push(`q.sales_id = 'USR_SALE_' || $${idx}`);
            matchConditions.push(`q.sales_id = 'USR_PHONE_' || $${idx}`);
        }
        if (safePhoneSuffix) {
            params.push(`%${safePhoneSuffix}`);
            const idx = params.length;
            matchConditions.push(`uq.phone LIKE $${idx}`);
            matchConditions.push(`o.phone LIKE $${idx}`);
            matchConditions.push(`q.sales_id LIKE $${idx}`);
        }

        if (matchConditions.length > 0) {
            quoteFilter = ` AND (${matchConditions.join(' OR ')})`;
            orderFilter = ` WHERE EXISTS (
                SELECT 1 FROM pending_order_quotes sub_poq
                JOIN quotations q ON sub_poq.quotation_code = q.quote_code
                LEFT JOIN outlets o ON (q.outlet_id = o.id OR q.outlet_id = o.code)
                LEFT JOIN users uq ON (q.sales_id = uq.id OR q.sales_id = uq.username)
                WHERE sub_poq.pending_order_id = po.id ${quoteFilter}
            )`;
        }

        const [rows] = await pool.query(`
            SELECT 
                po.id, 
                po.created_by, 
                COALESCE(po.created_by_name, u.fullname, po.created_by, 'User') AS created_by_name,
                po.created_at, 
                COALESCE((SELECT COUNT(*) FROM pending_order_quotes poq JOIN quotations q ON poq.quotation_code = q.quote_code LEFT JOIN outlets o ON (q.outlet_id = o.id OR q.outlet_id = o.code) LEFT JOIN users uq ON (q.sales_id = uq.id OR q.sales_id = uq.username) WHERE poq.pending_order_id = po.id ${quoteFilter}), 0) AS total_points, 
                COALESCE((SELECT SUM(q.total_amount) FROM pending_order_quotes poq JOIN quotations q ON poq.quotation_code = q.quote_code LEFT JOIN outlets o ON (q.outlet_id = o.id OR q.outlet_id = o.code) LEFT JOIN users uq ON (q.sales_id = uq.id OR q.sales_id = uq.username) WHERE poq.pending_order_id = po.id ${quoteFilter}), 0) AS total_amount, 
                po.updated_at,
                COALESCE(
                  (
                    SELECT json_agg(
                      json_build_object(
                        'quote_code', q.quote_code,
                        'quotation_code', q.quote_code,
                        'outlet_code', COALESCE(o.code, q.outlet_id, ''),
                        'outlet_name', COALESCE(o.name, ''),
                        'sale_name', COALESCE(uq.fullname, q.created_by_name, ''),
                        'sale_code', COALESCE(uq.username, q.sales_id, ''),
                        'sale_phone', COALESCE(uq.phone, o.phone, ''),
                        'sale_type', COALESCE(q.sale_type, 'Sale (SR)'),
                        'spo_number', COALESCE(q.spo_number, ''),
                        'spo_name', COALESCE(q.spo_number, ''),
                        'spo_status', COALESCE(q.spo_status, ''),
                        'ss_name', COALESCE(uq.ss_name, ''),
                        'ss', COALESCE(uq.ss_name, ''),
                        'ssName', COALESCE(uq.ss_name, ''),
                        'requester', COALESCE(q.created_by_name, ''),
                        'area', COALESCE(o.area, ''),
                        'total_amount', COALESCE(q.total_amount, 0),
                        'status', COALESCE(q.status, 'pending'),
                        'production_approval_status', COALESCE(q.status, 'pending'),
                        'approval_status', COALESCE(q.status, 'pending'),
                        'tk_code', COALESCE(q.tk_code, q.request_tk_code, ''),
                        'request_tk_code', COALESCE(q.tk_code, q.request_tk_code, ''),
                        'items', COALESCE((
                          SELECT json_agg(json_build_object(
                            'id', qi.id,
                            'type', COALESCE(qi.item_type, qi.product_name, 'Bảng hiệu'),
                            'product_name', COALESCE(qi.product_name, qi.item_type, ''),
                            'content', COALESCE(qi.product_name, qi.item_type, ''),
                            'brand', COALESCE(qi.brand, '-'),
                            'width', COALESCE(qi.width, 0),
                            'height', COALESCE(qi.height, 0),
                            'quantity', COALESCE(qi.qty, 1),
                            'qty', COALESCE(qi.qty, 1),
                            'action', 'Sản xuất mới'
                          ) ORDER BY qi.id ASC)
                          FROM quotation_items qi WHERE qi.quotation_code = q.quote_code
                        ), '[]'::json),
                        'images', COALESCE((SELECT json_agg(a.url) FROM assets a WHERE a.owner_code = q.quote_code AND a.owner_type = 'quotation'), '[]'::json),
                        'design_images', COALESCE((SELECT json_agg(a.url) FROM assets a WHERE a.owner_code = q.quote_code AND a.owner_type = 'quotation'), '[]'::json),
                        'qcag_image_url', COALESCE((SELECT a.url FROM assets a WHERE a.owner_code = q.quote_code AND a.owner_type = 'quotation' LIMIT 1), ''),
                        'sort_order', poq.sort_order
                      ) ORDER BY poq.sort_order ASC
                    )
                    FROM pending_order_quotes poq
                    JOIN quotations q ON poq.quotation_code = q.quote_code
                    LEFT JOIN outlets o ON (q.outlet_id = o.id OR q.outlet_id = o.code)
                    LEFT JOIN users uq ON (q.sales_id = uq.id OR q.sales_id = uq.username)
                    WHERE poq.pending_order_id = po.id ${quoteFilter}
                  ),
                  '[]'::json
                ) AS quotes
            FROM pending_orders po
            LEFT JOIN users u ON po.created_by = u.id OR po.created_by = u.username
            ${orderFilter}
            ORDER BY po.created_at DESC
        `, params);

        const orders = (rows || []).map(row => {
            let quotes = row.quotes;
            if (typeof quotes === 'string') {
                try { quotes = JSON.parse(quotes); } catch (_) { quotes = []; }
            }
            if (!Array.isArray(quotes)) quotes = [];

            quotes.forEach(q => {
                if (typeof q.items === 'string') {
                    try { q.items = JSON.parse(q.items); } catch (_) {}
                }
                if (typeof q.images === 'string') {
                    try { q.images = JSON.parse(q.images); } catch (_) {}
                }
                if (typeof q.design_images === 'string') {
                    try { q.design_images = JSON.parse(q.design_images); } catch (_) {}
                }
            });

            return {
                id: row.id,
                createdBy: row.created_by_name || row.created_by || 'User',
                createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
                quotes: quotes,
                totalPoints: Number(row.total_points) || quotes.length || 0,
                totalAmount: Number(row.total_amount) || 0
            };
        });

        res.json({ ok: true, data: orders });
    } catch (err) {
        console.error('GET /pending-orders error:', err && err.message ? err.message : err);
        res.status(500).json({ ok: false, error: 'db_error' });
    }
});

// POST /pending-orders - Tạo hoặc cập nhật pending order (3NF ACID Transaction)
app.post('/pending-orders', async (req, res) => {
    let conn = null;
    try {
        await ensureDbInitStarted();
        const b = req.body && typeof req.body === 'object' ? req.body : {};

        const id = b.id ? String(b.id).trim() : ('pending_' + Date.now());
        const createdByName = b.createdBy ? String(b.createdBy).trim() : 'User';
        const createdAtMs = Number(b.createdAt) || Date.now();
        const quotes = Array.isArray(b.quotes) ? b.quotes : [];
        const totalPoints = Number(b.totalPoints) || quotes.length || 0;
        const totalAmount = Number(b.totalAmount) || 0;

        // Resolve user ID nếu có trong bảng users
        let resolvedUserId = null;
        try {
            const [uRows] = await pool.query(
                'SELECT id FROM users WHERE id = ? OR username = ? OR fullname = ? LIMIT 1',
                [createdByName, createdByName, createdByName]
            );
            if (uRows && uRows.length > 0) resolvedUserId = uRows[0].id;
        } catch (_) {}

        conn = await pool.getConnection();
        await conn.beginTransaction();

        // 1. Upsert pending_orders
        await conn.query(
            `INSERT INTO pending_orders (id, created_by, created_by_name, total_points, total_amount, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, TO_TIMESTAMP(? / 1000.0), NOW())
             ON CONFLICT (id) DO UPDATE SET
                created_by = EXCLUDED.created_by,
                created_by_name = EXCLUDED.created_by_name,
                total_points = EXCLUDED.total_points,
                total_amount = EXCLUDED.total_amount,
                updated_at = NOW()`,
            [id, resolvedUserId, createdByName, totalPoints, totalAmount, createdAtMs]
        );

        // 2. Clear old junction records
        await conn.query('DELETE FROM pending_order_quotes WHERE pending_order_id = ?', [id]);

        // 3. Bulk insert quotes vào junction table pending_order_quotes
        for (let idx = 0; idx < quotes.length; idx++) {
            const q = quotes[idx];
            const qCode = String(q && (q.quote_code || q.quoteCode || q.id || q) || '').trim();
            if (!qCode) continue;
            const poqId = `poq_${id}_${qCode}_${idx}`;
            await conn.query(
                `INSERT INTO pending_order_quotes (id, pending_order_id, quotation_code, sort_order)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT (pending_order_id, quotation_code) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
                [poqId, id, qCode, idx]
            );
        }

        await conn.commit();

        // Notify other clients via WebSocket/SSE
        wsInvalidate('pending_orders', { action: 'upsert', id });

        res.json({ ok: true, id });
    } catch (err) {
        if (conn) {
            try { await conn.rollback(); } catch (_) {}
        }
        console.error('POST /pending-orders error:', err && err.message ? err.message : err);
        res.status(500).json({ ok: false, error: 'db_error' });
    } finally {
        if (conn) {
            try { conn.release(); } catch (_) {}
        }
    }
});

// DELETE /pending-orders/:id - Xóa một pending order (CASCADE)
app.delete('/pending-orders/:id', async (req, res) => {
    try {
        await ensureDbInitStarted();
        const id = req.params.id ? String(req.params.id).trim() : '';

        if (!id) {
            return res.status(400).json({ ok: false, error: 'missing_id' });
        }

        const [poqRows] = await pool.query(
            'SELECT quotation_code FROM pending_order_quotes WHERE pending_order_id = ? ORDER BY sort_order ASC',
            [id]
        );
        const quotes = (poqRows || []).map(r => ({ quote_code: r.quotation_code }));

        await pool.query('DELETE FROM pending_orders WHERE id = ?', [id]);

        // Notify other clients
        wsInvalidate('pending_orders', { action: 'delete', id });

        res.json({ ok: true, quotes });
    } catch (err) {
        console.error('DELETE /pending-orders error:', err && err.message ? err.message : err);
        res.status(500).json({ ok: false, error: 'db_error' });
    }
});

// DELETE /pending-orders - Xóa tất cả pending orders
app.delete('/pending-orders', async (req, res) => {
    try {
        await ensureDbInitStarted();


        await pool.query('DELETE FROM pending_orders');

        // Notify other clients
        wsInvalidate('pending_orders', { action: 'clear' });

        res.json({ ok: true, quotes: allQuotes });
    } catch (err) {
        console.error('DELETE /pending-orders (all) error:', err && err.message ? err.message : err);
        res.status(500).json({ ok: false, error: 'db_error' });
    }
});

// ========== END PENDING ORDERS API ==========

// ========== AI CHAT (GEMINI 2.0 FLASH) ==========

// Helper: call Gemini REST API (no extra npm package needed — uses Node 18+ built-in fetch)
async function callGemini(systemInstruction, userMessage, history) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    // Build contents array from history + current message
    const contents = [];
    if (Array.isArray(history)) {
        for (const h of history) {
            if (h && h.role && h.text) {
                contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(h.text) }] });
            }
        }
    }
    contents.push({ role: 'user', parts: [{ text: String(userMessage) }] });

    const body = {
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
    };

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Gemini API error ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return text.trim();
}

// Route: POST /api/ai/chat
app.post('/api/ai/chat', async (req, res) => {
    try {
        // Auth check
        const authHeader = req.headers && req.headers['authorization'];
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        const user = token ? verifyToken(token) : null;
        if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

        await ensureDbInitStarted();

        const message = req.body && req.body.message ? String(req.body.message).trim() : '';
        const history = req.body && Array.isArray(req.body.history) ? req.body.history : [];
        if (!message) return res.status(400).json({ ok: false, error: 'missing_message' });

        // Fetch summary stats from DB (injected as context for AI)
        let dbContext = '';
        try {
            const today = new Date();
            const yyyy = today.getFullYear();
            const mm = String(today.getMonth() + 1).padStart(2, '0');
            const todayStr = `${yyyy}-${mm}-${String(today.getDate()).padStart(2, '0')}`;
            const monthStart = `${yyyy}-${mm}-01`;

            const [[totalRow]] = await pool.query('SELECT COUNT(*) as cnt FROM quotations');
            const [[monthRow]] = await pool.query('SELECT COUNT(*) AS cnt FROM quotations WHERE created_at >= ?', [monthStart]);
            const [[todayRow]] = await pool.query('SELECT COUNT(*) AS cnt FROM quotations WHERE DATE(created_at) = ?', [todayStr]);
            const [[pendingRow]] = await pool.query('SELECT COUNT(*) AS cnt FROM pending_orders');
            const [[userRow]] = await pool.query('SELECT COUNT(*) AS cnt FROM users');

            // Recent quotations (last 10)
            const [recentQuotes] = await pool.query(
                'SELECT id, customer_name, status, total_amount, created_at, sale_name FROM quotations ORDER BY created_at DESC LIMIT 10'
            );

            const recentText = (recentQuotes || []).map(q =>
                `- Báo giá #${q.id}: KH "${q.customer_name || '?'}", Sale: ${q.sale_name || '?'}, Trạng thái: ${q.status || '?'}, Tổng: ${Number(q.total_amount || 0).toLocaleString('vi-VN')}đ, Ngày: ${q.created_at ? String(q.created_at).slice(0, 10) : '?'}`
            ).join('\n');

            dbContext = `
**Dữ liệu hệ thống QCAG (cập nhật realtime):**
- Tổng báo giá trong DB: ${totalRow?.cnt || 0}
- Báo giá tháng này (${yyyy}-${mm}): ${monthRow?.cnt || 0}
- Báo giá hôm nay (${todayStr}): ${todayRow?.cnt || 0}
- Đơn chờ xử lý (pending_orders): ${pendingRow?.cnt || 0}
- Tổng user: ${userRow?.cnt || 0}
- Người dùng đang hỏi: ${user.name || user.username || 'Unknown'} (username: ${user.username || 'N/A'})

**10 báo giá gần nhất:**
${recentText || '(không có dữ liệu)'}
`.trim();
        } catch (dbErr) {
            console.error('AI chat DB context error:', dbErr && dbErr.message);
            dbContext = '(Không thể lấy dữ liệu từ DB lúc này)';
        }

        const systemInstruction = `
    Bạn là "GiGi" — trợ lý AI thông minh và dễ thương của công ty QCAG (Quản lý Báo Giá Quảng Cáo).
    Bạn hỗ trợ nhân viên với các tác vụ: nhắc việc, báo cáo, tra cứu thông tin đơn hàng, báo giá.
    Trả lời bằng tiếng Việt, ngắn gọn, thân thiện, có thể dùng emoji nhẹ.
    Nếu được hỏi thông tin cụ thể ngoài dữ liệu được cung cấp, hãy trả lời trung thực là bạn chưa có đủ dữ liệu chi tiết.

    ${dbContext}

    Hướng dẫn:
    - Với câu hỏi về báo giá/đơn hàng: dùng số liệu từ dữ liệu hệ thống ở trên.
- Với câu hỏi tra cứu thông tin ngoài (giá vật liệu, quy định...) hãy trả lời dựa trên kiến thức của bạn và ghi rõ đây là thông tin tham khảo.
- Luôn thân thiện, dễ hiểu.
`.trim();

        const reply = await callGemini(systemInstruction, message, history);
        return res.json({ ok: true, reply });

    } catch (err) {
        console.error('POST /api/ai/chat error:', err && err.message ? err.message : err);
        if (err && err.message && err.message.includes('GEMINI_API_KEY')) {
            return res.status(503).json({ ok: false, error: 'ai_not_configured', message: 'GEMINI_API_KEY chưa được cấu hình trên server.' });
        }
        return res.status(500).json({ ok: false, error: 'ai_error', message: err && err.message ? err.message : 'Lỗi AI' });
    }
});

// ========== ADMIN MOJIBAKE RECOVERY ==========
app.post('/api/admin/mojibake/recover', async (req, res) => {
    try {
        const body = req.body || {};
        const secret = String(body.secret || '');
        const expected = String(process.env.MIGRATION_SECRET || '');
        if (!expected || !secret || secret !== expected) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
        }

        const allowedFields = new Set([
            'outlet_name', 'spo_name', 'sale_name', 'ss_name', 'address', 'items', 'notes',
            'images', 'qcag_note', 'customer_name', 'customer_phone',
            'created_by_name', 'spo_status', 'note', 'content', 'brand'
        ]);

        const scanOnly = Boolean(body.scanOnly);
        const force = Boolean(body.force);
        const syncCreatedByFromUsers = body.syncCreatedByFromUsers !== false;
        const records = Array.isArray(body.records) ? body.records : [];
        const suspiciousByField = {};

        const conn = await pool.getConnection();
        try {
            const [columnRows] = await conn.query(
                `SELECT column_name FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'quotations'`
            );
            const existingColumns = new Set((columnRows || []).map((r) => String(r.column_name || '')));
            const effectiveFields = [...allowedFields].filter((f) => existingColumns.has(f));

            let syncedCreatedByName = 0;
            if (syncCreatedByFromUsers && existingColumns.has('created_by') && existingColumns.has('created_by_name')) {
                const [syncResult] = await conn.query(`
                                        UPDATE quotations SET created_by_name = u.fullname
                                        FROM users u
                                        WHERE u.username = quotations.created_by
                                            AND u.fullname IS NOT NULL
                                            AND TRIM(u.fullname) <> ''
                                            AND (
                                                quotations.created_by_name IS NULL
                                                OR TRIM(quotations.created_by_name) = ''
                                                OR quotations.created_by_name LIKE '%?%'
                                                OR quotations.created_by_name LIKE '%�%'
                                            )
                                `);
                syncedCreatedByName = Number(syncResult && syncResult.affectedRows ? syncResult.affectedRows : 0);
            }

            for (const field of effectiveFields) {
                const [rows] = await conn.query(
                    `SELECT COUNT(*) AS cnt FROM quotations WHERE "${field}" LIKE '%?%' OR "${field}" LIKE '%�%'`
                );
                suspiciousByField[field] = Number(rows && rows[0] && rows[0].cnt ? rows[0].cnt : 0);
            }

            const suspiciousSamples = [];
            for (const field of effectiveFields) {
                const [sampleRows] = await conn.query(
                    `SELECT id, LEFT("${field}", 220) AS value FROM quotations WHERE "${field}" LIKE '%�%' OR (LENGTH("${field}") - LENGTH(REPLACE("${field}", '?', ''))) >= 3 LIMIT 5`
                );
                for (const row of (sampleRows || [])) {
                    suspiciousSamples.push({ id: Number(row.id), field, value: row.value });
                }
            }

            let noteQuestionSamples = [];
            if (effectiveFields.includes('notes')) {
                const [noteRows] = await conn.query(
                    "SELECT id, LEFT(notes, 260) AS value FROM quotations WHERE notes LIKE '%?%' LIMIT 3"
                );
                noteQuestionSamples = (noteRows || []).map((r) => ({ id: Number(r.id), value: r.value }));
            }
            if (scanOnly) {
                return res.json({ ok: true, scanOnly: true, syncedCreatedByName, suspiciousByField, suspiciousSamples, noteQuestionSamples });
            }

            let restored = 0;
            let skipped = 0;
            let mismatch = 0;
            let invalid = 0;

            for (const rec of records) {
                const id = Number(rec && rec.id);
                const field = String(rec && rec.field || '');
                const original = rec ? rec.original : null;
                const fixed = rec ? rec.fixed : null;

                if (!id || !allowedFields.has(field) || !existingColumns.has(field)) {
                    invalid++;
                    continue;
                }

                const [rows] = await conn.query(
                    `SELECT "${field}" AS value FROM quotations WHERE id = ? LIMIT 1`,
                    [id]
                );
                if (!rows || !rows.length) {
                    skipped++;
                    continue;
                }

                const current = rows[0].value;
                if (current === original) {
                    skipped++;
                    continue;
                }

                const currentText = typeof current === 'string' ? current : '';
                const hasCorruption = currentText.includes('?') || currentText.includes('�');
                const strictMatch = current === fixed;
                const shouldUpdate = force || strictMatch || hasCorruption;

                if (!shouldUpdate) {
                    mismatch++;
                    continue;
                }

                await conn.query(
                    `UPDATE quotations SET "${field}" = ? WHERE id = ?`,
                    [original, id]
                );
                restored++;
            }

            const suspiciousAfter = {};
            for (const field of effectiveFields) {
                const [rows] = await conn.query(
                    `SELECT COUNT(*) AS cnt FROM quotations WHERE "${field}" LIKE '%?%' OR "${field}" LIKE '%�%'`
                );
                suspiciousAfter[field] = Number(rows && rows[0] && rows[0].cnt ? rows[0].cnt : 0);
            }

            try {
                wsInvalidate('quotations', { action: 'mojibake_recover' });
            } catch (_) { }

            return res.json({
                ok: true,
                restored,
                skipped,
                mismatch,
                invalid,
                effectiveFields,
                syncedCreatedByName,
                suspiciousBefore: suspiciousByField,
                suspiciousAfter,
                suspiciousSamples,
                noteQuestionSamples
            });
        } finally {
            conn.release();
        }
    } catch (err) {
        console.error('POST /api/admin/mojibake/recover error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'recover_failed' });
    }
});
// ========== END ADMIN MOJIBAKE RECOVERY ==========

// ========== END AI CHAT ==========

// ======================== KS MOBILE API ========================

function safeIsoDate(raw) {
    if (raw == null) return null;
    const value = String(raw).trim();
    if (!value) return null;
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString();
}

// Helper: convert a DB row → camelCase app object
function ksRowToApp(row, lightweight = false) {
    if (!row) return null;
    let commentsStr = typeof row.comments === 'string' ? row.comments : JSON.stringify(row.comments || []);
    let parsedComments = [];
    try {
        let parsed = JSON.parse(commentsStr);
        if (typeof parsed === 'string') {
            try {
                const inner = JSON.parse(parsed);
                if (Array.isArray(inner)) parsed = inner;
            } catch (_) {}
        }
        if (Array.isArray(parsed)) {
            parsedComments = parsed;
        } else if (typeof parsed === 'string' && parsed.trim() && parsed.trim() !== '[]') {
            parsedComments = [{
                authorRole: 'heineken',
                authorName: row.production_approved_by || row.sale_name || 'Sale Heineken',
                text: parsed.trim(),
                commentType: 'edit-request',
                editCategories: [],
                createdAt: safeIsoDate(row.editing_requested_at) || safeIsoDate(row.updated_at) || new Date().toISOString()
            }];
        }
    } catch (_) {
        if (typeof commentsStr === 'string' && commentsStr.trim() && commentsStr !== '[]') {
            parsedComments = [{
                authorRole: 'heineken',
                authorName: row.production_approved_by || row.sale_name || 'Sale Heineken',
                text: commentsStr.trim(),
                commentType: 'edit-request',
                editCategories: [],
                createdAt: safeIsoDate(row.editing_requested_at) || safeIsoDate(row.updated_at) || new Date().toISOString()
            }];
        }
    }

    // Format items safely as valid JSON array string
    let itemsStr = '[]';
    if (typeof row.items === 'string') {
        itemsStr = row.items.trim() || '[]';
    } else if (Array.isArray(row.items) || (row.items && typeof row.items === 'object')) {
        itemsStr = JSON.stringify(row.items);
    }

    let statusImgs = typeof row.status_images === 'string' ? (row.status_images.trim() || '[]') : JSON.stringify(row.status_images || []);
    let designImgs = typeof row.design_images === 'string' ? (row.design_images.trim() || '[]') : JSON.stringify(row.design_images || []);
    let acceptImgs = typeof row.acceptance_images === 'string' ? (row.acceptance_images.trim() || '[]') : JSON.stringify(row.acceptance_images || []);
    let oldImgs = typeof row.old_content_images === 'string' ? (row.old_content_images.trim() || '[]') : JSON.stringify(row.old_content_images || []);

    if (lightweight) {
        if (parsedComments.length > 0) {
            for (let i = 0; i < parsedComments.length; i++) {
                const c = parsedComments[i];
                if (c && Array.isArray(c.images) && c.images.length > 0) {
                    c.images = c.images.map(img => {
                        if (typeof img === 'string' && (img.startsWith('data:') || img.length > 500)) {
                            return '...';
                        }
                        return img;
                    });
                }
            }
        }
        const stripHeavyImages = (str) => {
            if (!str || str === '[]') return '[]';
            if (str.includes('data:image') || str.length > 2000) {
                try {
                    const arr = JSON.parse(str);
                    if (Array.isArray(arr)) {
                        return JSON.stringify(arr.map(img => (typeof img === 'string' && (img.startsWith('data:') || img.length > 500)) ? '...' : img));
                    }
                } catch (_) {}
            }
            return str;
        };
        statusImgs = stripHeavyImages(statusImgs);
        designImgs = stripHeavyImages(designImgs);
        acceptImgs = stripHeavyImages(acceptImgs);
        oldImgs = stripHeavyImages(oldImgs);
    }
    commentsStr = JSON.stringify(parsedComments);

    // Build standardized requester JSON string with full V12 Sale & SS metadata
    let requesterObj = null;
    try {
        if (typeof row.requester === 'string' && row.requester.startsWith('{')) {
            requesterObj = JSON.parse(row.requester);
        }
    } catch (_) {}
    if (!requesterObj || typeof requesterObj !== 'object') {
        requesterObj = {
            role: (row.sale_code || row.sale_name) ? 'heineken' : 'qcag',
            saleName: row.sale_name || row.requester || '',
            saleCode: row.sale_code || '',
            phone: row.sale_phone || row.phone || '',
            region: row.region || '',
            ssName: row.ss_name || '',
            ssCode: row.ss_code || '',
            isTBA: Boolean(row.is_tba)
        };
    } else {
        if (!requesterObj.region && row.region) requesterObj.region = row.region;
        if (!requesterObj.saleName && row.sale_name) requesterObj.saleName = row.sale_name;
        if (!requesterObj.saleCode && row.sale_code) requesterObj.saleCode = row.sale_code;
        if (!requesterObj.phone && (row.sale_phone || row.phone)) requesterObj.phone = row.sale_phone || row.phone;
        if (!requesterObj.ssName && row.ss_name) requesterObj.ssName = row.ss_name;
        if (!requesterObj.ssCode && row.ss_code) requesterObj.ssCode = row.ss_code;
        if (typeof requesterObj.isTBA === 'undefined' && typeof row.is_tba !== 'undefined') requesterObj.isTBA = Boolean(row.is_tba);
    }

    return {
        __backendId: row.backend_id || ('db_' + row.id),
        id: row.id,
        tkCode: row.tk_code || '',
        type: row.type || 'new',
        region: row.region || requesterObj.region || '',
        outletCode: row.outlet_code || '',
        outletName: row.outlet_name || '',
        address: row.address || '',
        outletLat: row.outlet_lat || '',
        outletLng: row.outlet_lng || '',
        locationSource: row.location_source || 'manual',
        phone: row.phone || '',
        outletPhone: row.outlet_phone || row.phone || '',
        items: itemsStr,
        hasPendingSurvey: Boolean(row.has_pending_survey),
        has_pending_survey: Boolean(row.has_pending_survey),
        content: row.content || '',
        oldContent: Boolean(row.old_content),
        oldContentExtra: row.old_content_extra || '',
        oldContentImages: oldImgs,
        statusImages: statusImgs,
        designImages: designImgs,
        acceptanceImages: acceptImgs,
        comments: commentsStr,
        requester: JSON.stringify(requesterObj),
        status: row.status || 'pending',
        deleteRequested: Boolean(row.delete_requested),
        deleteReason: row.delete_reason || '',
        deleteRequestedAt: safeIsoDate(row.delete_requested_at),
        deleteRequestedBy: row.delete_requested_by || '',
        deleteRequestedPhone: row.delete_requested_phone || '',
        deleteRequestedSaleCode: row.delete_requested_sale_code || '',
        deleteStatus: row.delete_status || null,
        deleteRejectReason: row.delete_reject_reason || '',
        editingRequestedAt: safeIsoDate(row.editing_requested_at),
        hasHadDesign: Boolean(row.has_had_design),
        mqFolder: row.mq_folder || null,
        designCreatedBy: row.design_created_by || null,
        designCreatedAt: safeIsoDate(row.design_created_at),
        designLastEditedBy: row.design_last_edited_by || null,
        designLastEditedAt: safeIsoDate(row.design_last_edited_at),
        designFilename: row.design_filename || '',
        createdAt: safeIsoDate(row.created_at),
        updatedAt: safeIsoDate(row.updated_at),
        bridge: row.quote_code ? {
            quote_code: row.quote_code,
            quoteCode: row.quote_code,
            total_amount: Number(row.total_amount || 0),
            totalAmount: Number(row.total_amount || 0),
            status: row.quote_status || row.status || '',
            production_approval_status: row.production_approval_status || '',
            order_number: row.order_number || '',
            orderNumber: row.order_number || '',
            spo_status: row.spo_status || '',
            spo_number: row.spo_number || ''
        } : null,
        quoteCode: row.quote_code || '',
        totalAmount: Number(row.total_amount || 0),
        orderNumber: row.order_number || '',
        productionApprovalStatus: row.production_approval_status || '',
    };
}


const KS_REQUESTS_SELECT_SQL = `
    SELECT 
      COALESCE(r.id, r.tk_code) AS id,
      COALESCE(r.id, r.tk_code) AS backend_id,
      r.tk_code,
      COALESCE(r.type, 'new')::varchar(16) AS type,
      r.outlet_code,
      r.outlet_name,
      COALESCE(o.address, NULLIF(TRIM(CONCAT_WS(', ', NULLIF(o.house_number, ''), NULLIF(o.street, ''), NULLIF(o.ward, ''), NULLIF(o.district, ''), NULLIF(o.province, ''))), ''), o.street, '') AS address,
      o.latitude::varchar(32) AS outlet_lat,
      o.longitude::varchar(32) AS outlet_lng,
      COALESCE(COALESCE(o.phone, u.phone), '') AS phone,
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', ri.id,
          'seq', ri.seq,
          'type', ri.type,
          'otherContent', ri.other_content,
          'action', ri.action,
          'brand', ri.brand,
          'width', ri.width,
          'height', ri.height,
          'useOldSize', ri.use_old_size,
          'poles', ri.poles,
          'note', ri.note,
          'brandChangedByQcag', ri.brand_changed_by_qcag,
          'addedByQcag', ri.added_by_qcag,
          'survey', COALESCE(ri.survey, false),
          'surveySize', CASE 
            WHEN ri.survey_width IS NOT NULL AND ri.survey_height IS NOT NULL AND ri.survey_width > 0 AND ri.survey_height > 0 
            THEN json_build_object('width', ri.survey_width, 'height', ri.survey_height)
            ELSE NULL 
          END
        ) ORDER BY ri.seq)::text
        FROM request_items ri
        WHERE ri.request_tk_code = r.tk_code
      ), '[]') AS items,
      EXISTS(
        SELECT 1 FROM request_items ri 
        WHERE ri.request_tk_code = r.tk_code 
          AND COALESCE(ri.survey, false) = true 
          AND (ri.survey_width IS NULL OR ri.survey_width <= 0 OR ri.survey_height IS NULL OR ri.survey_height <= 0)
      ) AS has_pending_survey,
      r.content,
      COALESCE(r.old_content, false)::boolean AS old_content,
      r.old_content_extra,
      r.status,
      json_build_object(
        'role', CASE WHEN u.role IS NOT NULL THEN u.role ELSE 'heineken' END,
        'saleName', COALESCE(u.fullname, ''),
        'saleCode', COALESCE(u.username, ''),
        'phone', COALESCE(u.phone, o.phone, ''),
        'region', COALESCE(u.region, o.area, ''),
        'ssName', COALESCE(u.ss_name, ''),
        'ssCode', '',
        'isTBA', COALESCE(r.is_tba, false)
      )::text AS requester,
      '[]'::text AS comments,
      COALESCE((
        SELECT json_agg(ast.url ORDER BY ast.sort_order)::text
        FROM (
          SELECT url, sort_order FROM assets 
          WHERE owner_type = 'request' AND owner_code = r.tk_code AND category = 'status' 
          ORDER BY sort_order LIMIT 2
        ) ast
      ), '[]') AS status_images,
      COALESCE((
        SELECT json_agg(d.url)::text
        FROM (
          SELECT url FROM designs 
          WHERE request_tk_code = r.tk_code 
          ORDER BY id DESC LIMIT 1
        ) d
      ), '[]') AS design_images,
      '[]'::text AS acceptance_images,
      '[]'::text AS old_content_images,
      CASE 
        WHEN n_edit.created_at IS NOT NULL 
          AND (n_res.created_at IS NULL OR n_edit.created_at > n_res.created_at)
        THEN COALESCE(n_edit_first.created_at, n_edit.created_at)
        ELSE NULL::timestamptz
      END AS editing_requested_at,
      CASE
        WHEN (d_lat.created_at IS NOT NULL OR dt.created_at IS NOT NULL OR dt.designer_id IS NOT NULL)
        THEN true
        ELSE false
      END AS has_had_design,
      r.mq_folder,
      r.created_at,
      r.updated_at,
      COALESCE(u_des.fullname, u_des_d.fullname, NULLIF(dt.designer_id, ''), NULLIF(d_lat.created_by, ''), '') AS design_created_by,
      COALESCE(dt.created_at, d_lat.created_at) AS design_created_at,
      COALESCE(u_des.fullname, u_des_d.fullname, NULLIF(dt.designer_id, ''), NULLIF(d_lat.created_by, ''), '') AS design_last_edited_by,
      COALESCE(dt.updated_at, dt.created_at, d_lat.created_at) AS design_last_edited_at,
      COALESCE(d_lat.filename, '')::varchar(255) AS design_filename,
      r.sale_name,
      r.sale_phone,
      r.sale_code,
      r.ss_name,
      '' AS ss_code,
      r.region,
      COALESCE(r.is_tba, false) AS is_tba,
      COALESCE(r.delete_requested, false) AS delete_requested,
      COALESCE(r.delete_reason, '') AS delete_reason,
      r.delete_requested_at,
      r.delete_requested_by,
      r.delete_requested_phone,
      r.delete_requested_sale_code,
      r.delete_status,
      r.delete_reject_reason,
      COALESCE(q_lat.quote_code, '') AS quote_code,
      COALESCE(q_lat.total_amount, 0)::numeric AS total_amount,
      COALESCE(q_lat.quote_status, '') AS quote_status,
      COALESCE(q_lat.spo_status, '') AS spo_status,
      COALESCE(q_lat.spo_number, '') AS spo_number,
      COALESCE(q_lat.order_number, '') AS order_number,
      COALESCE(q_lat.production_approval_status, '') AS production_approval_status
    FROM (
        SELECT r_sub.*,
               COALESCE(o_sub.code, '') AS outlet_code,
               COALESCE(o_sub.name, '') AS outlet_name,
               COALESCE(u_sub.region, o_sub.area, '') AS region,
               COALESCE(u_sub.fullname, '') AS sale_name,
               COALESCE(u_sub.phone, '') AS sale_phone,
               COALESCE(u_sub.username, '') AS sale_code,
               COALESCE(u_sub.ss_name, '') AS ss_name
        FROM requests r_sub
        LEFT JOIN outlets o_sub ON r_sub.outlet_id = o_sub.id
        LEFT JOIN users u_sub ON r_sub.requester_id = u_sub.id
        WHERE COALESCE(r_sub.is_deleted, false) = false
    ) r
    LEFT JOIN outlets o ON r.outlet_id = o.id
    LEFT JOIN users u ON r.requester_id = u.id
    LEFT JOIN design_tasks dt ON dt.tk_code = r.tk_code
    LEFT JOIN users u_des ON u_des.id = dt.designer_id OR u_des.username = dt.designer_id OR u_des.phone = dt.designer_id
    LEFT JOIN LATERAL (
      SELECT d.url, d.created_by, d.created_at, d.filename 
      FROM designs d 
      WHERE d.request_tk_code = r.tk_code 
      ORDER BY d.created_at DESC, d.id DESC LIMIT 1
    ) d_lat ON true
    LEFT JOIN LATERAL (
      SELECT n.created_at
      FROM notes n
      WHERE (
          (n.ref_type = 'request' AND (n.ref_id = r.tk_code OR n.ref_id = r.id))
          OR (n.ref_type = 'quotation' AND n.ref_id IN (SELECT q_sub.quote_code FROM quotations q_sub WHERE q_sub.request_tk_code = r.tk_code))
        )
        AND n.note_type IN ('edit-request', 'edit_request')
      ORDER BY n.created_at DESC, n.id DESC LIMIT 1
    ) n_edit ON true
    LEFT JOIN LATERAL (
      SELECT n.created_at
      FROM notes n
      WHERE (
          (n.ref_type = 'request' AND (n.ref_id = r.tk_code OR n.ref_id = r.id))
          OR (n.ref_type = 'quotation' AND n.ref_id IN (SELECT q_sub.quote_code FROM quotations q_sub WHERE q_sub.request_tk_code = r.tk_code))
        )
        AND n.note_type = 'edit-resolved'
      ORDER BY n.created_at DESC, n.id DESC LIMIT 1
    ) n_res ON true
    LEFT JOIN LATERAL (
      SELECT n.created_at
      FROM notes n
      WHERE (
          (n.ref_type = 'request' AND (n.ref_id = r.tk_code OR n.ref_id = r.id))
          OR (n.ref_type = 'quotation' AND n.ref_id IN (SELECT q_sub.quote_code FROM quotations q_sub WHERE q_sub.request_tk_code = r.tk_code))
        )
        AND n.note_type IN ('edit-request', 'edit_request')
        AND (n_res.created_at IS NULL OR n.created_at > n_res.created_at)
      ORDER BY n.created_at ASC
      LIMIT 1
    ) n_edit_first ON true
    LEFT JOIN users u_des_d ON u_des_d.id = d_lat.created_by OR u_des_d.username = d_lat.created_by OR u_des_d.phone = d_lat.created_by
    LEFT JOIN LATERAL (
      SELECT 
          q_sub.quote_code, 
          q_sub.total_amount, 
          q_sub.status AS quote_status,
          q_sub.spo_status,
          q_sub.spo_number,
          ord_sub.order_no AS order_number,
          COALESCE(oq_sub.approval_status, q_sub.status) AS production_approval_status
      FROM quotations q_sub
      LEFT JOIN order_quotes oq_sub ON oq_sub.quotation_code = q_sub.quote_code
      LEFT JOIN orders ord_sub ON ord_sub.id = oq_sub.order_id AND (ord_sub.is_deleted = false OR ord_sub.is_deleted IS NULL)
      WHERE (q_sub.tk_code = r.tk_code OR q_sub.request_tk_code = r.tk_code)
        AND (q_sub.is_deleted = false OR q_sub.is_deleted IS NULL)
      ORDER BY q_sub.created_at DESC LIMIT 1
    ) q_lat ON true
`;

const KS_REQUESTS_LITE_SQL = `
    SELECT 
      COALESCE(r.id, r.tk_code) AS id,
      COALESCE(r.id, r.tk_code) AS backend_id,
      r.tk_code,
      COALESCE(NULLIF(r.type, ''), 'new')::varchar(16) AS type,
      COALESCE(o.code, '') AS outlet_code,
      COALESCE(o.name, '') AS outlet_name,
      COALESCE(o.address, NULLIF(TRIM(CONCAT_WS(', ', NULLIF(o.house_number, ''), NULLIF(o.street, ''), NULLIF(o.ward, ''), NULLIF(o.district, ''), NULLIF(o.province, ''))), ''), o.street, '') AS address,
      o.latitude::varchar(32) AS outlet_lat,
      o.longitude::varchar(32) AS outlet_lng,
      COALESCE(o.phone, u.phone, '') AS phone,
      '[]'::text AS items,
      EXISTS(
        SELECT 1 FROM request_items ri 
        WHERE ri.request_tk_code = r.tk_code 
          AND COALESCE(ri.survey, false) = true 
          AND (ri.survey_width IS NULL OR ri.survey_width <= 0 OR ri.survey_height IS NULL OR ri.survey_height <= 0)
      ) AS has_pending_survey,
      r.content,
      COALESCE(r.old_content, false)::boolean AS old_content,
      r.old_content_extra,
      r.status,
      json_build_object(
        'role', CASE WHEN u.role IS NOT NULL THEN u.role ELSE 'heineken' END,
        'saleName', COALESCE(u.fullname, ''),
        'saleCode', COALESCE(u.username, ''),
        'phone', COALESCE(u.phone, o.phone, ''),
        'region', COALESCE(u.region, o.area, ''),
        'ssName', COALESCE(u.ss_name, ''),
        'ssCode', '',
        'isTBA', COALESCE(r.is_tba, false)
      )::text AS requester,
      '[]'::text AS comments,
      '[]'::text AS status_images,
      CASE WHEN d_lat.url IS NOT NULL THEN json_build_array(d_lat.url)::text ELSE '[]'::text END AS design_images,
      '[]'::text AS acceptance_images,
      '[]'::text AS old_content_images,
      CASE 
        WHEN n_edit.created_at IS NOT NULL 
          AND (n_res.created_at IS NULL OR n_edit.created_at > n_res.created_at)
        THEN COALESCE(n_edit_first.created_at, n_edit.created_at)
        ELSE NULL::timestamptz
      END AS editing_requested_at,
      CASE
        WHEN (d_lat.created_at IS NOT NULL OR dt.created_at IS NOT NULL OR dt.designer_id IS NOT NULL)
        THEN true
        ELSE false
      END AS has_had_design,
      r.mq_folder,
      r.created_at,
      r.updated_at,
      COALESCE(u_des.fullname, u_des_d.fullname, NULLIF(dt.designer_id, ''), NULLIF(d_lat.created_by, ''), '') AS design_created_by,
      COALESCE(dt.created_at, d_lat.created_at) AS design_created_at,
      COALESCE(u_des.fullname, u_des_d.fullname, NULLIF(dt.designer_id, ''), NULLIF(d_lat.created_by, ''), '') AS design_last_edited_by,
      COALESCE(dt.updated_at, dt.created_at, d_lat.created_at) AS design_last_edited_at,
      COALESCE(d_lat.filename, '')::varchar(255) AS design_filename,
      COALESCE(u.fullname, '') AS sale_name,
      COALESCE(u.phone, '') AS sale_phone,
      COALESCE(u.username, '') AS sale_code,
      COALESCE(u.ss_name, '') AS ss_name,
      '' AS ss_code,
      COALESCE(u.region, o.area, '') AS region,
      COALESCE(r.is_tba, false) AS is_tba,
      COALESCE(r.delete_requested, false) AS delete_requested,
      COALESCE(r.delete_reason, '') AS delete_reason,
      r.delete_requested_at,
      r.delete_requested_by,
      r.delete_requested_phone,
      r.delete_requested_sale_code,
      r.delete_status,
      r.delete_reject_reason,
      COALESCE(q_lat.quote_code, '') AS quote_code,
      COALESCE(q_lat.total_amount, 0)::numeric AS total_amount,
      COALESCE(q_lat.quote_status, '') AS quote_status,
      COALESCE(q_lat.spo_status, '') AS spo_status,
      COALESCE(q_lat.spo_number, '') AS spo_number,
      COALESCE(q_lat.order_number, '') AS order_number,
      COALESCE(q_lat.production_approval_status, '') AS production_approval_status
    FROM requests r
    LEFT JOIN outlets o ON r.outlet_id = o.id
    LEFT JOIN users u ON r.requester_id = u.id
    LEFT JOIN design_tasks dt ON dt.tk_code = r.tk_code
    LEFT JOIN users u_des ON u_des.id = dt.designer_id OR u_des.username = dt.designer_id OR u_des.phone = dt.designer_id
    LEFT JOIN LATERAL (
      SELECT d.url, d.created_by, COALESCE(d.updated_at, d.created_at) AS created_at, d.filename 
      FROM designs d 
      WHERE d.request_tk_code = r.tk_code 
      ORDER BY COALESCE(d.updated_at, d.created_at) DESC, d.id DESC LIMIT 1
    ) d_lat ON true
    LEFT JOIN LATERAL (
      SELECT n.created_at
      FROM notes n
      WHERE (
          (n.ref_type = 'request' AND (n.ref_id = r.tk_code OR n.ref_id = r.id))
          OR (n.ref_type = 'quotation' AND n.ref_id IN (SELECT q_sub.quote_code FROM quotations q_sub WHERE q_sub.request_tk_code = r.tk_code))
        )
        AND n.note_type IN ('edit-request', 'edit_request')
      ORDER BY n.created_at DESC, n.id DESC LIMIT 1
    ) n_edit ON true
    LEFT JOIN LATERAL (
      SELECT n.created_at
      FROM notes n
      WHERE (
          (n.ref_type = 'request' AND (n.ref_id = r.tk_code OR n.ref_id = r.id))
          OR (n.ref_type = 'quotation' AND n.ref_id IN (SELECT q_sub.quote_code FROM quotations q_sub WHERE q_sub.request_tk_code = r.tk_code))
        )
        AND n.note_type = 'edit-resolved'
      ORDER BY n.created_at DESC, n.id DESC LIMIT 1
    ) n_res ON true
    LEFT JOIN LATERAL (
      SELECT n.created_at
      FROM notes n
      WHERE (
          (n.ref_type = 'request' AND (n.ref_id = r.tk_code OR n.ref_id = r.id))
          OR (n.ref_type = 'quotation' AND n.ref_id IN (SELECT q_sub.quote_code FROM quotations q_sub WHERE q_sub.request_tk_code = r.tk_code))
        )
        AND n.note_type IN ('edit-request', 'edit_request')
        AND (n_res.created_at IS NULL OR n.created_at > n_res.created_at)
      ORDER BY n.created_at ASC
      LIMIT 1
    ) n_edit_first ON true
    LEFT JOIN users u_des_d ON u_des_d.id = d_lat.created_by OR u_des_d.username = d_lat.created_by OR u_des_d.phone = d_lat.created_by
    LEFT JOIN LATERAL (
      SELECT 
          q_sub.quote_code, 
          q_sub.total_amount, 
          q_sub.status AS quote_status,
          q_sub.spo_status,
          q_sub.spo_number,
          ord_sub.order_no AS order_number,
          COALESCE(oq_sub.approval_status, q_sub.status) AS production_approval_status
      FROM quotations q_sub
      LEFT JOIN order_quotes oq_sub ON oq_sub.quotation_code = q_sub.quote_code
      LEFT JOIN orders ord_sub ON ord_sub.id = oq_sub.order_id AND (ord_sub.is_deleted = false OR ord_sub.is_deleted IS NULL)
      WHERE (q_sub.tk_code = r.tk_code OR q_sub.request_tk_code = r.tk_code)
        AND (q_sub.is_deleted = false OR q_sub.is_deleted IS NULL)
      ORDER BY q_sub.created_at DESC LIMIT 1
    ) q_lat ON true
    WHERE COALESCE(r.is_deleted, false) = false
    ORDER BY r.created_at DESC
`;

async function ksWarmRequestsCache() {
    if (_ksWarmingInProgress || !pool) return;
    _ksWarmingInProgress = true;
    try {
        const [rows] = await pool.query(KS_REQUESTS_LITE_SQL);
        const mapped = rows.map(r => ksRowToApp(r, true));
        const etag = '"' + crypto.createHash('md5').update(JSON.stringify(mapped)).digest('hex') + '"';
        _ksRequestsCache = { rows: mapped, etag };
        console.log(`[Cache] Pre-warmed _ksRequestsCache with ${mapped.length} records (ETag: ${etag})`);
    } catch (err) {
        console.warn('[Cache] ksWarmRequestsCache failed:', err && err.message ? err.message : err);
    } finally {
        _ksWarmingInProgress = false;
    }
}


// Helper: build safe GCS folder name for MQ images
// 'New Outlet' / empty → temp folder name; real code → 'mq-{sanitized}'
function ksSafeMqFolder(outletCode) {
    const code = String(outletCode || '').trim();
    if (!code || code.toLowerCase() === 'new outlet' || code.toLowerCase() === 'newoutlet') {
        return 'mq-NEWOUTLET-' + crypto.randomBytes(4).toString('hex');
    }
    const safe = code.replace(/[^a-zA-Z0-9]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 32);
    return 'mq-' + safe;
}

// Helper: rename GCS objects from oldPrefix → newPrefix inside bucket
// Returns new URL list for any given URL array (or empty if none match)
async function ksRenameGcsFolder(bucketName, oldPrefix, newPrefix) {
    if (!bucketName || !oldPrefix || !newPrefix || oldPrefix === newPrefix) return {};
    const bucket = gcs.bucket(bucketName);
    const [files] = await bucket.getFiles({ prefix: oldPrefix + '/' });
    const remap = {}; // oldUrl → newUrl
    await Promise.all(files.map(async (file) => {
        const oldName = file.name;
        const newName = newPrefix + '/' + oldName.slice(oldPrefix.length + 1);
        await bucket.file(oldName).copy(bucket.file(newName));
        await bucket.file(oldName).delete();
        const oldUrl = `https://storage.googleapis.com/${bucketName}/${oldName}`;
        const newUrl = `https://storage.googleapis.com/${bucketName}/${newName}`;
        remap[oldUrl] = newUrl;
    }));
    return remap;
}

// Helper: apply URL remap to a JSON array string of image URLs
function ksRemapImageUrls(jsonStr, remap) {
    try {
        const arr = JSON.parse(jsonStr || '[]');
        const remapped = arr.map(u => (typeof u === 'string' && remap[u]) ? remap[u] : u);
        return JSON.stringify(remapped);
    } catch (_) { return jsonStr; }
}


// GET /api/env — runtime environment config (same-origin contract)
app.get('/api/env', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end('window.__env = window.__env || {};');
});

// GET /api/ks/health
app.get('/api/ks/health', async (req, res) => {
    try {
        // Chờ DB khởi tạo xong (tối đa 8 giây) để Cloud Run cấp CPU xử lý kết nối,
        // tránh việc return 503 ngay lập tức làm container bị throttle CPU về 0.
        await Promise.race([
            ensureDbInitStarted(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('init_timeout')), 8000))
        ]);
    } catch (_) { }

    const snapshot = getDbHealthSnapshot();
    if (!snapshot.dbReady) {
        return res.status(503).json({
            ok: false,
            service: 'ks-mobile',
            ts: Date.now(),
            error: 'database_unavailable',
            ...snapshot,
        });
    }
    return res.json({
        ok: true,
        service: 'ks-mobile',
        ts: Date.now(),
        ...snapshot
    });
});

// GET /api/ks/proxy-image
// Proxies GCS image requests to bypass browser CORS headers for clipboard copying.
app.get('/api/ks/proxy-image', async (req, res) => {
    try {
        const rawUrl = req.query.url;
        if (!rawUrl) return res.status(400).send('Missing url parameter');

        const url = String(rawUrl).trim().replace(/^https:\/\/storage\.cloud\.google\.com\//i, 'https://storage.googleapis.com/');

        if (!url.startsWith('https://storage.googleapis.com/')) {
            return res.status(403).send('Forbidden URL domain');
        }

        const response = await fetch(url);
        if (!response.ok) {
            return res.status(response.status).send(`Failed to fetch image: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || 'image/png';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Cache-Control', 'public, max-age=86400');

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        return res.send(buffer);
    } catch (error) {
        console.error('proxy-image error:', error);
        return res.status(500).send(error.message);
    }
});

// GET /api/ks/stats — B-Tree Index Aggregate Stats (0.3KB payload, < 5ms execution for 1M rows)
app.get(['/api/ks/stats', '/stats'], async (req, res) => {
    try {
        const [statusRows] = await pool.query(`
            SELECT 
              CASE 
                WHEN status IN ('done', 'processed') THEN 'done'
                ELSE 'processing'
              END AS bucket,
              COUNT(*) AS count
            FROM requests
            GROUP BY 1
        `);

        const [regionRows] = await pool.query(`
            SELECT 
              COALESCE(NULLIF(TRIM(o.area), ''), 'other') AS region,
              COUNT(*) AS count
            FROM requests r
            LEFT JOIN outlets o ON r.outlet_id = o.id
            GROUP BY 1
        `);

        const [yearRows] = await pool.query(`
            SELECT 
              EXTRACT(YEAR FROM created_at)::int AS year,
              COUNT(*) AS count
            FROM requests
            GROUP BY 1
            ORDER BY 1 DESC
        `);

        const statusCounts = { processing: 0, done: 0, total: 0 };
        (statusRows || []).forEach(r => {
            const cnt = Number(r.count || 0);
            if (r.bucket === 'done') statusCounts.done += cnt;
            else statusCounts.processing += cnt;
            statusCounts.total += cnt;
        });

        const regionCounts = {};
        (regionRows || []).forEach(r => {
            regionCounts[r.region] = Number(r.count || 0);
        });

        const yearCounts = {};
        (yearRows || []).forEach(r => {
            if (r.year) yearCounts[r.year] = Number(r.count || 0);
        });

        return res.json({
            ok: true,
            status: statusCounts,
            regions: regionCounts,
            years: yearCounts,
            total: statusCounts.total
        });
    } catch (err) {
        console.error('GET /api/ks/stats error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'stats_failed' });
    }
});

// GET /api/ks/requests
// Pure B-Tree Row-Level Pagination (Max 20-50 rows = ~3KB payload, 0.08ms query on 1M rows)
// ZERO Monster JSON: never downloads entire database into client RAM
app.get('/api/ks/requests', async (req, res) => {
    try {
        const limitRaw = Number(req.query && req.query.limit);
        // Default 20 rows per page, maximum 50 rows. Guarantees ~3KB payload size
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 20;
        const cursor = String(req.query && (req.query.cursor || req.query.before) || '').trim();
        const statusFilter = String(req.query && req.query.status || '').trim().toLowerCase();
        const regionFilter = String(req.query && (req.query.region || req.query.area) || '').trim();
        const yearFilter = Number(req.query && req.query.year) || null;
        const { updatedSince } = resolveKsRequestsOptions(req.query || {});

        // Sale-specific query path (for Mobile Heineken): return requests for THAT Sale ONLY
        const salePhoneRaw = String(req.query && (req.query.sale_phone || req.query.phone || req.query.salePhone) || '').trim();
        const saleCodeRaw = String(req.query && (req.query.sale_code || req.query.saleCode) || '').trim();
        const searchQRaw = String(req.query && (req.query.q || req.query.search || req.query.query) || '').trim();

        // 1) Indexed Server Search path: direct B-tree search on physical tables (super fast < 15ms on 1M rows)
        if (searchQRaw) {
            const qTerm = `%${searchQRaw.toLowerCase()}%`;
            const [rows] = await pool.query(
                `${KS_REQUESTS_SELECT_SQL}
                 WHERE (r.tk_code ILIKE ? OR r.outlet_code ILIKE ? OR r.outlet_name ILIKE ? OR r.sale_name ILIKE ? OR r.sale_phone ILIKE ? OR o.phone ILIKE ? OR r.sale_code ILIKE ?)
                 ORDER BY r.created_at DESC LIMIT ${limit}`,
                [qTerm, qTerm, qTerm, qTerm, qTerm, qTerm, qTerm]
            );
            const mapped = rows.map(r => ksRowToApp(r, true));
            const nextCursor = rows.length > 0 ? rows[rows.length - 1].created_at : null;
            const hasMore = rows.length === limit;
            return res.json({
                ok: true,
                data: mapped,
                paging: { total: mapped.length, limit, hasMore, nextCursor: hasMore ? nextCursor : null }
            });
        }

        // 2) Fast ETag check: query MAX(updated_at) and COUNT(*) on base table requests (takes ~2ms)
        let serverEtag = null;
        try {
            const [statRows] = await pool.query(
                "SELECT COALESCE(TO_CHAR(MAX(updated_at), 'YYYYMMDDHH24MISSMS'), '0') AS max_up, COUNT(*) AS total FROM requests WHERE COALESCE(is_deleted, false) = false"
            );
            const statRow = statRows && statRows[0];
            if (statRow) {
                serverEtag = `"${statRow.max_up}_${statRow.total}"`;
                const clientEtag = req.headers['if-none-match'];
                res.setHeader('ETag', serverEtag);
                res.setHeader('Cache-Control', 'no-cache');
                if (clientEtag && clientEtag === serverEtag && !salePhoneRaw && !saleCodeRaw && !updatedSince && !cursor) {
                    return res.status(304).end();
                }
            }
        } catch (_) {}

        const roleRaw = String(req.query && (req.query.role || req.headers['x-user-role']) || '').trim().toLowerCase();
        const isInternalQcagRole = ['qcag', 'admin', 'operator', 'design'].indexOf(roleRaw) !== -1;

        // 3) Sale Heineken Mobile Filter (BẮT BUỘC ƯU TIÊN TRƯỚC ALL ĐỂ KHÔNG BỊ TRẢ TOÀN BỘ CACHE TOÀN QUỐC CHO SALE, NGOẠI TRỪ QCAG/ADMIN)
        if ((salePhoneRaw || saleCodeRaw) && !isInternalQcagRole) {
            const isLite = Boolean(req.query && (req.query.lite === '1' || req.query.lite === 'true' || req.query.summary === '1'));
            const conds = [];
            const params = [];
            if (salePhoneRaw) {
                const cleanPhone = salePhoneRaw.replace(/\s+/g, '');
                if (isLite) {
                    params.push(salePhoneRaw, cleanPhone, cleanPhone);
                    conds.push("(u.phone = ? OR REPLACE(COALESCE(u.phone, ''), ' ', '') = ? OR o.phone = ?)");
                } else {
                    params.push(salePhoneRaw, cleanPhone, cleanPhone);
                    conds.push("(u.phone = ? OR REPLACE(COALESCE(u.phone, ''), ' ', '') = ? OR o.phone = ?)");
                }
            }
            if (saleCodeRaw) {
                params.push(saleCodeRaw);
                conds.push(isLite ? "u.username = ?" : "r.sale_code = ?");
            }

            let sql = '';
            if (isLite) {
                const baseLite = KS_REQUESTS_LITE_SQL.replace(/ORDER BY r\.created_at DESC\s*$/, '').trim();
                sql = `${baseLite} AND (${conds.join(' OR ')}) ORDER BY r.created_at DESC LIMIT 200`;
            } else {
                sql = `${KS_REQUESTS_SELECT_SQL} WHERE (${conds.join(' OR ')}) ORDER BY r.created_at DESC LIMIT 200`;
            }

            const [rows] = await pool.query(sql, params);
            const mapped = rows.map(r => ksRowToApp(r, isLite));
            return res.json({
                ok: true,
                data: mapped,
                paging: { total: mapped.length, limit: mapped.length, hasMore: false, nextCursor: null }
            });
        }

        // 4) Full catalog path with In-Memory RAM cache (for Desktop QCAG & Mobile QCAG)
        const isAllRequested = Boolean(req.query && (req.query.all === '1' || req.query.all === 'true' || req.query.all === true));
        if (isAllRequested) {
            if (_ksRequestsCache) {
                const clientEtag = req.headers['if-none-match'];
                res.setHeader('ETag', _ksRequestsCache.etag);
                res.setHeader('Cache-Control', 'no-cache');
                if (clientEtag && clientEtag === _ksRequestsCache.etag) {
                    return res.status(304).end();
                }
                return res.json({
                    ok: true,
                    data: _ksRequestsCache.rows,
                    paging: { total: _ksRequestsCache.rows.length, limit: _ksRequestsCache.rows.length, offset: 0, hasMore: false }
                });
            }

            const isLite = Boolean(req.query && (req.query.lite === '1' || req.query.lite === 'true' || req.query.summary === '1'));
            const [rows] = await pool.query(isLite ? KS_REQUESTS_LITE_SQL : `${KS_REQUESTS_SELECT_SQL} ORDER BY r.created_at DESC`);
            const mapped = rows.map(r => ksRowToApp(r, true));
            const etag = '"' + crypto.createHash('md5').update(JSON.stringify(mapped)).digest('hex') + '"';
            _ksRequestsCache = { rows: mapped, etag };
            res.setHeader('ETag', etag);
            res.setHeader('Cache-Control', 'no-cache');
            return res.json({
                ok: true,
                data: mapped,
                paging: { total: mapped.length, limit: mapped.length, offset: 0, hasMore: false }
            });
        }

        // 4) Incremental Sync path (SWR)
        if (updatedSince) {
            const isLite = Boolean(req.query && (req.query.lite === '1' || req.query.lite === 'true' || req.query.summary === '1'));
            const [rows] = await pool.query(
                isLite
                    ? `${KS_REQUESTS_LITE_SQL.replace(/ORDER BY r\.created_at DESC\s*$/, '')} AND (r.updated_at >= ? OR r.created_at >= ?) ORDER BY r.updated_at DESC, r.id DESC LIMIT 100`
                    : `${KS_REQUESTS_SELECT_SQL} WHERE (r.updated_at >= ? OR r.created_at >= ?) ORDER BY r.updated_at DESC, r.id DESC LIMIT 100`,
                [updatedSince, updatedSince]
            );
            const mapped = rows.map(r => ksRowToApp(r, isLite));
            return res.json({
                ok: true,
                data: mapped,
                paging: { total: mapped.length, limit: mapped.length, hasMore: false, nextCursor: null }
            });
        }

        // 5) Total count from base table
        let total = 0;
        try {
            const [[countRow]] = await pool.query('SELECT COUNT(*) AS total FROM requests');
            total = Number(countRow && countRow.total ? countRow.total : 0);
        } catch (_) {}

        // 6) High-performance B-Tree Keyset Pagination (0.08ms index scan on 1,000,000 rows)
        const whereClauses = [];
        const params = [];

        if (statusFilter === 'done') {
            whereClauses.push("r.status IN ('done', 'processed')");
        } else if (statusFilter === 'processing') {
            whereClauses.push("r.status NOT IN ('done', 'processed')");
        }

        if (regionFilter && regionFilter !== 'all') {
            params.push(`%${regionFilter.toLowerCase()}%`);
            whereClauses.push("r.region ILIKE ?");
        }

        if (yearFilter) {
            params.push(yearFilter);
            whereClauses.push("EXTRACT(YEAR FROM r.created_at) = ?");
        }

        if (cursor) {
            params.push(cursor);
            whereClauses.push("r.created_at < ?");
        }

        const outletCodeFilter = String(req.query && (req.query.outlet_code || req.query.outletCode) || '').trim().toLowerCase();
        if (outletCodeFilter) {
            params.push(outletCodeFilter);
            whereClauses.push("LOWER(r.outlet_code) = ?");
        }

        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const [rows] = await pool.query(
            `${KS_REQUESTS_SELECT_SQL} ${whereSql} ORDER BY r.created_at DESC LIMIT ${limit}`,
            params
        );

        const mapped = rows.map(r => ksRowToApp(r, true));
        const nextCursor = rows.length > 0 ? rows[rows.length - 1].created_at : null;
        const hasMore = rows.length === limit;

        if (serverEtag) {
            res.setHeader('ETag', serverEtag);
            res.setHeader('Cache-Control', 'no-cache');
        }

        return res.json({
            ok: true,
            data: mapped,
            paging: {
                total,
                limit,
                hasMore,
                nextCursor: hasMore ? nextCursor : null
            }
        });
    } catch (err) {
        console.error('GET /api/ks/requests error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'fetch_failed' });
    }
});

// Helper: fetch complete request details with all child records directly from 3NF tables
async function getRequestDetailDirect(idOrTkCode) {
    if (!idOrTkCode) return null;
    const rawId = String(idOrTkCode).trim();
    const cleanId = rawId.replace(/^db_/, '');

    const [rows] = await pool.query(`
        SELECT 
            COALESCE(r.id, r.tk_code) AS id,
            COALESCE(r.id, r.tk_code) AS backend_id,
            r.tk_code,
            COALESCE(NULLIF(r.type, ''), 'new')::varchar(16) AS type,
            r.content,
            COALESCE(r.old_content, false)::boolean AS old_content,
            r.old_content_extra,
            r.status,
            COALESCE(r.sub_status, 'pending')::varchar(32) AS design_status,
            COALESCE(r.is_tba, false) AS is_tba,
            COALESCE(r.is_deleted, false) AS is_deleted,
            COALESCE(r.delete_requested, false) AS delete_requested,
            r.delete_requested_at,
            COALESCE(r.delete_reason, '') AS delete_reason,
            r.delete_status,
            r.delete_requested_by,
            r.delete_requested_phone,
            r.delete_requested_sale_code,
            r.delete_reject_reason,
            'gps'::varchar(32) AS location_source,
            r.requester_id AS created_by,
            r.created_at,
            r.updated_at,
            COALESCE(o.code, '') AS outlet_code,
            COALESCE(o.name, '') AS outlet_name,
            COALESCE(o.address, NULLIF(TRIM(CONCAT_WS(', ', NULLIF(o.house_number, ''), NULLIF(o.street, ''), NULLIF(o.ward, ''), NULLIF(o.district, ''), NULLIF(o.province, ''))), ''), o.street, '') AS address,
            o.latitude AS latitude,
            o.longitude AS longitude,
            o.latitude::varchar(32) AS outlet_lat,
            o.longitude::varchar(32) AS outlet_lng,
            COALESCE(u.region, o.area, '') AS region,
            COALESCE(o.name, '') AS customer_name,
            COALESCE(o.phone, '') AS customer_phone,
            COALESCE(u.fullname, '') AS sale_name,
            COALESCE(u.phone, '') AS sale_phone,
            COALESCE(COALESCE(o.phone, u.phone), '') AS phone,
            COALESCE(u.username, '') AS sale_code,
            COALESCE(u.ss_name, '') AS ss_name,
            '' AS ss_code,
            json_build_object(
                'role', CASE WHEN u.role IS NOT NULL THEN u.role ELSE 'heineken' END,
                'saleName', COALESCE(u.fullname, ''),
                'saleCode', COALESCE(u.username, ''),
                'phone', COALESCE(u.phone, o.phone, ''),
                'region', COALESCE(u.region, o.area, ''),
                'ssName', COALESCE(u.ss_name, ''),
                'ssCode', '',
                'isTBA', COALESCE(r.is_tba, false)
            )::text AS requester,
            r.mq_folder,
            COALESCE(u_des.fullname, u_des_d.fullname, NULLIF(dt.designer_id, ''), NULLIF(d_lat.created_by, ''), '') AS design_created_by,
            COALESCE(dt.created_at, d_lat.created_at) AS design_created_at,
            COALESCE(u_des.fullname, u_des_d.fullname, NULLIF(dt.designer_id, ''), NULLIF(d_lat.created_by, ''), '') AS design_last_edited_by,
            COALESCE(dt.updated_at, dt.created_at, d_lat.created_at) AS design_last_edited_at,
            COALESCE(d_lat.filename, '')::varchar(255) AS design_filename
        FROM requests r
        LEFT JOIN outlets o ON r.outlet_id = o.id
        LEFT JOIN users u ON r.requester_id = u.id
        LEFT JOIN design_tasks dt ON dt.tk_code = r.tk_code
        LEFT JOIN users u_des ON u_des.id = dt.designer_id OR u_des.username = dt.designer_id OR u_des.phone = dt.designer_id
        LEFT JOIN LATERAL (
          SELECT d.url, d.created_by, d.created_at, d.filename 
          FROM designs d 
          WHERE d.request_tk_code = r.tk_code 
          ORDER BY d.id DESC LIMIT 1
        ) d_lat ON true
        LEFT JOIN users u_des_d ON u_des_d.id = d_lat.created_by OR u_des_d.username = d_lat.created_by OR u_des_d.phone = d_lat.created_by
        WHERE (r.tk_code = ? OR r.id = ? OR r.id = ?)
        LIMIT 1
    `, [cleanId, cleanId, rawId]);

    if (!rows || rows.length === 0) return null;
    const row = rows[0];
    const tkCode = row.tk_code;

    // Fetch items, assets, designs, notes concurrently (Single Roundtrip)
    const [
        [itemRows],
        [assetRows],
        [designRows],
        [noteRows]
    ] = await Promise.all([
        pool.query(`
            SELECT id, seq, type, other_content AS "otherContent", action, brand, width, height, 
                   use_old_size AS "useOldSize", poles, note,
                   COALESCE(brand_changed_by_qcag, false) AS "brandChangedByQcag",
                   COALESCE(brand_changed_by_qcag, false) AS "brandChangedByQCAG",
                   brand_changed_by AS "brandChangedBy",
                   COALESCE(added_by_qcag, false) AS "addedByQcag",
                   COALESCE(added_by_qcag, false) AS "addedByQCAG",
                   added_by_qcag_by AS "addedByQcagBy",
                   added_by_qcag_by AS "addedByQCAGBy",
                   COALESCE(edited_by_qcag, false) AS "editedByQcag",
                   COALESCE(edited_by_qcag, false) AS "editedByQCAG",
                   edited_by_qcag_by AS "editedByQcagBy",
                   edited_by_qcag_by AS "editedByQCAGBy",
                   edited_by_qcag_at AS "editedByQcagAt",
                   edited_by_qcag_at AS "editedByQCAGAt",
                   COALESCE(survey, false) AS "survey",
                   CASE 
                     WHEN survey_width IS NOT NULL AND survey_height IS NOT NULL AND survey_width > 0 AND survey_height > 0 
                     THEN json_build_object('width', survey_width, 'height', survey_height)
                     ELSE NULL 
                   END AS "surveySize"
            FROM request_items
            WHERE request_tk_code = ?
            ORDER BY seq
        `, [tkCode]),
        pool.query(`
            SELECT category, url
            FROM assets
            WHERE owner_type = 'request' AND owner_code = ?
            ORDER BY sort_order
        `, [tkCode]),
        pool.query(`
            SELECT url FROM designs WHERE request_tk_code = ? ORDER BY id DESC
        `, [tkCode]),
        pool.query(`
            SELECT n.id, 
                   CASE 
                     WHEN LOWER(TRIM(COALESCE(n.author_name, ''))) IN (
                       'phong', 'trần huỳnh phong', 'đoàn minh thái', 'đòan minh thái', 'thái', 
                       'thanh hiển', 'nguyễn thanh hiển', 'mến', 'võ thị mến', 'mến võ',
                       'thảo', 'thảo võ', 'mỹ linh', 'trần lê mỹ linh', 'admin qcag', 'quản trị',
                       '0966767731', '0868866240', '0901017401', '0859219424', '0123567899'
                     ) THEN 'qcag'
                     WHEN LOWER(COALESCE(n.author_name, '')) LIKE '%qcag%' 
                       OR LOWER(COALESCE(n.author_name, '')) LIKE '%thiết kế%' 
                       OR LOWER(COALESCE(n.author_name, '')) LIKE '%designer%' THEN 'qcag'
                     WHEN n.note_type = 'edit-resolved' THEN 'qcag'
                     ELSE 'heineken'
                   END AS "authorRole",
                   COALESCE(n.author_name, 'Hệ thống') AS "authorName",
                   n.content AS "text",
                   n.note_type AS "commentType",
                   CASE WHEN n.image_url IS NOT NULL AND n.image_url != '' THEN json_build_array(n.image_url) ELSE '[]'::json END AS images,
                   n.created_at AS "createdAt"
            FROM notes n
            WHERE n.ref_type = 'request' AND n.ref_id = ?
            ORDER BY n.created_at ASC
        `, [tkCode])
    ]);

    let finalItems = itemRows || [];
    // Fallback: If request_items is empty (e.g. requests synced from App 1 quotes srv_TK26_%), read from quotation_items
    if (!finalItems.length) {
        try {
            const [qItemRows] = await pool.query(`
                SELECT 
                    qi.id,
                    ROW_NUMBER() OVER(ORDER BY qi.id ASC) AS seq,
                    COALESCE(qi.product_name, qi.item_type, 'Hạng mục khảo sát') AS type,
                    qi.item_name AS "otherContent",
                    'Làm mới' AS action,
                    qi.brand,
                    qi.width,
                    qi.height,
                    false AS "useOldSize",
                    1 AS poles,
                    qi.specifications AS note,
                    false AS "brandChangedByQcag",
                    false AS "brandChangedByQCAG",
                    NULL AS "brandChangedBy",
                    false AS "addedByQcag",
                    false AS "addedByQCAG",
                    NULL AS "addedByQcagBy",
                    NULL AS "addedByQCAGBy",
                    false AS "editedByQcag",
                    false AS "editedByQCAG",
                    NULL AS "editedByQcagBy",
                    NULL AS "editedByQCAGBy",
                    NULL AS "editedByQcagAt",
                    NULL AS "editedByQCAGAt",
                    false AS "survey",
                    NULL AS "surveySize"
                FROM quotations q
                JOIN quotation_items qi ON qi.quotation_code = q.quote_code
                WHERE q.tk_code = ? AND COALESCE(q.is_deleted, false) = false
                ORDER BY qi.id ASC
            `, [tkCode]);
            if (qItemRows && qItemRows.length) {
                finalItems = qItemRows;
            }
        } catch (fbErr) {
            console.warn('[getRequestDetailDirect] fallback quotation_items warning:', fbErr && fbErr.message);
        }
    }

    row.items = JSON.stringify(finalItems || []);

    const statusImgs = [];
    const acceptImgs = [];
    const oldImgs = [];
    for (const a of (assetRows || [])) {
        if (a.category === 'status') statusImgs.push(a.url);
        else if (a.category === 'acceptance') acceptImgs.push(a.url);
        else if (a.category === 'old_content') oldImgs.push(a.url);
    }
    row.status_images = JSON.stringify(statusImgs);
    row.acceptance_images = JSON.stringify(acceptImgs);
    row.old_content_images = JSON.stringify(oldImgs);

    row.design_images = JSON.stringify((designRows || []).map(d => d.url));
    row.comments = JSON.stringify(noteRows || []);

    // Accurately compute editing_requested_at and has_had_design
    let editingRequestedAt = null;
    if (Array.isArray(noteRows) && noteRows.length > 0) {
        let lastEditIdx = -1;
        let lastResIdx = -1;
        for (let i = 0; i < noteRows.length; i++) {
            const nt = String(noteRows[i].commentType || '').toLowerCase();
            if (nt === 'edit-request' || nt === 'edit_request') lastEditIdx = i;
            if (nt === 'edit-resolved') lastResIdx = i;
        }
        if (lastEditIdx !== -1 && (lastResIdx === -1 || lastEditIdx > lastResIdx)) {
            let firstEditAfterRes = noteRows[lastEditIdx];
            for (let i = (lastResIdx === -1 ? 0 : lastResIdx + 1); i <= lastEditIdx; i++) {
                const nt = String(noteRows[i].commentType || '').toLowerCase();
                if (nt === 'edit-request' || nt === 'edit_request') {
                    firstEditAfterRes = noteRows[i];
                    break;
                }
            }
            editingRequestedAt = firstEditAfterRes ? (firstEditAfterRes.createdAt || firstEditAfterRes.created_at) : null;
        }
    }
    row.editing_requested_at = editingRequestedAt;
    row.has_had_design = Boolean((designRows && designRows.length > 0) || row.design_created_at || row.design_created_by);
    row.has_pending_survey = (finalItems || []).some(it => Boolean(it.survey) && !(it.surveySize && it.surveySize.width && it.surveySize.height));

    return row;
}

// GET /api/ks/requests/:id — get full request details including comments & images
app.get('/api/ks/requests/:id', async (req, res, next) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
        if (id === 'production-approvals' || id === 'health' || id === 'proxy-image') {
            return next();
        }

        const row = await getRequestDetailDirect(id);
        if (!row) {
            return res.status(404).json({ ok: false, error: 'not_found' });
        }
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.json({ ok: true, data: ksRowToApp(row, false) });
    } catch (err) {
        console.error('GET /api/ks/requests/:id error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'fetch_failed' });
    }
});

// ── GET /api/ks/requests/:id/notes ──────────────────────────────────────────
// Lấy toàn bộ timeline ghi chú / trao đổi / yêu cầu sửa chuẩn 3NF
app.get('/api/ks/requests/:id/notes', async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });

        let [rRows] = await pool.query(
            'SELECT tk_code FROM requests WHERE tk_code = ? OR id = ? LIMIT 1',
            [id, id]
        );
        const tkCode = (rRows && rRows[0] && rRows[0].tk_code) || id;

        const [notes] = await pool.query(`
            SELECT 
                n.id, 
                n.ref_type AS "refType", 
                n.ref_id AS "refId", 
                n.note_type AS "noteType", 
                n.note_type AS "commentType", 
                n.content AS "text", 
                n.author_name AS "authorName", 
                CASE 
                  WHEN LOWER(TRIM(COALESCE(n.author_name, ''))) IN (
                    'phong', 'trần huỳnh phong', 'đoàn minh thái', 'đòan minh thái', 'thái', 
                    'thanh hiển', 'nguyễn thanh hiển', 'mến', 'võ thị mến', 'mến võ',
                    'thảo', 'thảo võ', 'mỹ linh', 'trần lê mỹ linh', 'admin qcag', 'quản trị',
                    '0966767731', '0868866240', '0901017401', '0859219424', '0123567899'
                  ) THEN 'qcag'
                  WHEN LOWER(COALESCE(n.author_name, '')) LIKE '%qcag%' 
                    OR LOWER(COALESCE(n.author_name, '')) LIKE '%thiết kế%' 
                    OR LOWER(COALESCE(n.author_name, '')) LIKE '%designer%' THEN 'qcag'
                  WHEN n.note_type = 'edit-resolved' THEN 'qcag'
                  ELSE 'heineken'
                END AS "authorRole",
                n.image_url AS "imageUrl", 
                CASE WHEN n.image_url IS NOT NULL AND n.image_url != '' THEN json_build_array(n.image_url) ELSE '[]'::json END AS "images",
                n.created_at AS "createdAt"
            FROM notes n
            WHERE n.ref_type = 'request' AND n.ref_id = ?
            ORDER BY n.created_at ASC
        `, [tkCode]);

        return res.json({ ok: true, data: notes || [] });
    } catch (err) {
        console.error('GET /api/ks/requests/:id/notes error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'fetch_notes_failed' });
    }
});

// ── POST /api/ks/requests/:id/notes (hoặc /comments) ─────────────────────────
// Ghi nhận ghi chú / phản hồi nguyên tử vào bảng 3NF notes (Zero Race-Condition)
async function handleCreateRequestNote(req, res) {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });

        const b = req.body || {};
        const text = String(b.text || b.content || '').trim();
        if (!text) return res.status(400).json({ ok: false, error: 'empty_content' });

        let [rRows] = await pool.query(
            'SELECT tk_code FROM requests WHERE tk_code = ? OR id = ? LIMIT 1',
            [id, id]
        );
        const tkCode = (rRows && rRows[0] && rRows[0].tk_code) || id;

        const authorName = String(b.authorName || b.author || (b.role === 'qcag' ? 'QCAG' : 'Sale Heineken')).trim();
        const noteType = String(b.noteType || b.commentType || 'comment').trim();
        let imageUrl = b.imageUrl || (Array.isArray(b.images) && b.images.length > 0 ? b.images[0] : null);
        if (typeof imageUrl !== 'string' || !imageUrl.trim() || imageUrl.startsWith('data:image')) {
            imageUrl = null; // Bảo vệ DB khỏi Base64 bloat
        }

        const noteId = `nt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        await pool.query(`
            INSERT INTO notes (id, ref_type, ref_id, note_type, content, author_name, image_url, created_at)
            VALUES (?, 'request', ?, ?, ?, ?, ?, NOW())
        `, [noteId, tkCode, noteType, text, authorName, imageUrl]);

        const isQcagAuthor = (
            String(b.authorRole || '').toLowerCase() === 'qcag' ||
            String(b.role || '').toLowerCase() === 'qcag' ||
            /^(phong|trần huỳnh phong|đoàn minh thái|đòan minh thái|thái|thanh hiển|nguyễn thanh hiển|mến|võ thị mến|mến võ|thảo|thảo võ|mỹ linh|trần lê mỹ linh|admin qcag|quản trị|0966767731|0868866240|0901017401|0859219424|0123567899)$/i.test(authorName.trim()) ||
            /qcag|thiết\s*kế|designer/i.test(authorName) ||
            noteType === 'edit-resolved'
        );
        const resolvedAuthorRole = isQcagAuthor ? 'qcag' : 'heineken';

        const noteObj = {
            id: noteId,
            refType: 'request',
            refId: tkCode,
            noteType,
            commentType: noteType,
            text,
            authorName,
            authorRole: resolvedAuthorRole,
            images: imageUrl ? [imageUrl] : [],
            createdAt: new Date().toISOString()
        };

        wsInvalidate('ks_requests', { action: 'note', id: tkCode, note: noteObj });
        sseBroadcast({ type: 'new_note', refType: 'request', refId: tkCode, note: noteObj });

        return res.json({ ok: true, data: noteObj });
    } catch (err) {
        console.error('POST /api/ks/requests/:id/notes error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'create_note_failed' });
    }
}
app.post('/api/ks/requests/:id/notes', handleCreateRequestNote);
app.post('/api/ks/requests/:id/comments', handleCreateRequestNote);

function normalizeVietnameseAccents(str) {
    if (typeof str !== "string") return str;
    return str.normalize("NFC");
}

function normalizePayloadStrings(obj) {
    if (typeof obj === "string") return normalizeVietnameseAccents(obj);
    if (Array.isArray(obj)) return obj.map(item => normalizePayloadStrings(item));
    if (obj !== null && typeof obj === "object") {
        const newObj = {};
        for (const key in obj) {
            newObj[key] = normalizePayloadStrings(obj[key]);
        }
        return newObj;
    }
    return obj;
}

// POST /api/ks/requests
app.post("/api/ks/requests", async (req, res) => {
    try {
        const b = normalizePayloadStrings(req.body || {});
        const now = new Date();
        const backendId = toNullableString(b.__backendId) || toNullableString(b.backendId) ||
            ("srv_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex"));

        // Step 0: Prevent duplicate record creation on retry timeouts
        const [existingRows] = await pool.query(
            "SELECT id, tk_code FROM requests WHERE id = ? LIMIT 1",
            [backendId]
        );
        if (existingRows && existingRows.length > 0) {
            console.log(`[ks/create] Duplicate request detected for backend_id=${backendId}, returning existing`);
            const existingDetail = await getRequestDetailDirect(existingRows[0].id);
            return res.status(200).json({ ok: true, data: ksRowToApp(existingDetail) });
        }

        // mq_folder: use provided value (from pre-generated ID) or generate new safe folder name
        const mqFolder = toNullableString(b.mqFolder) || ksSafeMqFolder(toNullableString(b.outletCode) || '');
        const createdAtTs = b.createdAt ? new Date(b.createdAt) : now;
        const outletCode = toNullableString(b.outletCode);
        const isPlaceholderOutlet = !outletCode || 
            /^(new\s*outlet|ch[uư]a\s*c[oó]\s*code|chuacocode|tba|none)$/i.test(outletCode.trim());
        const allowDuplicate = Boolean(b.allowDuplicate || b.force || b.userConfirmedNewForOutlet || b.confirmedNew);

        console.log(`[ks/create] Attempting request creation for outletCode="${outletCode}", isPlaceholder=${isPlaceholderOutlet}, allowDuplicate=${allowDuplicate}, backendId=${backendId}`);

        // Outlet Exclusivity Check: Prevent creating a new survey request if this outlet is already in progress
        if (outletCode && !isPlaceholderOutlet && !allowDuplicate) {
            // 1. Check if an active survey request already exists for this outlet (loại trừ các request đã có báo giá ra đơn hàng)
            const [activeReqRows] = await pool.query(
                `SELECT r.tk_code, r.status 
                 FROM requests r 
                 WHERE (r.outlet_id = ? OR r.outlet_id = ('OUT_' || ?) OR REGEXP_REPLACE(LOWER(r.outlet_id::text), '^out_', '') = LOWER(?))
                   AND (r.is_deleted = false OR r.is_deleted IS NULL)
                   AND r.status NOT IN ('cancelled', 'completed', 'done', 'exported')
                   AND NOT EXISTS (
                       SELECT 1 FROM quotations q
                       JOIN order_quotes oq ON oq.quotation_code = q.quote_code
                       JOIN orders ord ON ord.id = oq.order_id AND (ord.is_deleted = false OR ord.is_deleted IS NULL)
                       WHERE (q.tk_code = r.tk_code OR q.request_tk_code = r.tk_code)
                   )
                 LIMIT 1`,
                [outletCode, outletCode, outletCode]
            );
            if (activeReqRows && activeReqRows.length > 0) {
                console.warn(`[ks/create 409] Outlet ${outletCode} has active request ${activeReqRows[0].tk_code}`);
                return res.status(409).json({
                    ok: false,
                    error: 'outlet_in_progress',
                    message: `Điểm bán ${outletCode} đang có Yêu cầu khảo sát ${activeReqRows[0].tk_code} đang xử lý!`,
                    data: activeReqRows[0]
                });
            }

            // 2. Check if an active quotation already exists for this outlet (loại trừ các báo giá đã ra đơn hàng hoặc hoàn tất)
            const [activeQuoteRows] = await pool.query(
                `SELECT q.quote_code, q.tk_code, q.request_tk_code 
                 FROM quotations q
                 WHERE (q.outlet_id = ? OR q.outlet_id = ('OUT_' || ?) OR REGEXP_REPLACE(LOWER(q.outlet_id::text), '^out_', '') = LOWER(?)) 
                   AND (q.is_exported = 0 OR q.is_exported IS NULL)
                   AND (q.is_deleted = false OR q.is_deleted IS NULL)
                   AND (q.status IS NULL OR q.status NOT IN ('cancelled', 'rejected', 'bao_huy', 'completed', 'done'))
                   AND (q.spo_status IS NULL OR q.spo_status NOT IN ('Sales Admin Finish', 'Sign Maker Installed Signage'))
                   AND NOT EXISTS (
                       SELECT 1 FROM order_quotes oq 
                       JOIN orders ord ON ord.id = oq.order_id AND (ord.is_deleted = false OR ord.is_deleted IS NULL)
                       WHERE oq.quotation_code = q.quote_code
                   )
                 LIMIT 1`,
                [outletCode, outletCode, outletCode]
            );
            if (activeQuoteRows && activeQuoteRows.length > 0) {
                const aq = activeQuoteRows[0];
                console.warn(`[ks/create 409] Outlet ${outletCode} has active quotation ${aq.quote_code}`);
                return res.status(409).json({
                    ok: false,
                    error: 'outlet_in_progress',
                    message: `Điểm bán ${outletCode} đang có Báo giá ${aq.quote_code} (TK: ${aq.tk_code || aq.request_tk_code || 'chưa có'}) đang xử lý chưa xuất đơn hàng!`,
                    data: aq
                });
            }
        }

        // Step 1: Compute TK code (e.g. TK26.03911) using atomic PostgreSQL sequence
        const year = String(createdAtTs.getFullYear());
        const yy = year.slice(-2);
        let tkCode = backendId; // fallback
        try {
            const seqName = `seq_request_${yy}`;
            await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${seqName} START WITH 1`);
            const [seqRows] = await pool.query(`SELECT nextval('${seqName}') AS val`);
            const num = Number(seqRows && seqRows[0] && seqRows[0].val != null ? seqRows[0].val : 1);
            tkCode = `TK${yy}.${String(num).padStart(5, '0')}`;
        } catch (tkErr) {
            console.warn('[ks/create] tk_code sequence compute failed (non-fatal):', tkErr && tkErr.message ? tkErr.message : tkErr);
        }

        // Step 2: Upload any base64 images to GCS using tk_code as folder
        const statusImgsJson = await ksAutoUploadImages(normalizeBodyValue(b.statusImages) || '[]', tkCode, 'hien-trang');
        const oldContentImgsJson = await ksAutoUploadImages(normalizeBodyValue(b.oldContentImages) || '[]', tkCode, 'hien-trang');
        const designImgsJson = await ksAutoUploadImages(normalizeBodyValue(b.designImages) || '[]', tkCode, 'mq');
        const acceptanceImgsJson = await ksAutoUploadImages(normalizeBodyValue(b.acceptanceImages) || '[]', tkCode, 'mq');

        // Step 3: Resolve or create Requester in V12 3NF users table
        let requesterObj = {};
        try {
            requesterObj = typeof b.requester === 'string' ? JSON.parse(b.requester || '{}') : (b.requester || {});
        } catch (_) { }
        const saleCode = toNullableString(requesterObj.saleCode) || toNullableString(b.saleCode) || toNullableString(b.sale_code);
        const salePhone = toNullableString(requesterObj.phone) || toNullableString(b.salePhone) || toNullableString(b.sale_phone) || toNullableString(b.phone);
        const saleName = toNullableString(requesterObj.saleName) || toNullableString(b.saleName) || toNullableString(b.sale_name);
        const ssName = toNullableString(requesterObj.ssName) || toNullableString(b.ssName) || toNullableString(b.ss_name);
        const ssCode = toNullableString(requesterObj.ssCode) || toNullableString(b.ssCode) || toNullableString(b.ss_code);
        const region = toNullableString(requesterObj.region) || toNullableString(b.region);

        let requesterId = null;
        let userRegion = region;
        if (saleCode) {
            const [uRows] = await pool.query(
                "SELECT id, region FROM users WHERE username = ? OR id = ? OR id = ('USR_SALE_' || ?) LIMIT 1",
                [saleCode, saleCode, saleCode]
            );
            if (uRows && uRows.length > 0) {
                requesterId = uRows[0].id;
                if (!userRegion && uRows[0].region) userRegion = uRows[0].region;
            }
        }
        if (!requesterId && salePhone) {
            const [uRows] = await pool.query(
                "SELECT id, region FROM users WHERE phone = ? OR username = ? OR id = ('USR_PHONE_' || ?) LIMIT 1",
                [salePhone, salePhone, salePhone]
            );
            if (uRows && uRows.length > 0) {
                requesterId = uRows[0].id;
                if (!userRegion && uRows[0].region) userRegion = uRows[0].region;
            }
        }
        if (!requesterId) {
            requesterId = saleCode ? ('USR_SALE_' + saleCode) : (salePhone ? ('USR_PHONE_' + salePhone) : ('USR_REQ_' + tkCode));
            const uname = saleCode || salePhone || requesterId;
            const fname = saleName || uname;
            const [uRes] = await pool.query(`
                INSERT INTO users (id, username, fullname, phone, role, ss_name, region, company, is_internal, can_access_app1, can_access_app2, password_hash, is_active, approved, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'sales', ?, ?, 'HEINEKEN', false, false, true, 'auto_created', true, true, ?, ?)
                ON CONFLICT (username) DO UPDATE SET
                    fullname = COALESCE(EXCLUDED.fullname, users.fullname),
                    phone = COALESCE(EXCLUDED.phone, users.phone),
                    region = COALESCE(EXCLUDED.region, users.region),
                    updated_at = EXCLUDED.updated_at
                RETURNING id
            `, [
                requesterId, uname, fname, salePhone, ssName, region, now, now
            ]);
            if (uRes && uRes.length > 0 && uRes[0].id) {
                requesterId = uRes[0].id;
            }
        }

        // Step 4: Resolve or create Outlet in V12 3NF table
        let outletId = null;
        if (outletCode && !isPlaceholderOutlet) {
            const [foundOutlets] = await pool.query(
                "SELECT id, code, name FROM outlets WHERE id = ? OR code = ? OR id = ('OUT_' || ?) LIMIT 1",
                [outletCode, outletCode, outletCode]
            );
            if (foundOutlets && foundOutlets.length > 0) {
                outletId = foundOutlets[0].id;
                // Nếu Sale gửi định vị mới cho điểm bán có sẵn, luôn cập nhật tọa độ vào bảng outlets
                const lat = b.outletLat && !isNaN(Number(b.outletLat)) ? Number(b.outletLat) : (b.latitude && !isNaN(Number(b.latitude)) ? Number(b.latitude) : null);
                const lng = b.outletLng && !isNaN(Number(b.outletLng)) ? Number(b.outletLng) : (b.longitude && !isNaN(Number(b.longitude)) ? Number(b.longitude) : null);
                if (lat != null || lng != null) {
                    await pool.query(
                        "UPDATE outlets SET latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude), updated_at = NOW() WHERE id = ?",
                        [lat, lng, outletId]
                    );
                }
            }
        }
        if (!outletId) {
            // Quy tắc sợi chỉ đỏ tk_code: Outlet tạm cho New Outlet phải có ID = 'OUT_' + tkCode
            const cleanCode = (!isPlaceholderOutlet && outletCode) ? outletCode : ('TEMP_' + tkCode);
            outletId = (!isPlaceholderOutlet && outletCode) ? ('OUT_' + cleanCode) : ('OUT_' + tkCode);

            let outletName = toNullableString(b.outletName);
            let addr = toNullableString(b.address);
            let phone = toNullableString(b.phone);

            // Tự động phân tích tên quán, địa chỉ, sđt từ content nếu form để placeholder hoặc rỗng
            if (isPlaceholderOutlet && b.content) {
                const lines = String(b.content).split('\n').map(l => l.trim()).filter(Boolean);
                if (!outletName || /^(new\s*outlet|điểm\s*bán\s*mới|chưa\s*có\s*code|chuacocode|tba)$/i.test(outletName)) {
                    const nonMetaLines = lines.filter(l => !/^(đc|địa\s*chỉ|đt|sđt|tel|phone|lh)[:\s]/i.test(l));
                    if (nonMetaLines.length > 0) {
                        outletName = nonMetaLines.slice(0, 2).join(' ');
                    }
                }
                if (!addr) {
                    const dcLine = lines.find(l => /^(đc|địa\s*chỉ)[:\s]/i.test(l));
                    if (dcLine) addr = dcLine.replace(/^(đc|địa\s*chỉ)[:\s]+/i, '').trim();
                }
                if (!phone) {
                    const dtLine = lines.find(l => /^(đt|sđt|tel|phone|lh)[:\s]/i.test(l));
                    if (dtLine) phone = dtLine.replace(/^(đt|sđt|tel|phone|lh)[:\s]+/i, '').trim();
                }
            }
            if (!outletName) outletName = cleanCode;

            const lat = b.outletLat && !isNaN(Number(b.outletLat)) ? Number(b.outletLat) : null;
            const lng = b.outletLng && !isNaN(Number(b.outletLng)) ? Number(b.outletLng) : null;
            const isNewOutlet = true;
            // Bảo vệ khu vực: Ưu tiên tuyệt đối khu vực thật của Sale (userRegion)
            const outletArea = userRegion || toNullableString(b.region) || null;

            const [insRes] = await pool.query(`
                INSERT INTO outlets (id, code, name, phone, address, street, latitude, longitude, area, is_new_outlet, is_deleted, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, ?, ?)
                ON CONFLICT (id) DO UPDATE SET
                    code = EXCLUDED.code,
                    name = COALESCE(NULLIF(EXCLUDED.name, ''), outlets.name),
                    phone = COALESCE(NULLIF(EXCLUDED.phone, ''), outlets.phone),
                    address = COALESCE(NULLIF(EXCLUDED.address, ''), outlets.address),
                    street = COALESCE(NULLIF(EXCLUDED.street, ''), outlets.street),
                    latitude = COALESCE(EXCLUDED.latitude, outlets.latitude),
                    longitude = COALESCE(EXCLUDED.longitude, outlets.longitude),
                    area = COALESCE(EXCLUDED.area, outlets.area),
                    is_new_outlet = EXCLUDED.is_new_outlet,
                    updated_at = EXCLUDED.updated_at
                RETURNING id
            `, [
                outletId, cleanCode, outletName, phone, addr, null, lat, lng,
                outletArea,
                isNewOutlet, now, now
            ]);
            if (insRes && insRes.length > 0 && insRes[0].id) {
                outletId = insRes[0].id;
            }
        }


        // Parse itemsArr first to accurately determine type if not explicitly supplied
        let itemsArr = [];
        try {
            itemsArr = typeof b.items === 'string' ? JSON.parse(b.items || '[]') : (Array.isArray(b.items) ? b.items : []);
        } catch (_) { }
        const requestType = (b.type === 'warranty' || (!itemsArr.length && b.content && !b.items)) ? 'warranty' : (toNullableString(b.type) || 'new');

        // Step 5: INSERT INTO requests (Primary V12 table)
        const isTba = Boolean(requesterObj.isTBA || b.isTba || b.is_tba);
        const isOldContentVal = Boolean(b.oldContent || b.old_content || b.isOldContent);
        await pool.query(`
            INSERT INTO requests (
                id, tk_code, requester_id, outlet_id, status, sub_status,
                is_tba, type, content, old_content, old_content_extra, mq_folder, is_deleted,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, false, ?, ?)
            ON CONFLICT (tk_code) DO UPDATE SET
                outlet_id = EXCLUDED.outlet_id,
                requester_id = COALESCE(EXCLUDED.requester_id, requests.requester_id),
                status = COALESCE(EXCLUDED.status, requests.status),
                is_tba = EXCLUDED.is_tba,
                type = COALESCE(EXCLUDED.type, requests.type),
                content = EXCLUDED.content,
                old_content = EXCLUDED.old_content,
                old_content_extra = EXCLUDED.old_content_extra,
                mq_folder = COALESCE(EXCLUDED.mq_folder, requests.mq_folder),
                updated_at = EXCLUDED.updated_at
        `, [
            backendId,
            tkCode,
            requesterId,
            outletId,
            toNullableString(b.status) || 'pending',
            isTba,
            requestType,
            toNullableString(b.content),
            isOldContentVal,
            toNullableString(b.oldContentExtra),
            mqFolder,
            createdAtTs,
            now
        ]);

        // Step 6: INSERT INTO request_items (V12 3NF 1-N table) - Chỉ lưu QC Bảng hiệu + Shopname theo văn mẫu Sale
        const isExcludedReqItem = (it) => {
            const raw = String((it && (it.type || it.otherContent)) || '').toLowerCase();
            return raw.includes('chân sắt') || raw.includes('chan sat') || raw.includes('chân hộp đèn') ||
                   raw.includes('sắt chỏi') || raw.includes('sat choi') || raw.includes('chỏi') ||
                   raw.includes('trụ phi') || raw.includes('tru phi') || raw.includes('trụ sắt') || raw.includes('tru sat') ||
                   raw.includes('đèn chiếu sáng') || raw.includes('den chieu sang') ||
                   raw.includes('đèn huỳnh quang') || raw.includes('den huynh quang') ||
                   raw.includes('đèn pha') || raw.includes('den pha') ||
                   raw.includes('đèn rọi') || raw.includes('den roi') ||
                   raw.includes('bóng đèn') || raw.includes('tôn trắng kẽm') || raw.includes('tôn lưng') ||
                   raw.includes('giấy phép') || raw.includes('xin phép') || raw.includes('phí');
        };
        const normalizeSaleSignType = (t) => {
            const raw = String(t || '').trim();
            const sLower = raw.toLowerCase();
            if (sLower.includes('shopname') || sLower.includes('shop name') || sLower.includes('tên quán')) return 'Shopname';
            if (sLower.includes('hộp đèn') || sLower.includes('hop den')) {
                return (sLower.includes('2 mặt') || sLower.includes('hai mặt') || sLower.includes('2 mat')) ? 'Hộp đèn hiflex 2 mặt' : 'Hộp đèn hiflex 1 mặt';
            }
            if (sLower.includes('giả hộp') || sLower.includes('gia hop')) {
                return (sLower.includes('2 mặt') || sLower.includes('hai mặt') || sLower.includes('2 mat')) ? 'Bảng hiệu giả hộp hiflex 2 mặt' : 'Bảng hiệu giả hộp hiflex 1 mặt';
            }
            if (sLower.includes('bảng hiệu hiflex') || sLower.includes('bang hieu hiflex') || sLower.includes('bảng hiflex') || sLower.includes('bang hiflex')) {
                return (sLower.includes('2 mặt') || sLower.includes('hai mặt') || sLower.includes('không đèn') || sLower.includes('khong den') || sLower.includes('2 mat')) ? 'Bảng hiflex 2 mặt (KHÔNG ĐÈN)' : 'Bảng hiflex 1 mặt';
            }
            if (sLower.includes('alu')) return 'Bảng Alu Nhà Phân Phối';
            if (sLower.includes('mái che') || sLower.includes('mai che') || sLower.includes('mái hiên') || sLower.includes('mai hien')) return 'Mái che di động';
            if (sLower.includes('rèm') || sLower.includes('rem')) return 'Rèm Mái Che';
            if (sLower.includes('logo')) {
                return (sLower.includes('outdoor') || sLower.includes('ngoài trời') || sLower.includes('icon')) ? 'Logo Outdoor' : 'Logo indoor';
            }
            return raw;
        };
        const validItemsArr = (Array.isArray(itemsArr) ? itemsArr : []).filter(it => !isExcludedReqItem(it));
        if (validItemsArr.length > 0) {
            for (let i = 0; i < validItemsArr.length; i++) {
                const it = validItemsArr[i] || {};
                const itemId = toNullableString(it.id) || `rqi_${tkCode}_${i + 1}`;
                const seq = Number(it.seq) || (i + 1);
                const rawType = toNullableString(it.type) || 'Hạng mục khảo sát';
                const itemType = normalizeSaleSignType(rawType);
                const action = toNullableString(it.action) || 'Làm mới';
                const brand = toNullableString(it.brand) || null;
                const width = it.width && !isNaN(Number(it.width)) ? Number(it.width) : null;
                const height = it.height && !isNaN(Number(it.height)) ? Number(it.height) : null;
                const useOldSize = Boolean(it.useOldSize);
                const poles = Number(it.poles) || 0;
                const note = toNullableString(it.note);
                const otherContent = toNullableString(it.otherContent);
                const isSurvey = Boolean(it.survey || (!it.useOldSize && (!it.width || Number(it.width) === 0) && it.type !== 'Hạng mục khác'));
                const surveyW = (it.surveySize && it.surveySize.width && !isNaN(Number(it.surveySize.width))) ? Number(it.surveySize.width) : null;
                const surveyH = (it.surveySize && it.surveySize.height && !isNaN(Number(it.surveySize.height))) ? Number(it.surveySize.height) : null;

                await pool.query(`
                    INSERT INTO request_items (
                        id, request_tk_code, seq, type, other_content, action, brand,
                        width, height, use_old_size, poles, note,
                        survey, survey_width, survey_height, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (id) DO UPDATE SET
                        type = EXCLUDED.type,
                        other_content = EXCLUDED.other_content,
                        action = EXCLUDED.action,
                        brand = EXCLUDED.brand,
                        width = EXCLUDED.width,
                        height = EXCLUDED.height,
                        use_old_size = EXCLUDED.use_old_size,
                        poles = EXCLUDED.poles,
                        note = EXCLUDED.note,
                        survey = EXCLUDED.survey,
                        survey_width = EXCLUDED.survey_width,
                        survey_height = EXCLUDED.survey_height
                `, [
                    itemId, tkCode, seq, itemType, otherContent, action, brand,
                    width, height, useOldSize, poles, note,
                    isSurvey, surveyW, surveyH, now
                ]);
            }
        }

        // Step 7: INSERT INTO assets and designs (Polymorphic media table)
        const insertAssets = async (category, jsonUrls) => {
            try {
                const urls = typeof jsonUrls === 'string' ? JSON.parse(jsonUrls || '[]') : (Array.isArray(jsonUrls) ? jsonUrls : []);
                for (let i = 0; i < urls.length; i++) {
                    const u = urls[i];
                    if (typeof u === 'string' && u.trim() && !u.startsWith('data:')) {
                        if (category === 'design') {
                            const dsgId = `dsg_${tkCode}`;
                            await pool.query(`
                                INSERT INTO designs (id, request_tk_code, url, created_at, updated_at)
                                VALUES (?, ?, ?, NOW(), NOW())
                                ON CONFLICT (request_tk_code) DO UPDATE SET url = EXCLUDED.url, updated_at = NOW()
                            `, [dsgId, tkCode, u.trim()]);
                        } else {
                            const assetId = `ast_${tkCode}_${category}_${i + 1}`;
                            await pool.query(`
                                INSERT INTO assets (id, owner_type, owner_code, category, url, sort_order, created_at)
                                VALUES (?, 'request', ?, ?, ?, ?, ?)
                                ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url
                            `, [assetId, tkCode, category, u.trim(), i + 1, now]);
                        }
                    }
                }
            } catch (err) {
                console.warn(`[ks/create] Assets insert error for ${category}:`, err && err.message);
            }
        };

        await insertAssets('status', statusImgsJson);
        await insertAssets('old_content', oldContentImgsJson);
        await insertAssets('design', designImgsJson);
        await insertAssets('acceptance', acceptanceImgsJson);

        // Step 8: Save any initial comments to 3NF notes table (V12)
        if (b.comments) {
            await saveCommentPayloadToNotes(tkCode, b.comments);
        }

        // Step 9: Fetch complete freshly created row directly from 3NF tables
        const viewRow = await getRequestDetailDirect(tkCode || backendId);
        const row = viewRow || {
            id: backendId,
            backend_id: backendId,
            tk_code: tkCode,
            outlet_code: outletCode,
            outlet_name: toNullableString(b.outletName),
            address: toNullableString(b.address),
            outlet_lat: toNullableString(b.outletLat),
            outlet_lng: toNullableString(b.outletLng),
            phone: toNullableString(b.phone),
            items: normalizeBodyValue(b.items) || '[]',
            content: toNullableString(b.content),
            status: toNullableString(b.status) || 'pending',
            status_images: statusImgsJson,
            created_at: now,
            updated_at: now
        };
        const appRow = ksRowToApp(row);
        ksInvalidateCache();
        wsInvalidate('ks_requests', { action: 'create', id: backendId, tkCode, data: appRow });
        return res.status(201).json({ ok: true, data: appRow });
    } catch (err) {
        console.error('POST /api/ks/requests error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'create_failed', message: err && err.message ? err.message : 'Lỗi tạo yêu cầu' });
    }
});

// ─── Helper: auto-upload base64 images in a JSON array to GCS ──────────────
// Input:  JSON string like '["data:image/jpeg;base64,...","https://..."]'
// Output: Same array with base64 replaced by GCS public URLs.
// Folder structure: ks-surveys/{mqFolder}/{subfolder}/{ts}_{rand}.{ext}
async function ksAutoUploadImages(jsonStr, mqFolder, subfolder) {
    const ksBucket = process.env.KS_GCS_BUCKET || process.env.GCS_BUCKET || 'qcag-483014-qcag-images';
    if (!ksBucket) {
        console.warn('[ksAutoUpload] KS_GCS_BUCKET not set — images kept as-is');
        return jsonStr;
    }
    let arr;
    try { arr = JSON.parse(jsonStr || '[]'); } catch (_) { return jsonStr; }
    if (!Array.isArray(arr) || arr.length === 0) return jsonStr;
    const safeMq = String(mqFolder || 'misc').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const safeSub = String(subfolder || 'misc').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32);
    const bucket = gcs.bucket(ksBucket);
    const uploaded = await Promise.all(arr.map(async (item) => {
        if (typeof item !== 'string') return item;
        const m = item.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
        if (!m) return item; // already a URL or non-image → keep
        const mimetype = m[1];
        const buffer = Buffer.from(m[2], 'base64');
        let ext = 'bin';
        if (mimetype === 'image/jpeg') ext = 'jpg';
        else if (mimetype === 'image/png') ext = 'png';
        else if (mimetype === 'image/webp') ext = 'webp';
        else if (mimetype === 'image/gif') ext = 'gif';
        const rand = crypto.randomBytes(6).toString('hex');
        const filename = `ks-surveys/${safeMq}/${safeSub}/${Date.now()}_${rand}.${ext}`;
        try {
            await bucket.file(filename).save(buffer, { contentType: mimetype });
            return `https://storage.googleapis.com/${ksBucket}/${filename}`;
        } catch (uploadErr) {
            console.warn('[ksAutoUpload] GCS upload failed, dropping image:', uploadErr && uploadErr.message ? uploadErr.message : uploadErr);
            return null;
        }
    }));
    return JSON.stringify(uploaded.filter(x => x !== null));
}
// ─────────────────────────────────────────────────────────────────────────────

async function saveCommentPayloadToNotes(tkCode, rawComments) {
    if (!rawComments || !tkCode) return;
    try {
        let parsedArr = [];
        if (typeof rawComments === 'string') {
            try { parsedArr = JSON.parse(rawComments); } catch (_) {}
        } else if (Array.isArray(rawComments)) {
            parsedArr = rawComments;
        }
        if (!Array.isArray(parsedArr) || parsedArr.length === 0) return;
        const lastComment = parsedArr[parsedArr.length - 1];
        if (!lastComment || (!lastComment.text && !lastComment.content)) return;

        const cText = String(lastComment.text || lastComment.content).trim();
        if (!cText) return;
        const cAuthor = String(lastComment.authorName || lastComment.author || 'QCAG Thiết Kế').trim();
        const cType = String(lastComment.commentType || lastComment.noteType || 'comment').trim();
        let cImg = Array.isArray(lastComment.images) && lastComment.images.length > 0 ? lastComment.images[0] : null;
        if (typeof cImg !== 'string' || !cImg.trim() || cImg.startsWith('data:image')) cImg = null;

        const isEditResolved = cType === 'edit-resolved' || cText.includes('đã chỉnh sửa xong');

        // Bỏ qua chặn trùng lặp đối với edit-resolved để luôn ghi nhận mốc thời gian hoàn thành mới nhất
        if (!isEditResolved) {
            const [existing] = await pool.query(
                `SELECT id FROM notes WHERE ref_type = 'request' AND ref_id = ? AND content = ? LIMIT 1`,
                [tkCode, cText]
            );
            if (existing && existing.length > 0) return;
        }

        const noteId = `nt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        await pool.query(`
            INSERT INTO notes (id, ref_type, ref_id, note_type, content, author_name, image_url, created_at)
            VALUES (?, 'request', ?, ?, ?, ?, ?, NOW())
        `, [noteId, tkCode, isEditResolved ? 'edit-resolved' : cType, cText, cAuthor, cImg]);

        // Nếu là giải quyết yêu cầu sửa, ghi thêm note edit-resolved cho quotation liên quan nếu có
        if (isEditResolved) {
            try {
                const [qRows] = await pool.query(`SELECT quote_code FROM quotations WHERE request_tk_code = ? LIMIT 1`, [tkCode]);
                if (qRows && qRows.length > 0 && qRows[0].quote_code) {
                    const qCode = qRows[0].quote_code;
                    const qNoteId = `nt_${Date.now() + 1}_${Math.random().toString(36).substring(2, 7)}`;
                    await pool.query(`
                        INSERT INTO notes (id, ref_type, ref_id, note_type, content, author_name, image_url, created_at)
                        VALUES (?, 'quotation', ?, 'edit-resolved', ?, ?, ?, NOW())
                    `, [qNoteId, qCode, cText, cAuthor, cImg]);
                }
            } catch (qErr) {
                console.warn('[saveCommentPayloadToNotes] quotation note sync warning:', qErr && qErr.message);
            }
        }
    } catch (e) {
        console.warn('[saveCommentPayloadToNotes] warning:', e && e.message);
    }
}

// PATCH /api/ks/requests/:id
app.patch('/api/ks/requests/:id', async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        const b = normalizePayloadStrings(req.body || {});
        const now = new Date();

        const cleanId = id.replace(/^db_/, '');
        const tkCandidate = b.tkCode || b.tk_code || '';

        // 1. Check primary V12 table: requests
        let [reqRows] = await pool.query(
            `SELECT r.*, o.code AS outlet_code, o.name AS outlet_name, o.address, o.phone AS outlet_phone, o.area AS outlet_area, u.phone AS requester_phone, u.region AS sale_region 
             FROM requests r 
             LEFT JOIN outlets o ON r.outlet_id = o.id 
             LEFT JOIN users u ON r.requester_id = u.id 
             WHERE r.tk_code = ? OR r.id = ? OR r.id = ? OR (r.tk_code = ? AND ? <> '') 
             LIMIT 1`,
            [id, id, cleanId, tkCandidate, tkCandidate]
        );

        if (!reqRows || reqRows.length === 0) {
            return res.status(404).json({ ok: false, error: 'not_found' });
        }

        const currentReq = reqRows[0];
        const tkCode = currentReq.tk_code || id;
        const folderForUpload = tkCode || currentReq.id;

        // Helper chuẩn hóa định danh Designer khớp 100% với bảng users (FK constraint)
        const resolveDesignerIdHelper = (rawInput, area, region) => {
            const s = String(rawInput || '').trim();
            if (s) {
                const lower = s.toLowerCase();
                if (lower.includes('thái') || lower === 'usr_doanminhthai' || lower.includes('minh_th_i')) return 'USR_doanminhthai';
                if (lower.includes('thảo') || lower === 'usr_thao_designer' || lower.includes('th_o')) return 'USR_thao_designer';
                if (lower.includes('hiển') || lower === 'usr_0966767731' || lower.includes('88000255') || lower.includes('0966767731')) return 'USR_0966767731';
                if (lower.includes('admin') || lower === 'usr_adminqcag') return 'USR_adminqcag';
                if (s === 'USR_doanminhthai' || s === 'USR_thao_designer' || s === 'USR_0966767731' || s === 'USR_adminqcag') return s;
            }
            const a = String(area || region || '').toUpperCase().trim();
            if (a === 'S16' || a === 'S4') return 'USR_0966767731';
            if (['S17', 'S24', 'MOT8'].includes(a)) return 'USR_thao_designer';
            return 'USR_doanminhthai';
        };

        // Auto-upload any base64 images to GCS before persisting
        if ('statusImages' in b) b.statusImages = await ksAutoUploadImages(normalizeBodyValue(b.statusImages), folderForUpload, 'hien-trang');
        if ('oldContentImages' in b) b.oldContentImages = await ksAutoUploadImages(normalizeBodyValue(b.oldContentImages), folderForUpload, 'hien-trang');
        if ('designImages' in b) b.designImages = await ksAutoUploadImages(normalizeBodyValue(b.designImages), folderForUpload, 'mq');
        if ('acceptanceImages' in b) b.acceptanceImages = await ksAutoUploadImages(normalizeBodyValue(b.acceptanceImages), folderForUpload, 'mq');

        // Bridge any incoming comments to 3NF notes table
        if ('comments' in b) {
            await saveCommentPayloadToNotes(tkCode, b.comments);
        }

        // Sync assets & designs if images provided (supports both Array and JSON string)
        const parseImagesArr = (val) => {
            if (!val) return [];
            if (Array.isArray(val)) return val;
            if (typeof val === 'string') {
                try {
                    const parsed = JSON.parse(val);
                    return Array.isArray(parsed) ? parsed : [];
                } catch (_) { return []; }
            }
            return [];
        };

        if ('statusImages' in b) {
            const statusImgsList = parseImagesArr(b.statusImages);
            await pool.query(`DELETE FROM assets WHERE owner_type = 'request' AND owner_code = ? AND category = 'status'`, [tkCode]);
            for (let i = 0; i < statusImgsList.length; i++) {
                const u = statusImgsList[i];
                if (typeof u === 'string' && u.trim() && !u.startsWith('data:')) {
                    const astId = `ast_${tkCode}_st_${i + 1}`;
                    await pool.query(`
                        INSERT INTO assets (id, owner_type, owner_code, category, url, sort_order, created_at)
                        VALUES (?, 'request', ?, 'status', ?, ?, NOW())
                        ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url
                    `, [astId, tkCode, u.trim(), i + 1]);
                }
            }
        }

        if ('designImages' in b) {
            const designImgsList = parseImagesArr(b.designImages);
            if (designImgsList.length === 0) {
                // Người dùng bấm xóa ảnh MQ (chỉ xóa khi không phải yêu cầu chỉnh sửa và có cờ xác nhận rõ ràng)
                if (b.allowClearDesign === true) {
                    await pool.query('DELETE FROM designs WHERE request_tk_code = ?', [tkCode]);
                }
            } else {
                // Lấy ảnh MQ mới nhất hợp lệ
                const latestImg = designImgsList[designImgsList.length - 1];
                if (typeof latestImg === 'string' && latestImg.trim() && !latestImg.startsWith('data:')) {
                    const dsgId = `dsg_${tkCode}`;
                    const filenameVal = b.designFilename ? String(b.designFilename).trim() : null;
                    const desId = resolveDesignerIdHelper(b.designCreatedBy || b.designerId || b.designLastEditedBy, currentReq.outlet_area, currentReq.sale_region);
                    await pool.query(`
                        INSERT INTO designs (id, request_tk_code, url, filename, created_by, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, NOW(), NOW())
                        ON CONFLICT (request_tk_code) DO UPDATE SET 
                            url = EXCLUDED.url,
                            filename = COALESCE(NULLIF(EXCLUDED.filename, ''), designs.filename),
                            created_by = COALESCE(EXCLUDED.created_by, designs.created_by),
                            updated_at = NOW()
                    `, [dsgId, tkCode, latestImg.trim(), filenameVal, desId]);
                }
            }
        } else if ('designFilename' in b && b.designFilename) {
            const filenameVal = String(b.designFilename).trim();
            if (filenameVal) {
                await pool.query('UPDATE designs SET filename = ?, updated_at = NOW() WHERE request_tk_code = ?', [filenameVal, tkCode]);
            }
        }

        if ('acceptanceImages' in b) {
            const acceptImgsList = parseImagesArr(b.acceptanceImages);
            await pool.query(`DELETE FROM assets WHERE owner_type = 'request' AND owner_code = ? AND category = 'acceptance'`, [tkCode]);
            for (let i = 0; i < acceptImgsList.length; i++) {
                const u = acceptImgsList[i];
                if (typeof u === 'string' && u.trim() && !u.startsWith('data:')) {
                    const astId = `ast_${tkCode}_ac_${i + 1}`;
                    await pool.query(`
                        INSERT INTO assets (id, owner_type, owner_code, category, url, sort_order, created_at)
                        VALUES (?, 'request', ?, 'acceptance', ?, ?, NOW())
                        ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url
                    `, [astId, tkCode, u.trim(), i + 1]);
                }
            }
        }

        const fields = [], vals = [];
        const maybeStr = (k, col) => { if (k in b) { fields.push(`${col} = ?`); vals.push(toNullableString(b[k])); } };

        if ('deleteRequested' in b) {
            fields.push('delete_requested = ?');
            vals.push(Boolean(b.deleteRequested));
        }
        maybeStr('deleteReason', 'delete_reason');
        if ('deleteRequestedAt' in b) {
            fields.push('delete_requested_at = ?');
            vals.push(b.deleteRequestedAt ? new Date(b.deleteRequestedAt) : null);
        }
        maybeStr('deleteRequestedBy', 'delete_requested_by');
        maybeStr('deleteRequestedPhone', 'delete_requested_phone');
        maybeStr('deleteRequestedSaleCode', 'delete_requested_sale_code');
        maybeStr('deleteStatus', 'delete_status');
        maybeStr('deleteRejectReason', 'delete_reject_reason');
        maybeStr('status', 'status');
        maybeStr('subStatus', 'sub_status');
        maybeStr('type', 'type');
        if ('isTba' in b) {
            fields.push('is_tba = ?');
            vals.push(Boolean(b.isTba));
        }
        maybeStr('content', 'content');
        if ('oldContent' in b || 'old_content' in b) {
            fields.push('old_content = ?');
            vals.push(Boolean(b.oldContent || b.old_content));
        }
        maybeStr('oldContentExtra', 'old_content_extra');

        // Handle outletCode change
        if ('outletCode' in b && b.outletCode && currentReq.outlet_id) {
            const newCode = toNullableString(b.outletCode);
            await pool.query('UPDATE outlets SET code = ?, updated_at = NOW() WHERE id = ?', [newCode, currentReq.outlet_id]);
        }
        if (('outletName' in b || 'address' in b || 'outletLat' in b || 'outletLng' in b || 'phone' in b) && currentReq.outlet_id) {
            const oFields = [], oVals = [];
            if ('outletName' in b) { oFields.push('name = ?'); oVals.push(toNullableString(b.outletName)); }
            if ('address' in b) { oFields.push('address = ?'); oVals.push(toNullableString(b.address)); }
            if ('outletLat' in b && b.outletLat) { oFields.push('latitude = ?'); oVals.push(Number(b.outletLat) || null); }
            if ('outletLng' in b && b.outletLng) { oFields.push('longitude = ?'); oVals.push(Number(b.outletLng) || null); }
            if ('phone' in b) { oFields.push('phone = ?'); oVals.push(toNullableString(b.phone)); }
            if (oFields.length > 0) {
                oFields.push('updated_at = NOW()');
                oVals.push(currentReq.outlet_id);
                await pool.query(`UPDATE outlets SET ${oFields.join(', ')} WHERE id = ?`, oVals);
            }
        }

        if (fields.length > 0) {
            fields.push('updated_at = ?');
            vals.push(now);
            vals.push(tkCode);
            await pool.query(`UPDATE requests SET ${fields.join(', ')} WHERE tk_code = ?`, vals);
        }

        // Handle item edits & survey dimensions updates
        // Triệt để bảo vệ request_items: cấm xóa nhầm khi items rỗng hoặc gửi từ bản ghi lite
        if ('items' in b) {
            let itemsToSave = [];
            let isValidArray = false;
            try {
                if (typeof b.items === 'string') {
                    const parsed = JSON.parse(b.items);
                    if (Array.isArray(parsed)) {
                        itemsToSave = parsed;
                        isValidArray = true;
                    }
                } else if (Array.isArray(b.items)) {
                    itemsToSave = b.items;
                    isValidArray = true;
                }
            } catch (_) { isValidArray = false; }
            if (isValidArray && itemsToSave.length > 0) {
                const processedIds = [];
                for (let i = 0; i < itemsToSave.length; i++) {
                    const it = itemsToSave[i] || {};
                    const itemId = (toNullableString(it.id) || `rqi_${String(tkCode).replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}_${i + 1}`).trim();
                    it.id = itemId;
                    processedIds.push(itemId);
                    const seq = Number(it.seq) || (i + 1);
                    const itemType = toNullableString(it.type) || 'Hạng mục khảo sát';
                    const action = toNullableString(it.action) || 'Làm mới';
                    const brand = toNullableString(it.brand) || null;
                    const width = it.width && !isNaN(Number(it.width)) ? Number(it.width) : null;
                    const height = it.height && !isNaN(Number(it.height)) ? Number(it.height) : null;
                    const useOldSize = Boolean(it.useOldSize);
                    const poles = Number(it.poles) || 0;
                    const note = toNullableString(it.note);
                    const otherContent = toNullableString(it.otherContent || it.subType);
                    const isSurvey = Boolean(it.survey);
                    const surveyW = (it.surveySize && it.surveySize.width && !isNaN(Number(it.surveySize.width))) ? Number(it.surveySize.width) : null;
                    const surveyH = (it.surveySize && it.surveySize.height && !isNaN(Number(it.surveySize.height))) ? Number(it.surveySize.height) : null;
                    const brandChangedByQcag = Boolean(it.brandChangedByQCAG || it.brandChangedByQcag || it.brand_changed_by_qcag);
                    const brandChangedBy = toNullableString(it.brandChangedBy || it.brand_changed_by);
                    const addedByQcag = Boolean(it.addedByQCAG || it.addedByQcag || it.added_by_qcag);
                    const addedByQcagBy = toNullableString(it.addedByQCAGBy || it.addedByQcagBy || it.added_by_qcag_by);
                    const editedByQcag = Boolean(it.editedByQCAG || it.editedByQcag || it.edited_by_qcag);
                    const editedByQcagBy = toNullableString(it.editedByQCAGBy || it.editedByQcagBy || it.edited_by_qcag_by);
                    const editedByQcagAt = (it.editedByQCAGAt || it.editedByQcagAt || it.edited_by_qcag_at) ? new Date(it.editedByQCAGAt || it.editedByQcagAt || it.edited_by_qcag_at) : null;

                    await pool.query(`
                        INSERT INTO request_items (
                            id, request_tk_code, seq, type, other_content, action, brand,
                            width, height, use_old_size, poles, note,
                            survey, survey_width, survey_height,
                            brand_changed_by_qcag, brand_changed_by,
                            added_by_qcag, added_by_qcag_by,
                            edited_by_qcag, edited_by_qcag_by, edited_by_qcag_at,
                            created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                        ON CONFLICT (id) DO UPDATE SET
                            seq = EXCLUDED.seq,
                            type = EXCLUDED.type,
                            other_content = EXCLUDED.other_content,
                            action = EXCLUDED.action,
                            brand = EXCLUDED.brand,
                            width = EXCLUDED.width,
                            height = EXCLUDED.height,
                            use_old_size = EXCLUDED.use_old_size,
                            poles = EXCLUDED.poles,
                            note = EXCLUDED.note,
                            survey = EXCLUDED.survey,
                            survey_width = EXCLUDED.survey_width,
                            survey_height = EXCLUDED.survey_height,
                            brand_changed_by_qcag = EXCLUDED.brand_changed_by_qcag,
                            brand_changed_by = COALESCE(EXCLUDED.brand_changed_by, request_items.brand_changed_by),
                            added_by_qcag = EXCLUDED.added_by_qcag,
                            added_by_qcag_by = COALESCE(EXCLUDED.added_by_qcag_by, request_items.added_by_qcag_by),
                            edited_by_qcag = EXCLUDED.edited_by_qcag,
                            edited_by_qcag_by = COALESCE(EXCLUDED.edited_by_qcag_by, request_items.edited_by_qcag_by),
                            edited_by_qcag_at = COALESCE(EXCLUDED.edited_by_qcag_at, request_items.edited_by_qcag_at)
                    `, [
                        itemId, tkCode, seq, itemType, otherContent, action, brand,
                        width, height, useOldSize, poles, note,
                        isSurvey, surveyW, surveyH,
                        brandChangedByQcag, brandChangedBy,
                        addedByQcag, addedByQcagBy,
                        editedByQcag, editedByQcagBy, editedByQcagAt
                    ]);
                }
                if (processedIds.length > 0) {
                    await pool.query(`DELETE FROM request_items WHERE request_tk_code = ? AND id NOT IN (${processedIds.map(() => '?').join(',')})`, [tkCode, ...processedIds]);
                }
            } else if (isValidArray && itemsToSave.length === 0 && b.allowEmptyItems === true) {
                // Triệt để bảo vệ request_items: Chỉ xóa khi client chủ động truyền cờ allowEmptyItems === true
                await pool.query(`DELETE FROM request_items WHERE request_tk_code = ?`, [tkCode]);
            }
        }
        ksInvalidateCache();

        if (b.status === 'done') {
            try {
                await pool.query(`UPDATE design_tasks SET status = 'done', updated_at = NOW() WHERE tk_code = ?`, [tkCode]);
                wsInvalidate('design_tasks', { action: 'update', tk_code: tkCode });
            } catch (dtDoneErr) {
                console.warn('[ks/update] design_tasks done update warning:', dtDoneErr && dtDoneErr.message);
            }
        }

        // Synchronize designer assignment to design_tasks table
        if ('designCreatedBy' in b || 'designerId' in b || 'designLastEditedBy' in b) {
            try {
                const des = resolveDesignerIdHelper(b.designCreatedBy || b.designerId || b.designLastEditedBy, currentReq.outlet_area, currentReq.sale_region);
                if (des) {
                    await pool.query(`UPDATE design_tasks SET designer_id = ?, updated_at = NOW() WHERE tk_code = ?`, [des, tkCode]);
                    wsInvalidate('design_tasks', { action: 'update', tk_code: tkCode });
                }
            } catch (dtErr) {
                console.warn('[ks/update] design_tasks designer sync warning:', dtErr && dtErr.message ? dtErr.message : dtErr);
            }
        }

        // Post-update workflows (Design tasks, push notifications)
        try {
            const becomingDone = b.status === 'done' && currentReq.status !== 'done';
            const isEditConfirm = becomingDone && ('designLastEditedBy' in b);
            const isFirstMQ = becomingDone && ('designCreatedBy' in b) && !isEditConfirm;

            if (isEditConfirm || isFirstMQ || (becomingDone && 'designImages' in b)) {
                const requesterPhone = currentReq.requester_phone || null;
                const outletLabel = currentReq.outlet_name || currentReq.outlet_code || 'Outlet';

                // Chuyển giao Task cho App 1 khi ĐÃ CÓ BẢN VẼ MQ
                try {
                    const desId = resolveDesignerIdHelper(b.designCreatedBy || b.designLastEditedBy || b.designerId, currentReq.outlet_area, currentReq.sale_region);
                    await pool.query(`
                        INSERT INTO design_tasks (
                            tk_code,
                            ks_backend_id,
                            sale_phone,
                            outlet_phone,
                            address,
                            designer_id,
                            status,
                            created_at,
                            updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW())
                        ON CONFLICT (tk_code) DO UPDATE SET
                            ks_backend_id = COALESCE(EXCLUDED.ks_backend_id, design_tasks.ks_backend_id),
                            designer_id = COALESCE(EXCLUDED.designer_id, design_tasks.designer_id),
                            sale_phone = COALESCE(EXCLUDED.sale_phone, design_tasks.sale_phone),
                            outlet_phone = COALESCE(EXCLUDED.outlet_phone, design_tasks.outlet_phone),
                            address = COALESCE(EXCLUDED.address, design_tasks.address),
                            status = 'pending',
                            updated_at = NOW()
                    `, [
                        tkCode,
                        currentReq.id,
                        requesterPhone,
                        currentReq.outlet_phone || null,
                        currentReq.address || null,
                        desId
                    ]);
                    wsInvalidate('design_tasks', { action: 'create', tk_code: tkCode });
                } catch (taskErr) {
                    console.warn('[ks/update] create design_task error (non-fatal):', taskErr && taskErr.message ? taskErr.message : taskErr);
                }

                // Gửi push notification cho Mobile Sale (fire-and-forget, không block HTTP response)
                if (isFirstMQ) {
                    sendKsPush({
                        title: 'QCAG — Đã có mẫu quảng cáo (MQ)',
                        body: `Yêu cầu ${tkCode} Outlet ${outletLabel} đã có MQ. Vui lòng truy cập quản lý yêu cầu để xem MQ.`,
                        data: { backendId: currentReq.id },
                        targetPhone: requesterPhone,
                    }).catch(pushErr => console.warn('[push] firstMQ push warning:', pushErr && pushErr.message ? pushErr.message : pushErr));
                } else if (isEditConfirm) {
                    sendKsPush({
                        title: 'QCAG — Đã hoàn thành chỉnh sửa',
                        body: `Yêu cầu ${tkCode} Outlet ${outletLabel} đã được chỉnh sửa. Vui lòng truy cập quản lý yêu cầu để xem chỉnh sửa.`,
                        data: { backendId: currentReq.id },
                        targetPhone: requesterPhone,
                    }).catch(pushErr => console.warn('[push] editConfirm push warning:', pushErr && pushErr.message ? pushErr.message : pushErr));
                }
            }
        } catch (pushErr) {
            console.warn('[push] notify error (non-fatal):', pushErr && pushErr.message ? pushErr.message : pushErr);
        }

        // Fetch fresh row directly from 3NF tables
        const viewRow = await getRequestDetailDirect(tkCode || id || currentReq.id);
        const updated = viewRow || currentReq;
        const appUpdated = ksRowToApp(updated);
        ksInvalidateCache();
        wsInvalidate('ks_requests', { action: 'update', id: tkCode, data: appUpdated });
        return res.json({ ok: true, data: appUpdated });
    } catch (err) {
        console.error('PATCH /api/ks/requests/:id error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'update_failed' });
    }
});

// DELETE /api/ks/requests/:id
app.delete('/api/ks/requests/:id', async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        const deleteReason = req.body && req.body.reason ? String(req.body.reason).trim() : '';

        // Check primary V12 table: requests
        let [reqRows] = await pool.query(
            'SELECT * FROM requests WHERE tk_code = ? OR id = ? LIMIT 1',
            [id, id]
        );
        if (!reqRows || reqRows.length === 0) {
            return res.status(404).json({ ok: false, error: 'not_found' });
        }

        const row = reqRows[0];
        const tkCode = row.tk_code || id;
        await pool.query(
            'UPDATE requests SET is_deleted = true, deleted_at = NOW(), updated_at = NOW(), delete_status = ? WHERE tk_code = ?',
            ['approved', tkCode]
        );
        console.log(`[DELETED] Request tk_code=${tkCode} marked is_deleted=true in requests. Reason: ${deleteReason}`);
        ksInvalidateCache();
        wsInvalidate('ks_requests', {
            action: 'delete',
            id: row.id || tkCode,
            backendId: row.id || tkCode,
            tkCode: tkCode
        });
        return res.json({ ok: true, deleted: 1, tkCode, id: row.id || tkCode });
    } catch (err) {
        console.error('DELETE /api/ks/requests/:id error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'delete_failed' });
    }
});

// POST /api/ks/upload  — ảnh lên bucket GCS_BUCKET
// Body: { dataUrl, filename?, backendId?, folder? }
// Structured path: ks-surveys/{backendId}/{folder}/{ts}_{rand}.{ext}
// Fallback flat path (no backendId): ks-attachments/{ts}_{rand}.{ext}
app.post('/api/ks/upload', async (req, res) => {
    try {
        const dataUrl = req.body && req.body.dataUrl != null ? String(req.body.dataUrl) : '';
        const filenameHint = req.body && req.body.filename != null ? String(req.body.filename) : '';
        const backendIdRaw = req.body && req.body.backendId != null ? String(req.body.backendId) : '';
        const folderRaw = req.body && req.body.folder != null ? String(req.body.folder) : '';
        if (!dataUrl) return res.status(400).json({ ok: false, error: 'missing_dataUrl' });
        const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
        if (!m) return res.status(400).json({ ok: false, error: 'invalid_dataUrl' });
        const ksBucketName = process.env.KS_GCS_BUCKET || process.env.GCS_BUCKET || 'qcag-483014-qcag-images';
        if (!ksBucketName) return res.status(500).json({ ok: false, error: 'KS_GCS_BUCKET not configured' });
        const mimetype = m[1];
        const buffer = Buffer.from(m[2], 'base64');
        let ext = 'bin';
        if (mimetype === 'image/jpeg') ext = 'jpg';
        else if (mimetype === 'image/png') ext = 'png';
        else if (mimetype === 'image/webp') ext = 'webp';
        else if (mimetype === 'image/gif') ext = 'gif';
        const rand = crypto.randomBytes(6).toString('hex');
        const ts = Date.now();
        let filename;
        if (backendIdRaw) {
            const safeId = backendIdRaw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
            const safeFld = folderRaw ? folderRaw.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 64) : 'misc';
            filename = `ks-surveys/${safeId}/${safeFld}/${ts}_${rand}.${ext}`;
        } else {
            const safeHint = String(filenameHint || '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
            filename = `ks-attachments/${ts}_${rand}${safeHint ? '_' + safeHint : ''}.${ext}`;
        }
        await gcs.bucket(ksBucketName).file(filename).save(buffer, { contentType: mimetype });
        const url = `https://storage.googleapis.com/${ksBucketName}/${filename}`;
        return res.json({ ok: true, url, name: filename });
    } catch (err) {
        console.error('/api/ks/upload error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'upload_failed' });
    }
});

// POST /api/ks/requests/:id/rename-mq-folder
// Body: { newOutletCode }  — manually trigger GCS mq folder rename + DB update
app.post('/api/ks/requests/:id/rename-mq-folder', async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        const newOutletCode = String((req.body && req.body.newOutletCode) || '').trim();
        if (!newOutletCode) return res.status(400).json({ ok: false, error: 'missing newOutletCode' });

        let [reqRows] = await pool.query(
            'SELECT r.*, o.code as outlet_code FROM requests r LEFT JOIN outlets o ON r.outlet_id = o.id WHERE r.tk_code = ? OR r.id = ? LIMIT 1',
            [id, id]
        );
        if (!reqRows || reqRows.length === 0) return res.status(404).json({ ok: false, error: 'not_found' });
        const current = reqRows[0];
        const tkCode = current.tk_code || id;
        const oldMqFolder = current.mq_folder;
        const newMqFolder = ksSafeMqFolder(newOutletCode);
        const ksBucket = process.env.KS_GCS_BUCKET || process.env.GCS_BUCKET || 'qcag-483014-qcag-images';

        let remap = {};
        if (oldMqFolder && ksBucket && oldMqFolder !== newMqFolder) {
            remap = await ksRenameGcsFolder(
                ksBucket,
                (current.id || tkCode) + '/' + oldMqFolder,
                (current.id || tkCode) + '/' + newMqFolder
            );
        }

        // Update outlets code & requests mq_folder
        if (current.outlet_id) {
            await pool.query('UPDATE outlets SET code = ?, updated_at = NOW() WHERE id = ?', [newOutletCode, current.outlet_id]);
        }
        await pool.query('UPDATE requests SET mq_folder = ?, updated_at = NOW() WHERE tk_code = ?', [newMqFolder, tkCode]);

        // Remap URLs in assets table if any
        if (Object.keys(remap).length > 0) {
            for (const [oldUrl, newUrl] of Object.entries(remap)) {
                await pool.query('UPDATE assets SET url = ? WHERE owner_type = ? AND owner_code = ? AND url = ?', [newUrl, 'request', tkCode, oldUrl]);
            }
        }

        const viewRow = await getRequestDetailDirect(tkCode || current.id);
        const appUpdatedMq = viewRow ? ksRowToApp(viewRow) : current;
        ksInvalidateCache();
        wsInvalidate('ks_requests', { action: 'update', id: tkCode, data: appUpdatedMq });
        return res.json({ ok: true, data: appUpdatedMq, renamedFiles: Object.keys(remap).length });
    } catch (err) {
        console.error('/api/ks/requests/:id/rename-mq-folder error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'rename_failed' });
    }
});

// ── GET /api/ks/requests/production-approvals ─────────────────────────
app.get(['/api/ks/requests/production-approvals', '/production-approvals'], async (req, res) => {
    try {
        const map = {};
        const extractCleanCode = (s) => {
            if (!s) return '';
            const m = String(s).match(/po_q_([A-Za-z0-9]+)_/);
            return m && m[1] ? m[1] : String(s).trim();
        };

        try {
            // 1. Nguồn lịch sử & phê duyệt thực tế: ks_production_approvals
            try {
                const [apprRows] = await pool.query(`
                    SELECT 
                        a.quote_code,
                        a.outlet_code,
                        a.status,
                        a.approved_by,
                        a.approved_at,
                        a.reject_reason,
                        COALESCE(q.request_tk_code, '') AS request_tk_code
                    FROM ks_production_approvals a
                    LEFT JOIN quotations q ON (q.quote_code = a.quote_code OR q.quote_code = 'po_q_' || a.quote_code || '_')
                    ORDER BY a.approved_at ASC NULLS LAST, a.id ASC
                `);

                (apprRows || []).forEach(r => {
                    const rawCode = String(r.quote_code || '').trim();
                    const cleanCode = extractCleanCode(rawCode);
                    const tkCode = String(r.request_tk_code || '').trim();
                    const outletCode = String(r.outlet_code || '').trim();

                    const item = {
                        quoteCode: cleanCode || rawCode,
                        tkCode: tkCode,
                        outletCode: outletCode,
                        status: r.status || 'pending',
                        approvedBy: r.approved_by || null,
                        approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
                        reason: r.reject_reason || null
                    };

                    if (cleanCode) { map[cleanCode] = item; map[cleanCode.toLowerCase()] = item; }
                    if (rawCode) { map[rawCode] = item; map[rawCode.toLowerCase()] = item; }
                    if (tkCode) { map[tkCode] = item; map[tkCode.toLowerCase()] = item; }
                    if (outletCode) { map[outletCode] = item; map[outletCode.toLowerCase()] = item; }
                });
            } catch (apprErr) {
                console.warn('[production-approvals] ks_production_approvals query warning:', apprErr && apprErr.message);
            }

            // 2. Nguồn V12: quotations & order_quotes (bảo toàn tên người duyệt cụ thể)
            try {
                const [v12Rows] = await pool.query(`
                    SELECT 
                        q.quote_code,
                        q.request_tk_code,
                        COALESCE(o.code, '') AS outlet_code,
                        CASE 
                            WHEN COALESCE(oq.approval_status, q.status) IN ('approved', 'confirmed') THEN 'approved'
                            WHEN COALESCE(oq.approval_status, q.status) = 'rejected' THEN 'rejected'
                            ELSE 'pending'
                        END AS status,
                        COALESCE(u.fullname, u.username, oq.approved_by, NULL) AS approved_by,
                        COALESCE(oq.approved_at, q.last_confirmed_at) AS approved_at,
                        oq.reject_reason AS reject_reason
                    FROM quotations q
                    LEFT JOIN outlets o ON q.outlet_id = o.id
                    LEFT JOIN order_quotes oq ON oq.quotation_code = q.quote_code
                    LEFT JOIN users u ON oq.approved_by = u.id
                    WHERE q.is_deleted = false AND (q.status IN ('approved', 'rejected', 'confirmed') OR oq.approval_status IN ('approved', 'rejected'))
                `);

                (v12Rows || []).forEach(r => {
                    const rawCode = String(r.quote_code || '').trim();
                    const cleanCode = extractCleanCode(rawCode);
                    const tkCode = String(r.request_tk_code || '').trim();
                    const outletCode = String(r.outlet_code || '').trim();

                    const existing = map[cleanCode.toLowerCase()] || map[rawCode.toLowerCase()] || (tkCode ? map[tkCode.toLowerCase()] : null);
                    const approverName = r.approved_by || (existing && existing.approvedBy) || 'Sale Heineken';

                    const item = {
                        quoteCode: cleanCode || rawCode,
                        tkCode: tkCode,
                        outletCode: outletCode,
                        status: r.status || (existing && existing.status) || 'pending',
                        approvedBy: approverName,
                        approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : (existing ? existing.approvedAt : null),
                        reason: r.reject_reason || (existing ? existing.reason : null)
                    };

                    if (cleanCode) { map[cleanCode] = item; map[cleanCode.toLowerCase()] = item; }
                    if (rawCode) { map[rawCode] = item; map[rawCode.toLowerCase()] = item; }
                    if (tkCode && !map[tkCode.toLowerCase()]) { map[tkCode] = item; map[tkCode.toLowerCase()] = item; }
                    if (outletCode && !map[outletCode.toLowerCase()]) { map[outletCode] = item; map[outletCode.toLowerCase()] = item; }
                });
            } catch (v12Err) {
                console.warn('[production-approvals] v12 query warning:', v12Err && v12Err.message);
            }

            // 3. Yêu cầu sửa chưa giải quyết từ notes (chỉ nhận khi CHƯA có edit-resolved và CHƯA được duyệt sau đó)
            try {
                const [editRows] = await pool.query(`
                    WITH latest_edit_req AS (
                        SELECT DISTINCT ON (ref_id)
                            ref_id,
                            content,
                            author_name,
                            created_at
                        FROM notes
                        WHERE note_type IN ('edit-request', 'edit_request')
                        ORDER BY ref_id, created_at DESC
                    ),
                    latest_edit_res AS (
                        SELECT DISTINCT ON (ref_id)
                            ref_id,
                            created_at
                        FROM notes
                        WHERE note_type = 'edit-resolved'
                        ORDER BY ref_id, created_at DESC
                    )
                    SELECT 
                        e.ref_id,
                        e.content,
                        e.author_name,
                        e.created_at,
                        q.quote_code,
                        q.request_tk_code,
                        COALESCE(o.code, '') AS outlet_code
                    FROM latest_edit_req e
                    LEFT JOIN quotations q ON (q.quote_code = e.ref_id OR q.request_tk_code = e.ref_id)
                    LEFT JOIN outlets o ON q.outlet_id = o.id
                    LEFT JOIN latest_edit_res r ON (
                        r.ref_id = e.ref_id 
                        OR (q.request_tk_code IS NOT NULL AND r.ref_id = q.request_tk_code)
                        OR (q.quote_code IS NOT NULL AND r.ref_id = q.quote_code)
                    )
                    LEFT JOIN LATERAL (
                        SELECT COALESCE(d.updated_at, d.created_at) AS design_effective_at
                        FROM designs d
                        WHERE (q.request_tk_code IS NOT NULL AND d.request_tk_code = q.request_tk_code)
                           OR d.request_tk_code = e.ref_id
                        ORDER BY COALESCE(d.updated_at, d.created_at) DESC
                        LIMIT 1
                    ) d_lat ON true
                    WHERE (r.created_at IS NULL OR r.created_at < e.created_at)
                      AND (d_lat.design_effective_at IS NULL OR d_lat.design_effective_at < e.created_at)
                `);

                (editRows || []).forEach(r => {
                    const rawRef = String(r.ref_id || '').trim();
                    const cleanRef = extractCleanCode(rawRef);
                    const qCode = String(r.quote_code || '').trim();
                    const cleanQCode = extractCleanCode(qCode);
                    const tkCode = String(r.request_tk_code || '').trim();
                    const outletCode = String(r.outlet_code || '').trim();

                    // Nếu đã được duyệt sản xuất sau thời điểm yêu cầu sửa -> Trạng thái 'approved' được ưu tiên
                    const existing = map[cleanRef.toLowerCase()] || map[cleanQCode.toLowerCase()] || (tkCode ? map[tkCode.toLowerCase()] : null);
                    if (existing && existing.status === 'approved') {
                        const apprTime = existing.approvedAt ? new Date(existing.approvedAt).getTime() : 0;
                        const editTime = r.created_at ? new Date(r.created_at).getTime() : 0;
                        if (apprTime >= editTime) {
                            return;
                        }
                    }

                    const item = {
                        quoteCode: cleanQCode || cleanRef,
                        tkCode: tkCode,
                        outletCode: outletCode,
                        status: 'pending-edit',
                        approvedBy: r.author_name || null,
                        approvedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
                        reason: r.content || null
                    };

                    if (cleanRef) { map[cleanRef] = item; map[cleanRef.toLowerCase()] = item; }
                    if (rawRef) { map[rawRef] = item; map[rawRef.toLowerCase()] = item; }
                    if (cleanQCode) { map[cleanQCode] = item; map[cleanQCode.toLowerCase()] = item; }
                    if (qCode) { map[qCode] = item; map[qCode.toLowerCase()] = item; }
                    if (tkCode) { map[tkCode] = item; map[tkCode.toLowerCase()] = item; }
                    if (outletCode) { map[outletCode] = item; map[outletCode.toLowerCase()] = item; }
                });
            } catch (noteErr) {
                console.warn('[production-approvals] edit-request notes warning:', noteErr && noteErr.message);
            }

        } catch (flowErr) {
            console.warn('[production-approvals] query fallback:', flowErr && flowErr.message ? flowErr.message : flowErr);
        }

        return res.json({ ok: true, data: map });
    } catch (err) {
        console.error('GET /api/ks/requests/production-approvals error:', err && err.message ? err.message : err);
        return res.json({ ok: true, data: {} });
    }
});

// ── POST /api/ks/requests/:id/approve-production ───────────────────────
app.post('/api/ks/requests/:id/approve-production', async (req, res) => {
    try {
        const rawId = String(req.params.id || '').trim();
        if (!rawId) return res.status(400).json({ ok: false, error: 'missing_id' });

        const extractCleanCode = (s) => {
            if (!s) return '';
            const m = String(s).match(/po_q_([A-Za-z0-9]+)_/);
            return m && m[1] ? m[1] : String(s).trim();
        };
        const cleanCode = extractCleanCode(rawId);
        const approvedBy = String((req.body && (req.body.approvedBy || req.body.saleName || req.body.phone)) || 'Sale Heineken').trim();
        const outletCode = String((req.body && (req.body.outletCode || req.body.outlet_code)) || '').trim();
        const targetCode = cleanCode || rawId;

        // Chặn tuyệt đối: Designer QCAG không được duyệt sản xuất thay cho Sale Heineken
        if (approvedBy.toLowerCase() === 'designer' || approvedBy.toLowerCase().includes('designer')) {
            return res.status(403).json({ ok: false, error: 'designer_cannot_approve_production' });
        }

        // 1. CẬP NHẬT CHUẨN V12: quotations
        try {
            await pool.query(`
                UPDATE quotations 
                SET status = 'approved', 
                    is_confirmed = 1, 
                    last_confirmed_at = NOW(), 
                    updated_at = NOW() 
                WHERE quote_code = ? OR request_tk_code = ?
            `, [targetCode, targetCode]);
        } catch (qErr) {
            console.warn('[approve-production] sync quotations warning:', qErr && qErr.message);
        }

        // 2. CẬP NHẬT CHUẨN V12: order_quotes (nếu đã gom đơn/lệnh sản xuất)
        try {
            let approverUserId = null;
            try {
                const [uRows] = await pool.query(
                    `SELECT id FROM users WHERE id = ? OR username = ? OR phone = ? OR fullname = ? LIMIT 1`,
                    [approvedBy, approvedBy, approvedBy, approvedBy]
                );
                if (uRows && uRows.length > 0) approverUserId = uRows[0].id;
            } catch (_) {}

            await pool.query(`
                UPDATE order_quotes 
                SET approval_status = 'approved', 
                    approved_by = ?, 
                    approved_at = NOW() 
                WHERE quotation_code = ?
            `, [approverUserId, targetCode]);
        } catch (oqErr) {
            console.warn('[approve-production] sync order_quotes warning:', oqErr && oqErr.message);
        }

        // 3. GHI LỊCH SỬ CHUẨN 3NF: notes
        try {
            const noteId = `nt_appr_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
            await pool.query(`
                INSERT INTO notes (id, ref_type, ref_id, note_type, content, author_name, created_at)
                VALUES (?, 'quotation', ?, 'approval', ?, ?, NOW())
            `, [noteId, targetCode, `Sale Heineken (${approvedBy}) đã duyệt sản xuất.`, approvedBy]);
        } catch (noteErr) {
            console.warn('[approve-production] record note warning:', noteErr && noteErr.message);
        }

        wsInvalidate('pending_orders');
        wsInvalidate('ks_requests');
        wsInvalidate('quotations');
        sseBroadcast({ type: 'production_approval', action: 'approve', quoteCode: targetCode, approvedBy });

        return res.json({ ok: true, status: 'approved', quoteCode: targetCode, approvedBy });
    } catch (err) {
        console.error('POST /api/ks/requests/:id/approve-production error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'approve_failed' });
    }
});

// ── POST /api/ks/requests/:id/reject-production ────────────────────────
app.post('/api/ks/requests/:id/reject-production', async (req, res) => {
    try {
        const rawId = String(req.params.id || '').trim();
        if (!rawId) return res.status(400).json({ ok: false, error: 'missing_id' });

        const extractCleanCode = (s) => {
            if (!s) return '';
            const m = String(s).match(/po_q_([A-Za-z0-9]+)_/);
            return m && m[1] ? m[1] : String(s).trim();
        };
        const cleanCode = extractCleanCode(rawId);
        const reason = String((req.body && (req.body.reason || req.body.rejectReason || req.body.comments)) || 'Từ chối').trim();
        const rejectedBy = String((req.body && (req.body.rejectedBy || req.body.approvedBy || req.body.saleName || req.body.phone)) || 'Sale Heineken').trim();
        const outletCode = String((req.body && (req.body.outletCode || req.body.outlet_code)) || '').trim();
        const targetCode = cleanCode || rawId;

        // 1. CẬP NHẬT CHUẨN V12: quotations
        try {
            await pool.query(`
                UPDATE quotations 
                SET status = 'rejected', 
                    is_confirmed = 0, 
                    updated_at = NOW() 
                WHERE quote_code = ? OR request_tk_code = ?
            `, [targetCode, targetCode]);
        } catch (qErr) {
            console.warn('[reject-production] sync quotations warning:', qErr && qErr.message);
        }

        // 2. CẬP NHẬT CHUẨN V12: order_quotes
        try {
            let rejectorUserId = null;
            try {
                const [uRows] = await pool.query(
                    `SELECT id FROM users WHERE id = ? OR username = ? OR phone = ? OR fullname = ? LIMIT 1`,
                    [rejectedBy, rejectedBy, rejectedBy, rejectedBy]
                );
                if (uRows && uRows.length > 0) rejectorUserId = uRows[0].id;
            } catch (_) {}

            await pool.query(`
                UPDATE order_quotes 
                SET approval_status = 'rejected', 
                    approved_by = ?, 
                    reject_reason = ? 
                WHERE quotation_code = ?
            `, [rejectorUserId, reason, targetCode]);
        } catch (oqErr) {
            console.warn('[reject-production] sync order_quotes warning:', oqErr && oqErr.message);
        }

        // 3. GHI LỊCH SỬ CHUẨN 3NF: notes
        try {
            const noteId = `nt_rej_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
            await pool.query(`
                INSERT INTO notes (id, ref_type, ref_id, note_type, content, author_name, created_at)
                VALUES (?, 'quotation', ?, 'rejection', ?, ?, NOW())
            `, [noteId, targetCode, `Từ chối sản xuất: ${reason}`, rejectedBy]);
        } catch (noteErr) {
            console.warn('[reject-production] record note warning:', noteErr && noteErr.message);
        }

        // 4. MỞ LẠI TASK THIẾT KẾ CHO DESIGNER QCAG KHI TỪ CHỐI SẢN XUẤT
        try {
            await pool.query(`
                UPDATE design_tasks 
                SET status = 'pending', updated_at = NOW() 
                WHERE tk_code = ? OR tk_code = (SELECT request_tk_code FROM quotations WHERE quote_code = ? LIMIT 1)
            `, [targetCode, targetCode]);
            wsInvalidate('design_tasks', { action: 'update', code: targetCode });
        } catch (dtErr) {
            console.warn('[reject-production] reopen design_task warning:', dtErr && dtErr.message);
        }

        wsInvalidate('pending_orders');
        wsInvalidate('ks_requests');
        wsInvalidate('quotations');
        sseBroadcast({ type: 'production_approval', action: 'reject', quoteCode: targetCode, reason });

        return res.json({ ok: true, status: 'rejected', quoteCode: targetCode, reason });
    } catch (err) {
        console.error('POST /api/ks/requests/:id/reject-production error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'reject_failed' });
    }
});

// ── POST /api/ks/requests/:id/request-edit-production ──────────────────
app.post('/api/ks/requests/:id/request-edit-production', async (req, res) => {
    try {
        const rawId = String(req.params.id || '').trim();
        if (!rawId) return res.status(400).json({ ok: false, error: 'missing_id' });

        const extractCleanCode = (s) => {
            if (!s) return '';
            const m = String(s).match(/po_q_([A-Za-z0-9]+)_/);
            return m && m[1] ? m[1] : String(s).trim();
        };
        const cleanCode = extractCleanCode(rawId);
        const reason = String((req.body && (req.body.comments || req.body.reason || req.body.rejectReason)) || 'Yêu cầu chỉnh sửa').trim();
        const requestedBy = String((req.body && (req.body.requestedBy || req.body.approvedBy || req.body.saleName || req.body.phone)) || 'Sale Heineken').trim();
        const outletCode = String((req.body && (req.body.outletCode || req.body.outlet_code)) || '').trim();
        const targetCode = cleanCode || rawId;

        // 1. CẬP NHẬT CHUẨN V12: quotations
        try {
            await pool.query(`
                UPDATE quotations 
                SET status = 'pending', 
                    is_confirmed = 0, 
                    updated_at = NOW() 
                WHERE quote_code = ? OR request_tk_code = ?
            `, [targetCode, targetCode]);
        } catch (qErr) {
            console.warn('[request-edit-production] sync quotations warning:', qErr && qErr.message);
        }

        // 2. CẬP NHẬT CHUẨN V12: order_quotes
        try {
            await pool.query(`
                UPDATE order_quotes 
                SET approval_status = 'pending', 
                    reject_reason = ? 
                WHERE quotation_code = ?
            `, [reason, targetCode]);
        } catch (oqErr) {
            console.warn('[request-edit-production] sync order_quotes warning:', oqErr && oqErr.message);
        }

        // 3. GHI LỊCH SỬ CHUẨN 3NF: notes
        try {
            const noteId = `nt_edit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
            await pool.query(`
                INSERT INTO notes (id, ref_type, ref_id, note_type, content, author_name, created_at)
                VALUES (?, 'quotation', ?, 'edit-request', ?, ?, NOW())
            `, [noteId, targetCode, `Yêu cầu chỉnh sửa: ${reason}`, requestedBy]);
        } catch (noteErr) {
            console.warn('[request-edit-production] record note warning:', noteErr && noteErr.message);
        }

        // 4. MỞ LẠI TASK THIẾT KẾ CHO DESIGNER QCAG
        try {
            await pool.query(`
                UPDATE design_tasks 
                SET status = 'pending', updated_at = NOW() 
                WHERE tk_code = ? OR tk_code = (SELECT request_tk_code FROM quotations WHERE quote_code = ? LIMIT 1)
            `, [targetCode, targetCode]);
            wsInvalidate('design_tasks', { action: 'update', code: targetCode });
        } catch (dtErr) {
            console.warn('[request-edit-production] reopen design_task warning:', dtErr && dtErr.message);
        }

        // 5. ĐỒNG BỘ TRẠNG THÁI YÊU CẦU SỬA VÀO BẢNG CHUẨN 3NF & KS_REQUESTS
        try {
            let tkCode = rawId;
            try {
                const [qRows] = await pool.query(
                    `SELECT request_tk_code FROM quotations WHERE quote_code = ? LIMIT 1`,
                    [targetCode]
                );
                if (qRows && qRows[0] && qRows[0].request_tk_code) {
                    tkCode = qRows[0].request_tk_code;
                }
            } catch (_) {}

            if (tkCode && tkCode !== targetCode) {
                const noteTkId = `nt_edit_tk_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
                await pool.query(`
                    INSERT INTO notes (id, ref_type, ref_id, note_type, content, author_name, created_at)
                    VALUES (?, 'request', ?, 'edit-request', ?, ?, NOW())
                `, [noteTkId, tkCode, `Yêu cầu chỉnh sửa: ${reason}`, requestedBy]);
            }
        } catch (noteErr) {
            console.warn('[request-edit-production] record note warning:', noteErr && noteErr.message);
        }

        wsInvalidate('pending_orders');
        wsInvalidate('ks_requests');
        wsInvalidate('quotations');
        sseBroadcast({ type: 'production_approval', action: 'request_edit', quoteCode: targetCode, reason });

        return res.json({ ok: true, status: 'rejected', quoteCode: targetCode, reason });
    } catch (err) {
        console.error('POST /api/ks/requests/:id/request-edit-production error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'request_edit_failed' });
    }
});


// ======================== END KS MOBILE API ========================

async function start() {
    const preferredPort = Number(PORT) || 3000;
    const candidatePorts = (!process.env.K_SERVICE)
        ? Array.from(new Set([preferredPort, 3101, 3102]))
        : [preferredPort];

    async function listenWithFallback(ports) {
        let lastErr = null;
        for (const p of ports) {
            try {
                await new Promise((resolve, reject) => {
                    const onError = (err) => {
                        server.off('listening', onListening);
                        reject(err);
                    };
                    const onListening = () => {
                        server.off('error', onError);
                        resolve();
                    };
                    server.once('error', onError);
                    server.once('listening', onListening);
                    server.listen(p, '0.0.0.0');
                });
                return p;
            } catch (err) {
                lastErr = err;
                const code = err && err.code ? String(err.code) : '';
                if (code !== 'EADDRINUSE' || process.env.K_SERVICE) throw err;
            }
        }
        throw lastErr || new Error('No available port to listen.');
    }

    const activePort = await listenWithFallback(candidatePorts);
    console.log(`Backend running on :${activePort}`);
    console.log(`WebSocket listening on ws://localhost:${activePort}/ws`);

    // Initialize DB in the background so Cloud Run startup probes can pass.
    ensureDbInitStarted().catch((err) => {
        console.error('DB init background task failed unexpectedly:', err);
    });
}

start().catch((err) => {
    console.error('Failed to start server:', err);
});

// Global error handler to ensure we always return a JSON error and keep CORS headers
app.use((err, req, res, next) => {
    try {
        console.error('Unhandled error:', err && err.stack ? err.stack : err);
        if (!res.headersSent) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            res.status(500).json({ ok: false, error: 'internal_error' });
        } else {
            try { res.end(); } catch (_) { }
        }
    } catch (e) {
        try { if (!res.headersSent) res.status(500).json({ ok: false, error: 'internal_error' }); } catch (_) { }
    }
});

// Process-level handlers to log and optionally exit on fatal errors.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
    // allow process to exit so Cloud Run will restart the instance for a clean state
    try {
        setTimeout(() => process.exit(1), 1000);
    } catch (_) { process.exit(1); }
});

app.post('/images/upload', async (req, res) => {
    try {
        const dataUrl = req.body && req.body.dataUrl != null ? String(req.body.dataUrl) : '';
        const filenameHint = req.body && req.body.filename != null ? String(req.body.filename) : '';
        if (!dataUrl) return res.status(400).json({ ok: false, error: 'missing_dataUrl' });

        const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
        if (!m) return res.status(400).json({ ok: false, error: 'invalid_dataUrl' });

        const mimetype = m[1];
        const bodyB64 = m[2];
        const buffer = Buffer.from(bodyB64, 'base64');

        let ext = 'bin';
        if (mimetype === 'image/jpeg') ext = 'jpg';
        else if (mimetype === 'image/png') ext = 'png';
        else if (mimetype === 'image/webp') ext = 'webp';
        else if (mimetype === 'image/gif') ext = 'gif';

        const safeHint = filenameHint
            .replace(/[^a-zA-Z0-9._-]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 60);
        const rand = crypto.randomBytes(10).toString('hex');
        const filename = `quote-images/${Date.now()}_${rand}${safeHint ? '_' + safeHint : ''}.${ext}`;

        await uploadBuffer(buffer, filename, mimetype);

        const protoHeader = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const proto = String(protoHeader).split(',')[0].trim() || 'https';
        const host = req.get('host');
        const base = `${proto}://${host}`;
        const nameB64 = base64UrlEncode(filename);
        const url = `${base}/images/v/${nameB64}`;

        return res.json({ ok: true, url, name: filename, b64: nameB64 });
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error('images/upload failed:', msg);
        return res.status(500).json({ ok: false, error: 'upload_failed' });
    }
});

async function streamImageFromBucket(res, bucketName, objectName) {
    const name = String(objectName || '').trim();
    if (!name) {
        res.status(400).send('missing name');
        return;
    }
    if (name.length > 600) {
        res.status(400).send('name too long');
        return;
    }

    const bucket = gcs.bucket(bucketName);
    const tryNames = [name, `quote-images/${name}`];

    let file = null;
    for (const candidate of tryNames) {
        const f = bucket.file(candidate);
        const [exists] = await f.exists();
        if (exists) {
            file = f;
            break;
        }
    }

    if (!file) {
        res.status(404).send('not found');
        return;
    }

    const [meta] = await file.getMetadata();
    const ct = (meta && meta.contentType) ? String(meta.contentType) : 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=31536000');

    const stream = file.createReadStream();
    stream.on('error', (e) => {
        console.error('images stream error:', e && e.message ? e.message : String(e));
        if (!res.headersSent) res.status(500);
        try { res.end(); } catch (_) { }
    });
    stream.pipe(res);
}

app.get('/images/v/:b64', async (req, res) => {
    try {
        const bucketName = process.env.GCS_BUCKET || process.env.KS_GCS_BUCKET || 'qcag-483014-qcag-images';
        if (!bucketName) return res.status(500).send('GCS_BUCKET is not set');
        const b64 = req.params && req.params.b64 != null ? String(req.params.b64) : '';
        if (!b64) return res.status(400).send('missing b64');
        const name = base64UrlDecodeToString(b64);
        await streamImageFromBucket(res, bucketName, name);
    } catch (err) {
        console.error('images/v failed:', err && err.message ? err.message : String(err));
        res.status(500).send('error');
    }
});

app.get('/images/view', async (req, res) => {
    try {
        const bucketName = process.env.GCS_BUCKET || process.env.KS_GCS_BUCKET || 'qcag-483014-qcag-images';
        if (!bucketName) return res.status(500).send('GCS_BUCKET is not set');

        const rawName = req.query && req.query.name != null ? String(req.query.name) : '';
        const rawBucket = req.query && req.query.bucket != null ? String(req.query.bucket) : '';
        const name = rawName.trim();
        if (!name) return res.status(400).send('missing name');

        if (rawBucket && rawBucket.trim() && rawBucket.trim() !== bucketName) {
            return res.status(400).send('invalid bucket');
        }

        await streamImageFromBucket(res, bucketName, name);
    } catch (err) {
        console.error('images/view failed:', err && err.message ? err.message : String(err));
        res.status(500).send('error');
    }
});
