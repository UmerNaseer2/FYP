# Schema Studio developer manual

This is for a developer who takes the code over: how the app is built, where
everything lives, which files to open to change a feature, and the rules the
code follows. It describes the `handover` branch, which is the web app only.

Read it with the code open. Every file named here exists; if one has moved, the
code is right and this file needs fixing in the same change.

Other documents:

| For | Read |
|---|---|
| Installing and running the finished image | [`deploy/handover/SETUP-GUIDE.md`](../deploy/handover/SETUP-GUIDE.md) |
| Using the app, screen by screen | [`user-manual/schema-studio-user-manual.txt`](user-manual/schema-studio-user-manual.txt) |
| Why the SQL is written by hand | [`RAW-SQL.md`](RAW-SQL.md) |
| How a schema is read | [`my-app/lib/postgres/README.md`](../my-app/lib/postgres/README.md) |
| How a migration script is written | [`my-app/lib/sql/generate/README.md`](../my-app/lib/sql/generate/README.md) |

## Contents

1. [The system in one picture](#1-the-system-in-one-picture)
2. [Codebase map](#2-codebase-map)
3. [Where each feature lives](#3-where-each-feature-lives)
4. [Conventions, and the exceptions](#4-conventions-and-the-exceptions)
5. [Roles and permissions, walked through](#5-roles-and-permissions-walked-through)
6. [The entry point and the `[[...rest]]` folder](#6-the-entry-point-and-the-rest-folder)
7. [Data model](#7-data-model)
8. [How compare, deploy and drift work](#8-how-compare-deploy-and-drift-work)
9. [Running, testing and CI](#9-running-testing-and-ci)
10. [Recipes](#10-recipes)
11. [Large files still to split](#11-large-files-still-to-split)
12. [Ideas for later](#12-ideas-for-later)

## 1. The system in one picture

Schema Studio is one Next.js 16 app (React 19, TypeScript). The same server
draws the pages and answers the API. It talks to four outside things.

```
 Browser
   pages in app/[org]/(studio)/...         (React, "use client")
      |
      |  apiFetch("/api/...")  adds the header x-schema-studio-org: <slug>
      v
 Next.js server
   proxy.ts                 pages only: is there a session? if not, /login
   app/api/<area>/route.ts  every route opens with a gate from lib/auth/guard.ts
   lib/<feature>/           the logic, one folder per feature
   instrumentation.ts       starts the drift scheduler when the server starts
      |
      +--> The app's own PostgreSQL     DATABASE_URL_A
      |      28 tables: organizations, people, roles, saved connections,
      |      snapshots, versions, drift, approvals (lib/db/models.ts)
      |
      +--> The databases people compare and deploy to
      |      saved on the Connections page, read from pg_catalog
      |      (lib/postgres/), changed with generated SQL (lib/sql/generate/)
      |
      +--> GitHub                       the script registry, one repository
      |                                 per organization (lib/github/)
      |
      +--> Microsoft Entra ID           sign-in, through NextAuth v5
      |                                 (auth.ts, auth.config.ts)
      |
      +--> An AI service (optional)     off until set up (lib/ai/)
```

### One request, start to finish

Take a person opening Compare for the organization `acme`.

1. The browser asks for `/acme/compare`. `proxy.ts` runs first. The path is not
   in `lib/auth/public-paths.ts`, so it needs a session cookie; without one the
   person goes to `/login`. The proxy only checks that a session exists. It
   does not look at roles.
2. `app/[org]/layout.tsx` reads the slug `acme`, finds the organization with
   `resolveOrganization()` (`lib/auth/guard.ts`) and checks the person is a
   member. A non-member gets a 404, so a stranger cannot even tell the
   organization exists. A member gets the pages wrapped in `OrgProvider`
   (`components/OrgProvider.tsx`), which tells every page which organization
   it is in.
3. `app/[org]/(studio)/layout.tsx` draws the shell: sidebar, top bar, help
   panel (`components/studio/StudioShell.tsx`).
4. `app/[org]/(studio)/compare/layout.tsx` wraps the page in
   `<AuthGuard feature="compare">`. If the person's role cannot read Compare,
   the page shows a refusal with an "ask an admin" button instead. This is for
   the person's benefit only. The real check is on the server, in step 6.
5. The page calls `apiFetch("/api/compare?...")` (`lib/ui/api-fetch.ts`).
   `apiFetch` reads the slug from the address bar and sends it as the
   `x-schema-studio-org` header.
6. `app/api/compare/route.ts` opens with
   `requirePermission("compare:read")`. That reads the session, the
   organization from the header, the person's membership and their role's
   permissions from the database. It answers 401, 404, 403 or 503 on failure,
   or hands back a `principal` with the person and `orgId`.
7. The route calls `runComparison(orgId, ...)` in `lib/compare/run.ts`, which
   loads the two saved connections (only from this organization), reads both
   schemas with `fetchSchemaSnapshot()`, compares them with `compareSchemas()`
   and writes the script with `generateMigration()`.
8. The route returns JSON and the page draws it.

Two rules follow from this, and the whole codebase keeps them:

- **The browser never talks to a database.** Every page gets its data from a
  route in `app/api/`.
- **Every route decides access for itself.** The proxy, the layouts and
  `AuthGuard` are conveniences. A route without a gate is a bug, and a test
  fails on it (section 5).

## 2. Codebase map

### The repository

| Path | What it is |
|---|---|
| `my-app/` | The app. Everything below is inside it unless it says otherwise. |
| `deploy/handover/` | The kit for running the finished image on a machine with its own PostgreSQL: compose files, `example.env`, the SQL files, `make-sql.sh`, `SETUP-GUIDE.md` |
| `deploy/SUPABASE-VERCEL.md` | Running it on Supabase and Vercel instead |
| `docs/` | This manual, the raw SQL write-up, the user manual |
| `docker-compose.yml` | A developer stack: PostgreSQL 17 and the app built from source |
| `.github/workflows/ci.yml` | CI (section 9) |

### Inside `my-app/`

| Path | What it is |
|---|---|
| `app/` | Pages, layouts and API routes (Next.js App Router) |
| `components/` | React components shared by more than one page |
| `hooks/` | React hooks: `useUser`, `useOrg`, `useTheme`, `useRequestCounts`, `useDialogFocus`, `useMigrationDraft`, `useNow` |
| `lib/` | All the logic, one folder per feature |
| `tests/` | Every test, in one flat folder, named by prefix |
| `scripts/` | `seed-test-schemas.cjs` (four sample schemas) and the AI benchmark (`ai-bench*.cjs`) |
| `proxy.ts` | Next.js middleware: the page-level session check |
| `auth.ts`, `auth.config.ts` | NextAuth v5. `auth.config.ts` is the half the proxy can load (providers, pages, the token shape); `auth.ts` adds the database work done at sign-in |
| `instrumentation.ts` | Runs once when the server starts; starts the drift scheduler |
| `Dockerfile` | The image: three stages, Next.js standalone output |
| `.env.local.example` | Every setting, explained. Copy it to `.env.local` |
| `jest.config.mjs`, `eslint.config.mjs`, `tsconfig.json`, `next.config.ts` | Tool settings. `@/` means `my-app/` |

### `app/`

```
app/
  page.tsx                    "/" the landing page (Create account, Log in)
  layout.tsx                  the root layout: fonts, theme, atelier-system.css
  login/                      sign-in page
  onboarding/                 "Your organizations": the list, and a form to make one
  invite/[token]/             the page an invitation link opens
  studio/[[...rest]]/         /studio and anything under it: sends you on to
                              /<your last organization>/studio (section 6)
  [org]/                      one organization: /acme/...
    layout.tsx                membership check, OrgProvider
    page.tsx                  /acme goes to /acme/studio
    (studio)/                 a route group: shares the shell, adds nothing to the address
      layout.tsx              StudioShell (plus the View as cookie while the bypass is on)
      error.tsx               what a page shows when it throws
      studio/                 Dashboard
      connections/  compare/  script-editor/  deploy/  versionsync/
      drift/  history/  performance/  visualizer/  requests/  admin/
      schemas/[id]/           one tracked schema
  api/                        59 route.ts files, grouped by area (section 3)
  globals.css                 tokens, Tailwind import, shared classes
  styles/atelier-*.css        one stylesheet per page, plus atelier-system.css
  error.tsx, global-error.tsx, not-found.tsx
```

### `lib/`

Each folder is one feature. A file ending in `-db.ts` holds SQL on the app's
own tables. A file the comments call "Pure" has no database, network or
React in it, so it is tested on its own.

| Folder | Holds | Start with |
|---|---|---|
| `lib/auth/` | Sign-in mode, the gate on every route, session helpers, the sign-in database work | `guard.ts`, `mode.ts`, `accounts-db.ts`, `public-paths.ts` |
| `lib/orgs/` | Organizations, slugs, invitations, "send me to my last organization" | `orgs-db.ts`, `slug.ts`, `redirect.ts`, `invites-db.ts` |
| `lib/roles/` | The permission catalogue, roles in the database, access requests | `permissions.ts`, `roles-db.ts`, `access-requests-db.ts` |
| `lib/connections/` | Saved connections: parsing, checking, encrypting passwords, who may run on each | `config.ts`, `validate.ts`, `writes.ts`, `access.ts`, `host-guard.ts`, `secret-store.ts` |
| `lib/postgres/` | Reading a schema out of the catalog into a `SchemaSnapshot` | `README.md`, `snapshot.ts`, `catalog/` |
| `lib/compare/` | The comparison engine, saved sets, history, data compare, export | `run.ts`, `diff.ts`, `sets.ts`, `history.ts` |
| `lib/sql/` | `generate/` writes migration and rollback scripts; `guard.ts` spots destructive statements | `generate/README.md`, `generate/migration.ts` |
| `lib/versions/` | Tracked schemas, snapshots, the version lineage, change levels, version sync | `lineage-db.ts`, `script-status.ts`, `sync.ts`, `change-level.ts` |
| `lib/deploy/` | Running scripts: limits, transactions, approvals, attempts, rollback, Quick run | `run-settings.ts`, `script-transaction.ts`, `approvals-db.ts`, `attempts-db.ts` |
| `lib/drift/` | Drift checks and the background scheduler | `runner.ts`, `schedule.ts`, `scheduler.ts` |
| `lib/performance/` | Index and schema advice, `EXPLAIN` analysis, query history, metrics, alert levels | `advice/`, `query-analysis/`, `schema-metrics.ts`, `thresholds.ts` |
| `lib/github/` | The script registry: paths, push, pull, each organization's repository and token | `registry.ts`, `registry-paths.ts`, `org-store.ts` |
| `lib/ai/` | The AI features: settings, service clients, prompts, answer checks, counting | `config.ts`, `provider.ts`, `prompts/`, `features/`, `checks.ts`, `store.ts` |
| `lib/help/` | The Help panel's text, one file per page | `index.ts` |
| `lib/ui/` | Browser helpers: `apiFetch`, dates, plurals, friendly errors, the tour | `api-fetch.ts`, `friendly-error.ts`, `tour.ts` |
| `lib/db/` | The app's own database: the Sequelize models, table creation, the one pool | `models.ts`, `bootstrap.ts`, `sequelize.ts` |

`lib/postgres/` and `lib/sql/generate/` each have an `index.ts` that the rest
of the code imports from (`@/lib/postgres`, `@/lib/sql/generate`). Every other
folder is imported file by file.

### `components/`

| Folder | Holds |
|---|---|
| `components/ui/` | The design system: `Button`, `Card`, `Modal`, `Drawer`, `Select`, `Input`, `Pill`, `StatusChip`, `EmptyState`, `ErrorNotice`, `HelpHint`, `Skeleton`, `icons` and the rest. `index.ts` re-exports them |
| `components/studio/` | Pieces of the studio: the shell (`StudioShell`, `StudioSidebar`, `StudioTopbar`, `nav.tsx`, `CommandBar`, `AccountMenu`, `OrgSwitcher`, `ViewAsSwitcher`, `PageHeader`, `AppTour`) and the feature components named in section 3 |
| `components/studio/visualizer/` | The diagram panes and nodes (React Flow) |
| `components/admin/` | The Admin page's tabs |
| `components/help/` | The Help panel and its "Show me" spotlight |
| `components/landing/`, `onboarding/`, `invite/` | The pages outside an organization |
| `components/AuthGuard.tsx` | The screen-level permission check (section 5) |
| `components/OrgProvider.tsx` | Which organization the page is in (read it with `useOrg()`) |
| `components/ViewAsCookie.tsx` | View as, while the sign-in bypass is on |

## 3. Where each feature lives

For each feature: the page folder, the components it uses, the routes it calls,
the logic, its help file, its permission keys and its tests. Change a feature
by working down its row. Paths under `app/[org]/(studio)/` are written as
`(studio)/...`.

### Dashboard

- **Page:** `(studio)/studio/page.tsx`, with `status-line.ts` beside it
- **Components:** `RecheckDriftButton`, `ui/SetupChecklist`
- **Routes:** `lineage`, `lineage/schemas`, `lineage/track`, `lineage/drift`, `lineage/audit`, `comparison-sets`, `connections`, `admin/github`
- **Logic:** `lib/versions/`, `lib/drift/`
- **Help:** `lib/help/studio.ts`
- **Permissions:** `dashboard:*`
- **Tests:** `page-studio`, `studio-*`

### Connections

- **Page:** `(studio)/connections/page.tsx`
- **Routes:** `connections`, `connections/test`, `connections/test-saved`, `connections/machine`
- **Logic:** `lib/connections/` (all of it)
- **Help:** `lib/help/connections.ts`
- **Permissions:** `connections:*`
- **Tests:** `page-connections`, `connection*`, `host-*`, `secret-*`, `access-*`, `local-*`

### Compare

- **Page:** `(studio)/compare/page.tsx` (plus `loading.tsx`)
- **Components:** `DiffReport`, `MigrationWorkbench`, `SummaryMatrix`, `ChangeMap`, `CriticalChanges`, `CompareHistory`, `CompareVersionTimeline`, `ComparisonSetBar`, `DataCompare`, `ExportBar`, `TargetPicker`, `VersionDetectBar`, `CompareSummaryPanel` (AI)
- **Routes:** `compare`, `compare/version-history`, `comparison-sets`, `schema/snapshot`, `compare/summary` (AI)
- **Logic:** `lib/compare/`, `lib/postgres/`, `lib/sql/generate/`
- **Help:** `lib/help/compare.ts`
- **Permissions:** `compare:*`, `comparison_sets:*`
- **Tests:** `page-compare*`, `compare-*`, `comparison-*`, `generate-*`, `snapshot-*`

### Script Editor

- **Page:** `(studio)/script-editor/page.tsx`, with `SqlEditor.tsx` beside it
- **Components:** `SqlGeneratePanel` (AI), `MigrationDraftBanner`; hook `useMigrationDraft`
- **Routes:** `scripts/schemas`, `github/push`, `github/pull`, `scripts/generate` (AI)
- **Logic:** `lib/github/`, `lib/sql/guard.ts`, `lib/versions/change-level.ts`, `lib/versions/migration-draft.ts`
- **Help:** `lib/help/script-editor.ts`
- **Permissions:** `scripts:*`
- **Tests:** `page-script-editor`, `github-*`, `registry-*`, `script-*`

### Deploy

- **Page:** `(studio)/deploy/page.tsx`, with its parts beside it: `QuickRun.tsx`, `RunPanel.tsx`, `RunStage.tsx`, `RunTimeline.tsx`, `PreflightCards.tsx`, `PendingCard.tsx`, `MigRow.tsx`, `RollbackCard.tsx`, `VerifyStage.tsx`, `ShipChecklist.tsx`, `DriftPanel.tsx`, `helpers.ts`, `row-notes.ts`, `types.ts`
- **Components:** `ApprovalPanel`, `RiskGate`, `VersionTimeline`, `TargetPicker`, `MigrationReviewPanel` and `AiPanel` (AI)
- **Routes:** `scripts/preflight`, `scripts/apply`, `scripts/cancel`, `scripts/revert`, `scripts/attempts`, `deploy/approvals`, `deploy/approvals/[id]`, `github/pull`, `lineage/drift`, `scripts/review` (AI)
- **Logic:** `lib/deploy/`, `lib/versions/script-status.ts`, `lib/connections/access.ts`
- **Help:** `lib/help/deploy.ts`
- **Permissions:** `deploy:*`, `approvals:*`
- **Tests:** `page-deploy`, `apply-*`, `approvals-*`, `deploy-*`, `preflight-*`, `quick-*`, `revert-*`, `rollback-*`, `run-*`

### Version sync

- **Page:** `(studio)/versionsync/page.tsx`, with `VersionLine.tsx` beside it
- **Components:** `ApprovalPanel`, `RiskGate`, `VersionTimeline`, `TargetPicker`
- **Routes:** `scripts/schemas`, `scripts/apply`, `versionsync/ledger`, `github/family`, `deploy/approvals`
- **Logic:** `lib/versions/sync.ts`, `family-lock.ts`, `family-reads.ts`
- **Help:** `lib/help/versionsync.ts`
- **Permissions:** `version_sync:*`
- **Tests:** `page-versionsync`, `version*`, `family-*`

### Drift, and one tracked schema

- **Pages:** `(studio)/drift/page.tsx`; `(studio)/schemas/[id]/page.tsx`
- **Components:** `AuditLogTable`, `DriftResolutionBar`, `ScheduleTable`, `DiffReport`, `DriftExplainPanel` (AI)
- **Routes:** `lineage`, `lineage/[id]`, `lineage/lookup`, `lineage/audit`, `lineage/drift`, `lineage/acknowledge`, `lineage/rebaseline`, `lineage/schedule`, `internal/drift-tick`, `lineage/drift/explain` (AI)
- **Logic:** `lib/drift/`, `lib/versions/lineage-db.ts`; the scheduler starts in `instrumentation.ts`
- **Help:** `lib/help/drift.ts`, `lib/help/schema-details.ts`
- **Permissions:** `drift:*` (the schema page also opens with `dashboard:read`)
- **Tests:** `page-drift`, `page-schema-detail`, `drift-*`, `lineage-*`, `rebaseline-*`

### History

- **Page:** `(studio)/history/page.tsx` (no layout of its own; see section 4)
- **Routes:** `lineage/audit`
- **Logic:** `lib/ui/history-activity.ts`
- **Help:** `lib/help/history.ts`
- **Permissions:** `drift:read`
- **Tests:** `page-history`

### Performance

- **Page:** `(studio)/performance/page.tsx`
- **Components:** `PerfAdviceList`, `PerfTargetPicker`, `QueryAnalyzer`, `PlanTree`, `ScoreBadge`, `QueryHistoryPanel`, `LiveActivity`, `SchemaTrends`, `AlertThresholds`, `ThresholdBanner`
- **Routes:** `performance/advice`, `performance/analyze`, `performance/history`, `performance/activity`, `performance/metrics`, `performance/thresholds`
- **Logic:** `lib/performance/` (`advice/` and `query-analysis/` are folders of their own)
- **Help:** `lib/help/performance.ts`
- **Permissions:** `performance:*`, `alert_thresholds:*`
- **Tests:** `page-performance`, `perf-*`, `query-*`, `metrics-*`, `composite-*`

### Visualizer

- **Page:** `(studio)/visualizer/page.tsx`
- **Components:** `components/studio/visualizer/`
- **Routes:** `connections`, `schema/snapshot`
- **Help:** `lib/help/visualizer.ts`
- **Permissions:** `visualizer:*`
- **Tests:** `page-visualizer`, `visualizer-*`

### Requests

- **Page:** `(studio)/requests/page.tsx`
- **Routes:** `requests`, `requests/[id]`, `requests/seen`, `admin/roles`, `admin/users`
- **Logic:** `lib/roles/access-requests-db.ts`, `access-requests.ts`, `request-wording.ts`; hook `useRequestCounts`
- **Help:** `lib/help/requests.ts`
- **Permissions:** any member may ask; answering needs `users:update` or `roles:update` (`canAnswerRequests()` in `lib/roles/access-requests.ts`)
- **Tests:** `page-requests`, `requests-*`

### Admin

- **Page:** `(studio)/admin/page.tsx`
- **Components:** `components/admin/`: `UsersTab`, `RolesTab` (with `PermissionList`, `PermissionsGuide`, `RoleCompare`, `RoleChangeLog`), `OrganizationTab`, `GitHubTab`, `AiTab` (with `AiKeyCard`), `InvitePanel`
- **Routes:** `admin/users`, `admin/roles`, `admin/invites`, `admin/organization`, `admin/github`, `admin/ai`, `admin/ai/key`
- **Logic:** `lib/roles/`, `lib/orgs/`, `lib/github/settings.ts` and `org-store.ts`, `lib/ai/settings.ts` and `org-key.ts`
- **Help:** `lib/help/admin.ts`
- **Permissions:** `users:*`, `roles:*`, `organization:*`, `github:*`, `ai:*`
- **Tests:** `page-admin`, `admin-*`, `role*`, `permissions*`, `invites-*`, `organization*`

### AI features

All six are off until the server or the organization has an AI service set up
and an Admin switches AI on (the Admin page, AI tab).

- **Logic:** `lib/ai/`. `config.ts` reads the `AI_*` settings, `provider.ts` picks the client (`openai-compatible.ts` or `anthropic.ts`), `prompts/` holds the rules every prompt starts with, `features/` holds one file per feature, `checks.ts` checks an answer before it is shown, `store.ts` counts calls and caches answers
- **Routes:** `ai/chat`, `ai/status`, `ai/rate`, and the feature routes named above (`compare/summary`, `scripts/review`, `scripts/generate`, `lineage/drift/explain`)
- **Components:** `AiPanel`, `SchemaChat`, `ai-names.tsx`, and the feature panels named above
- **Permissions:** `ai:read` to use them; `ai:update` to switch them on
- **Tests:** `ai-*`

### Sign-in, organizations and invitations

- **Pages:** `app/page.tsx`, `app/login/`, `app/onboarding/`, `app/invite/[token]/`, `app/[org]/layout.tsx`, `app/studio/[[...rest]]/`
- **Components:** `components/landing/`, `onboarding/`, `invite/`, `OrgProvider`, `OrgSwitcher`, `AccountMenu`
- **Routes:** `auth/[...nextauth]`, `organizations`, `invites/accept`, `me`, `me/view-as`
- **Logic:** `auth.ts`, `auth.config.ts`, `proxy.ts`, `lib/auth/`, `lib/orgs/`; hooks `useUser`, `useOrg`
- **Tests:** `page-login`, `page-onboarding*`, `page-invite*`, `page-root`, `auth-*`, `sign-*`, `callback-*`, `org-*`, `proxy.test.ts`, `accounts-*`

### Help, the tour and the shell

- **Help text:** `lib/help/<page>.ts`, listed in `lib/help/index.ts`. The rule at the top of that file says what goes in Help and what stays on the page
- **Help panel:** `components/help/HelpPanel.tsx`, `Spotlight.tsx`; the page title comes from `components/studio/PageHeader.tsx`
- **Tour:** `lib/ui/tour.ts`, `components/studio/AppTour.tsx`
- **Menu:** `components/studio/nav.tsx` (groups, order, icons), `StudioSidebar.tsx`, `StudioTopbar.tsx`, `CommandBar.tsx`
- **Tests:** `help-*`, `tour.test.ts`, `component-*`

### Styling

- `app/globals.css`: Tailwind's import, the colour and size tokens for the
  light and dark themes, and classes shared across pages
- `app/styles/atelier-system.css`: the design system's own classes
- `app/styles/atelier-<page>.css`: one per page
- The theme is the `data-theme` attribute on `<html>` (`hooks/useTheme.ts`)

## 4. Conventions, and the exceptions

The code follows one pattern throughout. Learn the pattern once; after that,
only the exceptions listed below need finding.

### The pattern

1. **A studio page** is `app/[org]/(studio)/<name>/page.tsx`, a client
   component (`"use client"`). Beside it is a `layout.tsx` holding
   `<AuthGuard feature="...">`. The page starts with `<PageHeader>`, gets its
   help from `lib/help/<name>.ts`, its look from `app/styles/atelier-<name>.css`,
   and its menu entry from `components/studio/nav.tsx`. Its test is
   `tests/page-<name>.test.tsx`.
2. **A component used by one page only sits beside that page** (the Deploy
   parts, `SqlEditor.tsx`, `VersionLine.tsx`, `status-line.ts`). One used by
   two pages or more goes in `components/studio/`.
3. **Every call from the browser goes through `apiFetch`**, never `fetch`, so
   the organization header is always sent. `tests/api-fetch.test.ts` fails on
   a bare `fetch("/api/...")`.
4. **Every route opens with a gate** from `lib/auth/guard.ts`, usually
   `requirePermission("<feature>:<action>")`, and uses
   `gate.principal.orgId` in every query, so nothing from another
   organization is ever read or written.
5. **Permission keys are `feature:action`**, from the list in
   `lib/roles/permissions.ts`. The actions are `create`, `read`, `update`,
   `delete`, `run` and `approve`.
6. **SQL on the app's own tables lives in `*-db.ts` files**, written by hand
   with `$1` placeholders and sent through `metadataPool`
   (`lib/db/sequelize.ts`). [`RAW-SQL.md`](RAW-SQL.md) says why.
7. **Logic that can be pure, is.** Rules (permissions, schedules, scoring,
   change levels, diffing) sit in files with no database or network in them,
   and are unit tested directly.
8. **Tests sit in `tests/`, named `<area>-<what>.test.ts`.** Page tests are
   `page-*`, component tests `component-*`. A test that needs a browser says
   so on its first line (`/** @jest-environment jsdom */`); the rest run in
   Node. A test against a real PostgreSQL is named `*-db.test.ts` and skips
   without `TEST_DATABASE_URL`.
9. **Each file opens with a comment saying what it is for and why.** Comments
   explain decisions; the code says what it does.
10. **Words on screen are plain English.** Errors go through
    `lib/ui/friendly-error.ts`; a refusal uses `refusalMessage()` from
    `lib/roles/permissions.ts`.

### The exceptions

| Exception | Why |
|---|---|
| `(studio)/history/` has no `layout.tsx`; the page checks `can("drift:read")` itself | It shows a different message per case (no access, nothing yet) inside the page's own frame |
| `(studio)/admin/layout.tsx` names four features, and `schemas/[id]` names two | Read on any one of them is enough to open the page |
| Routes that do not use `requirePermission` | `me`, `me/view-as` and the three `requests` routes use `requireMember()` (they are about the person, not a feature); `organizations` and `invites/accept` use `requireSignedIn()` (the person may be in no organization yet); `auth/[...nextauth]` is NextAuth itself; `internal/drift-tick` checks `CRON_SECRET`. `tests/permissions-coverage.test.ts` names each one |
| Pages outside `[org]` | `/`, `/login`, `/onboarding`, `/invite/[token]` and `/studio` come before anyone has chosen an organization |
| `lib/postgres/` and `lib/sql/generate/` are imported through `index.ts` | They are large and split into parts; the rest of the app sees one front door |
| Some files are far longer than the rest | Listed in section 11 |
| Sequelize models are never queried | They create the tables; queries are SQL ([`RAW-SQL.md`](RAW-SQL.md)) |

## 5. Roles and permissions, walked through

This is the order to read the code in.

### Step 1: the catalogue, `lib/roles/permissions.ts`

Everything a role can be allowed to do is listed once, in `FEATURES`. Each
feature has a `key` (such as `compare`), the `screen` it belongs to, and its
`actions`, each with a sentence of what it `does`. A permission is
`<feature key>:<action>`, so `compare:read` or `deploy:run`.

The same file holds the rules, all pure:

| Function | Rule |
|---|---|
| `BUILT_IN_ROLES`, `presetFor()` | Viewer, Editor and Admin, and what Viewer and Editor start with. `DEFAULT_ROLE` is Viewer |
| `effectivePermissions()` | Admin has everything. Turning any action on also turns on that feature's Read. Features marked `adminOnly` (Roles, Organization) can never be given to another role |
| `hasPermission()` | A check passes if the role has any one of the keys asked for |
| `canHandOut()` | You can only give someone a permission you hold yourself |
| `refusalMessage()` | The sentence shown when the answer is no |

### Step 2: the database

| Table | Holds |
|---|---|
| `memberships` | Which role each person has in each organization |
| `roles` | The roles of each organization: the three built in, and any an admin makes |
| `role_permissions` | One row per permission turned on for a role. Admin has none stored, because it has everything |
| `role_changes` | The log shown on the Roles tab |

`lib/roles/roles-db.ts` reads and writes them (`getRoleAccess`, `listRoles`,
`createRole`, `setRolePermissions`, `resetRolePermissions`, `deleteRole`,
`listRoleChanges`). `setUpRoles()` in `lib/db/bootstrap.ts` creates the
built-in roles for every organization, and when a preset gains a permission it
applies it to existing organizations once (`preset_applied` records that).

### Step 3: the server's check, `lib/auth/guard.ts`

`requirePermission(...keys)` is the gate. In order it:

1. reads the session (no session: 401);
2. reads the organization from the `x-schema-studio-org` header;
3. checks the person is a member (not a member: 404, so the organization's
   existence is not given away);
4. loads the role's permissions with `getRoleAccess()`;
5. checks `hasPermission()` against the keys (no: 403, with
   `refusalMessage()`);
6. returns a `principal`: `profileId`, `email`, `name`, `role`,
   `permissions`, `orgId`, `orgSlug`, `orgName` and a few more. A database
   that cannot be reached gives 503.

With the sign-in bypass on (testing only), everyone is Admin, or the role
picked in View as.

### Step 4: the browser's check

`useUser()` (`hooks/useUser.ts`) gives each screen `can("<key>")`, used to hide
or disable buttons. `AuthGuard` uses the same answer for the whole page. Both
only make the screen honest about what the server will allow; neither is
security.

### Two checks on top of roles

- **A second person approves.** A run that needs approval cannot be approved
  by the person who asked (`lib/deploy/approvals-db.ts`). An approval covers
  one exact run and expires after a week (`APPROVAL_VALID_HOURS`).
- **Each connection says who may run scripts on it**: anyone whose role has
  `deploy:run`, Admins only, or nobody (`lib/connections/access.ts`).

### Who becomes Admin

Admin is a role inside one organization. The app has no role above it, and an
Admin of one organization has no access to another.

- Whoever makes an organization becomes its Admin (`lib/orgs/orgs-db.ts`).
- On a fresh install, the first person from the home Microsoft tenant to sign
  in while the default organization has no members becomes its Admin
  (`joinOnSignIn()` in `lib/auth/accounts-db.ts`). Everyone after that joins
  by invitation or makes their own organization.

### The tests that keep it honest

- `tests/permissions-coverage.test.ts` fails when a route has no gate, or when
  a permission can be turned on but no route checks it. Two are known and
  listed there: `approvals:create` (asking for approval is let in on
  `deploy:read`) and `performance:update` (no screen cancels a query yet).
- `tests/permissions-equivalence.test.ts` checks that each built-in role still
  gets into what it always could, and the role below it still does not.

## 6. The entry point and the `[[...rest]]` folder

### Where a visitor starts

1. `/` is `app/page.tsx`, the landing page. Someone already signed in is sent
   on to `/studio`. "Create account" goes to `/login?callbackUrl=/onboarding`,
   "Log in" to `/studio`.
2. `/studio` is `app/studio/[[...rest]]/page.tsx`. It calls
   `redirectToLastOrg("studio", props)` (`lib/orgs/redirect.ts`), which sends
   the person to `/<slug>/studio`: the organization they used last, or
   `/onboarding` if they are in none, or `/login` if they are not signed in.
3. `/acme/studio` is the Dashboard, drawn through the layouts in section 1.

### Folder names in `app/`

| Name | Meaning in Next.js | Here |
|---|---|---|
| `login` | A plain folder is one part of the address | `/login` |
| `[org]` | Square brackets: a dynamic part, read as a parameter | `/acme`, the organization's slug |
| `(studio)` | Round brackets: a route group, adds nothing to the address | Gives every studio page one shared layout |
| `[id]`, `[token]` | Dynamic parts | `/acme/schemas/12`, `/invite/abc...` |
| `[...nextauth]` | A catch-all: one or more parts | `/api/auth/signin`, `/api/auth/callback/...` |
| `[[...rest]]` | An optional catch-all: zero or more parts | `/studio` and `/studio/anything/below` |

### Why `/studio` uses `[[...rest]]`

Before organizations existed, every page lived at the top: `/compare`,
`/deploy`, `/history` and so on, each in its own `app/<page>/[[...rest]]/`
folder that forwarded old links into the right organization. Those twelve
folders were removed in commit `41f7a7b`; their addresses now get the normal
404. `/studio` is the one kept, because it is the app's front door: the
landing page, the sign-in page and the app tour all send people there without
knowing which organization they belong to.

A fixed folder name such as `studio` wins over `[org]`, so no organization can
be called `studio`. `RESERVED_SLUGS` in `lib/orgs/slug.ts` lists every name an
organization cannot take. `tests/org-redirect.test.ts` covers the forwarding,
and fails if another `[[...rest]]` folder appears.

## 7. Data model

### The app's own database (`DATABASE_URL_A`)

`lib/db/models.ts` defines every table; `lib/db/bootstrap.ts` creates them on
first use and adds what a model cannot say (checks, expression indexes, seed
rows). The same tables as plain SQL, for a database administrator, are in
`deploy/handover/sql/02-schema-studio-tables.sql`. There are 28:

| Group | Tables |
|---|---|
| Organizations and people | `organizations`, `profiles`, `memberships`, `identities`, `invites`, `access_requests` |
| Roles | `roles`, `role_permissions`, `role_changes` |
| Saved connections | `connections` (passwords encrypted with `APP_ENCRYPTION_KEY`) |
| Tracking and drift | `tracked_schemas`, `snapshots`, `lineage_migrations`, `drift_events`, `drift_scheduler_state`, `schema_metrics` |
| Compare | `comparison_sets`, `comparison_set_targets`, `comparison_runs` |
| Deploy | `deploy_approvals`, `deploy_attempts` |
| Performance | `query_history`, `perf_thresholds` |
| Organization settings | `organization_github` (token encrypted), `organization_ai` |
| AI | `ai_calls` (counts only, never the prompt), `ai_results` (cached answers, a week) |
| Housekeeping | `metadata_boot_stamps` |

Every organization's rows carry its `organization_id`, and every query filters
on it.

### In each database the app deploys to

| Table | Holds |
|---|---|
| `script_patch` | The ledger: which script version ran here, and when. Deploy writes it in the same transaction as the script |

## 8. How compare, deploy and drift work

### Compare

1. **Read.** `fetchSchemaSnapshot()` (`lib/postgres/snapshot.ts`) opens one
   connection, starts a `REPEATABLE READ READ ONLY` transaction so every
   query sees the same moment, and runs the readers in `lib/postgres/catalog/`
   (tables, constraints, indexes and triggers, row security, views, sequences,
   user types, collations, routines, extensions, privileges). The result is a
   `SchemaSnapshot`.
2. **Match.** `compareSchemas()` (`lib/compare/diff.ts`) matches tables by
   name, then scores the leftovers against each other on column names, types
   and name similarity, and keeps only pairs that pick each other above a
   threshold. A weak match becomes a create and a drop, not a rename. The same
   is done for columns inside each table.
3. **Write.** `generateMigration()` (`lib/sql/generate/migration.ts`) writes
   the script in an order where each statement finds what it needs (extensions
   and types first, tables, then keys, views, grants, and the drops last).
   `generateRollback()` (`rollback.ts`) writes the script that undoes it.
4. `runComparison()` (`lib/compare/run.ts`) ties these together for the route,
   and records the run in `comparison_runs` so the next one can say what
   changed since.

### Deploy

1. **Pre-flight** (`scripts/preflight`) checks the target can be reached and
   which versions it already has.
2. **Apply** (`scripts/apply`) checks permission, the connection's run setting
   and any approval, then runs each script in one transaction with a lock wait
   cap, a time cap and the target schema first on the search path
   (`lib/deploy/run-settings.ts`, `script-transaction.ts`), and writes the
   `script_patch` row in the same transaction. Every attempt is recorded in
   `deploy_attempts`, whether it landed or not.
3. **Revert** (`scripts/revert`) runs a version's rollback the same way.
4. **Version sync** reads the ledgers of two schemas and replays on the target
   what the source has and the target is missing.

### Drift

`instrumentation.ts` starts `lib/drift/scheduler.ts` when the server starts. It
wakes every minute, asks `lib/drift/schedule.ts` which tracked schemas are due,
and runs the same check as the Recheck button (`lib/drift/runner.ts`): read
the live schema, compare it with the saved snapshot, record a `drift_events`
row if they differ, and take a size reading into `schema_metrics`.
`DRIFT_SCHEDULER=off` stops it.

## 9. Running, testing and CI

### Running from source

Needs Node 22 and a PostgreSQL for the app's own tables.

```bash
docker compose up -d db
```

That starts PostgreSQL 17 on `localhost:5433` from the repository root.

```bash
cd my-app && npm ci && cp .env.local.example .env.local
```

In `.env.local`, set `DATABASE_URL_A=postgres://studio:studio@localhost:5433/studio`.
The example file has the sign-in bypass on, so no Microsoft keys are needed
while developing. Then:

```bash
npm run dev
```

Open `http://localhost:3000`. The tables are made on the first request.

`node scripts/seed-test-schemas.cjs` adds four small sample schemas to compare.

To build and run the whole thing in Docker instead, from the repository root:

```bash
NEXT_PUBLIC_AUTH_BYPASS=true docker compose up --build
```

The bypass is read when the app is **built**, not when it runs, because
Next.js writes every `NEXT_PUBLIC_` value into the browser code. An image
built without it always asks for sign-in. The image label
`org.schema-studio.sign-in-bypass` says which kind an image is.

### Commands

| Command | Does |
|---|---|
| `npm run dev` | The app with live reload |
| `npm run build` | The production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no output |
| `npm test` | Jest, every test |
| `npm run test:watch` | Jest, re-running on change |
| `npm run ai:bench` | Grades the AI features against a running copy |

### Tests against a real PostgreSQL

The `*-db.test.ts` suites skip unless `TEST_DATABASE_URL` is set. They create
and drop databases of their own, so they refuse a database whose name does not
contain `test`.

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/schema_studio_test REQUIRE_TEST_DATABASE=1 npm test
```

`REQUIRE_TEST_DATABASE=1` turns a skip into a failure, so a run that lost its
database cannot pass by accident. A new table that belongs to an organization
also needs a sample row in `tests/org-migration.test.ts`.

### CI (`.github/workflows/ci.yml`)

| Job | Does |
|---|---|
| Lint, type-check, test, build | Everything above, with a PostgreSQL 16 for the database suites |
| Schema reading on PostgreSQL 13 to 18 | The schema reader and the SQL generator against six PostgreSQL versions |
| Developer Docker stack | Builds and starts the root `docker-compose.yml` |
| Handover kit on Ubuntu with PostgreSQL 16 | Builds the image, follows `SETUP-GUIDE.md` on a fresh PostgreSQL 16, checks `sql/02` is up to date, and offers the image file as a download |

### Settings

Every setting is explained in `my-app/.env.local.example`, and those needed to
run the image are in the Settings reference of
[`SETUP-GUIDE.md`](../deploy/handover/SETUP-GUIDE.md). Two not covered there:
`LOCAL_DATABASE_URL` and `LOCAL_MACHINE_NAME` let one copy of the app keep some
connection passwords on its own machine while sharing everything else with
another copy (`lib/connections/local-store.ts`). Without them nothing changes.

## 10. Recipes

### Add a studio page

1. `app/[org]/(studio)/<name>/page.tsx` and a `layout.tsx` with
   `<AuthGuard feature="...">`.
2. Add `<name>` to `RESERVED_SLUGS` in `lib/orgs/slug.ts`.
3. A menu entry in `components/studio/nav.tsx`.
4. Help text in `lib/help/<name>.ts`, listed in `lib/help/index.ts`.
5. A stylesheet `app/styles/atelier-<name>.css`, imported by the page.
6. `tests/page-<name>.test.tsx`.

### Add an API route

1. `app/api/<area>/route.ts`, exporting `GET`, `POST` and so on.
2. Open with `const gate = await requirePermission("<feature>:<action>")`,
   return `gate.response` when it is not `ok`, and pass
   `gate.principal.orgId` to everything that reads or writes.
3. Put the logic in `lib/<feature>/`, the SQL in a `*-db.ts` file.
4. Call it from the page with `apiFetch`.
5. Test the route in `tests/<area>-*.test.ts`.
   `tests/permissions-coverage.test.ts` fails until the route has a gate.

### Add a permission

1. Add the action to its feature in `FEATURES` (`lib/roles/permissions.ts`),
   with its `does` sentence.
2. If Viewer or Editor should have it, add it to their preset. Existing
   organizations get it on the next start.
3. Check it in the route with `requirePermission`, and in the screen with
   `can()`.
4. Run the tests: the coverage test fails until some route checks it.

### Add a table to the app's own database

1. A model in `lib/db/models.ts`, with `organization_id` if it belongs to an
   organization.
2. Anything a model cannot say (a check, an expression index) in
   `lib/db/bootstrap.ts`.
3. The queries in a new `lib/<feature>/<name>-db.ts`.
4. A sample row in `tests/org-migration.test.ts`, and a `*-db.test.ts` suite.
5. Rebuild the image and remake the handover SQL; CI fails until you do:

```bash
docker build -t schema-studio-app:handover my-app
```

```bash
bash deploy/handover/make-sql.sh schema-studio-app:handover
```

### Read a new kind of object from a schema

1. A new file in `lib/postgres/catalog/` with the same three parts as the
   others: a row type, a `read...()` query, a build step.
2. Call it from `fetchSchemaSnapshot()` in `lib/postgres/snapshot.ts`, and add
   the type to `lib/postgres/types.ts` or `object-types.ts`.
3. Compare it in `lib/compare/diff.ts` and write its SQL in
   `lib/sql/generate/`.
4. Add one to `tests/schema-reading-db.test.ts`, which CI runs on PostgreSQL
   13 to 18. A column only newer servers have is read with `to_jsonb(row) ->>`
   (see [`RAW-SQL.md`](RAW-SQL.md)).
5. If the stored snapshot shape changes, raise the version in
   `lib/postgres/snapshot-format.ts`.

## 11. Large files still to split

Four of the largest files were split into parts for the handover (the SQL
generator, query analysis and performance advice, the schema reader, and the
Deploy page). These are still long. They work and are tested; splitting them is
tidying, not a fix.

| File | Lines | What it holds |
|---|---|---|
| `lib/compare/diff.ts` | about 3,000 | The comparison engine: scoring, matching, every object kind |
| `(studio)/deploy/page.tsx` | about 2,950 | The Deploy page's state and stages (its parts are already beside it) |
| `(studio)/connections/page.tsx` | about 2,250 | The Connections page and its form |
| `app/api/scripts/apply/route.ts` | about 2,000 | Applying scripts, with every check before it |
| `lib/db/models.ts` | about 1,900 | All 28 table definitions |
| `(studio)/script-editor/page.tsx` | about 1,850 | The Script Editor |
| `(studio)/versionsync/page.tsx` | about 1,800 | Version sync |
| `components/studio/DiffReport.tsx` | about 1,750 | The difference cards |
| `(studio)/studio/page.tsx` | about 1,600 | The Dashboard |
| `lib/compare/run.ts` | about 1,500 | Running one comparison for the route |

A good split follows the one used for the Deploy page: parts used only by that
page go in files beside it, and the page keeps the state.

## 12. Ideas for later

- **A yes or no check for CI.** A small command or route that compares two
  connections and exits with an error when they differ, so a team's own CI can
  stop a release whose database has drifted. `runComparison()` already has
  everything needed.
- **Numbered migrations for the app's own tables**, if they start changing
  often ([`RAW-SQL.md`](RAW-SQL.md), "When to reconsider").
- **Other database engines.** `lib/connections/dialects.ts` lists what the app
  knows about each; only PostgreSQL is built. A second engine needs its own
  catalog readers and SQL writer.
- **AI on the Performance page.** Query analysis and advice are rules written
  out in `lib/performance/` today.
