// The Requests routes: who gets to read what, and every refusal a person can get.
//
// The gate and the stores are replaced, so this is about the routes' own
// decisions. tests/access-requests-db.test.ts runs the queries on a real database.
import { NextRequest, NextResponse } from "next/server";
import type { AccessRequest } from "@/lib/access-requests";
import type { Gate } from "@/lib/auth-guard";
import type { PermissionKey } from "@/lib/permissions";
import { principalFor, TEST_ORG } from "./helpers/principals";

let mockGate: Gate;
jest.mock("../lib/auth-guard", () => ({
  requireMember: async () => mockGate,
}));

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/access-requests-db", () => ({
  answerAccessRequest: jest.fn(),
  countRequestInbox: jest.fn(),
  countRequestsAnsweredSince: jest.fn(),
  createAccessRequest: jest.fn(),
  endGrant: jest.fn(),
  getAccessRequest: jest.fn(),
  grantAccessRequest: jest.fn(),
  listActiveGrants: jest.fn(),
  listOwnRequests: jest.fn(),
  listRequestInbox: jest.fn(),
  markRequestsSeen: jest.fn(),
  readRequestsSeen: jest.fn(),
  withdrawAccessRequest: jest.fn(),
}));

jest.mock("../lib/approvals-db", () => ({
  countOwnRunsAnsweredSince: jest.fn(),
  countRunsReadyToRun: jest.fn(),
  countRunsToApprove: jest.fn(),
  listOwnRuns: jest.fn(),
  listRunsReadyToRun: jest.fn(),
  listRunsToApprove: jest.fn(),
  // The real rule, because which runs a person sees depends on it.
  mayDecideOwn: (principal: { bypass: boolean }) => principal.bypass,
}));

// Alerts are looked at in tests/push-alerts.test.ts. Here only: are they sent?
jest.mock("../lib/push-alerts", () => ({
  afterResponse: (task: () => Promise<void>) => void task(),
  alertRequestMade: jest.fn(async () => undefined),
  alertRequestAnswered: jest.fn(async () => undefined),
}));

import * as pushAlerts from "../lib/push-alerts";
import * as requestsDb from "../lib/access-requests-db";
import * as approvalsDb from "../lib/approvals-db";
import { GET, POST } from "../app/api/requests/route";
import { PATCH } from "../app/api/requests/[id]/route";
import { POST as SEEN } from "../app/api/requests/seen/route";

const db = jest.mocked(requestsDb);
const runs = jest.mocked(approvalsDb);

const NOT_A_MEMBER = (): Gate => ({
  ok: false,
  response: NextResponse.json({ error: "Not found." }, { status: 404 }),
});

/** A member of a custom role holding exactly these, to show each one counts on its own. */
function holding(...permissions: PermissionKey[]): Gate {
  return { ok: true, principal: principalFor("viewer", { permissions }) };
}

function as(role: "viewer" | "editor" | "admin", over = {}): Gate {
  return { ok: true, principal: principalFor(role, over) };
}

function getRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/requests${query}`);
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/requests", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function patch(id: string, body: unknown) {
  return PATCH(
    new NextRequest(`http://localhost/api/requests/${id}`, {
      method: "PATCH",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

