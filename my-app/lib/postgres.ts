import { parseIntoClientConfig } from "pg-connection-string";
import type { ClientConfig } from "pg";
import { Pool } from "pg";

declare global {
  var __comparePgPoolMap: Map<string, Pool> | undefined;
}

function poolMap(): Map<string, Pool> {
  if (!globalThis.__comparePgPoolMap) {
    globalThis.__comparePgPoolMap = new Map();
  }
  return globalThis.__comparePgPoolMap;
}

function poolKey(cfg: ClientConfig): string {
  return [
    cfg.host ?? "",
    String(cfg.port ?? ""),
    cfg.database ?? "",
    cfg.user ?? "",
    cfg.password ?? "",
  ].join("\0");
}

export function getPoolForConfig(cfg: ClientConfig): Pool {
  const key = poolKey(cfg);
  const map = poolMap();
  let p = map.get(key);
  if (!p) {
    p = new Pool({ ...cfg, max: 4 });
    map.set(key, p);
  }
  return p;
}

function normalizeDefinition(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function coerceTextArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
  }

  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "{}") {
    return [];
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) {
      return [];
    }

    return inner
      .split(",")
      .map((entry) => entry.replace(/^"(.*)"$/, "$1").trim())
      .filter((entry) => entry.length > 0);
  }

  return [trimmed];
}

function formatAction(code: string | null): string {
  switch (code) {
    case "a":
      return "NO ACTION";
    case "r":
      return "RESTRICT";
    case "c":
      return "CASCADE";
    case "n":
      return "SET NULL";
    case "d":
      return "SET DEFAULT";
    default:
      return "UNKNOWN";
  }
}

export type CompareTarget = {
  id: "a" | "b";
  config: ClientConfig;
  displayName: string;
};

export type ColumnSnapshot = {
  name: string;
  ordinalPosition: number;
  typeDisplay: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  uniqueConstraintNames: string[];
  foreignKeyConstraintNames: string[];
};

export type ConstraintKind =
  | "PRIMARY KEY"
  | "UNIQUE"
  | "CHECK"
  | "EXCLUDE";

export type ConstraintSnapshot = {
  name: string;
  kind: ConstraintKind;
  columns: string[];
  definition: string;
  normalizedDefinition: string;
};

export type ForeignKeySnapshot = {
  name: string;
  kind: "FOREIGN KEY";
  columns: string[];
  definition: string;
  normalizedDefinition: string;
  referencedSchema: string | null;
  referencedTable: string | null;
  referencedColumns: string[];
  onUpdate: string;
  onDelete: string;
};

export type TableSnapshot = {
  name: string;
  columns: ColumnSnapshot[];
  primaryKey: ConstraintSnapshot | null;
  uniqueConstraints: ConstraintSnapshot[];
  foreignKeys: ForeignKeySnapshot[];
  checkConstraints: ConstraintSnapshot[];
  excludeConstraints: ConstraintSnapshot[];
};

export type SchemaSnapshot = {
  database: string;
  schema: string;
  tables: TableSnapshot[];
};

type ConstraintRow = {
  table_name: string;
  constraint_name: string;
  contype: "p" | "u" | "f" | "c" | "x";
  definition: string;
  columns: string[] | null;
  referenced_schema: string | null;
  referenced_table: string | null;
  referenced_columns: string[] | null;
  confupdtype: string | null;
  confdeltype: string | null;
};

function trimEnv(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : undefined;
}

/**
 * Two ways to configure:
 * 1) DATABASE_URL_A + DATABASE_URL_B — full URLs, possibly different hosts/users.
 * 2) DATABASE_URL (or DATABASE_URL_A) only — same server/user/password; opens
 *    COMPARE_DATABASE_A (default "postgres") and COMPARE_DATABASE_B (default "TEST").
 */
