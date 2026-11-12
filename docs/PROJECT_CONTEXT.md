# Schema Studio — orientation for a reviewer

Written for someone who has never seen this repository and has perhaps an hour.
Everything below was read out of the code on 2026-09-18, not out of a plan
document. Where a plan document says otherwise, the code wins — see
[README.md](README.md) for the specific places the coursework documents have
gone stale.

Brought up to date with the code on 2026-11-10, at commit `e1a4d0c`: the
counts, the stack versions, the sign-in providers, organizations and the AI
features. The line numbers in section 7 are as of that commit.

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
   pipeline with pre-flight, dry run, and an approval of one exact run for
   anyone whose role may not run it.
4. **Has anything changed behind my back?** Snapshot a schema as a baseline,
   then re-check it on a schedule and report drift.

Query analysis and performance advice were added later and sit alongside, not
underneath, those four.

## 2. The single most important thing to understand

**There are two entirely different kinds of database here, and confusing them
will make the whole codebase read wrong.**

**The metadata database** is the tool's own store — one PostgreSQL database
addressed by `DATABASE_URL_A`. It holds 34 tables: organizations and who
belongs to them, saved connections, roles and their permissions, tracked
schemas, snapshots, lineage migrations, drift events, schema metrics,
comparison sets, deploy approvals and attempts, the AI settings and call log,
and the tables behind the desktop and phone links. **Sequelize** defines
those tables as models and creates them (`my-app/lib/db/models.ts`,
`my-app/lib/db/bootstrap.ts`), and it owns the connection pool. It does not do
the reading and writing: every query is parameterised SQL sent with the `pg`
client through one handle, `pool`, the default export of
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
deploy/                    server scripts
desktop/                   the Electron desktop app
relay/                     the Cloudflare Worker relay and the phone app
my-app/
  app/
    page.tsx               the landing page at "/"
    [org]/                 one organization's pages: /acme/studio and so on
      layout.tsx           checks membership, tells the pages which organization
      page.tsx             /acme opens /acme/studio
      (studio)/            12 pages, the whole product
    studio/, compare/, …   the old addresses: each [[...rest]]/page.tsx sends
                           /compare?left=1 on to the organization opened last
    api/                   83 route handlers
    login/                 the sign-in page
    layout.tsx             root layout, dark theme, fonts
    globals.css            about 1,800 lines: design tokens + hand-written rules
    error.tsx              the boundaries: one per depth, see §11
  components/
    studio/                49 feature components
    admin/                 the Admin screen's tabs
    ui/                    17 files — the shared kit (EmptyState, Skeleton, dialogs, …)
  lib/                     132 modules at the top level: all the logic
    ai/                    the AI features (32 files)
    db/                    Sequelize: models, bootstrap, the instance (4 files)
  tests/                   the Jest suites (their counts are kept in one
                           place, the Jest row in my-app/README.md)
  proxy.ts                 Next 16's renamed middleware — the page auth gate
  auth.ts, auth.config.ts  NextAuth v5 (Microsoft Entra ID and GitHub)
  instrumentation.ts       starts the drift scheduler on boot
```

Sizes, for scale: `app/` ~35,000 lines, `lib/` ~66,800, `components/` ~24,100,
`tests/` ~104,300. The test tree being larger than the source it covers is a
consequence of how these suites are written: each one opens with a header
saying what it is pinning down and what deliberately belongs to another file,
and most assertions carry the reason they exist.

## 4. Stack

Next.js 16.4.5 (App Router, Turbopack) · React 19.2.4 · TypeScript 5 strict ·
Node 22 · PostgreSQL via `pg` 8.20 and Sequelize 6.37 · NextAuth v5 beta with
Microsoft Entra ID and GitHub · Tailwind v4 alongside hand-written CSS · Jest 30 ·
`@xyflow/react` + `@dagrejs/dagre` for the ERD visualiser.

**There is no charting library.** Every chart in `components/studio/SchemaTrends.tsx`
is hand-drawn SVG over pure geometry from `lib/metrics-series.ts`. That is a
choice, not an omission.

## 5. How a request flows

Every one of the 12 studio pages is a **client component** that fetches from a
route handler. No page queries a database at render time. (One page imports
*types* from a `-db` module; types are erased at build.) That separation was a
client requirement.

```
page.tsx  ──fetch──▶  app/api/**/route.ts
                          │
                          ├─ requirePermission(key)       ← lib/auth-guard.ts
                          ├─ pool                          ← the metadata DB
                          └─ getPoolForConfig(buildPgConfig(row))  ← a target DB
