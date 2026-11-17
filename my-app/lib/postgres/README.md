# lib/postgres

This folder reads a PostgreSQL schema and turns it into a `SchemaSnapshot`: one
plain object that lists the schema's tables, views, sequences, types,
collations, routines, extensions and privileges. Compare, drift checks and
script generation all work from snapshots.

Code outside this folder imports from `@/lib/postgres` (that is `index.ts`).
Files inside the folder import each other directly, never through `index.ts`.

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | The public face. Re-exports only, no logic. |
| `snapshot.ts` | `fetchSchemaSnapshot` (the orchestrator), `fetchSchemaNames`, `MANAGED_SCHEMAS`, `withoutToolTables`. |
| `pool.ts` | One connection pool per target database, and the timeouts (`POOL_MAX`, `getPoolForConfig`). |
| `normalize.ts` | `normalizeDefinition`, `withCurrentNormalization`, `stripSchemaFromExpr`. |
| `helpers.ts` | Small shared helpers (array and text coercion, quoting) and `COMPARE_IGNORED_TABLES`. |
| `types.ts` | Snapshot types for tables and what hangs off them, plus `SchemaSnapshot`. Re-exports `object-types.ts`. |
| `object-types.ts` | Snapshot types for views, sequences, types, collations, routines, extensions, privileges. |
| `snapshot-facts.ts` | Small questions about a snapshot that the browser can ask without pulling in `pg`. |
| `snapshot-format.ts` | The version number of the stored snapshot format. |
| `catalog/` | One file per catalog area. See below. |

## The catalog readers

Each file in `catalog/` covers one area and has the same three parts:

1. A row type: the shape of one row the query returns.
2. A `read...(client, schemaName)` function that holds the SQL and returns the rows.
3. A build step (`build...`, `add...`, `apply...`) that turns rows into snapshot pieces.

| File | Area |
| --- | --- |
| `catalog/tables.ts` | Tables, columns, partitioning and inheritance |
| `catalog/constraints.ts` | Primary key, unique, foreign key, check and exclude constraints |
| `catalog/indexes-triggers.ts` | Indexes and triggers (on tables and on views) |
| `catalog/row-security.ts` | Row-level security switches and policies |
| `catalog/views.ts` | Views and materialized views |
| `catalog/sequences.ts` | Sequences, and handing an owned sequence's settings to its column |
| `catalog/user-types.ts` | Enums, domains, composites and ranges |
| `catalog/collations.ts` | Collations |
| `catalog/extensions.ts` | Extensions |
| `catalog/routines.ts` | Functions and procedures |
| `catalog/privileges.ts` | Owners and grants |

## How a snapshot is read

`fetchSchemaSnapshot(cfg, schemaName)` in `snapshot.ts` does this:

1. Takes a connection from the pool for `cfg`. If that fails it returns
   `{ ok: false, error }`.
2. Opens one `REPEATABLE READ READ ONLY` transaction, so every query sees the
   same instant and nothing can be written. Sets the statement timeout, and
   the lock timeout if the caller asked for one.
3. Runs the fifteen readers one after another, in a fixed order: tables,
   columns, constraints, indexes, triggers, partitioning, row security,
   policies, views, sequences, types, extensions, collations, routines,
   privileges.
4. Commits.
5. Puts the rows together. Order matters here too: columns go in before
   constraints (a constraint marks the columns it covers), and views are built
   before indexes and triggers (both can belong to a view).
6. Sorts everything by name and returns `{ ok: true, data }`.

If anything throws after step 1, the transaction is rolled back and the result
is `{ ok: false, error, code? }`, where `code` is the PostgreSQL error code
when there is one. The connection always goes back to the pool.

## Adding something new to the snapshot

1. Add its type to `types.ts` or `object-types.ts`, and export it from `index.ts`.
2. Add a reader and a build step, in a new `catalog/` file or the one it belongs to.
3. Call both from `fetchSchemaSnapshot`, the reader inside the transaction and
   the build step after the commit.
4. `tests/snapshot-catalog.test.ts` matches queries by their text. Run it, and
   give its fake client rows for the new query if you want to test the build step.
