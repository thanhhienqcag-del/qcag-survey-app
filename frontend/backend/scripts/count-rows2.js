const fs = require('fs');
const sql = fs.readFileSync('f:/10. Code/QCAG APP/backend-qcag-app/scripts/data/quotations.sql', 'utf8');

// Find first INSERT statement  
const firstInsert = sql.indexOf('INSERT INTO `quotations` VALUES');
const sectionStart = firstInsert + 'INSERT INTO `quotations` VALUES'.length;

// Manually walk to find where the INSERT block ends (matching ; at depth 0 outside quotes)
let inStr = false, i = sectionStart;
let parenDepth = 0;
let rowCount = 0;
let firstSemicolon = -1;
while (i < sql.length) {
  const ch = sql[i];
  if (!inStr) {
    if (ch === "'") inStr = true;
    else if (ch === '(') parenDepth++;
    else if (ch === ')') {
      parenDepth--;
      if (parenDepth === 0) rowCount++;
    } else if (ch === ';' && parenDepth === 0) {
      firstSemicolon = i;
      break;
    }
  } else {
    if (ch === '\\') i++;
    else if (ch === "'") inStr = false;
  }
  i++;
}

console.log('First INSERT block: rows counted =', rowCount);
console.log('Block length:', firstSemicolon - sectionStart, 'chars');
console.log('End char at:', firstSemicolon, '/ total length:', sql.length);

// Check if there are more INSERTs after
const remaining = sql.indexOf('INSERT INTO `quotations` VALUES', firstSemicolon);
console.log('Next INSERT at:', remaining, '(>0 means more blocks)');

// Count all INSERT blocks properly
let pos = 0;
let blockCount = 0;
let totalRows = 0;
while (true) {
  const idx = sql.indexOf("INSERT INTO `quotations` VALUES", pos);
  if (idx === -1) break;
  blockCount++;
  let bInStr = false, bDepth = 0, bRows = 0, bi = idx + "INSERT INTO `quotations` VALUES".length;
  while (bi < sql.length) {
    const ch = sql[bi];
    if (!bInStr) {
      if (ch === "'") bInStr = true;
      else if (ch === '(') bDepth++;
      else if (ch === ')') { bDepth--; if (bDepth === 0) bRows++; }
      else if (ch === ';' && bDepth === 0) { bi++; break; }
    } else {
      if (ch === '\\') bi++;
      else if (ch === "'") bInStr = false;
    }
    bi++;
  }
  console.log(`Block ${blockCount}: ${bRows} rows`);
  totalRows += bRows;
  pos = bi;
}

console.log('\nTotal blocks:', blockCount, '| Total rows:', totalRows);
