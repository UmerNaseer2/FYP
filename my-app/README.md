# Schema Studio

Compare two live PostgreSQL schemas, generate the migration that closes the gap,
version it in a GitHub script registry, and apply it to a target database inside a
transaction — with a per-database ledger recording what was applied and when.

Final-year project, Swinburne Sarawak. This file is the **only** document in the
repository and is the single source of truth for what exists, what does not, and
how to run it. If something here disagrees with a comment in the code, this file
is the one that was checked last.

---

## 1. Running it

Requires Node 22 and a PostgreSQL database to hold the tool's own metadata. The
simplest one is the Postgres in the root `docker-compose.yml` — start only that
service (Docker Desktop must be running), then point `DATABASE_URL_A` at it in
`my-app/.env.local`:

```bash
docker compose up -d db    # from the repository root: Postgres 17 on localhost:5433
```

```
DATABASE_URL_A=postgres://studio:studio@localhost:5433/studio
```

The same server can also be saved on the Connections screen as a database to
compare (host `localhost`, port `5433`, SSL off). `docker compose down` stops it
and keeps the data; `docker compose down -v` deletes the data as well.

```bash
npm install
npm run dev          # http://localhost:3000 → redirects to /studio
```

```bash
npm run build        # production build
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm test             # jest
```

Or bring up Postgres and the app together, from the repository root — this needs
no local Node and creates the metadata database for you:

```bash
docker compose up --build
```

Create `my-app/.env.local` (git-ignored, never commit it):

| Key | Purpose | Required |
| --- | --- | --- |
| `DATABASE_URL_A` | The tool's own metadata database: connections, lineage, snapshots | yes |
| `GITHUB_PAT` | Personal access token with `contents:write` on the script registry repo | yes, for push/pull |
| `GITHUB_REPO_OWNER` | Owner of the registry repo | yes, for push/pull |
| `GITHUB_REPO_NAME` | Name of the registry repo | yes, for push/pull |
| `AZURE_AD_CLIENT_ID` | Microsoft Entra app registration | not yet set — see §5 |
| `AZURE_AD_CLIENT_SECRET` | Microsoft Entra app secret | not yet set — see §5 |
| `AZURE_AD_TENANT_ID` | Microsoft Entra tenant | not yet set — see §5 |
| `NEXTAUTH_SECRET` | Session encryption key | not yet set — see §5 |
| `DRIFT_SCHEDULER` | `off` stops the background drift loop; anything else leaves it on | no, defaults to on |

Metadata tables are created on first use by `ensureMetadataSchema()`; there is no
separate migration step for the tool's own storage.

`scripts/seed-test-schemas.cjs` seeds four throwaway schemas (`cmp_prod`/`cmp_dev`
for compare, `vs_source`/`vs_target` for version sync) into a saved target
connection. It reads `DATABASE_URL_A` from `.env.local` and embeds no credentials.

```bash
node scripts/seed-test-schemas.cjs
```

---

## 2. What the app does, end to end

1. **Connections** — save a PostgreSQL target by host/port/user/password or by URI,
   then test that it is reachable.
2. **Compare** — pick a source connection + schema and a target connection + schema.
   The engine snapshots both catalogs and diffs them: new tables, dropped tables,
   changed columns, and *renames* detected by similarity scoring rather than name
   equality.
3. **Diff report** — the differences rendered as cards, with the generated SQL
   underneath.
4. **Script editor** — review and hand-edit the SQL, choose a semver bump level,
   and push it to the GitHub registry at
   `{database}/{schema}/{script}/v{X.Y.Z}.sql`. Pushing an existing version is
   refused rather than overwritten.
5. **Deploy** — pick a target, pre-flight it, select the pending scripts, and apply
   them inside a transaction. Each applied script is written to a `script_patch`
   ledger table in the target database.
6. **Drift** — snapshot a tracked schema, then compare the live schema against that
   snapshot later; acknowledge or re-baseline the difference.
7. **Version sync** — reconcile three sources of truth: the registry, the target's
   ledger, and the lineage history.
8. **Visualizer** — side-by-side entity-relationship diagrams of both schemas.

---

## 3. Layout

