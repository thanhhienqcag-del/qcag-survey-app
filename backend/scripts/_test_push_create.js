'use strict';
// Script tạo 1 request test trong DB với saleCode 88000255
// để kiểm tra push notification khi QCAG confirm
const { Pool } = require('pg');

const DB = process.env.DATABASE_URL ||
  'postgresql://neondb_owner:npg_tC3ymrsEYQk2@ep-floral-pine-a18w14pz-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const pool = new Pool({ connectionString: DB, ssl: { rejectUnauthorized: false } });

async function run() {
  // 1. Lấy 1 URL ảnh status có sẵn
  const imgRow = await pool.query(
    `SELECT status_images FROM ks_requests
     WHERE status_images IS NOT NULL AND status_images <> '[]'
       AND length(status_images) > 20
     ORDER BY created_at DESC LIMIT 1`
  );
  const sampleImages = (imgRow.rows[0] && imgRow.rows[0].status_images) || '["https://storage.googleapis.com/ks-khao-sat-bucket/ks-surveys/mq-NEWOUTLET-test/hien-trang/test.jpg"]';
  console.log('Using status_images:', sampleImages.slice(0, 120));

  // 2. Tạo request test
  const backendId = 'srv_TEST_' + Date.now();
  const requester = JSON.stringify({
    phone: '0966767731',
    saleCode: '88000255',
    saleName: 'TEST SALE',
    region: 'South 4'
  });

  const res = await pool.query(`
    INSERT INTO ks_requests
      (backend_id, type, outlet_code, outlet_name, address,
       phone, items, content, old_content, status_images, design_images, acceptance_images,
       comments, requester, status, mq_folder, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW())
    RETURNING id, backend_id`,
    [
      backendId,
      'new',
      'TEST001',
      '[TEST] Outlet Kiểm Tra Push',
      '123 Đường Test, Q.1, TP.HCM',
      '0966767731',
      JSON.stringify([{ name: 'Bảng hiệu hộp đèn', qty: 1 }]),
      '[TEST] Kiểm tra push notification khi QCAG confirm',
      0,
      sampleImages,
      '[]',
      '[]',
      '[]',
      requester,
      'pending',
      'mq-TEST001',
    ]
  );

  const row = res.rows[0];
  console.log('\n✅ Đã tạo request test:');
  console.log('   id         :', row.id);
  console.log('   backend_id :', row.backend_id);
  console.log('\n👉 Mở app trên http://127.0.0.1:3000/QCAG-Production/App-2-KS-Khao-Sat/frontend/index.html');
  console.log('   Đăng nhập QCAG → tìm outlet "[TEST] Outlet Kiểm Tra Push" → upload MQ → bấm Hoàn thành');
  console.log('   Kiểm tra thiết bị saleCode 88000255 có nhận thông báo không\n');
  console.log('   Sau khi test xong, chạy: node scripts/_test_push_delete.js', row.id);
  await pool.end();
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
