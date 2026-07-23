// debug-mapping.js  — Find rows with out-of-range values
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

const COLS = ['id','quote_code','images','qcag_image_url','qcag_override_status',
  'qcag_note','qcag_at','created_at','outlet_code','outlet_name','spo_name',
  'area','outlet_phone','sale_type','sale_code','sale_name','sale_phone',
  'ss_name','house_number','street','ward','district','province','address',
  'items','total_amount','spo_number','spo_status','notes','qcag_status',
  'qcag_order_number','order_number','updated_at','due_date','responsibles',
  'is_confirmed','last_confirmed_at','edit_history','is_exported',
  'exported_at','created_by','created_by_name','qc_signage_state'];

function parseLine(line) {
  const fields = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) { fields.push(null); break; }
    if (line[i] === '"') {
      i++;
      let v = '';
      while (i < line.length) {
        if (line[i] === '"') {
          if (i+1 < line.length && line[i+1] === '"') { v += '"'; i += 2; }
          else { i++; break; }
        } else { v += line[i++]; }
      }
      while (i < line.length && line[i] !== ',') i++;
      fields.push(v === '' ? null : v);
      if (i < line.length && line[i] === ',') i++;
    } else {
      let end = line.length;
      for (let j = i; j < line.length; j++) { if (line[j] === ',') { end = j; break; } }
      const raw = line.slice(i, end);
      fields.push((raw === 'N' || raw === '') ? null : raw);
      i = end;
      if (i < line.length && line[i] === ',') i++;
    }
  }
  return fields;
}

const raw = fs.readFileSync(path.join(DATA_DIR, 'quotations.csv'), 'utf8').replace(/\r\n/g, '\n');
const lines = raw.split('\n').filter(l => l.trim());

// Check rows 15 and 48 (0-indexed: 14, 47)
for (const idx of [14, 47]) {
  const row = parseLine(lines[idx]);
  const obj = {};
  COLS.forEach((c, i) => { obj[c] = row[i]; });
  console.log(`\n=== Row ${idx+1} (id=${row[0]}) fields: ${row.length} ===`);
  // Show suspicious fields
  ['qcag_at','created_at','updated_at','is_confirmed','last_confirmed_at',
   'is_exported','exported_at','created_by','created_by_name','qc_signage_state',
   'spo_number','order_number','qcag_order_number'].forEach(c => {
    const v = obj[c];
    if (v) console.log(`  ${c}: ${JSON.stringify(v).slice(0, 80)}`);
  });
}

// Count errors we'd get
let overflowVarchar = 0;
for (const line of lines) {
  const row = parseLine(line);
  const obj = {};
  COLS.forEach((c, i) => { obj[c] = row[i]; });
  // varchar(128) fields
  for (const col of ['outlet_code','sale_code','spo_number','order_number','qcag_order_number','created_by']) {
    if (obj[col] && obj[col].length > 128) {
      overflowVarchar++;
      console.log(`id=${row[0]} ${col}(${obj[col].length}): ${obj[col].slice(0,60)}`);
      break;
    }
  }
}
console.log(`\nTotal varchar overflow rows: ${overflowVarchar}`);
