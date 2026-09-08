/**
 * Deployment environments — the typed label on a connection and on a tracked
 * schema.
 *
 * Before this existed, "which environment is this?" lived only in a free-text
 * name ("Staging — Neon", "Prod — RDS"). That reads fine to a human and is
 * invisible to code: nothing could filter by it, group by it, or refuse to
 * generate a destructive migration because the target happened to be
 * production. This module is the single definition both databases and both
 * screens agree on.
 *
 * `unset` is a real member rather than a NULL so the column can be NOT NULL and
 * every query, filter and group can treat it like any other value. It also says
 * something honest: nobody has labelled this target yet, so we must not pretend
 * it is safe.
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
    label: "Unlabelled",
    tone: "neutral",
    help: "No environment set. Nothing can warn you about this target, so label it.",
  },
  dev: {
    label: "Dev",
    tone: "brand",
    help: "A development database. Safe to rebuild from scratch.",
  },
  staging: {
    label: "Staging",
    tone: "pending",
    help: "A pre-production rehearsal. Treat migrations here as a dry run for prod.",
  },
  prod: {
    label: "Production",
    tone: "break",
    help: "Live data. Every destructive change here is announced loudly before it runs.",
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
 * The louder of two labels.
 *
 * A target has up to two: the connection's (a property of the whole database)
 * and the tracked schema's (set when it was tracked, editable since). They can
 * disagree. We take the louder, because a warning that turns out to be
 * over-cautious costs a moment's attention and a missing one costs data.
 * "unset" ranks lowest, so an unlabelled schema on a production connection
 * still reads as production.
 */
export function louderEnvironment(a: Environment, b: Environment): Environment {
  return environmentRank(a) >= environmentRank(b) ? a : b;
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
