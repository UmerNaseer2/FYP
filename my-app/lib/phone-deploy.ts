/**
 * What a paired phone may start of a deploy or a rollback, by the same rules as
 * the Deploy screen.
 *
 * The Deploy screen (app/[org]/(studio)/deploy/page.tsx) works these out in the
 * browser, from the registry and the ledger, and sends the result. A phone gets
 * no such say. It names a script family and a version, and
 * app/api/deploy/phone/route.ts reads the same registry and ledger and passes
 * them here. So the SQL a phone starts is always what the registry holds, and a
 * phone never supplies any.
 *
 * Every rule below follows the page, and the routes that run the result check
 * them all again. The point of having them here is to tell the person holding
 * the phone the truth before they sign, rather than refuse them afterwards.
 *
 * No database and no network here, so the rules can be tested on their own.
 */
import { checkApplications, readAppliesToHeader, type TargetApplications } from "./application-targeting";
import { readChangeNote } from "./change-note";
import { describeChangeType } from "./change-type";
import { analyseRunRisk, scriptLabel } from "./deploy-risk";
import { planRollback, rollbackTargets, type AppliedRollbackRow, type RollbackTarget } from "./rollback-plan";
import { compareVersions, pendingPrefixThrough } from "./script-status";
import { containsTransactionControl } from "./sql-guard";

/** The fields of a registry script these rules read (app/api/github/pull/route.ts). */
export type RegistryScript = {
  database_name: string;
  schema_name: string;
  script_name: string;
  version: string;
  path: string;
  sql_content: string;
  down_sql?: string | null;
};

/** The fields of POST /api/scripts/preflight these rules read. */
export type LedgerRead = {
  currentVersion: string | null;
  timeline: AppliedRollbackRow[];
  applications: TargetApplications;
  otherScripts: { script_name: string; version: string; applied_at: string | null }[];
};

export type PhoneDeployAction = "deploy" | "revert";

/** One script family a connection could run. */
export type PhoneFamily = {
  schemaName: string;
  scriptName: string;
  newestVersion: string;
  versionCount: number;
};

/** Where a family stands, and what could be done with it. */
export type PhoneFamilyChoices = {
  currentVersion: string | null;
  /** The versions a deploy could go up to, oldest first. */
  waiting: string[];
  /** The versions a rollback could go back to, nearest first. A null target is before the first version. */
  undo: RollbackTarget[];
};

/** Which step comes next for this person, on this run. */
export type PhoneNextStep =
  | "run"
  /** Production, and somebody has approved exactly this run. */
  | "run-approved"
  /** Production, and nobody has been asked yet. */
  | "ask-approval"
  /** Production, and the request for exactly this run has not been decided. */
  | "waiting"
  | "blocked";

/** Why nothing can be done with a run. A phone has its own sentence for each. */
export type PhoneBlockedReason =
  | "nothing-to-do"
  | "transaction-control"
  | "application"
  | "no-rollback"
  | "read-only"
  | "role";

export type PhoneRisks = {
  production: boolean;
  /** "users_migration v2.0.0" labels. */
  breaking: string[];
  dataLoss: string[];
  /** A rollback only: other scripts that ran after what it would undo. */
  otherScripts: string[];
  /** A deploy only: what the last drift check said, when it should give someone pause. */
  drift: "drifted" | "unreachable" | null;
};

/** A run worked out from the registry and the ledger, before asking who may do what. */
export type PhoneRunDraft = {
  /** In the order they run, as approval fingerprints want them. */
  scripts: { scriptName: string; version: string; sqlContent: string }[];
  risks: Omit<PhoneRisks, "production">;
  problem: PhoneBlockedReason | null;
  /** What to POST to run it, without the acknowledgements somebody has to give. */
  run: { path: "/api/scripts/apply" | "/api/scripts/revert"; body: Record<string, unknown> };
  /** What to POST to /api/deploy/approvals to ask for it. */
  approvalRequest: Record<string, unknown>;
};