```
my-app/
  app/
    page.tsx                  redirect → /studio
    login/                    Microsoft Entra sign-in button
    (studio)/                 the app shell; every page below shares it
      studio/                 dashboard: tracked schemas and their drift status
      connections/            connection CRUD + test
      compare/                live-vs-live schema comparison
      script-editor/          review, edit, semver-classify, push to GitHub
      deploy/                 pre-flight → select → transactional apply → ledger
      drift/                  snapshot-vs-live drift, acknowledge / re-baseline
      schemas/[id]/           lineage detail for one tracked schema
      versionsync/            registry vs ledger vs lineage reconciliation
      visualizer/             React Flow ERD
      admin/                  role management — roles, approver list
    api/                      26 route handlers, listed below
    globals.css               all styling (see §6)
  components/
    ui/                       design-system primitives
    studio/                   feature components (DiffReport, MigrationWorkbench, …)
    studio/visualizer/        ERD panes and nodes
  lib/                        all domain logic — see the table below
    db/                       Sequelize instance, models, one-time schema sync
  hooks/                      useUser and friends
  scripts/                    seed-test-schemas.cjs
  auth.ts                     NextAuth v5 config (Microsoft Entra provider)
```

### Library modules

| Module | Role |
| --- | --- |
| `lib/compare.ts` | The diff engine: weighted similarity, mutual-best matching, rename guard |
| `lib/compare-utils.ts` | Levenshtein, Jaccard, multiset helpers used by the scorer |
| `lib/compare-types.ts` | Shared types for snapshots and reports |
| `lib/postgres.ts` | Catalog introspection, connection-pool cache, schema-qualifier stripping |
| `lib/generate-sql.ts` | Migration generator, five ordered phases |
| `lib/sql-guard.ts` | Destructive-statement detection |
| `lib/lineage-db.ts` | `tracked_schemas`, `snapshots`, `lineage_migrations`, `drift_events` |
| `lib/drift-runner.ts` | One drift check plus its audit row — shared by the button, the scheduler and tracking |
| `lib/drift-schedule.ts` | Cadence arithmetic: what is due, what is overdue. Pure, so it is unit-tested |
| `lib/drift-scheduler.ts` | The background loop itself; the only timer in the process |
| `lib/query-analysis.ts` | Reads an `EXPLAIN` plan and says what is wrong with it. Pure |
| `lib/schema-metrics.ts` | `schema_metrics`: takes a reading, reads a window, prunes the tail |
| `lib/metrics-series.ts` | Readings to plot geometry, ticks and a sentence. Pure |
| `lib/snapshot-format.ts` | The snapshot format version, and what to do with an older one |
| `lib/db/sequelize.ts` | The one Sequelize instance, plus a `pg.Pool`-shaped adapter over its pool |
| `lib/db/models.ts` | All ten metadata tables as Sequelize models |
| `lib/db/bootstrap.ts` | `syncMetadataTables()` — creates the tables once per process |
| `lib/version-db.ts` | Re-exports the metadata pool; profile lookup and upsert |
| `lib/script-status.ts` | Pending / applied / superseded classification against the ledger |
| `lib/version-sync.ts` | Ledger reconciliation helpers |
| `lib/version-detection.ts` | Change-level severity, plus detecting an existing version table in a target |
| `lib/connection-config.ts` | Builds a `pg` config from a saved row; host allow-list check |
| `lib/parse-uri.ts` | `postgres://` URI parsing |

### API routes

```
admin/users             auth/[...nextauth]      compare
comparison-sets         connections             connections/test
connections/test-saved  deploy/approvals        deploy/approvals/[id]
github/pull             github/push             lineage
lineage/[id]            lineage/acknowledge     lineage/audit
lineage/drift           lineage/lookup          lineage/rebaseline
lineage/schedule        lineage/schemas         lineage/track
performance/advice      performance/analyze     performance/metrics
schema/snapshot         scripts/apply           scripts/preflight
scripts/revert          scripts/schemas         versionsync/ledger
```

Every one of them opens with a role gate — `requireViewer`, `requireEditor`,
`requireApprover` or `requireAdmin` from `lib/auth-guard.ts`. The single
exception is `auth/[...nextauth]`, which *is* the sign-in endpoint and cannot
require a session to reach.

### How the comparison engine works

`fetchSchemaSnapshot()` runs three catalog queries — tables, columns, and
`pg_constraint` — and returns a normalised snapshot. `compareSchemas()` then:

1. matches tables by exact name;
2. scores every unmatched source table against every unmatched target table on
   column-name overlap, type overlap, and name similarity;
