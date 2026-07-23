const fs = require('fs');
const sql = fs.readFileSync('f:/10. Code/QCAG APP/backend-qcag-app/scripts/data/quotations.sql', 'utf8');

// Count INSERT blocks and rows
const re = /INSERT INTO `quotations` VALUES\s*([\s\S]+?);/g;
let m;
let totalItems = 0;
const insertBlocks = [];
while ((m = re.exec(sql)) !== null) {
  const block = m[1];
  let cnt = 0, depth = 0, inStr = false;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (!inStr) {
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) cnt++; }
      else if (ch === "'") inStr = true;
    } else {
      if (ch === '\\') i++;
      else if (ch === "'") inStr = false;
    }
  }
  totalItems += cnt;
  insertBlocks.push(cnt);
}
console.log('INSERT block sizes:', insertBlocks.join(', '));
console.log('Total rows in dump:', totalItems);
