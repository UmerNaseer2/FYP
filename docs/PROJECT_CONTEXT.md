# Schema Studio — orientation for a reviewer

Written for someone who has never seen this repository and has perhaps an hour.
Everything below was read out of the code on 2026-09-10, not out of a plan
document. Where a plan document says otherwise, the code wins — see
[README.md](README.md) for the specific places the coursework documents have
gone stale.

Paths are relative to the repository root. The application lives in `my-app/`.

---

## 1. What the tool does

A PostgreSQL schema comparison and migration tool. The client, a working
developer, lost production availability to a schema change that nobody had
recorded. So the tool exists to answer four questions:

1. **How do two databases differ?** Point it at two schemas, get a structural
   diff — tables, columns, constraints, indexes, foreign keys, views,
   sequences, custom types, routines, triggers, RLS policies, partitioning.
2. **What SQL would close the gap?** Generate a migration, and the matching
   rollback, from that diff.
3. **What has actually been applied where?** A versioned script registry in
   GitHub, a ledger table written into each target database, and a deploy
   pipeline with pre-flight, dry run, and a two-person rule on production.
4. **Has anything changed behind my back?** Snapshot a schema as a baseline,
   then re-check it on a schedule and report drift.

Query analysis and performance advice were added later and sit alongside, not
underneath, those four.

## 2. The single most important thing to understand

**There are two entirely different kinds of database here, and confusing them
will make the whole codebase read wrong.**

**The metadata database** is the tool's own store — one PostgreSQL database
addressed by `DATABASE_URL_A`. It holds ten tables: saved connections, user
profiles, tracked schemas, snapshots, lineage migrations, drift events, schema
metrics, comparison sets, comparison-set targets, deploy approvals. It is owned
by **Sequelize** (`my-app/lib/db/models.ts`, `my-app/lib/db/bootstrap.ts`), and
reached everywhere through one handle: `pool`, the default export of
`my-app/lib/version-db.ts`.

**Target databases** are the customer databases being compared and deployed to.
They are registered on the Connections screen, stored (with credentials
encrypted) in the metadata DB, and reached with the **raw `pg` driver** through
`getPoolForConfig()` in `my-app/lib/postgres.ts`. Sequelize never touches them.

That split is deliberate and is stated in `my-app/lib/db/sequelize.ts`: an ORM
models tables you own, and the tool owns none of the schemas it introspects. A
reviewer asking "why isn't this using the ORM?" about `my-app/lib/postgres.ts`
has hit this boundary.

## 3. Repository layout

```
docs/                      the coursework documents (see docs/README.md)
docker-compose.yml         Postgres 17 + the app, two containers
my-app/
  app/
    (studio)/              11 pages, the whole product
    api/                   30 route handlers
    login/                 the sign-in page
    layout.tsx             root layout, dark theme, fonts
    globals.css            1,271 lines — design tokens + 463 hand-written rules
  components/
    studio/                feature components
    ui/                    the shared kit (EmptyState, Skeleton, dialogs, …)
  lib/                     46 modules — all the logic
    db/                    Sequelize: models, bootstrap, the instance
  tests/                   16 Jest suites, 388 tests
  proxy.ts                 Next 16's renamed middleware — the page auth gate
  auth.ts, auth.config.ts  NextAuth v5 (Microsoft Entra ID)
  instrumentation.ts       starts the drift scheduler on boot
```

Sizes, for scale: `app/` ~17,500 lines, `lib/` ~21,900, `components/` ~8,400,
`tests/` ~4,400.

## 4. Stack

Next.js 16.2.2 (App Router, Turbopack) · React 19.2.4 · TypeScript 5 strict ·
Node 22 · PostgreSQL via `pg` 8.20 and Sequelize 6.37 · NextAuth v5 beta with
Microsoft Entra ID · Tailwind v4 alongside hand-written CSS · Jest 30 ·
`@xyflow/react` + `@dagrejs/dagre` for the ERD visualiser.

**There is no charting library.** Every chart in `components/studio/SchemaTrends.tsx`
is hand-drawn SVG over pure geometry from `lib/metrics-series.ts`. That is a
choice, not an omission.

## 5. How a request flows

Every one of the 11 studio pages is a **client component** that fetches from a
route handler. No page queries a database at render time. (One page imports
*types* from a `-db` module; types are erased at build.) That separation was a
client requirement.

```
page.tsx  ──fetch──▶  app/api/**/route.ts
                          │
                          ├─ requireViewer/Editor/Admin   ← lib/auth-guard.ts
                          ├─ pool                          ← the metadata DB
                          └─ getPoolForConfig(buildPgConfig(row))  ← a target DB
```

`proxy.ts` runs before all of it at the edge and decides what is reachable at all.

