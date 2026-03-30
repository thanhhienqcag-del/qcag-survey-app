/**
 * import-sql-to-neon.js
 * Parse MySQL SQL dump files and import into Neon PostgreSQL
 * Handles column reordering from MySQL dump → Neon schema
 * 
 * Usage: node scripts/import-sql-to-neon.js
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ── Config ──────────────────────────────────────────────────────────────────
const NEON_URL = process.env.DATABASE_URL ||
  'postgresql://neondb_owner:npg_tC3ymrsEYQk2@ep-floral-pine-a18w14pz-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

const DATA_DIR = path.join(__dirname, 'data');

// ── DB pool ──────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: NEON_URL });

// ── MySQL → Neon column mappings ─────────────────────────────────────────────
const TABLE_MAPS = {
  users: {
    mysql: ['id','username','name','password_hash','role','approved','created_at','updated_at'],
    neon:  ['id','username','name','password_hash','role','approved','created_at','updated_at'],
  },
  quote_sequences: {
    mysql: ['year','current_value','updated_at'],
    neon:  ['year','current_value','updated_at'],
    pk: 'year',
  },
  quotations: {
    mysql: ['id','quote_code','images','qcag_image_url','qcag_override_status','qcag_note','qcag_at','created_at','outlet_code','outlet_name','spo_name','area','outlet_phone','sale_type','sale_code','sale_name','sale_phone','ss_name','house_number','street','ward','district','province','address','items','total_amount','spo_number','spo_status','notes','qcag_status','qcag_order_number','order_number','updated_at','due_date','responsibles','is_confirmed','last_confirmed_at','edit_history','is_exported','exported_at','created_by','created_by_name','qc_signage_state'],
    neon:  ['id','quote_code','outlet_code','outlet_name','spo_name','area','outlet_phone','sale_type','sale_code','sale_name','sale_phone','ss_name','house_number','street','ward','district','province','address','items','images','total_amount','spo_number','spo_status','notes','qcag_status','qcag_order_number','order_number','qcag_image_url','qcag_override_status','qcag_note','qcag_at','due_date','responsibles','is_confirmed','last_confirmed_at','edit_history','is_exported','exported_at','created_by','created_by_name','qc_signage_state','created_at','updated_at'],
  },
  production_orders: {
    mysql: ['id','items','quote_keys','spo_number','order_number','notes','created_at','updated_at','acceptanceImages'],
    neon:  ['id','items','quote_keys','spo_number','order_number','notes','acceptance_images','created_at','updated_at'],
  },
  pending_orders: {
    mysql: ['id','created_by','created_by_name','created_at','quotes','total_points','total_amount','updated_at'],
    neon:  ['id','created_by','created_by_name','created_at','quotes','total_points','total_amount','updated_at'],
  },
  inspections: {
    mysql: ['id','quotation_id','status','note','created_at'],
    neon:  ['id','quotation_id','status','note','created_at'],
  },
};

function buildReorderMap(mysql_cols, neon_cols) {
  return neon_cols.map(nc => mysql_cols.indexOf(nc));
}

// ── MySQL value parser ───────────────────────────────────────────────────────
function parseMySQLRow(rowStr) {
  const inner = rowStr.slice(1, -1);
  const values = [];
  let i = 0;
  const len = inner.length;

  while (i < len) {
    if (inner[i] === ' ' || inner[i] === '\t') { i++; continue; }

    if (inner[i] === "'") {
      let str = '';
      i++;
      while (i < len) {
        if (inner[i] === '\\' && i + 1 < len) {
          const next = inner[i + 1];
          if (next === "'")  str += "'";
          else if (next === '\\') str += '\\';
          else if (next === 'n')  str += '\n';
          else if (next === 'r')  str += '\r';
          else if (next === 't')  str += '\t';
          else if (next === '0')  str += '\0';
          else str += next;
          i += 2;
        } else if (inner[i] === "'") {
          if (i + 1 < len && inner[i + 1] === "'") {
            str += "'"; i += 2;
          } else {
            i++; break;
          }
        } else {
          str += inner[i]; i++;
        }
      }
      values.push(str);
    } else if (inner.substring(i, i + 4) === 'NULL') {
      values.push(null);
      i += 4;
    } else {
      let raw = '';
      while (i < len && inner[i] !== ',') { raw += inner[i]; i++; }
      const n = Number(raw);
      values.push(isNaN(n) || raw === '' ? raw : n);
    }

    if (i < len && inner[i] === ',') i++;
  }

  return values;
}

// ── Extract row strings from VALUES clause ───────────────────────────────────
function extractRows(valuesStr) {
  const rows = [];
  let i = 0;
  const len = valuesStr.length;

  while (i < len) {
    while (i < len && valuesStr[i] !== '(') i++;
    if (i >= len) break;

    let depth = 0, inStr = false, j = i;
    while (j < len) {
      const ch = valuesStr[j];
      if (!inStr) {
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) { j++; break; } }
        else if (ch === "'") inStr = true;
      } else {
        if (ch === '\\') j++;
        else if (ch === "'") inStr = false;
      }
      j++;
    }
    rows.push(valuesStr.slice(i, j));
    i = j;
  }

  return rows;
}

// ── Import one table ──────────────────────────────────────────────────────────
async function importTable(tableName) {
  const sqlFile = path.join(DATA_DIR, `${tableName}.sql`);
  if (!fs.existsSync(sqlFile)) {
    console.log(`  [SKIP] ${tableName}.sql not found`);
    return { inserted: 0, errors: 0 };
  }

  const tableMap = TABLE_MAPS[tableName];
  if (!tableMap) {
    console.log(`  [SKIP] No mapping for ${tableName}`);
    return { inserted: 0, errors: 0 };
  }

  const { mysql: mysqlCols, neon: neonCols, pk = 'id' } = tableMap;
  const reorder = buildReorderMap(mysqlCols, neonCols);

  const colList = neonCols.map(c => `"${c}"`).join(', ');
  const placeholders = neonCols.map((_, i) => `$${i + 1}`).join(', ');
  const insertSQL = `INSERT INTO ${tableName} (${colList}) VALUES (${placeholders}) ON CONFLICT ("${pk}") DO NOTHING`;

  const sqlContent = fs.readFileSync(sqlFile, 'utf8');

  let insertedTotal = 0;
  let errorTotal = 0;

  // Extract INSERT blocks properly (regex ;  breaks on ; inside JSON strings)
  function extractInsertBlocks(sql) {
    const blocks = [];
    let pos = 0;
    const marker = 'INSERT INTO `';
    while (true) {
      const idx = sql.indexOf(marker, pos);
      if (idx === -1) break;
      // Skip to VALUES
      const valIdx = sql.indexOf(' VALUES', idx);
      if (valIdx === -1) break;
      const startValues = valIdx + 7; // after ' VALUES'
      // Walk to find ; at paren depth 0 and outside quotes
      let inStr = false, depth = 0, i = startValues;
      while (i < sql.length) {
        const ch = sql[i];
        if (!inStr) {
          if (ch === "'") inStr = true;
          else if (ch === '(') depth++;
          else if (ch === ')') { depth--; }
          else if (ch === ';' && depth === 0) { i++; break; }
        } else {
          if (ch === '\\') i++;
          else if (ch === "'") inStr = false;
        }
        i++;
      }
      blocks.push(sql.slice(startValues, i - 1).trim()); // trim the trailing ;
      pos = i;
    }
    return blocks;
  }

  const insertBlocks = extractInsertBlocks(sqlContent);
  console.log(`  Found ${insertBlocks.length} INSERT block(s)`);

  const client = await pool.connect();
  try {
    // Clear existing data
    await client.query(`TRUNCATE TABLE ${tableName} CASCADE`);
    console.log(`  Cleared ${tableName}`);

    for (const valuesStr of insertBlocks) {
      const rows = extractRows(valuesStr);
      console.log(`  Found ${rows.length} rows`);

      for (let ri = 0; ri < rows.length; ri++) {
        try {
          const mysqlVals = parseMySQLRow(rows[ri]);

          while (mysqlVals.length < mysqlCols.length) mysqlVals.push(null);

          // Reorder to Neon column order
          const pgVals = reorder.map(mysqlIdx => mysqlIdx === -1 ? null : mysqlVals[mysqlIdx]);

          // Convert MySQL datetime to ISO, and handle special types
          const finalVals = pgVals.map((v, idx) => {
            if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) {
              return v.replace(' ', 'T') + '+00:00';
            }
            // is_confirmed, is_exported are NOT NULL tinyint — default to 0
            const colName = neonCols[idx];
            if ((colName === 'is_confirmed' || colName === 'is_exported' || colName === 'approved') && v === null) {
              return 0;
            }
            return v;
          });

          await client.query(insertSQL, finalVals);
          insertedTotal++;
          if (insertedTotal % 200 === 0) process.stdout.write(`\r  Inserted: ${insertedTotal}...`);

        } catch (err) {
          errorTotal++;
          if (errorTotal <= 10) {
            console.error(`\n  [ERR] Row ${ri + 1}: ${err.message}`);
          }
        }
      }
    }

    // Reset id sequence
    if (pk === 'id') {
      try {
        await client.query(`SELECT setval(pg_get_serial_sequence('${tableName}', 'id'), COALESCE(MAX(id), 1)) FROM ${tableName}`);
      } catch (e) { /* no sequence */ }
    }

    if (insertedTotal > 0) process.stdout.write('\n');
    console.log(`  ✓ ${tableName}: ${insertedTotal} inserted, ${errorTotal} errors`);

  } finally {
    client.release();
  }

  return { inserted: insertedTotal, errors: errorTotal };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== MySQL SQL Dump → Neon PostgreSQL Import ===\n');

  const TABLES = ['users', 'quote_sequences', 'production_orders', 'pending_orders', 'inspections', 'quotations'];
  const results = {};

  for (const table of TABLES) {
    console.log(`\n[${table}]`);
    results[table] = await importTable(table);
  }

  console.log('\n=== SUMMARY ===');
  for (const [t, r] of Object.entries(results)) {
    const status = r.errors === 0 ? '✓' : '⚠';
    console.log(`  ${status} ${t}: ${r.inserted} rows, ${r.errors} errors`);
  }

  await pool.end();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
