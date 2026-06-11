# Version Sync (Version Replay) — Implementation Plan

> Status: **planned, not built**. Page name: **Version Sync** · route `/versionsync` · sidebar item.
>
> This is the "Table Version" panel from the wireflow — the second of the two
> migration models the project needs.

---

## 1. The two migration models (framing)

The app today only has the **first**:

1. **Structural** *(built — `/compare`)* — diff two schemas' **current states** → generate
   one fresh migration → push to GitHub. "Goes straight to v3.0.0", loses the
   intermediate versions.
2. **Version replay** *(this feature — `/versionsync`)* — bring a **behind** schema up to an
   **ahead** one by **re-running the actual scripts that were applied to the ahead schema,
   version by version** (v2.0.0 → v2.0.1 → v3.0.0). **Preserves lineage.** Requires the
   applied SQL to be stored — that's the single data change.

Concrete example (from the brief): Schema A has 2 scripts applied; Schema B has those
2 + 4 more. Version Sync lets you select both, see the 4 that B has and A is missing,
and replay them onto A (all at once = "match up", or one step = "bump by 1").

---

## 2. Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Per-family or whole-schema? | **Whole-schema flat log.** Match entries on `script_name` + `version`; replay in the Source's original `applied_at` order; show one timeline. |
| 2 | Divergence handling | **Support "Target behind Source".** If the Target has versions the Source lacks (they branched), **detect + warn — never auto-merge.** |
| 3 | Legacy rows (no stored SQL) | Rows applied before this change have `sql_content = NULL` → **show "no stored script — can't replay"**. *Optional later:* fall back to the GitHub registry by family + version. |
| 4 | Where it lives | **Dedicated sidebar page** named **Version Sync** (`/versionsync`). Not a Compare sub-mode. |

**Safety caveat (surface in the UI):** replaying historical SQL assumes the Target is at a
compatible prior state. If the Target drifted, a replay step can fail — it rolls back that
one step cleanly (earlier steps stay applied), and the error is shown.

---

## 3. The one data change

Add **`sql_content TEXT`** to `script_patch`. The apply route already *receives* the SQL it
executes — it just doesn't keep it. Store it on apply.

- Add the column defensively: `ALTER TABLE <schema>.script_patch ADD COLUMN IF NOT EXISTS sql_content TEXT;`
  (same pattern the apply route already uses to back-fill `script_name` on older tables).
- Include `sql_content` in the `script_patch` `INSERT` performed after a successful apply.
- Backwards-compatible: existing rows keep `NULL`; nothing else changes.

`script_patch` columns after this: `id, script_name, version, title, description,
change_type, source_ref, sql_content, applied_at`.

---

## 4. The flow

1. **Pick two schemas** — Source (ahead) + Target (behind), each a connection + schema.
   Auto-mark the outdated side.
2. **Read both ledgers** — each schema's `script_patch` including `sql_content`.
3. **Diff** — entries the Source has that the Target lacks, matched on
   `(script_name, version)`, ordered by the Source's `applied_at` = the replay order.
4. **Show** — the version timeline; each missing version's **SQL read-only** ("you cannot
   change the script here — it's history"); controls: **Run vX**, **Run All**, **Bump by 1**
   (apply just the next missing entry).
5. **Apply** — feed the Source's stored `sql_content` into the **existing apply route**,
   targeting the Target schema, **one version per transaction** (reusing its
   rollback-on-failure + advisory-lock safety). Each success records into the Target's
   `script_patch`.
6. **Result** — Target advances; **"You're up to date!"** when matched.

---

## 5. Reused vs. new

- **Reused:** the apply route (`/api/scripts/apply` — transactional run + ledger insert),
  preflight (ledger read), the connection/schema pickers (`Select`), the semver helpers
  (`lib/script-status.ts`), `AuthGuard` layout pattern.
- **New:** the `sql_content` column + storing it; a "ledger-with-SQL" read endpoint; the
  Version Sync page (timeline + read-only SQL + Run / Bump / Run All).

---

## 6. Phases

### P1 — Storage *(smallest, unblocks everything; backwards-compatible)*
- `app/api/scripts/apply/route.ts`: add `sql_content` to the `CREATE TABLE` DDL + the
  defensive `ADD COLUMN IF NOT EXISTS`; include it in the post-apply `INSERT`.
- **Done when:** applying a script through Deploy stores its SQL in `script_patch`;
  `tsc`/`eslint`/`build` green; an applied row shows non-null `sql_content`.

### P2 — Read *(ledger-with-SQL endpoint)*
- `GET /api/versionsync/ledger?connectionId=&schema=` → the schema's `script_patch`
  rows: `{ script_name, version, change_type, applied_at, hasSql, sql_content }`.
  (Mirror preflight's connection lookup + SSL/URI handling via `buildPgConfig`.)
- Pure helper to **diff two ledgers** → `{ missing: Entry[], diverged: Entry[], upToDate: boolean }`
  in `lib/version-sync.ts` (unit-testable, no DB).
- **Done when:** the endpoint returns a schema's ledger; the diff helper has unit tests
  (clean subset, divergence, legacy/no-sql, empty).

### P3 — Diff + UI *(the page; read-only, no applying yet)*
- Nav: "Version Sync" item (`SchemaMapIcon`-style or a new icon), route `/versionsync`,
  `AuthGuard` layout.
- Page: two **Source/Target** pickers (connection + schema each), reusing `Select`.
- On both selected → fetch both ledgers → run the diff → render:
  - the **version timeline** (Source versions, Target's current marked, missing highlighted),
  - per missing version: **read-only SQL** (or "no stored script" for legacy NULLs),
  - **divergence warning** banner when the Target has versions the Source lacks,
  - **"You're up to date!"** state when matched.
- Controls present but **disabled/no-op** until P4: Run vX / Bump by 1 / Run All.
- **Done when:** picking two schemas shows the correct missing-versions timeline + SQL +
  divergence/up-to-date states; loading/error/empty handled; pretty + on-brand.

### P4 — Apply wiring *(make the buttons work)*
- **Run vX:** POST the Source entry's `sql_content` to `/api/scripts/apply` targeting the
  Target (connection + schema + script_name + version + sql_content + change_type).
- **Bump by 1:** apply only the earliest missing entry.
- **Run All:** apply all missing entries **in `applied_at` order, sequentially**, each its
  own transaction; stop + surface on the first failure (earlier successes stay).
- After each apply: refresh the Target ledger → timeline advances; reach "up to date".
- Guard rails: confirm before Run All (it's writes to a live DB); block when diverged
  unless explicitly overridden; skip/disable entries with no stored SQL.
- **Done when:** a behind schema can be brought up to an ahead schema's version end-to-end,
  verified live; failures roll back the failing step cleanly and report; `tsc`/`eslint`/`build` green.

---

## 7. Deferred / optional
- **GitHub-registry fallback** for legacy NULL `sql_content` (look up the script by
  family + version in the registry).
- **Backfill** existing `script_patch` rows' `sql_content` from the registry.
- **Dry-run / preview** of what Run All would change before committing.
- **Two-way / merge** when schemas have diverged (out of scope for v1 — we only warn).
