const fs = require('fs');
const tables = ['users','quote_sequences','production_orders','pending_orders','inspections','quotations'];
for (const t of tables) {
  const sql = fs.readFileSync('f:/10. Code/QCAG APP/backend-qcag-app/scripts/data/' + t + '.sql', 'utf8');
  const m = sql.match(/CREATE TABLE[^(]+\(([\s\S]+?)\) ENGINE/);
  if (!m) { console.log(t + ': no CREATE TABLE'); continue; }
  const lines = m[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('`'));
  const names = lines.map(l => { const x = l.match(/`([^`]+)`/); return x ? x[1] : null; }).filter(Boolean);
  console.log(t + ' (' + names.length + ' cols): ' + names.join(', '));
}
