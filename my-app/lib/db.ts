// import { Pool } from "pg";

//const pool = new Pool({
  //host: process.env.DB_HOST || "localhost",
  //port: Number(process.env.DB_PORT) || 5432,
  //database: process.env.DB_NAME || "script_registry",
  //user: process.env.DB_USER || "postgres",
  //password: process.env.DB_PASSWORD || "1234",
//});

//export default pool;

import { Pool } from "pg";

const pool = new Pool({
  host: "localhost",
  port: 5432,
  database: "postgres",
  user: "postgres",
  password: "1234", //Real Postgred Password
});

export default pool;