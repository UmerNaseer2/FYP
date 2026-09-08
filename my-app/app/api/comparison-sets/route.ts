import { NextRequest, NextResponse } from "next/server";
import { requireEditor, requireViewer } from "@/lib/auth-guard";
import {
  deleteComparisonSet,
  listComparisonSets,
  saveComparisonSet,
  type SaveComparisonSetInput,
} from "@/lib/comparison-sets";

/**
 * Saved comparison sets — the named "source + targets" selections on /compare.
 *
 * Reading a set is a viewer action: it is a selection, not a change to any
 * database. Saving and deleting need editor, matching every other write in this
 * app — a set is what somebody else's finger will click before a migration runs
 * against production, so it is not a viewer's to rewrite.
 */

/** Pull one target out of an untrusted JSON body without trusting any of it. */
function parseTarget(value: unknown): SaveComparisonSetInput["targets"][number] | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const connectionId = Number(raw.connectionId);
  const schema = String(raw.schema ?? "").trim();
  if (!Number.isInteger(connectionId) || connectionId <= 0) return null;
  if (schema.length === 0) return null;
  return {
    connectionId,
    connectionLabel: String(raw.connectionLabel ?? "").slice(0, 200),
    schema,
  };
}

/** GET /api/comparison-sets — every saved set, with its targets in order. */
export async function GET() {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  try {
    return NextResponse.json({ sets: await listComparisonSets() });
  } catch (error) {
    console.error("GET comparison sets error:", error);
    return NextResponse.json(
      { error: "Could not read the saved comparison sets." },
      { status: 500 }
    );
  }
}

/**
 * POST /api/comparison-sets — save a set, replacing one of the same name.
 * Body: { name, sourceConnectionId, sourceSchema, allowDataLoss, targets: [...] }
 */
export async function POST(request: NextRequest) {
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const rawTargets = Array.isArray(body.targets) ? body.targets : [];
  const targets = rawTargets.map(parseTarget);
  if (targets.some((target) => target === null)) {
    return NextResponse.json(
      { error: "Every target needs a saved connection and a schema." },
      { status: 400 }
    );
  }

  const input: SaveComparisonSetInput = {
    name: String(body.name ?? ""),
    sourceConnectionId: Number(body.sourceConnectionId),
    sourceConnectionLabel: String(body.sourceConnectionLabel ?? "").slice(0, 200),
    sourceSchema: String(body.sourceSchema ?? ""),
    allowDataLoss: body.allowDataLoss === true,
    targets: targets as SaveComparisonSetInput["targets"],
  };

  try {
    const result = await saveComparisonSet(input);
    // The validation messages are written for the person who pressed Save, so
    // they are passed through as-is rather than replaced with "Bad request".
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ success: true, set: result.set, created: result.created });
  } catch (error) {
    console.error("POST comparison set error:", error);
    return NextResponse.json(
      { error: "Could not save that comparison set." },
      { status: 500 }
    );
  }
}

/** DELETE /api/comparison-sets — remove a set. Body: { id }. */
export async function DELETE(request: NextRequest) {
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "A valid set id is required." }, { status: 400 });
  }

  try {
    const removed = await deleteComparisonSet(id);
    if (!removed) {
      return NextResponse.json({ error: "No such comparison set." }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE comparison set error:", error);
    return NextResponse.json(
      { error: "Could not delete that comparison set." },
      { status: 500 }
    );
  }
}
