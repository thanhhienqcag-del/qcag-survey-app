// Quick CSV format analysis
const fs = require('fs');
const content = fs.readFileSync('scripts/data/quotations.csv', 'utf8');
const lines = content.split('\n');
console.log('Total lines:', lines.length);

// Analyze first line
const L1 = lines[0];
console.log('\nLine 1 length:', L1.length);
console.log('First 300 chars:', JSON.stringify(L1.substring(0, 300)));

// Count N null pattern
const m1 = (L1.match(/"N,/g) || []).length;
const m2 = (L1.match(/,N,/g) || []).length;
console.log('\n"N, pattern count:', m1);
console.log(',N, pattern count:', m2);

// Find exact positions
let pos = 0;
while (pos < Math.min(L1.length, 1000)) {
  const idx = L1.indexOf('"N,', pos);
  if (idx < 0) break;
  console.log('  "N, at pos', idx, ':', JSON.stringify(L1.substring(idx-5, idx+10)));
  pos = idx + 1;
  if (pos > 500) break;
}
