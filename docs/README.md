# Project documents

The coursework documents behind this repository: what the client asked for and
how to drive the finished app. They are kept here
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
| `user-manual/schema-studio-user-manual.txt` | End-user walkthrough of the app, screen by screen. | **The app as a user meets it.** Re-read against the code on 2026-09-18 (v2.1.0). |

`.txt` files are text extractions of the original documents, kept alongside them
so a reader that cannot open a PDF still gets the full content.

The first two rows and the last one are maintained alongside the code and
describe it as it is today. The rest are coursework documents, frozen at the
date they were submitted.

## What is deliberately not here

**The signed Student Project Agreement is excluded from this repository.** It is
a legal form carrying signatures and personal details, and this repository is
public. The original lives outside the repository, at
`~/Documents/FYP-doc-originals-not-in-repo/`.

One redaction was made to a committed file: the user manual gave a real Neon
database host as its worked example. It was replaced with a placeholder, and
the example has since been dropped from that walkthrough entirely.

## Where these documents disagree with the code

Read the code first. These documents were written at points in time and the code
moved past them.

- **The project plan lists rollback and query analysis as later work.** Both are
  built. See `my-app/lib/query-analysis.ts`, `my-app/lib/perf-advice.ts` and the
  `/api/scripts/revert` route.
- **The project plan describes signing in with a Microsoft work account.** The sign-in flow is built and the login screen offers it, but this
  repository carries no Entra ID credentials, so the button is disabled with an
  explanation until a server is given them. A checkout can be opened for testing
  with `NEXT_PUBLIC_AUTH_BYPASS=true` in `.env.local`, which lets everybody in as
  an admin and says so on screen — an "auth off" pill in the sidebar. Without
  that line authentication is enforced and an unconfigured checkout is shut, not
  open: see the reasoning at the top of `my-app/lib/auth-mode.ts`.

Two entries left this list on 2026-09-18, when the user manual was re-read
against the code: it described two roles where there are three, and it had no
section for the Performance screens. Both are fixed in v2.1.0.

Four tracked documents do describe the code as it stands, and are re-read
against it rather than frozen: `my-app/README.md`, `PROJECT_CONTEXT.md`,
`REVIEW_PROMPT.md` and the user manual.
