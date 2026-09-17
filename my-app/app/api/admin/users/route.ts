import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { ROLES, type Role } from "@/lib/auth-mode";
import pool, { syncMetadataTables } from "@/lib/version-db";
import type { MetadataClient } from "@/lib/db/sequelize";

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

/**
 * Take out the last-admin lock, then answer how many admins remain if
 * `excludingId` is demoted or deleted.
 *
 * Must run inside a transaction on `client`, because the lock it takes lasts
 * until that transaction ends — and the whole point is that it is still held
 * when the UPDATE or DELETE below runs.
 *
 * Why a lock at all. Counting and then acting are two statements, and two
 * admins pressing the button at the same moment both counted before either
 * acted: Umer demotes Mei while Mei demotes Umer, each sees "one other admin
 * left", each is allowed through, and the app ends up with no admin and no
 * screen that can appoint one. Rare, and unrecoverable without a hand-written
 * UPDATE against the database.
 *
 * Why the lock query selects EVERY admin and does not exclude the target. An
 * "everyone except me" lock excludes exactly the row this request is about to
 * write — which is the row the OTHER request has locked. Both counts come back
 * "one other admin left", so the guard has already failed; then each goes to
 * write the row the other holds and PostgreSQL kills one for deadlock. Checked
 * against 17.11 rather than reasoned about: reproducible on every run, and at
 * three admins as readily as at two. The last admin does survive that, but by
 * accident, and the operator gets a 500 instead of being told which rule they
 * hit. Locking the whole set makes the second request WAIT instead, so it
 * re-counts once the first commits and refuses properly. `ORDER BY id` so two
 * requests always take the rows in the same order and cannot deadlock by
 * grabbing them in opposite directions.
 *
 * Why the count is a second statement rather than the length of that result.
 * Under READ COMMITTED each statement gets a fresh view, so this one sees
 * whatever the transaction we just waited behind committed. The lock query
 * cannot: its result set was fixed before it blocked, and PostgreSQL re-checks
 * `role = 'admin'` against rows already in it — dropping one that was just
 * demoted, which is what saves us — but never adds a row that only became an
 * admin while we waited. Counting again is how a promotion that landed during
 * the wait gets counted.
 */
async function otherAdminCount(
  client: MetadataClient,
  excludingId: number
): Promise<number> {
  await client.query(`SELECT id FROM profiles WHERE role = 'admin' ORDER BY id FOR UPDATE`);
  const result = await client.query<{ count: string }>(
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

  let client;
  try {
    await syncMetadataTables();

    // One transaction from the check to the write: see otherAdminCount.
    client = await pool.connect();
    await client.query("BEGIN");

    // Demoting the last admin would leave nobody able to promote anyone back,
    // and this screen is the only way to change a role. Read the current role
    // first so the lock is only taken when this really is a demotion — a
    // promotion cannot remove the last admin, and making every role change
    // queue behind every other one would be a cost for nothing.
    const current = await client.query<{ role: string }>(
      `SELECT role FROM profiles WHERE id = $1`,
      [userId]
    );
    if (current.rows.length === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "No such user." }, { status: 404 });
    }
    if (
      role !== "admin" &&
      current.rows[0].role === "admin" &&
      (await otherAdminCount(client, userId)) === 0
    ) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "This is the last admin. Promote someone else first." },
        { status: 409 }
      );
    }

    const result = await client.query<UserRow>(
      `UPDATE profiles SET role = $1 WHERE id = $2
       RETURNING id, email, name, role, created_at, last_seen_at`,
      [role, userId]
    );
    // Checked again rather than trusted from the SELECT above. On a promotion
    // no lock is taken, so somebody else's DELETE can land in between, and
    // this is what stops the reply being `user: undefined` with success: true.
    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "No such user." }, { status: 404 });
    }
    await client.query("COMMIT");
    return NextResponse.json({ success: true, user: result.rows[0] });
  } catch (error) {
    // Best-effort: if the connection is what failed, this fails too, and the
    // server drops the transaction when the connection goes.
    await client?.query("ROLLBACK").catch(() => {});
    console.error("Failed to update user role:", error);
    return NextResponse.json(
      { error: "Could not update that user." },
      { status: 500 }
    );
  } finally {
    client?.release();
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

  let client;
  try {
    await syncMetadataTables();

    // One transaction from the check to the write, exactly as PUT does — a
    // delete removes an admin just as surely as a demotion, so two deletes
    // racing each other can empty the admin list the same way.
    client = await pool.connect();
    await client.query("BEGIN");

    const target = await client.query<{ email: string; role: string }>(
      `SELECT email, role FROM profiles WHERE id = $1`,
      [userId]
    );
    if (target.rows.length === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "No such user." }, { status: 404 });
    }

    // Same reasoning as the demotion guard above.
    if (
      target.rows[0].role === "admin" &&
      (await otherAdminCount(client, userId)) === 0
    ) {
      await client.query("ROLLBACK");
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
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "You can't delete your own account here." },
        { status: 409 }
      );
    }

    await client.query(`DELETE FROM profiles WHERE id = $1`, [userId]);
    await client.query("COMMIT");
    return NextResponse.json({ success: true });
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => {});
    console.error("Failed to delete user:", error);
    return NextResponse.json(
      { error: "Could not delete that user." },
      { status: 500 }
    );
  } finally {
    client?.release();
  }
}
