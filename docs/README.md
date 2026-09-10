# Project documents

The coursework documents behind this repository: what the client asked for, what
was reported each sprint, and how to drive the finished app. They are kept here
so anyone reviewing the code — a marker, a teammate, an AI reviewer — can read
the requirements without being handed a separate folder.

Unit COS40005, Swinburne University of Technology Sarawak.
Team: Umer Naseer, Frandya Meidy F., Cindy Wong IY. Supervisor: Jason Thomas Chew.

## What is here

| File | What it is | Trust it for |
|---|---|---|
| `PROJECT_CONTEXT.md` | Orientation for someone reviewing the code: architecture, the two-database model, core entry points, the backlog traced against what is actually built, and the honest caveats. | **The current code.** Written from the code, not from a plan, and dated. |
| `REVIEW_PROMPT.md` | A paste-ready prompt for an external AI reviewer, including what is deliberately out of scope. | Getting a useful outside review instead of a list of things already known. |
| `requirements/COS40005-team-and-project-plan.*` | The project plan agreed with the client. Stakeholders, scope, the mandated technology stack, and the 38-item Product Backlog (Table 5). | **The requirements.** This is the authoritative statement of what the software is supposed to do. |
| `requirements/fyp-poster.*` | The academic poster: problem framing, literature review, gap analysis against Flyway and Liquibase. | Why the project exists and how it differs from existing tools. |
| `progress-reports/COS40005-sprint-report-{1,2,3}.txt` | What was built in each sprint, week by week, per team member. | A timeline of the build. **Not** a description of the current code — see below. |
| `user-manual/schema-studio-user-manual.txt` | End-user walkthrough of the app. | The intended user journey. **Partly stale** — see below. |

`.txt` files are text extractions of the original documents, kept alongside them
so a reader that cannot open a PDF still gets the full content.

The first two rows are maintained alongside the code and describe it as it is
today. The rest are coursework documents, frozen at the date they were
submitted.

## What is deliberately not here

**The three sprint-report PDFs are excluded from this repository, and the `.txt`
extractions are committed in their place.** The PDFs embed 123 screenshots
between them, and those screenshots show real data: teammates' university and
personal email addresses, a live `profiles` table with user rows, an Azure AD
app registration with its tenant and client identifiers, hosted database
endpoints and usernames, and one client email stamped *"This data has been
classified as Internal"*. This repository is public. The text layer of those
same reports carries none of that, which is why the `.txt` files are safe to
commit and the PDFs are not.

The signed Student Project Agreement is excluded for the same reason — it is a
legal form carrying signatures and personal details.

The originals live outside the repository, at
`~/Documents/FYP-doc-originals-not-in-repo/`.

One redaction was made to a committed file: the user manual gave a real Neon
database host as its worked example, and that host is now `ep-xxxxxxxx-…`.

## Where these documents disagree with the code

Read the code first. These documents were written at points in time and the code
moved past them.

- **The user manual (v2.0.0, 2026-06-16) says there are two roles, `viewer` and
  `admin`.** There are three: `viewer`, `editor`, `admin`. `editor` is the level
  that may write — generate scripts, deploy, run a measured query plan.
- **The user manual describes signing in with a Microsoft work account as the
  live flow.** Authentication is fully built, but the bypass switch in
  `my-app/lib/auth-mode.ts` is currently ON, so a local run lets everybody in as
  an admin. That is a deliberate testing setting, not a missing feature.
- **The sprint reports describe a Supabase-backed app** with `lib/supabase/client.ts`,
  Supabase Auth and row-level-security policies. None of that survives. The app
  now talks to PostgreSQL directly through `pg` and Sequelize, and authentication
  is NextAuth with Microsoft Entra ID. Sprint 3 records that migration.
- **The sprint reports show a multi-page shell** (Dashboard / Connections /
  Schema Comparison / Version Detection / SQL Scripts / Admin Control). Sprint 3
  replaced it with the single `/studio` route group; the screens in Sprint 1 and
  Sprint 2 no longer look like that.
- **The project plan lists rollback and query analysis as later work.** Both are
  built. See `my-app/lib/query-analysis.ts`, `my-app/lib/perf-advice.ts` and the
  `/api/scripts/revert` route.

The single tracked document that does describe the code as it stands is
`my-app/README.md`.
