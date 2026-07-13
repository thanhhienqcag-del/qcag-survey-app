const fs = require('fs');
const sql = fs.readFileSync('f:/10. Code/QCAG APP/backend-qcag-app/scripts/data/quotations.sql', 'utf8');

// Find INSERT block
const m = sql.match(/INSERT INTO `quotations` VALUES\s*([\s\S]+?);/);
if (!m) { console.log('No INSERT found'); process.exit(1); }

const block = m[1];
console.log('Block starts with:', block.substring(0, 50));

// Find first row: properly handle quotes
let depth = 0, start = -1, end = -1, inStr = false;
for (let i = 0; i < block.length; i++) {
  const ch = block[i];
  if (!inStr) {
    if (ch === '(') { if (depth === 0) start = i; depth++; }
    else if (ch === ')') { depth--; if (depth === 0) { end = i; break; } }
    else if (ch === "'") { inStr = true; }
  } else {
    if (ch === '\\') i++; // skip escaped char
    else if (ch === "'") inStr = false;
  }
}

const firstRow = block.slice(start, end + 1);
console.log('\nFirst row (first 1000 chars):');
console.log(firstRow.substring(0, 1000));

// Count commas at depth=1 to estimate column count
let cnt = 1, d = 0, iStr = false;
for (let i = 1; i < firstRow.length - 1; i++) {
  const ch = firstRow[i];
  if (!iStr) {
    if (ch === '(') d++;
    else if (ch === ')') d--;
    else if (ch === "'") iStr = true;
    else if (ch === ',' && d === 0) cnt++;
  } else {
    if (ch === '\\') i++;
    else if (ch === "'") iStr = false;
  }
}
console.log('\nEstimated column count:', cnt);
