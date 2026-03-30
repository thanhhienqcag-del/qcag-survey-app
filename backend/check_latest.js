require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query("SELECT COUNT(*) as total, MAX(id) as max_id, MIN(created_at) as oldest, MAX(created_at) as newest FROM quotations").then(r => {
  console.log("Neon:", JSON.stringify(r.rows[0], null, 2));
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); });
