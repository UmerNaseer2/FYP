# Schema Studio

Compare two live PostgreSQL schemas, generate the migration that closes the gap,
version it in a GitHub script registry, and apply it to a target database inside a
transaction — with a per-database ledger recording what was applied and when.

Final-year project, Swinburne Sarawak. This file describes the web app: what
exists, what does not, and how to run it. The other guides are listed in §7.
It was last checked against the code on 10 November 2026, at commit `e1a4d0c`.
If something here disagrees with the code, the code is right and this file
needs a fix.

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
npm run dev          # http://localhost:3000 opens the landing page
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

That build asks everyone to sign in, so it needs `NEXTAUTH_SECRET` and the keys
of one sign-in provider in a `.env` beside `docker-compose.yml`: the three
`AZURE_AD_*` keys for Microsoft, or `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` for GitHub (see
[deploy/README.md](../deploy/README.md), step 4). For a quick look on your own
machine without them, turn the test bypass on for that build:

```bash
NEXT_PUBLIC_AUTH_BYPASS=true docker compose up --build
```

Create `my-app/.env.local` (git-ignored, never commit it):

| Key | Purpose | Required |
| --- | --- | --- |
| `DATABASE_URL_A` | The tool's own metadata database: connections, lineage, snapshots | yes |
| `GITHUB_PAT` | Personal access token with `contents:write` on the script registry repo, used by the default organization until an admin saves one on the Admin screen, under GitHub | for push/pull |
| `GITHUB_REPO_OWNER` | Owner of the registry repo, the same way | for push/pull |
| `GITHUB_REPO_NAME` | Name of the registry repo, the same way | for push/pull |
| `AZURE_AD_CLIENT_ID` | Microsoft Entra app registration | for real sign-in, see §5 |
| `AZURE_AD_CLIENT_SECRET` | Microsoft Entra app secret | for real sign-in, see §5 |
| `AZURE_AD_TENANT_ID` | Microsoft Entra tenant | for real sign-in, see §5 |
| `NEXTAUTH_SECRET` | Session encryption key | for real sign-in, see §5 |
| `GITHUB_CLIENT_ID` | GitHub OAuth app, for the "Continue with GitHub" button. The button is offered only when this and the secret below are both set | for GitHub sign-in |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app secret | for GitHub sign-in |
| `AI_BASE_URL` | Address of an OpenAI-compatible AI service, starting with `http://` or `https://`. AI stays off on this server unless this, `AI_API_KEY` and at least one model below are set (`lib/ai/config.ts`). An organization can also save its own key on the Admin screen, under AI | for the AI features, see §5 |
| `AI_API_KEY` | The key for that service | for the AI features |
| `AI_MODEL_FAST` | Model for short summaries. If only one of the two models is set, it is used for both | for the AI features |
| `AI_MODEL_SMART` | Model for reviews and explanations | for the AI features |
| `AI_REASONING_EFFORT` | `low`, `medium` or `high`, passed on to the service. Anything else leaves it to the model | no |
| `AI_TIMEOUT_MS` | How long one AI call may take | no, defaults to 90000 (90 seconds) |
| `AI_DAILY_LIMIT` | AI calls one organization may make in a day | no, defaults to 300 |
| `AI_PER_MINUTE` | AI calls one person may make in a minute | no, defaults to 10 |
| `DRIFT_SCHEDULER` | `off` stops the background drift loop; anything else leaves it on | no, defaults to on |
| `APP_ENCRYPTION_KEY` | Encrypts saved database passwords and each organization's GitHub access token at rest. With neither this nor `NEXTAUTH_SECRET` set, passwords are stored as plain text, the server only logs a warning, and no GitHub token can be saved | no, but set it |
| `ALLOW_PRIVATE_DB_HOSTS` | `true` lets a production deployment dial loopback, unix sockets and RFC1918 addresses. Off, those are refused in production only, so local development still works | no, defaults to off |
| `NEXT_PUBLIC_AUTH_BYPASS` | `true` (or `1`/`yes`/`on`, any case) skips login and signs you in as admin, or as the role picked in View as. Read at BUILD time, not run time — see §5 | no, defaults to real sign-in |

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
6. **Version sync**: pick a Source schema that is ahead and a Target schema that
   is behind. The page reads both ledgers, lists the versions missing on the
   Target, and replays them there in one transaction.
7. **Drift** — snapshot a tracked schema, then compare the live schema against that
   snapshot later; acknowledge or re-baseline the difference. Worth doing right
   after step 5: the moment a database is most likely to drift is just after
   somebody changed it.
8. **Performance** — suggestions from the catalog and the statistics views, an
   `EXPLAIN` of one query, the history of analysed queries, live activity, the
   trends monitoring has collected, and alert levels.
9. **Visualizer** — side-by-side entity-relationship diagrams of both schemas.

