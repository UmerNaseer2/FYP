# External review prompt

Paste everything below the line into the reviewing model, with the repository
available to it. It is written to be self-contained.

---

You are reviewing **Schema Studio**, a final-year university project: a
PostgreSQL schema comparison, migration and drift-detection tool. It is a real
application built for a real client, not a toy. Roughly 52,000 lines of
TypeScript across a Next.js 16 App Router codebase.

## Read these first, in this order

1. `docs/PROJECT_CONTEXT.md` — an orientation written specifically for you:
   architecture, the two-database model, entry points, known caveats,
   conventions. **Start here.** It will save you an hour.
2. `docs/requirements/COS40005-team-and-project-plan.txt` — the client's own
   requirements, including the mandated stack and the 38-item product backlog
   in Table 5. This is the authoritative statement of what the tool is
   supposed to do.
3. `docs/README.md` — the documentation index, including a section listing
   where the coursework documents have gone stale relative to the code.
4. `my-app/README.md` — the only tracked document maintained alongside the code.

The `docs/` folder also holds the user manual as a text extraction. Treat it as
partly stale: `docs/README.md` lists where it disagrees with the code.

## What is deliberately out of scope

Please do not spend findings on any of these. They are known, they are
intentional or already in hand, and reporting them costs you review budget that
would be better spent elsewhere.

**1. The authentication bypass.** `my-app/lib/auth-mode.ts` defines
`BYPASS_AUTH = process.env.NEXT_PUBLIC_AUTH_BYPASS !== "false"`, and it is
currently ON. While on, every route gate returns a hardcoded admin principal and
the edge proxy passes everything through. **This is a deliberate development
setting** — the Microsoft Entra credentials have not been provisioned yet, so
the alternative is that the app cannot be run at all.

Review the authorisation code **behind** the switch, on the assumption that the
switch is off and the credentials exist. The role model, the gate design in
`lib/auth-guard.ts`, per-route gate correctness, the edge/server/client layering,
and the role-lookup-per-request behaviour in `auth.ts` are all fair game and I
want your judgement on them. The switch's current position is not.

Corollaries also out of scope: that the flag is fail-open on a malformed value;
that no Microsoft sign-in has ever completed; that `.env.local` lacks
`AZURE_AD_*` and `NEXTAUTH_SECRET`.

**2. Secret rotation.** Credentials leaked into the repository's public history
earlier in the project. The history has been purged and rotation is a known,
tracked action item. Do not re-report it.

**3. Item 38 of the backlog, "AI assistance if time allows".** Confirmed absent,
already recorded, and marked optional by the client.

## What I actually want reviewed

Weight your effort roughly in this order.

**1. Correctness of the core engine.** The comparison, SQL generation and
rollback path is the product; everything else is scaffolding around it. Three
things specifically:

- `lib/compare.ts` — rename detection. It scores candidate table and column
  pairs on weighted similarity and applies `tableNameRenameGuard` to demote
  structurally-similar-but-unrelated names. Where does this get it wrong, and
  what does a wrong answer cost?
- `lib/generate-sql.ts` — is the generated SQL correct, and is the *rollback*
  genuinely the inverse of the migration? `generateRollback` works by re-running
  the comparison backwards. Where does that reasoning break?
- Ordering and dependency: does generated DDL respect foreign keys, inheritance
  and partitioning, or can it emit statements a real server would reject?

**2. Data-loss and destructive-operation safety.** `app/api/scripts/apply/route.ts`
is 1,244 lines and runs arbitrary DDL against a customer database. It has a
safe-mode default, an "allow data loss" arm, a transaction around the whole
queue, advisory locks, a dry-run path, a production two-person approval with a
single-use run fingerprint, and a ledger. **Try to find the path through it that
loses data or leaves a target half-migrated.** Review `scripts/revert` alongside
it, since they share the ledger and the approval mechanics.

**3. SQL injection and input handling.** Schema and table names flow from user
input into introspection queries, generated DDL and the deploy path. Identifier
quoting is the risk surface. `lib/sql-guard.ts` does statement splitting and
comment/string masking; `/api/performance/analyze` executes caller-supplied SQL
inside `BEGIN READ ONLY` with a statement timeout and an unconditional rollback.
Is that containment actually sound?

**4. Error handling and failure modes.** The known gap is that there is no
`error.tsx`, `global-error.tsx` or `not-found.tsx` anywhere in `app/`. Beyond
that: what happens when a target database is unreachable mid-operation, when a
snapshot is truncated, when two drift checks race? A stated project value is
that error states must be readable by a user and must never crash — measure
against that.

**5. Test coverage where it matters.** 16 suites, 388 tests, all in `lib/`.
No route handler, page or component is under test. Given that, **which
untested code path would hurt most if it were wrong?** I would rather have three
well-chosen test targets than a general observation that coverage is uneven.

**6. Requirements fidelity.** Compare the code against the 38-item backlog and
the mandated stack in the project plan. My own trace says 32 done, 5 partial,
1 missing, with the partials listed in `docs/PROJECT_CONTEXT.md` section 9.
**Check that trace rather than trusting it** — say where I have marked something
done that is not really done, or partial that is actually fine.

## How to report

- **Order findings by consequence**, worst first. A single data-loss path is
  worth more than twenty style notes.
- **Cite `file:line`** for every finding. A claim I cannot navigate to is a
  claim I cannot act on.
- **State the concrete failure**: the inputs or state, and the wrong output or
  crash that results. "This could be a problem" is not actionable; "with a
  partitioned table whose parent is dropped in the same migration, line N emits
  the child drop second and the statement fails" is.
- **Separate what is broken from what is merely unlike how you would write it.**
  Both are welcome, labelled.
- If you conclude something is fine after genuinely checking it, **say so** —
  knowing which areas survived scrutiny is as useful to me as the defect list.

## Context on the standards to apply

This is a final-year undergraduate project maintained by one student who is
still learning. Simple readable code is a deliberate value here; a clever
abstraction that saves ten lines but costs a maintainer an hour is a regression,
not an improvement. Judge the engineering on whether it is *correct, safe and
comprehensible*, and hold the correctness and safety bars high — this tool
writes DDL to other people's databases.
