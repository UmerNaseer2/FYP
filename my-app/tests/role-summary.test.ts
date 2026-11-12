// role-summary: the words the Roles & permissions tab uses about a role
// (lib/role-summary.ts). Pure functions, so every sentence is checked here
// without a screen:
//
//   - lists read as words, with "N more" past the limit and semicolons when
//     an item has a comma of its own;
//   - every permission sits under exactly one sidebar screen, with its
//     feature's see line first and no other see line under it;
//   - the locked line and the copy-of-Admin note name the admin-only tabs;
//   - each role's card summary and its four answers at a glance follow what
//     it holds, and Admin is always everything;
//   - a tick that also turned another line on or off says which, and a tick
//     that did nothing else says nothing;
//   - the save bar says what will be gained, then what will be lost, in the
//     order the tab lists the lines;
//   - and a permission this build no longer has keeps its key as its name.
//
// The lines as the Admin page draws them: tests/page-admin.test.tsx.
import { ALL_PERMISSIONS, presetFor, type PermissionKey } from "@/lib/permissions";
import {
  ADMIN_COPY_NOTE,
  ADMIN_ONLY_LINE,
  ADMIN_ONLY_TABS,
  SCREEN_GROUPS,
  capitalise,
  changeSentences,
  glance,
  glanceValue,
  joinList,
  lineName,
  roleSummary,
  toggleHint,
} from "@/lib/role-summary";

const VIEWER: readonly string[] = presetFor("viewer") ?? [];
const EDITOR: readonly string[] = presetFor("editor") ?? [];

/** A key an old log row might hold, which this build no longer has. */
const GONE = "old:thing" as string as PermissionKey;

/** The four answers at a glance, as the tab words them. */
function answers(roleName: string, keys: readonly string[]): string[] {
  return glance(roleName, keys).map(glanceValue);
}

describe("capitalise", () => {
  it("capitalises the first letter only", () => {
    expect(capitalise("add a connection")).toBe("Add a connection");
    expect(capitalise("")).toBe("");
  });
});

describe("joinList", () => {
  it("joins with commas and a last and", () => {
    expect(joinList([])).toBe("");
    expect(joinList(["a"])).toBe("a");
    expect(joinList(["a", "b"])).toBe("a and b");
    expect(joinList(["a", "b", "c"])).toBe("a, b and c");
  });

  it("counts what is past the limit instead of listing it", () => {
    expect(joinList(["a", "b", "c", "d", "e", "f", "g"])).toBe("a, b, c, d and 3 more");
    expect(joinList(["a", "b", "c", "d", "e"])).toBe("a, b, c, d and 1 more");
  });

  it("keeps items with a comma of their own apart with semicolons", () => {
    expect(joinList(["a, x", "b", "c"])).toBe("a, x; b; and c");
    // Two items only ever need the and.
    expect(joinList(["a, x", "b"])).toBe("a, x and b");
  });
});

describe("SCREEN_GROUPS", () => {
  it("follows the sidebar's order", () => {
    expect(SCREEN_GROUPS.map((group) => group.screen)).toEqual([
      "Dashboard",
      "Compare & Author",
      "Script Editor",
      "Deploy",
      "Version Sync",
      "Drift",
      "Performance",
      "Visualizer",
      "Connections",
      "AI assistance",
      "Admin",
    ]);
  });

  it("puts each feature's see line first and no other see line under it", () => {
    for (const group of SCREEN_GROUPS) {
      for (const lines of group.features) {
        expect(lines.read.action).toBe("read");
        expect(lines.read.feature).toBe(lines.feature);
        expect(lines.others.filter((p) => p.action === "read")).toEqual([]);
        expect(lines.others.every((p) => p.feature === lines.feature)).toBe(true);
      }
    }
  });

  it("lists every permission exactly once", () => {
    const keys = SCREEN_GROUPS.flatMap((group) =>
      group.features.flatMap((lines) => [lines.read.key, ...lines.others.map((p) => p.key)])
    );
    expect(keys).toHaveLength(ALL_PERMISSIONS.length);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });
});

describe("the admin-only tabs", () => {
  it("are named in the locked line and in the copy-of-Admin note", () => {
    expect(ADMIN_ONLY_TABS).toBe("The Roles & permissions and Organization tabs");
    expect(ADMIN_ONLY_LINE).toBe(
      "The Roles & permissions and Organization tabs are for Admin only, " +
        "so no role can make itself an admin."
    );
    expect(ADMIN_COPY_NOTE).toBe(
      "A copy of Admin gets everything except the Roles & permissions and " +
        "Organization tabs, which only Admin can have."
    );
  });
});

describe("roleSummary", () => {
  it("says Admin is everything, whatever it holds", () => {
    expect(roleSummary("admin", [])).toBe("Everything, always");
  });

  it("says when nothing this build knows is turned on", () => {
    expect(roleSummary("qa_lead", [])).toBe("Nothing turned on");
    expect(roleSummary("qa_lead", ["nope"])).toBe("Nothing turned on");
  });

  it("calls a role that only looks read-only, and says so when it can run drift checks", () => {
    expect(roleSummary("viewer", VIEWER)).toBe("Read-only");
    expect(roleSummary("qa_lead", ["dashboard:read"])).toBe("Read-only");
    expect(roleSummary("viewer", [...VIEWER, "drift:run"])).toBe("Read-only, plus drift checks");
  });

  it("puts running migrations above changing other things", () => {
    expect(roleSummary("editor", EDITOR)).toBe("Can run migrations");
    expect(roleSummary("editor", EDITOR.filter((key) => key !== "deploy:run"))).toBe(
      "Can change things"
    );
  });
});

