require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function checkUrl(url) {
    return new Promise((resolve) => {
        https.get(url, (res) => {
            resolve({ statusCode: res.statusCode, contentType: res.headers['content-type'], contentLength: res.headers['content-length'] });
        }).on('error', (err) => resolve({ error: err.message }));
    });
}

async function verify() {
    const res = await pool.query("SELECT id, outlet_code, outlet_name, status_images, design_images FROM ks_requests WHERE id IN (3882, 3881, 3877, 3864)");
    for (const r of res.rows) {
        console.log(`\nID ${r.id} (${r.outlet_name}):`);
        console.log('  status_images:', r.status_images);
        console.log('  design_images:', r.design_images);

        // Test first URL
        try {
            const urls = JSON.parse(r.status_images || '[]');
            if (urls[0]) {
                const info = await checkUrl(urls[0]);
                console.log(`  -> Test HTTP GET ${urls[0].slice(0, 70)}... : HTTP ${info.statusCode} (${info.contentType}, ${info.contentLength} bytes)`);
            }
        } catch (_) {}
    }
    await pool.end();
}

verify().catch(console.error);
