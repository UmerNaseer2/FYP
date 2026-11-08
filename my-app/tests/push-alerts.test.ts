// What phone alerts say and who gets each one.
//
// A lock screen is public and a role can change at any time, so this checks the
// wording never carries more than a name, and that the list of who gets an alert
// comes from what each person may do now. Sending itself is in lib/push-send.ts,
// and tests/push-db.test.ts runs the device queries on a real database.
import type { AccessRequest } from "@/lib/access-requests";
import type { DeployApproval } from "@/lib/approvals-db";
import type { DriftRun } from "@/lib/drift-runner";
import type { Alert } from "@/lib/push-send";

const mockDevices = jest.fn();
jest.mock("../lib/push-db", () => ({
  subscriptionsInOrganization: (...args: unknown[]) => mockDevices(...args),
}));

const mockSend = jest.fn(async () => ({ sent: 1, failed: 0 }));
jest.mock("../lib/push-send", () => ({
  sendAlert: (...args: unknown[]) => (mockSend as jest.Mock)(...args),
}));

const mockRoles: Record<string, string[]> = {};
jest.mock("../lib/roles-db", () => ({
  getRoleAccess: async (_orgId: number, role: string) =>
    mockRoles[role] ? { role, roleLabel: role, permissions: mockRoles[role] } : null,
}));

const mockQuery = jest.fn();
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import {
  afterResponse,
  alertDriftChange,
  alertRequestAnswered,
  alertRequestMade,
  alertRunDecided,
  alertRunWaiting,
  cleanName,
  driftAlertKind,
  driftAlertText,
  subjectOf,
} from "../lib/push-alerts";

const ACTOR = { orgId: 7, orgSlug: "swinburne-fyp", orgName: "Swinburne FYP" };

function device(id: number, email: string, role: string) {
  return { id, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: "k", auth: "a", profileId: id, email, role };
}

const ADA = device(1, "ada@example.test", "admin");
const VIC = device(2, "vic@example.test", "viewer");
const EVE = device(3, "eve@example.test", "editor");

/** Who the one alert went to, and what it said. */
function sentOnce(): { to: number[]; alert: Alert } {
  expect(mockSend).toHaveBeenCalledTimes(1);
  const [devices, alert] = (mockSend as jest.Mock).mock.calls[0] as [{ id: number }[], Alert];
  return { to: devices.map((d) => d.id).sort(), alert };
}

function run(over: Partial<DriftRun> = {}): DriftRun {
  return {
    trackedSchemaId: 4,
    status: "drifted",
    summary: "1 change",
    counts: null,
    report: null,
    expected: null,
    checkedAt: "2026-11-01T00:00:00Z",
    recorded: true,
    fingerprint: "new",
    previous: null,
    ...over,
  } as DriftRun;
}

function approval(over: Partial<DeployApproval> = {}): DeployApproval {
  return {
    id: 9,
    connection_id: 3,
    schema_name: "shop",
    requested_by: "vic@example.test",
    decided_by: null,
    status: "pending",
    action: "deploy",
    ...over,
  } as DeployApproval;
}

function request(over: Partial<AccessRequest> = {}): AccessRequest {
  return {
    id: 5,
    requested_by: "vic@example.test",
    requested_by_name: "Vic Secretname",
    permission: "scripts:create",
    message: "a private reason",
    status: "open",
    decided_by: null,
    ...over,
  } as AccessRequest;
}

beforeEach(() => {
  mockSend.mockClear();
  mockDevices.mockReset();
  mockDevices.mockResolvedValue([ADA, VIC, EVE]);
  mockQuery.mockReset();
  Object.keys(mockRoles).forEach((key) => delete mockRoles[key]);
  Object.assign(mockRoles, {
    admin: ["drift:read", "approvals:approve", "users:update"],
    editor: ["drift:read"],
    viewer: [],
  });
});

describe("driftAlertKind", () => {
  it.each([
    // status, before, this fingerprint, last fingerprint, the alert
    ["drifted", null, "a", null, "drifted"],
    ["drifted", "in_sync", "a", null, "drifted"],
    ["drifted", "drifted", "a", "a", null],
    ["drifted", "drifted", "b", "a", "changed"],
    // Nothing to compare against says nothing new, rather than a false "changed".
    ["drifted", "drifted", "b", null, null],
    ["drifted", "drifted", null, "a", null],
    ["drifted", "unreachable", "a", null, "reachable"],
    ["in_sync", null, null, null, null],
    ["in_sync", "in_sync", null, null, null],
    ["in_sync", "drifted", null, "a", "in_sync"],
    ["in_sync", "unreachable", null, null, "reachable"],
    ["unreachable", null, null, null, "unreachable"],
    ["unreachable", "in_sync", null, null, "unreachable"],
    ["unreachable", "unreachable", null, null, null],
    ["something new", "drifted", null, null, null],
  ])("%s after %s (%s, %s) is %s", (status, before, fingerprint, last, expected) => {
    expect(driftAlertKind(status, before, fingerprint, last)).toBe(expected);
  });
});