describe("glance", () => {
  it("asks the same four questions, in the same order", () => {
    expect(glance("viewer", VIEWER).map((row) => row.label)).toEqual([
      "Changes things",
      "Runs migrations",
      "Approves runs",
      "Manages people",
    ]);
  });

  it("answers no to all four for a role that only looks", () => {
    expect(answers("viewer", VIEWER)).toEqual(["No", "No", "No", "No"]);
  });

  it("answers yes to all four for Admin, with the connection's own limit on migrations", () => {
    expect(answers("admin", [])).toEqual(["Yes", "Yes, where the connection allows", "Yes", "Yes"]);
  });

  it("counts managing people only when the role can change who is in", () => {
    expect(answers("qa_lead", ["users:read"])[3]).toBe("No");
    const people = answers("qa_lead", ["users:read", "users:update"]);
    expect(people[0]).toBe("Yes");
    expect(people[3]).toBe("Yes");
  });

  it("counts approving runs apart from seeing the approvals", () => {
    expect(answers("qa_lead", ["approvals:read"])[2]).toBe("No");
    expect(answers("qa_lead", ["approvals:read", "approvals:approve"])[2]).toBe("Yes");
  });

  it("words a row as no, yes, or yes with its limit", () => {
    expect(glanceValue({ label: "x", yes: false, detail: "d" })).toBe("No");
    expect(glanceValue({ label: "x", yes: true, detail: null })).toBe("Yes");
    expect(glanceValue({ label: "x", yes: true, detail: "d" })).toBe("Yes, d");
  });
});

describe("toggleHint", () => {
  it("says when a tick also turned on the see line it needs", () => {
    expect(toggleHint([], "connections:update", true)).toEqual({
      key: "connections:update",
      feature: "connections",
      text: "Also turned on “See saved connections”, because “Edit or test a saved connection” needs it.",
    });
  });

  it("says nothing when the tick did nothing else", () => {
    // The see line was already on.
    expect(toggleHint(["connections:read"], "connections:update", true)).toBeNull();
    // A see line needs nothing.
    expect(toggleHint([], "connections:read", true)).toBeNull();
    // Turning off a line under the see line touches nothing else.
    expect(
      toggleHint(["connections:read", "connections:update"], "connections:update", false)
    ).toBeNull();
    // Turning off a see line with nothing under it.
    expect(toggleHint(["connections:read"], "connections:read", false)).toBeNull();
    expect(toggleHint([], GONE, true)).toBeNull();
  });

  it("says which lines went with an unticked see line", () => {
    expect(
      toggleHint(["connections:read", "connections:update"], "connections:read", false)?.text
    ).toBe("Also turned off “Edit or test a saved connection”, because it needs “See saved connections”.");
    expect(
      toggleHint(
        ["connections:read", "connections:create", "connections:update"],
        "connections:read",
        false
      )
    ).toEqual({
      key: "connections:read",
      feature: "connections",
      text:
        "Also turned off “Add a connection” and “Edit or test a saved connection”, " +
        "because they need “See saved connections”.",
    });
  });
});

describe("changeSentences", () => {
  const withoutCompare = VIEWER.filter((key) => key !== "compare:read");

  it("says what will be gained, then what will be lost", () => {
    const gained = "Viewer will be able to add a connection.";
    const lost = "Viewer will no longer be able to compare schemas.";
    expect(changeSentences("Viewer", VIEWER, [...VIEWER, "connections:create"])).toEqual([gained]);
    expect(changeSentences("Viewer", VIEWER, withoutCompare)).toEqual([lost]);
    expect(
      changeSentences("Viewer", VIEWER, [...withoutCompare, "connections:create"])
    ).toEqual([gained, lost]);
  });

  it("says nothing when nothing would change", () => {
    expect(changeSentences("Viewer", VIEWER, [...VIEWER])).toEqual([]);
  });

  it("lists the lines in the tab's order, see line first, whatever order they were ticked in", () => {
    expect(
      changeSentences(
        "QA Lead",
        ["dashboard:read"],
        ["dashboard:read", "connections:update", "connections:create", "connections:read"]
      )
    ).toEqual([
      "QA Lead will be able to see saved connections, add a connection and " +
        "edit or test a saved connection.",
    ]);
  });

  it("keeps a line with commas of its own in one piece", () => {
    expect(changeSentences("Editor", [], ["drift:read", "drift:update", "drift:run"])).toEqual([
      "Editor will be able to see tracked schemas and their drift; change schedules " +
        "and baselines, or acknowledge drift; and run a drift check.",
    ]);
  });
});

describe("lineName", () => {
  it("names a permission the way its line does", () => {
    expect(lineName("connections:create")).toBe("Add a connection");
  });

  it("keeps the key of a permission this build no longer has", () => {
    expect(lineName("old:thing")).toBe("old:thing");
  });
});
