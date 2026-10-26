// role-change-log: the "Recent changes" list on the Roles & permissions tab
// (components/admin/RoleChangeLog.tsx), as describeRoleChanges words it.
//
// The database keeps one row per box ticked or unticked, and hands them back
// newest first (listRoleChanges in lib/roles-db.ts). The screen puts the rows
// of one save back into one line, so these tests give it rows the way the
// database does and check that:
//
//   - one save is one line, its boxes listed in the order they were written;
//   - a reset says so, and still lists what it changed;
//   - saves stay apart when the role, the person or the time differs, and a
//     row of any other kind ends a save, even one written at the same time;
//   - a deleted role and a box this build no longer has still read;
//   - making, deleting and giving out a role each read as a sentence;
//   - so do inviting someone, cancelling an invitation and joining by one,
//     for an address and for a link alike.
//
// The lines as the Admin page draws them: tests/page-admin.test.tsx.
import { describeRoleChanges, type LogEntry } from "@/components/admin/RoleChangeLog";
import type { RoleChange } from "@/lib/roles-db";

const ADA = "ada@example.com";
const BOB = "bob@example.com";
const SAVED_AT = "2026-10-17T09:00:00.000Z";
const LATER = "2026-10-17T09:05:00.000Z";
const EDITOR = "changed what Editor can do";

/** A log row, by default part of a save of Editor by Ada. */
function row(over: Partial<RoleChange> & Pick<RoleChange, "kind">): RoleChange {
  return {
    id: 1,
    role: "editor",
    roleLabel: "Editor",
    feature: null,
    action: null,
    subject: null,
    detail: null,
    actor: ADA,
    createdAt: SAVED_AT,
    ...over,
  };
}

/** A box ticked (grant) or unticked (revoke), named by its key. */
function box(
  id: number,
  kind: "grant" | "revoke",
  key: string,
  over: Partial<RoleChange> = {}
): RoleChange {
  const [feature, action] = key.split(":") as [string, string];
  return row({ id, kind, feature, action, ...over });
}

/** A line of the log, by default Ada's at SAVED_AT with no boxes. */
function line(over: Partial<LogEntry> & Pick<LogEntry, "id" | "text">): LogEntry {
  return { actor: ADA, createdAt: SAVED_AT, gave: [], tookAway: [], ...over };
}

test("an empty log is no lines", () => {
  expect(describeRoleChanges([])).toEqual([]);
});

describe("a save of the grid", () => {
  test("is one line, with its boxes in the order they were written", () => {
    // Written as 11 to 14 by one transaction, read back newest first.
    const rows = [
      box(14, "revoke", "comparison_sets:delete"),
      box(13, "revoke", "connections:delete"),
      box(12, "grant", "connections:update"),
      box(11, "grant", "connections:create"),
    ];
    expect(describeRoleChanges(rows)).toEqual([
      line({
        id: 14,
        text: EDITOR,
        gave: ["Connections: Create", "Connections: Update"],
        tookAway: ["Connections: Delete", "Comparison sets: Delete"],
      }),
    ]);
  });

  test("that puts a role back to its defaults says so, and lists what that changed", () => {
    // resetRolePermissions writes the boxes first and the reset row last, so
    // the reset row is the newest, and comes first.
    const rows = [
      row({ id: 23, kind: "reset" }),
      box(22, "revoke", "deploy:run"),
      box(21, "grant", "drift:run"),
    ];
    expect(describeRoleChanges(rows)).toEqual([
      line({
        id: 23,
        text: "reset Editor to its defaults",
        gave: ["Drift tracking: Run"],
        tookAway: ["Deploy: Run"],
      }),
    ]);
  });

  test("stays apart from the next when the person, the time or the role differs", () => {
    // Each row differs from the one after it in exactly one of the three.
    const rows = [
      box(33, "grant", "connections:create", { actor: BOB, createdAt: LATER }),
      box(32, "grant", "connections:update", { createdAt: LATER }),
      box(31, "grant", "drift:create"),
      box(30, "grant", "drift:update", { role: "viewer", roleLabel: "Viewer" }),
    ];
    expect(describeRoleChanges(rows)).toEqual([
      line({ id: 33, actor: BOB, createdAt: LATER, text: EDITOR, gave: ["Connections: Create"] }),
      line({ id: 32, createdAt: LATER, text: EDITOR, gave: ["Connections: Update"] }),
      line({ id: 31, text: EDITOR, gave: ["Drift tracking: Create"] }),
      line({ id: 30, text: "changed what Viewer can do", gave: ["Drift tracking: Update"] }),
    ]);
  });

  test("is ended by a row of any other kind, even one written at the same time", () => {
    const rows = [
      box(42, "grant", "connections:create"),
      row({ id: 41, kind: "assign", subject: "grace@example.com", detail: "Viewer" }),
      box(40, "grant", "connections:update"),
    ];
    expect(describeRoleChanges(rows)).toEqual([
      line({ id: 42, text: EDITOR, gave: ["Connections: Create"] }),
      line({ id: 41, text: "gave grace@example.com the Editor role, instead of Viewer" }),
      line({ id: 40, text: EDITOR, gave: ["Connections: Update"] }),
    ]);
  });
});

