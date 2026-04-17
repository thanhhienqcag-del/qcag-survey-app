// In Cloud Run, prefer service environment variables / secrets.
// Avoid loading a bundled .env file that could override/mask production config.
if (!process.env.K_SERVICE) {
    require('dotenv').config();
}

if (!process.env.TZ) {
    process.env.TZ = 'Asia/Ho_Chi_Minh';
}

const express = require('express');
const http = require('http');
const cors = require('cors');
const mysql = require('./lib/mysql-compat');
const crypto = require('crypto');
const { Storage } = require('@google-cloud/storage');
const { uploadBuffer } = require('./storage');

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
    } catch (_) {}
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
    } catch (_) {}
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
            } catch (_) {}
        });
    } catch (_) {}
}

// ── In-memory cache for GET /api/ks/requests ──────────────────────────────────
// Eliminates repetitive Neon queries: cache is populated on first GET after any
// write, and served from RAM for all subsequent GETs until the next write.
let _ksRequestsCache = null; // { rows: Array, etag: string } | null
function ksInvalidateCache() { _ksRequestsCache = null; }
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
            try { onFrame({ opcode, payload }); } catch (_) {}
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
            } catch (_) {}
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
            } catch (_) {}
        });

        socket.on('close', () => {
            wsClients.delete(socket);
        });
        socket.on('error', () => {
            wsClients.delete(socket);
        });
    } catch (e) {
        try { socket.destroy(); } catch (_) {}
    }
});

startWsHeartbeat();

app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '50mb' }));

// Ensure minimal CORS headers are always present (even on errors)
app.use((req, res, next) => {
    try {
        if (!res.getHeader('Access-Control-Allow-Origin')) res.setHeader('Access-Control-Allow-Origin', '*');
        if (!res.getHeader('Access-Control-Allow-Methods')) res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        if (!res.getHeader('Access-Control-Allow-Headers')) res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (String(req.method || '').toUpperCase() === 'OPTIONS') return res.status(200).end();
    } catch (e) {}
    return next();
});

// Basic in-memory rate limiter (per-IP, per-instance). Tunable via RATE_LIMIT_MAX and RATE_LIMIT_WINDOW_MS.
const _rateMap = new Map();
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 120;
app.use((req, res, next) => {
    try {
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
    } catch (e) {}
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
            try { clearInterval(pingTimer); } catch (_) {}
            sseClients.delete(res);
        });
    } catch (e) {
        try { res.end(); } catch (_) {}
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
    return async function(req, res, next) {
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
        // 42701 = duplicate_column (PostgreSQL)
        if (err && err.code !== '42701') throw err;
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
    CREATE TABLE IF NOT EXISTS production_orders (
      id SERIAL PRIMARY KEY,
      items TEXT,
      quote_keys TEXT,
      spo_number VARCHAR(64),
      order_number VARCHAR(64),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ
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
            `INSERT INTO users (username, name, password_hash, role, approved, updated_at)
             VALUES (?, ?, ?, 'admin', 1, ?)`, ['adminqcag', 'Admin', createPasswordHash('admin123'), new Date()]
        );
    }

    // Keep forward-compatible: if an existing DB has an older quotations table, add missing columns.
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS outlet_code VARCHAR(64)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS outlet_name VARCHAR(255)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS spo_name VARCHAR(255)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS area VARCHAR(64)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS outlet_phone VARCHAR(64)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS sale_type VARCHAR(64)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS sale_code VARCHAR(64)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS sale_name VARCHAR(255)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS sale_phone VARCHAR(64)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS ss_name VARCHAR(255)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS house_number VARCHAR(64)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS street VARCHAR(255)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS ward VARCHAR(255)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS district VARCHAR(255)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS province VARCHAR(255)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS address TEXT`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS items TEXT`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS images TEXT`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS total_amount DECIMAL(15,2)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS spo_number VARCHAR(64)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS spo_status VARCHAR(255)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS notes TEXT`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS qcag_status VARCHAR(64)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS qcag_order_number VARCHAR(64)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS order_number VARCHAR(64)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS qcag_image_url TEXT`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS qcag_override_status VARCHAR(30)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS qcag_note TEXT`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS qcag_at TIMESTAMPTZ`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);

    // Production order extra fields.
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS due_date TEXT`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS responsibles TEXT`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS is_confirmed SMALLINT NOT NULL DEFAULT 0`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS last_confirmed_at TEXT`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS edit_history TEXT`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS is_exported SMALLINT NOT NULL DEFAULT 0`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS exported_at TEXT`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS created_by VARCHAR(64)`);
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(255)`);

    // QC signage modal state (stored as JSON string).
    await ensureColumn(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS qc_signage_state TEXT`);

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

// ======================== KS MOBILE DB INIT ========================
async function initKsDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ks_requests (
          id SERIAL PRIMARY KEY,
          backend_id VARCHAR(128),
          type VARCHAR(16) NOT NULL DEFAULT 'new',
          outlet_code VARCHAR(16),
          outlet_name TEXT,
          address TEXT,
          outlet_lat VARCHAR(32),
          outlet_lng VARCHAR(32),
          phone VARCHAR(32),
          items TEXT,
          content TEXT,
          old_content SMALLINT NOT NULL DEFAULT 0,
          old_content_extra TEXT,
          status_images TEXT,
          design_images TEXT,
          acceptance_images TEXT,
          comments TEXT,
          requester TEXT,
          status VARCHAR(32) NOT NULL DEFAULT 'pending',
          editing_requested_at TIMESTAMPTZ,
          mq_folder VARCHAR(128),
          design_created_by VARCHAR(255),
          design_created_at TIMESTAMPTZ,
          design_last_edited_by VARCHAR(255),
          design_last_edited_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ks_users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(64) NOT NULL,
          name VARCHAR(255),
          password_hash VARCHAR(255) NOT NULL,
          role VARCHAR(16) NOT NULL DEFAULT 'qcag',
          approved SMALLINT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ,
          UNIQUE (username)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ks_settings (
          setting_key VARCHAR(128) NOT NULL PRIMARY KEY,
          setting_value TEXT,
          updated_at TIMESTAMPTZ
        )
    `);

    // Default QCAG password
    await pool.query(`
        INSERT INTO ks_settings (setting_key, setting_value, updated_at)
        VALUES ('qcag_password', 'qcag123', NOW())
        ON CONFLICT (setting_key) DO NOTHING
    `);

    // Push subscriptions table
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

    // Forward-compatible column additions
    const ksCols = [
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS backend_id VARCHAR(128)',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS outlet_lat VARCHAR(32)',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS outlet_lng VARCHAR(32)',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS old_content SMALLINT NOT NULL DEFAULT 0',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS old_content_extra TEXT',
        'ALTER TABLE ks_requests DROP COLUMN IF EXISTS old_content_images',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS design_images TEXT',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS acceptance_images TEXT',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS comments TEXT',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS requester TEXT',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS editing_requested_at TIMESTAMPTZ',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS mq_folder VARCHAR(128)',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS design_created_by VARCHAR(255)',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS design_created_at TIMESTAMPTZ',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS design_last_edited_by VARCHAR(255)',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS design_last_edited_at TIMESTAMPTZ',
        'ALTER TABLE ks_requests ADD COLUMN IF NOT EXISTS tk_code VARCHAR(16)',
        // push_subscriptions: add sale_code for reliable per-user targeting
        'ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS sale_code VARCHAR(64)',
    ]
    for (const sql of ksCols) await ensureColumn(sql);
}
// ======================== END KS MOBILE DB INIT ========================