export function resolveCompareTargets():
  | { ok: true; a: CompareTarget; b: CompareTarget }
  | { ok: false; error: string } {
  const urlA = trimEnv("DATABASE_URL_A") || trimEnv("DATABASE_URL");
  const urlB = trimEnv("DATABASE_URL_B");

  if (!urlA) {
    return {
      ok: false,
      error:
        "Set DATABASE_URL in .env.local (or DATABASE_URL_A + DATABASE_URL_B for two full URLs).",
    };
  }

  try {
    if (urlB) {
      const cfgA = parseIntoClientConfig(urlA);
      const cfgB = parseIntoClientConfig(urlB);
      return {
        ok: true,
        a: {
          id: "a",
          config: cfgA,
          displayName: cfgA.database ?? "database A",
        },
        b: {
          id: "b",
          config: cfgB,
          displayName: cfgB.database ?? "database B",
        },
      };
    }

    const base = parseIntoClientConfig(urlA);
    const dbA = trimEnv("COMPARE_DATABASE_A") || "postgres";
    const dbB = trimEnv("COMPARE_DATABASE_B") || "TEST";
    const cfgA = { ...base, database: dbA };
    const cfgB = { ...base, database: dbB };
    return {
      ok: true,
      a: { id: "a", config: cfgA, displayName: dbA },
      b: { id: "b", config: cfgB, displayName: dbB },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Invalid connection URL: ${message}` };
  }
}

export async function fetchSchemaNames(
  cfg: ClientConfig
): Promise<{ ok: true; data: string[] } | { ok: false; error: string }> {
  const pool = getPoolForConfig(cfg);

  try {
    const result = await pool.query<{ schema_name: string }>(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name <> 'information_schema'
         AND schema_name NOT LIKE 'pg_%'
       ORDER BY schema_name`
    );

    return {
      ok: true,
      data: result.rows.map((row) => row.schema_name),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

export async function fetchSchemaSnapshot(
  cfg: ClientConfig,
  schemaName: string
): Promise<{ ok: true; data: SchemaSnapshot } | { ok: false; error: string }> {
  const pool = getPoolForConfig(cfg);
  const database = cfg.database ?? "(unknown)";

  type TableRow = {
    table_name: string;
  };

  type ColumnRow = {
    table_name: string;
    column_name: string;
    ordinal_position: number;
    type_display: string;
    is_nullable: boolean;
  };

  try {
    const [tableResult, columnResult, constraintResult] = await Promise.all([
      pool.query<TableRow>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1
           AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        [schemaName]
      ),
      pool.query<ColumnRow>(
        `SELECT
           c.table_name,
           c.column_name,
           c.ordinal_position,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS type_display,
           (c.is_nullable = 'YES') AS is_nullable
         FROM information_schema.columns c
         JOIN pg_namespace n
           ON n.nspname = c.table_schema
         JOIN pg_class cls
           ON cls.relnamespace = n.oid
          AND cls.relname = c.table_name
          AND cls.relkind = 'r'
         JOIN pg_attribute a
           ON a.attrelid = cls.oid
          AND a.attname = c.column_name
          AND a.attnum > 0
          AND NOT a.attisdropped
         WHERE c.table_schema = $1
         ORDER BY c.table_name, c.ordinal_position`,
        [schemaName]
      ),
      pool.query<ConstraintRow>(
        `SELECT
           tbl.relname AS table_name,
           con.conname AS constraint_name,
           con.contype,
           pg_get_constraintdef(con.oid, true) AS definition,
           COALESCE(
             array_agg(att.attname ORDER BY key_cols.ordinality)
             FILTER (WHERE att.attname IS NOT NULL),
             ARRAY[]::text[]
           ) AS columns,
           ref_ns.nspname AS referenced_schema,
           ref_tbl.relname AS referenced_table,
           COALESCE(
             array_agg(ref_att.attname ORDER BY ref_cols.ordinality)
             FILTER (WHERE ref_att.attname IS NOT NULL),
             ARRAY[]::text[]
           ) AS referenced_columns,
           con.confupdtype,
           con.confdeltype
         FROM pg_constraint con
         JOIN pg_class tbl
           ON tbl.oid = con.conrelid
         JOIN pg_namespace ns
           ON ns.oid = tbl.relnamespace
         LEFT JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_cols(attnum, ordinality)
           ON true
         LEFT JOIN pg_attribute att
           ON att.attrelid = tbl.oid
          AND att.attnum = key_cols.attnum
         LEFT JOIN pg_class ref_tbl
           ON ref_tbl.oid = con.confrelid
         LEFT JOIN pg_namespace ref_ns
           ON ref_ns.oid = ref_tbl.relnamespace
         LEFT JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS ref_cols(attnum, ordinality)
           ON ref_cols.ordinality = key_cols.ordinality
         LEFT JOIN pg_attribute ref_att
           ON ref_att.attrelid = ref_tbl.oid
          AND ref_att.attnum = ref_cols.attnum
         WHERE ns.nspname = $1
           AND con.contype IN ('p', 'u', 'f', 'c', 'x')
         GROUP BY
           tbl.relname,
           con.conname,
           con.contype,
           con.oid,
           ref_ns.nspname,
           ref_tbl.relname,
           con.confupdtype,
           con.confdeltype
         ORDER BY tbl.relname, con.contype, con.conname`,
        [schemaName]
      ),
    ]);

    const tablesByName = new Map<string, TableSnapshot>();

    for (const row of tableResult.rows) {
      tablesByName.set(row.table_name, {
        name: row.table_name,
        columns: [],
        primaryKey: null,
        uniqueConstraints: [],
        foreignKeys: [],
        checkConstraints: [],
        excludeConstraints: [],
      });
    }

    for (const row of columnResult.rows) {
      const table = tablesByName.get(row.table_name);
      if (!table) {
        continue;
      }

      table.columns.push({
        name: row.column_name,
        ordinalPosition: row.ordinal_position,
        typeDisplay: row.type_display,
        nullable: row.is_nullable,
        isPrimaryKey: false,
        uniqueConstraintNames: [],
        foreignKeyConstraintNames: [],
      });
    }

    for (const row of constraintResult.rows) {
      const table = tablesByName.get(row.table_name);
      if (!table) {
        continue;
      }

      const columns = coerceTextArray(row.columns);
      const definition = row.definition;
      const normalizedDefinition = normalizeDefinition(definition);

      if (row.contype === "p") {
        table.primaryKey = {
          name: row.constraint_name,
          kind: "PRIMARY KEY",
          columns,
          definition,
          normalizedDefinition,
        };

        for (const name of columns) {
          const column = table.columns.find((entry) => entry.name === name);
          if (column) {
            column.isPrimaryKey = true;
          }
        }
        continue;
      }

      if (row.contype === "u") {
        table.uniqueConstraints.push({
          name: row.constraint_name,
          kind: "UNIQUE",
          columns,
          definition,
          normalizedDefinition,
        });

        for (const name of columns) {
          const column = table.columns.find((entry) => entry.name === name);
          if (column) {
            column.uniqueConstraintNames.push(row.constraint_name);
          }
        }
        continue;
      }

      if (row.contype === "f") {
        const foreignKey: ForeignKeySnapshot = {
          name: row.constraint_name,
          kind: "FOREIGN KEY",
          columns,
          definition,
          normalizedDefinition,
          referencedSchema: row.referenced_schema,
          referencedTable: row.referenced_table,
          referencedColumns: coerceTextArray(row.referenced_columns),
          onUpdate: formatAction(row.confupdtype),
          onDelete: formatAction(row.confdeltype),
        };
        table.foreignKeys.push(foreignKey);

        for (const name of columns) {
          const column = table.columns.find((entry) => entry.name === name);
          if (column) {
            column.foreignKeyConstraintNames.push(row.constraint_name);
          }
        }
        continue;
      }

      const constraint: ConstraintSnapshot = {
        name: row.constraint_name,
        kind: row.contype === "c" ? "CHECK" : "EXCLUDE",
        columns,
        definition,
        normalizedDefinition,
      };

      if (row.contype === "c") {
        table.checkConstraints.push(constraint);
      } else {
        table.excludeConstraints.push(constraint);
      }
    }

    for (const table of tablesByName.values()) {
      table.columns.sort((a, b) => a.ordinalPosition - b.ordinalPosition);
      for (const column of table.columns) {
        column.uniqueConstraintNames.sort();
        column.foreignKeyConstraintNames.sort();
      }
      table.uniqueConstraints.sort((a, b) => a.name.localeCompare(b.name));
      table.foreignKeys.sort((a, b) => a.name.localeCompare(b.name));
      table.checkConstraints.sort((a, b) => a.name.localeCompare(b.name));
      table.excludeConstraints.sort((a, b) => a.name.localeCompare(b.name));
    }

    return {
      ok: true,
      data: {
        database,
        schema: schemaName,
        tables: Array.from(tablesByName.values()).sort((a, b) =>
          a.name.localeCompare(b.name)
        ),
      },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}
