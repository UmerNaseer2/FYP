# Script System Refactor Plan

> Written after discussion session — come back to this when ready to implement.
> Do these in order — each phase builds on the previous one.

---

## Phase 1 — Fix GitHub Folder Structure ✅ DONE

**Problem:** Currently GitHub creates one folder per script name:
```
repo/
  users_migration/
    v1.0.0.sql
  products_migration/
    v1.0.0.sql
```

**Target structure:** One folder per schema, scripts nested inside:
```
repo/
  public/
    users_migration/
      v1.0.0.sql
    products_migration/
      v1.0.0.sql
  finance/
    accounts_migration/
      v1.0.0.sql
```

**What to change in code:**
- `app/api/github/push/route.ts` — update the file path construction to prepend `schemaName/` before the script folder
- `app/api/github/pull/route.ts` — update the path it reads from to match
- Any folder-listing/discovery logic that finds scripts in the repo

**What to do in the GitHub repo itself:**
- Delete the existing root-level script folders (e.g. `users_migration/`) from the repo
- They'll be re-created under the correct schema path on next push
- One-time cleanup — do this manually or via the GitHub UI

---

## Phase 2 — Single Source of Truth: GitHub Only ✅ DONE

**Problem:** Scripts are stored in two places — the local app database AND GitHub. They can drift apart (edit locally, forget to push, now they're out of sync).

**Target:** GitHub is the canonical source. Local DB is not used for script storage.

**How it works after the change:**
1. Scripts live only in GitHub (`.sql` files in the schema-based folder structure from Phase 1)
2. When the user opens the scripts page, the app **pulls the file list from GitHub** to know what scripts exist
3. The `script_patch` table inside the **target database** remains the source of truth for what has been *applied*
4. The app compares (GitHub scripts) vs (script_patch rows) to determine pending scripts

**What to change:**
- The local app DB `scripts` table becomes unused — can be dropped or ignored
- `app/api/scripts/list/route.ts` — rewrite to fetch from GitHub instead of local DB
- `app/api/scripts/register/route.ts` — probably goes away entirely (no more local registration)
- `app/scripts/page.tsx` — update script-loading logic to pull from GitHub
- `app/api/github/pull/route.ts` — this becomes the primary way to load scripts, needs to return structured data (script_name, version, sql_content) not just raw file bytes

**Key insight:** The `script_patch` table in the target DB is still needed and still works as-is. Only the "where do script files live" part changes — from local DB to GitHub.

---

## Phase 3 — New UX Flow for Scripts Page ✅ DONE

**Current flow:** Flat page, pick connection, pick script group, run.

**New flow:**

```
Step 1 → Choose Connection
Step 2 → Choose Schema (dropdown populated from target DB)
Step 3 → Script dashboard for that schema
Step 4 → Run to version / Rollback
Step 5 → Success
```

### Step 2 — Schema selector
- Query: `SELECT schema_name FROM information_schema.schemata ORDER BY schema_name`
- Run this against the selected connection after Step 1
- Show as a dropdown (filter out `pg_*`, `information_schema` etc.)
- This also determines which GitHub folder to read from (Phase 1 structure)

### Step 3 — Script dashboard
Show for the selected connection + schema:
- Current version (from `script_patch` in target DB)
- List of all scripts from GitHub, split into:
  - ✅ Applied (version ≤ currentVersion, shown in history)
  - 🟡 Pending (version > currentVersion, ready to deploy)
- Option to run all pending, or run up to a specific version

### Step 4 — Run options
- **"Deploy to version X"** — apply all pending scripts up to and including a chosen version
  - Simpler than "run all" — user picks target version from a dropdown
  - Apply loop runs only up to that version
- **"Rollback to version X"** — see note below

### Rollback — defer this, it's its own feature
Rollback needs:
- Each script to have a corresponding **down migration** file (e.g. `v1.2.0_down.sql`)
- The app to run the down files in reverse order
- `script_patch` rows to be deleted after successful rollback
- New UI for selecting how far back to roll

**Don't build rollback in the same phase as the UX refactor — it's a separate feature that needs its own design.**

---

## Suggested Order of Work

| # | Task | Effort | Notes |
|---|---|---|---|
| 1 | Fix GitHub folder structure (Phase 1) | ✅ DONE | push/pull routes updated |
| 2 | Single source of truth (Phase 2) | ✅ DONE | GitHub is canonical; local scripts table unused |
| 3 | Schema selector in UI (Phase 3, Step 2) | ✅ DONE | Dropdown from DB schemas |
| 4 | Script dashboard redesign (Phase 3, Step 3) | ✅ DONE | Schema-scoped pending list |
| 5 | "Deploy to version X" option (Phase 3, Step 4) | ✅ DONE | Version target picker |
| 6 | Rollback feature | Separate phase | Needs down migration files + new UI |

---

## Notes / Decisions Made

- GitHub = canonical script store. Local DB = gone for scripts.
- Folder structure: `repo/<schemaName>/<scriptName>/<version>.sql`
- `script_patch` table in target DB stays exactly as-is (already has `script_name` column).
- Rollback is intentionally deferred — it requires down migration files and is a larger feature.
- The compare feature (`/compare`) is unrelated and should not be touched in this refactor.
