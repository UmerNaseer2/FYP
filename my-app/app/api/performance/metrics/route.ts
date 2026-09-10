import { NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { readSchemaMetrics, METRIC_RETENTION_DAYS } from "@/lib/schema-metrics";
import { normalizeDriftInterval } from "@/lib/drift-schedule";
import type { MetricSample } from "@/lib/metrics-series";

/**
 * GET /api/performance/metrics?connectionId=<id>&schema=<name>&days=<n>
 *
 * Spec feature 10 — performance monitoring.
 *
 * The history this returns is not gathered on request. Readings are written by
 * the drift check (lib/schema-metrics), so a schema has a history exactly when
 * the app has been watching it, and the honest answer for anything else is "not
 * tracked" rather than an empty chart. An empty chart says "nothing happened";
 * "not tracked" says "nobody was looking", and those are different facts.
 *
 * The other two Performance tabs answer their question from the live database
 * the moment you ask. This one cannot: a trend is the one thing that has to
 * have been collected in advance. That is why the response carries the tracking
 * state rather than only the numbers — the screen has to be able to explain why
 * it is empty, and offer the thing that would fill it.
 */

/** The tracked schema behind the chosen connection + schema, if there is one. */
export type MetricsTracking = {
  trackedSchemaId: number;
  label: string | null;
  /** Minutes between automatic checks; 0 means manual checks only. */
  intervalMinutes: number;
  /** When a check last ran, ISO. Null when none ever has. */
  lastCheckedAt: string | null;
};

export type MetricsView = {
  connectionName: string;
  schema: string;
  /** Null when this connection + schema is not tracked — see the note above. */
  tracking: MetricsTracking | null;
  /** How many days of history were asked for. */
  days: number;
  /** How long a reading is kept before it is pruned. */
  retentionDays: number;
  /** Readings inside the window, oldest first. Empty is a real answer. */
  samples: MetricSample[];
};

/** Windows the screen offers. Anything else is rounded into one of these. */
const WINDOWS = [1, 7, 30, 90];
const DEFAULT_WINDOW = 7;

/**
 * Snap a requested window onto one the screen has a button for.
 *
 * A free-form `days` would let a URL ask for 4,000 days of history and get a
 * query that scans the whole table to return the same ninety days the retention
 * window holds. Snapping keeps the answer and the button in agreement.
 */
function windowDays(raw: string | null): number {
  const asked = Number(raw ?? "");
  if (!Number.isFinite(asked) || asked <= 0) return DEFAULT_WINDOW;
  return WINDOWS.find((w) => w >= asked) ?? WINDOWS[WINDOWS.length - 1];
}

export async function GET(request: NextRequest) {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  const connectionId = Number(request.nextUrl.searchParams.get("connectionId") ?? "");
  const schema = (request.nextUrl.searchParams.get("schema") ?? "").trim();
  const days = windowDays(request.nextUrl.searchParams.get("days"));

  if (!connectionId) {
    return NextResponse.json(
      { error: "A connectionId query parameter is required." },
      { status: 400 }
    );
  }
  if (!schema) {
    return NextResponse.json(
      { error: "A schema query parameter is required." },
      { status: 400 }
    );
  }

  let connectionName: string;
  let tracking: MetricsTracking | null;
  try {
    await syncMetadataTables();

    const conn = await pool.query<{ name: string; type: string }>(
      `SELECT name, type FROM connections WHERE id = $1`,
      [connectionId]
    );
    if (conn.rows.length === 0) {
      return NextResponse.json(
        { error: `No saved connection found with id ${connectionId}.` },
        { status: 404 }
      );
    }
    if (conn.rows[0].type !== "PostgreSQL") {
      return NextResponse.json(
        { error: "Monitoring is only available for PostgreSQL connections." },
        { status: 400 }
      );
    }
    connectionName = conn.rows[0].name;

    const tracked = await pool.query<{
      id: number;
      label: string | null;
      drift_check_interval_minutes: number | null;
      last_drift_check_at: string | Date | null;
    }>(
      `SELECT id, label, drift_check_interval_minutes, last_drift_check_at
         FROM tracked_schemas
        WHERE connection_id = $1 AND schema_name = $2`,
      [connectionId, schema]
    );
    const row = tracked.rows[0];
    tracking = row
      ? {
          trackedSchemaId: row.id,
          label: row.label,
          intervalMinutes: normalizeDriftInterval(row.drift_check_interval_minutes),
          lastCheckedAt: row.last_drift_check_at
            ? new Date(row.last_drift_check_at).toISOString()
            : null,
        }
      : null;
  } catch (error) {
    console.error("Monitoring — failed to read tracking metadata:", error);
    return NextResponse.json(
      { error: "Could not read the app database. Is it reachable?" },
      { status: 500 }
    );
  }

  // Not tracked is a complete answer, not an error: the screen turns it into
  // "nothing is watching this yet" plus the link that starts it.
  if (!tracking) {
    const view: MetricsView = {
      connectionName,
      schema,
      tracking: null,
      days,
      retentionDays: METRIC_RETENTION_DAYS,
      samples: [],
    };
    return NextResponse.json(view);
  }

  let samples: MetricSample[];
  try {
    samples = await readSchemaMetrics(tracking.trackedSchemaId, days);
  } catch (error) {
    console.error("Monitoring — failed to read readings:", error);
    return NextResponse.json(
      { error: "Could not read the monitoring history for this schema." },
      { status: 500 }
    );
  }

  const view: MetricsView = {
    connectionName,
    schema,
    tracking,
    days,
    retentionDays: METRIC_RETENTION_DAYS,
    samples,
  };
  return NextResponse.json(view);
}
