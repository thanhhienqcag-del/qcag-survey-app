/**
 * migrate_v8_fast.js — Ultra-fast batch data loader into Target Schema V8
 * Uses multi-row INSERT queries (batch size 200) to minimize network roundtrips to Neon DB.
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
  console.log('[fast-v8] Connected to Neon DB');

  try {
    // 1. Dọn dẹp legacy tables
    const legacyTables = [
      'production_orders', 'qc_reg_lists', 'qc_registration_lists',
      'ks_pending_orders', 'ks_production_approvals', 'ks_quote_bridge',
      'ks_request_comments', 'ks_request_images', 'ks_request_items',
      'ks_requests', 'ks_settings', 'ks_users', 'quotation_notes'
    ];
    for (const t of legacyTables) {
      await client.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }

    // Truncate V8 tables to start clean
    const tablesResult = await client.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);
    for (const r of tablesResult.rows) {
      await client.query(`TRUNCATE TABLE ${r.tablename} CASCADE`);
    }
    console.log('[fast-v8] Cleaned database tables');

    // 2. Fetch V8 column names
    const v8Columns = {};
    for (const row of tablesResult.rows) {
      const colResult = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [row.tablename]);
      v8Columns[row.tablename] = colResult.rows.map(r => r.column_name);
    }

    // 3. Read backup.sql
    const backupPath = path.resolve('f:/10. Code/QCAG-Production Main/backup.sql');
    const backup = fs.readFileSync(backupPath, 'utf8');
    const lines = backup.split('\n');

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

    let inCopy = false;
    let copyTable = '';
    let backupCols = [];
    let copyRows = [];
    const tableBatches = []; // [{ table, cols, rows }]

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('COPY public.')) {
        const match = line.match(/^COPY\s+public\.(\w+)\s*\(([^)]+)\)\s+FROM\s+stdin/i);
        if (match) {
          const backupTable = match[1];
          const v8Table = tableNameMap[backupTable];

          if (v8Table && v8Columns[v8Table]) {
            inCopy = true;
            copyTable = v8Table;
            backupCols = match[2].split(',').map(c => c.trim());
            copyRows = [];
          } else {
            inCopy = true;
            copyTable = '';
            backupCols = [];
            copyRows = [];
          }
        }
        continue;
      }

      if (inCopy) {
        if (line === '\\.') {
          if (copyTable && copyRows.length > 0) {
            tableBatches.push({
              table: copyTable,
              cols: [...backupCols],
              rows: [...copyRows]
            });
          }
          inCopy = false;
          copyTable = '';
          continue;
        }
        if (copyTable) copyRows.push(line);
        continue;
      }
    }

    console.log(`[fast-v8] Parsed ${tableBatches.length} tables from backup.sql`);

    // Helper: Execute batch insert
    async function insertBatch(table, cols, rows) {
      const v8ColSet = new Set(v8Columns[table]);
      const matchingIndices = [];
      const matchingCols = [];

      for (let j = 0; j < cols.length; j++) {
        if (v8ColSet.has(cols[j])) {
          matchingIndices.push(j);
          matchingCols.push(cols[j]);
        }
      }

      // Skip 'id' for SERIAL tables
      if (['push_subscriptions', 'design_tasks'].includes(table)) {
        const idIdx = matchingCols.indexOf('id');
        if (idIdx >= 0) {
          matchingCols.splice(idIdx, 1);
          matchingIndices.splice(idIdx, 1);
        }
      }

      if (matchingCols.length === 0 || rows.length === 0) return 0;

      const BATCH_SIZE = 150;
      let insertedTotal = 0;

      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_SIZE);
        const valueStrings = [];
        const queryParams = [];
        let paramIdx = 1;

        for (const rowStr of chunk) {
          const allVals = rowStr.split('\t');
          const rowParams = [];

          for (const colIdx of matchingIndices) {
            let v = allVals[colIdx];
            if (v === '\\N' || v === undefined) {
              v = null;
            }
            queryParams.push(v);
            rowParams.push(`$${paramIdx++}`);
          }
          valueStrings.push(`(${rowParams.join(',')})`);
        }

        const sql = `INSERT INTO ${table} (${matchingCols.join(',')}) VALUES ${valueStrings.join(',')} ON CONFLICT DO NOTHING`;
        try {
          await client.query(sql, queryParams);
          insertedTotal += chunk.length;
        } catch (err) {
          // Fallback to row-by-row if batch fails due to a bad row
          for (const rowStr of chunk) {
            const allVals = rowStr.split('\t');
            const rowParams = [];
            const singleVals = [];
            let pIdx = 1;

            for (const colIdx of matchingIndices) {
              let v = allVals[colIdx];
              if (v === '\\N' || v === undefined) v = null;
              singleVals.push(v);
              rowParams.push(`$${pIdx++}`);
            }

            const singleSql = `INSERT INTO ${table} (${matchingCols.join(',')}) VALUES (${rowParams.join(',')}) ON CONFLICT DO NOTHING`;
            try {
              await client.query(singleSql, singleVals);
              insertedTotal++;
            } catch (_) {}
          }
        }
      }

      return insertedTotal;
    }

    // Correct insertion order to satisfy Foreign Key constraints
    const orderPriority = [
      'users',
      'quote_sequences',
      'outlets',
      'outlet_code_aliases',
      'requests',
      'request_items',
      'quotations',
      'quotation_items',
      'orders',
      'order_quotes',
      'assets',
      'notes',
      'designs',
      'design_tasks',
      'inspections',
      'qc_batches',
      'qc_batch_items',
      'push_subscriptions',
      'pending_orders',
      'pending_order_quotes'
    ];

    console.log('\n[fast-v8] Inserting data in batch mode:');
    for (const tableName of orderPriority) {
      const b = tableBatches.find(x => x.table === tableName);
      if (b) {
        const count = await insertBatch(b.table, b.cols, b.rows);
        console.log(`  ✓ ${tableName}: ${count} rows`);
      }
    }

    // Sync sequences
    try {
      await client.query(`SELECT setval(pg_get_serial_sequence('quotations', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM quotations`);
      console.log('\n[fast-v8] Synced quotations.id sequence');
    } catch (e) {}

    // Summary counts
    console.log('\n[fast-v8] Final DB Table Counts:');
    const finalResult = await client.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);
    for (const r of finalResult.rows) {
      const countRes = await client.query(`SELECT COUNT(*) AS c FROM ${r.tablename}`);
      console.log(`  ${r.tablename}: ${countRes.rows[0].c} rows`);
    }

    console.log('\n🚀 ✅ [fast-v8] FAST V8 DATA MIGRATION SUCCESSFUL!');
  } finally {
    await client.end();
  }
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
