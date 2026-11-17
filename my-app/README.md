# Schema Studio

Compare two live PostgreSQL schemas, generate the migration that closes the
gap, keep it as a numbered version in a GitHub script registry, and apply it to
a target database inside a transaction, with a ledger in that database of what
was applied and when.

This is the web app. This file says what it does, how to run it from source,
and what is and is not built. If something here disagrees with the code, the
code is right and this file needs a fix.

| To | Read |
|---|---|
| Install and run the finished image, with your own PostgreSQL and Microsoft sign-in (one command, `deploy/handover/setup.sh`, or step by step) | [`deploy/handover/SETUP-GUIDE.md`](../deploy/handover/SETUP-GUIDE.md) |
| Understand the code: architecture, where each feature lives, conventions, roles, recipes | [`docs/DEVELOPER-MANUAL.md`](../docs/DEVELOPER-MANUAL.md) |
| Know why the SQL is written by hand, and how older PostgreSQL is handled | [`docs/RAW-SQL.md`](../docs/RAW-SQL.md) |
| Run it on Supabase and Vercel instead | [`deploy/SUPABASE-VERCEL.md`](../deploy/SUPABASE-VERCEL.md) |
| Use it, screen by screen | [`docs/user-manual/schema-studio-user-manual.txt`](../docs/user-manual/schema-studio-user-manual.txt) |

---

## 1. Running it from source

Needs Node 22 and a PostgreSQL database for the app's own tables. The simplest
one is the PostgreSQL in the root `docker-compose.yml`. From the repository
root:

```bash
docker compose up -d db
```

That is PostgreSQL 17 on `localhost:5433`. Then, in `my-app/`:

```bash
npm ci
```

```bash
cp .env.local.example .env.local
```

Set `DATABASE_URL_A=postgres://studio:studio@localhost:5433/studio` in
`.env.local`, then:

```bash
npm run dev
```

Open `http://localhost:3000`. The app makes its tables on the first request
(`syncMetadataTables()` in `lib/db/bootstrap.ts`); there is no separate
migration step. The example settings file has the sign-in bypass on (section
5), so no Microsoft keys are needed while developing.

The same PostgreSQL can be saved on the Connections page as a database to
compare (host `localhost`, port `5433`, SSL off). To fill it with four small
sample schemas (`cmp_prod` and `cmp_dev` for Compare, `vs_source` and
`vs_target` for Version sync):

```bash
node scripts/seed-test-schemas.cjs
```

`docker compose down` stops the database and keeps its data;
`docker compose down -v` deletes the data too.

### Commands

| Command | Does |
|---|---|
| `npm run dev` | The app with live reload |
| `npm run build` | The production build |
| `npm start` | Runs the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no output |
| `npm test` | Jest |
| `npm run test:watch` | Jest, re-running on change |
| `npm run ai:bench` | Grades the AI features against a running copy |

The database test suites (`tests/*-db.test.ts`) skip unless
`TEST_DATABASE_URL` points at a database whose name contains `test`. The
developer manual, section 9, has the details.

### The whole thing in Docker

From the repository root, with no Node needed:

```bash
NEXT_PUBLIC_AUTH_BYPASS=true docker compose up --build
```

Without the bypass, the build asks everyone to sign in, so it needs
`NEXTAUTH_SECRET` and Microsoft's three `AZURE_AD_*` keys (or GitHub's two) in a
`.env` beside `docker-compose.yml`. Step 6 of the setup guide shows how to get
the Microsoft ones.

To build the image that the setup guide runs:

```bash
docker build -t schema-studio-app:handover my-app
```

### Settings

Every setting is explained in `.env.local.example`. In short:

| Key | What it is | Needed |
|---|---|---|
| `DATABASE_URL_A` | The app's own PostgreSQL | yes |
| `NEXTAUTH_SECRET` | Encrypts the sign-in cookie | for real sign-in |
| `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `AZURE_AD_TENANT_ID` | The Microsoft Entra app registration | for Microsoft sign-in |
| `AZURE_AD_ANY_ACCOUNT` | `true` lets Microsoft accounts from outside the tenant sign in, once the registration allows it | no |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | A GitHub OAuth app, for "Continue with GitHub". The button shows only when both are set | no |
| `APP_ENCRYPTION_KEY` | Encrypts saved database passwords and each organization's GitHub token. Without it (or `NEXTAUTH_SECRET`) passwords are stored as plain text and no GitHub token can be saved | set it |
| `GITHUB_PAT`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME` | A script registry for the default organization, until an Admin saves one on the Admin page | no |
| `ALLOW_PRIVATE_DB_HOSTS` | `true` lets a production server connect to private addresses (section 5) | when the databases are on the same network |
| `DRIFT_SCHEDULER` | `off` stops the background drift checks | no |
| `CRON_SECRET`, `DRIFT_CALL_MINUTES` | Only for a host with no long-running server (Vercel): the secret and spacing of the outside call that runs drift checks | no |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL_FAST`, `AI_MODEL_SMART` | An AI service for the AI features (section 6). AI stays off unless these are set, or an organization saves its own key | no |
| `AI_REASONING_EFFORT`, `AI_TIMEOUT_MS`, `AI_DAILY_LIMIT`, `AI_PER_MINUTE` | AI tuning: defaults are the model's own effort, 90 seconds, 300 calls a day per organization, 10 a minute per person | no |
| `NEXT_PUBLIC_AUTH_BYPASS` | `true` skips sign-in for testing. Read when the app is built, not when it runs (section 5) | no, off by default |

---

## 2. What the app does, end to end

1. **Connections**: save a PostgreSQL database by host, port, user and
   password, or by URI, and test it.
2. **Compare**: pick a source and a target schema. The app reads both
   catalogs and lists the differences: tables and columns added, dropped and
   changed, and renames found by similarity rather than by name.
3. **The difference report**: the differences as cards, with the generated
   SQL and its rollback underneath, ready to edit.
4. **Script Editor**: review and edit the SQL, choose how big a change it is,
   and push it to the GitHub registry as
   `{database}/{schema}/{script}/v{X.Y.Z}.sql`. A version that already exists is
   refused, never overwritten.
5. **Deploy**: pick a target, check it, pick the scripts not yet applied, and
   apply them in a transaction. Each one is written to the `script_patch`
   ledger in the target database. Quick run applies one script straight away.
6. **Version sync**: pick a schema that is ahead and one that is behind. The
   page reads both ledgers and replays on the second what it is missing.
7. **Drift**: keep a snapshot of a tracked schema and compare the live schema
   with it, by hand or on a schedule; accept the change or make it the new
   baseline.
8. **Performance**: index and schema advice, an `EXPLAIN` of one query, the
   history of analysed queries, live activity, trends and alert levels.
9. **Visualizer**: diagrams of two schemas side by side.

The menu lists them in this order, and each page links onward once it has
produced something: Connections to Compare, Compare to Deploy, Deploy to
Version sync and Drift. **Requests** is where a member asks for a permission
their role lacks, and where runs waiting for approval show. **Admin** holds
users, roles, the organization, its GitHub registry and AI.

---

## 3. How it is built

One Next.js app: the pages in `app/[org]/(studio)/` get all their data from the
59 routes in `app/api/`, every route checks the person's permission first, and
the logic lives in `lib/`, one folder per feature. The developer manual has the
full map, a section per feature listing the files to change, and the rules the
code follows.

### How the comparison engine works

`fetchSchemaSnapshot()` (`lib/postgres/snapshot.ts`) reads one schema with the
readers in `lib/postgres/catalog/`: tables and columns, constraints, indexes and
triggers, partitions, row security, views, sequences, user types, collations,
routines, extensions and privileges. They all run on one connection inside
`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, so every answer describes the
same moment, and a schema being changed while it is read cannot give a snapshot
that never existed. `compareSchemas()` (`lib/compare/diff.ts`) then:

1. matches tables by exact name;
2. scores every unmatched source table against every unmatched target table on
   column names, column types and name similarity;
3. keeps only pairs that pick each other above a threshold, so a weak match
   becomes a create and a drop instead of a rename;
4. does the same for the columns inside each matched table.

`generateMigration()` (`lib/sql/generate/migration.ts`) writes the script in an
order where each statement finds what it needs: extensions, collations, types
and standalone sequences, the functions a new table needs, dropping views that
must be rebuilt, table renames, renames of owned sequences, `CREATE TABLE`,
functions and procedures, changes to matched tables, dropped tables, indexes,
foreign keys, triggers, row security, views, indexes and triggers on views,
ownership and grants, and last the routines, types, sequences, collations and
extensions nothing uses any more. `generateRollback()`
(`lib/sql/generate/rollback.ts`) writes the script that undoes it.

### The database layers

- **The app's own database** has 28 tables, each defined once in
  `lib/db/models.ts`. Sequelize creates them and owns the one connection pool.
  The reads and writes are plain SQL with `$1` placeholders in the `*-db.ts`
  files, sent through `metadataPool` (`lib/db/sequelize.ts`).
- **The databases people compare and deploy to** are read straight from
  `pg_catalog` with the `pg` driver, and changed with generated SQL.

[`docs/RAW-SQL.md`](../docs/RAW-SQL.md) explains the choice.

---

## 4. What works