3. keeps only mutual-best pairs above a threshold, and applies a rename guard so a
   weak match becomes a create + drop instead of a rename;
4. repeats the same process for columns inside each matched table.

`generateMigrationSQL()` emits statements in five phases, in this order: renames,
creates, alters, deferred foreign keys, then destructive drops last.

---

## 4. Data model

In the **metadata database** (`DATABASE_URL_A`) — ten tables, all declared as
Sequelize models in `lib/db/models.ts` and created by `syncMetadataTables()`:

| Table | Holds |
| --- | --- |
| `connections` | Saved targets: name, host, port, database, user, password, connection string |
| `tracked_schemas` | A `(connection_id, schema_name)` pair given a stable identity |
| `snapshots` | Point-in-time catalog snapshots of a tracked schema |
| `lineage_migrations` | Which migration was applied to which tracked schema |
| `drift_events` | Detected drift, plus acknowledgement state |
| `profiles` | Signed-in users and their role; the first to sign in becomes `admin` |
| `comparison_sets` | A saved source schema plus its list of targets |
| `comparison_set_targets` | One target of a saved set, in a fixed slot |
| `deploy_approvals` | Approval requests, decisions, and the two-person record |
| `schema_metrics` | One reading of a schema's size and shape per drift check, pruned past 90 days |

### Which database layer talks to what

Two very different kinds of database work happen here, and only one of them
belongs to an ORM:

- **This app's own database** — the ten tables above. A fixed schema the app
  owns, so Sequelize defines it, creates it, and does the reading and writing.
  Queries that are genuinely SQL rather than CRUD still run through
  `metadataPool`, which borrows a connection from Sequelize's pool: one pool,
  not two competing for the same connection limit.
- **The databases being compared and deployed to.** Arbitrary schemas the app
  has never seen, read out of `pg_catalog` and changed with generated DDL.
  There is nothing for an ORM to model, so `lib/postgres.ts` keeps talking to
  them with the `pg` driver directly.

In each **target database**:

| Table | Holds |
| --- | --- |
| `script_patch` | The ledger: which script version was applied here, and when |

---

## 5. Verified state — what works and what does not

Checked against the code on 9 September 2026, and against a running instance
with a real PostgreSQL behind it. Nothing below is deferred.

### Works end to end

Compare with rename detection · row-data comparison by count and checksum ·
migration generation · script review and editing · semver push to the GitHub
registry · pull back · pre-flight · dry run · approval and the two-person rule ·
transactional apply · `script_patch` ledger · rollback from a `.down.sql` ·
lineage snapshots · drift detection and re-baseline · version-sync
reconciliation · detecting an existing version table in a target · saved
comparison sets · comparing one source against up to six
targets · dev/staging/production labels and their warnings · exporting a diff as
Markdown, JSON, CSV or PDF · the ERD visualizer · scheduled drift checking
without a button press · query plan analysis · index and schema suggestions ·
schema metrics over time.

The compare engine introspects tables, columns, constraints, indexes, triggers,
views, sequences, types and routines.

Four of those are new enough to say where they live:

- **Drift is checked on a cadence**, not only when somebody presses the button.
  `lib/drift-scheduler.ts` runs one interval timer in the Next.js server,
  started from `instrumentation.ts`. It wakes every 60s, asks
  `lib/drift-schedule.ts` which tracked schemas are overdue, and runs the same
  check the button runs — at most 6 per tick, 2 at a time, so a backlog drains
  over several ticks instead of opening thirty connections to other people's
  databases at once. `DRIFT_SCHEDULER=off` is the kill switch. Per-schema
  cadence is set on the Drift screen; 0 means manual only.
- **Performance** is three tabs over one schema. *Suggestions* reads
  `pg_stat_user_tables` / `pg_stat_user_indexes` and the catalog for un-indexed
  foreign keys, unused and duplicate indexes, sequential-scan-heavy tables,
  bloat and missing primary keys. *Analyse a query* runs `EXPLAIN` — never
  `ANALYZE`, so nothing is executed — behind a read-only statement guard.
  *Trends* draws the history that monitoring collects.
- **Monitoring** takes one reading per drift check into `schema_metrics`:
  structure counts from the snapshot the check already had, plus a size probe
  against `pg_class`. Readings are pruned past 90 days. Charts are hand-drawn
  SVG; there is no charting dependency.