describe("the wording", () => {
  it("says what happened, in words a person would use", () => {
    expect(driftAlertText("drifted", "shop on Live", "drifted")).toEqual({
      title: "Drift found",
      body: "shop on Live no longer matches its baseline.",
    });
    expect(driftAlertText("changed", "shop", "drifted").body).toBe("The drift in shop has changed.");
    expect(driftAlertText("in_sync", "shop", "in_sync").title).toBe("Back in sync");
    expect(driftAlertText("unreachable", "shop", "unreachable").title).toBe("Database not reachable");
  });

  it("adds the AI's line to a new or changed drift, and to nothing else", () => {
    const line = "Live lost old_notes and books.price.";
    expect(driftAlertText("drifted", "shop", "drifted", line).body).toBe(
      "shop no longer matches its baseline. Live lost old_notes and books.price."
    );
    expect(driftAlertText("changed", "shop", "drifted", line).body).toBe(
      "The drift in shop has changed. Live lost old_notes and books.price."
    );
    expect(driftAlertText("in_sync", "shop", "in_sync", line).body).toBe("shop matches its baseline again.");
    expect(driftAlertText("drifted", "shop", "drifted", null).body).toBe("shop no longer matches its baseline.");
  });

  it("says whether a database that came back still matches", () => {
    expect(driftAlertText("reachable", "shop", "in_sync").body).toContain("and it matches its baseline");
    expect(driftAlertText("reachable", "shop", "drifted").body).toContain("but it differs from its baseline");
  });

  it("names the connection only when there is one", () => {
    expect(subjectOf("shop", "Live")).toBe("shop on Live");
    expect(subjectOf("shop", null)).toBe("shop");
  });
});

describe("cleanName", () => {
  it("removes what could rearrange or break a line", () => {
    expect(cleanName("  sh‮op​\n\tnow ")).toBe("shop now");
  });

  it("calls a name with nothing visible in it no name at all", () => {
    expect(cleanName(null)).toBeNull();
    expect(cleanName(" ​\n ")).toBeNull();
  });

  it("cuts a long name by whole characters", () => {
    const name = "🦊".repeat(60);
    const cut = cleanName(name) as string;
    expect(Array.from(cut)).toHaveLength(48);
    expect(cut.endsWith("\u{2026}")).toBe(true);
    expect(cleanName("a".repeat(48))).toBe("a".repeat(48));
  });
});

