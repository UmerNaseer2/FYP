import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { hasPermission } from "@/lib/permissions";
import {
  deleteComparisonSet,
  listComparisonSets,
  saveComparisonSet,
} from "@/lib/comparison-sets";
import { parseSaveBody } from "@/lib/comparison-set-rules";

/**
 * Saved comparison sets — the named "source + targets" selections on /compare.
 *
 * Reading, saving a new set, overwriting one and deleting one are four
 * permissions under Comparison sets. Out of the box viewers may read them
 * and editors may do the rest: a set is what somebody else's finger will
 * click before a migration runs against production, so rewriting one is not
 * everybody's to do.
 *
 * Every method works inside the caller's organization: it sees, saves and
 * deletes only that organization's sets (see lib/comparison-sets.ts).
 */

/** GET /api/comparison-sets — every saved set, with its targets in order. */
export async function GET() {
  const gate = await requirePermission("comparison_sets:read");
  if (!gate.ok) return gate.response;

  try {
    return NextResponse.json({ sets: await listComparisonSets(gate.principal.orgId) });
  } catch (error) {
    console.error("GET comparison sets error:", error);
    return NextResponse.json(
      { error: "Could not read the saved comparison sets." },
      { status: 500 }
    );
  }
}

/**
 * POST /api/comparison-sets — save a set.
 * Body: { id, overwrite, name, sourceConnectionId, sourceConnectionLabel,
 *         sourceSchema, allowDataLoss, compareData, targets: [...] }
 *
 * `id` is the set that was open (null for none). A name that belongs to a
 * different set answers 409 with `conflict: true` until the request is sent
 * again with `overwrite: true` — the screen asks the user in between.
 */
export async function POST(request: NextRequest) {
  const gate = await requirePermission("comparison_sets:create", "comparison_sets:update");
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  try {
    // parseSaveBody never rejects: a missing or mistyped field becomes empty,
    // and the validation inside saveComparisonSet names it in a sentence the
    // person who pressed Save can act on, passed through below as-is.
    //
    // The gate above let in a role with either Create or Update, because
    // which one a save is depends on whether its name is taken, and only
    // saveComparisonSet can tell. It refuses the one the role lacks.
    const result = await saveComparisonSet(gate.principal.orgId, parseSaveBody(body), {
      mayCreate: hasPermission(gate.principal, "comparison_sets:create"),
      mayUpdate: hasPermission(gate.principal, "comparison_sets:update"),
      roleLabel: gate.principal.roleLabel,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, conflict: result.conflict },
        { status: result.conflict ? 409 : result.refused ? 403 : 400 }
      );
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
  const gate = await requirePermission("comparison_sets:delete");
  if (!gate.ok) return gate.response;

  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const id = Number(body?.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "A valid set id is required." }, { status: 400 });
  }

  try {
    const removed = await deleteComparisonSet(gate.principal.orgId, id);
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
