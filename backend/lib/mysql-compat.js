'use strict';

/**
 * lib/mysql-compat.js
 *
 * Thin adapter that wraps `pg` (Neon) to expose the same API surface
 * used in index.js which was originally written against mysql2/promise.
 *
 * Mapping:
 *   mysql.createPool(opts)              → pg Pool (opts ignored, uses DATABASE_URL)
 *   pool.query(sql, params)             → converts ? → $N, returns [rows, fields]
 *   pool.getConnection()                → returns pg Client wrapped with mysql2-like API
 *   conn.beginTransaction()             → BEGIN
 *   conn.commit()                       → COMMIT
 *   conn.rollback()                     → ROLLBACK
 *   conn.release()                      → client.release()
 *   conn.query(sql, params)             → same as pool.query
 *
 * Result shape:
 *   Both SELECT and mutation queries return [rows, fields].
 *   The rows array has extra properties attached:
 *     rows.insertId    = rows[0].id   (populated when INSERT ... RETURNING id)
 *     rows.affectedRows = pgResult.rowCount
 */

const { Pool } = require('pg');

let _pool = null;

function buildPool() {
    const rawUrl = process.env.DATABASE_URL;
    if (!rawUrl) throw new Error('DATABASE_URL environment variable is not set');

    let connectionString = rawUrl;
    try {
        const url = new URL(rawUrl);
        url.searchParams.delete('sslmode');
        url.searchParams.delete('channel_binding');
        connectionString = url.toString();
    } catch (_) {}

    // Neon free tier: max 5 concurrent connections.
    // Use DB_CONN_LIMIT env to override if on a paid plan.
    return new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false },
        max: Number(process.env.DB_CONN_LIMIT) || 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        // Keep at least 1 connection warm so the first query after idle is fast.
        allowExitOnIdle: false,
    });
}

function getPool() {
    if (!_pool) {
        _pool = buildPool();
        _pool.on('error', (err) => {
            console.error('pg pool error:', err && err.message ? err.message : err);
            _pool = null; // reset so next call rebuilds
        });
    }
    return _pool;
}

/**
 * Convert MySQL `?` placeholders to PostgreSQL `$1, $2, ...`
 */
function convertPlaceholders(sql) {
    let i = 0;
    // Replace standalone ? that are not inside quoted strings.
    // Simple approach: replace all ? sequentially (safe since query params are separate).
    return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * Wrap a pg QueryResult to match mysql2's return shape of [rows, fields].
 * Attaches insertId and affectedRows as properties on the rows array.
 */
function wrapResult(pgResult) {
    const rows = Array.isArray(pgResult.rows) ? pgResult.rows : [];
    // Attach mutation metadata to the array for callers expecting [result] destructure
    rows.insertId = rows.length > 0 && rows[0] && rows[0].id != null ? Number(rows[0].id) : null;
    rows.affectedRows = pgResult.rowCount != null ? pgResult.rowCount : rows.length;
    rows.rowCount = pgResult.rowCount != null ? pgResult.rowCount : rows.length;
    return [rows, pgResult.fields || []];
}

/**
 * Execute a query via a pg client or pool, with placeholder conversion.
 */
async function execQuery(pgClientOrPool, sql, params) {
    const converted = convertPlaceholders(String(sql || ''));
    const result = await pgClientOrPool.query(converted, params || []);
    return wrapResult(result);
}

/**
 * Wrap a pg Client to provide the mysql2 connection API.
 */
function wrapConnection(pgClient) {
    return {
        query: (sql, params) => execQuery(pgClient, sql, params),
        beginTransaction: () => pgClient.query('BEGIN'),
        commit: () => pgClient.query('COMMIT'),
        rollback: () => pgClient.query('ROLLBACK'),
        release: () => pgClient.release(),
    };
}

/**
 * Drop-in replacement for `mysql.createPool(opts)`.
 * The MySQL opts are ignored; connection is configured via DATABASE_URL.
 */
function createPool(/* opts */) {
    return {
        query: (sql, params) => execQuery(getPool(), sql, params),
        getConnection: async () => {
            const client = await getPool().connect();
            return wrapConnection(client);
        },
    };
}

module.exports = { createPool };
