require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function checkNormalUrls() {
    const res1 = await pool.query("SELECT id, status_images FROM ks_requests WHERE status_images NOT LIKE '%data:image%' AND status_images != '[]' AND status_images IS NOT NULL ORDER BY id DESC LIMIT 5");
    res1.rows.forEach(r => console.log('Normal status_images (id=' + r.id + '):', r.status_images));

    const res2 = await pool.query("SELECT id, design_images FROM ks_requests WHERE design_images NOT LIKE '%data:image%' AND design_images != '[]' AND design_images IS NOT NULL ORDER BY id DESC LIMIT 5");
    res2.rows.forEach(r => console.log('Normal design_images (id=' + r.id + '):', r.design_images));

    await pool.end();
}

checkNormalUrls().catch(console.error);