After these nine the sidebar lists Connections, Requests and Admin. Requests is
where a member asks for a permission their role does not have, and where a
production run waiting for approval shows up for the people who can approve it.

The sidebar is in this order for the same reason, and the screens hand over to
each other: each one offers a link onward at the point where it has actually
produced something — Connections to Compare, Compare to Deploy once a version
is pushed, Deploy to both Version sync and Drift. So the path is followable
without knowing it in advance.

It is a path rather than a strict 1-to-9 chain, and the places it departs from
the list are deliberate. Compare hands straight to Deploy because its workbench
does the editing inline; step 4 is where you land instead when you start from an
already-saved script, or from a Performance fix. Performance therefore feeds
backwards as well as forwards — a fix it suggests is saved as a migration and
opens in the Script Editor. The Visualizer offers Compare as its only
next step, because reading a diagram is a thing people come to do on its own. Connections and Admin sit
apart at the bottom: both are setup rather than steps, and Admin is the one
screen that leads nowhere, which is correct for it.

---

## 3. Layout

```
my-app/
  app/
    page.tsx                  the landing page at "/": Create account and Log in
    login/                    sign-in page: Continue with Microsoft, Continue with GitHub
    onboarding/               "Your organizations": the list, and a form to make a new one
    invite/[token]/           the page an invitation link opens, with a Join button
    demo/                     a public placeholder page for the live demo
    [org]/                    one organization's pages: /acme/studio, /acme/compare, and so on
      layout.tsx              checks the visitor is a member, tells the pages which organization
      page.tsx                /acme opens /acme/studio
      phone/                  the phone app: drift, history, approvals and alerts
      link-computer/          approve a computer that asks to be linked to your account
      (studio)/               the app shell; every page below shares it
        studio/               dashboard: tracked schemas and their drift status
        connections/          connection CRUD + test
        compare/              live-vs-live schema comparison
        script-editor/        review, edit, semver-classify, push to GitHub
        deploy/               pre-flight → select → transactional apply → ledger
        drift/                snapshot-vs-live drift, acknowledge / re-baseline
        schemas/[id]/         lineage detail for one tracked schema
        versionsync/          replay the versions a Source has and a Target is missing
        visualizer/           React Flow ERD
        admin/                five tabs: Users, Roles & permissions, Organization, GitHub, AI
        performance/          suggestions, query analysis, history, live activity, trends, alerts
        requests/             ask for a permission, answer requests, see runs waiting for approval
    studio/, compare/, …      the addresses from before organizations, one per page above:
                              each [[...rest]]/page.tsx sends /compare?left=1 on to the
                              organization opened last (lib/org-redirect.ts)
    api/                      the route handlers, listed in full below
    globals.css               all styling (see §6)
  components/
    ui/                       design-system primitives
    studio/                   feature components (DiffReport, MigrationWorkbench, …)
    studio/visualizer/        ERD panes and nodes
  lib/                        all domain logic — see the table below
    db/                       Sequelize instance, models, one-time schema sync
    ai/                       the AI features: settings, the two service clients, prompts, checks
  hooks/                      useUser, useOrg, useTheme, useRequestCounts and four more
  scripts/                    seed-test-schemas.cjs, the AI benchmark (ai-bench*.cjs),
                              and move-data.cjs / move-connections.cjs for moving an
                              organization to another metadata database
  components/AuthGuard.tsx    client-side gate; reads the same switch the server does
  auth.ts                     NextAuth v5 config
  auth.config.ts              the edge-safe half of that config, imported by proxy.ts;
                              the Microsoft Entra and GitHub providers are set up here
  proxy.ts                    middleware: the page-level session check
  instrumentation.ts          server start-up; this is what launches the drift scheduler
```

### Library modules

