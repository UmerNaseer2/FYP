// Trigger statements, row level security switches and policy statements.

import type { TableMatch } from "../../compare/types";
import type { PolicySnapshot, RowSecuritySnapshot, TriggerSnapshot } from "../../postgres";
import { q } from "./basics";
import { namesChangingColumn } from "./column-changes";
import { literal, objectStatement, onlyIfMissing } from "./statement-helpers";
import type { SqlStatement } from "./types";

// ── Triggers ───────────────────────────────────────────────────────────────

// CREATE TRIGGER has no IF NOT EXISTS, so a preceding DROP is the only way to
// make it idempotent. That is also what makes a changed trigger replaceable.
export function createTriggerStatements(
  trigger: TriggerSnapshot,
  tableName: string,
  opts: {
    /**
     * Set for a trigger on a view whose drop safe mode comments out — see
     * createIndexStatement. The DROP/CREATE pair itself would succeed against
     * the old view, but it would be putting the source's trigger onto the
     * target's view, which is not a state either side asked for.
     */
    afterHeldBackDrop?: boolean;
    /**
     * Set when `tableName` names a view rather than a table.
     *
     * PostgreSQL has no way to disable a trigger on a view: ALTER TABLE is the
     * only syntax that carries DISABLE TRIGGER, and it answers "ALTER action
     * DISABLE TRIGGER cannot be performed on relation" for a view. So a view
     * trigger is always enabled and the disable line below is skipped — which
     * matters, because the apply route runs the migration in one transaction
     * and that one rejected statement would take every other one down with it.
     */
    onView?: boolean;
  } = {}
): SqlStatement[] {
  const afterHeldBackDrop = opts.afterHeldBackDrop ?? false;
  const stmts: SqlStatement[] = [
    objectStatement({
      sql: `DROP TRIGGER IF EXISTS ${q(trigger.name)} ON ${q(tableName)};`,
      description: `Replace trigger "${trigger.name}" on "${tableName}"`,
      kind: "DROP_TRIGGER",
      tableName,
      needsArmedDrop: afterHeldBackDrop,
    }),
    objectStatement({
      sql: `${trigger.definition.trim()};`,
      description: `Create trigger "${trigger.name}" on "${tableName}"`,
      kind: "CREATE_TRIGGER",
      tableName,
      needsArmedDrop: afterHeldBackDrop,
    }),
  ];
  // A trigger is created enabled. Recreating a disabled one without this would
  // silently turn its behaviour back on in the target.
  if (!trigger.enabled && !opts.onView) {
    stmts.push(
      objectStatement({
        sql: `ALTER TABLE ${q(tableName)} DISABLE TRIGGER ${q(trigger.name)};`,
        description: `Disable trigger "${trigger.name}" on "${tableName}" (it is disabled in the source)`,
        kind: "CREATE_TRIGGER",
        tableName,
        needsArmedDrop: afterHeldBackDrop,
      })
    );
  }
  return stmts;
}

export function dropTriggerStatement(triggerName: string, tableName: string): SqlStatement {
  return objectStatement({
    sql: `DROP TRIGGER IF EXISTS ${q(triggerName)} ON ${q(tableName)};`,
    description: `Drop trigger "${triggerName}" from "${tableName}" — WARNING: the behaviour it enforced stops`,
    kind: "DROP_TRIGGER",
    severity: "breaking",
    tableName,
  });
}

/**
 * Take a trigger off for the length of the script, so a column it names can be
 * retyped or rebuilt. Its CREATE is queued in the trigger phase, which runs
 * after the alters.
 */
export function dropTriggerForColumnChange(triggerName: string, tableName: string): SqlStatement {
  return objectStatement({
    sql: `DROP TRIGGER IF EXISTS ${q(triggerName)} ON ${q(tableName)};`,
    description:
      `Drop trigger "${triggerName}" from "${tableName}" so a column it names can be ` +
      "changed (it is created again further down)",
    kind: "DROP_TRIGGER",
    tableName,
  });
}

// ── Row-level security ─────────────────────────────────────────────────────

/**
 * Bring one table's row-security switches to the source's setting.
 *
 * Two switches, not one: ENABLE decides whether policies are enforced at all,
 * FORCE decides whether they are enforced against the table's own owner too.
 * Only the ones that actually differ are written, so a migration that changed a
 * policy does not also carry a no-op ENABLE line.
 */
export function rowSecurityStatements(
  source: RowSecuritySnapshot,
  target: RowSecuritySnapshot,
  tableName: string
): SqlStatement[] {
  const stmts: SqlStatement[] = [];

  if (source.enabled !== target.enabled) {
    stmts.push(
      objectStatement({
        sql: `ALTER TABLE ${q(tableName)} ${source.enabled ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY;`,
        description: source.enabled
          ? `Enable row level security on "${tableName}" — WARNING: every query now returns ` +
            "only the rows a policy allows, and a table with no policy returns none"
          : `Disable row level security on "${tableName}" — WARNING: its policies stop being ` +
            "enforced and every row becomes visible to anyone who can read the table",
        kind: "ALTER_ROW_SECURITY",
        // Breaking in both directions, and for opposite reasons. See
        // objectChangeSeverity in lib/compare/diff.ts.
        severity: "breaking",
        tableName,
      })
    );
  }

  if (source.forced !== target.forced) {
    stmts.push(
      objectStatement({
        sql: `ALTER TABLE ${q(tableName)} ${source.forced ? "FORCE" : "NO FORCE"} ROW LEVEL SECURITY;`,
        description: source.forced
          ? `Apply row level security to the owner of "${tableName}" as well`
          : `Stop applying row level security to the owner of "${tableName}"`,
        kind: "ALTER_ROW_SECURITY",
        severity: "breaking",
        tableName,
      })
    );
  }

  return stmts;
}

/** A policy reads columns in two places: its USING and its WITH CHECK. */
export function policyNamesChangingColumn(match: TableMatch, policy: PolicySnapshot): boolean {
  return namesChangingColumn(match, `${policy.using ?? ""} ${policy.withCheck ?? ""}`);
}

export function createPolicyStatement(policy: PolicySnapshot, tableName: string): SqlStatement {
  return objectStatement({
    sql: onlyIfMissing(
      `SELECT 1 FROM pg_policy WHERE polrelid = to_regclass(${literal(q(tableName))}) ` +
        `AND polname = ${literal(policy.name)}`,
      `CREATE POLICY ${q(policy.name)} ON ${q(tableName)} ${policy.definition};`
    ),
    description: `Create policy "${policy.name}" on "${tableName}" — check who this lets in`,
    kind: "CREATE_POLICY",
    severity: "breaking",
    tableName,
  });
}

export function dropPolicyStatement(policyName: string, tableName: string, why: string): SqlStatement {
  return objectStatement({
    sql: `DROP POLICY IF EXISTS ${q(policyName)} ON ${q(tableName)};`,
    description: `Drop policy "${policyName}" from "${tableName}"${why}`,
    kind: "DROP_POLICY",
    severity: "breaking",
    tableName,
  });
}
