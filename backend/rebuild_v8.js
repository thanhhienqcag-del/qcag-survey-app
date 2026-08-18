/**
 * rebuild_v8.js — Deploy Target Schema V8 to Neon PostgreSQL
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
  console.log('[V8] Connected to Neon (direct)');

  try {
    // Step 1: Read and execute V8 DDL
    const ddlPath = path.resolve('f:/10. Code/QCAG-Production Main/target_schema_v8.sql');
    const ddl = fs.readFileSync(ddlPath, 'utf8');
    
    console.log('[V8] Executing DDL (target_schema_v8.sql)...');
    
    // Split by semicolons but be careful with comments
    const statements = [];
    let current = '';
    for (const line of ddl.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('--')) continue;
      current += line + '\n';
      if (trimmed.endsWith(';')) {
        const clean = current.replace(/--[^\n]*/g, '').trim();
        if (clean && clean !== ';') {
          statements.push(current.trim());
        }
        current = '';
      }
    }
    
    let executed = 0;
    for (const stmt of statements) {
      try {
        await client.query(stmt);
        executed++;
      } catch (err) {
        const msg = err.message || '';
        if (msg.includes('does not exist') || msg.includes('already exists')) continue;
        console.error(`[V8] Error: ${msg}`);
        console.error(`  Statement: ${stmt.substring(0, 120)}...`);
        throw err;
      }
    }
    console.log(`[V8] DDL complete: ${executed} statements`);

    // Verify tables
    const tablesResult = await client.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);
    console.log('\n[V8] Tables:');
    tablesResult.rows.forEach(r => console.log(`  ✓ ${r.tablename}`));

    const viewsResult = await client.query(`
      SELECT viewname FROM pg_views WHERE schemaname = 'public' ORDER BY viewname
    `);
    console.log('\n[V8] Views:');
    viewsResult.rows.forEach(r => console.log(`  ✓ ${r.viewname}`));

    // Load backup data
    const backupPath = path.resolve('f:/10. Code/QCAG-Production Main/backup.sql');
    if (fs.existsSync(backupPath)) {
      console.log('\n[V8] Loading backup data...');
      const backup = fs.readFileSync(backupPath, 'utf8');
      const lines = backup.split('\n');
      let inCopy = false;
      let copyTarget = '';
      let copyColumns = '';
      let copyRows = [];
      let rowCounts = {};
      let errorCounts = {};
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (line.startsWith('COPY ')) {
          const match = line.match(/^COPY\s+(\w+)\s*\(([^)]+)\)\s+FROM\s+stdin/i);
          if (match) {
            inCopy = true;
            copyTarget = match[1];
            copyColumns = match[2];
            copyRows = [];
          }
          continue;
        }
        
        if (inCopy) {
          if (line === '\\.') {
            if (copyRows.length > 0) {
              const cols = copyColumns.split(',').map(c => c.trim());
              let inserted = 0;
              
              for (const row of copyRows) {
                const values = row.split('\t').map(v => v === '\\N' ? null : v);
                if (values.length !== cols.length) continue;
                
                const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(',');
                const sql = `INSERT INTO ${copyTarget} (${cols.join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
                
                try {
                  await client.query(sql, values);
                  inserted++;
                } catch (err) {
                  if (!errorCounts[copyTarget]) errorCounts[copyTarget] = 0;
                  errorCounts[copyTarget]++;
                }
              }
              rowCounts[copyTarget] = (rowCounts[copyTarget] || 0) + inserted;
            }
            inCopy = false;
            continue;
          }
          copyRows.push(line);
          continue;
        }
      }
      
      console.log('\n[V8] Data loaded:');
      Object.entries(rowCounts).sort().forEach(([table, count]) => {
        const errCount = errorCounts[table] || 0;
        const suffix = errCount > 0 ? ` (${errCount} skipped)` : '';
        console.log(`  ${table}: ${count} rows${suffix}`);
      });
    }

    // Final counts
    console.log('\n[V8] Final row counts:');
    for (const row of tablesResult.rows) {
      try {
        const c = await client.query(`SELECT COUNT(*) AS c FROM ${row.tablename}`);
        console.log(`  ${row.tablename}: ${c.rows[0].c}`);
      } catch (e) {
        console.log(`  ${row.tablename}: error`);
      }
    }

    console.log('\n✅ [V8] Schema deployment complete!');
  } finally {
    await client.end();
  }
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
