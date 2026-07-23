// scripts/test-services.js — Kiểm tra kết nối Neon + Cloudinary
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

async function testNeon() {
  // Strip sslmode từ URL để tránh cảnh báo pg v8
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');
  const pool = new Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false }, max: 2 });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT table_name, pg_total_relation_size(quote_ident(table_name)) AS size_bytes
      FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name
    `);
    console.log('✅ Neon OK — bảng hiện có:');
    rows.forEach(r => console.log(`   • ${r.table_name}  (${r.size_bytes} bytes)`));
  } finally {
    client.release();
    await pool.end();
  }
}

async function testCloudinary() {
  const result = await cloudinary.api.ping();
  console.log('✅ Cloudinary OK —', result.status, '| cloud:', process.env.CLOUDINARY_CLOUD_NAME);
}

(async () => {
  console.log('\n🧪 Kiểm tra kết nối các dịch vụ...\n');
  try {
    await testNeon();
  } catch (e) { console.error('❌ Neon lỗi:', e.message); }

  try {
    await testCloudinary();
  } catch (e) { console.error('❌ Cloudinary lỗi:', e.message); }

  console.log('\nHoàn tất kiểm tra.\n');
})();
