// check-fixed-csv.js
const fs = require('fs');
const path = require('path');

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
      fields.push((raw === '' || raw === 'N') ? null : raw);
      i = end;
      if (i < line.length && line[i] === ',') i++;
    }
  }
  return fields;
}

const DATA_DIR = path.join(__dirname, 'data');
const raw = fs.readFileSync(path.join(DATA_DIR, 'quotations_fixed.csv'), 'utf8').replace(/\r\n/g, '\n');
const lines = raw.split('\n').filter(l => l.trim());

console.log('Total records:', lines.length);

// Count field distribution
const fieldCounts = {};
let wrongCount = 0;
for (const line of lines) {
  const n = parseLine(line).length;
  fieldCounts[n] = (fieldCounts[n] || 0) + 1;
  if (n !== 40) wrongCount++;
}
console.log('Field count distribution:', fieldCounts);
console.log('Records with != 40 fields:', wrongCount);

// Show first record detailed
const r1 = parseLine(lines[0]);
console.log('\nFirst record (40 cols expected):');
const COLS = ['id','quote_code','images','qcag_image_url','qcag_override_status',
  'qcag_note','qcag_at','created_at','outlet_code','outlet_name','spo_name',
  'area','outlet_phone','sale_type','sale_code','sale_name','sale_phone',
  'ss_name','house_number','street','ward','district','province','address',
  'items','total_amount','spo_number','spo_status','notes','qcag_status',
  'qcag_order_number','order_number','updated_at','due_date','responsibles',
  'is_confirmed','last_confirmed_at','edit_history','is_exported',
  'exported_at','created_by','created_by_name','qc_signage_state'];
r1.forEach((v, i) => {
  const preview = v ? (v.length > 60 ? v.substring(0,60)+'...' : v) : 'NULL';
  const col = COLS[i] || `[${i}]`;
  console.log(`  ${col}: ${preview}`);
});
