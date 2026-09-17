import pool from "./version-db";
import {
  computeDriftDetail,
  type DriftCounts,
  type DriftStatus,
  type ExpectedRef,
} from "./lineage-db";
import { recordSchemaMetrics } from "./schema-metrics";
import { driftFingerprint } from "./drift-fingerprint";
import type { CompareReport } from "./compare-types";
import type { DriftSource } from "./drift-source";

/**
 * Run one drift check and write it down.
 *
 * There used to be one caller of `computeDriftDetail` that also recorded the
 * result — the POST on /api/lineage/drift — and the recording was inline in the
 * route. Now the scheduler runs the same check with no request behind it, and
 * the tracking route runs it once as soon as a schema is tracked, so the "check
 * it, then record it" pair has to live somewhere all three can reach. Putting a
 * copy in each would be three chances for the audit feed to disagree with
 * itself about what a check is.
 *
 * Deliberately NOT an API route calling itself over HTTP: the scheduler has no
 * request, no session and no idea what URL it is served on, and a background job
 * that depends on the app being reachable from inside itself is a job that
 * silently stops working the first time it is deployed behind a proxy.
 */

/** A check that ran, whatever it found. */
export type DriftRun = {
  trackedSchemaId: number;
  status: DriftStatus;
  summary: string;
  counts: DriftCounts | null;
  report: CompareReport | null;
  expected: ExpectedRef;
  /** ISO time the check finished — what the audit row will show. */
  checkedAt: string;
  /**
   * Whether this check left a row in the audit feed.
   *
   * False has two harmless meanings: a scheduled check that found exactly what
   * the last one did and was deliberately not written down (see
   * DriftRecordMode), or a metadata database that went away between reading and
   * writing. Either way the check itself succeeded and the result is good —
   * losing an audit row is not worth failing a user's button press over.
   */
  recorded: boolean;
};

/**
 * Whether this check deserves a permanent row in the audit feed.
 *
 * "always" is what a person gets: they pressed a button and the record is the
 * answer to "did I check this?". "on_change" is what the scheduler gets — a
 * check every fifteen minutes that says "still fine" would push a day of real
 * events off the end of the feed within hours, and the fact that we looked is
 * already recorded on tracked_schemas.last_drift_check_at.
 */
export type DriftRecordMode = "always" | "on_change";

/** A check that could not run, and why — never an exception. */
export type DriftRunProblem =
  | { kind: "not_found" }
  | { kind: "no_baseline" }
  | { kind: "failed"; message: string };

export type DriftRunResult =
  | { ok: true; run: DriftRun }
  | { ok: false; problem: DriftRunProblem };

/**
 * Check one tracked schema and record the outcome.
 *
 * `source` is written to the row so the audit feed can tell an automatic check
 * from a person pressing the button — which is the whole question a user asks
 * when the app claims to be watching a schema for them.
 */
