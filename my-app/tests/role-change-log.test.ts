// role-change-log: the "Recent changes" list on the Roles & permissions tab
// (components/admin/RoleChangeLog.tsx), as describeRoleChanges words it.
//
// The database keeps one row per line turned on or off, and hands them back
// newest first (listRoleChanges in lib/roles-db.ts). The screen puts the rows
// of one save back into one line, so these tests give it rows the way the
// database does and check that:
//
//   - one save is one entry, naming what it turned on and off, by the names
//     the tab's lines have, in the order they were written;
//   - a reset says so, and still lists what it changed;
//   - saves stay apart when the role, the person or the time differs, and a
//     row of any other kind ends a save, even one written at the same time;
//   - a deleted role and a permission this build no longer has still read;
//   - making, deleting and giving out a role each read as a sentence;
//   - so do inviting someone, cancelling an invitation and joining by one,
//     for an address and for a link alike;
//   - and removing someone, renaming the organization, switching its
//     two-person rule and changing where its scripts are kept on GitHub.
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

/** A line turned on (grant) or off (revoke), named by its key. */
function toggled(
  id: number,
  kind: "grant" | "revoke",
  key: string,
  over: Partial<RoleChange> = {}
): RoleChange {
  const [feature, action] = key.split(":") as [string, string];
  return row({ id, kind, feature, action, ...over });
}

/** An entry of the log, by default Ada's at SAVED_AT, turning nothing on or off. */
function line(over: Partial<LogEntry> & Pick<LogEntry, "id" | "text">): LogEntry {
  return { actor: ADA, createdAt: SAVED_AT, turnedOn: [], turnedOff: [], ...over };
}

test("an empty log is no lines", () => {
  expect(describeRoleChanges([])).toEqual([]);
});

describe("a save of a role's lines", () => {
  test("is one entry, naming its lines in the order they were written", () => {
    // Written as 11 to 14 by one transaction, read back newest first.
    const rows = [
      toggled(14, "revoke", "comparison_sets:delete"),
      toggled(13, "revoke", "connections:delete"),
      toggled(12, "grant", "connections:update"),
      toggled(11, "grant", "connections:create"),
    ];
    expect(describeRoleChanges(rows)).toEqual([
      line({
        id: 14,
        text: EDITOR,
        turnedOn: ["Add a connection", "Edit or test a saved connection"],
        turnedOff: ["Delete a connection", "Delete a comparison set"],
      }),
    ]);
  });

  test("that puts a role back to its defaults says so, and lists what that changed", () => {
    // resetRolePermissions writes the lines first and the reset row last, so
    // the reset row is the newest, and comes first.
    const rows = [
      row({ id: 23, kind: "reset" }),
      toggled(22, "revoke", "deploy:run"),
      toggled(21, "grant", "drift:run"),
    ];
    expect(describeRoleChanges(rows)).toEqual([
      line({
        id: 23,
        text: "reset Editor to its defaults",
        turnedOn: ["Run a drift check"],
        turnedOff: ["Apply or revert migrations"],
      }),
    ]);
  });

  test("stays apart from the next when the person, the time or the role differs", () => {
    // Each row differs from the one after it in exactly one of the three.
    const rows = [
      toggled(33, "grant", "connections:create", { actor: BOB, createdAt: LATER }),
      toggled(32, "grant", "connections:update", { createdAt: LATER }),
      toggled(31, "grant", "drift:create"),
      toggled(30, "grant", "drift:update", { role: "viewer", roleLabel: "Viewer" }),
    ];
    expect(describeRoleChanges(rows)).toEqual([
      line({ id: 33, actor: BOB, createdAt: LATER, text: EDITOR, turnedOn: ["Add a connection"] }),
      line({ id: 32, createdAt: LATER, text: EDITOR, turnedOn: ["Edit or test a saved connection"] }),
      line({ id: 31, text: EDITOR, turnedOn: ["Track a schema"] }),
      line({ id: 30, text: "changed what Viewer can do", turnedOn: ["Change schedules, environments and baselines, or acknowledge drift"] }),
    ]);
  });

  test("is ended by a row of any other kind, even one written at the same time", () => {
    const rows = [
      toggled(42, "grant", "connections:create"),
      row({ id: 41, kind: "assign", subject: "grace@example.com", detail: "Viewer" }),
      toggled(40, "grant", "connections:update"),
    ];
    expect(describeRoleChanges(rows)).toEqual([
      line({ id: 42, text: EDITOR, turnedOn: ["Add a connection"] }),
      line({ id: 41, text: "gave grace@example.com the Editor role, instead of Viewer" }),
      line({ id: 40, text: EDITOR, turnedOn: ["Edit or test a saved connection"] }),
    ]);
  });
});

