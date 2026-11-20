// View statements: create, drop, dependency order, and which views a
// DROP ... CASCADE takes with it.

import type { ViewSnapshot } from "../../postgres";
import { viewOptionsClause } from "../../compare/diff";
import { q } from "./basics";
import { objectStatement } from "./statement-helpers";
import type { SqlStatement } from "./types";

// ── Views ──────────────────────────────────────────────────────────────────

/**
 * @param afterHeldBackDrop whether this script drops a view of this name with a
 * statement safe mode comments out, so this one is putting back something that
 * in safe mode was never taken away.
 */
export function createViewStatement(view: ViewSnapshot, afterHeldBackDrop: boolean): SqlStatement {
  // pg_get_viewdef already ends in a semicolon and starts with whitespace.
  const body = view.definition.trim();
  // security_invoker, check_option, security_barrier and a matview's storage
  // settings live here and nowhere in the body. Writing them out is not just
  // for completeness: CREATE OR REPLACE VIEW REPLACES the option list, so an
  // omitted WITH clause silently strips security_invoker off a view this
  // statement was only meant to put back after a CASCADE took it.
  const options = viewOptionsClause(view);
  const head = options ? `${q(view.name)} ${options}` : q(view.name);
  // Neither form fails when the view is already there. That matters because
  // this same statement is used to put back a view a CASCADE *may* have taken:
  // if it survived, running this is harmless.
  //
  // The two forms are not equally harmless, though. CREATE OR REPLACE rewrites
  // whatever it finds; IF NOT EXISTS finds the old matview and does NOTHING.
  const sql = view.materialized
    ? `CREATE MATERIALIZED VIEW IF NOT EXISTS ${head} AS\n${body}`
    : `CREATE OR REPLACE VIEW ${head} AS\n${body}`;
  const note = options ? ` ${options}` : "";
  return objectStatement({
    sql: sql.endsWith(";") ? sql : `${sql};`,
    description: `Create ${view.materialized ? "materialized view" : "view"} "${view.name}"${note}`,
    kind: "CREATE_VIEW",
    tableName: view.name,
    // ...which is why a rebuild is held back with a drop safe mode comments
    // out. The old materialized view is then still sitting there, and this
    // statement either does nothing (IF NOT EXISTS) or fails outright
    // ("x is not a view", when the source made it a plain view). Either way
    // the script must not run it and report success.
    needsArmedDrop: afterHeldBackDrop,
  });
}

export function dropViewStatement(view: ViewSnapshot, reason: string): SqlStatement {
  return objectStatement({
    sql: view.materialized
      ? `DROP MATERIALIZED VIEW IF EXISTS ${q(view.name)} CASCADE;`
      : `DROP VIEW IF EXISTS ${q(view.name)} CASCADE;`,
    description: `Drop ${view.materialized ? "materialized view" : "view"} "${view.name}"${reason}`,
    kind: "DROP_VIEW",
    severity: "breaking",
    tableName: view.name,
    // A plain view is a stored query and holds nothing. A materialized view
    // holds its own copy of the rows, and dropping it throws them away.
    destructive: view.materialized,
  });
}

/**
 * Order views so each one comes after everything it reads.
 *
 * A view built on another view fails to create if its source is not there yet,
 * and fails to drop cleanly in the other direction. `dependsOn` comes from
 * pg_depend, so this is the real dependency graph and not a guess parsed out of
 * the SELECT text. `visiting` only guards the recursion — PostgreSQL does not
 * allow a cycle between views in the first place.
 */
export function sortViewsByDependency(views: ViewSnapshot[]): ViewSnapshot[] {
  const byName = new Map(views.map((view) => [view.name, view]));
  const ordered: ViewSnapshot[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();

  function place(view: ViewSnapshot): void {
    if (placed.has(view.name) || visiting.has(view.name)) return;
    visiting.add(view.name);
    for (const dependency of view.dependsOn) {
      const source = byName.get(dependency);
      if (source) place(source);
    }
    visiting.delete(view.name);
    placed.add(view.name);
    ordered.push(view);
  }

  for (const view of views) place(view);
  return ordered;
}

/**
 * Every view that a `DROP ... CASCADE` on one of `doomedRelations` will take
 * with it, including views built on those views.
 *
 * This is the whole reason ViewSnapshot records dependsOn. CASCADE is silent:
 * it destroys dependents without naming them, and a report that never mentioned
 * them cannot put them back. Knowing the list up front means the script can say
 * what it is about to remove, and can recreate the ones that should survive.
 */
export function viewsCascadedBy(views: ViewSnapshot[], doomedRelations: Set<string>): ViewSnapshot[] {
  const doomed = new Set(doomedRelations);
  let grew = true;
  while (grew) {
    grew = false;
    for (const view of views) {
      if (doomed.has(view.name)) continue;
      if (view.dependsOn.some((dependency) => doomed.has(dependency))) {
        doomed.add(view.name);
        grew = true;
      }
    }
  }
  return views.filter((view) => doomed.has(view.name));
}

/**
 * The views that read one of the named columns of a table, and so are removed
 * by a `DROP COLUMN ... CASCADE` on it. Views built on those views are NOT
 * added here: pass the result's names to viewsCascadedBy for that.
 *
 * A view from an old snapshot has no column list. For those the answer is the
 * careful one, "it reads the table, so it may read the column".
 */
export function viewsReadingColumns(
  views: ViewSnapshot[],
  tableName: string,
  columnNames: Set<string>
): ViewSnapshot[] {
  if (columnNames.size === 0) return [];
  return views.filter((view) => {
    if (!view.dependsOn.includes(tableName)) return false;
    if (view.dependsOnColumns === undefined) return true;
    const read = view.dependsOnColumns.filter((entry) => entry.table === tableName);
    // It depends on the table but on no single column of it (it reads the row
    // as a whole), so any column may matter to it.
    if (read.length === 0) return true;
    return read.some((entry) => columnNames.has(entry.column));
  });
}

/** viewsReadingColumns plus every view built on one of them. */
export function viewsCascadedByColumns(
  views: ViewSnapshot[],
  tableName: string,
  columnNames: Set<string>
): ViewSnapshot[] {
  const direct = viewsReadingColumns(views, tableName, columnNames);
  if (direct.length === 0) return [];
  return viewsCascadedBy(views, new Set(direct.map((view) => view.name)));
}
