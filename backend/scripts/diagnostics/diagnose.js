require('dotenv').config();
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

async function main() {
    const client = await pool.connect();
    try {
        console.log('=== Checking tables & views ===');

        // 1. Check if ks_requests_view exists
        const { rows: viewCheck } = await client.query(`
            SELECT table_name, table_type
            FROM information_schema.tables
            WHERE table_name IN ('ks_requests', 'ks_requests_view', 'ks_requests_new')
            ORDER BY table_name
        `);
        console.log('Tables/Views:', viewCheck);

        // 2. Count rows in ks_requests
        const { rows: countRows } = await client.query('SELECT COUNT(*) as total FROM ks_requests');
        console.log('ks_requests total rows:', countRows[0].total);

        // 3. Get last 5 records
        const { rows: lastRows } = await client.query(`
            SELECT id, backend_id, outlet_code, outlet_name, status, created_at
            FROM ks_requests ORDER BY created_at DESC LIMIT 5
        `);
        console.log('\nLast 5 records in ks_requests:');
        lastRows.forEach(r => console.log(`  id=${r.id}, backend_id=${r.backend_id}, outlet=${r.outlet_code}, status=${r.status}, created=${r.created_at}`));

        // 4. Try query the view
        try {
            const { rows: viewRows } = await client.query(`SELECT COUNT(*) as total FROM ks_requests_view`);
            console.log('\nks_requests_view total rows:', viewRows[0].total);
        } catch (e) {
            console.error('\n[ERROR] ks_requests_view does not exist or failed:', e.message);
        }

        // 5. Check ks_requests_new if exists
        try {
            const { rows: newRows } = await client.query('SELECT COUNT(*) as total FROM ks_requests_new');
            console.log('ks_requests_new total rows:', newRows[0].total);
        } catch (e) {
            console.log('ks_requests_new: does not exist (non-fatal)');
        }

        // 6. Check for very recent records (last 30 min)
        const { rows: recentRows } = await client.query(`
            SELECT id, backend_id, outlet_code, outlet_name, status, created_at
            FROM ks_requests WHERE created_at > NOW() - INTERVAL '30 minutes'
            ORDER BY created_at DESC
        `);
        console.log('\nRecords created in last 30 minutes:', recentRows.length);
        recentRows.forEach(r => console.log(`  id=${r.id}, outlet=${r.outlet_code}, status=${r.status}, created=${r.created_at}`));

        // 7. Check wsInvalidate trigger - verify cache is cleared on create
        console.log('\n=== Summary ===');
        console.log('Issue: ks_requests_view is used in GET /api/ks/requests but may not exist!');

    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(err => {
    console.error('ERROR:', err);
    process.exit(1);
});
