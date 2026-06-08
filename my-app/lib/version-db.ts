import { Pool } from "pg";

declare global {
  var __connectionsPgPool: Pool | undefined;
}

const connectionString = process.env.DATABASE_URL_A;

if (!connectionString) {
  throw new Error("DATABASE_URL_A is missing in .env.local");
}

const pool =
  globalThis.__connectionsPgPool ??
  new Pool({
    connectionString,
    max: 5,
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__connectionsPgPool = pool;
}

export default pool;