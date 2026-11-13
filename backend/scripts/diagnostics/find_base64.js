require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

const rawUrl = process.env.DATABASE_URL;
let connectionString = rawUrl;
try {
    const url = new URL(rawUrl);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('channel_binding');
    connectionString = url.toString();
} catch (_) {}

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 3 });

async function scanAllTables() {
    const client = await pool.connect();
    try {
        console.log('\n--- Deep Scanning All Tables for Base64 Strings ---');
        
        // Find all text / character / json / jsonb columns
        const { rows: cols } = await client.query(`
            SELECT table_name, column_name, data_type 
            FROM information_schema.columns 
            WHERE table_schema = 'public'
              AND (data_type IN ('text', 'character varying', 'json', 'jsonb') OR data_type LIKE '%char%')
            ORDER BY table_name, column_name
        `);

        // Group by table
        const tables = {};
        for (const c of cols) {
            if (!tables[c.table_name]) tables[c.table_name] = [];
            tables[c.table_name].push(c.column_name);
        }

        for (const [table, columns] of Object.entries(tables)) {
            const hasCreatedAt = columns.includes('created_at');
            const hasUpdatedAt = columns.includes('updated_at');

            for (const col of columns) {
                try {
                    let whereDate = '';
                    if (hasCreatedAt && hasUpdatedAt) {
                        whereDate = ` AND (created_at >= '2026-09-05 00:00:00' OR updated_at >= '2026-09-05 00:00:00')`;
                    } else if (hasCreatedAt) {
                        whereDate = ` AND created_at >= '2026-09-05 00:00:00'`;
                    } else if (hasUpdatedAt) {
                        whereDate = ` AND updated_at >= '2026-09-05 00:00:00'`;
                    }

                    const queryRecent = `
                        SELECT COUNT(*) as cnt
                        FROM "${table}"
                        WHERE (CAST("${col}" AS TEXT) LIKE '%data:image%' OR CAST("${col}" AS TEXT) LIKE '%;base64,%')
                        ${whereDate}
                    `;
                    const res = await client.query(queryRecent);
                    const count = parseInt(res.rows[0].cnt, 10);
                    if (count > 0) {
                        console.log(`[MATCH] Table "${table}", Column "${col}": ${count} records (since 2026-09-05)`);
                    }

                    // Check all time if different
                    const queryAll = `
                        SELECT COUNT(*) as cnt
                        FROM "${table}"
                        WHERE CAST("${col}" AS TEXT) LIKE '%data:image%' OR CAST("${col}" AS TEXT) LIKE '%;base64,%'
                    `;
                    const resAll = await client.query(queryAll);
                    const countAll = parseInt(resAll.rows[0].cnt, 10);
                    if (countAll > count) {
                        console.log(`  -> Table "${table}", Column "${col}": ${countAll} records across ALL time (older than 2026-09-05)`);
                    }
                } catch (err) {
                    console.error(`Error checking ${table}.${col}:`, err.message);
                }
            }
        }
        console.log('\n--- Scan Completed ---');
    } finally {
        client.release();
        await pool.end();
    }
}

scanAllTables().catch(console.error);