/** A stored request. Only what the routes look at matters here. */
function stored(over: Partial<AccessRequest> = {}): AccessRequest {
  return {
    id: 5,
    requested_by: "someone@test",
    requested_by_name: "Someone",
    permission: "deploy:run",
    message: null,
    status: "pending",
    decided_by: null,
    decided_at: null,
    decision_note: null,
    created_at: "2026-11-01T00:00:00.000Z",
    granted_until: null,
    ...over,
  };
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  jest.resetAllMocks();
  consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  mockGate = as("viewer");
  db.countRequestInbox.mockResolvedValue(0);
  db.countRequestsAnsweredSince.mockResolvedValue(0);
  db.listOwnRequests.mockResolvedValue([]);
  db.listRequestInbox.mockResolvedValue([]);
  db.listActiveGrants.mockResolvedValue([]);
  db.readRequestsSeen.mockResolvedValue(null);
  runs.countOwnRunsAnsweredSince.mockResolvedValue(0);
  runs.countRunsReadyToRun.mockResolvedValue(0);
  runs.countRunsToApprove.mockResolvedValue(0);
  runs.listOwnRuns.mockResolvedValue([]);
  runs.listRunsReadyToRun.mockResolvedValue([]);
  runs.listRunsToApprove.mockResolvedValue([]);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("GET /api/requests?only=counts", () => {
  it("passes the gate's refusal on", async () => {
    mockGate = NOT_A_MEMBER();
    const response = await GET(getRequest("?only=counts"));
    expect(response.status).toBe(404);
    expect(db.countRequestsAnsweredSince).not.toHaveBeenCalled();
  });

  it("gives a Viewer nothing to do, and asks no store about other people's work", async () => {
    db.countRequestInbox.mockResolvedValue(9);
    runs.countRunsToApprove.mockResolvedValue(9);
    runs.countRunsReadyToRun.mockResolvedValue(9);
    const response = await GET(getRequest("?only=counts"));
    expect(await response.json()).toEqual({ counts: { waiting: 0, answered: 0 } });
    expect(db.countRequestInbox).not.toHaveBeenCalled();
    expect(runs.countRunsToApprove).not.toHaveBeenCalled();
    expect(runs.countRunsReadyToRun).not.toHaveBeenCalled();
  });

  it("adds up what is waiting on an Admin", async () => {
    mockGate = as("admin");
    db.countRequestInbox.mockResolvedValue(2);
    runs.countRunsToApprove.mockResolvedValue(3);
    runs.countRunsReadyToRun.mockResolvedValue(4);
    const body = await (await GET(getRequest("?only=counts"))).json();
    expect(body.counts.waiting).toBe(9);
  });

  it.each<[string, PermissionKey[], number]>([
    ["Users: Update", ["users:update"], 1],
    ["Roles: Update", ["roles:update"], 1],
    ["Approvals: Approve", ["approvals:approve"], 10],
    ["Deploy: Run", ["deploy:run"], 100],
  ])("counts the one thing %s can act on", async (_name, permissions, expected) => {
    mockGate = holding(...permissions);
    db.countRequestInbox.mockResolvedValue(1);
    runs.countRunsToApprove.mockResolvedValue(10);
    runs.countRunsReadyToRun.mockResolvedValue(100);
    const body = await (await GET(getRequest("?only=counts"))).json();
    expect(body.counts.waiting).toBe(expected);
  });

  it("leaves your own run out of what you can approve", async () => {
    mockGate = as("admin");
    await GET(getRequest("?only=counts"));
    expect(runs.countRunsToApprove).toHaveBeenCalledWith(TEST_ORG.id, "admin@test");
  });

  it("keeps your own run in under the bypass, which may decide its own", async () => {
    mockGate = as("admin", { bypass: true });
    await GET(getRequest("?only=counts"));
    expect(runs.countRunsToApprove).toHaveBeenCalledWith(TEST_ORG.id, null);
  });

  it("counts answers given since the person last looked, requests and runs together", async () => {
    const since = "2026-10-31T00:00:00.000Z";
    db.readRequestsSeen.mockResolvedValue(since);
    db.countRequestsAnsweredSince.mockResolvedValue(2);
    runs.countOwnRunsAnsweredSince.mockResolvedValue(3);
    const body = await (await GET(getRequest("?only=counts"))).json();
    expect(body.counts.answered).toBe(5);
    expect(db.countRequestsAnsweredSince).toHaveBeenCalledWith(TEST_ORG.id, "viewer@test", since);
    expect(runs.countOwnRunsAnsweredSince).toHaveBeenCalledWith(TEST_ORG.id, "viewer@test", since);
  });

  it("has nothing unread for someone with no profile of their own", async () => {
    mockGate = as("admin", { profileId: null, bypass: true });
    db.countRequestsAnsweredSince.mockResolvedValue(2);
    const body = await (await GET(getRequest("?only=counts"))).json();
    expect(body.counts.answered).toBe(0);
    expect(db.readRequestsSeen).not.toHaveBeenCalled();
  });

  it("answers 500 in fixed words when a store fails", async () => {
    db.readRequestsSeen.mockRejectedValue(new Error("connection refused at 10.0.0.1"));
    const response = await GET(getRequest("?only=counts"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not load requests." });
  });
});

describe("GET /api/requests", () => {
  it("gives a Viewer their own and nothing of anyone else's", async () => {
    const own = stored();
    db.listOwnRequests.mockResolvedValue([own]);
    db.listRequestInbox.mockResolvedValue([{ ...stored(), member_id: 1 } as never]);
    runs.listRunsToApprove.mockResolvedValue([{ id: 1 } as never]);
    runs.listRunsReadyToRun.mockResolvedValue([{ id: 2 } as never]);

    const body = await (await GET(getRequest())).json();

    expect(body.mine).toHaveLength(1);
    expect(body.inbox).toEqual([]);
    expect(body.runsToApprove).toEqual([]);
    expect(body.runsToRun).toEqual([]);
    expect(body.lent).toEqual([]);
    expect(body.canAnswer).toBe(false);
    expect(db.listActiveGrants).not.toHaveBeenCalled();
    expect(db.listRequestInbox).not.toHaveBeenCalled();
    expect(runs.listRunsToApprove).not.toHaveBeenCalled();
    expect(runs.listRunsReadyToRun).not.toHaveBeenCalled();
  });

  it("gives an Admin the inbox and the runs waiting on someone", async () => {
    mockGate = as("admin");
    db.listRequestInbox.mockResolvedValue([{ ...stored(), member_id: 1 } as never]);
    runs.listRunsToApprove.mockResolvedValue([{ id: 1 } as never]);
    runs.listRunsReadyToRun.mockResolvedValue([{ id: 2 } as never, { id: 3 } as never]);

    const body = await (await GET(getRequest())).json();

    expect(body.canAnswer).toBe(true);
    expect(body.inbox).toHaveLength(1);
    expect(body.runsToApprove).toHaveLength(1);
    expect(body.runsToRun).toHaveLength(2);
    expect(body.lent).toEqual([]);
    expect(db.listActiveGrants).toHaveBeenCalledWith(TEST_ORG.id);
    expect(db.listRequestInbox).toHaveBeenCalledWith(TEST_ORG.id, "admin@test");
    expect(runs.listRunsToApprove).toHaveBeenCalledWith(TEST_ORG.id, "admin@test");
  });

  it("says when the person last looked, so the page can mark what is new", async () => {
    db.readRequestsSeen.mockResolvedValue("2026-10-31T00:00:00.000Z");
    const body = await (await GET(getRequest())).json();
    expect(body.lastSeenAt).toBe("2026-10-31T00:00:00.000Z");
  });

  it("answers 500 in fixed words when a store fails", async () => {
    db.listOwnRequests.mockRejectedValue(new Error("connection refused at 10.0.0.1"));
    const response = await GET(getRequest());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not load requests." });
  });
});

describe("POST /api/requests", () => {
  it("passes the gate's refusal on", async () => {
    mockGate = NOT_A_MEMBER();
    const response = await POST(postRequest({ permission: "deploy:run", message: "" }));
    expect(response.status).toBe(404);
    expect(db.createAccessRequest).not.toHaveBeenCalled();
  });

  it.each<[string, unknown, number, string | RegExp]>([
    ["a body that is not JSON", "{nope", 400, "Say what you need."],
    ["a body that is not an object", "[1]", 400, "Say what you need."],
    ["a key that does not exist", { permission: "deploy:fly", message: "" }, 400, "Pick something from the list."],
    ["a key that is not text", { permission: 7, message: "" }, 400, "Pick something from the list."],
    ["something only admins can do", { permission: "roles:update", message: "" }, 400, /^Only admins can do that\./],
    ["something the role already holds", { permission: "dashboard:read", message: "" }, 400, "Your role can already do that."],
    ["something else, with nothing said", { permission: null, message: "   " }, 400, "Say what you need."],
    ["a message over the limit", { permission: null, message: "x".repeat(501) }, 400, "Keep it to 500 characters."],
  ])("refuses %s", async (_name, body, status, words) => {
    const response = await POST(postRequest(body));
    expect(response.status).toBe(status);
    const { error } = await response.json();
    if (typeof words === "string") expect(error).toBe(words);
    else expect(error).toMatch(words);
    expect(db.createAccessRequest).not.toHaveBeenCalled();
  });

  it("stores a permission request under the person who is signed in", async () => {
    db.createAccessRequest.mockResolvedValue({ kind: "created", request: stored() });
    const response = await POST(
      postRequest({
        permission: "deploy:run",
        message: "  for the release  ",
        // Whatever a caller claims about who they are is not read.
        email: "someone-else@test",
        name: "Someone else",
      })
    );
    expect(response.status).toBe(201);
    expect((await response.json()).already).toBe(false);
    expect(db.createAccessRequest).toHaveBeenCalledWith({
      orgId: TEST_ORG.id,
      email: "viewer@test",
      name: "A viewer",
      permission: "deploy:run",
      message: "for the release",
    });
    expect(pushAlerts.alertRequestMade).toHaveBeenCalledTimes(1);
  });

  it("stores an empty reason as nothing", async () => {
    db.createAccessRequest.mockResolvedValue({ kind: "created", request: stored() });
    await POST(postRequest({ permission: "deploy:run", message: "  " }));
    expect(db.createAccessRequest.mock.calls[0][0].message).toBeNull();
  });

  it("takes something else, once it says what", async () => {
    db.createAccessRequest.mockResolvedValue({ kind: "created", request: stored() });
    const response = await POST(postRequest({ permission: null, message: "A role in between." }));
    expect(response.status).toBe(201);
    expect(db.createAccessRequest.mock.calls[0][0].permission).toBeNull();
  });

  it("answers with the one still waiting when asked twice", async () => {
    db.createAccessRequest.mockResolvedValue({ kind: "already", request: stored() });
    const response = await POST(postRequest({ permission: "deploy:run", message: "" }));
    expect(response.status).toBe(200);
    expect((await response.json()).already).toBe(true);
    // They have already been told about this one.
    expect(pushAlerts.alertRequestMade).not.toHaveBeenCalled();
  });

  it("says how to go on once too many are waiting", async () => {
    db.createAccessRequest.mockResolvedValue({ kind: "too-many" });
    const response = await POST(postRequest({ permission: "deploy:run", message: "" }));
    expect(response.status).toBe(429);
    expect((await response.json()).error).toBe(
      "You have 20 requests waiting. Withdraw one, or wait for an answer, before asking for more."
    );
  });

  it("answers 500 in fixed words when the store fails", async () => {
    db.createAccessRequest.mockRejectedValue(new Error("connection refused at 10.0.0.1"));
    const response = await POST(postRequest({ permission: "deploy:run", message: "" }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not send your request." });
  });
});

describe("PATCH /api/requests/[id]", () => {
  const ANSWER = { action: "answer", answer: "allowed", note: "" };

  it("passes the gate's refusal on", async () => {
    mockGate = NOT_A_MEMBER();
    expect((await patch("5", ANSWER)).status).toBe(404);
    expect(db.getAccessRequest).not.toHaveBeenCalled();
  });

  it.each(["abc", "0", "-1", "1.5"])("treats the id %s as a request that does not exist", async (id) => {
    const response = await patch(id, ANSWER);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "That request does not exist." });
    expect(db.getAccessRequest).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ["a body that is not JSON", "{nope"],
    ["no action", {}],
    ["an action it does not know", { action: "delete" }],
  ])("refuses %s", async (_name, body) => {
    const response = await patch("5", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Say what to do with this request." });
  });

  it("looks the request up inside the caller's organization only", async () => {
    mockGate = as("admin");
    db.getAccessRequest.mockResolvedValue(null);
    const response = await patch("5", ANSWER);
    expect(response.status).toBe(404);
    expect(db.getAccessRequest).toHaveBeenCalledWith(TEST_ORG.id, 5);
    expect(db.answerAccessRequest).not.toHaveBeenCalled();
  });

  describe("withdrawing", () => {
    const WITHDRAW = { action: "withdraw" };

    it("lets the person who asked take it back, whatever their role", async () => {
      db.getAccessRequest.mockResolvedValue(stored({ requested_by: "VIEWER@test" }));
      db.withdrawAccessRequest.mockResolvedValue(stored({ status: "withdrawn" }));
      const response = await patch("5", WITHDRAW);
      expect(response.status).toBe(200);
      expect((await response.json()).request.status).toBe("withdrawn");
      expect(db.withdrawAccessRequest).toHaveBeenCalledWith(TEST_ORG.id, 5, "viewer@test");
    });

    it("refuses anyone else, an Admin too", async () => {
      mockGate = as("admin");
      db.getAccessRequest.mockResolvedValue(stored());
      const response = await patch("5", WITHDRAW);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only the person who asked can withdraw this." });
      expect(db.withdrawAccessRequest).not.toHaveBeenCalled();
    });

    it("says so when it was answered first", async () => {
      db.getAccessRequest.mockResolvedValue(stored({ requested_by: "viewer@test" }));
      db.withdrawAccessRequest.mockResolvedValue(null);
      const response = await patch("5", WITHDRAW);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "That request has already been answered." });
    });
  });

  describe("answering", () => {
    beforeEach(() => {
      db.getAccessRequest.mockResolvedValue(stored());
    });

    it("refuses a role that can't change roles or users", async () => {
      mockGate = as("editor");
      const response = await patch("5", ANSWER);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Your role (Editor) can't answer requests." });
      expect(db.answerAccessRequest).not.toHaveBeenCalled();
    });

    it.each<[string, PermissionKey]>([
      ["Users: Update", "users:update"],
      ["Roles: Update", "roles:update"],
    ])("lets %s answer", async (_name, permission) => {
      mockGate = holding(permission);
      db.answerAccessRequest.mockResolvedValue(stored({ status: "allowed" }));
      expect((await patch("5", ANSWER)).status).toBe(200);
    });

    it("refuses your own, in any spelling of your address", async () => {
      mockGate = as("admin");
      db.getAccessRequest.mockResolvedValue(stored({ requested_by: "ADMIN@test" }));
      const response = await patch("5", ANSWER);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "You can't answer your own request." });
    });

    it.each([["withdrawn"], ["pending"], [undefined], [7]])("refuses the answer %s", async (answer) => {
      mockGate = as("admin");
      const response = await patch("5", { action: "answer", answer });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Say how you are answering." });
    });

    it("refuses a note over the limit", async () => {
      mockGate = as("admin");
      const response = await patch("5", { ...ANSWER, note: "x".repeat(501) });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Keep the note to 500 characters." });
    });

    it.each(["allowed", "declined", "done"])("records %s under the person answering", async (answer) => {
      mockGate = as("admin");
      db.answerAccessRequest.mockResolvedValue(stored({ status: answer as never }));
      const response = await patch("5", { action: "answer", answer, note: "  Sorted.  " });
      expect(response.status).toBe(200);
      expect(db.answerAccessRequest).toHaveBeenCalledWith(TEST_ORG.id, 5, answer, "admin@test", "Sorted.");
      expect(pushAlerts.alertRequestAnswered).toHaveBeenCalledTimes(1);
    });

    it("stores an empty note as nothing", async () => {
      mockGate = as("admin");
      db.answerAccessRequest.mockResolvedValue(stored({ status: "done" }));
      await patch("5", { action: "answer", answer: "done", note: "  " });
      expect(db.answerAccessRequest.mock.calls[0][4]).toBeNull();
    });

    it("says so when someone else answered first", async () => {
      mockGate = as("admin");
      db.answerAccessRequest.mockResolvedValue(null);
      const response = await patch("5", ANSWER);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "That request has already been answered." });
    });

    it("answers 500 in fixed words when the store fails", async () => {
      mockGate = as("admin");
      db.answerAccessRequest.mockRejectedValue(new Error("connection refused at 10.0.0.1"));
      const response = await patch("5", ANSWER);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Could not update this request." });
    });
  });

  describe("allowing just the asker for a day", () => {
    const GRANT = { action: "grant", note: "  For the demo.  " };

    beforeEach(() => {
      db.getAccessRequest.mockResolvedValue(stored());
    });

    it("lets an Admin allow it, under their name, and tells the asker", async () => {
      mockGate = as("admin");
      db.grantAccessRequest.mockResolvedValue(stored({ status: "allowed", granted_until: "2026-11-02T00:00:00.000Z" }));
      const response = await patch("5", GRANT);
      expect(response.status).toBe(200);
      expect(db.grantAccessRequest).toHaveBeenCalledWith(TEST_ORG.id, 5, "admin@test", "For the demo.");
      expect(db.answerAccessRequest).not.toHaveBeenCalled();
      expect(pushAlerts.alertRequestAnswered).toHaveBeenCalledTimes(1);
    });

    it("refuses a role that can't answer requests", async () => {
      mockGate = as("editor");
      expect((await patch("5", GRANT)).status).toBe(403);
      expect(db.grantAccessRequest).not.toHaveBeenCalled();
    });

    it("refuses your own", async () => {
      mockGate = as("admin");
      db.getAccessRequest.mockResolvedValue(stored({ requested_by: "admin@test" }));
      const response = await patch("5", GRANT);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "You can't answer your own request." });
      expect(db.grantAccessRequest).not.toHaveBeenCalled();
    });

    it("refuses what only an Admin may ever do", async () => {
      mockGate = as("admin");
      db.getAccessRequest.mockResolvedValue(stored({ permission: "roles:update" }));
      const response = await patch("5", GRANT);
      expect(response.status).toBe(403);
      expect((await response.json()).error).toMatch(/Make them an Admin instead/);
      expect(db.grantAccessRequest).not.toHaveBeenCalled();
    });

    it("refuses a request that is not for one permission", async () => {
      mockGate = as("admin");
      db.getAccessRequest.mockResolvedValue(stored({ permission: null, message: "Something else" }));
      const response = await patch("5", GRANT);
      expect(response.status).toBe(403);
      expect(db.grantAccessRequest).not.toHaveBeenCalled();
    });

    it("refuses to lend what the person answering cannot do themselves", async () => {
      mockGate = holding("users:update");
      const response = await patch("5", GRANT);
      expect(response.status).toBe(403);
      expect((await response.json()).error).toMatch(/cannot do that yourself/);
      expect(db.grantAccessRequest).not.toHaveBeenCalled();
    });

    it("says so when someone else answered first", async () => {
      mockGate = as("admin");
      db.grantAccessRequest.mockResolvedValue(null);
      expect((await patch("5", GRANT)).status).toBe(409);
    });
  });

  describe("ending a day's allowance early", () => {
    const END = { action: "end-grant" };

    beforeEach(() => {
      db.getAccessRequest.mockResolvedValue(stored({ status: "allowed", granted_until: "2026-11-02T00:00:00.000Z" }));
    });

    it("lets an Admin end it", async () => {
      mockGate = as("admin");
      db.endGrant.mockResolvedValue(stored({ status: "allowed" }));
      expect((await patch("5", END)).status).toBe(200);
      expect(db.endGrant).toHaveBeenCalledWith(TEST_ORG.id, 5);
    });

    it("refuses the person it was given to, and anyone who can't answer requests", async () => {
      mockGate = as("viewer");
      db.getAccessRequest.mockResolvedValue(stored({ requested_by: "viewer@test", status: "allowed" }));
      expect((await patch("5", END)).status).toBe(403);
      mockGate = as("editor");
      expect((await patch("5", END)).status).toBe(403);
      expect(db.endGrant).not.toHaveBeenCalled();
    });

    it("says so when it has already ended", async () => {
      mockGate = as("admin");
      db.endGrant.mockResolvedValue(null);
      const response = await patch("5", END);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "That has already ended." });
    });
  });
});

describe("POST /api/requests/seen", () => {
  it("passes the gate's refusal on", async () => {
    mockGate = NOT_A_MEMBER();
    expect((await SEEN()).status).toBe(404);
    expect(db.markRequestsSeen).not.toHaveBeenCalled();
  });

  it("marks them seen for this person in this organization", async () => {
    const response = await SEEN();
    expect(await response.json()).toEqual({ ok: true });
    expect(db.markRequestsSeen).toHaveBeenCalledWith(TEST_ORG.id, 21);
  });

  it("has nothing to mark for someone with no profile of their own", async () => {
    mockGate = as("admin", { profileId: null, bypass: true });
    expect((await SEEN()).status).toBe(200);
    expect(db.markRequestsSeen).not.toHaveBeenCalled();
  });

  it("answers 500 in fixed words when the store fails", async () => {
    db.markRequestsSeen.mockRejectedValue(new Error("connection refused at 10.0.0.1"));
    const response = await SEEN();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not update this." });
  });
});