describe("alertDriftChange", () => {
  const FOUND = {
    rows: [{ slug: "swinburne-fyp", schema_name: "shop", label: null, connection_name: "Live" }],
  };

  it("tells everyone who may read drift, and leads to the phone app", async () => {
    mockQuery.mockResolvedValue(FOUND);
    await alertDriftChange(7, run());
    const { to, alert } = sentOnce();
    expect(to).toEqual([ADA.id, EVE.id]);
    expect(alert).toEqual({
      kind: "drift",
      title: "Drift found",
      body: "shop on Live no longer matches its baseline.",
      url: "/swinburne-fyp/phone",
    });
  });

  it("carries the AI's line on the drift when the check wrote one", async () => {
    mockQuery.mockResolvedValue(FOUND);
    await alertDriftChange(7, run({ aiSummary: "Live lost old_notes." }));
    expect(sentOnce().alert.body).toBe("shop on Live no longer matches its baseline. Live lost old_notes.");
  });

  it("prefers the label people gave a schema", async () => {
    mockQuery.mockResolvedValue({ rows: [{ ...FOUND.rows[0], label: "Bookshop" }] });
    await alertDriftChange(7, run());
    expect(sentOnce().alert.body).toBe("Bookshop on Live no longer matches its baseline.");
  });

  it("keeps its query inside the organization", async () => {
    mockQuery.mockResolvedValue(FOUND);
    await alertDriftChange(7, run());
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain("t.org_id = $2");
    expect(sql).toContain("c.org_id = t.org_id");
    expect(values).toEqual([4, 7]);
  });

  it("stays quiet about a check that was not recorded, and spends nothing finding out", async () => {
    await alertDriftChange(7, run({ recorded: false }));
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("stays quiet when it could not read the last outcome, rather than guess", async () => {
    await alertDriftChange(7, run({ previous: undefined }));
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("stays quiet about a first check that finds everything in order", async () => {
    await alertDriftChange(7, run({ status: "in_sync", fingerprint: null }));
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("compares with the last outcome", async () => {
    mockQuery.mockResolvedValue(FOUND);
    await alertDriftChange(7, run({ fingerprint: "b", previous: { status: "drifted", fingerprint: "a" } }));
    expect(sentOnce().alert.title).toBe("Drift changed");
  });

  it("sends nothing for a schema that has gone", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await alertDriftChange(7, run());
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not fail the check when anything goes wrong, and logs no detail", async () => {
    const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockQuery.mockRejectedValue(new Error("db.secret.example refused"));
    await expect(alertDriftChange(7, run())).resolves.toBeUndefined();
    expect(JSON.stringify(quiet.mock.calls)).not.toContain("db.secret.example");
    quiet.mockRestore();
  });
});

describe("the alerts about runs", () => {
  beforeEach(() => mockQuery.mockResolvedValue({ rows: [{ name: "Live" }] }));

  it("asks those who can approve, apart from the person asking", async () => {
    Object.assign(mockRoles, { viewer: ["approvals:approve"] });
    await alertRunWaiting(ACTOR, approval({ requested_by: "VIC@example.test" }));
    const { to, alert } = sentOnce();
    expect(to).toEqual([ADA.id]);
    expect(alert.title).toBe("Approval needed");
    expect(alert.body).toBe("A deploy of shop on Live is waiting for approval.");
    expect(alert.url).toBe("/swinburne-fyp/phone?tab=approvals");
  });

  it("calls a rollback a rollback", async () => {
    await alertRunWaiting(ACTOR, approval({ action: "revert" }));
    expect(sentOnce().alert.body).toBe("A rollback of shop on Live is waiting for approval.");
  });

  it("looks up the connection inside the organization", async () => {
    await alertRunWaiting(ACTOR, approval());
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain("org_id = $2");
    expect(values).toEqual([3, 7]);
  });

  it("tells the person who asked how it was decided, and no one else", async () => {
    await alertRunDecided(ACTOR, approval({ status: "approved", decided_by: "ada@example.test" }));
    const { to, alert } = sentOnce();
    expect(to).toEqual([VIC.id]);
    expect(alert.title).toBe("Run approved");
    expect(alert.body).toBe("Your deploy of shop on Live was approved.");
  });

  it("says when a run was rejected", async () => {
    await alertRunDecided(ACTOR, approval({ status: "rejected", decided_by: "ada@example.test" }));
    expect(sentOnce().alert.title).toBe("Run rejected");
  });

  it("does not tell people what they just did themselves", async () => {
    await alertRunDecided(ACTOR, approval({ status: "approved", decided_by: "Vic@example.test" }));
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("the alerts about requests", () => {
  it("asks those who can answer, and shows neither a name nor a message", async () => {
    await alertRequestMade(ACTOR, request());
    const { to, alert } = sentOnce();
    expect(to).toEqual([ADA.id]);
    expect(alert.title).toBe("Access request");
    expect(alert.body).toContain("Swinburne FYP");
    expect(JSON.stringify(alert)).not.toContain("Secretname");
    expect(JSON.stringify(alert)).not.toContain("private reason");
  });

  it("copes with a request that is not for any one permission", async () => {
    await alertRequestMade(ACTOR, request({ permission: null }));
    expect(sentOnce().alert.body).toBe("A member of Swinburne FYP sent a request.");
  });

  it.each([
    ["allowed", "was allowed"],
    ["declined", "was declined"],
    ["done", "was marked as done"],
  ])("tells the person who asked when it is %s", async (status, words) => {
    await alertRequestAnswered(
      ACTOR,
      request({ status: status as AccessRequest["status"], decided_by: "ada@example.test" })
    );
    const { to, alert } = sentOnce();
    expect(to).toEqual([VIC.id]);
    expect(alert.body).toContain(words);
  });

  it("does not tell people about their own answer", async () => {
    await alertRequestAnswered(ACTOR, request({ status: "done", decided_by: "vic@example.test" }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("leaves out anyone whose role no longer exists", async () => {
    delete mockRoles.admin;
    await alertRequestMade(ACTOR, request());
    expect(sentOnce().to).toEqual([]);
  });

  it("reads each role once, however many people hold it", async () => {
    mockDevices.mockResolvedValue([ADA, device(8, "a2@example.test", "admin"), device(9, "a3@example.test", "admin")]);
    await alertRequestMade(ACTOR, request());
    expect(sentOnce().to).toEqual([1, 8, 9]);
  });
});

describe("afterResponse", () => {
  it("does nothing outside a request, rather than throw", () => {
    const task = jest.fn(async () => undefined);
    expect(() => afterResponse(task)).not.toThrow();
  });
});