| Module | Role |
| --- | --- |
| `lib/compare.ts` | The diff engine: weighted similarity, mutual-best matching, rename guard |
| `lib/compare-utils.ts` | Levenshtein, Jaccard, multiset helpers used by the scorer |
| `lib/compare-types.ts` | Shared types for snapshots and reports |
| `lib/postgres.ts` | Catalog introspection, connection-pool cache, schema-qualifier stripping |
| `lib/generate-sql.ts` | Migration generator (`generateMigration()`) and its rollback (`generateRollback()`); the order it writes statements in is under *How the comparison engine works* below |
| `lib/sql-guard.ts` | Destructive-statement detection |
| `lib/lineage-db.ts` | `tracked_schemas`, `snapshots`, `lineage_migrations`, `drift_events` |
| `lib/drift-runner.ts` | One drift check plus its audit row — shared by the button, the scheduler and tracking |
| `lib/drift-schedule.ts` | Cadence arithmetic: what is due, what is overdue. Pure, so it is unit-tested |
| `lib/drift-scheduler.ts` | The background loop itself; the only timer in the process |
| `lib/query-analysis.ts` | Reads an `EXPLAIN` plan and says what is wrong with it. Pure |
| `lib/schema-metrics.ts` | `schema_metrics`: takes a reading, reads a window, prunes the tail |
| `lib/metrics-series.ts` | Readings to plot geometry, ticks and a sentence. Pure |
| `lib/snapshot-format.ts` | The snapshot format version, and what to do with an older one |
| `lib/db/sequelize.ts` | The one Sequelize instance, plus `metadataPool`, a `pg.Pool`-shaped adapter over its pool that every metadata read and write goes through |
| `lib/db/models.ts` | Every metadata table as a Sequelize model. The list in §4 is described from this file. The models are used to create the tables, not to query them |
| `lib/db/bootstrap.ts` | `syncMetadataTables()` — creates the tables once per process |
| `lib/version-db.ts` | Re-exports the metadata pool and `syncMetadataTables()`, so every caller reaches the metadata database through one module |
| `lib/ai/` | The AI features. `config.ts` reads the `AI_*` settings, `openai-compatible.ts` and `anthropic.ts` talk to the service, `prompts/index.ts` names the six features and the rules every prompt starts with, `features/` holds the code of each feature, `checks.ts` checks an answer before it is shown, and `store.ts` counts calls and caches answers |
| `lib/permissions.ts` | The permission catalogue: every feature and its permissions, what Viewer and Editor start with, the rule that turning a permission on also turns on its feature's Read, and the refusal sentence. Pure |
| `lib/roles-db.ts` | `roles`, `role_permissions` and `role_changes`: what a role may do, making, editing and deleting roles, and the change log |
| `lib/auth-guard.ts` | `requirePermission()` and `requireSignedIn()`, the gate every route opens with, and the View as role while the bypass is on |
| `lib/script-status.ts` | Pending / applied / superseded classification against the ledger |
| `lib/version-sync.ts` | Ledger reconciliation helpers |
| `lib/version-detection.ts` | Change-level severity, plus detecting an existing version table in a target |
| `lib/connection-config.ts` | Builds a `pg` config from a saved row; host allow-list check |
| `lib/parse-uri.ts` | `postgres://` URI parsing |
| `lib/connection-access.ts` | Who may execute against a connection on top of "Apply or revert migrations" (`deploy:run`), and why "none" is not the weakest rank. Pure |
| `lib/dialects.ts` | What the app knows about each engine, and which ones are actually implemented. Pure |
| `lib/comparison-history.ts` | Diffs this comparison against the last one of the same pair. Pure |
| `lib/comparison-history-db.ts` | `comparison_runs`: stores a run, reads the previous one |
| `lib/compare-export.ts` | Flattens a report into the document the exporters format. Pure |
| `lib/application-targeting.ts` | Which application a migration is allowed to touch |
| `lib/perf-thresholds.ts` | Per-schema alert levels and the banner they drive |
| `lib/query-score.ts` | Turns an analysed plan into one comparable number. Pure |

### API routes

The 83 `route.ts` files under `app/api/`, read down each column:

```
admin/ai                    computers/jobs/[id]           lineage/schemas
admin/ai/key                computers/link                lineage/track
admin/github                connections                   me
admin/invites               connections/computers         me/approver
admin/organization          connections/machine           me/view-as
admin/roles                 connections/phone             organizations
admin/users                 connections/test              performance/activity
agent/connections           connections/test-saved        performance/advice
agent/jobs/[id]             deploy/approvals              performance/analyze
agent/jobs/next             deploy/approvals/[id]         performance/cancel
agent/link                  deploy/approvals/[id]/phone   performance/history
agent/link/claim            deploy/approvals/phone        performance/metrics
agent/self                  deploy/phone                  performance/thresholds
agent/sync                  desktop/sync                  phone/push
agent/sync/connections      github/family                 phone/push/test
agent/sync/drift            github/pull                   requests
ai/chat                     github/push                   requests/[id]
ai/rate                     internal/drift-tick           requests/seen
ai/status                   invites/accept                schema/snapshot
auth/[...nextauth]          lineage                       scripts/apply
compare                     lineage/[id]                  scripts/attempts
compare/phone               lineage/acknowledge           scripts/generate
compare/summary             lineage/audit                 scripts/preflight
compare/version-history     lineage/drift                 scripts/revert
comparison-sets             lineage/drift/explain         scripts/review
computers                   lineage/lookup                scripts/schemas
computers/[id]              lineage/rebaseline            versionsync/ledger
computers/jobs              lineage/schedule
```

Most of them open with a gate from `lib/auth-guard.ts`. The usual one is
`requirePermission()` with one or more boxes from the Admin screen's grid, such
as `"connections:update"`, which lets the request through when the person's role
has any one of them. A route that several screens read for their pickers names
the Read box of each of those screens. What each role may do lives in the
database (`roles`, `role_permissions`), and the boxes themselves are listed
once, in `lib/permissions.ts`. Approval is not a role either, but a second
*person*, which `lib/approvals-db.ts` enforces per run.

