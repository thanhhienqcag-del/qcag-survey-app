/**
 * migrate_v8_data.js — Load legacy backup data into V8 schema
 */
'use strict';

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DIRECT_HOST = 'ep-tiny-night-azvff9xe.c-3.ap-southeast-1.aws.neon.tech';
const DATABASE_URL = `postgresql://neondb_owner:npg_2nyfpCLYVi3d@${DIRECT_HOST}/neondb?sslmode=require`;

async function run() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('[migrate] Connected to Neon');

  try {
    // Drop legacy tables not in V8
    const legacyTables = [
      'production_orders', 'qc_reg_lists', 'qc_registration_lists',
      'ks_pending_orders', 'ks_production_approvals', 'ks_quote_bridge',
      'ks_request_comments', 'ks_request_images', 'ks_request_items',
      'ks_requests', 'ks_settings', 'ks_users', 'quotation_notes'
    ];
    for (const t of legacyTables) {
      await client.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
    console.log('[migrate] Dropped legacy tables');

    // Get V8 table columns
    const v8Columns = {};
    const tablesResult = await client.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);
    for (const row of tablesResult.rows) {
      const colResult = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [row.tablename]);
      v8Columns[row.tablename] = colResult.rows.map(r => r.column_name);
    }

    // Read backup
    const backupPath = path.resolve('f:/10. Code/QCAG-Production Main/backup.sql');
    const backup = fs.readFileSync(backupPath, 'utf8');
    const lines = backup.split('\n');

    let inCopy = false;
    let copyTable = '';
    let backupCols = [];
    let copyRows = [];
    let rowCounts = {};
    let errorCounts = {};
    let skippedTables = [];

    const tableNameMap = {
      'users': 'users',
      'outlets': 'outlets',
      'requests': 'requests',
      'request_items': 'request_items',
      'quotations': 'quotations',
      'quotation_items': 'quotation_items',
      'orders': 'orders',
      'order_quotes': 'order_quotes',
      'assets': 'assets',
      'notes': 'notes',
      'designs': 'designs',
      'design_tasks': 'design_tasks',
      'inspections': 'inspections',
      'qc_batches': 'qc_batches',
      'qc_batch_items': 'qc_batch_items',
      'push_subscriptions': 'push_subscriptions',
      'pending_orders': 'pending_orders',
      'pending_order_quotes': 'pending_order_quotes',
      'outlet_code_aliases': 'outlet_code_aliases',
      'quote_sequences': 'quote_sequences',
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('COPY public.')) {
        const match = line.match(/^COPY\s+public\.(\w+)\s*\(([^)]+)\)\s+FROM\s+stdin/i);
        if (match) {
          const backupTable = match[1];
          const v8Table = tableNameMap[backupTable];
          
          if (!v8Table || !v8Columns[v8Table]) {
            inCopy = true;
            copyTable = '';
            backupCols = [];
            copyRows = [];
            if (!skippedTables.includes(backupTable)) skippedTables.push(backupTable);
            continue;
          }

          inCopy = true;
          copyTable = v8Table;
          backupCols = match[2].split(',').map(c => c.trim());
          copyRows = [];
        }
        continue;
      }

      if (inCopy) {
        if (line === '\\.') {
          if (copyTable && copyRows.length > 0) {
            const v8ColSet = new Set(v8Columns[copyTable]);
            const matchingIndices = [];
            const matchingCols = [];
            
            for (let j = 0; j < backupCols.length; j++) {
              if (v8ColSet.has(backupCols[j])) {
                matchingIndices.push(j);
                matchingCols.push(backupCols[j]);
              }
            }

            // Skip 'id' for SERIAL tables
            const serialIdTables = ['push_subscriptions', 'design_tasks'];
            if (serialIdTables.includes(copyTable)) {
              const idIdx = matchingCols.indexOf('id');
              if (idIdx >= 0) {
                matchingCols.splice(idIdx, 1);
                matchingIndices.splice(idIdx, 1);
              }
            }

            if (matchingCols.length === 0) {
              inCopy = false;
              continue;
            }

            let inserted = 0;
            const placeholders = matchingCols.map((_, idx) => `$${idx + 1}`).join(',');
            const sql = `INSERT INTO ${copyTable} (${matchingCols.join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

            for (const row of copyRows) {
              const allValues = row.split('\t');
              const values = matchingIndices.map(idx => {
                const v = allValues[idx];
                if (v === '\\N' || v === undefined) return null;
                return v;
              });

              try {
                await client.query(sql, values);
                inserted++;
              } catch (err) {
                if (!errorCounts[copyTable]) errorCounts[copyTable] = 0;
                errorCounts[copyTable]++;
                if (errorCounts[copyTable] === 1) {
                  console.warn(`  [warn] ${copyTable}: ${err.message.substring(0, 120)}`);
                }
              }
            }
            rowCounts[copyTable] = (rowCounts[copyTable] || 0) + inserted;
          }
          inCopy = false;
          copyTable = '';
          continue;
        }
        
        if (copyTable) copyRows.push(line);
        continue;
      }
    }

    console.log('\n[migrate] Data loaded:');
    Object.entries(rowCounts).sort().forEach(([table, count]) => {
      const errCount = errorCounts[table] || 0;
      const suffix = errCount > 0 ? ` (${errCount} errors)` : '';
      console.log(`  ✓ ${table}: ${count} rows${suffix}`);
    });

    if (skippedTables.length > 0) {
      console.log('\n[migrate] Skipped legacy tables:', skippedTables.join(', '));
    }

    // Sync sequences
    try {
      await client.query(`SELECT setval(pg_get_serial_sequence('quotations', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM quotations`);
      console.log('\n[migrate] Synced quotations.id sequence');
    } catch (e) {
      console.warn('[migrate] Could not sync quotations.id sequence:', e.message);
    }

    // Final counts
    console.log('\n[migrate] Final row counts:');
    const finalTables = await client.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);
    for (const row of finalTables.rows) {
      try {
        const c = await client.query(`SELECT COUNT(*) AS c FROM ${row.tablename}`);
        const count = Number(c.rows[0].c);
        if (count > 0) console.log(`  ${row.tablename}: ${count}`);
      } catch (e) {}
    }

    console.log('\n✅ [migrate] V8 data migration complete!');
  } finally {
    await client.end();
  }
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