/** Every family a connection's database has in the registry, by schema and then by name. */
export function listFamilies(scripts: ReadonlyArray<RegistryScript>, databaseName: string): PhoneFamily[] {
  const families = new Map<string, PhoneFamily>();
  for (const script of scripts) {
    if (script.database_name !== databaseName) continue;
    const key = JSON.stringify([script.schema_name, script.script_name]);
    const seen = families.get(key);
    if (seen === undefined) {
      families.set(key, {
        schemaName: script.schema_name,
        scriptName: script.script_name,
        newestVersion: script.version,
        versionCount: 1,
      });
      continue;
    }
    seen.versionCount += 1;
    if (compareVersions(script.version, seen.newestVersion) > 0) seen.newestVersion = script.version;
  }
  return [...families.values()].sort(
    (left, right) =>
      left.schemaName.localeCompare(right.schemaName) || left.scriptName.localeCompare(right.scriptName),
  );
}

/** One family's files in the registry, as this connection's database sees them. */
export function familyFiles(
  scripts: ReadonlyArray<RegistryScript>,
  databaseName: string,
  schemaName: string,
  scriptName: string,
): RegistryScript[] {
  return scripts.filter(
    (script) =>
      script.database_name === databaseName &&
      script.schema_name === schemaName &&
      script.script_name === scriptName,
  );
}

/**
 * The versions above the ledger's current one, oldest first, without those
 * addressed to another application: the only refusal a run may step over,
 * because those scripts are for a database that is not this one.
 */
function pendingScripts(family: ReadonlyArray<RegistryScript>, ledger: LedgerRead): RegistryScript[] {
  const { currentVersion, applications } = ledger;
  return [...family]
    .sort((left, right) => compareVersions(left.version, right.version))
    .filter((script) => currentVersion === null || compareVersions(script.version, currentVersion) > 0)
    .filter((script) => !checkApplications(readAppliesToHeader(script.sql_content), applications).addressedElsewhere);
}

function appliedNewestFirst(ledger: LedgerRead): string[] {
  return ledger.timeline.map((row) => row.version).sort((left, right) => compareVersions(right, left));
}

export function familyChoices(family: ReadonlyArray<RegistryScript>, ledger: LedgerRead): PhoneFamilyChoices {
  return {
    currentVersion: ledger.currentVersion,
    waiting: pendingScripts(family, ledger).map((script) => script.version),
    undo: rollbackTargets(appliedNewestFirst(ledger)),
  };
}

/** The level a script is recorded with: its own stamp when it has one, its SQL's grade otherwise. */
function changeTypeOf(sql: string) {
  return describeChangeType(sql).recorded;
}

type Target = { connectionId: number; schemaName: string; scriptName: string; targetVersion: string | null };

/** A deploy up to a version: every waiting version through it, oldest first. */
export function draftDeploy(
  { connectionId, schemaName, scriptName, targetVersion }: Target,
  family: ReadonlyArray<RegistryScript>,
  ledger: LedgerRead,
  driftStatus: string | null,
): PhoneRunDraft {
  const queue = pendingPrefixThrough(pendingScripts(family, ledger), targetVersion);
  const risk = analyseRunRisk(
    queue.map((script) => ({
      scriptName: script.script_name,
      version: script.version,
      sqlContent: script.sql_content,
      changeType: changeTypeOf(script.sql_content),
    })),
  );
  let problem: PhoneBlockedReason | null = null;
  if (queue.length === 0) {
    problem = "nothing-to-do";
  } else if (queue.some((script) => containsTransactionControl(script.sql_content))) {
    problem = "transaction-control";
  } else if (
    queue.some((script) => !checkApplications(readAppliesToHeader(script.sql_content), ledger.applications).allowed)
  ) {
    problem = "application";
  }
  return {
    scripts: queue.map((script) => ({
      scriptName: script.script_name,
      version: script.version,
      sqlContent: script.sql_content,
    })),
    risks: {
      breaking: risk.breaking.map((entry) => entry.label),
      dataLoss: risk.dataLoss.map((entry) => entry.label),
      otherScripts: [],
      // The apply route's rule, read from the same stored status it reads.
      drift: driftStatus === "drifted" || driftStatus === "unreachable" ? driftStatus : null,
    },
    problem,
    run: {
      path: "/api/scripts/apply",
      body: {
        connectionId,
        schemaName,
        dryRun: false,
        scripts: queue.map((script) => ({
          script_name: script.script_name,
          sql_content: script.sql_content,
          version: script.version,
          title: script.script_name,
          description: readChangeNote(script.sql_content) ?? undefined,
          change_type: changeTypeOf(script.sql_content),
          source_ref: script.path,
          ...(script.down_sql ? { down_sql: script.down_sql } : {}),
        })),
      },
    },
    approvalRequest: {
      action: "deploy",
      connectionId,
      schemaName,
      scriptName,
      targetVersion,
      scripts: queue.map((script) => ({
        script_name: script.script_name,
        version: script.version,
        sql_content: script.sql_content,
        change_type: changeTypeOf(script.sql_content),
      })),
    },
  };
}

