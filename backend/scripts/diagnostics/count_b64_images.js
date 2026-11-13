require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function checkRecentRecords() {
    const res = await pool.query(`
        SELECT id, outlet_code, outlet_name, status, created_at, updated_at,
               status_images LIKE '%data:image%' AS status_has_b64,
               design_images LIKE '%data:image%' AS design_has_b64,
               status_images,
               design_images
        FROM ks_requests
        WHERE (created_at >= '2026-09-05 00:00:00+07' OR updated_at >= '2026-09-05 00:00:00+07')
          AND (status_images LIKE '%data:image%' OR design_images LIKE '%data:image%')
        ORDER BY id DESC
    `);

    console.log(`Found ${res.rowCount} records with base64 in status_images / design_images since 2026-09-05:`);
    
    let totalStatusB64Imgs = 0;
    let totalDesignB64Imgs = 0;

    for (const r of res.rows) {
        let statusB64Count = 0;
        let designB64Count = 0;

        if (r.status_has_b64) {
            try {
                const arr = JSON.parse(r.status_images || '[]');
                statusB64Count = arr.filter(x => typeof x === 'string' && x.startsWith('data:image')).length;
                totalStatusB64Imgs += statusB64Count;
            } catch (e) {
                console.error(`ID ${r.id} status_images JSON parse error`);
            }
        }

        if (r.design_has_b64) {
            try {
                const arr = JSON.parse(r.design_images || '[]');
                designB64Count = arr.filter(x => typeof x === 'string' && x.startsWith('data:image')).length;
                totalDesignB64Imgs += designB64Count;
            } catch (e) {
                console.error(`ID ${r.id} design_images JSON parse error`);
            }
        }

        console.log(`  ID ${r.id} | Code: ${r.outlet_code} | Name: ${r.outlet_name} | Created: ${r.created_at} | Updated: ${r.updated_at} | status_b64: ${statusB64Count} | design_b64: ${designB64Count}`);
    }

    console.log(`\nTOTAL: ${res.rowCount} records.`);
    console.log(`TOTAL base64 images to migrate: ${totalStatusB64Imgs} status images + ${totalDesignB64Imgs} design images = ${totalStatusB64Imgs + totalDesignB64Imgs} images.`);

    await pool.end();
}

checkRecentRecords().catch(console.error);
