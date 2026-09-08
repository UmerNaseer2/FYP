#!/usr/bin/env node
/**
 * Seeds 4 test schemas into the Neon `neondb` database (the "neon DB ecoms"
 * connection) for manual feature testing. Idempotent — drops + recreates each.
 *
 *   COMPARE pair (no script_patch):  cmp_prod  vs  cmp_dev
 *   VERSION-SYNC pair (with ledger): vs_source (ahead) vs vs_target (behind)
 *
 * Run from my-app/:   node seed-test-schemas.cjs
 * Git-ignored. Holds no secrets — reads DATABASE_URL_A from .env.local.
 */
const { Pool } = require("pg");
const fs = require("fs");

const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

// These schemas must land in the *target* database that the app's Compare /
// Version Sync operate on — i.e. the saved "neon DB ecoms" connection — NOT the
// Supabase metadata DB (DATABASE_URL_A). We read that connection's stored
// connection_string from the metadata DB's `connections` table at runtime.
const metaPool = new Pool({
  connectionString: env.DATABASE_URL_A,
  ssl: { rejectUnauthorized: false },
});

async function targetPool() {
  const r = await metaPool.query(
    "SELECT connection_string FROM connections WHERE name = $1 ORDER BY id LIMIT 1",
    ["neon DB ecoms"]
  );
  if (!r.rows[0]?.connection_string) throw new Error('No connection_string for "neon DB ecoms"');
  return new Pool({ connectionString: r.rows[0].connection_string, ssl: { rejectUnauthorized: false } });
}

// The exact script_patch DDL the app's apply route creates (kept in sync).
const SCRIPT_PATCH_DDL = (schema) => `
  CREATE TABLE ${schema}.script_patch (
    id          SERIAL PRIMARY KEY,
    script_name VARCHAR(150) NOT NULL DEFAULT 'unknown',
    version     VARCHAR(20)  NOT NULL,
    title       VARCHAR(150),
    description TEXT,
    change_type VARCHAR(20)  NOT NULL
                  CHECK (change_type IN ('breaking','additive','patch','unknown')),
    source_ref  TEXT,
    sql_content TEXT,
    applied_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX script_patch_name_version_idx
    ON ${schema}.script_patch (script_name, version);
`;

// ── Version-sync migration ledger (unqualified SQL — search_path scopes it) ──
const SCRIPT_NAME = "inventory_migration";
const V1_SQL = `CREATE TABLE category (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL
);
CREATE TABLE product (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(150) NOT NULL,
  price       NUMERIC(10,2) NOT NULL DEFAULT 0,
  category_id INTEGER REFERENCES category(id)
);`;
const V2_SQL = `CREATE TABLE supplier (
  id    SERIAL PRIMARY KEY,
  name  VARCHAR(150) NOT NULL,
  email VARCHAR(200)
);
ALTER TABLE product ADD COLUMN supplier_id INTEGER REFERENCES supplier(id);`;
const V3_SQL = `ALTER TABLE product ADD COLUMN sku VARCHAR(50);
ALTER TABLE category ADD COLUMN description TEXT;`;

const VERSIONS = [
  { version: "v1.0.0", title: "Create base inventory", change_type: "additive", sql: V1_SQL, applied_at: "2026-01-15 10:00:00" },
  { version: "v2.0.0", title: "Add suppliers",          change_type: "additive", sql: V2_SQL, applied_at: "2026-02-15 10:00:00" },
  { version: "v3.0.0", title: "Add SKU + category notes", change_type: "patch",  sql: V3_SQL, applied_at: "2026-03-15 10:00:00" },
];