describe("names that have gone since", () => {
  test("a deleted role is named by its key", () => {
    const gone = { role: "qa-lead", roleLabel: null };
    const rows = [
      box(52, "grant", "drift:read", gone),
      row({ id: 51, kind: "assign", subject: "grace@example.com", ...gone }),
    ];
    expect(describeRoleChanges(rows)).toEqual([
      line({ id: 52, text: "changed what qa-lead (deleted) can do", gave: ["Drift tracking: Read"] }),
      line({ id: 51, text: "gave grace@example.com the qa-lead (deleted) role" }),
    ]);
  });

  test("a box this build no longer has is named by its parts", () => {
    // A log keeps what it was given, so a key a later build drops, or a whole
    // feature it drops, still has to read as something.
    const rows = [box(62, "grant", "version_sync:create"), box(61, "revoke", "reports:export")];
    expect(describeRoleChanges(rows)).toEqual([
      line({ id: 62, text: EDITOR, gave: ["version_sync: create"], tookAway: ["reports: export"] }),
    ]);
  });
});

describe("a role made, deleted or given to someone", () => {
  test.each<[string, Partial<RoleChange> & Pick<RoleChange, "kind">, string]>([
    [
      "a role copied from another",
      { kind: "create-role", role: "qa-lead", roleLabel: "QA Lead", detail: "Copied from Viewer" },
      "created QA Lead (copied from Viewer)",
    ],
    [
      "a role made empty",
      { kind: "create-role", role: "qa-lead", roleLabel: "QA Lead" },
      "created QA Lead",
    ],
    [
      "a role deleted, by the name it had",
      { kind: "delete-role", role: "qa-lead", roleLabel: null, detail: "QA Lead" },
      "deleted QA Lead",
    ],
    [
      "a role deleted with no name kept",
      { kind: "delete-role", role: "qa-lead", roleLabel: null },
      "deleted qa-lead",
    ],
    [
      "a role given in place of another",
      { kind: "assign", subject: "grace@example.com", detail: "Viewer" },
      "gave grace@example.com the Editor role, instead of Viewer",
    ],
    [
      "a role given to someone who had none",
      { kind: "assign", subject: "grace@example.com" },
      "gave grace@example.com the Editor role",
    ],
    ["a role given to someone the row does not name", { kind: "assign" }, "gave someone the Editor role"],
  ])("%s", (_name, over, text) => {
    expect(describeRoleChanges([row({ id: 7, ...over })])).toEqual([line({ id: 7, text })]);
  });
});

describe("an invitation made, cancelled or taken", () => {
  test.each<[string, Partial<RoleChange> & Pick<RoleChange, "kind">, string]>([
    [
      "an invitation to an address",
      { kind: "invite", subject: "grace@example.com" },
      "invited grace@example.com as Editor",
    ],
    [
      "an invitation link, with how long it lasts",
      { kind: "invite", role: "viewer", roleLabel: "Viewer", detail: "30" },
      "made a 30-day invitation link to join as Viewer",
    ],
    [
      "an invitation link of one day",
      { kind: "invite", role: "viewer", roleLabel: "Viewer", detail: "1" },
      "made a 1-day invitation link to join as Viewer",
    ],
    [
      // A row the app did not write, or a detail mangled since: the line
      // still reads, without a number nobody chose.
      "an invitation link whose length the row does not hold",
      { kind: "invite", role: "viewer", roleLabel: "Viewer", detail: "soon" },
      "made an invitation link to join as Viewer",
    ],
    [
      "an invitation to an address, cancelled",
      { kind: "cancel-invite", subject: "grace@example.com" },
      "cancelled the invitation for grace@example.com",
    ],
    [
      "an invitation link, cancelled",
      { kind: "cancel-invite", role: "viewer", roleLabel: "Viewer" },
      "cancelled an invitation link to join as Viewer",
    ],
    [
      "an invitation to a role deleted since",
      { kind: "invite", subject: "grace@example.com", role: "qa-lead", roleLabel: null },
      "invited grace@example.com as qa-lead (deleted)",
    ],
  ])("%s", (_name, over, text) => {
    expect(describeRoleChanges([row({ id: 7, ...over })])).toEqual([line({ id: 7, text })]);
  });

  // The person who joined is the actor: nobody else did anything.
  test.each<[string, string, string]>([
    ["by an invitation to their address", "email", "joined as Editor by invitation"],
    ["through an invitation link", "link", "joined as Editor with an invitation link"],
  ])("someone joining %s", (_name, detail, text) => {
    const grace = { actor: "grace@example.com" };
    expect(
      describeRoleChanges([row({ id: 7, kind: "join", subject: "grace@example.com", detail, ...grace })])
    ).toEqual([line({ id: 7, text, ...grace })]);
  });

  test("an invitation between two saves at the same moment keeps them apart", () => {
    // Inviting someone and saving the grid are separate requests, so their
    // rows never share a timestamp in practice. These do anyway, to show the
    // line breaks on the kind of row and not only on the time: the boxes
    // either side must not end up on one line, nor the older box under the
    // invitation.
    const rows = [
      box(4, "grant", "drift:read"),
      row({ id: 3, kind: "invite", subject: "grace@example.com" }),
      box(2, "revoke", "drift:create"),
    ];
    expect(describeRoleChanges(rows)).toEqual([
      line({ id: 4, text: EDITOR, gave: ["Drift tracking: Read"] }),
      line({ id: 3, text: "invited grace@example.com as Editor" }),
      line({ id: 2, text: EDITOR, tookAway: ["Drift tracking: Create"] }),
    ]);
  });
});