export async function runDriftCheck(
  trackedSchemaId: number,
  source: DriftSource,
  mode: DriftRecordMode = "always"
): Promise<DriftRunResult> {
  // Every path out of here stamps the check time, including the ones that found
  // nothing to check. The schedule is driven by when a schema was last LOOKED
  // at, not by whether the look succeeded, and the scheduler takes the six most
  // overdue schemas a minute: a schema that never gets stamped stays the most
  // overdue there is and is picked again on the very next tick, forever. Six of
  // them fill every tick and no other schema is ever checked. Stamping costs a
  // broken schema one delayed retry; not stamping costs every other schema its
  // check. (An unreachable database already came through the success path below
  // and got its stamp, which is why the symptom only ever showed up here.)
  let comp;
  try {
    comp = await computeDriftDetail(trackedSchemaId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await stampLastChecked(trackedSchemaId);
    return { ok: false, problem: { kind: "failed", message } };
  }

  if (comp.kind === "not_found") {
    // The row is gone, so the UPDATE matches nothing and does nothing — kept
    // for the next case, which looks identical from here and is not harmless.
    await stampLastChecked(trackedSchemaId);
    return { ok: false, problem: { kind: "not_found" } };
  }
  if (comp.kind === "no_baseline") {
    // A tracked schema with no baseline is the one to worry about: it is not a
    // transient failure, so without the stamp it sits at the front of the queue
    // until somebody notices the rest of the schedule has stopped.
    await stampLastChecked(trackedSchemaId);
    return { ok: false, problem: { kind: "no_baseline" } };
  }

  const status: DriftStatus = comp.kind === "unreachable" ? "unreachable" : comp.status;
  const counts = comp.kind === "ok" ? comp.counts : null;
  const report = comp.kind === "ok" ? comp.report : null;

  // Order matters: stamp the check first, so a schema whose event row is
  // suppressed below still stops looking overdue. If the stamp fails the row is
  // still written — a duplicated event is better than a schema that silently
  // stops being checked.
  await stampLastChecked(trackedSchemaId);

  // Spec feature 10 — one reading per check, whatever the check found and
  // whether or not the audit row below is suppressed. The audit feed answers
  // "what changed"; this answers "what did it look like", and a series with
  // points only on the days something changed is not a series.
  if (comp.kind === "ok") {
    await recordSchemaMetrics({
      trackedSchemaId,
      live: comp.live,
      drifted: status === "drifted",
    });
  }

  // Which differences were found, as one short string — null when there was no
  // comparison to fingerprint, which is every unreachable database.
  const fingerprint = report ? driftFingerprint(report) : null;

  const worthRecording =
    mode === "always" || (await outcomeChanged(trackedSchemaId, status, fingerprint));
  const recorded = worthRecording
    ? await recordDriftEvent({
        trackedSchemaId,
        status,
        summary: comp.summary,
        counts,
        baselineSnapshotId: comp.expected.snapshotId,
        source,
        fingerprint,
      })
    : false;

  return {
    ok: true,
    run: {
      trackedSchemaId,
      status,
      summary: comp.summary,
      counts,
      report,
      expected: comp.expected,
      checkedAt: new Date().toISOString(),
      recorded,
    },
  };
}

/**
 * Record that a check ran, whatever it found.
 *
 * Best-effort like the event insert: the user already has their answer, and a
 * missing stamp only costs one early re-check.
 */
async function stampLastChecked(trackedSchemaId: number): Promise<void> {
  try {
    await pool.query(
      `UPDATE tracked_schemas SET last_drift_check_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [trackedSchemaId]
    );
  } catch (error) {
    console.error("Drift — failed to stamp last_drift_check_at:", error);
  }
}

/**
 * Whether this outcome says something the newest recorded event does not.
 *
 * Two things are compared, not one. The status on its own answers "is this
 * schema drifted?", which stops being news the moment it first drifts: a schema
 * that is already "drifted" and then loses a whole table is still "drifted", so
 * on the scheduler's "on_change" setting nothing was written and the audit feed
 * ended at the first change — the one thing the feed exists to show.
 *
 * The fingerprint answers the other half, "drifted HOW?", so a second change
 * inside an already-drifted schema is a different answer and gets its own row.
 *
 * The two null cases pull in opposite directions and are deliberately not
 * folded together. A check with no fingerprint had no comparison behind it —
 * an unreachable database — and there is nothing to compare beyond the status,
 * so it falls back to the old behaviour and stays quiet; treating that as
 * "cannot tell, record it" would refill the feed every fifteen minutes for as
 * long as the database stayed down. A previous row with no fingerprint is a row
 * written before this existed, or by a deploy, and recording once against it
 * costs one row and leaves a fingerprint behind for next time to match.
 *
 * Errs towards recording otherwise: if the previous row cannot be read, the row
 * is written. A duplicated "in sync" is noise; a missed change is a bug.
 */
async function outcomeChanged(
  trackedSchemaId: number,
  status: DriftStatus,
  fingerprint: string | null
): Promise<boolean> {
  try {
    const previous = await pool.query<{ status: string; fingerprint: string | null }>(
      `SELECT status, fingerprint FROM drift_events
        WHERE tracked_schema_id = $1
        ORDER BY detected_at DESC, id DESC
        LIMIT 1`,
      [trackedSchemaId]
    );
    if (previous.rows.length === 0) return true;
    if (previous.rows[0].status !== status) return true;
    // Same status, and nothing was compared this time — the status is all there
    // is to go on and it has not moved.
    if (fingerprint === null) return false;
    // Same status, and the row to compare against has no fingerprint: record
    // once, which also leaves one for the next check to match against.
    if (previous.rows[0].fingerprint === null) return true;
    return previous.rows[0].fingerprint !== fingerprint;
  } catch (error) {
    console.error("Drift — could not read the previous outcome:", error);
    return true;
  }
}

/** What one audit row needs. Exported so the deploy and re-baseline paths share it. */
export type DriftEventRecord = {
  trackedSchemaId: number;
  status: DriftStatus;
  summary: string | null;
  counts: DriftCounts | null;
  baselineSnapshotId: number | null;
  source: DriftSource;
  /**
   * Which differences this row is about — see lib/drift-fingerprint.ts.
   *
   * Optional because the callers outside this file (a deploy, a re-baseline)
   * are recording that something happened, not the result of a comparison.
   * Leaving it null is correct there: the next scheduled check will not match
   * it, so the first real drift after a deploy is always recorded.
   */
  fingerprint?: string | null;
};

/**
 * Write one drift_events row. Returns whether it landed rather than throwing.
 *
 * Every caller is in the same position: the interesting work already succeeded
 * and the audit row is a side effect. A failure here is worth a server log and
 * nothing more — it must never turn a successful check into an error on screen.
 */
export async function recordDriftEvent(record: DriftEventRecord): Promise<boolean> {
  try {
    await pool.query(
      `INSERT INTO drift_events
         (tracked_schema_id, status, summary, detail, baseline_snapshot_id, source,
          fingerprint)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [
        record.trackedSchemaId,
        record.status,
        record.summary,
        record.counts ? JSON.stringify(record.counts) : null,
        record.baselineSnapshotId,
        record.source,
        record.fingerprint ?? null,
      ]
    );
    return true;
  } catch (error) {
    console.error("Drift — failed to record drift_event:", error);
    return false;
  }
}