async function insertLedgerRow(c, schema, v, descr) {
  await c.query(
    `INSERT INTO ${schema}.script_patch
       (script_name, version, title, description, change_type, source_ref, sql_content, applied_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [SCRIPT_NAME, v.version, v.title, descr, v.change_type, "seed: test data", v.sql, v.applied_at]
  );
}

async function main() {
  const pool = await targetPool();
  const c = await pool.connect();
  try {
    const who = await c.query("SELECT current_database() db");
    console.log("Seeding into target DB:", who.rows[0].db, "(neon DB ecoms)\n");
    // ── Reset ────────────────────────────────────────────────────────────
    for (const s of ["cmp_prod", "cmp_dev", "vs_source", "vs_target"]) {
      await c.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
      await c.query(`CREATE SCHEMA ${s}`);
    }

    // ── 1. COMPARE pair (no script_patch) ─────────────────────────────────
    // Baseline: a simple blog.
    await c.query(`
      CREATE TABLE cmp_prod.author (
        id    SERIAL PRIMARY KEY,
        name  VARCHAR(120) NOT NULL,
        email VARCHAR(200) NOT NULL
      );
      CREATE TABLE cmp_prod.post (
        id         SERIAL PRIMARY KEY,
        author_id  INTEGER REFERENCES cmp_prod.author(id),
        title      VARCHAR(200) NOT NULL,
        body       TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE cmp_prod.tag (
        id    SERIAL PRIMARY KEY,
        label VARCHAR(60) NOT NULL
      );
    `);
    // Evolved: + comment table, + bio/published columns, name→full_name rename,
    // title widened 200→300. Exercises add-table / add-column / rename / type-change.
    await c.query(`
      CREATE TABLE cmp_dev.author (
        id        SERIAL PRIMARY KEY,
        full_name VARCHAR(120) NOT NULL,
        email     VARCHAR(200) NOT NULL,
        bio       TEXT
      );
      CREATE TABLE cmp_dev.post (
        id         SERIAL PRIMARY KEY,
        author_id  INTEGER REFERENCES cmp_dev.author(id),
        title      VARCHAR(300) NOT NULL,
        body       TEXT,
        published  BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE cmp_dev.tag (
        id    SERIAL PRIMARY KEY,
        label VARCHAR(60) NOT NULL
      );
      CREATE TABLE cmp_dev.comment (
        id         SERIAL PRIMARY KEY,
        post_id    INTEGER REFERENCES cmp_dev.post(id),
        body       TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ── 2. VERSION-SYNC pair (with script_patch) ──────────────────────────
    // Source — fully migrated through v3.0.0.
    await c.query(`SET search_path TO vs_source, public`);
    await c.query(V1_SQL);
    await c.query(V2_SQL);
    await c.query(V3_SQL);
    await c.query(`RESET search_path`);
    await c.query(SCRIPT_PATCH_DDL("vs_source"));
    for (const v of VERSIONS) {
      await insertLedgerRow(c, "vs_source", v, "Applied in source (ahead).");
    }

    // Target — migrated only through v1.0.0. Missing supplier/supplier_id/sku/description.
    await c.query(`SET search_path TO vs_target, public`);
    await c.query(V1_SQL);
    await c.query(`RESET search_path`);
    await c.query(SCRIPT_PATCH_DDL("vs_target"));
    await insertLedgerRow(c, "vs_target", VERSIONS[0], "Applied in target (behind).");

    // ── Report ────────────────────────────────────────────────────────────
    const counts = await c.query(`
      SELECT table_schema, count(*) AS tables
      FROM information_schema.tables
      WHERE table_schema IN ('cmp_prod','cmp_dev','vs_source','vs_target')
      GROUP BY table_schema ORDER BY table_schema
    `);
    console.log("Seeded schemas (table counts):");
    for (const r of counts.rows) console.log(`  ${r.table_schema.padEnd(12)} ${r.tables} tables`);
    const led = await c.query(`
      SELECT 'vs_source' s, count(*) n FROM vs_source.script_patch
      UNION ALL SELECT 'vs_target', count(*) FROM vs_target.script_patch
    `);
    console.log("Ledger rows:");
    for (const r of led.rows) console.log(`  ${r.s.padEnd(12)} ${r.n} versions`);
    console.log("\nDone.");
  } finally {
    c.release();
    await pool.end();
    await metaPool.end();
  }
}

main().catch((e) => {
  console.error("SEED FAILED:", e.message);
  process.exit(1);
});
