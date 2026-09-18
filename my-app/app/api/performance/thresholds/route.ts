import { NextRequest, NextResponse } from "next/server";
import { requireEditor, requireViewer } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { getThresholds, saveThresholds } from "@/lib/perf-thresholds-db";
import {
  THRESHOLDS,
  type ThresholdDefinition,
  type ThresholdKey,
  type ThresholdSetting,
} from "@/lib/perf-thresholds";

/**
 * GET  /api/performance/thresholds?connectionId=<id>&schema=<name>
 * PUT  /api/performance/thresholds
 *
 * Spec feature 10 — "Allow custom alert thresholds for performance issues."
 *
 * The GET returns the definitions as well as the values, so the settings screen
 * renders its whole form — labels, units, ranges, help text — from one call and
 * cannot drift from what the server will accept. lib/perf-thresholds.ts is the
 * single definition of both.
 */

export type ThresholdsView = {
  connectionName: string;
  schema: string;
  /** Every key, with a stored value or its suggested one. Never partial. */
  settings: ThresholdSetting[];
  /** What each key means, for the form. Keyed the same as `settings`. */
  definitions: Record<ThresholdKey, ThresholdDefinition>;
};

/** Read and check the two identifiers both verbs need. */
function readTarget(connectionId: unknown, schema: unknown):
  | { ok: true; connectionId: number; schema: string }
  | { ok: false; error: string } {
  const id = Number(connectionId ?? "");
  const name = String(schema ?? "").trim();
  if (!id) return { ok: false, error: "A connectionId is required." };
  if (!name) return { ok: false, error: "A schema is required." };
  return { ok: true, connectionId: id, schema: name };
}

/** The connection's name, or null when there is no such connection. */
async function connectionName(connectionId: number): Promise<string | null> {
  await syncMetadataTables();
  const result = await pool.query<{ name: string }>(
    `SELECT name FROM connections WHERE id = $1`,
    [connectionId]
  );
  return result.rows[0]?.name ?? null;
}

export async function GET(request: NextRequest) {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  const params = request.nextUrl.searchParams;
  const target = readTarget(params.get("connectionId"), params.get("schema"));
  if (!target.ok) return NextResponse.json({ ok: false, error: target.error }, { status: 400 });

  try {
    const name = await connectionName(target.connectionId);
    if (name === null) {
      return NextResponse.json(
        { ok: false, error: `No saved connection found with id ${target.connectionId}.` },
        { status: 404 }
      );
    }
    const view: ThresholdsView = {
      connectionName: name,
      schema: target.schema,
      settings: await getThresholds(target.connectionId, target.schema),
      definitions: THRESHOLDS,
    };
    return NextResponse.json(view);
  } catch (error) {
    console.error("Thresholds — failed to read:", error);
    return NextResponse.json(
      { ok: false, error: "Could not read the alert thresholds. Is the app database reachable?" },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  // Changing what the app alerts on changes what everybody else sees, so this
  // is an editor's action rather than a viewer's — the same line drawn around
  // every other setting that outlives the request.
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  let body: { connectionId?: unknown; schema?: unknown; settings?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "The request body was not JSON." }, { status: 400 });
  }

  const target = readTarget(body.connectionId, body.schema);
  if (!target.ok) return NextResponse.json({ ok: false, error: target.error }, { status: 400 });

  if (!Array.isArray(body.settings)) {
    return NextResponse.json(
      { ok: false, error: "The request needs a settings array." },
      { status: 400 }
    );
  }

  try {
    const name = await connectionName(target.connectionId);
    if (name === null) {
      return NextResponse.json(
        { ok: false, error: `No saved connection found with id ${target.connectionId}.` },
        { status: 404 }
      );
    }

    // saveThresholds validates every row and writes nothing when any of them is
    // wrong, so a rejected form leaves the stored settings exactly as they were.
    const problems = await saveThresholds(
      target.connectionId,
      target.schema,
      body.settings as ThresholdSetting[],
      gate.principal.email
    );
    if (problems.length > 0) {
      return NextResponse.json({ ok: false, error: problems.join(" ") }, { status: 400 });
    }

    // The saved state is read back rather than echoed from the request, so the
    // screen shows what is stored and not what it hoped was stored.
    const view: ThresholdsView = {
      connectionName: name,
      schema: target.schema,
      settings: await getThresholds(target.connectionId, target.schema),
      definitions: THRESHOLDS,
    };
    return NextResponse.json(view);
  } catch (error) {
    console.error("Thresholds — failed to save:", error);
    return NextResponse.json(
      { ok: false, error: "Could not save the alert thresholds. Is the app database reachable?" },
      { status: 500 }
    );
  }
}
