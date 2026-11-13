require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
    // 1. Column info of ks_requests
    const cols = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'ks_requests'");
    console.log('Columns of ks_requests:', cols.rows);

    // 2. Check comments with base64
    const commentsMatch = await pool.query(`
        SELECT id, created_at, updated_at, comments 
        FROM ks_requests 
        WHERE comments LIKE '%base64%' OR comments LIKE '%data:image%'
        LIMIT 3
    `);
    console.log('comments with base64 count:', commentsMatch.rowCount);
    if (commentsMatch.rowCount > 0) {
        console.log('Sample comments[0]:', commentsMatch.rows[0].comments.slice(0, 200));
        console.log('Sample created_at:', commentsMatch.rows[0].created_at);
    }

    // 3. Check old_content_images, acceptance_images, items
    for (const f of ['old_content_images', 'acceptance_images', 'items']) {
        const res = await pool.query(`
            SELECT id, created_at, ${f}
            FROM ks_requests
            WHERE ${f} LIKE '%base64%' OR ${f} LIKE '%data:image%'
        `);
        console.log(`Field ${f} with base64 count:`, res.rowCount);
    }

    // 4. Quotations notes
    const qNotes = await pool.query(`
        SELECT id, quote_code, created_at, notes
        FROM quotations
        WHERE notes LIKE '%base64%' OR notes LIKE '%data:image%'
        LIMIT 3
    `);
    console.log('quotations.notes with base64 count:', qNotes.rowCount);
    if (qNotes.rowCount > 0) {
        console.log('Sample quotation notes:', qNotes.rows[0].notes.slice(0, 200));
        console.log('Quotation created_at:', qNotes.rows[0].created_at);
    }

    await pool.end();
}

run().catch(console.error);
