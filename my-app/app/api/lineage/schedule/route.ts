import { NextRequest, NextResponse } from "next/server";
import { requireEditor, requireViewer } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import {
  driftSchedulerStatus,
  requestImmediateCheck,
  type SchedulerStatus,
} from "@/lib/drift-scheduler";
import {
  DRIFT_INTERVAL_CHOICES,
  describeCadence,
  isDriftInterval,
  nextDueAt,
  normalizeDriftInterval,
} from "@/lib/drift-schedule";

/**
 * The automatic-checking settings screen, as an API.
 *
 * GET says what the background loop is doing and when each tracked schema is
 * next due; PATCH changes one schema's cadence. Kept apart from
 * /api/lineage/drift, which is about the RESULT of a check — this is about
 * whether and when checks happen at all.
 */

/** One row of the cadence table. */
export type ScheduleRow = {
  trackedSchemaId: number;
  label: string | null;
  schemaName: string;
  connectionName: string;
  intervalMinutes: number;
  /** "every 15m" / "manual only" — the same words the rest of the UI uses. */
  cadence: string;
  /** When a check last ran, ISO. Null when none ever has. */
  lastCheckedAt: string | null;
  /** When the next automatic check is due, ISO. Null when nothing will run. */
  nextDueAt: string | null;
  /** True when the next check is already overdue — or has never happened. */
  due: boolean;
};

export type ScheduleView = {
  scheduler: SchedulerStatus;
  /** The cadences the UI is allowed to offer, so it cannot invent one. */
  choices: ReadonlyArray<{ minutes: number; label: string }>;
  rows: ScheduleRow[];
};

type ScheduleQueryRow = {
  id: number;
  label: string | null;
  schema_name: string;
  connection_name: string;
  drift_check_interval_minutes: number | null;
  last_drift_check_at: string | null;
};

export async function GET() {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  try {
    await syncMetadataTables();
    const result = await pool.query<ScheduleQueryRow>(
      `SELECT ts.id,
              ts.label,
              ts.schema_name,
              c.name AS connection_name,
              ts.drift_check_interval_minutes,
              ts.last_drift_check_at
         FROM tracked_schemas ts
         JOIN connections c ON c.id = ts.connection_id
        ORDER BY ts.id`
    );

    const now = new Date();
    const rows: ScheduleRow[] = result.rows.map((r) => {
      const intervalMinutes = normalizeDriftInterval(r.drift_check_interval_minutes);
      const lastCheckedAt = r.last_drift_check_at ? new Date(r.last_drift_check_at) : null;
      const entry = { trackedSchemaId: r.id, intervalMinutes, lastCheckedAt };
      const next = nextDueAt(entry);
      return {
        trackedSchemaId: r.id,
        label: r.label,
        schemaName: r.schema_name,
        connectionName: r.connection_name,
        intervalMinutes,
        cadence: describeCadence(intervalMinutes),
        lastCheckedAt: lastCheckedAt ? lastCheckedAt.toISOString() : null,
        nextDueAt: next ? next.toISOString() : null,
        // Scheduled and never checked is due now, which is why this is not
        // simply "next <= now" — there is no next to compare against yet.
        due:
          intervalMinutes > 0 && (next === null || next.getTime() <= now.getTime()),
      };
    });

    const view: ScheduleView = {
      scheduler: driftSchedulerStatus(),
      choices: DRIFT_INTERVAL_CHOICES,
      rows,
    };
    return NextResponse.json(view);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Drift schedule — read failed:", message);
    return NextResponse.json(
      { error: "Could not read the checking schedule. Is the app database reachable?" },
      { status: 500 }
    );
  }
}

/**
 * PATCH  { trackedSchemaId, intervalMinutes }
 *
 * Change how often one schema is checked. Editor-gated because the number
 * decides how often this app connects to somebody else's database.
 */
export async function PATCH(request: NextRequest) {
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  let body: { trackedSchemaId?: number; intervalMinutes?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body." }, { status: 400 });
  }

  const trackedSchemaId = Number(body.trackedSchemaId);
  if (!trackedSchemaId) {
    return NextResponse.json({ error: "trackedSchemaId is required." }, { status: 400 });
  }

  const intervalMinutes = Number(body.intervalMinutes);
  // Refuse rather than snap. normalizeDriftInterval exists for values already
  // sitting in the column; a request arriving now can be told it asked for a
  // cadence this app does not offer, which is more useful than silently
  // checking at a different rate than the caller chose.
  if (!Number.isFinite(intervalMinutes) || !isDriftInterval(intervalMinutes)) {
    return NextResponse.json(
      {
        error:
          `"${body.intervalMinutes}" is not one of the available cadences. ` +
          `Choose one of: ${DRIFT_INTERVAL_CHOICES.map((c) => c.minutes).join(", ")}.`,
      },
      { status: 400 }
    );
  }

  try {
    await syncMetadataTables();
    const updated = await pool.query<{ id: number }>(
      `UPDATE tracked_schemas
          SET drift_check_interval_minutes = $2
        WHERE id = $1
      RETURNING id`,
      [trackedSchemaId, intervalMinutes]
    );
    if (updated.rows.length === 0) {
      return NextResponse.json({ error: "Tracked schema not found." }, { status: 404 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Drift schedule — update failed:", message);
    return NextResponse.json(
      { error: "Could not save the cadence. Is the app database reachable?" },
      { status: 500 }
    );
  }

  // Turning automatic checking ON should feel like it started, not like it
  // will start at some point in the next quarter of an hour. Recorded as a
  // scheduled check because that is what it is — the first one — and on_change
  // so that toggling a cadence twice does not put two rows in the audit log.
  if (intervalMinutes > 0) requestImmediateCheck(trackedSchemaId, "scheduled", "on_change");

  return NextResponse.json({
    trackedSchemaId,
    intervalMinutes,
    cadence: describeCadence(intervalMinutes),
    message:
      intervalMinutes === 0
        ? "Automatic checking is off for this schema. Checks still run when you press Check now."
        : `This schema is now checked ${describeCadence(intervalMinutes)}.`,
  });
}