// ── Push notification helper ──────────────────────────────────────────
async function sendKsPush({ title, body, data = {}, targetPhone = null, targetSaleCode = null, targetRole = null }) {
    const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
    const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
    const VAPID_SUBJECT = process.env.VAPID_SUBJECT     || 'mailto:admin@qcag.vn';
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
        console.warn('[push] sendKsPush skipped: VAPID keys not configured');
        return;
    }
    // Normalize phone: strip spaces/dashes, convert +84 → 0
    if (targetPhone) {
        targetPhone = String(targetPhone).replace(/[\s\-\.]+/g, '');
        if (targetPhone.startsWith('+84')) targetPhone = '0' + targetPhone.slice(3);
        else if (targetPhone.startsWith('84') && targetPhone.length >= 10) targetPhone = '0' + targetPhone.slice(2);
    }
    const webpush = require('web-push');
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    try {
        let rows;
        // TARGETING STRATEGY (priority: phone > saleCode > role > broadcast)
        // Phone-based lookup is more reliable because QCAG staff confirmed it works.
        if (targetPhone) {
            [rows] = await pool.query('SELECT id, subscription FROM push_subscriptions WHERE phone = ?', [targetPhone]);
            // Fallback to sale_code if phone lookup returns nothing
            if ((!rows || rows.length === 0) && targetSaleCode) {
                const sc = String(targetSaleCode).trim();
                [rows] = await pool.query('SELECT id, subscription FROM push_subscriptions WHERE sale_code = ?', [sc]);
            }
        } else if (targetSaleCode) {
            const sc = String(targetSaleCode).trim();
            [rows] = await pool.query('SELECT id, subscription FROM push_subscriptions WHERE sale_code = ?', [sc]);
        } else if (targetRole) {
            [rows] = await pool.query('SELECT id, subscription FROM push_subscriptions WHERE role = ?', [String(targetRole)]);
        } else {
            [rows] = await pool.query('SELECT id, subscription FROM push_subscriptions', []);
        }
        if (!rows || rows.length === 0) {
            console.warn('[push] sendKsPush: no subscriptions found for saleCode:', targetSaleCode, 'phone:', targetPhone, 'role:', targetRole);
            return;
        }
        console.log('[push] sendKsPush: sending to', rows.length, 'subscription(s), saleCode:', targetSaleCode, 'phone:', targetPhone, 'role:', targetRole);
        const payload = JSON.stringify({ title, body, data });
        // TTL = 86400s (24h): push is queued if device offline, not dropped
        const pushOptions = { TTL: 86400 };
        const results = await Promise.allSettled(rows.map(r => {
            try {
                const sub = JSON.parse(r.subscription);
                return webpush.sendNotification(sub, payload, pushOptions).catch(async (err) => {
                    // 410 Gone or 404 = subscription expired/unregistered — remove from DB
                    if (err && (err.statusCode === 410 || err.statusCode === 404)) {
                        try {
                            await pool.query('DELETE FROM push_subscriptions WHERE id = ?', [r.id]);
                            console.log('[push] removed expired subscription id:', r.id);
                        } catch (_) {}
                    } else {
                        console.warn('[push] sendNotification error:', err && err.statusCode, err && err.body);
                    }
                    throw err;
                });
            } catch (e) { return Promise.resolve(); }
        }));
        const sent = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;
        console.log('[push] sendKsPush result: sent:', sent, 'failed:', failed, 'total:', rows.length);
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
        let { subscription, phone, role, saleCode } = req.body || {};
        if (!subscription) return res.status(400).json({ ok: false, error: 'missing_subscription' });
        // Normalize phone: strip spaces/dashes, convert +84 → 0
        if (phone) {
            phone = String(phone).replace(/[\s\-\.]+/g, '');
            if (phone.startsWith('+84')) phone = '0' + phone.slice(3);
            else if (phone.startsWith('84') && phone.length >= 10) phone = '0' + phone.slice(2);
        }
        const subStr = typeof subscription === 'string' ? subscription : JSON.stringify(subscription);
        const subObj = typeof subscription === 'object' ? subscription : JSON.parse(subStr);
        const endpoint = String(subObj.endpoint || '');
        if (!endpoint) return res.status(400).json({ ok: false, error: 'invalid_subscription' });
        const sc = saleCode ? String(saleCode).trim() : null;
        const endpointSuffix = endpoint.slice(-40);
        const [existing] = await pool.query('SELECT id FROM push_subscriptions WHERE subscription LIKE ?', ['%' + endpointSuffix + '%']);
        if (existing && existing.length > 0) {
            await pool.query(
                'UPDATE push_subscriptions SET subscription = ?, phone = ?, role = ?, sale_code = ?, updated_at = NOW() WHERE id = ?',
                [subStr, phone || null, role || null, sc, existing[0].id]
            );
        } else {
            await pool.query(
                'INSERT INTO push_subscriptions (subscription, phone, role, sale_code, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
                [subStr, phone || null, role || null, sc]
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
            dbReady = true;
            dbLastError = null;
            dbLastOkAt = Date.now();
            console.log('DB init OK');
            startDbKeepAlive();
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
    if (_keepAliveTimer) return; // already running
    const INTERVAL_MS = 4 * 60 * 1000; // 4 minutes
    _keepAliveTimer = setInterval(async () => {
        try {
            await pool.query('SELECT 1');
            dbReady = true;
            dbLastOkAt = Date.now();
            dbLastError = null;
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            console.warn('[db-keepalive] ping failed:', msg);
            dbReady = false;
            dbLastError = msg;
            // Re-init pool on next request via ensureDbInitStarted
            dbInitPromise = null;
        }
    }, INTERVAL_MS);
    // Allow Node process to exit even if this timer is running
    if (_keepAliveTimer.unref) _keepAliveTimer.unref();
    console.log('[db-keepalive] started (interval: 4 min)');
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
].join(', ');

app.get('/db-health', async(req, res) => {
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

app.post('/auth/register', async(req, res) => {
    await ensureDbInitStarted();
    const phone = req.body && req.body.phone != null ? String(req.body.phone).trim() : '';
    const name = req.body && req.body.name != null ? String(req.body.name).trim() : '';
    if (!isValidPhone(phone)) return res.status(400).json({ ok: false, error: 'invalid_phone' });
    if (!name) return res.status(400).json({ ok: false, error: 'missing_name' });

    const [
        [existing]
    ] = await pool.query('SELECT id, approved FROM users WHERE username = ? LIMIT 1', [phone]);
    if (existing && existing.id) {
        if (Number(existing.approved) === 0) return res.status(409).json({ ok: false, error: 'already_pending' });
        return res.status(409).json({ ok: false, error: 'already_exists' });
    }

    await pool.query(
        `INSERT INTO users (username, name, password_hash, role, approved, updated_at)
     VALUES (?, ?, ?, 'user', 0, ?)`, [phone, name, createPasswordHash('123456'), new Date()]
    );

    res.json({ ok: true });
});

app.post('/auth/login', async(req, res) => {
    await ensureDbInitStarted();
    const username = req.body && req.body.username != null ? String(req.body.username).trim() : '';
    const password = req.body && req.body.password != null ? String(req.body.password) : '';

    if (!isValidUsername(username)) {
        return res.status(400).json({ ok: false, error: 'invalid_username' });
    }

    const [
        [user]
    ] = await pool.query(
        'SELECT id, username, name, password_hash, role, approved FROM users WHERE username = ? LIMIT 1', [username]
    );

    if (!user || !user.id) {
        return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    if (String(user.role) !== 'admin' && Number(user.approved) === 0) {
        return res.status(403).json({ ok: false, error: 'pending_approval' });
    }

    if (!verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    const token = signToken({
            sub: user.id,
            username: user.username,
            name: user.name || null,
            role: user.role,
        },
        60 * 60 * 24 * 7 // 7 days
    );

    res.json({
        ok: true,
        token,
        user: {
            username: user.username,
            name: user.name || null,
            role: user.role,
        },
    });
});

app.get('/auth/me', requireAuth(), async(req, res) => {
    res.json({ ok: true, user: { username: req.user.username, name: req.user.name, role: req.user.role } });
});

app.post('/auth/logout', async(req, res) => {
    // Stateless token: client deletes token. Keep endpoint for UX parity.
    res.json({ ok: true });
});

app.get('/auth/admin/pending', requireAuth('admin'), async(req, res) => {
    await ensureDbInitStarted();
    const [rows] = await pool.query(
        `SELECT username, name
     FROM users
     WHERE role = 'user' AND approved = 0
     ORDER BY created_at ASC`
    );
    res.json({ ok: true, pending: rows || [] });
});

app.post('/auth/admin/approve', requireAuth('admin'), async(req, res) => {
    await ensureDbInitStarted();
    const username = req.body && (req.body.username != null || req.body.phone != null) ?
        String(req.body.username != null ? req.body.username : req.body.phone).trim() :
        '';
    if (!isValidPhone(username)) return res.status(400).json({ ok: false, error: 'invalid_phone' });
    await pool.query('UPDATE users SET approved = 1, updated_at = ? WHERE username = ? AND role = \'user\'', [new Date(), username]);
    res.json({ ok: true });
});

app.get('/auth/admin/users', requireAuth('admin'), async(req, res) => {
    await ensureDbInitStarted();
    const [rows] = await pool.query(
        `SELECT username, name, role, approved, created_at
         FROM users
         ORDER BY role DESC, created_at ASC`
    );

    const users = (rows || []).map((u) => ({
        username: u.username,
        name: u.name,
        role: u.role,
        approved: Number(u.approved) === 1,
        created_at: u.created_at,
    }));

    res.json({ ok: true, users });
});

// ============ PUBLIC: Get approved users (for dropdown selection) ============
// No auth required - returns only username + name for approved users
app.get('/users/approved', async(req, res) => {
    try {
        await ensureDbInitStarted();
        const [rows] = await pool.query(
            `SELECT username, name
             FROM users
             WHERE approved = 1
             ORDER BY role DESC, name ASC`
        );

        const users = (rows || []).map((u) => ({
            username: u.username,
            name: u.name || u.username,
        }));

        res.json({ ok: true, users });
    } catch (err) {
        console.error('[GET /users/approved] Error:', err);
        res.status(500).json({ ok: false, error: 'db_error' });
    }
});

app.post('/auth/admin/update', requireAuth('admin'), async(req, res) => {
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

app.post('/auth/admin/delete', requireAuth('admin'), async(req, res) => {
    await ensureDbInitStarted();
    const username = req.body && (req.body.username != null || req.body.phone != null) ?
        String(req.body.username != null ? req.body.username : req.body.phone).trim() :
        '';
    if (!isValidPhone(username)) return res.status(400).json({ ok: false, error: 'invalid_phone' });

    await pool.query('DELETE FROM users WHERE username = ? AND role = \'user\'', [username]);
    res.json({ ok: true });
});

app.post('/auth/admin/change-password', requireAuth('admin'), async(req, res) => {
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

app.get('/quotations', async(req, res) => {
    try {
        await ensureDbInitStarted();
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

app.post('/quotations', async(req, res) => {
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
            } catch (_) {}
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

app.patch('/quotations/:id', async(req, res) => {
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

app.put('/quotations/:id', async(req, res) => {
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

app.delete('/quotations/:id', async(req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });
    const [result] = await pool.query('DELETE FROM quotations WHERE id = ?', [id]);
    res.json({ ok: true, deleted: result.affectedRows || 0 });
    wsInvalidate('quotations', { action: 'delete', id });
});

// Admin-only: force-set created_by / created_by_name for a specific quote (data correction)
app.patch('/admin/quotations/:id/set-creator', requireAuth('admin'), async(req, res) => {
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
    } catch (_) {}
    res.json({ ok: true });
});

app.get('/production-orders', async(req, res) => {
    const [rows] = await pool.query(`
    SELECT *
    FROM production_orders
    ORDER BY created_at DESC
  `);
    res.json(rows);
});

app.post('/production-orders', async(req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const items = normalizeBodyValue(b.items);
    const quoteKeys = normalizeBodyValue(b.quote_keys);
        const now = new Date();

    await pool.query(
        `
            INSERT INTO production_orders (items, quote_keys, spo_number, order_number, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
            items,
            quoteKeys,
            toNullableString(b.spo_number),
            toNullableString(b.order_number),
            normalizeBodyValue(b.notes),
                        now,
                        now,
        ]
    );
    
    // Delete all pending orders after creating production order
    try {
        await pool.query('DELETE FROM pending_orders');
        wsInvalidate('pending_orders', { action: 'clear' });
    } catch (err) {
        console.error('Error clearing pending orders:', err);
    }
    
    res.json({ ok: true });
    wsInvalidate('production-orders', { action: 'create' });
});

app.post('/qcag/submit', async(req, res) => {
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

app.post('/inspections', async(req, res) => {
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

// ========== PENDING ORDERS API ==========

// GET /pending-orders - Lấy tất cả pending orders
app.get('/pending-orders', async (req, res) => {
    try {
        await ensureDbInitStarted();
        const [rows] = await pool.query(
            `SELECT id, created_by, created_by_name, created_at, quotes, total_points, total_amount, updated_at
             FROM pending_orders
             ORDER BY created_at DESC`
        );
        
        // Parse quotes JSON for each row
        const orders = (rows || []).map(row => {
            let quotes = [];
            try {
                quotes = JSON.parse(row.quotes || '[]');
            } catch (e) {
                quotes = [];
            }
            return {
                id: row.id,
                createdBy: row.created_by || row.created_by_name || 'User',
                createdAt: Number(row.created_at) || Date.now(),
                quotes: quotes,
                totalPoints: Number(row.total_points) || 0,
                totalAmount: Number(row.total_amount) || 0
            };
        });
        
        res.json({ ok: true, data: orders });
    } catch (err) {
        console.error('GET /pending-orders error:', err && err.message ? err.message : err);
        res.status(500).json({ ok: false, error: 'db_error' });
    }
});

// POST /pending-orders - Tạo hoặc cập nhật pending order
app.post('/pending-orders', async (req, res) => {
    try {
        await ensureDbInitStarted();
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        
        const id = b.id ? String(b.id).trim() : ('pending_' + Date.now());
        const createdBy = b.createdBy ? String(b.createdBy).trim() : 'User';
        const createdAt = b.createdAt ? Number(b.createdAt) : Date.now();
        const quotes = Array.isArray(b.quotes) ? b.quotes : [];
        const totalPoints = Number(b.totalPoints) || quotes.length || 0;
        const totalAmount = Number(b.totalAmount) || 0;
        const quotesJson = JSON.stringify(quotes);
        
        // Upsert: INSERT ... ON CONFLICT DO UPDATE
        await pool.query(
            `INSERT INTO pending_orders (id, created_by, created_by_name, created_at, quotes, total_points, total_amount, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
             ON CONFLICT (id) DO UPDATE SET
                quotes = EXCLUDED.quotes,
                total_points = EXCLUDED.total_points,
                total_amount = EXCLUDED.total_amount,
                updated_at = NOW()`,
            [id, createdBy, createdBy, createdAt, quotesJson, totalPoints, totalAmount]
        );
        
        // Notify other clients via WebSocket/SSE
        wsInvalidate('pending_orders', { action: 'upsert', id });
        
        res.json({ ok: true, id });
    } catch (err) {
        console.error('POST /pending-orders error:', err && err.message ? err.message : err);
        res.status(500).json({ ok: false, error: 'db_error' });
    }
});

// DELETE /pending-orders/:id - Xóa một pending order
app.delete('/pending-orders/:id', async (req, res) => {
    try {
        await ensureDbInitStarted();
        const id = req.params.id ? String(req.params.id).trim() : '';
        
        if (!id) {
            return res.status(400).json({ ok: false, error: 'missing_id' });
        }
        
        // Get the order first to return its quotes
        const [[existing]] = await pool.query(
            'SELECT quotes FROM pending_orders WHERE id = ? LIMIT 1',
            [id]
        );
        
        let quotes = [];
        if (existing && existing.quotes) {
            try {
                quotes = JSON.parse(existing.quotes || '[]');
            } catch (e) {
                quotes = [];
            }
        }
        
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
        
        // Get all orders first to return their quotes
        const [rows] = await pool.query('SELECT quotes FROM pending_orders');
        
        let allQuotes = [];
        (rows || []).forEach(row => {
            try {
                const quotes = JSON.parse(row.quotes || '[]');
                if (Array.isArray(quotes)) {
                    allQuotes = allQuotes.concat(quotes);
                }
            } catch (e) {}
        });
        
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
app.post('/api/admin/mojibake/recover', async(req, res) => {
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
                                        UPDATE quotations SET created_by_name = u.name
                                        FROM users u
                                        WHERE u.username = quotations.created_by
                                            AND u.name IS NOT NULL
                                            AND TRIM(u.name) <> ''
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
            } catch (_) {}

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

// Helper: convert a DB row → camelCase app object
function ksRowToApp(row) {
    if (!row) return null;
    return {
        __backendId: row.backend_id || ('db_' + row.id),
        id:                  row.id,
        type:                row.type || 'new',
        outletCode:          row.outlet_code || '',
        outletName:          row.outlet_name || '',
        address:             row.address || '',
        outletLat:           row.outlet_lat || '',
        outletLng:           row.outlet_lng || '',
        phone:               row.phone || '',
        items:               row.items || '[]',
        content:             row.content || '',
        oldContent:          Boolean(row.old_content),
        oldContentExtra:     row.old_content_extra || '',
        statusImages:        row.status_images || '[]',
        designImages:        row.design_images || '[]',
        acceptanceImages:    row.acceptance_images || '[]',
        comments:            row.comments || '[]',
        requester:           row.requester || '{}',
        status:              row.status || 'pending',
        editingRequestedAt:  row.editing_requested_at ? new Date(row.editing_requested_at).toISOString() : null,
        tkCode:              row.tk_code || null,
        mqFolder:            row.mq_folder || null,
        designCreatedBy:     row.design_created_by  || null,
        designCreatedAt:     row.design_created_at  ? new Date(row.design_created_at).toISOString()  : null,
        designLastEditedBy:  row.design_last_edited_by  || null,
        designLastEditedAt:  row.design_last_edited_at  ? new Date(row.design_last_edited_at).toISOString()  : null,
        createdAt:           row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt:           row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
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

// GET /api/ks/health
app.get('/api/ks/health', (req, res) => {
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
    return res.json({ ok: true, service: 'ks-mobile', ts: Date.now(), ...snapshot });
});

// GET /api/ks/requests
// NOTE: excludes large image columns to avoid response size limits.
// Uses in-memory cache + ETag to avoid hitting Neon on every client refresh.
app.get('/api/ks/requests', async (req, res) => {
    try {
        // Serve from cache if available
        if (_ksRequestsCache) {
            const clientEtag = req.headers['if-none-match'];
            res.setHeader('ETag', _ksRequestsCache.etag);
            res.setHeader('Cache-Control', 'no-cache');
            if (clientEtag && clientEtag === _ksRequestsCache.etag) {
                return res.status(304).end();
            }
            return res.json({ ok: true, data: _ksRequestsCache.rows });
        }
        // Cache miss: query Neon once, cache result
        // NOTE: we exclude the full contents of large image columns but we return
        // a placeholder array if they contain data so the client UI knows they exist.
        const [rows] = await pool.query(`
            SELECT id, backend_id, type, outlet_code, outlet_name, address,
                   outlet_lat, outlet_lng, phone, items, content,
                   old_content, old_content_extra, status, requester, comments,
                   editing_requested_at, mq_folder, created_at, updated_at,
                   design_created_by, design_created_at, design_last_edited_by, design_last_edited_at,
                   CASE WHEN design_images IS NOT NULL AND length(design_images) > 4 AND design_images != '[]' THEN '["..."]' ELSE '[]' END as design_images,
                   CASE WHEN status_images IS NOT NULL AND length(status_images) > 4 AND status_images != '[]' THEN '["..."]' ELSE '[]' END as status_images,
                   CASE WHEN acceptance_images IS NOT NULL AND length(acceptance_images) > 4 AND acceptance_images != '[]' THEN '["..."]' ELSE '[]' END as acceptance_images
            FROM ks_requests ORDER BY created_at DESC
        `);
        const mapped = rows.map(ksRowToApp);
        const etag = '"' + crypto.createHash('md5').update(JSON.stringify(mapped)).digest('hex') + '"';
        _ksRequestsCache = { rows: mapped, etag };
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'no-cache');
        return res.json({ ok: true, data: mapped });
    } catch (err) {
        console.error('GET /api/ks/requests error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'fetch_failed' });
    }
});

// GET /api/ks/requests/:id  (by numeric id OR backend_id string)
app.get('/api/ks/requests/:id', async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        let rows;
        const dbPrefixMatch = id.match(/^db_(\d+)$/);
        if (/^\d+$/.test(id)) {
            [rows] = await pool.query('SELECT * FROM ks_requests WHERE id = ? LIMIT 1', [Number(id)]);
        } else if (dbPrefixMatch) {
            [rows] = await pool.query('SELECT * FROM ks_requests WHERE id = ? LIMIT 1', [Number(dbPrefixMatch[1])]);
        } else {
            [rows] = await pool.query('SELECT * FROM ks_requests WHERE backend_id = ? LIMIT 1', [id]);
        }
        if (!rows || rows.length === 0) return res.status(404).json({ ok: false, error: 'not_found' });
        return res.json({ ok: true, data: ksRowToApp(rows[0]) });
    } catch (err) {
        console.error('GET /api/ks/requests/:id error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'fetch_failed' });
    }
});

// POST /api/ks/requests
app.post('/api/ks/requests', async (req, res) => {
    try {
        const b = req.body || {};
        const now = new Date();
        const backendId = toNullableString(b.__backendId) || toNullableString(b.backendId) ||
            ('srv_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'));
        // mq_folder: use provided value (from pre-generated ID) or generate new safe folder name
        const mqFolder = toNullableString(b.mqFolder) || ksSafeMqFolder(toNullableString(b.outletCode) || '');
        const createdAtTs = b.createdAt ? new Date(b.createdAt) : now;

        // Step 1: INSERT with empty image arrays (avoid storing base64 in Neon)
        const [result] = await pool.query(`
            INSERT INTO ks_requests
              (backend_id, type, outlet_code, outlet_name, address, outlet_lat, outlet_lng, phone,
               items, content, old_content, old_content_extra,
               status_images, design_images, acceptance_images, comments, requester,
               status, editing_requested_at, mq_folder, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            RETURNING id
        `, [
            backendId,
            toNullableString(b.type) || 'new',
            toNullableString(b.outletCode),
            toNullableString(b.outletName),
            toNullableString(b.address),
            toNullableString(b.outletLat),
            toNullableString(b.outletLng),
            toNullableString(b.phone),
            normalizeBodyValue(b.items) || '[]',
            toNullableString(b.content),
            b.oldContent ? 1 : 0,
            toNullableString(b.oldContentExtra),
            '[]',
            '[]',
            '[]',
            normalizeBodyValue(b.comments) || '[]',
            normalizeBodyValue(b.requester) || '{}',
            toNullableString(b.status) || 'pending',
            b.editingRequestedAt ? new Date(b.editingRequestedAt) : null,
            mqFolder,
            createdAtTs,
            now,
        ]);
        const insertId = result.insertId;

        // Step 2: Compute TK code (e.g. TK26.00001) for GCS folder naming
        const year = String(createdAtTs.getFullYear());
        const yy = year.slice(-2);
        let tkCode = backendId; // fallback
        try {
            const [[cntRow]] = await pool.query(
                `SELECT COUNT(*) AS cnt FROM ks_requests WHERE EXTRACT(YEAR FROM created_at) = ? AND id <= ?`,
                [year, insertId]
            );
            const seq = String(Number((cntRow && cntRow.cnt) || 1)).padStart(5, '0');
            tkCode = `TK${yy}.${seq}`;
        } catch (tkErr) {
            console.warn('[ks/create] tk_code compute failed (non-fatal):', tkErr && tkErr.message ? tkErr.message : tkErr);
        }

        // Step 3: Fire wsInvalidate + push IMMEDIATELY (before slow image upload)
        // so QCAG gets notified within seconds of the request being created.
        // A second wsInvalidate fires after images are uploaded with the final state.
        try {
            const [[earlyRow]] = await pool.query('SELECT * FROM ks_requests WHERE id = ? LIMIT 1', [insertId]);
            wsInvalidate('ks_requests', { action: 'create', id: tkCode, data: ksRowToApp(earlyRow) });
            // Non-blocking push — do NOT await; image upload must not delay the notification
            const reqObj = (() => { try { return JSON.parse(earlyRow.requester || '{}'); } catch (_) { return {}; } })();
            const senderName = reqObj.saleName || reqObj.phone || 'Sale Heineken';
            const outletLabel = earlyRow.outlet_name || earlyRow.outlet_code || 'Outlet';
            sendKsPush({
                title: 'QCAG — Yêu cầu mới từ Heineken',
                body: `${senderName} vừa gửi yêu cầu mới cho Outlet ${outletLabel}.`,
                data: { backendId: earlyRow.backend_id },
                targetPhone: null,
                targetSaleCode: null,
                targetRole: 'qcag',
            }).catch(e => console.warn('[push] new-request notify error (non-fatal):', e && e.message ? e.message : e));
        } catch (earlyNotifyErr) {
            console.warn('[ks/create] early notify error (non-fatal):', earlyNotifyErr && earlyNotifyErr.message ? earlyNotifyErr.message : earlyNotifyErr);
        }

        // Step 4: Upload any base64 images to GCS in PARALLEL.
        // Frontend now sends compressed base64 images directly in the POST body
        // so they are uploaded atomically with request creation (no background PATCH).
        const [statusImgsJson, designImgsJson, acceptanceImgsJson] = await Promise.all([
            ksAutoUploadImages(normalizeBodyValue(b.statusImages)     || '[]', tkCode, 'hien-trang'),
            ksAutoUploadImages(normalizeBodyValue(b.designImages)     || '[]', tkCode, 'mq'),
            ksAutoUploadImages(normalizeBodyValue(b.acceptanceImages) || '[]', tkCode, 'mq'),
        ]);

        // Step 5: Update row with GCS URLs + tk_code, then notify clients of final state
        await pool.query(
            `UPDATE ks_requests SET tk_code=?, status_images=?, design_images=?, acceptance_images=?, updated_at=? WHERE id=?`,
            [tkCode, statusImgsJson, designImgsJson, acceptanceImgsJson, now, insertId]
        );

        const [[row]] = await pool.query('SELECT * FROM ks_requests WHERE id = ? LIMIT 1', [insertId]);
        // Second invalidate: push final row (with uploaded image URLs) to all clients
        wsInvalidate('ks_requests', { action: 'update', id: row.backend_id, data: ksRowToApp(row) });

        return res.status(201).json({ ok: true, data: ksRowToApp(row) });
    } catch (err) {
        console.error('POST /api/ks/requests error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'create_failed' });
    }
});

// ─── Helper: auto-upload base64 images in a JSON array to GCS ──────────────
// Input:  JSON string like '["data:image/jpeg;base64,...","https://..."]'
// Output: Same array with base64 replaced by GCS public URLs.
// Folder structure: ks-surveys/{mqFolder}/{subfolder}/{ts}_{rand}.{ext}
// Each image is retried up to 3 times on transient GCS errors to guarantee
// no silent image loss.
async function ksAutoUploadImages(jsonStr, mqFolder, subfolder) {
    const ksBucket = process.env.KS_GCS_BUCKET;
    if (!ksBucket) {
        console.warn('[ksAutoUpload] KS_GCS_BUCKET not set — images kept as-is');
        return jsonStr;
    }
    let arr;
    try { arr = JSON.parse(jsonStr || '[]'); } catch (_) { return jsonStr; }
    if (!Array.isArray(arr) || arr.length === 0) return jsonStr;
    const safeMq  = String(mqFolder  || 'misc').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const safeSub = String(subfolder || 'misc').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32);
    const bucket  = gcs.bucket(ksBucket);
    const uploaded = await Promise.all(arr.map(async (item) => {
        if (typeof item !== 'string') return item;
        const m = item.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
        if (!m) return item; // already a URL or non-image → keep
        const mimetype = m[1];
        const buffer   = Buffer.from(m[2], 'base64');
        let ext = 'bin';
        if (mimetype === 'image/jpeg') ext = 'jpg';
        else if (mimetype === 'image/png')  ext = 'png';
        else if (mimetype === 'image/webp') ext = 'webp';
        else if (mimetype === 'image/gif')  ext = 'gif';
        const rand     = crypto.randomBytes(6).toString('hex');
        const filename = `ks-surveys/${safeMq}/${safeSub}/${Date.now()}_${rand}.${ext}`;
        // Retry up to 3 times on transient GCS errors
        const GCS_RETRIES = 3;
        for (let attempt = 1; attempt <= GCS_RETRIES; attempt++) {
            try {
                await bucket.file(filename).save(buffer, { contentType: mimetype });
                return `https://storage.googleapis.com/${ksBucket}/${filename}`;
            } catch (uploadErr) {
                console.warn(`[ksAutoUpload] GCS upload attempt ${attempt}/${GCS_RETRIES} failed:`, uploadErr && uploadErr.message ? uploadErr.message : uploadErr);
                if (attempt < GCS_RETRIES) {
                    await new Promise(r => setTimeout(r, 500 * attempt));
                }
            }
        }
        // All retries failed — keep base64 in DB as last resort so data is not lost.
        // The image can be re-uploaded manually or via a cleanup job later.
        console.error('[ksAutoUpload] All GCS retries failed for image — preserving base64 in DB');
        return item;
    }));
    return JSON.stringify(uploaded.filter(x => x !== null));
}
// ─────────────────────────────────────────────────────────────────────────────

// PATCH /api/ks/requests/:id
app.patch('/api/ks/requests/:id', async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        const b = req.body || {};
        const now = new Date();

        let rows;
        const dbPrefixMatch = id.match(/^db_(\d+)$/);
        if (/^\d+$/.test(id)) {
            [rows] = await pool.query('SELECT * FROM ks_requests WHERE id = ? LIMIT 1', [Number(id)]);
        } else if (dbPrefixMatch) {
            // Fallback ID for rows that had backend_id = NULL: look up by numeric id
            [rows] = await pool.query('SELECT * FROM ks_requests WHERE id = ? LIMIT 1', [Number(dbPrefixMatch[1])]);
        } else {
            [rows] = await pool.query('SELECT * FROM ks_requests WHERE backend_id = ? LIMIT 1', [id]);
        }
        if (!rows || rows.length === 0) return res.status(404).json({ ok: false, error: 'not_found' });
        const current = rows[0];
        const rowId = current.id;

        // Auto-upload any base64 images to GCS before persisting
        // Use tk_code as folder name (falls back to backend_id for pre-existing rows)
        const folderForUpload = current.tk_code || current.backend_id || ('db_' + current.id);
        if ('statusImages' in b) b.statusImages = await ksAutoUploadImages(normalizeBodyValue(b.statusImages), folderForUpload, 'hien-trang');
        if ('designImages' in b) b.designImages = await ksAutoUploadImages(normalizeBodyValue(b.designImages), folderForUpload, 'mq');
        if ('acceptanceImages' in b) b.acceptanceImages = await ksAutoUploadImages(normalizeBodyValue(b.acceptanceImages), folderForUpload, 'mq');

        const fields = [], vals = [];
        const maybeStr  = (k, col) => { if (k in b) { fields.push(`${col} = ?`); vals.push(toNullableString(b[k])); } };
        const maybeJson = (k, col) => { if (k in b) { fields.push(`${col} = ?`); vals.push(normalizeBodyValue(b[k])); } };

        maybeStr('type',             'type');
        maybeStr('outletName',       'outlet_name');
        maybeStr('address',          'address');
        maybeStr('outletLat',        'outlet_lat');
        maybeStr('outletLng',        'outlet_lng');
        maybeStr('phone',            'phone');
        maybeJson('items',           'items');
        maybeStr('content',          'content');
        if ('oldContent' in b)       { fields.push('old_content = ?'); vals.push(b.oldContent ? 1 : 0); }
        maybeStr('oldContentExtra',  'old_content_extra');
        maybeJson('statusImages',    'status_images');
        maybeJson('comments',        'comments');
        maybeJson('requester',       'requester');
        maybeStr('status',           'status');
        if ('editingRequestedAt' in b) {
            fields.push('editing_requested_at = ?');
            vals.push(b.editingRequestedAt ? new Date(b.editingRequestedAt) : null);
        }

        // Handle outletCode change: may trigger GCS folder rename for MQ images
        let newDesignImages = null;
        let newMqFolder = current.mq_folder || null;
        if ('outletCode' in b) {
            const newOutletCode = toNullableString(b.outletCode);
            const oldOutletCode = current.outlet_code || '';
            fields.push('outlet_code = ?');
            vals.push(newOutletCode);

            const ksBucket = process.env.KS_GCS_BUCKET;
            const oldMqFolder = current.mq_folder;
            const outletCodeChanged = newOutletCode && newOutletCode !== oldOutletCode;
            const isStillTemp = oldMqFolder && oldMqFolder.startsWith('mq-NEWOUTLET-');

            if (outletCodeChanged && oldMqFolder && ksBucket) {
                // Generate proper folder name for new outlet code
                const newFolder = ksSafeMqFolder(newOutletCode);
                try {
                    const remap = await ksRenameGcsFolder(
                        ksBucket,
                        current.backend_id + '/' + oldMqFolder,
                        current.backend_id + '/' + newFolder
                    );
                    newMqFolder = newFolder;
                    // Re-map URLs in design_images
                    const currentDesignImages = current.design_images || '[]';
                    // Build full-path remap (the helper returns old→new for full GCS object paths)
                    newDesignImages = ksRemapImageUrls(currentDesignImages, remap);
                } catch (renameErr) {
                    console.warn('GCS mq_folder rename failed (non-fatal):', renameErr && renameErr.message ? renameErr.message : renameErr);
                    // Still update mq_folder in DB even if GCS fails
                    if (!isStillTemp) newMqFolder = ksSafeMqFolder(newOutletCode);
                }
                fields.push('mq_folder = ?');
                vals.push(newMqFolder);
                if (!('designImages' in b)) {
                    // Only auto-update if caller isn't also sending new design_images
                    fields.push('design_images = ?');
                    vals.push(newDesignImages || current.design_images || '[]');
                }
            } else if (!oldMqFolder) {
                // First time outlet code is set — generate mq_folder
                newMqFolder = ksSafeMqFolder(newOutletCode || '');
                fields.push('mq_folder = ?');
                vals.push(newMqFolder);
            }
        }

        // Allow explicit mq_folder override (admin use)
        if ('mqFolder' in b) {
            fields.push('mq_folder = ?');
            vals.push(toNullableString(b.mqFolder));
        }

        // designImages and acceptanceImages updated with their own fields
        maybeJson('designImages',    'design_images');
        maybeJson('acceptanceImages','acceptance_images');

        // Design author tracking fields
        maybeStr('designCreatedBy',    'design_created_by');
        if ('designCreatedAt' in b)    { fields.push('design_created_at = ?');     vals.push(b.designCreatedAt     ? new Date(b.designCreatedAt)     : null); }
        maybeStr('designLastEditedBy', 'design_last_edited_by');
        if ('designLastEditedAt' in b) { fields.push('design_last_edited_at = ?'); vals.push(b.designLastEditedAt  ? new Date(b.designLastEditedAt)  : null); }

        if (fields.length === 0) return res.json({ ok: true, message: 'no_changes' });

        fields.push('updated_at = ?');
        vals.push(now);
        vals.push(rowId);

        await pool.query(`UPDATE ks_requests SET ${fields.join(', ')} WHERE id = ?`, vals);
        const [[updated]] = await pool.query('SELECT * FROM ks_requests WHERE id = ? LIMIT 1', [rowId]);
        // Include full data in SSE payload for instant client-side patching
        wsInvalidate('ks_requests', { action: 'update', id: updated.backend_id, data: ksRowToApp(updated) });

        // ── Fire push notification ──
        // Covers: QCAG hoàn thành MQ, QCAG chỉnh sửa xong, Sale yêu cầu chỉnh sửa, bảo hành
        try {
            // isPendingEdit: the request had an active edit request at time of PATCH
            const isPendingEdit = !!(current.editing_requested_at);
            // isNewMQ: first time a MQ is being confirmed (no prior designCreatedBy on DB row)
            const isNewMQ = !current.design_created_by;
            // Send push when:
            //   1. Status first becomes 'done' (new MQ completed), OR
            //   2. Status stays/becomes 'done' while resolving a pending edit request
            const becomingDone = b.status === 'done' && (current.status !== 'done' || isPendingEdit);

            if (becomingDone) {
                // Lấy thông tin của Sale Heineken từ requester field
                let requesterPhone = null;
                let requesterSaleCode = null;
                try {
                    const reqObj = JSON.parse(updated.requester || '{}') || {};
                    requesterPhone    = reqObj.phone    || null;
                    requesterSaleCode = reqObj.saleCode || null;
                } catch (_) {}

                // Tính mã TK giống frontend: đếm requests cùng năm có id <= id hiện tại
                let tkCode = updated.backend_id || ('db_' + updated.id);
                try {
                    const createdAt = updated.created_at ? new Date(updated.created_at) : new Date();
                    const yy = String(createdAt.getFullYear()).slice(-2);
                    const yearStr = String(createdAt.getFullYear());
                    const [[cntRow]] = await pool.query(
                        `SELECT COUNT(*) AS cnt FROM ks_requests
                         WHERE EXTRACT(YEAR FROM created_at) = ?
                           AND (created_at < ? OR (created_at = ? AND id <= ?))`,
                        [yearStr, updated.created_at, updated.created_at, updated.id]
                    );
                    const seq = String(Number((cntRow && cntRow.cnt) || 1)).padStart(5, '0');
                    tkCode = `TK${yy}.${seq}`;
                } catch (_) {}

                const outletLabel = updated.outlet_name || updated.outlet_code || 'Outlet';
                const pushTitle = isPendingEdit
                    ? 'QCAG — Đã hoàn thành chỉnh sửa'
                    : 'QCAG — Đã có mẫu quảng cáo (MQ)';
                const pushBody = isPendingEdit
                    ? `Yêu cầu ${tkCode} Outlet ${outletLabel} đã được QCAG chỉnh sửa xong. Vui lòng mở app để kiểm tra MQ.`
                    : `Yêu cầu ${tkCode} Outlet ${outletLabel} đã được duyệt MQ. Vui lòng mở app để xem.`;

                await sendKsPush({
                    title: pushTitle,
                    body: pushBody,
                    data: { backendId: updated.backend_id },
                    targetPhone: requesterPhone,
                    targetSaleCode: requesterSaleCode,
                });
            }

            // ── Push for editing request: Sale Heineken yêu cầu chỉnh sửa → notify QCAG ──
            const editingJustRequested = !!b.editingRequestedAt && !current.editing_requested_at;
            if (editingJustRequested) {
                let requesterName = 'Sale Heineken';
                try {
                    const reqObj2 = JSON.parse(updated.requester || '{}') || {};
                    requesterName = reqObj2.saleName || reqObj2.phone || 'Sale Heineken';
                } catch (_) {}
                const outletLabel2 = updated.outlet_name || updated.outlet_code || 'Outlet';
                sendKsPush({
                    title: 'QCAG — Yêu cầu chỉnh sửa MQ',
                    body: `${requesterName} yêu cầu chỉnh sửa MQ cho Outlet ${outletLabel2}.`,
                    data: { backendId: updated.backend_id },
                    targetPhone: null,
                    targetSaleCode: null,
                    targetRole: 'qcag',
                }).catch(e => console.warn('[push] editing-request notify error (non-fatal):', e && e.message ? e.message : e));
            }
        } catch (pushErr) {
            console.warn('[push] notify error (non-fatal):', pushErr && pushErr.message ? pushErr.message : pushErr);
        }
        // ────────────────────────────────────────────────────────────────

        return res.json({ ok: true, data: ksRowToApp(updated) });
    } catch (err) {
        console.error('PATCH /api/ks/requests/:id error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'update_failed' });
    }
});

// DELETE /api/ks/requests/:id
app.delete('/api/ks/requests/:id', async (req, res) => {
    try {
        await ensureDbInitStarted();
        const id = String(req.params.id || '').trim();
        let rows;
        const dbPrefixMatch = id.match(/^db_(\d+)$/);
        if (/^\d+$/.test(id)) {
            [rows] = await pool.query('SELECT id FROM ks_requests WHERE id = ? LIMIT 1', [Number(id)]);
        } else if (dbPrefixMatch) {
            // Fallback ID for rows that had backend_id = NULL: look up by numeric id
            [rows] = await pool.query('SELECT id FROM ks_requests WHERE id = ? LIMIT 1', [Number(dbPrefixMatch[1])]);
        } else {
            [rows] = await pool.query('SELECT id FROM ks_requests WHERE backend_id = ? LIMIT 1', [id]);
        }
        if (!rows || rows.length === 0) return res.status(404).json({ ok: false, error: 'not_found' });
        await pool.query('DELETE FROM ks_requests WHERE id = ?', [rows[0].id]);
        wsInvalidate('ks_requests', { action: 'delete', id });
        return res.json({ ok: true });
    } catch (err) {
        console.error('DELETE /api/ks/requests/:id error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'delete_failed' });
    }
});

// POST /api/ks/upload  — ảnh lên bucket KS_GCS_BUCKET (tách biệt qcag-images)
// Body: { dataUrl, filename?, backendId?, folder? }
// Structured path: ks-surveys/{backendId}/{folder}/{ts}_{rand}.{ext}
// Fallback flat path (no backendId): ks-attachments/{ts}_{rand}.{ext}
app.post('/api/ks/upload', async (req, res) => {
    try {
        const dataUrl      = req.body && req.body.dataUrl      != null ? String(req.body.dataUrl)      : '';
        const filenameHint = req.body && req.body.filename     != null ? String(req.body.filename)     : '';
        const backendIdRaw = req.body && req.body.backendId    != null ? String(req.body.backendId)    : '';
        const folderRaw    = req.body && req.body.folder       != null ? String(req.body.folder)       : '';
        if (!dataUrl) return res.status(400).json({ ok: false, error: 'missing_dataUrl' });
        const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
        if (!m) return res.status(400).json({ ok: false, error: 'invalid_dataUrl' });
        const ksBucketName = process.env.KS_GCS_BUCKET;
        if (!ksBucketName) return res.status(500).json({ ok: false, error: 'KS_GCS_BUCKET not configured' });
        const mimetype = m[1];
        const buffer = Buffer.from(m[2], 'base64');
        let ext = 'bin';
        if (mimetype === 'image/jpeg') ext = 'jpg';
        else if (mimetype === 'image/png') ext = 'png';
        else if (mimetype === 'image/webp') ext = 'webp';
        else if (mimetype === 'image/gif') ext = 'gif';
        const rand = crypto.randomBytes(6).toString('hex');
        const ts   = Date.now();
        let filename;
        if (backendIdRaw) {
            const safeId  = backendIdRaw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
            const safeFld = folderRaw   ? folderRaw.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 64) : 'misc';
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

        let rows;
        if (/^\d+$/.test(id)) {
            [rows] = await pool.query('SELECT * FROM ks_requests WHERE id = ? LIMIT 1', [Number(id)]);
        } else {
            [rows] = await pool.query('SELECT * FROM ks_requests WHERE backend_id = ? LIMIT 1', [id]);
        }
        if (!rows || rows.length === 0) return res.status(404).json({ ok: false, error: 'not_found' });
        const current = rows[0];
        const rowId   = current.id;
        const oldMqFolder = current.mq_folder;
        const newMqFolder = ksSafeMqFolder(newOutletCode);
        const ksBucket    = process.env.KS_GCS_BUCKET;

        let remap = {};
        if (oldMqFolder && ksBucket && oldMqFolder !== newMqFolder) {
            remap = await ksRenameGcsFolder(
                ksBucket,
                current.backend_id + '/' + oldMqFolder,
                current.backend_id + '/' + newMqFolder
            );
        }
        const newDesignImages = ksRemapImageUrls(current.design_images || '[]', remap);
        await pool.query(
            'UPDATE ks_requests SET outlet_code = ?, mq_folder = ?, design_images = ?, updated_at = NOW() WHERE id = ?',
            [newOutletCode, newMqFolder, newDesignImages, rowId]
        );
        const [[updated]] = await pool.query('SELECT * FROM ks_requests WHERE id = ? LIMIT 1', [rowId]);
        wsInvalidate('ks_requests', { action: 'update', id: updated.backend_id, data: ksRowToApp(updated) });
        return res.json({ ok: true, data: ksRowToApp(updated), renamedFiles: Object.keys(remap).length });
    } catch (err) {
        console.error('/api/ks/requests/:id/rename-mq-folder error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: 'rename_failed' });
    }
});

// GET /api/ks/settings/:key
app.get('/api/ks/settings/:key', async (req, res) => {
    try {
        const key = String(req.params.key || '').trim();
        const [[row]] = await pool.query('SELECT setting_value FROM ks_settings WHERE setting_key = ? LIMIT 1', [key]);
        if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
        return res.json({ ok: true, key, value: row.setting_value });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'fetch_failed' });
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
                    server.listen(p);
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
            try { res.end(); } catch (_) {}
        }
    } catch (e) {
        try { if (!res.headersSent) res.status(500).json({ ok: false, error: 'internal_error' }); } catch (_) {}
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

app.post('/images/upload', async(req, res) => {
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
        try { res.end(); } catch (_) {}
    });
    stream.pipe(res);
}

app.get('/images/v/:b64', async(req, res) => {
    try {
        const bucketName = process.env.GCS_BUCKET;
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

app.get('/images/view', async(req, res) => {
    try {
        const bucketName = process.env.GCS_BUCKET;
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
