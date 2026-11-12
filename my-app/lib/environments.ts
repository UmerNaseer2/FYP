/**
 * Deployment environments — the typed label on a connection. A tracked schema
 * has no label of its own: it reads its connection's.
 *
 * Before this existed, "which environment is this?" lived only in a free-text
 * name ("Staging — Neon", "Prod — RDS"). That reads fine to a human and is
 * invisible to code: nothing could filter by it, group by it, or refuse to
 * generate a destructive migration because the target happened to be
 * production. This module is the single definition both databases and both
 * screens agree on.
 *
 * `unset` is a real member rather than a NULL so the column can be NOT NULL and
 * every query, filter and group can treat it like any other value. A label is
 * optional: an unlabelled target is treated like any database that is not
 * production, and the screens show nothing for it.
 *
 * Only production asks anything of you. Outside it, warnings are just warnings.
 */

export const ENVIRONMENTS = ["unset", "dev", "staging", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const DEFAULT_ENVIRONMENT: Environment = "unset";

/**
 * How each environment is written on screen. `tone` is a subset of the design
 * system's PillTone, spelled out here rather than imported so this module stays
 * plain data that a route handler or a DDL helper can pull in without dragging
 * a React component along with it.
 */
export const ENVIRONMENT_META: Record<
  Environment,
  { label: string; tone: "neutral" | "brand" | "pending" | "break"; help: string }
> = {
  unset: {
    label: "No label",
    tone: "neutral",
    help: "No label. Optional: only Production changes how the app behaves.",
  },
  dev: {
    label: "Dev",
    tone: "brand",
    help: "A development database.",
  },
  staging: {
    label: "Staging",
    tone: "pending",
    help: "A pre-production copy.",
  },
  prod: {
    label: "Production",
    tone: "break",
    help: "Live data. Runs here ask for one confirmation first.",
  },
};

/** Narrow anything off the wire or out of an old row to a known environment. */
export function toEnvironment(value: unknown): Environment {
  const raw = String(value ?? "").trim().toLowerCase();
  return (ENVIRONMENTS as readonly string[]).includes(raw)
    ? (raw as Environment)
    : DEFAULT_ENVIRONMENT;
}

/** True for the one environment where a mistake is not recoverable. */
export function isProduction(environment: Environment): boolean {
  return environment === "prod";
}

/** Display order for grouped lists: riskiest last, unlabelled first. */
export function environmentRank(environment: Environment): number {
  return ENVIRONMENTS.indexOf(environment);
}

/**
 * Why a run against this target must be refused, or null when it may proceed.
 *
 * Production asks for one tick, checked here on the server as well as on the
 * screen, because the routes are reachable directly. Nothing else does.
 */
export function productionBlockReason(
  environment: Environment,
  acknowledged: boolean
): string | null {
  if (!isProduction(environment) || acknowledged) return null;
  return (
    "This target is labelled production and the run was not confirmed. " +
    "Tick the production box and run it again."
  );
}

/**
 * Whether a risk found in a run (a breaking change, deleted rows, drift, other
 * scripts applied since) needs a tick before it runs. Only on production;
 * everywhere else the screen shows the warning and lets you get on with it.
 */
export function risksNeedTicks(environment: Environment): boolean {
  return isProduction(environment);
}

/**
 * Whether a run needs someone's approval first: a real run (not a dry run) on
 * production, in an organization whose two-person rule is on. With the rule
 * off, production asks for the one tick and nothing more.
 */
export function needsApproval(
  environment: Environment,
  approvalsOn: boolean,
  dryRun = false
): boolean {
  return isProduction(environment) && approvalsOn && !dryRun;
}

/**
 * Does this free text read like a production database?
 *
 * Used only to *suggest* a label in the connection drawer — never to write one.
 * Guessing "prod" from a name and saving it silently would make the column a
 * different kind of lie than the one it replaced; the user still confirms.
 */
export function looksLikeProduction(text: string): boolean {
  return /\bprod(uction)?\b/i.test(text ?? "");
}
