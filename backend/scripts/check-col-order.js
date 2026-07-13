// check-col-order.js — Verify actual CSV column positions
const fs = require('fs');

const raw = fs.readFileSync('scripts/data/quotations.csv', 'utf8')
  .replace(/\r\n/g, '\n').replace(/\r/g, '\n');

// Fix the ,"N, pattern
let fixed = raw.replace(/,"N,/g, ',,').replace(/,"N\n/g, ',\n');

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

const lines = fixed.split('\n').filter(l => l.trim());
const row1 = parseLine(lines[0]);
const row2 = parseLine(lines[1]);
const row3 = parseLine(lines[5]); // row 6 (id=14)

console.log('Row 1 field count:', row1.length);
console.log('\nRow 1 (id=1):');
row1.forEach((v, i) => {
  const preview = v ? (v.length > 60 ? v.substring(0,60)+'...' : v) : 'NULL';
  console.log(`  [${i}]: ${preview}`);
});

console.log('\n\nRow 6 (id=14):');
row3.forEach((v, i) => {
  const preview = v ? (v.length > 60 ? v.substring(0,60)+'...' : v) : 'NULL';
  console.log(`  [${i}]: ${preview}`);
});
