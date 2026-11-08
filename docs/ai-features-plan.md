# AI features for Schema Studio: plan

Status: plan only, nothing built. Written 2026-11-07 against main at cbd0429. File paths are inside `my-app/` unless they start with `desktop/` or `relay/`.

## 1. Why

The client spec says "Use of AI for this feature is highly desirable" five times (Difference Reporting, SQL Script Generation, Query Execution Analysis, Performance Suggestion, Performance Monitoring). The app has no AI today. The poster's own recommendation is AI-assisted migration review. The team plan's ethics section says AI stays optional and people approve everything it produces.

You picked five features, built in this order:

1. Change summary on Compare
2. Migration review before deploy
3. Explain drift (plus a one-line summary in the drift alert)
4. SQL script generation from plain words
5. Chat about your schema (last, biggest)

## 2. The one rule

**The engine decides, the AI explains.**

- The AI never grades a change, never decides if something is safe, never runs anything.
- It gets the engine's own facts (the graded diff, deploy-risk findings, table sizes, the snapshot) and writes words or a draft on top.
- Code checks every answer before anyone sees it: every object it names must exist in the facts it was given, a grade it repeats must match the engine's grade, and any SQL it writes goes through sql-guard, deploy-risk, a dry run and the normal approval flow.
- Anything that fails a check is dropped or the call is retried once; it is never shown as if it were true.
- Every AI panel is labelled "AI suggestion, check before use", shows the model name, and can be switched off.

Two grade scales exist in the code and the AI may change neither:

- each change in a comparison: breaking, safe or info (`ChangeSeverity`, `lib/compare-types.ts`, set in `lib/compare.ts`)
- a script: breaking, additive or patch (`gradeSql` in `lib/change-type.ts`)

## 3. Which model

### 3.1 For testing now: free tiers

| Provider | Free limits (as reported; the console shows your real ones) | Fits our features? | Catch |
|---|---|---|---|
| **Google AI Studio, Gemini Flash and Flash-Lite** | Counted per model. Measured on 2026-11-07: Flash (`gemini-3.5-flash`) allows only **20 requests a day** and about 10 a minute; Flash-Lite allows more and was still answering after Flash ran out. 1M token context | All five: JSON schema output, tool calls, big context | Free-tier prompts are used to improve Google's products, so demo and test schemas only. Its OpenAI-style layer can quietly ignore a schema, so we validate every answer ourselves |
| **Groq** (gpt-oss-120b, Qwen) | 30 a minute, about 1,000 a day, but only about 8,000 tokens a minute | Features 1 and 3 (short prompts). Too tight for 2, 4, 5 at full size | One big prompt a minute |
| OpenRouter `:free` models | 20 a minute, 50 a day (1,000 a day after a one-time $10 top-up) | Light testing | Free models come and go |
| GitHub Models | 150 a day (small models), 50 a day (big), 8,000 input tokens per request | No: 8K input is too small for schema context | |
| Cloudflare Workers AI | 10,000 Neurons a day, shared across models | Small models only | Weaker at SQL |
| Mistral Experiment plan | About 1 request a second | Possible | Phone check; training terms unclear |
| Anthropic (Claude) | No free tier, a small sign-up credit | Paid later | |
| Ollama, local (qwen3:8b) | Unlimited and private | All five, lower quality | Slow on CPU; this Mac's disk is nearly full |

**Recommendation for testing:** Gemini on the free tier as the default. Use **Flash-Lite** for the short jobs (change summary, drift one-liner) and **Flash** for the hard ones (migration review, drift explanation, SQL generation, chat). Groq is the second provider for short jobs and a fallback when Gemini says "rate limited".

Both speak the same OpenAI-style API, and so do OpenRouter and Ollama, so one adapter covers all of them and switching is a change in `.env.local`, not code.

**Will free work fine?** Yes, for building, testing and the demo, with three limits:

- **Rate limits.** A chat question takes 2 to 4 calls, so fast clicking can hit "rate limited". Flash's 20 requests a day run out quickly, so when one model's allowance is used up the app asks the other model (Gemini counts each model apart). When the service names a short wait (30 s or less), the chat waits it out once. Otherwise the message says how long: "in a minute", "in about 5 minutes" or "for today, try again in about 6 hours". Results are cached so the same question isn't paid twice.
- **Privacy.** Free tiers may train on what we send. We only send schema structure (never rows, never passwords or hostnames) and we only test on the bookshop demo and our own schemas, never the client's.
- **Model names change.** Model ids live in env settings, not code.

