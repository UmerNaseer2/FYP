import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { ADMIN_ROLE, canHandOut } from "@/lib/permissions";
import { listRoles, lockRoles, logRoleChanges } from "@/lib/roles-db";
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
 *
 * Each method has its own permission under Users (Read, Update, Delete),
 * which an Admin can give to other roles. The rank rule (canHandOut in
 * lib/permissions.ts) keeps that from being a way up: nobody can give a role
 * that can do something theirs can't, move someone out of one, or remove
 * someone who holds one. So only an Admin can touch an Admin.
 *
 * A user here is a member of the caller's organization (gate.principal.orgId).
 * The list is that organization's memberships, a role change changes one
 * membership, and removing someone removes their membership. The profile
 * behind it, which says who the person is wherever they belong, is deleted
 * only once they belong to no organization at all, so removing someone here
 * never takes away their place in another organization. Someone who is not a
 * member here is "No such user", the same answer as someone who never existed.
 */

type UserRow = {
  id: number;
  email: string;
  name: string | null;
  role: string;
  created_at: string;
  last_seen_at: string | null;
};

/** The rank rule's refusal: `doing` the role `label`, which outranks the caller's. */
function outOfReach(doing: string, label: string, roleLabel: string): NextResponse {
  return NextResponse.json(
    { error: `You can't ${doing} the ${label} role. It can do things your role (${roleLabel}) can't.` },
    { status: 403 }
  );
}

/**
 * The role asked for, if it is worth looking up. Whether a role by that name
 * exists is for the roles table to say (see PUT): an admin can add and delete
 * roles, so there is no fixed list to check it against here.
 */
function parseRole(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= 64 ? value : null;
}

/**
 * The answer when the person was changed or removed by somebody else between
 * this request's first read and its write. Nothing was written.
 */
function changedMeanwhile(): NextResponse {
  return NextResponse.json(
    {
      error:
        "Someone else changed this person's role or removed them a moment ago. " +
        "Reload the page to see them as they are now.",
    },
    { status: 409 }
  );
}

