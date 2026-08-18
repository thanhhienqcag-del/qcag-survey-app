/**
 * migrate_v8_smart.js — Smart & Ultra-Fast Data Migration into Target Schema V8
 */
'use strict';

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DIRECT_HOST = 'ep-tiny-night-azvff9xe.c-3.ap-southeast-1.aws.neon.tech';
const DATABASE_URL = `postgresql://neondb_owner:npg_2nyfpCLYVi3d@${DIRECT_HOST}/neondb?sslmode=require`;

function parseDateSafe(val) {
  if (!val || val === '0' || val === '0000-00-00' || val === '\\N') return null;
  try {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  } catch (_) {
    return null;
  }
}

async function run() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('[v8-smart] Connected to Neon DB');

  try {
    // 1. Dọn dẹp bảng cũ
    const legacyTables = [
      'production_orders', 'qc_reg_lists', 'qc_registration_lists',
      'ks_pending_orders', 'ks_production_approvals', 'ks_quote_bridge',
      'ks_request_comments', 'ks_request_images', 'ks_request_items',
      'ks_requests', 'ks_settings', 'ks_users', 'quotation_notes'
    ];
    for (const t of legacyTables) {
      await client.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }

    const tablesResult = await client.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);
    for (const r of tablesResult.rows) {
      await client.query(`TRUNCATE TABLE ${r.tablename} CASCADE`);
    }
    console.log('[v8-smart] Database tables cleaned');

    // Read backup.sql
    const backupPath = path.resolve('f:/10. Code/QCAG-Production Main/backup.sql');
    const backup = fs.readFileSync(backupPath, 'utf8');
    const lines = backup.split('\n');

    const parsedCopyBlocks = {};

    let inCopy = false;
    let curTable = '';
    let curCols = [];
    let curRows = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('COPY public.')) {
        const match = line.match(/^COPY\s+public\.(\w+)\s*\(([^)]+)\)\s+FROM\s+stdin/i);
        if (match) {
          inCopy = true;
          curTable = match[1];
          curCols = match[2].split(',').map(c => c.trim());
          curRows = [];
        }
        continue;
      }

      if (inCopy) {
        if (line === '\\.') {
          if (curTable && curRows.length > 0) {
            parsedCopyBlocks[curTable] = { cols: curCols, rows: curRows };
          }
          inCopy = false;
          curTable = '';
          continue;
        }
        if (curTable) curRows.push(line);
      }
    }

    function parseRows(tableName) {
      const block = parsedCopyBlocks[tableName];
      if (!block) return [];
      return block.rows.map(rowLine => {
        const vals = rowLine.split('\t');
        const obj = {};
        block.cols.forEach((col, idx) => {
          let v = vals[idx];
          if (v === '\\N' || v === undefined) v = null;
          obj[col] = v;
        });
        return obj;
      });
    }

    // 0. Ensure Admin User FIRST
    await client.query(`
      INSERT INTO users (id, username, password_hash, fullname, name, role, approved, is_active)
      VALUES ('USR_ADMINQCAG', 'adminqcag', '$2b$10$hashed_default', 'Admin', 'Admin', 'admin', true, true)
      ON CONFLICT (username) DO NOTHING
    `);

    // A. MIGRATE USERS
    const userRows = parseRows('ks_users').concat(parseRows('users'));
    const userMap = new Map();
    const userIdSet = new Set(['USR_ADMINQCAG']);

    for (const u of userRows) {
      const uname = (u.username || '').trim().toLowerCase();
      if (!uname || uname === 'adminqcag') continue;
      const uid = u.id && u.id.startsWith('USR_') ? u.id : `USR_${uname}`;
      if (userMap.has(uname)) continue;

      userMap.set(uname, {
        id: uid,
        username: uname,
        password_hash: u.password_hash || '$2b$10$hashed_default',
        fullname: u.name || u.fullname || uname,
        name: u.name || u.fullname || uname,
        role: u.role || 'sale',
        phone: u.phone || uname,
        approved: u.approved === 't' || u.approved === '1' || u.approved === 'true'
      });
      userIdSet.add(uid);
    }

    console.log(`[v8-smart] Migrating ${userMap.size} users...`);
    const userValues = Array.from(userMap.values());
    for (const u of userValues) {
      await client.query(`
        INSERT INTO users (id, username, password_hash, fullname, name, role, phone, approved, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
        ON CONFLICT (username) DO NOTHING
      `, [u.id, u.username, u.password_hash, u.fullname, u.name, u.role, u.phone, u.approved]);
    }

    // B. MIGRATE OUTLETS
    const quoteRows = parseRows('quotations');
    const reqRows = parseRows('ks_requests');

    const outletMap = new Map();
    for (const q of quoteRows) {
      const code = (q.outlet_code || '').trim();
      if (!code || outletMap.has(code)) continue;
      outletMap.set(code, {
        id: `OUT_${code}`,
        code: code,
        name: q.outlet_name || code,
        phone: q.outlet_phone || null,
        house_number: q.house_number || null,
        street: q.street || null,
        ward: q.ward || null,
        district: q.district || null,
        province: q.province || q.area || null,
        region: q.area || null
      });
    }
    for (const r of reqRows) {
      const code = (r.outlet_code || '').trim();
      if (!code || outletMap.has(code)) continue;
      outletMap.set(code, {
        id: `OUT_${code}`,
        code: code,
        name: r.outlet_name || code,
        phone: r.phone || null,
        house_number: null,
        street: null,
        ward: null,
        district: null,
        province: null,
        region: null
      });
    }

    console.log(`[v8-smart] Migrating ${outletMap.size} outlets...`);
    const outletValues = Array.from(outletMap.values());
    for (let i = 0; i < outletValues.length; i += 100) {
      const chunk = outletValues.slice(i, i + 100);
      const valStrs = [];
      const params = [];
      let pIdx = 1;
      for (const o of chunk) {
        valStrs.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`);
        params.push(o.id, o.code, o.name, o.phone, o.house_number, o.street, o.ward, o.district, o.province, o.region);
      }
      await client.query(`
        INSERT INTO outlets (id, code, name, phone, house_number, street, ward, district, province, region)
        VALUES ${valStrs.join(',')} ON CONFLICT (code) DO NOTHING
      `, params);
    }

    // C. MIGRATE REQUESTS
    const requestIdSet = new Set();
    console.log(`[v8-smart] Migrating ${reqRows.length} requests...`);
    for (let i = 0; i < reqRows.length; i += 100) {
      const chunk = reqRows.slice(i, i + 100);
      const valStrs = [];
      const params = [];
      let pIdx = 1;
      for (const r of chunk) {
        const tkCode = r.backend_id || r.id;
        const outletCode = (r.outlet_code || '').trim();
        const outletId = outletCode ? `OUT_${outletCode}` : null;
        if (!tkCode || !outletId) continue;

        requestIdSet.add(tkCode);
        valStrs.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`);
        params.push(
          tkCode,
          outletId,
          r.type || 'new',
          r.old_content === 't' || r.old_content === '1',
          r.status || 'pending',
          r.design_status || 'pending',
          r.items || '[]',
          'USR_ADMINQCAG',
          parseDateSafe(r.created_at) || new Date()
        );
      }
      if (valStrs.length > 0) {
        await client.query(`
          INSERT INTO requests (tk_code, outlet_id, type, old_content, status, design_status, items, created_by, created_at)
          VALUES ${valStrs.join(',')} ON CONFLICT (tk_code) DO NOTHING
        `, params);
      }
    }

    // D. MIGRATE QUOTATIONS
    console.log(`[v8-smart] Migrating ${quoteRows.length} quotations...`);
    for (let i = 0; i < quoteRows.length; i += 50) {
      const chunk = quoteRows.slice(i, i + 50);
      for (const q of chunk) {
        const quoteCode = q.quote_code;
        if (!quoteCode) continue;
        const outletCode = (q.outlet_code || '').trim();
        const outletId = outletCode ? `OUT_${outletCode}` : null;
        const validTkCode = q.tk_code && requestIdSet.has(q.tk_code) ? q.tk_code : null;

        await client.query(`
          INSERT INTO quotations (
            id, quote_code, tk_code, outlet_id, outlet_code, outlet_name, outlet_phone,
            sale_type, sale_code, sale_name, sale_phone, ss_name, spo_name, area,
            house_number, street, ward, district, province, address,
            items, images, total_amount, spo_number, spo_status, notes, status,
            qcag_status, qcag_order_number, qcag_image_url, qcag_override_status, qcag_note, qcag_at,
            order_number, responsibles, edit_history, qc_signage_state,
            due_date, is_confirmed, last_confirmed_at, is_exported, exported_at,
            created_by, created_by_name, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25, $26, $27,
            $28, $29, $30, $31, $32, $33,
            $34, $35, $36, $37,
            $38, $39, $40, $41, $42,
            $43, $44, $45, $46
          ) ON CONFLICT (quote_code) DO NOTHING
        `, [
          q.id ? parseInt(q.id, 10) : null,
          quoteCode,
          validTkCode,
          outletId,
          q.outlet_code || null,
          q.outlet_name || null,
          q.outlet_phone || null,
          q.sale_type || null,
          q.sale_code || null,
          q.sale_name || null,
          q.sale_phone || null,
          q.ss_name || null,
          q.spo_name || null,
          q.area || null,
          q.house_number || null,
          q.street || null,
          q.ward || null,
          q.district || null,
          q.province || null,
          q.address || null,
          q.items || '[]',
          q.images || '[]',
          q.total_amount ? parseFloat(q.total_amount) : 0,
          q.spo_number || null,
          q.spo_status || null,
          q.notes || '[]',
          q.quote_status || q.status || 'pending',
          q.qcag_status || null,
          q.qcag_order_number || null,
          q.qcag_image_url || null,
          q.qcag_override_status || null,
          q.qcag_note || null,
          parseDateSafe(q.qcag_at),
          q.order_number || null,
          q.responsibles || null,
          q.edit_history || null,
          q.qc_signage_state || null,
          parseDateSafe(q.due_date),
          q.is_confirmed === 't' || q.is_confirmed === '1' || q.is_confirmed === 'true',
          parseDateSafe(q.last_confirmed_at),
          q.is_exported === 't' || q.is_exported === '1' || q.is_exported === 'true',
          parseDateSafe(q.exported_at),
          q.created_by && userIdSet.has(q.created_by) ? q.created_by : null,
          q.created_by_name || null,
          parseDateSafe(q.created_at) || new Date(),
          parseDateSafe(q.updated_at) || new Date()
        ]);
      }
    }

    // E. MIGRATE QUOTATION ITEMS
    const qiRows = parseRows('quotation_items');
    console.log(`[v8-smart] Migrating ${qiRows.length} quotation items...`);
    for (let i = 0; i < qiRows.length; i += 100) {
      const chunk = qiRows.slice(i, i + 100);
      const valStrs = [];
      const params = [];
      let pIdx = 1;
      for (const item of chunk) {
        if (!item.id || !item.quotation_code) continue;
        valStrs.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`);
        params.push(
          item.id,
          item.quotation_code,
          item.item_code || null,
          item.item_type || null,
          item.brand || null,
          item.product_name || item.content || 'Hạng mục',
          item.width ? parseFloat(item.width) : 0,
          item.height ? parseFloat(item.height) : 0,
          item.depth ? parseFloat(item.depth) : 0,
          item.area ? parseFloat(item.area) : null,
          item.quantity ? parseFloat(item.quantity) : 1,
          item.unit || null,
          item.unit_price ? parseFloat(item.unit_price) : 0,
          item.total_price ? parseFloat(item.total_price) : 0,
          item.note || null
        );
      }
      if (valStrs.length > 0) {
        await client.query(`
          INSERT INTO quotation_items (
            id, quotation_code, item_code, item_type, brand, product_name,
            width, height, depth, area, qty, unit, unit_price, total_price, note
          ) VALUES ${valStrs.join(',')} ON CONFLICT (id) DO NOTHING
        `, params);
      }
    }

    // F. MIGRATE PUSH SUBSCRIPTIONS & QUOTE SEQUENCES
    const pushRows = parseRows('push_subscriptions');
    if (pushRows.length > 0) {
      console.log(`[v8-smart] Migrating ${pushRows.length} push subscriptions...`);
      for (const p of pushRows) {
        if (!p.subscription) continue;
        await client.query(`
          INSERT INTO push_subscriptions (phone, role, subscription)
          VALUES ($1, $2, $3)
        `, [p.phone || null, p.role || null, p.subscription]);
      }
    }

    const seqRows = parseRows('quote_sequences');
    if (seqRows.length > 0) {
      console.log(`[v8-smart] Migrating ${seqRows.length} sequence entries...`);
      for (const s of seqRows) {
        await client.query(`
          INSERT INTO quote_sequences (year, current_value, updated_at)
          VALUES ($1, $2, NOW()) ON CONFLICT (year) DO UPDATE SET current_value = EXCLUDED.current_value
        `, [s.year, parseInt(s.current_value || '0', 10)]);
      }
    }

    // Sync SERIAL sequence for quotations
    await client.query(`SELECT setval(pg_get_serial_sequence('quotations', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM quotations`);

    // G. FINAL VERIFICATION & COUNTS
    console.log('\n[v8-smart] Final DB Table Row Counts:');
    for (const r of tablesResult.rows) {
      const c = await client.query(`SELECT COUNT(*) AS count FROM ${r.tablename}`);
      console.log(`  ✓ ${r.tablename}: ${c.rows[0].count} rows`);
    }

    console.log('\n🎉 ✅ [v8-smart] V8 SMART DATA MIGRATION COMPLETE!');
  } finally {
    await client.end();
  }
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