Three smaller groups use a different check, and
`tests/permissions-coverage.test.ts` names every route in each group:

- **Any member of the organization** (`requireMember()`): `me`, `me/approver`,
  `me/view-as`, `requests`, `requests/[id]`, `requests/seen`, `phone/push` and
  `phone/push/test`. These are about the person asking, not about a feature.
- **Anyone signed in** (`requireSignedIn()`): `organizations` and
  `invites/accept`, because they must answer people who are not in any
  organization yet.
- **No person's session at all**, twelve routes: `auth/[...nextauth]` is the
  sign-in endpoint itself; `internal/drift-tick` is a scheduled call checked
  against `CRON_SECRET`; `agent/link` and `agent/link/claim` are a computer
  asking to be linked, before anyone is known; the other seven `agent/` routes
  are checked against the linked computer's own token; and `desktop/sync` is
  checked against the desktop app's own token and answers 404 on a website.

Two suites keep this honest. `tests/permissions-coverage.test.ts` fails when a
route has no gate, or when a permission an admin can turn on is checked by no
route at all. `tests/permissions-equivalence.test.ts` holds every route that
existed before per-feature permissions to the role it needed then: out of the
box, that role still gets in and the role below it still does not.

### How the comparison engine works

`fetchSchemaSnapshot()` runs 15 catalog queries — tables, columns, constraints,
indexes, triggers, partitioning, row security, policies, views, sequences, types,
extensions, collations, routines and privileges — and returns one normalised
snapshot. They all run on a single connection inside `BEGIN ISOLATION LEVEL
REPEATABLE READ READ ONLY`, so the fifteen answers describe the same instant
rather than fifteen slightly different ones, and a schema being altered while it
is read cannot produce a snapshot that never existed. `compareSchemas()` then:

1. matches tables by exact name;
2. scores every unmatched source table against every unmatched target table on
   column-name overlap, type overlap, and name similarity;
3. keeps only mutual-best pairs above a threshold, and applies a rename guard so a
   weak match becomes a create + drop instead of a rename;
4. repeats the same process for columns inside each matched table.

`generateMigration()` in `lib/generate-sql.ts` then writes the script. It writes
its sections in this order, so that each statement finds what it depends on:
extensions, collations, types and standalone sequences, the functions a new
table needs, dropping views that must be rebuilt, table renames, renames of
owned sequences, `CREATE TABLE`, functions and procedures, changes to matched
tables, dropped tables, indexes, foreign keys, triggers, row security, views,
indexes and triggers on views, ownership and grants, and last the routines,
types, sequences, collations and extensions that nothing uses any more.
`generateRollback()` in the same file writes the script that undoes it.

---

## 4. Data model

In the **metadata database** (`DATABASE_URL_A`) — every table below is declared
as a Sequelize model in `lib/db/models.ts` and created by `syncMetadataTables()`.
That file is the list; this one is a description of it, so check there before
trusting this table to be complete. At commit `e1a4d0c` it declares 34 tables:

| Table | Holds |
| --- | --- |
| `organizations` | Every organization: its name and the address its pages sit under |
| `memberships` | Who is in which organization, and with which role |
| `identities` | The sign-in accounts (Microsoft or GitHub) that belong to a profile |
| `invites` | Invitations to an organization, each with the role it gives |
| `access_requests` | What people ask for on the Requests page, and the answers |
| `organization_github` | One organization's script registry repository and its access token, encrypted |
| `organization_ai` | Whether AI is switched on for an organization, which features, and its own key if it saved one. No row means off |
| `ai_calls` | One row per AI call, for counting and the daily limit. Never the prompt or the answer |
| `ai_results` | Cached AI answers, deleted after a week |
| `agents` | A computer linked to a person's account. Its token is kept only as a hash |
| `agent_links` | A computer waiting to be approved, for ten minutes at most |
| `agent_connections` | The connections a linked computer shares: a name and an environment, never the host, user or password |
| `agent_jobs` | A question waiting for a linked computer, and its answer |
| `push_subscriptions` | Where to send phone and browser alerts |
| `push_keys` | The server's own push key, one row |
| `drift_scheduler_state` | One row: who holds the drift checker's tick, and what the last tick did |
| `metadata_boot_stamps` | One row per deployment that finished setting up these tables |
| `deploy_attempts` | Every deploy attempt, whether or not it landed |
| `connections` | Saved targets: name, host, port, database, user, password, connection string |
| `tracked_schemas` | A `(connection_id, schema_name)` pair given a stable identity |
| `snapshots` | Point-in-time catalog snapshots of a tracked schema |
| `lineage_migrations` | Which migration was applied to which tracked schema |
| `drift_events` | Detected drift, plus acknowledgement state |
| `profiles` | One row per person who has signed in. Their role in each organization is in `memberships`. On the web nobody joins an organization just by signing in: they make their own or accept an invitation. The one exception is a fresh deployment, where the first person from the home Microsoft tenant to sign in while the default organization has no members becomes its admin (`lib/accounts-db.ts`) |
| `roles` | Every role: the three built in, which can't be deleted, and any an admin makes |
| `role_permissions` | The permissions each role has turned on, one row each. Admin has none stored: it can always do everything |
| `role_changes` | The Recent changes list on the Roles & permissions tab: permissions turned on and off, roles made, reset, deleted and given to people, invitations, people removed, and changes to the organization and its GitHub settings |
| `comparison_sets` | A saved source schema plus its list of targets |
| `comparison_set_targets` | One target of a saved set, in a fixed slot |
| `deploy_approvals` | Approval requests, decisions, and the two-person record |
| `schema_metrics` | One reading of a schema's size and shape per drift check, pruned past 90 days |
| `comparison_runs` | What one comparison of a source/target pair found, so the next one can say what changed since |
| `query_history` | Saved EXPLAIN runs, so a query's plan can be compared against its own past |
| `perf_thresholds` | Per-schema alert levels for the performance checks |