/**
 * Take out the last-admin lock, then answer how many admins the organization
 * has left if `excludingId` is demoted or removed.
 *
 * Only this organization's admins count. Being an admin somewhere else gives
 * nobody a way to manage this one, so it cannot keep this one manageable.
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
 * re-counts once the first commits and refuses properly. `ORDER BY profile_id`
 * so two requests always take the rows in the same order and cannot deadlock
 * by grabbing them in opposite directions.
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
  orgId: number,
  excludingId: number
): Promise<number> {
  await client.query(
    `SELECT profile_id FROM memberships
      WHERE org_id = $1 AND role = 'admin'
      ORDER BY profile_id FOR UPDATE`,
    [orgId]
  );
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM memberships
      WHERE org_id = $1 AND role = 'admin' AND profile_id <> $2`,
    [orgId, excludingId]
  );
  return Number(result.rows[0]?.count ?? "0");
}

export async function GET() {
  const gate = await requirePermission("users:read");
  if (!gate.ok) return gate.response;

  try {
    await syncMetadataTables();
    // The roles come along for the role picker on each row: names and labels,
    // and whether the caller may hand each one out (the rank rule). What each
    // role may do is the Roles tab's business, so that is not sent.
    const { orgId } = gate.principal;
    const [result, roles] = await Promise.all([
      pool.query<UserRow>(
        `SELECT p.id, p.email, p.name, m.role, p.created_at, p.last_seen_at
           FROM memberships m
           JOIN profiles p ON p.id = m.profile_id
          WHERE m.org_id = $1
          ORDER BY p.email`,
        [orgId]
      ),
      listRoles(orgId),
    ]);
    return NextResponse.json({
      users: result.rows,
      roles: roles.map((role) => ({
        name: role.name,
        label: role.label,
        assignable: canHandOut(gate.principal, role.permissions),
      })),
    });
  } catch (error) {
    console.error("Failed to list users:", error);
    return NextResponse.json(
      {
        error:
          "Could not read the user list. The app's database may be unreachable. " +
          "Try again in a moment.",
      },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const gate = await requirePermission("users:update");
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
    return NextResponse.json({ error: "Choose a role for this user." }, { status: 400 });
  }

  const { orgId } = gate.principal;
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
      `SELECT role FROM memberships WHERE org_id = $1 AND profile_id = $2`,
      [orgId, userId]
    );
    if (current.rows.length === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "No such user." }, { status: 404 });
    }
    const previousRole = current.rows[0].role;

    // The role asked for is looked up, because the Roles tab can add and
    // delete roles. lockRoles keeps it from being deleted until this commits:
    // deleting a role waits for this transaction, then finds the role in use
    // and refuses. The person's current role is read alongside it, for the
    // rank rule and so the change log can say what they had before.
    const named = await lockRoles(client, orgId, [role, previousRole]);
    const asked = named.get(role);
    const had = named.get(previousRole);
    if (!asked) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        {
          error:
            `There is no role called "${role}". It may have just been deleted: ` +
            "reload the page to see the roles there are now.",
        },
        { status: 400 }
      );
    }

    // The rank rule, both ways round: moving someone out of a role that can
    // do more than yours would be taking it from someone above you, and
    // giving one would be handing out more than you have. A membership's role
    // always exists (a foreign key says so), so `had` is only missing if the
    // rows were edited by hand, and then nobody but an Admin should touch it.
    const { roleLabel } = gate.principal;
    if (!had || !canHandOut(gate.principal, had.permissions)) {
      await client.query("ROLLBACK");
      return outOfReach("change the role of someone who has", had?.label ?? previousRole, roleLabel);
    }
    if (!canHandOut(gate.principal, asked.permissions)) {
      await client.query("ROLLBACK");
      return outOfReach("give someone", asked.label, roleLabel);
    }

    if (
      role !== ADMIN_ROLE &&
      previousRole === ADMIN_ROLE &&
      (await otherAdminCount(client, orgId, userId)) === 0
    ) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "This is the last admin. Promote someone else first." },
        { status: 409 }
      );
    }

    // The role lives on the membership and the rest on the profile, so the
    // reply is put together from both, in the same statement as the change.
    // Only while they still hold the role every check above was about: no
    // lock is taken on a promotion, so somebody else can change or remove
    // them in between, and the rank rule was checked against the old role.
    const result = await client.query<UserRow>(
      `WITH changed AS (
         UPDATE memberships SET role = $1
          WHERE org_id = $2 AND profile_id = $3 AND role = $4
         RETURNING profile_id, role
       )
       SELECT p.id, p.email, p.name, changed.role, p.created_at, p.last_seen_at
         FROM changed
         JOIN profiles p ON p.id = changed.profile_id`,
      [role, orgId, userId, previousRole]
    );
    // This is also what stops the reply being `user: undefined` with
    // success: true.
    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return changedMeanwhile();
    }

    // Written in the same transaction, so the log never shows a change that
    // did not happen, or misses one that did. Picking the role someone
    // already has changes nothing and is not logged.
    if (previousRole !== role) {
      await logRoleChanges(client, orgId, [
        {
          role,
          kind: "assign",
          subject: result.rows[0].email,
          detail: had.label,
          actor: actorFor(gate.principal),
        },
      ]);
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
  const gate = await requirePermission("users:delete");
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

  const { orgId } = gate.principal;
  let client;
  try {
    await syncMetadataTables();

    // One transaction from the check to the write, exactly as PUT does — a
    // delete removes an admin just as surely as a demotion, so two deletes
    // racing each other can empty the admin list the same way.
    client = await pool.connect();
    await client.query("BEGIN");

    const target = await client.query<{ role: string }>(
      `SELECT role FROM memberships WHERE org_id = $1 AND profile_id = $2`,
      [orgId, userId]
    );
    if (target.rows.length === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "No such user." }, { status: 404 });
    }
    const targetRole = target.rows[0].role;

    // The rank rule, as for a role change: nobody can remove someone whose
    // role can do more than theirs.
    const held = (await lockRoles(client, orgId, [targetRole])).get(targetRole);
    if (!held || !canHandOut(gate.principal, held.permissions)) {
      await client.query("ROLLBACK");
      return outOfReach("remove someone who has", held?.label ?? targetRole, gate.principal.roleLabel);
    }

    // Same reasoning as the demotion guard above.
    if (
      targetRole === ADMIN_ROLE &&
      (await otherAdminCount(client, orgId, userId)) === 0
    ) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "This is the last admin. Promote someone else first." },
        { status: 409 }
      );
    }

    // Deleting yourself signs you out of an app you can no longer administer.
    if (userId === gate.principal.profileId) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "You can't delete your own account here." },
        { status: 409 }
      );
    }

    // Only while they still hold the role checked above, for the same reason
    // as the role change. Their address comes back for the change log.
    const removed = await client.query<{ email: string }>(
      `WITH gone AS (
         DELETE FROM memberships
          WHERE org_id = $1 AND profile_id = $2 AND role = $3
         RETURNING profile_id
       )
       SELECT p.email FROM gone JOIN profiles p ON p.id = gone.profile_id`,
      [orgId, userId, targetRole]
    );
    if (removed.rows.length === 0) {
      await client.query("ROLLBACK");
      return changedMeanwhile();
    }
    await logRoleChanges(client, orgId, [
      {
        role: targetRole,
        kind: "remove",
        subject: removed.rows[0].email,
        actor: actorFor(gate.principal),
      },
    ]);
    // The profile goes too once nothing else needs it: a person who belongs to
    // no organization has nothing left to sign in to. Checked in the same
    // statement, so a membership somewhere else, however new, keeps it.
    await client.query(
      `-- every organization: a membership in any of them keeps the profile
       DELETE FROM profiles
        WHERE id = $1
          AND NOT EXISTS (SELECT 1 FROM memberships WHERE profile_id = $1)`,
      [userId]
    );
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