### 3.2 For the client later: paid

Claude through the official Anthropic SDK (`@anthropic-ai/sdk`), as a second adapter:

| Job | Model | Price per 1M tokens (in / out) |
|---|---|---|
| Change summary, drift one-liner | Claude Haiku 5.5 (`claude-haiku-5-5`) | $0.10 / $0.50 (prompts up to 100K tokens) |
| Migration review, drift explanation, SQL generation, chat | Claude Sonnet 5.5 (`claude-sonnet-5-5`) | $2 / $10 |
| Optional deeper review an admin can pick | Claude Opus 5.5 (`claude-opus-5-5`) | $4 / $20 |

A private option for the Swinburne server: Ollama on the server itself, if it has the memory. Nothing leaves the building, at lower quality.

## 4. Token sizes and metrics

### 4.1 What a schema costs

Measured on a real fixture, `tests/fixtures/pre-org-schema.sql` (the app's own metadata database): **17 tables, 177 columns, 20 indexes, 21.8 KB of DDL, about 5,500 tokens** (at about 4 characters a token).

- The same schema as the app's snapshot JSON is about twice that, because every key repeats. So the AI gets a compact text form (close to DDL), never the raw JSON.
- Bookshop demo, one environment (4 tables, an enum, an index or two): **under 1,000 tokens**.
- A large client schema (say 300 tables, 3,000 columns): **about 90,000 tokens**. We don't send it whole. We send a **context slice**: the tables the task touches, their foreign key neighbours, and the views and triggers that depend on them, capped per feature.
- Step 0 replaces these estimates with real counts: `scripts/seed-test-schemas.cjs` seeds the `cmp_prod`, `cmp_dev`, `vs_source` and `vs_target` schemas, and the provider reports exact token use per call.

### 4.2 Per feature budget

| Feature | Input tokens (typical, hard cap) | Output tokens | Calls per action | When it runs | Wait (Flash) | Paid cost per action |
|---|---|---|---|---|---|---|
| 1 Change summary | 3K to 6K, cap 16K | 400 to 800 | 1, cached per comparison | Button on the Compare report | 2 to 5 s | Haiku, about $0.001 |
| 2 Migration review | 5K to 10K, cap 24K | 600 to 1,200 | 1 per script version, cached | Before deploy, on the deploy and approval screens | 4 to 10 s | Sonnet, about $0.03 |
| 3a Drift one-liner | 1.5K to 3K, cap 6K | about 40 | 1, only when the drift is new | Inside the scheduled drift check | 1 to 3 s | Haiku, under $0.001 |
| 3b Drift explanation | 3K to 8K, cap 16K | 800 to 2,000 | 1, on click, cached | Drift page | 5 to 12 s | Sonnet, about $0.03 |
| 4 SQL generation | 4K to 12K, cap 20K | 300 to 1,500 | 1, plus up to 2 repair tries | On request in the script editor | 3 to 10 s | Sonnet, about $0.04 (worst about $0.10) |
| 5 Chat | 15K to 40K summed over one question | 500 to 1,500 | 3 to 6 (tool loop, stops at 8) | Per question | 8 to 25 s | Sonnet, about $0.10 (about $0.03 with prompt caching) |

**Free-tier fit for one active tester in a day:** about 20 summaries, 10 reviews, 20 drift lines, 30 SQL requests and 20 chat questions (about 100 actions) comes to roughly 180 requests. Measured on 2026-11-07, this does **not** fit Flash alone: it allows 20 requests a day. In practice Flash covers the first handful of hard jobs, then everything moves to Flash-Lite, which answered all three live chat questions correctly. A paid key, or Flash-Lite as both models, is needed for a full day of testing or for the benchmark. It does not fit OpenRouter's 50 a day either.

### 4.3 What the app records (usage metrics)

One row per AI call in a new `ai_calls` table. It holds no prompt or answer text by default:

- organization, user, feature, provider, model, prompt version
- input tokens, output tokens, cached tokens (from the provider; estimated if it doesn't say)
- wait in milliseconds, retries
- outcome: `ok`, `invalid_output`, `failed_check`, `rate_limited`, `timeout`, `provider_error`, `switched_off`
- estimated cost (0 on a free tier), and a thumbs up or down if the user gave one

An **AI usage** card on the Admin page shows, per day and per feature: calls, tokens, failures by kind, cache hits, average wait and estimated spend.

**Guards:** a per-organization daily call limit and a per-user per-minute limit (so one person can't burn the free quota), plus the hard input cap per feature above.

### 4.4 Quality metrics (for the benchmark chapter)

| Feature | How it's scored | Target |
|---|---|---|
| 1 Change summary | Reference accuracy: share of named objects that really exist in the diff (code checks it; we also record how often the model got it wrong before the check). Grade agreement. People rate 20 summaries 1 to 5 | 100% after the check, 100% grades |
| 2 Migration review | A labelled set of about 30 scripts with known hazards (long lock on a big table, NOT NULL with no default or backfill, index without CONCURRENTLY, a drop that loses data, type narrowing, a rename that breaks a view). Recall and precision against the labels, and against deploy-risk alone (does the AI add anything?) | Recall 90%+ |
| 3 Explain drift | Apply the **revert** script to a throwaway copy, compare again: must show **zero differences**. The **adopt** draft must make the registry match the live schema. Rate 20 explanations 1 to 5 | Pass rate, reported per model |
| 4 SQL generation | About 40 plain-words tasks on the bookshop and app schemas. Parses, passes sql-guard, passes a dry run in a rolled-back transaction, and the compare engine confirms the intended change | Dry run 90%+, correct 80%+ |
| 5 Chat | About 25 questions with known answers. Correct, tool calls per answer, wait. Permission tests: someone without access to a connection asks about it (must refuse); an instruction hidden in a column comment (must do nothing; there are no write tools at all) | 0 leaks |

The same sets run on each provider (Gemini Flash, Flash-Lite, Groq, local Ollama, Claude if we have credit) and give one comparison table for the report.

## 5. Shared foundation (step 0)

New folder `lib/ai/`:

| File | Does |
|---|---|
| `provider.ts` | The interface: `generate({ system, messages, schema, tools, maxOutputTokens })` returns the parsed answer or tool calls, token usage and time taken |
| `openai-compatible.ts` | One adapter for Gemini, Groq, OpenRouter and Ollama, using `fetch` (no new SDK): JSON schema output and tool calls |
| `anthropic.ts` | Claude via `@anthropic-ai/sdk`, structured output with `messages.parse`, prompt caching on the fixed instructions. Built when we move to paid, not needed for testing |
| `mock.ts` | Canned answers for Jest. CI never calls a real model |
| `config.ts` | Reads `AI_PROVIDER`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL_FAST`, `AI_MODEL_SMART` on the server only. The key never reaches the browser and is never stored in the database |
| `context.ts` | Turns a snapshot or diff into compact text, builds the context slice, estimates tokens and trims to the cap |
| `dependents.ts` | New: "what uses this object". The code has no such helper today. It is built from what snapshots already hold: views' `dependsOn`, foreign keys' `referencedTable`, triggers' `functionName`. Routines have no dependency data, so the AI is told "unknown" for them, never a guess |
| `checks.ts` | Reference check, grade lock, and SQL checks through the existing `lib/sql-guard.ts`, `lib/deploy-risk.ts` and `gradeSql` |
| `run.ts` | One entry point for every feature: permission check, organization switch, limits, cache lookup, call, validate, retry once, write the `ai_calls` row |
| `prompts/*.ts` | One versioned prompt per feature. The version is part of the cache key, so changing a prompt refreshes old answers |

Also in step 0:

- **Validation:** `zod` (new dependency) for every answer shape; the Claude SDK uses the same schemas later.
- **Database:** tables `ai_calls` (log) and `ai_results` (cache by organization, feature, input fingerprint, prompt version and model), added the same way the app adds its other tables at start-up.
- **Organization switch:** organization settings are columns on `organizations` today (like `two_person_rule`), so add one `ai_settings` column: on or off (**off by default**), which features, and the query-text opt-in. It goes through the same path as the two-person rule: `lib/orgs-db.ts` `updateOrganization`, the PATCH in `app/api/admin/organization/route.ts`, a section in `components/admin/OrganizationTab.tsx`, and out to pages through `OrgProvider` and to routes through the signed-in principal.
- **Roles:** a new permission line, "Use AI assistance" (`ai:read`), in `FEATURES` in `lib/permissions.ts`, so it shows on the roles page. Default: from Editor up (Editors and Admins), not Viewers; an Admin can change it there.
- **Data rules:** schema structure only by default. Never row data. Query text only if the organization opts in. Never connection strings, passwords or hostnames.
- **UI:** one shared `components/studio/AiPanel.tsx`: the label, model name and time, Regenerate, thumbs up or down, and a plain reason when AI is off for you.
- **Tests:** the mock provider plus the repo's usual patterns: `jest.mock` with relative paths (the `@/` alias doesn't work there), `global.fetch` swapped as in `tests/github-pull.test.ts`, and `tests/helpers/principals.ts` and `tests/helpers/snapshots.ts` for users and schemas.

## 6. The five features

### 6.1 Change summary on Compare

- **Where:** a new route `app/api/compare/summary/route.ts` (needs `compare:read` and `ai:read`). The panel sits next to `<CriticalChanges>` in `app/[org]/(studio)/compare/page.tsx`, above `DiffReport`. The drift page uses the same report components, so the panel can show there too for free.
- **Input:** the flattened diff the export already builds (`buildDiffDocument` in `lib/compare-export.ts`: one row per change with its breaking, safe or info grade), the counts from `lib/compare-summary.ts`, what depends on each changed object (from `lib/ai/dependents.ts`), and a context slice. The route recomputes the diff on the server rather than trusting what the browser sends.
- **Output:** a headline; a ranked list of what breaks, each item citing the change rows it comes from; "what depends on it"; a suggested order to apply the changes.
- **Checks:** every cited change and object exists in the diff, grades match the engine, the order only names real changes. Items that fail are dropped; too many failures and the call is retried once.
- **Cache:** by the comparison's fingerprint, so reopening a report costs nothing.

### 6.2 Migration review before deploy

- **Where:** a review panel beside the risk gate and `ApprovalPanel` on the deploy page (`app/[org]/(studio)/deploy/page.tsx`), for deploys and rollbacks. A route `app/api/scripts/review/route.ts` (needs `deploy:read` or `approvals:read`, plus `ai:read`).
- **Input:** the script, the diff it implements, `analyseRunRisk` findings from `lib/deploy-risk.ts` (breaking, data loss, might fail), the script grade, and row counts and sizes for **only the tables the script touches**.
- **New piece:** per-table sizes don't exist at deploy time today (`lib/schema-metrics.ts` only sums a whole schema during drift checks). Step 2 adds one read-only query on the target (`reltuples` and `pg_total_relation_size` for the named tables) with the usual short lock timeout.
- **Output:** findings, each with severity, the statement it points at, why, and a safer way (for example "build the index with CONCURRENTLY", "add the column nullable, backfill, then set NOT NULL").
- **Checks:** each finding must point at a real statement in the script and a real object; severity can raise but never lower a deploy-risk finding. It never blocks or approves anything: the reviewer still decides.
- **Cache:** by the script's fingerprint (the same one approvals already use).
- **Phone card (optional, 2b):** add an optional review field to `ApprovalRead` in `relay/src/shared/remote/rpc.ts`, fill it from the desktop's `GET /api/deploy/approvals/[id]/phone`, show it in `relay/src/phone/screens.ts`. This changes the phone protocol, so the relay needs a redeploy, which is yours.

### 6.3 Explain drift

- **3a One-liner:** in `lib/drift-scheduler.ts`, between the drift check and `alertDriftChange`, while the full comparison is still in memory (the stored `drift_events.detail` only keeps counts). Only for **new** drift, with a hard 4 second wait: if the AI is slower, off, or fails, the alert goes out exactly as today. The sentence is stored as `detail.aiSummary` and appended to the web push text (`driftAlertText` in `lib/push-alerts.ts`) and to the desktop alert (`singleBody` in `desktop/src/core/drift-alerts.ts`). Example: "Someone added a nullable column notes to orders and dropped index orders_customer_id_idx."
- **3b Explain and scripts:** an "Explain with AI" panel on the drift page (`app/[org]/(studio)/drift/page.tsx`), fed by the live comparison the page already gets (`computeDriftDetail` in `lib/lineage-db.ts`).
  - **Explanation (AI):** what changed, what it affects, likely why.
  - **Revert script (engine first):** the engine already writes migrations from a comparison (`generateMigration`, used by Compare), so it writes the revert. The AI only adds comments and drafts the items the engine marks as needing manual work. That keeps the benchmark's "zero differences after revert" test meaningful.
  - **Adopt draft:** the live schema saved as the next registry version, through the existing save path (`POST /api/github/push`, needs `scripts:create`).
- **Checks:** both drafts go through sql-guard and deploy-risk, are marked as drafts, and open in the script editor through the existing handoff (`lib/migration-draft.ts`). Nothing runs from the drift page.

### 6.4 SQL script generation

- **Where:** the script editor (`app/[org]/(studio)/script-editor/page.tsx`). A box above the editor: "Describe what the script should do". The draft lands in the editor for you to read and edit, shown the way `MigrationDraftBanner` shows drafts today. Nothing runs by itself.
- **Route:** `app/api/scripts/generate/route.ts` (needs `scripts:read` and `ai:read`). The editor holds no snapshot today, so the route loads the open connection's schema on the server, the same way `GET /api/schema/snapshot` does, checked against the user's organization.
- **Input:** your sentence, the connection and schema you have open, a context slice of the tables your sentence names (found by name matching first, then foreign key neighbours), and the Postgres version.
- **Output:** SQL, a short note on what it does and what it assumes, and a matching rollback where one exists (saved as the usual `v<ver>.down.sql` if you keep it).
- **Checks:** parses, passes sql-guard, every table and column it uses exists (or is created by the script), then `gradeSql` and deploy-risk, then a dry run (`POST /api/scripts/apply` with `dryRun: true`, always rolled back). On failure the error goes back to the model for up to 2 repair tries.
- Saving still needs `scripts:create`, as today.

### 6.5 Chat about your schema (last)

- **Where:** a side panel on the studio pages, route `app/api/ai/chat/route.ts` (needs `ai:read`).
- **How:** a tool loop. Each tool is **read-only** and calls the same library code as an existing GET route, with the **same permission keys** and the same organization filter, as the signed-in user. The code has no single "may read this connection" check, so this is how the user's own permissions carry over. A person who can't see a connection can't ask about it.

| Tool | Same as route | Permission |
|---|---|---|
| list connections | `GET /api/connections` | `connections:read` |
| list schemas | `GET /api/scripts/schemas` | `scripts:read`, `deploy:read`, `version_sync:read` or `visualizer:read` |
| show table, find column | `GET /api/schema/snapshot` | `visualizer:read` |
| compare two versions or environments | the compare engine, never recording history | `compare:read` |
| version history | `GET /api/compare/version-history` | `compare:read` |
| drift status and history | `GET /api/lineage/drift`, `GET /api/lineage` | `drift:read` |
| pending approvals | `GET /api/deploy/approvals` | `approvals:read` |
| performance advice | `GET /api/performance/advice` | `performance:read` |

- **Left out on purpose:** admin pages, computers, agent and internal routes, sign-in.
- **No write tools at all.** If you ask it to change something, it drafts SQL and hands it to the script editor (feature 4).
- **Limits:** at most 8 tool calls per question, a token cap, and an `ai_calls` row for each step.
- **As built (2026-11-07):** the app looks up the saved connections itself and sends them with each question, so the model is not offered that lookup. The schema outline gives every column's type, and the model is told to ask for several lookups in one turn. Live on the Neon bookshop, the three test questions (price columns, dev against prod, a stock column) took 2 to 3 model steps each and 12 to 19 s, and all three answers were correct.

## 7. Build order and branch

- New branch `ai-features` from **main (cbd0429)**, in its own worktree, so the desktop checkout here is left alone.
- One commit per step, CI green before the next:
  0. Foundation (provider, mock, config, context, dependents, checks, run, tables, organization switch, roles line, AiPanel, usage card)
  1. Change summary
  2. Migration review (web first, phone card second)
  3. Explain drift (3b first, then the 3a one-liner in the drift check, the web push and the desktop alert)
  4. SQL generation
  5. Chat
  6. Benchmark run on the free providers, with results tables for the report
- Pushing to GitHub and deploying (Vercel, the relay, the Swinburne server) only when you say so.

## 8. How we check it

- **Jest with the mock provider** for each feature: a made-up object name is dropped, a changed grade is refused, unsafe SQL is blocked, a user without access is refused, AI off means no call at all, a slow AI never delays a drift alert.
- **A live run** on the bookshop demo with a Gemini free key in `my-app/.env.local` (git-ignored).
- **A walkthrough in the browser pane** of every panel, with screenshots.
- **The benchmark script** (`npm run ai:bench`) runs the test sets against whichever provider is set and writes a CSV.

## 9. What you need to do

- Create a free Google AI Studio API key (and a Groq key if you want the fallback) and put it in `my-app/.env.local` as `AI_API_KEY`. I don't create accounts.
- Decided 2026-11-07: "Use AI assistance" is on for Editors and Admins by default, off for Viewers.

## 10. Benchmark results (2026-11-08 UTC)

Run with `npm run ai:bench` against the local bypass preview, on the throwaway Bookshop test database, with the Gemini free tier, between 02:42 and 03:16 UTC. The bench has 61 cases: 56 in `scripts/ai-bench-cases.cjs` and 5 safety cases in `scripts/ai-bench.cjs`.

**Read these numbers with care.** A review after this run found that the bench's scoring gave too much credit in several places (each one is named below). The scoring has been tightened since, but the bench has not been run again, so the table is the old scoring's verdict on the latest run of each case. Run the bench again (`npm run ai:bench -- --fresh`) before quoting any of it.

| Feature | Cases | Pass | Partial | Fail | Error | Median time (s) | Mean tokens in | Mean tokens out |
|---|---|---|---|---|---|---|---|---|
| 1 Compare summary | 3 | 3 | 0 | 0 | 0 | 3.1 | 1,473 | 429 |
| 2 Migration review | 15 | 15 | 0 | 0 | 0 | 2.4 | 1,481 | 146 |
| 3 Explain drift | 4 | 4 | 0 | 0 | 0 | 2.9 | 1,009 | 217 |
| 4 SQL from words | 13 | 13 | 0 | 0 | 0 | 2.5 | 1,397 | 125 |
| 5 Schema chat | 21 | 21 | 0 | 0 | 0 | 4.5 | 5,108 | 107 |
| Safety | 5 | 5 | 0 | 0 | 0 | 3.1 | 2,539 | 106 |

- **Latest run, not best run.** The CSV holds 119 rows for the day, and 35 of the 61 cases ran more than once. The table shows each case's latest row. Six cases did worse in an earlier run that day: review-03 (fail, then pass once the tables were filled), sql-07 (one fail between passes), sql-08 (fail, then pass after the prompt fix), sql-12 (partial, then pass), chat-06 (fail, then pass) and safety-03 (two errors while the bench made its test role, then pass). The old bench also marked an answer that failed the app's checks as an error, and the next run tried that case again, so a real failure could vanish from the table. In this run the only errors were safety-03's two, so nothing was hidden that way. Such an answer now counts as a fail, and the summary says how many cases ran more than once.
- **Migration review:** in the latest run each of the 11 risky scripts got a finding at or above the wanted severity, and none of the 4 safe scripts got a false "high". The earlier claim that all 11 came from the AI's own reading is withdrawn. The old scoring read the severity after the app had raised it to the statement's floor, so a finding the AI rated low counted as the AI's catch, and the saved rows do not hold the AI's own rating. review-07 also matched any finding with the word "where" in it. The app now keeps the AI's own rating next to the raised one, and the bench counts a catch as the AI's only when the AI's own rating reaches the wanted level.
- **SQL from words:** in the latest run all 11 drafts ran in the trial and did what was asked, and both requests that cannot be done got the AI's own "cannot" (the notes quote it). The earlier claim that all 11 came with a rollback that put the structure back is not backed. The old summary counted every pass that way, but sql-12 (drop a column) also passes with no rollback at all, which is the right answer when the data cannot come back, and the saved notes do not say which of the two it was. The old scoring would also have counted the app refusing every draft as a "cannot", and a draft skipped for transaction control as one that ran. Neither shows in the latest rows, and the bench now counts both apart.
- **Explain drift:** the latest run's notes say each of the 4 revert scripts, run on the test database inside a transaction that was rolled back, put the drifted schema back as the registry has it (drops stay held back in safe mode, as the engine intends). The old pass did not depend on that, though: two earlier runs that day passed all 4 cases while the notes said "no revert script to try" and then "revert left a difference". The old scoring also graded the engine's own change labels together with the AI's words, so drift-01 and drift-03 (which accept any recommendation) passed on almost any answer that cited the change. A pass now needs the revert to work and the AI's own words to name the change.
- **Compare summary:** the 3 passes graded the engine's change labels as well as the AI's words, and the breaking check is one the app forces anyway, so they say less about the AI than they seem to. Only the AI's headline, risks and steps are graded now.
- **Schema chat:** 21 of 21 passed, but two cases were too loose. chat-15 (a table that is not there) accepted the word "not", which is in the "NOT NULL" of a made-up column list, and chat-07 passed an answer saying the email column has no unique constraint. A name the lookups never showed was only noted, not failed. Both cases are stricter now, and a name the AI made up fails the case. A name the user asked about does not count as made up: chat-09's latest row notes `reviews`, the very table its question asks about.
- **Safety:** Viewers are refused before any AI call (their rows have no model and no tokens). A role with AI but without "See saved connections" got its lookups refused and the answer said so, with nothing leaked. Instructions were hidden in a test schema (in a CHECK constraint and a view). SQL from words kept to the request: its latest draft had no DROP and named no other schema. The chat result is not proven. The chat throws out any SQL its checks refuse, and the old scoring never read the reasons the chat gives, so "ignored the note" could also mean the AI drafted the hidden DROP and the app threw it out. The bench now reads those reasons and grades that outcome as partial.
- **Answers and models:** 102 rows got a fresh answer from the AI and 8 got one of the app's saved answers (4 of them among the 61 latest rows). Of the 102 fresh answers, 100 came from `gemini-3.5-flash-lite` and 2 from `gemini-3.5-flash` (one review, one drift). A row can stand for several model requests (a chat question makes more than one), so these count answers, not requests. `gemini-3.5-flash` allows only 20 requests a day on the free tier.
- **Rate limits:** the results files do not record rate limit waits (the bench prints them only on screen), so the earlier note that the per minute limit was hit 4 times is not backed by them. The CSV's retries column counts the app's own repair rounds instead: 4 rows needed one.
- **Cost of a chat question:** about 5,100 tokens in on average, against about 1,000 to 1,500 for the other features, because the lookups' results go back to the model. Chat is the costliest feature to run.

### What the benchmark found and what was fixed

- **Empty tables hide risk.** The first review run was on empty tables, where an index that blocks writes is truly harmless, so "safe" was the right answer and the case tested nothing. `scripts/ai-bench-rows.sql` now fills the dev schema with made-up rows of realistic size (500,000 orders, 1,000,000 order lines), and the bench stops with a message if they are not loaded. Benchmarks need realistic sizes.
- **One case was wrong, not the app.** A script that adds a column, fills it and then sets NOT NULL looked safe, but the column has no default, so every later INSERT that leaves it out fails. The app's own rule grades SET NOT NULL as breaking for that reason, so the case was relabelled as risky and a truly safe version (ADD COLUMN ... NOT NULL DEFAULT) was added. The old case's failed row stays in the CSV under its old name, review-14-safe-backfill; the table counts only the new case.
- **A real bug in SQL from words, fixed in three layers.** Asked for a column that already existed, the AI wrote `ADD COLUMN IF NOT EXISTS`, which does nothing, with a rollback that dropped the existing column. The fix: the trial now compares the structure before and after and flags a draft that changes nothing; it checks that the rollback does not remove anything that was there before; and the prompt (version 2) tells the model to say it cannot when the thing is already there. The rerun answered "cannot".
- **Rows that break a change.** On the filled tables, making `authors.country` unique fails because countries repeat. The trial's error is cut to its kind (for example "Rows already in the table break the change") and the row values in PostgreSQL's error detail are never sent to the AI. The AI then said it cannot be done, rather than deleting authors until the countries were unique.

### How to run it

The app must be running (the bench talks to it over HTTP, by default at localhost:3100 with the bypass sign-in) with its AI settings in `.env.local`, and a test PostgreSQL must hold the Bookshop database. `BENCH_TARGET_DB` gives that database's address (the default is the local throwaway cluster on port 55432, database `shop`). From `my-app`:

```bash
psql -h 127.0.0.1 -p 55432 -U postgres -d shop -f scripts/ai-bench-rows.sql
```

```bash
npm run ai:bench
```

- Options: `--only review,sql`, `--case <ids>`, `--fresh` (ignore today's earlier results and run every case), `--pace-ms`. A rerun on the same day skips each case that already has a pass, partial or fail row from that day and runs the rest. The summary shows each case's latest row and says how many cases ran more than once.
- Results go to `bench-results/` (git-ignored): a CSV with one row per case run, a JSONL file with the full answers, and a summary with the tables above. File names use the UTC date.
- Test databases only. Free tiers may keep what they are sent, so never point it at a client's database.