/** A rollback to a version, or before the first with a null target: every applied version above it, newest first. */
export function draftRollback(
  { connectionId, schemaName, scriptName, targetVersion }: Target,
  family: ReadonlyArray<RegistryScript>,
  ledger: LedgerRead,
): PhoneRunDraft {
  const offered = rollbackTargets(appliedNewestFirst(ledger)).some(({ target }) => target === targetVersion);
  const steps = offered ? planRollback(ledger.timeline, family, targetVersion) : [];
  const scripts = steps.map((step) => ({
    scriptName,
    version: step.version,
    sqlContent: "sql" in step.resolved ? step.resolved.sql : "",
  }));
  const oldest = steps[steps.length - 1];
  const from = oldest?.appliedAt ? new Date(oldest.appliedAt).getTime() : Number.NaN;
  const others = ledger.otherScripts.filter(
    (other) => Number.isNaN(from) || !other.applied_at || new Date(other.applied_at).getTime() >= from,
  );

  let problem: PhoneBlockedReason | null = null;
  if (steps.length === 0) problem = "nothing-to-do";
  else if (steps.some((step) => "problem" in step.resolved)) problem = "no-rollback";

  return {
    scripts,
    risks: {
      breaking: [],
      dataLoss: analyseRunRisk(scripts).dataLoss.map((entry) => entry.label),
      otherScripts: others.map((other) => scriptLabel(other.script_name, other.version)),
      drift: null,
    },
    problem,
    run: {
      path: "/api/scripts/revert",
      body: {
        connectionId,
        schemaName,
        script_name: scriptName,
        versions: steps.map((step) => step.version),
        registryRollbacks: steps.flatMap((step) =>
          "sql" in step.resolved && step.resolved.source === "registry"
            ? [{ version: step.version, down_sql: step.resolved.sql }]
            : [],
        ),
        dryRun: false,
      },
    },
    approvalRequest: {
      action: "revert",
      connectionId,
      schemaName,
      scriptName,
      // The oldest version it undoes, as the Deploy screen asks for it.
      targetVersion: oldest?.version ?? null,
      scripts: scripts.map((script) => ({
        script_name: scriptName,
        version: script.version,
        sql_content: script.sqlContent,
      })),
    },
  };
}

/**
 * What this person can do next with a run.
 *
 * Asking needs no acknowledgements and no right to run, because a request
 * changes nothing but a row in the queue. The one difference from the Deploy
 * screen: a connection nobody may run on blocks asking too. An approval could
 * never be spent there, and a phone should say so rather than send a request
 * that can go nowhere.
 */
export function nextStep(
  problem: PhoneBlockedReason | null,
  who: {
    production: boolean;
    /** The request for exactly this run, when there is one. */
    approval: "approved" | "pending" | null;
    readOnly: boolean;
    mayRun: boolean;
    mayAsk: boolean;
  },
): { next: PhoneNextStep; blockedReason: PhoneBlockedReason | null } {
  const blocked = (blockedReason: PhoneBlockedReason) => ({ next: "blocked" as const, blockedReason });
  if (problem !== null) return blocked(problem);
  if (who.readOnly) return blocked("read-only");
  if (!who.production) return who.mayRun ? { next: "run", blockedReason: null } : blocked("role");
  if (who.approval === "approved") return who.mayRun ? { next: "run-approved", blockedReason: null } : blocked("role");
  if (who.approval === "pending") return { next: "waiting", blockedReason: null };
  return who.mayAsk ? { next: "ask-approval", blockedReason: null } : blocked("role");
}
