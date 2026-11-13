require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const { Storage } = require('@google-cloud/storage');
const crypto = require('crypto');

const rawUrl = process.env.DATABASE_URL;
let connectionString = rawUrl;
try {
    const url = new URL(rawUrl);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('channel_binding');
    connectionString = url.toString();
} catch (_) {}

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 3 });
const storage = new Storage();
const bucketName = process.env.GCS_BUCKET || 'qcag-483014-qcag-images';
const bucket = storage.bucket(bucketName);

async function uploadBase64Image(dataUrl, folderPath) {
    const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
    if (!m) return dataUrl; // Not base64, return as-is

    const mimetype = m[1];
    const buffer = Buffer.from(m[2], 'base64');
    let ext = 'bin';
    if (mimetype === 'image/jpeg') ext = 'jpg';
    else if (mimetype === 'image/png') ext = 'png';
    else if (mimetype === 'image/webp') ext = 'webp';
    else if (mimetype === 'image/gif') ext = 'gif';

    const rand = crypto.randomBytes(6).toString('hex');
    const ts = Date.now();
    const filename = `${folderPath}/${ts}_${rand}.${ext}`;

    const file = bucket.file(filename);
    await file.save(buffer, { contentType: mimetype });

    return `https://storage.googleapis.com/${bucketName}/${filename}`;
}

async function processArray(jsonStr, folderPath) {
    if (!jsonStr) return jsonStr;
    let arr;
    try {
        arr = JSON.parse(jsonStr);
    } catch (e) {
        return jsonStr;
    }
    if (!Array.isArray(arr)) return jsonStr;

    let hasChange = false;
    const newArr = [];
    for (const item of arr) {
        if (typeof item === 'string' && item.startsWith('data:image')) {
            const url = await uploadBase64Image(item, folderPath);
            newArr.push(url);
            hasChange = true;
        } else {
            newArr.push(item);
        }
    }

    return { changed: hasChange, json: JSON.stringify(newArr) };
}

async function main() {
    const client = await pool.connect();
    try {
        console.log(`\n=== BẮT ĐẦU MIGRATION BASE64 SANG GCS (Bucket: ${bucketName}) ===`);

        const { rows } = await client.query(`
            SELECT id, backend_id, tk_code, outlet_code, outlet_name,
                   status_images, design_images
            FROM ks_requests
            WHERE (created_at >= '2026-09-05 00:00:00+07' OR updated_at >= '2026-09-05 00:00:00+07')
              AND (status_images LIKE '%data:image%' OR design_images LIKE '%data:image%')
            ORDER BY id ASC
        `);

        console.log(`Tìm thấy ${rows.length} bản ghi cần xử lý.\n`);

        let totalUploaded = 0;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const safeId = String(row.backend_id || row.tk_code || `req_${row.id}`)
                .replace(/[^a-zA-Z0-9_-]/g, '_')
                .slice(0, 80);
            const safeOutlet = String(row.outlet_code || 'outlet')
                .replace(/[^a-zA-Z0-9_-]/g, '_')
                .slice(0, 40);

            console.log(`[${i + 1}/${rows.length}] Đang xử lý ID ${row.id} (${row.outlet_name || row.outlet_code})...`);

            const statusFolder = `ks-surveys/${safeId}/hien-trang`;
            const designFolder = `ks-surveys/${safeId}/mq-${safeOutlet}`;

            const statusRes = await processArray(row.status_images, statusFolder);
            const designRes = await processArray(row.design_images, designFolder);

            const finalStatusImages = statusRes.changed ? statusRes.json : row.status_images;
            const finalDesignImages = designRes.changed ? designRes.json : row.design_images;

            if (statusRes.changed || designRes.changed) {
                await client.query(
                    `UPDATE ks_requests SET status_images = $1, design_images = $2 WHERE id = $3`,
                    [finalStatusImages, finalDesignImages, row.id]
                );
                console.log(`  -> Cập nhật DB thành công cho ID ${row.id}`);
            }
        }

        console.log(`\n=== KIỂM TRA LẠI CƠ SỞ DỮ LIỆU ===`);
        const { rows: verifyRows } = await client.query(`
            SELECT id FROM ks_requests
            WHERE (created_at >= '2026-09-05 00:00:00+07' OR updated_at >= '2026-09-05 00:00:00+07')
              AND (status_images LIKE '%data:image%' OR design_images LIKE '%data:image%')
        `);

        if (verifyRows.length === 0) {
            console.log('✅ HOÀN TẤT XUẤT SẮC: Không còn bản ghi nào chứa base64 từ ngày 05/09 đến nay!');
        } else {
            console.warn(`⚠️ Vẫn còn ${verifyRows.length} bản ghi chưa được chuyển đổi!`);
        }

    } finally {
        client.release();
        await pool.end();
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('Migration failed:', err);
        process.exit(1);
    });
}