### Which database layer talks to what

Two very different kinds of database work happen here, and Sequelize has a
part in only one of them:

- **This app's own database** — the tables above. A fixed schema the app
  owns. Sequelize does two jobs here and no more. It defines every table as a
  model in `lib/db/models.ts` and creates the tables with `sequelize.sync()`
  (`lib/db/bootstrap.ts`), and it owns the one connection pool, five
  connections at most (`lib/db/sequelize.ts`). The reading and writing is not
  done through the models. Every query is parameterised SQL sent through
  `metadataPool`, which borrows the `pg` driver's own client from Sequelize's
  pool: one pool, not two competing for the same connection limit. Nothing in
  `lib/`, `app/` or `scripts/` calls a model's `findAll`, `create`, `update` or
  `destroy`. What `sync()` cannot express, such as a column added to a table
  that already exists, a foreign key added later or an index over an
  expression, is plain SQL in `lib/db/bootstrap.ts` as well.
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

First checked against the code on 9 September 2026, and against a running
instance with a real PostgreSQL behind it. Read against the code again on
10 November 2026, at commit `e1a4d0c`. That second check read the files only:
nothing was run for it. Nothing below is deferred.

### Works end to end

Compare with rename detection · row-data comparison by count and checksum ·
migration generation · script review and editing · semver push to the GitHub
registry · pull back · pre-flight · dry run · approval and the two-person rule ·
transactional apply · `script_patch` ledger · rollback from a `.down.sql` ·
lineage snapshots · drift detection and re-baseline · version-sync
reconciliation · detecting an existing version table in a target · saved
comparison sets · comparing one source against up to six
targets · what changed since the last comparison of the same pair ·
dev/staging/production labels and their warnings ·
roles an admin edits box by box for each feature, custom roles and their
change log · per-connection execution permissions · exporting a diff as
Markdown, JSON or CSV · the ERD visualizer · scheduled drift checking
without a button press · query plan analysis · index and schema suggestions ·
schema metrics over time.

Built after that first check, and in the code at commit `e1a4d0c`:
organizations, each with its own members, roles, connections and GitHub
registry · making an organization on first sign-in, and joining one through an
invitation link · the Requests page · sign-in with GitHub beside Microsoft ·
the AI features (see *AI assistance* below) · a record of every deploy attempt
(`deploy_attempts`) · the phone app and linking a computer to an account, which
have their own guides in `relay/` and `desktop/`.

The **Print / PDF** button is the browser's own print dialog (`window.print()`
in `components/studio/ExportBar.tsx`), with print styles applied. Save-as-PDF is
whatever the browser offers there; the app generates no PDF file itself, which is
why PDF is not in the export list above.

The compare engine introspects tables, columns, constraints, indexes, triggers,
views, sequences, types and routines.

Some of those are new enough to say where they live:

- **Drift is checked on a cadence**, not only when somebody presses the button.
  `lib/drift-scheduler.ts` runs one interval timer in the Next.js server,
  started from `instrumentation.ts`. It wakes every 60s, asks
  `lib/drift-schedule.ts` which tracked schemas are overdue, and runs the same
  check the button runs — at most 6 per tick, 2 at a time, so a backlog drains
  over several ticks instead of opening thirty connections to other people's
  databases at once. `DRIFT_SCHEDULER=off` is the kill switch. Per-schema
  cadence is set on the Drift screen; 0 means manual only.
