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
 * How each environment is written on screen. `pill` is an existing class from
 * globals.css so the labels look like every other status pill in the app.
 */
export const ENVIRONMENT_META: Record<
  Environment,
  { label: string; pill: string; help: string }
> = {
  unset: {
    label: "Unlabelled",
    pill: "pill-neutral",
    help: "No environment set. Nothing can warn you about this target, so label it.",
  },
  dev: {
    label: "Dev",
    pill: "pill-brand",
    help: "A development database. Safe to rebuild from scratch.",
  },
  staging: {
    label: "Staging",
    pill: "pill-pending",
    help: "A pre-production rehearsal. Treat migrations here as a dry run for prod.",
  },
  prod: {
    label: "Production",
    pill: "pill-break",
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
 * Does this free text read like a production database?
 *
 * Used only to *suggest* a label in the connection drawer — never to write one.
 * Guessing "prod" from a name and saving it silently would make the column a
 * different kind of lie than the one it replaced; the user still confirms.
 */
export function looksLikeProduction(text: string): boolean {
  return /\bprod(uction)?\b/i.test(text ?? "");
}
