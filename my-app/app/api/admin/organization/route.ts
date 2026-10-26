import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { cleanOrgName, orgNameProblem } from "@/lib/new-organization";
import { deleteOrganization, updateOrganization } from "@/lib/orgs-db";

/**
 * The caller's organization itself, from the Organization tab on the Admin
 * screen. All three need an Organization box, which only the admin role has
 * (lib/permissions.ts), so nobody can rename, loosen or delete an
 * organization from a role an Admin made.
 *
 * GET says its name, its address and whether its two-person rule is on.
 *
 * PATCH renames it, switches the rule, or both. The address stays as it is
 * (see updateOrganization in lib/orgs-db.ts). Each change goes in the change
 * log on the Roles & permissions tab.
 *
 * DELETE deletes it and everything it owns, once the body's `confirm` is its
 * name exactly as it is now. It is refused in two places:
 *
 * - The desktop app, which keeps one organization of its own and has nowhere
 *   else to go.
 * - The demo, with sign-in switched off, where everyone is the same stand-in
 *   admin and one click would take the organization from all of them.
 *
 * The default organization can't be deleted anywhere: the desktop app and the
 * demo act in it, and its scripts sit at the top of the GitHub registry.
 */

const DESKTOP = "The desktop app keeps a single organization of its own, so it can't be deleted.";
const DEMO =
  "Deleting an organization needs a real sign-in. In the demo everyone is the same stand-in admin.";

export async function GET() {
  const gate = await requirePermission("organization:read");
  if (!gate.ok) return gate.response;

  const { orgName, orgSlug, orgTwoPersonRule, orgIsDefault, bypass } = gate.principal;
  return NextResponse.json({
    name: orgName,
    slug: orgSlug,
    twoPersonRule: orgTwoPersonRule,
    // So the tab draws no Delete that could only be refused.
    canDelete: !orgIsDefault && !bypass && !onDesktop(),
  });
}

export async function PATCH(request: NextRequest) {
  const gate = await requirePermission("organization:update");
  if (!gate.ok) return gate.response;

  const fields = await readBody(request);
  if (fields === null) {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const changes: { name?: string; twoPersonRule?: boolean } = {};
  if (fields.name !== undefined) {
    const name = cleanOrgName(typeof fields.name === "string" ? fields.name : "");
    const problem = orgNameProblem(name);
    if (problem) return NextResponse.json({ error: problem, field: "name" }, { status: 400 });
    changes.name = name;
  }
  if (fields.twoPersonRule !== undefined) {
    if (typeof fields.twoPersonRule !== "boolean") {
      return NextResponse.json(
        { error: "Say whether the two-person rule is on (true) or off (false).", field: "twoPersonRule" },
        { status: 400 }
      );
    }
    changes.twoPersonRule = fields.twoPersonRule;
  }
  if (changes.name === undefined && changes.twoPersonRule === undefined) {
    return NextResponse.json(
      { error: "Say what to change: the name, the two-person rule, or both." },
      { status: 400 }
    );
  }

  try {
    const updated = await updateOrganization(gate.principal.orgId, changes, actorFor(gate.principal));
    if (updated.kind === "not-found") return gone();
    const { name, slug, twoPersonRule } = updated.organization;
    return NextResponse.json({ name, slug, twoPersonRule });
  } catch (error) {
    console.error("Failed to update the organization:", error);
    return unavailable("Could not save the change.");
  }
}

export async function DELETE(request: NextRequest) {
  const gate = await requirePermission("organization:delete");
  if (!gate.ok) return gate.response;

  if (onDesktop()) return NextResponse.json({ error: DESKTOP }, { status: 403 });
  if (gate.principal.bypass) return NextResponse.json({ error: DEMO }, { status: 403 });

  const fields = await readBody(request);
  if (fields === null) {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const confirm = typeof fields.confirm === "string" ? fields.confirm : "";

  try {
    const deleted = await deleteOrganization(gate.principal.orgId, confirm);
    switch (deleted.kind) {
      case "not-found":
        return gone();
      case "default":
        return NextResponse.json(
          {
            error:
              "This is the first organization on this install, which the app can't do without, " +
              "so it can't be deleted.",
          },
          { status: 403 }
        );
      case "mismatch":
        return NextResponse.json(
          {
            error:
              "That is not the organization's name. Type it exactly as it is shown, " +
              "or reload the page if someone renamed it a moment ago.",
            field: "confirm",
          },
          { status: 400 }
        );
      case "deleted":
        // Its own change log went with it, so this is the only record of who
        // did it: the address and the profile ID, not the person's email, and
        // nothing the organization held.
        console.info(
          `Organization ${gate.principal.orgSlug} deleted by profile ${gate.principal.profileId}.`
        );
        return NextResponse.json({ deleted: true });
    }
  } catch (error) {
    console.error("Failed to delete the organization:", error);
    return unavailable("Could not delete the organization.");
  }
}

/** The body's fields, or null when it is not a JSON object. */
async function readBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The organization was deleted between the gate and the write. */
function gone(): NextResponse {
  return NextResponse.json(
    { error: "This organization no longer exists. Someone may have just deleted it." },
    { status: 404 }
  );
}

/** The desktop app starts this server with SCHEMA_STUDIO_DESKTOP=1 (see auth.config.ts). */
function onDesktop(): boolean {
  return process.env.SCHEMA_STUDIO_DESKTOP === "1";
}

/** A 503 for a database that did not answer, with the reason kept to the log. */
function unavailable(what: string): NextResponse {
  return NextResponse.json(
    { error: `${what} The app's database may be unreachable. Try again in a moment.` },
    { status: 503 }
  );
}
