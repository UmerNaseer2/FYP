import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { ROLES, type Role } from "@/lib/auth-mode";
import pool, { syncMetadataTables } from "@/lib/version-db";

/**
 * Manage who can use the app and at what level.
 *
 * This route previously opened its own `new Pool({ connectionString:
 * process.env.DATABASE_URL })`. That variable is never set anywhere in this
 * project — the metadata database is `DATABASE_URL_A` — so every query here
 * failed at connect time. It now shares the one pool in lib/version-db, which
 * is also the pool that creates the `profiles` table.
 */

type UserRow = {
  id: number;
  email: string;
  name: string | null;
  role: string;
  created_at: string;
  last_seen_at: string | null;
};

/** Reject a role that isn't one of ours, rather than writing it and letting the CHECK constraint fail. */
function parseRole(value: unknown): Role | null {
  return (ROLES as readonly string[]).includes(String(value))
    ? (String(value) as Role)
    : null;
}

/** How many admins remain if `excludingId` is demoted or deleted. */
async function otherAdminCount(excludingId: number): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM profiles WHERE role = 'admin' AND id <> $1`,
    [excludingId]
  );
  return Number(result.rows[0]?.count ?? "0");
}

export async function GET() {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  try {
    await syncMetadataTables();
    const result = await pool.query<UserRow>(
      `SELECT id, email, name, role, created_at, last_seen_at
         FROM profiles
        ORDER BY email`
    );
    return NextResponse.json({ users: result.rows });
  } catch (error) {
    console.error("Failed to list users:", error);
    return NextResponse.json(
      { error: "Could not read the user list." },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  let body: { userId?: unknown; role?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const userId = Number(body.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "A valid userId is required." }, { status: 400 });
  }

  const role = parseRole(body.role);
  if (!role) {
    return NextResponse.json(
      { error: `Role must be one of: ${ROLES.join(", ")}.` },
      { status: 400 }
    );
  }

  try {
    await syncMetadataTables();

    // Demoting the last admin would leave nobody able to promote anyone back,
    // and this screen is the only way to change a role.
    if (role !== "admin" && (await otherAdminCount(userId)) === 0) {
      const current = await pool.query<{ role: string }>(
        `SELECT role FROM profiles WHERE id = $1`,
        [userId]
      );
      if (current.rows[0]?.role === "admin") {
        return NextResponse.json(
          { error: "This is the last admin. Promote someone else first." },
          { status: 409 }
        );
      }
    }

    const result = await pool.query<UserRow>(
      `UPDATE profiles SET role = $1 WHERE id = $2
       RETURNING id, email, name, role, created_at, last_seen_at`,
      [role, userId]
    );
    if (result.rows.length === 0) {
      return NextResponse.json({ error: "No such user." }, { status: 404 });
    }
    return NextResponse.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error("Failed to update user role:", error);
    return NextResponse.json(
      { error: "Could not update that user." },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  let body: { userId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const userId = Number(body.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "A valid userId is required." }, { status: 400 });
  }

  try {
    await syncMetadataTables();

    const target = await pool.query<{ email: string; role: string }>(
      `SELECT email, role FROM profiles WHERE id = $1`,
      [userId]
    );
    if (target.rows.length === 0) {
      return NextResponse.json({ error: "No such user." }, { status: 404 });
    }

    // Same reasoning as the demotion guard above.
    if (target.rows[0].role === "admin" && (await otherAdminCount(userId)) === 0) {
      return NextResponse.json(
        { error: "This is the last admin. Promote someone else first." },
        { status: 409 }
      );
    }

    // Deleting yourself signs you out of an app you can no longer administer.
    if (
      !gate.principal.bypass &&
      target.rows[0].email.toLowerCase() === gate.principal.email.toLowerCase()
    ) {
      return NextResponse.json(
        { error: "You can't delete your own account here." },
        { status: 409 }
      );
    }

    await pool.query(`DELETE FROM profiles WHERE id = $1`, [userId]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete user:", error);
    return NextResponse.json(
      { error: "Could not delete that user." },
      { status: 500 }
    );
  }
}