- **Performance** is six tabs over one schema. *Suggestions* reads
  `pg_stat_user_tables` / `pg_stat_user_indexes` and the catalog for un-indexed
  foreign keys, unused and duplicate indexes, sequential-scan-heavy tables,
  bloat and missing primary keys. *Analyse a query* runs a plain `EXPLAIN`
  first, which plans the query without running it, inside a read-only
  transaction that is always rolled back. Only when the person ticks the
  measure box does it also run `EXPLAIN ANALYZE`, which really runs the query;
  the steps are written at the top of `app/api/performance/analyze/route.ts`.
  *History* lists every query analysed against the schema, with its score.
  *Live activity* is one reading of what the server is running right now.
  *Trends* draws the history that monitoring collects. *Alerts* sets the alert
  levels, and every rule starts switched off.
- **Monitoring** takes one reading per drift check into `schema_metrics`:
  structure counts from the snapshot the check already had, plus a size probe
  against `pg_class`. Readings are pruned past 90 days. Charts are hand-drawn
  SVG; there is no charting dependency.
- **Each connection says who may execute against it**, which is what spec
  feature 1.2 asks for. A role says what a person may do anywhere; it cannot say
  that the same editor is trusted on dev and not on the reference schema, and
  the environment label is only a warning. So running anything needs the
  "Apply or revert migrations" permission (`deploy:run`) first, and then the connection's own setting on top: anyone
  whose role may run deployments (the default), the Admin role only, or nobody.
  `lib/connection-access.ts` holds the rule, the setting is a `<select>` on
  Connections, and both executing routes (`scripts/apply`, `scripts/revert`)
  check it before opening a connection. Three more routes read the same
  setting: `scripts/generate` before it tries AI-written SQL on the database,
  `performance/cancel` before it stops a running query, and `deploy/phone`
  when it tells the phone app what the person may do next. Dry runs are included, because a
  rehearsal really executes the script and only then rolls back. `none` is
  read-only and refuses everybody including admins, which is the point for a
  reference schema others are compared against: it is a fact about the
  database, not a rank to be outranked.
- **A comparison says what changed since the last one of the same pair.**
  `comparison_runs` stores what each run found; `lib/comparison-history.ts`
  diffs the current run against the previous one and the panel on Compare
  reports what appeared and what was resolved. Absent on a first comparison,
  because there is nothing to have drifted from. Only structural differences
  are tracked — row counts move whenever a database is used, and counting that
  as drift would bury the schema change that matters.
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

- **Authentication can be bypassed for testing, and is in local development.**
  `.env.local.example` sets `NEXT_PUBLIC_AUTH_BYPASS=true`, and
  `docker-compose.yml` does only when asked
  (`NEXT_PUBLIC_AUTH_BYPASS=true docker compose up --build`). With it on,
  `lib/auth-mode.ts` reports the bypass as on and both the UI guard and
  `lib/auth-guard.ts` let every request through as an admin, or as the role
  picked in View as (below). The wiring underneath is complete: every API route
  that a person calls opens with `requirePermission`, `requireMember` or
  `requireSignedIn` (the list of exceptions is under *API routes* in §3), and
  the `profiles` and role tables are created with the
  rest of the metadata schema. Remove that line — or
  set it to anything that is not `true`, `1`, `yes` or `on` — and the whole
  thing turns on, and then `NEXTAUTH_SECRET` and the keys of one sign-in
  provider in §1 (Microsoft or GitHub) have to be set for anyone to get in.

  **The default is real sign-in, and that asymmetry is deliberate.** It used to
  be the other way round, because a fresh checkout could then be used straight
  away. But the two mistakes are not equally visible: a checkout that comes up
  locked says so on the first click, while one that comes up open used to look
  exactly like one that is properly signed in — there is no sign-in screen
  either way. So an unrecognised value, and a deployment that forgets the
  variable, get real sign-in. The spellings work the same way: an allow-list of
  the things a person writes meaning *on*, with everything else falling to the
  safe side.

  **It is read when the app is BUILT, not when it runs.** Next substitutes every
  `NEXT_PUBLIC_` variable for its value during compilation, so what ships is a
  hard-coded true or false. `npm run dev` recompiles and picks up an edit to
  `.env.local` on the next request; a built app does not, and setting the
  variable next to a running container does nothing at all. Rebuild, or for
  Docker pass `--build-arg NEXT_PUBLIC_AUTH_BYPASS=true`.

  **How to tell which one you got, without reading the source.** The bottom-left
  corner of the studio rail, under your name and address, carries your role's
  name (Viewer, Editor, Admin or one an admin made), with a tooltip saying what
  it buys you, and, when the bypass is on, an `auth off` pill beside it. Both,
  never just the role: Admin on its own is the half that would be reassuring
  and wrong. The
  role is withheld entirely when nobody is signed in, because the code's floor
  for a missing session is `viewer` and a badge saying so under *Not signed in*
  would read as a role somebody holds.

  **View as, for checking a role without signing in as it.** While the bypass
  is on, a View as picker sits under your name on the studio rail. Picking a
  role asks `POST /api/me/view-as` to leave a cookie naming it, for this
  browser session only, and from then on every route answers as that role and
  every screen shows what it may use. That is how the boxes on the Admin screen
  get checked without signing in as each role. "Admin (everything)" clears the
  cookie, and the picker stays on the rail whatever role is picked, so there is
  always a way back. With real sign-in the route answers 404 and the cookie is
  never read, so nobody can use it to raise their own role.

