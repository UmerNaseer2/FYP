import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import {
  listTrackedSchemas,
  type TrackedSchemaListItem,
} from "@/lib/lineage-db";
import { ENVIRONMENTS, toEnvironment } from "@/lib/environments";
import { hasPermission } from "@/lib/permissions";
import {
  UNLABEL_PRODUCTION_PERMISSION,
  lowersProduction,
  unlabelRefusal,
} from "@/lib/environment-guard";

// Re-export so existing callers can keep importing the list item type from here.
export type { TrackedSchemaListItem };

/**
 * GET /api/lineage — list every tracked schema in the caller's organization
 * with its lineage HEAD + drift.
 */
export async function GET() {
  const gate = await requirePermission("drift:read", "dashboard:read");
  if (!gate.ok) return gate.response;

  try {
    const items = await listTrackedSchemas(gate.principal.orgId);
    return NextResponse.json(items);
  } catch (error) {
    // This used to answer `[]` with a 200. A dashboard showing "nothing tracked
    // yet" when the metadata database is unreachable is worse than an error —
    // it invites you to track a schema that is already tracked, and it hides
    // every drift warning you actually needed to see.
    console.error("GET lineage error:", error);
    return NextResponse.json(
      { error: "Could not read your tracked schemas. Is the app database reachable?" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/lineage — relabel a tracked schema's environment.
 * Body: { id: number, environment: "unset" | "dev" | "staging" | "prod" }
 *
 * The environment is inherited from the connection when tracking starts, but
 * it has to be changeable afterwards: a schema gets promoted, a server gets
 * repurposed, and every row that existed before the column did arrived as
 * "unset". A label nobody can correct is a label nobody will trust.
 *
 * Unlike the tracking route this rejects an unknown value rather than quietly
 * narrowing it — the caller here is a deliberate edit, and silently writing
 * "unset" because of a typo would be the same lie the free-text name was.
 */
export async function PATCH(request: NextRequest) {
  const gate = await requirePermission("drift:update");
  if (!gate.ok) return gate.response;

  try {
    await syncMetadataTables();

    const body = await request.json().catch(() => ({}));
    const id = Number(body.id);
    if (!id) {
      return NextResponse.json(
        { error: "A tracked-schema id is required." },
        { status: 400 }
      );
    }

    const raw = String(body.environment ?? "").trim().toLowerCase();
    if (!(ENVIRONMENTS as readonly string[]).includes(raw)) {
      return NextResponse.json(
        { error: `Environment must be one of: ${ENVIRONMENTS.join(", ")}.` },
        { status: 400 }
      );
    }
    const environment = toEnvironment(raw);

    // Taking the Production label off needs the permission that gives
    // approvals, the same rule as a connection's label (lib/environment-guard).
    // Asked only when the caller lacks it, so an Admin's edit costs no extra
    // read. A schema that is not tracked falls through to the 404 below.
    if (!hasPermission(gate.principal, UNLABEL_PRODUCTION_PERMISSION)) {
      const current = await pool.query<{ schema_name: string; environment: string }>(
        `SELECT schema_name, environment FROM tracked_schemas WHERE id = $1 AND org_id = $2`,
        [id, gate.principal.orgId]
      );
      const row = current.rows?.[0];
      if (row && lowersProduction(toEnvironment(row.environment), environment)) {
        return NextResponse.json(
          { error: unlabelRefusal(`schema "${row.schema_name}"`) },
          { status: 403 }
        );
      }
    }

    // Another organization's schema reads as not tracked, the same answer an
    // untracked one gets, so this cannot be used to learn which ids exist.
    const result = await pool.query<{ id: number; environment: string }>(
      `UPDATE tracked_schemas SET environment = $1 WHERE id = $2 AND org_id = $3
       RETURNING id, environment`,
      [environment, id, gate.principal.orgId]
    );
    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: "That schema is not tracked." },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, environment });
  } catch (error) {
    console.error("PATCH lineage error:", error);
    return NextResponse.json(
      { error: "Failed to change this schema's environment." },
      { status: 500 }
    );
  }
}

/** DELETE /api/lineage — stop tracking a schema (cascades snapshots/lineage/drift). */
export async function DELETE(request: NextRequest) {
  const gate = await requirePermission("drift:delete");
  if (!gate.ok) return gate.response;

  try {
    await syncMetadataTables();

    const body = await request.json().catch(() => ({}));
    const id = Number(body.id);
    if (!id) {
      return NextResponse.json(
        { error: "A tracked-schema id is required." },
        { status: 400 }
      );
    }

    // Only inside the caller's organization. Another organization's id deletes
    // nothing and answers the same success an already-untracked one does.
    await pool.query("DELETE FROM tracked_schemas WHERE id = $1 AND org_id = $2", [
      id,
      gate.principal.orgId,
    ]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE lineage error:", error);
    return NextResponse.json(
      { error: "Failed to stop tracking this schema." },
      { status: 500 }
    );
  }
}