- **Snapshots carry a format version.** `lib/snapshot-format.ts` stamps one on
  every capture. The comparator already refused to report a category as "added"
  just because an old baseline predated it — a category is compared only when
  both sides recorded it — so the bug this fixes is not a false drift report but
  a silent one: `undefined` meant both "captured before this app knew about
  views" and "tried to read views and was refused", and the app guessed the
  first. The stamp separates them, names the categories being skipped, and says
  re-baselining is the fix. It also gives a future change that alters an
  existing field somewhere to be noticed, which optionality cannot do.

### Switched off or incomplete

- **Authentication is bypassed on purpose, for testing.**
  `NEXT_PUBLIC_AUTH_BYPASS` is not `"false"`, so `lib/auth-mode.ts` reports the
  bypass as on and both the UI guard and `lib/auth-guard.ts` let every request
  through as an admin. The wiring underneath is complete: all 30 API routes
  except the NextAuth handler itself call `requireViewer` / `requireEditor` /
  `requireAdmin`, and the `profiles` table is created with the rest of the
  metadata schema. Setting `NEXT_PUBLIC_AUTH_BYPASS=false` turns the whole thing
  on, and then the Entra keys in §1 have to be set for anyone to get in.

### Not built at all

Nothing in the spec is unbuilt. Spec features 8, 9 and 10 — query execution
analysis, performance suggestions and performance monitoring — were the last
three, and they are the Performance section described above.

### Compliance sheet

| Required | State |
| --- | --- |
| Next.js | met — 16.2.2, App Router, React 19.2.4, TypeScript 5 |
| PostgreSQL with Sequelize | met — Sequelize owns the metadata database (§4); the `pg` driver stays for target introspection |
| Microsoft OAuth via NextAuth | wired in `auth.ts`, disabled by `BYPASS_AUTH` |
| fetch / axios with UI ↔ API separation | met — every page fetches its data from a route handler |
| Tailwind or standard CSS | met — hand-written `globals.css` |
| Docker | met — multi-stage `my-app/Dockerfile` on the Next.js standalone output, plus `.dockerignore`, and a root `docker-compose.yml` that brings up Postgres 17 and the app together |
| Jest unit tests | met — 365 tests in 16 suites over the domain modules; the pages themselves are covered by route tests, not render tests |

---

## 6. Styling

All styling lives in `app/globals.css` (about 1,250 lines) as CSS custom
properties plus hand-written component classes. Tailwind v4 is imported at the
top of that file and its utilities carry layout and spacing — `flex`, `grid`,
`mt-2`, `text-[12px]` — while anything with a look of its own (`.btn`, `.card`,
`.pill`, `.diff-row`) is a hand-written class built on the tokens below.

Theming is driven by a `data-theme` attribute on `:root`, with a full token set
defined for both `light` and `dark`.

| Token group | Names |
| --- | --- |
| Surfaces | `--bg` `--surface` `--surface-2` `--surface-3` |
| Lines | `--border` `--border-strong` |
| Text | `--text` `--text-2` `--text-3` `--text-inv` |
| Brand | `--brand` `--brand-2` `--brand-soft` `--brand-soft-2` |
| Status | `--sync` `--pending` `--drift` `--break`, each with a `-soft` pair |
| Diff | `--diff-add-*` `--diff-rem-*` `--diff-chg-*` |
| Elevation | `--shadow-sm` `--shadow-md` `--shadow-lg` |

Fonts are Geist Sans and Geist Mono via `next/font`, exposed as
`--font-geist-sans` and `--font-geist-mono`.

---

## 7. Repository conventions

- `main` is the trunk. `Umer-dev`, `Cindy-dev`, `mei-dev`, `G-DEV` and `test`
  are the per-person branches. Work lands on `Umer-dev` first; the others are
  fast-forwarded to match, so every branch holds the same tree.
- This README is the only tracked document. Working notes, reviews and generated
  reports go in `my-app/docs/`, which is git-ignored.
- The full FYP-B review — subsystem maps, the spec trace, 54 findings, the market
  comparison against fourteen commercial tools, and the roadmap — is at
  `my-app/docs/schema-studio-fyp-b-review.html`. Open it in a browser.
- Never commit `.env.local`. Repository history was purged of leaked credentials
  on 11 June 2026; the affected tokens still need rotating.