### Two rules that only bite in production

- **Private hosts are refused when `NODE_ENV=production`.** Loopback, the
  RFC1918 ranges, and a host that is a unix socket — one starting with `/` or
  `@`, or left out of a connection string entirely, since `pg` then falls back
  to the local socket — all count as private and are blocked, because each of
  them reaches the app server's own machine. Cloud metadata and link-local
  addresses are blocked everywhere, production or not. `ALLOW_PRIVATE_DB_HOSTS=true`
  opts back in for a trusted or VPC deployment. Development is unaffected, which
  is why a localhost target works locally and then fails once deployed.
- **A production approval expires after a week** (`APPROVAL_VALID_HOURS`, 24 × 7).
  The run fingerprint pins *what* was approved but not *when*, and a month-old
  yes was a judgement about a database as it stood a month ago. Past the expiry
  the run simply reads as unapproved again — it is not an error, and asking
  again costs one click.

### Not built at all

All eleven spec features have a screen, and that sentence used to stand here on
its own as "nothing in the spec is unbuilt". It was true one level up and false
one level down: the spec's features are headings, each with its own bullets, and
counted as bullets rather than headings some are not built. They are listed here
rather than left for a marker to find.

- **Multiple database types** (feature 2.4). PostgreSQL only.
  `lib/dialects.ts` names the three engines the app has an opinion about and
  carries an `implemented` flag; only PostgreSQL has it, and
  `SUPPORTED_TYPES` in `lib/connection-validate.ts` is derived from that flag
  rather than written out separately. What that file buys is honesty, not
  coverage: a MySQL connection is now refused with a reason instead of being
  saved and then silently filtered out of Compare. Introspection is still
  `pg_catalog` and `information_schema` throughout and the generator still
  emits PostgreSQL DDL, so a second engine remains a second implementation of
  the whole read path, not a setting. The spec says "(primary PostgreSQL)" and
  that is what this is.
Microsoft sign-in (feature 1) used to be on this list as "written and
unreachable". It is off the list now. Real sign-in is the default, the login
page offers "Continue with Microsoft" and "Continue with GitHub", and each
button works once its keys from §1 are set. A deployment with no keys shows the
login page with a notice that says which keys are missing.

The rest of the list is worked through in the sections above and in the code.
Where a bullet is met in a narrower way than the wording suggests, the narrowing
is written down next to the code that does it rather than here.

### AI assistance

This section used to be called "No AI anywhere". That is no longer true. The
code is in `lib/ai/`, and there are six AI features
(`lib/ai/prompts/index.ts`):

| Feature | Where it shows | Route |
| --- | --- | --- |
| Compare change summary | Compare, the "Change summary" panel | `compare/summary` |
| Migration review before deploy | Deploy, "Review with AI" | `scripts/review` |
| Explain drift | Drift, "Explain with AI" | `lineage/drift/explain` |
| One line in drift alerts | Added to a drift alert by the scheduler (`lib/ai/drift-alert-line.ts`) | none |
| Write SQL from plain words | Script Editor, "Write it with AI" | `scripts/generate` |
| Schema chat | "Ask AI" in the top bar | `ai/chat` |

What has to be true before anyone sees an AI button:

1. The server has an AI service set up with the `AI_*` keys in §1, or the
   organization has saved its own key on the Admin screen, under AI. The own
   key can be for Anthropic Claude, Google Gemini or OpenAI
   (`lib/ai/key-providers.ts`). It is stored encrypted.
2. An Admin has switched AI on for the organization on the same tab. It is off
   for every organization until then (`organization_ai`, where no row means
   off). Each of the six features has its own switch there as well.
3. The person's role has the "Use AI assistance" permission (`ai:read`). Editor
   and Admin have it out of the box, Viewer does not.

What the code does to keep the answers honest:

- Only schema structure and the SQL of the scripts under review are sent. Rows
  of data, passwords and connection addresses are not.
- `lib/ai/checks.ts` checks an answer before it is shown. A point that names a
  table or column that does not exist is dropped. The change level (patch,
  additive or breaking) always comes from the app's own engine, never from the
  model. SQL the model writes is refused if it contains transaction control.