## 6. Authorisation

Three roles, ordered: `viewer` < `editor` < `admin`. Defined in
`my-app/lib/auth-mode.ts`, stored on the `profiles` table, re-read from the
database on **every** session read (`my-app/auth.ts`), so a role change takes
effect on the next request rather than at the next sign-in.

Enforced at three layers that share one source of truth:

- **Edge** — `my-app/proxy.ts` decides which pages and APIs are reachable.
- **Server** — `my-app/lib/auth-guard.ts` exposes a discriminated union,
  `{ok: true, principal} | {ok: false, response}`. Because the failure branch
  carries the response, forgetting to check `gate.ok` is a *type error*, not a
  silent hole. **29 of the 30 route handlers call a gate**; the exception is
  `app/api/auth/[...nextauth]/route.ts`, which must stay open for sign-in.
- **Client** — `components/AuthGuard.tsx`, whose own header comment states it
  "is a convenience, not a security boundary". Believe the comment.

One route escalates mid-handler: `/api/performance/analyze` needs viewer to read
a query plan and editor to actually execute the query under `EXPLAIN ANALYZE`.

### The bypass switch — read this before filing an auth finding

`my-app/lib/auth-mode.ts` defines:

```ts
export const BYPASS_AUTH: boolean = process.env.NEXT_PUBLIC_AUTH_BYPASS !== "false";
```

It is currently **ON**, deliberately, so the tool can be worked on without a
Microsoft tenant. While on, every gate returns a hardcoded admin principal and
the edge lets everything through.

This is a known, intentional development setting, not a defect. The four secrets
that would let it be switched off — `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`,
`AZURE_AD_TENANT_ID`, `NEXTAUTH_SECRET` — are not yet provisioned. Note the
consequence: setting the flag to `false` *today* locks everyone out rather than
turning sign-in on, because `authUsable` in `auth.config.ts` is false without
those secrets. Also note `NEXT_PUBLIC_*` is inlined at build time, so flipping it
needs a rebuild, not a restart.

**Review the code behind the switch, not the switch's current position.**

## 7. Core entry points

Nine functions carry most of the product. Reading these in order is the fastest
route into the codebase.

| Function | Where | What it is |
|---|---|---|
| `fetchSchemaSnapshot(cfg, schema)` | `lib/postgres.ts:1272` | The single introspection entry point. Everything downstream consumes its `SchemaSnapshot`. |
| `compareSchemas(left, right)` | `lib/compare.ts:2738` | The diff engine. 2,828 lines; the only entry point the app calls. |
| `generateMigration(report, opts)` | `lib/generate-sql.ts:3028` | Diff → migration SQL. |
| `generateRollback(report, opts)` | `lib/generate-sql.ts:3616` | The inverse, by re-running the comparison backwards. |
| `runComparison(query, record)` | `lib/compare-run.ts:698` | Orchestrates a whole compare run; everything on `/compare` comes from here. |
| `runDriftCheck(id, source, mode)` | `lib/drift-runner.ts:79` | One drift check, and the `drift_events` row it writes. |
| `fetchSchemaVersionInfo(cfg, schema)` | `lib/version-detection.ts:313` | Finds a target's own version table — Flyway, Liquibase, or hand-rolled. |
| `readPlan(raw, tableRows)` / `readSql(sql)` | `lib/query-analysis.ts:592`, `:733` | EXPLAIN-plan reader and static SQL anti-pattern linter. |
| `analyzeSchemaPerformance(snapshot)` | `lib/perf-advice.ts:163` | Structural performance advice. |

### Rename detection is the interesting algorithm

A dropped `customer` table and an added `client` table might be a rename or might
be two unrelated changes, and guessing wrong emits destructive SQL. So
`lib/compare.ts` scores candidate pairs on weighted dimensions (name 20,
constraints 15, columns 55, relationships 10 for tables) with accept/possible
thresholds at 70/55, and then applies `tableNameRenameGuard` — a structurally
identical pair whose *names* are unrelated is demoted to a review candidate
rather than auto-emitting `ALTER TABLE … RENAME TO`. Primitives are in
`lib/compare-utils.ts` (Levenshtein, Jaccard, multiset similarity).

## 8. The `lib/` purity split

Of 46 modules, **28 are pure** — their value-import closure contains no `pg`,
`sequelize`, `next/*`, `@/auth` or `node:*` — and **18 are impure**. That is
what decides whether a module can be imported by a client component.

Several files exist *only* to preserve that line: `lib/snapshot-facts.ts` holds
one function so the UI can ask it without pulling in `pg`; `lib/parse-uri.ts`
re-implements URI parsing so the connection drawer can preview a string in the
browser; `lib/compare-data-summary.ts` is the browser-safe half of
`lib/compare-data.ts`. A reviewer wondering why a 28-line file exists has found
the reason.

