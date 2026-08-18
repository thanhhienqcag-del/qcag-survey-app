/**
 * rebuild_v9.js — Deploy Target Schema V9 DDL & Populate Pure 3NF Data (Including Production Orders & Users)
 * No JSON columns inside physical quotations table!
 * Production Orders -> orders + order_quotes tables with accurate creators (role = 'user')
 * Items -> quotation_items table
 * Images -> assets table
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

function parseJsonSafe(val, fallback = []) {
  if (!val || val === '\\N') return fallback;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch (_) {
    return fallback;
  }
}

async function run() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('[v9-deploy] Connected to Neon DB (Direct)');

  try {
    // 1. Read & Execute Target Schema V9 DDL
    const ddlPath = path.resolve('f:/10. Code/QCAG-Production Main/target_schema_v9.sql');
    const ddl = fs.readFileSync(ddlPath, 'utf8');
    
    console.log('[v9-deploy] Executing Target Schema V9 DDL...');
    await client.query(ddl);
    console.log('[v9-deploy] DDL executed successfully!');

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

    // 0. System & Default Admin
    await client.query(`
      INSERT INTO users (id, username, password_hash, fullname, name, role, approved, is_active)
      VALUES 
        ('USR_ADMINQCAG', 'adminqcag', '$2b$10$hashed_default', 'Admin', 'Admin', 'admin', true, true)
      ON CONFLICT (username) DO NOTHING
    `);

    // A. USERS (Preserving internal role = 'user' vs 'sale' vs 'admin')
    const userRows = parseRows('ks_users').concat(parseRows('users'));
    const quoteRows = parseRows('quotations');

    const userMap = new Map();
    const userIdSet = new Set(['USR_ADMINQCAG']);
    const nameToUserIdMap = new Map();

    for (const u of userRows) {
      const uname = (u.username || '').trim().toLowerCase();
      if (!uname) continue;
      const uid = u.id && u.id.startsWith('USR_') ? u.id : `USR_${uname}`;
      if (userMap.has(uname)) continue;

      const fullname = u.name || u.fullname || uname;
      const role = u.role || 'sale';

      userMap.set(uname, {
        id: uid,
        username: uname,
        password_hash: u.password_hash || '$2b$10$hashed_default',
        fullname: fullname,
        name: fullname,
        role: role,
        phone: u.phone || uname,
        approved: u.approved === 't' || u.approved === '1' || u.approved === 'true'
      });
      userIdSet.add(uid);
      if (fullname) nameToUserIdMap.set(fullname.trim().toLowerCase(), uid);
      if (uname) nameToUserIdMap.set(uname.trim().toLowerCase(), uid);
    }

    // Extract Sales users from quotations
    for (const q of quoteRows) {
      const scode = (q.sale_code || '').trim().toLowerCase();
      if (!scode || scode === 'adminqcag' || userMap.has(scode)) continue;
      const uid = `USR_${scode}`;
      const sname = q.sale_name || scode;
      userMap.set(scode, {
        id: uid,
        username: scode,
        password_hash: '$2b$10$hashed_default',
        fullname: sname,
        name: sname,
        role: 'sale',
        phone: q.sale_phone || scode,
        approved: true
      });
      userIdSet.add(uid);
      if (sname) nameToUserIdMap.set(sname.trim().toLowerCase(), uid);
    }

    console.log(`[v9-deploy] Migrating ${userMap.size} users...`);
    for (const u of userMap.values()) {
      await client.query(`
        INSERT INTO users (id, username, password_hash, fullname, name, role, phone, approved, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
        ON CONFLICT (username) DO UPDATE SET fullname = EXCLUDED.fullname, name = EXCLUDED.name, role = EXCLUDED.role
      `, [u.id, u.username, u.password_hash, u.fullname, u.name, u.role, u.phone, u.approved]);
    }

    // B. OUTLETS
    const reqRows = parseRows('ks_requests');
    const outletMap = new Map();
    const outletIdSet = new Set();

    for (const q of quoteRows) {
      const code = (q.outlet_code || '').trim();
      if (!code || code === 'quote_code' || outletMap.has(code)) continue;
      const oid = `OUT_${code}`;
      const isProd = code.startsWith('PROD_') || (q.outlet_name || '').toLowerCase().includes('đơn hàng sản xuất');
      outletMap.set(code, {
        id: oid,
        code: code,
        name: q.outlet_name || code,
        phone: q.outlet_phone || null,
        house_number: q.house_number || null,
        street: q.street || null,
        ward: q.ward || null,
        district: q.district || null,
        province: q.province || q.area || null,
        region: isProd ? 'PRODUCTION' : (q.area || null)
      });
      outletIdSet.add(oid);
    }
    for (const r of reqRows) {
      const code = (r.outlet_code || '').trim();
      if (!code || outletMap.has(code)) continue;
      const oid = `OUT_${code}`;
      outletMap.set(code, {
        id: oid,
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
      outletIdSet.add(oid);
    }

    console.log(`[v9-deploy] Migrating ${outletMap.size} outlets...`);
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

    // C. REQUESTS
    const requestIdSet = new Set();
    console.log(`[v9-deploy] Migrating ${reqRows.length} requests...`);
    for (let i = 0; i < reqRows.length; i += 100) {
      const chunk = reqRows.slice(i, i + 100);
      const valStrs = [];
      const params = [];
      let pIdx = 1;
      for (const r of chunk) {
        const tkCode = r.backend_id || r.id;
        const outletCode = (r.outlet_code || '').trim();
        const outletId = outletCode ? `OUT_${outletCode}` : null;
        if (!tkCode || !outletId || !outletIdSet.has(outletId)) continue;

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

    // D. QUOTATIONS & PRODUCTION ORDERS
    console.log(`[v9-deploy] Migrating ${quoteRows.length} clean 3NF quotations & production orders...`);
    
    const userRowsDb = await client.query(`SELECT id, username, fullname FROM users`);
    const usernameToIdMap = new Map();
    userRowsDb.rows.forEach(u => {
      usernameToIdMap.set(u.username.toLowerCase(), u.id);
      if (u.fullname) usernameToIdMap.set(u.fullname.toLowerCase(), u.id);
    });
    const defaultSalesId = 'USR_ADMINQCAG';

    const parsedQuotationItems = [];
    const parsedAssets = [];
    const parsedOrders = [];
    const parsedOrderQuotes = [];

    for (let i = 0; i < quoteRows.length; i += 50) {
      const chunk = quoteRows.slice(i, i + 50);
      for (const q of chunk) {
        const quoteCode = q.quote_code;
        if (!quoteCode || quoteCode === 'quote_code') continue;

        const outletCode = (q.outlet_code || '').trim();
        let outletId = outletCode ? `OUT_${outletCode}` : null;
        if (!outletId) continue;

        if (!outletIdSet.has(outletId)) {
          await client.query(`
            INSERT INTO outlets (id, code, name, phone)
            VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING
          `, [outletId, outletCode, q.outlet_name || outletCode, q.outlet_phone || null]);
          outletIdSet.add(outletId);
        }

        const isProdOrder = outletCode.startsWith('PROD_') || (q.outlet_name || '').toLowerCase().includes('đơn hàng sản xuất');
        const saleCode = (q.sale_code || '').trim().toLowerCase();
        const salesId = usernameToIdMap.get(saleCode) || defaultSalesId;
        const validTkCode = q.tk_code && requestIdSet.has(q.tk_code) ? q.tk_code : null;

        const rawItemsStr = q.items || '[]';
        const parsedItems = parseJsonSafe(rawItemsStr, []);

        if (isProdOrder) {
          // Resolve internal coordinator creator (role = 'user')
          const creatorName = (q.created_by_name || '').trim().toLowerCase();
          const creatorPhone = (q.created_by || '').trim().toLowerCase();
          const creatorId = usernameToIdMap.get(creatorPhone) || usernameToIdMap.get(creatorName) || 'USR_0859219424'; // Default to Trần Lê Mỹ Linh

          const orderNo = q.order_number || q.spo_number || quoteCode;
          const orderId = `ORD_${orderNo}`;
          const constructionUnit = q.construction_unit || q.order_construction_unit || q.other_construction_unit || 'QCAG THI CÔNG';
          const dueDate = parseDateSafe(q.order_due_date) || parseDateSafe(q.due_date);

          // Determine area from quotes array or q.area
          let derivedArea = q.area;
          if (Array.isArray(parsedItems) && parsedItems.length > 0) {
            const firstQuoteArea = parsedItems.find(sub => sub && sub.area)?.area;
            if (firstQuoteArea) derivedArea = firstQuoteArea;
          }

          parsedOrders.push({
            id: orderId,
            order_no: orderNo,
            unit: constructionUnit,
            area: derivedArea || 'PRODUCTION',
            spo_number: q.spo_number || null,
            status: q.status || 'pending',
            total_points: Array.isArray(parsedItems) ? parsedItems.length : 0,
            total_amount: q.total_amount ? parseFloat(q.total_amount) : 0,
            due_date: dueDate,
            created_by: creatorId,
            created_at: parseDateSafe(q.created_at) || new Date()
          });

          // Link quotes inside items JSON to order_quotes junction table
          if (Array.isArray(parsedItems)) {
            parsedItems.forEach((sub, idx) => {
              if (sub && typeof sub === 'object') {
                const linkedCode = sub.quote_code || sub.quote_key || sub.quoteKey || null;
                if (linkedCode) {
                  parsedOrderQuotes.push({
                    id: `oq_${orderNo}_${linkedCode}`,
                    order_id: orderId,
                    quotation_code: linkedCode,
                    sort_order: idx + 1
                  });
                }
              }
            });
          }
        }

        // Parse standard quotation items -> quotation_items table
        if (Array.isArray(parsedItems)) {
          parsedItems.forEach((it, idx) => {
            if (it && typeof it === 'object' && !it.quote_code) {
              parsedQuotationItems.push({
                id: `qi_${quoteCode}_${idx + 1}`,
                quotation_code: quoteCode,
                item_code: it.code || null,
                item_type: it.type || null,
                brand: it.brand || null,
                product_name: it.content || it.product_name || it.name || 'Hạng mục',
                width: it.width ? parseFloat(it.width) : 0,
                height: it.height ? parseFloat(it.height) : 0,
                depth: it.depth ? parseFloat(it.depth) : 0,
                area: it.area ? parseFloat(it.area) : (it.width && it.height ? parseFloat(it.width) * parseFloat(it.height) : null),
                qty: it.quantity ? parseFloat(it.quantity) : (it.qty ? parseFloat(it.qty) : 1),
                unit: it.unit || null,
                unit_price: it.price ? parseFloat(String(it.price).replace(/\D/g, '')) : (it.unit_price ? parseFloat(it.unit_price) : 0),
                total_price: it.total ? parseFloat(String(it.total).replace(/\D/g, '')) : (it.total_price ? parseFloat(it.total_price) : 0),
                note: it.note || null
              });
            }
          });
        }

        // Parse images -> assets table
        const rawImagesStr = q.images || '[]';
        const parsedImages = parseJsonSafe(rawImagesStr, []);
        if (Array.isArray(parsedImages)) {
          parsedImages.forEach((img, idx) => {
            const url = typeof img === 'string' ? img : (img && (img.data || img.url || img.src || img.path || ''));
            if (url) {
              parsedAssets.push({
                id: `ast_q_${quoteCode}_${idx + 1}`,
                owner_type: 'quotation',
                owner_code: quoteCode,
                category: String((img && img.name) || 'maquette').substring(0, 100),
                url: url
              });
            }
          });
        }

        // STRICT 17 CORE COLUMNS INSERT (NO items COLUMN, NO images COLUMN)
        await client.query(`
          INSERT INTO quotations (
            id, quote_code, request_tk_code, outlet_id, sales_id,
            spo_no, sale_type, total_amount, status, quote_status, due_date,
            last_confirmed_at, exported_at, is_deleted, created_by, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17
          ) ON CONFLICT (quote_code) DO NOTHING
        `, [
          q.id ? parseInt(q.id, 10) : null,
          quoteCode,
          validTkCode,
          outletId,
          salesId,
          q.spo_number || q.spo_no || null,
          isProdOrder ? 'Đơn hàng sản xuất' : (q.sale_type || null),
          q.total_amount ? parseFloat(q.total_amount) : 0,
          q.quote_status || q.status || 'pending',
          q.quote_status || q.status || 'pending',
          parseDateSafe(q.due_date),
          parseDateSafe(q.last_confirmed_at),
          parseDateSafe(q.exported_at),
          q.is_deleted === 't' || q.is_deleted === '1' || q.is_deleted === 'true',
          q.created_by && userIdSet.has(q.created_by) ? q.created_by : null,
          parseDateSafe(q.created_at) || new Date(),
          parseDateSafe(q.updated_at) || new Date()
        ]);
      }
    }

    // E. ORDERS & ORDER_QUOTES (Pure 3NF Production Orders)
    console.log(`[v9-deploy] Migrating ${parsedOrders.length} production orders into orders table...`);
    for (let i = 0; i < parsedOrders.length; i += 100) {
      const chunk = parsedOrders.slice(i, i + 100);
      const valStrs = [];
      const params = [];
      let pIdx = 1;
      for (const ord of chunk) {
        valStrs.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`);
        params.push(ord.id, ord.order_no, ord.unit, ord.area, ord.spo_number, ord.status, ord.total_points, ord.total_amount, ord.due_date, ord.created_by, ord.created_at);
      }
      if (valStrs.length > 0) {
        await client.query(`
          INSERT INTO orders (id, order_no, unit, area, spo_number, status, total_points, total_amount, due_date, created_by, created_at)
          VALUES ${valStrs.join(',')} ON CONFLICT (id) DO NOTHING
        `, params);
      }
    }

    console.log(`[v9-deploy] Migrating ${parsedOrderQuotes.length} order quote links into order_quotes junction table...`);
    for (let i = 0; i < parsedOrderQuotes.length; i += 100) {
      const chunk = parsedOrderQuotes.slice(i, i + 100);
      const valStrs = [];
      const params = [];
      let pIdx = 1;
      for (const oq of chunk) {
        valStrs.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`);
        params.push(oq.id, oq.order_id, oq.quotation_code, oq.sort_order);
      }
      if (valStrs.length > 0) {
        await client.query(`
          INSERT INTO order_quotes (id, order_id, quotation_code, sort_order)
          VALUES ${valStrs.join(',')} ON CONFLICT (id) DO NOTHING
        `, params);
      }
    }

    // F. QUOTATION ITEMS
    console.log(`[v9-deploy] Migrating ${parsedQuotationItems.length} quotation items into quotation_items table...`);
    for (let i = 0; i < parsedQuotationItems.length; i += 100) {
      const chunk = parsedQuotationItems.slice(i, i + 100);
      const valStrs = [];
      const params = [];
      let pIdx = 1;
      for (const item of chunk) {
        valStrs.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`);
        params.push(
          item.id,
          item.quotation_code,
          item.item_code,
          item.item_type,
          item.brand,
          item.product_name,
          item.width,
          item.height,
          item.depth,
          item.area,
          item.qty,
          item.unit,
          item.unit_price,
          item.total_price,
          item.note
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

    // G. ASSETS
    console.log(`[v9-deploy] Migrating ${parsedAssets.length} image assets into assets table...`);
    for (let i = 0; i < parsedAssets.length; i += 100) {
      const chunk = parsedAssets.slice(i, i + 100);
      const valStrs = [];
      const params = [];
      let pIdx = 1;
      for (const ast of chunk) {
        valStrs.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`);
        params.push(ast.id, ast.owner_type, ast.owner_code, ast.category, ast.url);
      }
      if (valStrs.length > 0) {
        await client.query(`
          INSERT INTO assets (id, owner_type, owner_code, category, url)
          VALUES ${valStrs.join(',')} ON CONFLICT (id) DO NOTHING
        `, params);
      }
    }

    // H. PUSH SUBSCRIPTIONS & QUOTE SEQUENCES
    const pushRows = parseRows('push_subscriptions');
    if (pushRows.length > 0) {
      console.log(`[v9-deploy] Migrating ${pushRows.length} push subscriptions...`);
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
      console.log(`[v9-deploy] Migrating ${seqRows.length} sequence entries...`);
      for (const s of seqRows) {
        await client.query(`
          INSERT INTO quote_sequences (year, current_value, updated_at)
          VALUES ($1, $2, NOW()) ON CONFLICT (year) DO UPDATE SET current_value = EXCLUDED.current_value
        `, [s.year, parseInt(s.current_value || '0', 10)]);
      }
    }

    // Sync SERIAL sequence for quotations
    await client.query(`SELECT setval(pg_get_serial_sequence('quotations', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM quotations`);

    // I. VERIFY TARGET SCHEMA V9 DATABASE
    console.log('\n[v9-deploy] Final Target Schema V9 Row Counts:');
    const finalTables = await client.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);
    for (const r of finalTables.rows) {
      const c = await client.query(`SELECT COUNT(*) AS count FROM ${r.tablename}`);
      console.log(`  ✓ ${r.tablename}: ${c.rows[0].count} rows`);
    }

    console.log('\n🎉 ✅ [v9-deploy] PURE 3NF TARGET SCHEMA V9 DEPLOYMENT COMPLETE!');
  } finally {
    await client.end();
  }
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