describe("names that have gone since", () => {
  test("a deleted role is named by its key", () => {
    const gone = { role: "qa-lead", roleLabel: null };
    const rows = [
      toggled(52, "grant", "drift:read", gone),
      row({ id: 51, kind: "assign", subject: "grace@example.com", ...gone }),
    ];
    expect(describeRoleChanges(rows)).toEqual([
      line({ id: 52, text: "changed what qa-lead (deleted) can do", turnedOn: ["See tracked schemas and their drift"] }),
      line({ id: 51, text: "gave grace@example.com the qa-lead (deleted) role" }),
    ]);
  });

  test("a permission this build no longer has is named by its parts", () => {
    // A log keeps what it was given, so a key a later build drops, or a whole
    // feature it drops, still has to read as something.
    const rows = [toggled(62, "grant", "version_sync:create"), toggled(61, "revoke", "reports:export")];
    expect(describeRoleChanges(rows)).toEqual([
      line({ id: 62, text: EDITOR, turnedOn: ["version_sync: create"], turnedOff: ["reports: export"] }),
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
    // Inviting someone and saving a role are separate requests, so their
    // rows never share a timestamp in practice. These do anyway, to show the
    // entry breaks on the kind of row and not only on the time: the lines
    // either side must not end up in one entry, nor the older one under the
    // invitation.
    const rows = [
      toggled(4, "grant", "drift:read"),
      row({ id: 3, kind: "invite", subject: "grace@example.com" }),
      toggled(2, "revoke", "drift:create"),
    ];
    expect(describeRoleChanges(rows)).toEqual([
      line({ id: 4, text: EDITOR, turnedOn: ["See tracked schemas and their drift"] }),
      line({ id: 3, text: "invited grace@example.com as Editor" }),
      line({ id: 2, text: EDITOR, turnedOff: ["Track a schema"] }),
    ]);
  });
});

describe("someone removed, and the organization changed", () => {
  const admin = { role: "admin", roleLabel: "Admin" };
  test.each<[string, Partial<RoleChange> & Pick<RoleChange, "kind">, string]>([
    ["someone removed", { kind: "remove", subject: "grace@example.com" }, "removed grace@example.com (Editor)"],
    [
      "the organization renamed",
      { kind: "rename-organization", subject: "Acme Labs", detail: "Acme", ...admin },
      "renamed the organization from Acme to Acme Labs",
    ],
    [
      "the two-person rule switched off",
      { kind: "two-person-rule", detail: "off", ...admin },
      "switched the two-person rule off, so people can approve their own production deploys",
    ],
    [
      "the two-person rule switched on",
      { kind: "two-person-rule", detail: "on", ...admin },
      "switched the two-person rule on, so production deploys wait for a second person",
    ],
    [
      "the GitHub repository changed",
      { kind: "github-settings", subject: "acme/schema-scripts", detail: "repository", ...admin },
      "pointed the organization at the GitHub repository acme/schema-scripts",
    ],
    [
      "a new GitHub access token saved",
      { kind: "github-settings", subject: "acme/schema-scripts", detail: "token", ...admin },
      "saved a new GitHub access token for acme/schema-scripts",
    ],
    [
      "the GitHub settings removed",
      { kind: "github-settings", subject: "acme/schema-scripts", detail: "removed", ...admin },
      "removed the GitHub settings for acme/schema-scripts",
    ],
  ])("%s", (_name, over, text) => {
    expect(describeRoleChanges([row({ id: 7, ...over })])).toEqual([line({ id: 7, text })]);
  });
});
