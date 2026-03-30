// debug-csv-row.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const raw = fs.readFileSync(path.join('scripts/data/quotations.csv'), 'utf8')
  .replace(/\r\n/g, '\n').replace(/\r/g, '\n');

function fixNulls(s) {
  s = s.replace(/,"N,/g, ',,');
  s = s.replace(/,"N(\n)/g, ',$1');
  return s;
}

const cols = ['id','quote_code','images','qcag_image_url','qcag_override_status',
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
          if (line[i+1] === '"') { v += '"'; i += 2; }
          else { i++; break; }
        } else { v += line[i++]; }
      }
      fields.push(v || null);
      if (line[i] === ',') i++;
    } else {
      const e = line.indexOf(',', i);
      if (e < 0) { fields.push(line.slice(i) || null); break; }
      fields.push(line.slice(i, e) || null);
      i = e + 1;
    }
  }
  return fields;
}

const lines = fixNulls(raw).split('\n').filter(l => l.trim());
console.log('Total lines:', lines.length);

// Check rows 6, 62, 120 (1-indexed → 0-indexed: 5, 61, 119)
for (const idx of [5, 61, 119]) {
  if (!lines[idx]) continue;
  const row = parseLine(lines[idx]);
  console.log(`\n=== Row ${idx+1} (id=${row[0]}) ===`);
  cols.forEach((c, i) => {
    const v = row[i];
    if (v && v.length > 200) {
      console.log(`  ${c} (LEN=${v.length}): "${v.substring(0, 80)}..."`);
    }
  });
}