- Nothing the AI writes runs by itself. A script it drafts is saved and
  deployed through the same permissions as any other script. On a target
  labelled Dev or Staging, and only for a person who may run scripts there,
  the app first tries the drafted script and its rollback inside one
  transaction that is always rolled back
  (`lib/ai/features/sql-generate-trial.ts`).
- Calls are counted in `ai_calls`. One organization gets `AI_DAILY_LIMIT` calls
  a day (300 unless set) and one person `AI_PER_MINUTE` calls a minute (10
  unless set). Checked answers are cached in `ai_results` for a week.

Of the six spec features that carry the line "Use of AI for this feature is
highly desirable", three now have an AI feature: difference reporting (the
change summary), SQL generation (write SQL from plain words) and migration
validation (the migration review). The other three, query analysis, performance
suggestion and performance monitoring, are still produced only by the rules
written out in `lib/`. No AI code is used on the Performance screen.

`npm run ai:bench` runs the AI test sets in `scripts/ai-bench-cases.cjs`
against a running copy of the app and grades the answers.

### Compliance sheet

| Required | State |
| --- | --- |
| Next.js | met: 16.4.5, App Router, React 19.2.4, TypeScript 5 |
| PostgreSQL with Sequelize | met, with this limit: Sequelize defines and creates the tables of the metadata database and owns its connection pool (§4). It does not do the reading and writing. Every query, on the metadata database and on the target databases, is SQL sent through the `pg` driver |
| Microsoft OAuth via NextAuth | met: NextAuth v5 with the Microsoft Entra ID provider, set up in `auth.config.ts` and `auth.ts`, with GitHub as a second provider. Real sign-in is the default. `NEXT_PUBLIC_AUTH_BYPASS` switches it off for testing (§5) |
| fetch / axios with UI ↔ API separation | met — every page fetches its data from a route handler |
| Tailwind or standard CSS | met: Tailwind v4 utilities for layout and spacing, plus hand-written classes in `globals.css` (§6) |
| Docker | met — multi-stage `my-app/Dockerfile` on the Next.js standalone output, plus `.dockerignore`, and a root `docker-compose.yml` that brings up Postgres 17 and the app together |
| Jest unit tests | met. **The test numbers are written in this row only; update them here.** With the review fixes of 2026-11-10 on top of commit `e1a4d0c`: 6,996 tests in 264 suites, all passing when a test database is set (`TEST_DATABASE_URL`). Without one, 11 suites holding 293 tests skip themselves. Coverage as configured is measured on the `lib/` folder only (`collectCoverageFrom` in `jest.config.mjs`): lines 92.61%, statements 90.48%, branches 82.99%, functions 93.8% (measured with the test database set). The sheet asks for "unit testing for all the webpages". There are 34 `page.tsx` files. The 19 that show something each have a suite of their own in `tests/page-*.test.tsx` (23 files): the 12 studio pages, the phone app, the link-a-computer page, login, onboarding, the invitation page, the demo page and the landing page. They sit alongside 41 component suites (`tests/component-*.test.tsx`), with `lib/` and the route handlers covered as before. The landing page at `app/page.tsx` has two: `tests/page-root.test.ts` for whom it shows the page to and whom it sends on, and `tests/component-landing-page.test.tsx` for what the page says and where its buttons go. The other 15 pages only redirect: `/acme` and the 14 addresses from before organizations, covered by `tests/org-redirect.test.ts`. jsdom is asked for per file: `/** @jest-environment jsdom */` on the first line: rather than switched on globally, so the logic suites keep a node environment and their start-up time |

---

## 6. Styling

All styling lives in `app/globals.css` (about 1,800 lines) as CSS custom
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

- `main` is the trunk. Work lands there, and both the Swinburne test server
  (which takes only signed commits that pass CI) and the Vercel project deploy
  from it. The per-person branches (`Umer-dev`, `Cindy-dev`, `mei-dev`, `G-DEV`
  and `test`) and the older work branches are not kept level with it, so
  compare one with `main` before working from it.
- This README describes the web app. The other tracked guides sit beside what
  they cover: `deploy/` (running it on a server, the container and disk images,
  hardening, and Supabase with Vercel), `desktop/` (the Ubuntu app, its security
  notes and a demo script) and `relay/` (the phone relay and the phone app). The
  root `README.md` points to each of them, and `docs/` holds the coursework
  documents, the project context, a demo script and the user manual.
- Working notes, reviews and generated reports go in `my-app/docs/`, which git
  ignores, so they stay on the machine that wrote them. The FYP-B review
  (`schema-studio-fyp-b-review.html`, with the subsystem maps, the spec trace,
  54 findings, the market comparison against fourteen commercial tools, and the
  roadmap) is one of them. Open it in a browser.
- Never commit `.env.local`. Repository history was purged of leaked credentials
  on 11 June 2026; the affected tokens still need rotating.
