import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import {
  createRole,
  deleteRole,
  listRoleChanges,
  listRoles,
  resetRolePermissions,
  setRolePermissions,
} from "@/lib/roles-db";

/**
 * The roles themselves and what each one may do: the Roles & permissions tab
 * on the Admin screen.
 *
 * Each method has its own permission under Roles & permissions (Read, Create,
 * Update, Delete). They are admin-only boxes, so the grid never offers them to
 * another role: a role that could change roles could make itself an admin.
 *
 * The rules themselves (a name already taken, a role still in use, Admin can't
 * be edited) live in lib/roles-db.ts. It answers `{ ok: false, status, error }`
 * for anything the person can fix, and this route passes that straight back.
 * What is checked here is only the shape of what was sent. Anything thrown
 * (the database is down) becomes a 500 with a message a person can act on.
 */

/** The longest role key worth looking up. Keys are 32 characters at most. */
const ROLE_MAX = 64;

/** The request's JSON object, or null when it sent anything else. */
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

function parseRole(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= ROLE_MAX ? value : null;
}

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

/** A refusal from lib/roles-db, sent on with the status it chose. */
function refused(result: { status: number; error: string }) {
  return NextResponse.json({ error: result.error }, { status: result.status });
}

const TRY_AGAIN = "The app's database may be unreachable. Try again in a moment.";

/**
 * Every role with what it can do, and the most recent changes to any of them.
 *
 * One request for both because the tab shows both, and both change after every
 * save: the page reloads this after each write rather than patching its copy.
 */
export async function GET() {
  const gate = await requirePermission("roles:read");
  if (!gate.ok) return gate.response;

  try {
    const [roles, changes] = await Promise.all([listRoles(), listRoleChanges(50)]);
    return NextResponse.json({ roles, changes });
  } catch (error) {
    console.error("Failed to list roles:", error);
    return NextResponse.json({ error: `Could not read the roles. ${TRY_AGAIN}` }, { status: 500 });
  }
}

/** Make a role: `{ label, description?, copyFrom? }`. */
export async function POST(request: NextRequest) {
  const gate = await requirePermission("roles:create");
  if (!gate.ok) return gate.response;

  const body = await readBody(request);
  if (!body) return badRequest("Expected a JSON body.");

  if (typeof body.label !== "string") return badRequest("Give the role a name.");
  const description = body.description ?? "";
  if (typeof description !== "string") return badRequest("The description must be text.");

  // No role to copy (left out, null, or the picker's empty choice) starts the
  // new role with nothing ticked.
  let copyFrom: string | null = null;
  if (body.copyFrom !== undefined && body.copyFrom !== null && body.copyFrom !== "") {
    copyFrom = parseRole(body.copyFrom);
    if (copyFrom === null) {
      return badRequest("Pick a role to copy, or none to start with nothing ticked.");
    }
  }

  try {
    const result = await createRole(
      { label: body.label, description, copyFrom },
      actorFor(gate.principal)
    );
    if (!result.ok) return refused(result);
    return NextResponse.json({ role: result.role }, { status: 201 });
  } catch (error) {
    console.error("Failed to create a role:", error);
    return NextResponse.json({ error: `Could not create the role. ${TRY_AGAIN}` }, { status: 500 });
  }
}

/**
 * Change what a role can do.
 *
 *   { role, permissions: [...] }  the role gets exactly these (plus the Reads
 *                                 they bring with them)
 *   { role, reset: true }         Viewer or Editor goes back to its defaults
 */
export async function PUT(request: NextRequest) {
  const gate = await requirePermission("roles:update");
  if (!gate.ok) return gate.response;

  const body = await readBody(request);
  if (!body) return badRequest("Expected a JSON body.");

  const role = parseRole(body.role);
  if (!role) return badRequest("Say which role to change.");

  // A reset needs no list. Anything else sends the role's whole new set, not
  // a change to it, so that two tabs saving one after the other each leave
  // the role exactly as that tab showed it.
  const reset = body.reset === true;
  let permissions: string[] = [];
  if (!reset) {
    const sent = body.permissions;
    if (!Array.isArray(sent) || !sent.every((key) => typeof key === "string")) {
      return badRequest("Send the role's permissions as a list.");
    }
    permissions = sent;
  }

  try {
    const actor = actorFor(gate.principal);
    const result = reset
      ? await resetRolePermissions(role, actor)
      : await setRolePermissions(role, permissions, actor);
    if (!result.ok) return refused(result);
    return NextResponse.json({ permissions: result.permissions, changes: result.changes });
  } catch (error) {
    console.error("Failed to save a role's permissions:", error);
    return NextResponse.json(
      { error: `Could not save the role's permissions. ${TRY_AGAIN}` },
      { status: 500 }
    );
  }
}

/** Delete a role nobody holds: `{ role }`. */
export async function DELETE(request: NextRequest) {
  const gate = await requirePermission("roles:delete");
  if (!gate.ok) return gate.response;

  const body = await readBody(request);
  if (!body) return badRequest("Expected a JSON body.");

  const role = parseRole(body.role);
  if (!role) return badRequest("Say which role to delete.");

  try {
    const result = await deleteRole(role, actorFor(gate.principal));
    if (!result.ok) return refused(result);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete a role:", error);
    return NextResponse.json({ error: `Could not delete the role. ${TRY_AGAIN}` }, { status: 500 });
  }
}
