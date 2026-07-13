/**
 * fix-csv-multiline.js
 *
 * Cloud SQL CSV export embeds literal \n inside JSON fields.
 * This causes single records to span multiple lines.
 * This script reassembles multi-line records back into single lines.
 *
 * A valid record start: first field is an integer (id).
 * Strategy: join lines that don't start with a digit + comma pattern.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

function fixCsvMultiline(inputFile, outputFile) {
  const raw = fs.readFileSync(path.join(DATA_DIR, inputFile), 'utf8');
  // Normalize line endings
  const content = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = content.split('\n');
  
  console.log(`Input: ${inputFile}, raw lines: ${lines.length}`);

  // A record starts with: digit(s), comma
  const RECORD_START = /^\d+,/;
  
  const records = [];
  let current = null;
  
  for (const line of lines) {
    if (!line.trim()) continue;
    
    if (RECORD_START.test(line)) {
      // This is the start of a new record
      if (current !== null) records.push(current);
      current = line;
    } else {
      // This is a continuation of the current record (multiline field)
      if (current !== null) {
        // Replace the \n with a space or \\n to avoid breaking CSV
        current = current + '\\n' + line;
      }
    }
  }
  if (current !== null) records.push(current);
  
  console.log(`Output: ${records.length} records`);
  
  // Verify: count fields in first record
  const firstParsed = parseFields(records[0]);
  console.log(`First record field count: ${firstParsed.length}`);
  
  fs.writeFileSync(path.join(DATA_DIR, outputFile), records.join('\n') + '\n', 'utf8');
  console.log(`Written: ${outputFile}\n`);
}

function parseFields(line) {
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
      fields.push(v);
      if (i < line.length && line[i] === ',') i++;
    } else {
      let end = line.length;
      for (let j = i; j < line.length; j++) { if (line[j] === ',') { end = j; break; } }
      fields.push(line.slice(i, end));
      i = end;
      if (i < line.length && line[i] === ',') i++;
    }
  }
  return fields;
}

// Process quotations.csv (the biggest file with multiline issues)
fixCsvMultiline('quotations.csv', 'quotations_fixed.csv');
fixCsvMultiline('production_orders.csv', 'production_orders_fixed.csv');
fixCsvMultiline('pending_orders.csv', 'pending_orders_fixed.csv');

console.log('Done! Use *_fixed.csv files for import.');