Compare with rename detection, row-data comparison by count and checksum,
migration and rollback generation, script review and editing, versioned push to
the GitHub registry and pull back, pre-flight, dry run, approval of one exact
run by a second person, transactional apply, the `script_patch` ledger,
revert, Quick run, a record of every deploy attempt, tracked schemas and
snapshots, drift detection, acceptance and re-baselining on a schedule,
version sync, detecting a version table already in a target, saved comparison
sets, one source against up to six targets, what changed since the last
comparison of the same pair, exporting a report as Markdown, JSON or CSV (and
the browser's print dialog for PDF), the diagram visualizer, query plan
analysis, index and schema advice, schema metrics over time, organizations each
with their own members, roles, connections and registry, invitations, the
Requests page, roles an Admin edits permission by permission, per-connection
run settings, Help on every page, the app tour, sign-in with Microsoft or
GitHub, and the six AI features (section 6).

Details of the newer parts:

- **Drift is checked on a schedule.** `lib/drift/scheduler.ts` runs one timer
  in the server, started from `instrumentation.ts`. It wakes every minute, asks
  `lib/drift/schedule.ts` which tracked schemas are due, and runs the same check
  as the Recheck button, at most 6 per wake and 2 at a time, so a backlog drains
  over several minutes instead of opening thirty connections at once. Each
  schema's interval is set on the Drift page; 0 means by hand only.
- **Performance** has six tabs over one schema. Suggestions reads the
  statistics views and the catalog for unindexed foreign keys, unused and
  duplicate indexes, tables read by sequential scan, bloat and missing primary
  keys. Analyse a query runs a plain `EXPLAIN` in a read-only transaction that is
  always rolled back; only when the person ticks the measure box does it run
  `EXPLAIN ANALYZE`, which really runs the query. History, Live activity,
  Trends and Alerts complete it; every alert starts switched off.
- **Each connection says who may run scripts on it**: anyone whose role may
  deploy (the default), Admins only, or nobody (`lib/connections/access.ts`).
  Both routes that run scripts, and the AI script trial, check it. "Nobody"
  refuses Admins too, which is the point for a reference schema.
- **A comparison says what changed since the last one** of the same pair
  (`comparison_runs`, `lib/compare/history.ts`). Only structure is tracked;
  row counts move whenever a database is used.
- **Snapshots carry a format version** (`lib/postgres/snapshot-format.ts`), so
  a baseline taken before the app could read some kind of object is told apart
  from one where reading it was refused, and the page says to re-baseline.

### Not built

- **Database engines other than PostgreSQL.** `lib/connections/dialects.ts`
  names the engines and marks which are built; only PostgreSQL is. A MySQL
  connection is refused with a reason. A second engine needs its own catalog
  readers and SQL writer, not a setting.
- **AI on the Performance page.** Query analysis and advice come from the rules
  in `lib/performance/`.

---

## 5. Sign-in, the testing bypass, and two production rules

**Real sign-in is the default.** The login page offers Continue with Microsoft
and, when its keys are set, Continue with GitHub. A server missing the keys
shows a notice naming them.

**The bypass is for testing only.** `NEXT_PUBLIC_AUTH_BYPASS=true` (or `1`,
`yes`, `on`) skips sign-in and makes everyone an Admin. Anything else, including
leaving it out, means real sign-in, so a forgotten setting fails safe.

- **It is read when the app is built, not when it runs.** Next.js writes every
  `NEXT_PUBLIC_` value into the browser code. `npm run dev` picks up a change on
  the next request; a built app never does. The Docker image's label
  `org.schema-studio.sign-in-bypass` says which kind an image is.
- **You can tell from the screen.** The bottom of the menu shows your role,
  and an `auth off` pill beside it when the bypass is on.
- **View as.** With the bypass on, a picker under your name makes every route
  and page answer as Viewer, Editor or another role, for checking roles without
  signing in as each. With real sign-in the route answers 404 and the cookie is
  never read.

**Two rules that apply only in production** (`NODE_ENV=production`):

- **Private addresses are refused**: localhost, the private ranges
  (10.x, 172.16 to 31.x, 192.168.x) and unix sockets, because each reaches the
  app server's own machine. Cloud metadata and link-local addresses are refused
  everywhere. `ALLOW_PRIVATE_DB_HOSTS=true` allows private addresses for a
  server on a trusted network, which is what the setup guide uses.
- **An approval expires after a week** (`APPROVAL_VALID_HOURS` in
  `lib/deploy/approvals-db.ts`). After that the run reads as unapproved again;
  asking again is one click.

---

## 6. AI assistance

The code is in `lib/ai/`. There are six features (`lib/ai/prompts/index.ts`):

| Feature | Where it shows | Route |
|---|---|---|
| Change summary | Compare, the Change summary panel | `compare/summary` |
| Migration review | Deploy, Review with AI | `scripts/review` |
| Explain drift | Drift, Explain with AI | `lineage/drift/explain` |
| One line in drift alerts | Added by the scheduler (`lib/ai/drift-alert-line.ts`) | none |
| Write SQL from plain words | Script Editor, Write it with AI | `scripts/generate` |
| Schema chat | Ask AI in the top bar | `ai/chat` |

Before anyone sees an AI button, all three must be true:

1. The server has an AI service set up (the `AI_*` settings), or the
   organization has saved its own key on the Admin page, AI tab (Anthropic,
   Google Gemini or OpenAI, stored encrypted).
2. An Admin has switched AI on for the organization on that tab. Each feature
   has its own switch too.
3. The person's role has Use AI assistance (`ai:read`). Editor and Admin have
   it out of the box; Viewer does not.

How the answers are kept honest:

- Only schema structure and the SQL under review are sent. No rows, passwords
  or connection addresses.
- `lib/ai/checks.ts` checks every answer before it is shown. A point naming a
  table or column that does not exist is dropped. The change level always comes
  from the app's own engine, never the model. SQL containing transaction
  control is refused.
- Nothing the AI writes runs by itself. When the person may run scripts on the
  target, the app first tries the drafted script and its rollback inside one
  transaction that is always rolled back
  (`lib/ai/features/sql-generate-trial.ts`). Saving and deploying it go through
  the same permissions as any other script.
- Calls are counted in `ai_calls`, never with the prompt or answer. Checked
  answers are cached in `ai_results` for a week.

---

## 7. Compliance sheet

| Required | State |
|---|---|
| Next.js | 16.4.5, App Router, React 19.2.4, TypeScript 5 |
| PostgreSQL with Sequelize | Sequelize defines and creates the app's own tables and owns the connection pool. The queries are SQL through the `pg` driver ([`docs/RAW-SQL.md`](../docs/RAW-SQL.md)) |
| Microsoft OAuth via NextAuth | NextAuth v5 with Microsoft Entra ID (`auth.config.ts`, `auth.ts`), and GitHub as a second provider. Real sign-in by default |
| fetch with UI and API kept apart | Every page gets its data from a route in `app/api/` through `apiFetch` |
| Tailwind or standard CSS | Tailwind v4 for layout and spacing, plus the hand-written classes in `app/globals.css` and `app/styles/` (section 8) |
| Docker | A three-stage `my-app/Dockerfile` on the Next.js standalone output, a root `docker-compose.yml` for development, and `deploy/handover/` for running the image beside an existing PostgreSQL (`setup.sh` does it in one command) |
| Jest unit tests | **The test numbers live in this row only; update them here.** Measured 2026-11-17: 6,561 tests in 251 suites, all passing with a test database set. Without one, 9 suites holding 225 tests skip themselves. Coverage is measured on `lib/` (`collectCoverageFrom` in `jest.config.mjs`): lines 92.35%, statements 90.19%, branches 81.54%, functions 92.96%. Every page is tested: of the 19 `page.tsx` files, the 17 that show something have suites in `tests/page-*.test.tsx` (the 13 studio pages, login, onboarding, the invitation page and the landing page), and the two that only redirect (`/acme` and `/studio`) are covered by `tests/org-redirect.test.ts`. There are also 45 component suites (`tests/component-*.test.tsx`) |

---

## 8. Styling

`app/globals.css` imports Tailwind v4 and holds the colour, size and shadow
tokens for both themes, plus classes shared across pages. Each page has its own
stylesheet in `app/styles/atelier-<page>.css`, and `atelier-system.css` holds
the design system's classes. Tailwind utilities carry layout and spacing
(`flex`, `grid`, `mt-2`); anything with a look of its own (`.btn`, `.card`,
`.pill`) is a hand-written class built on the tokens.

The theme is the `data-theme` attribute on `<html>`, light or dark
(`hooks/useTheme.ts`).

| Token group | Names |
|---|---|
| Surfaces | `--bg` `--surface` `--surface-2` `--surface-3` |
| Lines | `--border` `--border-strong` |
| Text | `--text` `--text-2` `--text-3` `--text-inv` |
| Brand | `--brand` `--brand-2` `--brand-soft` `--brand-soft-2` |
| Status | `--sync` `--pending` `--drift` `--break`, each with a `-soft` pair |
| Differences | `--diff-add-*` `--diff-rem-*` `--diff-chg-*` |
| Elevation | `--shadow-sm` `--shadow-md` `--shadow-lg` |

Fonts are Geist Sans and Geist Mono through `next/font`.

---

## 9. Working on it

- Never commit `.env.local` or any `.env` file with real values in it.
- Run `npm run lint`, `npm run typecheck` and `npm test` (with a test
  database) before pushing; CI runs the same and more (the developer manual,
  section 9).
- A change to the app's tables also needs the handover SQL remade, or CI
  fails (the developer manual, section 10).