```

`proxy.ts` runs before all of it at the edge and decides what is reachable at all.

## 6. Authorisation

Roles with per-feature permissions. `my-app/lib/permissions.ts` lists every
feature and its permissions (Create, Read, Update, Delete, and Run or Approve
where a feature has them), 43 in all across 17 features. What each role may do
is stored in the database (`roles`, `role_permissions`), turned on and off on
the Admin screen's Roles & permissions tab, where each permission is a plain
sentence such as "Add a connection" grouped under its sidebar screen, and
logged in `role_changes`. Three roles are built in and can't be deleted: Viewer
and Editor start with the permissions that reproduce the old
`viewer` < `editor` ladder, and Admin can always do everything, so its
permissions are neither stored nor editable. An admin can add roles of their
own. A person has one role in each organization they belong to, stored on
the `memberships` table, and the role and its permissions are re-read from the database on **every** session read
(`my-app/auth.ts`), so a change takes effect on the next request rather than
at the next sign-in.

Enforced at three layers that share one source of truth:

- **Edge** — `my-app/proxy.ts` decides which pages and APIs are reachable.
- **Server** — `my-app/lib/auth-guard.ts` exposes a discriminated union,
  `{ok: true, principal} | {ok: false, response}`. Because the failure branch
  carries the response, forgetting to check `gate.ok` is a *type error*, not a
  silent hole. **71 of the 83 route files call a gate**:
  `requirePermission(...keys)` (61 files), which passes when the role has any
  one of the permissions named; `requireMember()` (8 files, such as `me` and
  `me/view-as`), for routes about the caller that every member needs; or
  `requireSignedIn()` (2 files), for someone who may not be in an organization
  yet. The other 12 are exempt, each with its reason written down in the test
  named below. One of them is `app/api/auth/[...nextauth]/route.ts`, which must
  stay open for sign-in. `my-app/tests/permissions-coverage.test.ts` fails if a
  new route forgets its gate or a permission is checked by no route.
- **Client** — `components/AuthGuard.tsx`, whose own header comment states it
  "is a convenience, not a security boundary". Believe the comment.

Some routes ask for a second permission mid-handler (below, Feature: Action is
shorthand for a permission key; the app itself names each one by its line on the
Roles & permissions tab, `permissionLabel` in `my-app/lib/permissions.ts`).
`/api/performance/analyze` needs Performance: Read to read a query plan and
Performance: Run to actually execute the query under `EXPLAIN ANALYZE`. Saving a
comparison set needs Create for a new name and Update for a name already taken.
`/api/compare` leaves the saved sets out unless the role has Comparison sets:
Read. `scripts/apply` and `scripts/revert` need Deploy: Run and then the
connection's own setting (`my-app/lib/connection-access.ts`).

### The bypass switch — read this before filing an auth finding

`my-app/lib/auth-mode.ts` defines:

```ts
const BYPASS_ON = new Set(["true", "1", "yes", "on"]);
export const BYPASS_AUTH: boolean = BYPASS_ON.has(bypassSetting);
```

An allow-list: only those spellings turn the bypass on, and everything else —
a typo, an empty string, the variable not being set at all — leaves real
authentication enforced. It reads as ON in a local development checkout,
because `.env.local` sets it explicitly, deliberately, so the tool can be
worked on without a Microsoft tenant. `docker-compose.yml` leaves it off
unless asked (`NEXT_PUBLIC_AUTH_BYPASS=true docker compose up --build`), so
the server image and the Vercel deployment make everyone sign in. While on, every
gate returns a hardcoded admin principal, or the role picked in View as on the
studio rail, and the edge lets everything through.

That is a known, intentional development setting, not a defect. With it off,
sign-in needs `NEXTAUTH_SECRET` plus either the three `AZURE_AD_*` keys or
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Without them `authUsable` in
`auth.config.ts` is false and the login page says single sign-on is not set
up, so a missing key locks everyone out rather than letting everyone in. That
is the intended reading of the default rather than an oversight: an app nobody
can get into is a five-minute fix, and an app everybody can get into is not
something you find out about at all. Also note `NEXT_PUBLIC_*` is inlined at
build time, so changing it needs a rebuild, not a restart.

**Review the code behind the switch, not the switch's current position.**

## 7. Core entry points

Nine functions carry most of the product. Reading these in order is the fastest
route into the codebase.

| Function | Where | What it is |
|---|---|---|
| `fetchSchemaSnapshot(cfg, schema)` | `lib/postgres.ts:1394` | The single introspection entry point. Everything downstream consumes its `SchemaSnapshot`. |
| `compareSchemas(left, right)` | `lib/compare.ts:2784` | The diff engine. 2,874 lines; the only entry point the app calls. |
| `generateMigration(report, opts)` | `lib/generate-sql.ts:4222` | Diff → migration SQL. |
| `generateRollback(report, opts)` | `lib/generate-sql.ts:4884` | The inverse, by re-running the comparison backwards. |
| `runComparison(query, record)` | `lib/compare-run.ts:1027` | Orchestrates a whole compare run; everything on `/compare` comes from here. |
| `runDriftCheck(id, source, mode)` | `lib/drift-runner.ts:120` | One drift check, and the `drift_events` row it writes. |
| `fetchSchemaVersionInfo(cfg, schema)` | `lib/version-detection.ts:575` | Finds a target's own version table: Flyway, Liquibase, or hand-rolled. |
| `readPlan(raw, tableRows)` / `readSql(sql)` | `lib/query-analysis.ts:3517`, `:6049` | EXPLAIN-plan reader and static SQL anti-pattern linter. |
| `analyzeSchemaPerformance(snapshot)` | `lib/perf-advice.ts:1021` | Structural performance advice. |

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

The modules under `lib/` are of two kinds. A **pure** module is one whose
value-import closure contains no `pg`, `sequelize`, `next/*`, `@/auth` or
`node:*`. The rest are **impure**. That is what decides whether a module can
be imported by a client component. (This file used to give a count of each
kind. The count was not redone on 2026-11-10, so it is left out.)

Several files exist *only* to preserve that line: `lib/snapshot-facts.ts` holds
one function so the UI can ask it without pulling in `pg`; `lib/parse-uri.ts`
re-implements URI parsing so the connection drawer can preview a string in the
browser; `lib/compare-data-summary.ts` is the browser-safe half of
`lib/compare-data.ts`. A reviewer wondering why a 28-line file exists has found
the reason.

## 9. Requirements traceability

The client's product backlog has 38 items (`docs/requirements/COS40005-team-and-project-plan.txt`,
Table 5). Traced against the code:

**37 done · 1 that needs configuration, not code.**

The one that is not simply done:

| # | Item | Status |
|---|---|---|
| 5 | NextAuth Microsoft OAuth | Code complete and wired end to end, with GitHub as a second provider. Real sign-in is the default. This repository carries no credentials, so a server has to be given the keys (§6) before the login page can offer it. |

Five items that were partial or missing when this file was first written have
since been finished. They are listed rather than deleted, because a reviewer holding an
older copy of this document will come looking for them:

| # | Item | What closed it |
|---|---|---|
| 28 | Migration execution history and audit log | The ledger row already held the SQL, the rollback, the change type and the timestamp; it now holds the actor too (`applied_by`, added to older ledgers on the next apply), and the Deploy screen's timeline reads "Applied *date* by *who*". The *Audit log* tab on the Drift screen is a different log and always was — drift checks, not deployments. |
| 30 | Save comparison history and templates | Templates are `lib/comparison-sets.ts`. History is `lib/comparison-history.ts` and `-db.ts`: every run stores the finding set it saw, and the next comparison of the same pair opens with what appeared and what was resolved in between. What is stored is the finding set rather than the whole report, so a past run is compared against, not re-opened. |
| 31 | Jest testing for the main webpages | The suite, test and coverage numbers are kept in one place: the Jest row of the compliance sheet in `my-app/README.md`. Of the 34 `page.tsx` files, the 19 that show something each have a suite of their own (`tests/page-*.test.tsx`), alongside 41 component suites; the landing page at `app/page.tsx` has one suite for whom it sends where and one for what it shows. The addresses that only redirect (`/acme` and the ones from before organizations) are in `tests/org-redirect.test.ts`. jsdom is asked for per file, so the logic suites keep a node environment. |
| 32 | UI polish and error handling | The polish was already there. The error handling is `app/[org]/(studio)/error.tsx`, `app/error.tsx`, `app/not-found.tsx` and `app/global-error.tsx` — see §11. |
| 38 | AI assistance | Built, and off by default. `my-app/lib/ai/` holds six features: a change summary on Compare, a migration review before deploy, an explanation of drift, one line in drift alerts, SQL written from plain words, and a schema chat. An organization gets them only after an Admin switches AI on in the Admin screen's AI tab, and only when the server or the organization has a key for an AI service. Using them needs the permission "Use AI assistance". Items 34 to 36 are still rule-based and do not need it. |

### Where the code exceeds the backlog

Not asked for, but built: drift detection with an in-server scheduler; lineage
snapshots; the ERD visualiser; row-data comparison; diff export to
Markdown/JSON/CSV/PDF; version-sync ledger replay between two databases;
approval of one exact run with a single-use run fingerprint; risk warnings
before a run; AES-256-GCM credential encryption at rest; an
SSRF guard on connection targets; a 90-day schema-metrics time series; snapshot
format versioning; and comparison breadth well past "tables, columns,
constraints" — views, sequences, enum/range/composite types, routines, RLS
policies, triggers and partitioning.

Added since this list was first written: organizations with invitations and a
role per organization, the Requests page, sign-in with GitHub, the desktop app
in `desktop/`, and the relay and phone app in `relay/`.

## 10. Quality gates

Four commands, all green at the current commit, all run in CI on every branch:

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint, configured by eslint.config.mjs
npm test             # jest
npm run build
```

`.github/workflows/ci.yml` runs exactly these on push to any branch, pull
request, and manual dispatch. The app has 83 API route files, 34 `page.tsx`
files and one proxy.

## 11. Known state and honest caveats

- **The metadata database is the Docker Compose Postgres.** For local work,
  `DATABASE_URL_A` points at the `db` service of the root `docker-compose.yml`
  (Postgres 17 on `localhost:5433`). The app creates its tables itself on
  first use. The hosted Supabase project it once pointed at has been deleted, and
  nothing saved there survives.
- **The auth bypass is ON in local development only** (`.env.local`). The
  server image and Vercel make everyone sign in. See section 6.
- **`checkConnectableHost` judges the literal host only.** It normalises
  IPv4-mapped IPv6 and bare 32-bit integers first, so `::ffff:127.0.0.1` and
  `2130706433` are caught, but a public name that resolves to a private address
  (DNS rebinding) is not. Loopback and private ranges are refused only in a
  production build.
- **`/api/lineage/acknowledge` is the only metadata-writing route that never
  calls `syncMetadataTables()`** before querying. On a fresh database it fails
  where its siblings self-heal.
- **`app/api/scripts/apply/route.ts` is the largest route handler in `app/`**, at
  nearly 2,000 lines. It is the most dangerous route in the codebase: it runs
  arbitrary DDL against a customer database — and repays careful reading.
- **A render error is now caught at the depth it happened.**
  `app/[org]/(studio)/error.tsx` sits inside the route group, so a screen that throws
  is replaced while the sidebar stays up and every other screen is one click
  away. `app/error.tsx` covers the landing page, sign-in and the old
  addresses' redirects, which have no sidebar to keep. `app/global-error.tsx` catches a throw in the root layout
  itself, and therefore ships its own `<html>`, `<body>` and stylesheet and
  imports nothing — the layout that loads `globals.css` is the thing that has
  just failed. `app/not-found.tsx` is the 404. Each prints `error.digest` when
  there is one, because the message itself is redacted in a production build and
  the digest is the only thread back to the server log.
- **The auth state is readable on screen.** The bottom-left of the studio rail
  carries your role, and an `auth off` pill beside it whenever the bypass is on.
  That is a label, not a guard: the gates are `lib/auth-guard.ts` and `proxy.ts`.

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
