// scripts/fix-huynh.js
'use strict';

const db = require('../db');

async function run() {
  try {
    console.log('=== FIXING HUYNH MISSPELLINGS IN DB ===');
    
    // We will clean:
    // - outlet_name
    // - address
    // - items (TEXT or JSONB)
    // - comments (TEXT or JSONB)
    // - requester (TEXT or JSONB)
    // - content
    // - old_content_extra

    // 1. Update text columns
    const textCols = ['outlet_name', 'address', 'content', 'old_content_extra'];
    for (const col of textCols) {
      console.log(`Processing text column: ${col}...`);
      const checkRes = await db.query(`
        SELECT count(*) FROM ks_requests 
        WHERE ${col} ILIKE '%hùynh%'
      `);
      const count = checkRes.rows[0].count;
      console.log(`Found ${count} rows to update in ${col}.`);
      
      if (Number(count) > 0) {
        const updateRes = await db.query(`
          UPDATE ks_requests 
          SET ${col} = REPLACE(REPLACE(REPLACE(${col}, 'Hùynh', 'Huỳnh'), 'hùynh', 'huỳnh'), 'HÙYNH', 'HUỲNH')
          WHERE ${col} ILIKE '%hùynh%'
        `);
        console.log(`Updated ${updateRes.rowCount} rows in ${col}.`);
      }
    }

    // 2. Update JSONB/TEXT columns (items, comments, requester)
    // We will cast to text, replace, and cast back to verify compatibility
    const jsonCols = ['items', 'comments', 'requester'];
    for (const col of jsonCols) {
      console.log(`Processing json/text column: ${col}...`);
      const checkRes = await db.query(`
        SELECT count(*) FROM ks_requests 
        WHERE ${col}::text ILIKE '%hùynh%'
      `);
      const count = checkRes.rows[0].count;
      console.log(`Found ${count} rows to update in ${col}.`);
      
      if (Number(count) > 0) {
        // Find column type in database to construct proper update query
        const typeRes = await db.query(`
          SELECT data_type FROM information_schema.columns 
          WHERE table_name = 'ks_requests' AND column_name = '${col}'
        `);
        const dataType = typeRes.rows[0]?.data_type || 'text';
        console.log(`Column ${col} data type is ${dataType}`);
        
        let queryStr = '';
        if (dataType.toLowerCase().includes('json')) {
          queryStr = `
            UPDATE ks_requests 
            SET ${col} = (REPLACE(REPLACE(REPLACE(${col}::text, 'Hùynh', 'Huỳnh'), 'hùynh', 'huỳnh'), 'HÙYNH', 'HUỲNH'))::${dataType}
            WHERE ${col}::text ILIKE '%hùynh%'
          `;
        } else {
          queryStr = `
            UPDATE ks_requests 
            SET ${col} = REPLACE(REPLACE(REPLACE(${col}, 'Hùynh', 'Huỳnh'), 'hùynh', 'huỳnh'), 'HÙYNH', 'HUỲNH')
            WHERE ${col} ILIKE '%hùynh%'
          `;
        }
        
        const updateRes = await db.query(queryStr);
        console.log(`Updated ${updateRes.rowCount} rows in ${col}.`);
      }
    }

    // 3. Update ks_users table names
    console.log('Processing ks_users table...');
    const userCheck = await db.query("SELECT count(*) FROM ks_users WHERE name ILIKE '%hùynh%'");
    const userCount = userCheck.rows[0].count;
    console.log(`Found ${userCount} users with misspelled name.`);
    if (Number(userCount) > 0) {
      const userUpdate = await db.query(`
        UPDATE ks_users 
        SET name = REPLACE(REPLACE(REPLACE(name, 'Hùynh', 'Huỳnh'), 'hùynh', 'huỳnh'), 'HÙYNH', 'HUỲNH')
        WHERE name ILIKE '%hùynh%'
      `);
      console.log(`Updated ${userUpdate.rowCount} rows in ks_users.`);
    }

    console.log('=== COMPLETED SUCCESSFULLY ===');
  } catch (err) {
    console.error('Error executing migration:', err);
  } finally {
    process.exit(0);
  }
}

run();
