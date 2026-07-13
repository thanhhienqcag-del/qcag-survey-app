// scripts/migrate.js — Chạy schema.sql lên Neon một lần duy nhất
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function migrate() {
  console.log('🔌 Kết nối Neon...');
  // Strip sslmode từ URL để tránh cảnh báo pg v8
  const rawUrl = new URL(process.env.DATABASE_URL);
  rawUrl.searchParams.delete('sslmode');
  rawUrl.searchParams.delete('channel_binding');
  const pool = new Pool({
    connectionString: rawUrl.toString(),
    ssl: { rejectUnauthorized: false },
    max: 2,
  });

  const schemaPath = path.join(__dirname, '../schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const client = await pool.connect();
  try {
    console.log('📋 Đang chạy schema.sql...');
    await client.query(sql);
    console.log('✅ Migration thành công! Các bảng đã được tạo trên Neon.');

    // Kiểm tra bảng đã tồn tại
    const { rows } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    console.log('\n📦 Danh sách bảng hiện có:');
    rows.forEach(r => console.log('  •', r.table_name));
  } catch (err) {
    console.error('❌ Migration thất bại:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