## 9. Requirements traceability

The client's product backlog has 38 items (`docs/requirements/COS40005-team-and-project-plan.txt`,
Table 5). Traced against the code:

**32 done · 5 partial · 1 missing.**

The five partials and the one gap, precisely:

| # | Item | Status |
|---|---|---|
| 5 | NextAuth Microsoft OAuth | Code complete and wired end to end; no credentials provisioned, so the flow has never run. Needs env values, not more code. |
| 28 | Migration execution audit log | Every applied script is recorded in the target's `script_patch` ledger with its SQL, rollback, change type and timestamp — but **no actor**. The route knows the principal and does not persist it. Separately, the screen labelled "audit log" shows *drift* events, not deployments. |
| 30 | Comparison history and templates | Templates exist (`lib/comparison-sets.ts`). History does not: `last_run_at` is the only trace, so a past comparison cannot be reopened. |
| 31 | Jest testing | 16 suites, 388 tests, real and running in CI — but confined to `lib/`. Zero `@/app` imports, no `.tsx` tests, no jsdom. No route handler, page or component is under test. |
| 32 | UI polish and error handling | Polish is genuinely there (shared kit, first-run states, keyboard-reachable rows, print styles). Error handling is not: **no `error.tsx`, `global-error.tsx` or `not-found.tsx` anywhere in `app/`**, so a render error falls through to Next's default screen. |
| 38 | AI assistance | **Missing.** No AI SDK, no LLM call anywhere. Items 34–36 are rule-based heuristics. The backlog marks this "if time allows". |

### Where the code exceeds the backlog

Not asked for, but built: drift detection with an in-server scheduler; lineage
snapshots; the ERD visualiser; row-data comparison; diff export to
Markdown/JSON/CSV/PDF; version-sync ledger replay between two databases;
two-person production approval with a single-use run fingerprint; environment
labels and production warnings; AES-256-GCM credential encryption at rest; an
SSRF guard on connection targets; a 90-day schema-metrics time series; snapshot
format versioning; and comparison breadth well past "tables, columns,
constraints" — views, sequences, enum/range/composite types, routines, RLS
policies, triggers and partitioning.

## 10. Quality gates

Four commands, all green at the current commit, all run in CI on every branch:

```bash
npx tsc --noEmit
npx eslint app lib components hooks tests proxy.ts auth.ts auth.config.ts instrumentation.ts
npx jest
npm run build
```

`.github/workflows/ci.yml` runs exactly these on push to any branch, pull
request, and manual dispatch. Production build: 42 static pages, 30 API routes,
12 page routes, one proxy.

## 11. Known state and honest caveats

- **The metadata database is the Docker Compose Postgres.** For local work,
  `DATABASE_URL_A` points at the `db` service of the root `docker-compose.yml`
  (Postgres 17 on `localhost:5433`). The app creates its ten tables itself on
  first use. The hosted Supabase project it once pointed at has been deleted, and
  nothing saved there survives.
- **The auth bypass is ON** — see section 6.
- **`checkConnectableHost` judges the literal host only.** It normalises
  IPv4-mapped IPv6 and bare 32-bit integers first, so `::ffff:127.0.0.1` and
  `2130706433` are caught, but a public name that resolves to a private address
  (DNS rebinding) is not. Loopback and private ranges are refused only in a
  production build.
- **`/api/lineage/acknowledge` is the only metadata-writing route that never
  calls `syncMetadataTables()`** before querying. On a fresh database it fails
  where its siblings self-heal.
- **`app/(studio)/performance/` is the only studio route with no `layout.tsx`**,
  so it is the only page not wrapped in the client `AuthGuard`. Server gates
  still apply — a UI inconsistency, not a security hole.
- **`app/api/scripts/apply/route.ts` is 1,244 lines**, by far the largest file
  in `app/`. It is the most dangerous route in the codebase — it runs arbitrary
  DDL against a customer database — and repays careful reading.

## 12. House conventions

- `type` aliases only; the codebase contains zero `interface` declarations.
- Discriminated unions on a `kind` or `status` field, so exhaustiveness is checked.
- `export function`, not arrow consts.
- 2-space indent, double quotes, semicolons, ~88-character wrap.
- Comments explain **why**, never what. A comment restating the code is a defect here.
- Em dashes in prose, not hyphens.
- `!` non-null assertions are avoided.
- Tests: a JSDoc header on every suite explaining why it exists; `describe("functionName")`;
  `it("full lowercase sentence in third person")` — never "should".
- The project is maintained by a beginner. Simple readable code beats a clever
  abstraction, deliberately.
