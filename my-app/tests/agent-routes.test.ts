import { NextRequest, NextResponse } from "next/server";
import type { Gate } from "@/lib/auth-guard";
import { principalFor } from "./helpers/principals";

let mockGate: Gate;
const mockRequirePermission = jest.fn<Promise<Gate>, string[]>(async () => mockGate);
jest.mock("../lib/auth-guard", () => ({
  requirePermission: (...keys: string[]) => mockRequirePermission(...keys),
}));

jest.mock("../lib/agent-db", () => ({
  approveLink: jest.fn(),
  claimLink: jest.fn(),
  createAgentJob: jest.fn(),
  denyLink: jest.fn(),
  findAgent: jest.fn(),
  finishAgentJob: jest.fn(),
  listComputers: jest.fn(),
  nextAgentJob: jest.fn(),
  openLink: jest.fn(),
  readAgentJobFor: jest.fn(),
  readLink: jest.fn(),
  removeAgent: jest.fn(),
  removeComputer: jest.fn(),
  removeOrgComputer: jest.fn(),
  replaceAgentConnections: jest.fn(),
  runningJobMethod: jest.fn(),
}));

import * as agentDb from "../lib/agent-db";
import { POST as openLink } from "../app/api/agent/link/route";
import { POST as claim } from "../app/api/agent/link/claim/route";
import { POST as nextJob } from "../app/api/agent/jobs/next/route";
import { POST as answerJob } from "../app/api/agent/jobs/[id]/route";
import { PUT as putConnections } from "../app/api/agent/connections/route";
import { DELETE as unlinkSelf } from "../app/api/agent/self/route";
import { GET as computers } from "../app/api/computers/route";
import { DELETE as removeComputer } from "../app/api/computers/[id]/route";
import { DELETE as turnAway, GET as readLink, POST as approve } from "../app/api/computers/link/route";
import { POST as ask } from "../app/api/computers/jobs/route";
import { GET as readAnswer } from "../app/api/computers/jobs/[id]/route";
import { MAX_ANSWER_BYTES } from "../lib/agent-rules";

const db = jest.mocked(agentDb);

const SITE = "studio.example.test";
const TOKEN = "ssa_a-token-for-this-test";
const COMPUTER = { id: 41, orgId: 7, profileId: 12 };

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://${SITE}${path}`, {
    method,
    headers: { "content-type": "application/json", host: SITE, ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function fromComputer(method: string, path: string, body?: unknown): NextRequest {
  return call(method, path, body, { authorization: `Bearer ${TOKEN}` });
}

function idOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

const member = principalFor("editor", { profileId: 12 });
const inBypass = { ...member, profileId: null, bypass: true };
const admin = principalFor("admin", { profileId: 30 });

let errorLog: jest.SpyInstance;

beforeEach(() => {
  jest.resetAllMocks();
  mockRequirePermission.mockImplementation(async () => mockGate);
  mockGate = { ok: true, principal: member };
  db.findAgent.mockResolvedValue(COMPUTER);
  errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => errorLog.mockRestore());

/** Whatever a route logged, as one string, to check nothing secret got in. */
function logged(): string {
  return JSON.stringify(errorLog.mock.calls);
}

describe("POST /api/agent/link", () => {
  it("opens a link and says where to send the person", async () => {
    db.openLink.mockResolvedValue({ deviceCode: "device-secret", userCode: "BCDFGHJK" });
    const response = await openLink(call("POST", "/api/agent/link", { computerName: "  Ada's\nlaptop " }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      deviceCode: "device-secret",
      userCode: "BCDF-GHJK",
      verifyPath: "/link-computer?code=BCDF-GHJK",
      intervalSeconds: 3,
      expiresInSeconds: 600,
    });
    expect(db.openLink).toHaveBeenCalledWith("Ada's laptop", null);
  });

  it.each([
    ["the plain header", { "x-real-ip": " 203.0.113.9 " }, "203.0.113.9"],
    // Each server on the way adds to the list, so only the last entry is one
    // a server saw for itself. The first is whatever the caller sent.
    ["the last entry of the list", { "x-forwarded-for": "10.0.0.1, 198.51.100.7" }, "198.51.100.7"],
    ["the plain header before the list", { "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4" }, "203.0.113.9"],
  ])("tells the store who is asking, from %s", async (_what, headers, caller) => {
    db.openLink.mockResolvedValue({ deviceCode: "device-secret", userCode: "BCDFGHJK" });
    await openLink(call("POST", "/api/agent/link", { computerName: "x" }, headers));
    expect(db.openLink).toHaveBeenCalledWith("x", caller);
  });

  it.each([[{}], [{ computerName: "" }], [{ computerName: 12 }], ["not json"]])(
    "calls a computer that gives no name %j just Computer",
    async (body) => {
      db.openLink.mockResolvedValue({ deviceCode: "device-secret", userCode: "BCDFGHJK" });
      expect((await openLink(call("POST", "/api/agent/link", body))).status).toBe(201);
      expect(db.openLink).toHaveBeenCalledWith("Computer", null);
    }
  );

  it("cuts a very long name", async () => {
    db.openLink.mockResolvedValue({ deviceCode: "device-secret", userCode: "BCDFGHJK" });
    await openLink(call("POST", "/api/agent/link", { computerName: "x".repeat(500) }));
    expect(db.openLink).toHaveBeenCalledWith("x".repeat(60), null);
  });

  it("asks a computer to wait when too many are open", async () => {
    db.openLink.mockResolvedValue(null);
    expect((await openLink(call("POST", "/api/agent/link", { computerName: "x" }))).status).toBe(429);
  });

  it("logs only the kind of failure", async () => {
    db.openLink.mockRejectedValue(new TypeError("secret detail"));
    expect((await openLink(call("POST", "/api/agent/link", { computerName: "x" }))).status).toBe(500);
    expect(logged()).not.toContain("secret detail");
  });
});

describe("POST /api/agent/link/claim", () => {
  const post = (body: unknown) => claim(call("POST", "/api/agent/link/claim", body));

  it("says to keep waiting", async () => {
    db.claimLink.mockResolvedValue({ kind: "waiting" });
    const response = await post({ deviceCode: "device-secret" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ waiting: true });
  });

  it("hands over the token once someone said yes", async () => {
    db.claimLink.mockResolvedValue({ kind: "linked", token: TOKEN, org: { slug: "acme", name: "Acme" } });
    const response = await post({ deviceCode: "device-secret" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: TOKEN, org: { slug: "acme", name: "Acme" } });
  });

  it("says when it is over, so the computer stops asking", async () => {
    db.claimLink.mockResolvedValue({ kind: "gone" });
    expect((await post({ deviceCode: "device-secret" })).status).toBe(410);
  });

  it.each([[{}], [{ deviceCode: 5 }], [{ deviceCode: "x".repeat(201) }], ["nope"]])("refuses %j", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(db.claimLink).not.toHaveBeenCalled();
  });
});

describe("what a computer's token opens", () => {
  it.each([
    ["no token", {}],
    ["a word that is not one", { authorization: "Bearer nope" }],
    ["the wrong scheme", { authorization: `Basic ${TOKEN}` }],
    ["one far too long", { authorization: `Bearer ssa_${"x".repeat(300)}` }],
  ])("%s is not linked, without touching the database", async (_name, headers: Record<string, string>) => {
    const response = await nextJob(call("POST", "/api/agent/jobs/next", undefined, headers));
    expect(response.status).toBe(401);
    expect(db.findAgent).not.toHaveBeenCalled();
  });

  it("a token nobody holds is not linked", async () => {
    db.findAgent.mockResolvedValue(null);
    const checks = [
      nextJob(fromComputer("POST", "/api/agent/jobs/next")),
      answerJob(fromComputer("POST", "/api/agent/jobs/1", { result: {} }), idOf("1")),
      putConnections(fromComputer("PUT", "/api/agent/connections", { connections: [] })),
      unlinkSelf(fromComputer("DELETE", "/api/agent/self")),
    ];
    for (const response of await Promise.all(checks)) expect(response.status).toBe(401);
    expect(db.nextAgentJob).not.toHaveBeenCalled();
    expect(db.finishAgentJob).not.toHaveBeenCalled();
    expect(db.replaceAgentConnections).not.toHaveBeenCalled();
    expect(db.removeAgent).not.toHaveBeenCalled();
  });

  it("a database hiccup is not an unlinking", async () => {
    db.findAgent.mockRejectedValue(new Error(`boom ${TOKEN}`));
    const response = await nextJob(fromComputer("POST", "/api/agent/jobs/next"));
    expect(response.status).toBe(503);
    expect(logged()).not.toContain(TOKEN);
  });
});

describe("POST /api/agent/jobs/next", () => {
  it("hands over this computer's next question", async () => {
    const job = { id: 5, method: "schemas.list", params: { connectionId: 1 } };
    db.nextAgentJob.mockResolvedValue(job);
    const response = await nextJob(fromComputer("POST", "/api/agent/jobs/next"));
    expect(await response.json()).toEqual({ job });
    expect(db.nextAgentJob).toHaveBeenCalledWith(COMPUTER.id);
  });

  it("says when there is none", async () => {
    db.nextAgentJob.mockResolvedValue(null);
    expect(await (await nextJob(fromComputer("POST", "/api/agent/jobs/next"))).json()).toEqual({ job: null });
  });
});

describe("POST /api/agent/jobs/[id]", () => {
  const send = (body: unknown, id = "5") => answerJob(fromComputer("POST", `/api/agent/jobs/${id}`, body), idOf(id));

  beforeEach(() => {
    db.runningJobMethod.mockResolvedValue("schemas.list");
    db.finishAgentJob.mockResolvedValue(true);
  });

  it("keeps a good answer, cleaned", async () => {
    const response = await send({ result: { schemas: ["shop"], host: "db.example.test" } });
    expect(await response.json()).toEqual({ ok: true });
    expect(db.finishAgentJob).toHaveBeenCalledWith(COMPUTER.id, 5, { result: { schemas: ["shop"] } });
  });

  it("keeps a refusal as one known word", async () => {
    await send({ refusal: "unreachable" });
    expect(db.finishAgentJob).toHaveBeenCalledWith(COMPUTER.id, 5, { refusal: "unreachable" });
    await send({ refusal: "could not reach db.example.test" });
    expect(db.finishAgentJob).toHaveBeenLastCalledWith(COMPUTER.id, 5, { refusal: "failed" });
  });

  it("fails the question rather than keep an answer that makes no sense", async () => {
    const response = await send({ result: { schemas: "many" } });
    expect(response.status).toBe(400);
    expect(db.finishAgentJob).toHaveBeenCalledWith(COMPUTER.id, 5, { refusal: "failed" });
  });

  it("fails the question rather than keep a huge answer", async () => {
    const response = await send({ result: { schemas: ["x".repeat(MAX_ANSWER_BYTES)] } });
    expect(response.status).toBe(413);
    expect(db.finishAgentJob).toHaveBeenCalledWith(COMPUTER.id, 5, { refusal: "too-big" });
  });

  it("finds no question another computer holds, or one already answered", async () => {
    db.runningJobMethod.mockResolvedValue(null);
    expect((await send({ result: { schemas: [] } })).status).toBe(404);
    expect(db.finishAgentJob).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5", "abc"])("finds nothing at id %s", async (id) => {
    expect((await send({ result: { schemas: [] } }, id)).status).toBe(404);
    expect(db.runningJobMethod).not.toHaveBeenCalled();
  });
});

describe("PUT /api/agent/connections", () => {
  const put = (body: unknown) => putConnections(fromComputer("PUT", "/api/agent/connections", body));

  it("keeps names and environments, nothing else it was sent", async () => {
    const response = await put({
      connections: [{ id: 1, name: " Book\nshop ", environment: "prod", host: "db.example.test", password: "nope" }],
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(db.replaceAgentConnections).toHaveBeenCalledWith(COMPUTER.id, [
      { id: 1, name: "Book shop", environment: "prod", shared: true },
    ]);
  });

  it("keeps the shared flag a newer desktop sends, and reads a missing one as shared", async () => {
    await put({ connections: [{ id: 1, name: "x", shared: false }, { id: 2, name: "y" }] });
    expect(db.replaceAgentConnections).toHaveBeenCalledWith(COMPUTER.id, [
      { id: 1, name: "x", environment: "unset", shared: false },
      { id: 2, name: "y", environment: "unset", shared: true },
    ]);
  });

  it("turns an environment it does not know into none", async () => {
    await put({ connections: [{ id: 1, name: "x", environment: "moon" }] });
    expect(db.replaceAgentConnections).toHaveBeenCalledWith(COMPUTER.id, [{ id: 1, name: "x", environment: "unset", shared: true }]);
  });

  it("keeps the drift results a newer desktop sends, tidied, and none for an older one", async () => {
    const check = { status: "drifted", summary: "1 table added", checkedAt: "2026-11-08T10:00:00.000Z", source: "scheduled", acknowledged: false };
    await put({
      connections: [
        { id: 1, name: "x", drift: [{ schema: "public", intervalMinutes: 60, checks: [check, { ...check, status: "?" }] }, { schema: "" }] },
        { id: 2, name: "y" },
        { id: 3, name: "z", drift: "lots" },
      ],
    });
    expect(db.replaceAgentConnections).toHaveBeenCalledWith(COMPUTER.id, [
      {
        id: 1,
        name: "x",
        environment: "unset",
        shared: true,
        drift: [{ schema: "public", label: null, intervalMinutes: 60, lastCheckedAt: null, checks: [check] }],
      },
      { id: 2, name: "y", environment: "unset", shared: true },
      { id: 3, name: "z", environment: "unset", shared: true, drift: [] },
    ]);
  });

  it("keeps at most so many drift schemas across the whole computer", async () => {
    const schemas = Array.from({ length: 150 }, (_, i) => ({ schema: `s${i}` }));
    await put({ connections: [{ id: 1, name: "x", drift: schemas }, { id: 2, name: "y", drift: schemas }] });
    const [, sent] = db.replaceAgentConnections.mock.calls[0] as [number, { drift?: unknown[] }[]];
    expect(sent[0].drift).toHaveLength(150);
    expect(sent[1].drift).toHaveLength(50);
  });

  it.each([
    ["no list", {}],
    ["a list too long", { connections: Array.from({ length: 101 }, (_, i) => ({ id: i + 1, name: "x" })) }],
    ["an id of zero", { connections: [{ id: 0, name: "x" }] }],
    ["an id too big for the column", { connections: [{ id: 2147483648, name: "x" }] }],
    ["a repeated id", { connections: [{ id: 1, name: "x" }, { id: 1, name: "y" }] }],
    ["no name", { connections: [{ id: 1, name: " " }] }],
  ])("refuses %s", async (_name, body) => {
    expect((await put(body)).status).toBe(400);
    expect(db.replaceAgentConnections).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/agent/self", () => {
  it("unlinks only the computer asking", async () => {
    const response = await unlinkSelf(fromComputer("DELETE", "/api/agent/self"));
    expect(await response.json()).toEqual({ ok: true });
    expect(db.removeAgent).toHaveBeenCalledWith(COMPUTER.id);
  });
});

describe("who may use a person's computers", () => {
  const refused = NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  it.each([
    ["list", () => computers(call("GET", "/api/computers"))],
    ["read a link", () => readLink(call("GET", "/api/computers/link?code=BCDF-GHJK"))],
    ["approve", () => approve(call("POST", "/api/computers/link", { code: "BCDF-GHJK" }))],
    ["turn away", () => turnAway(call("DELETE", "/api/computers/link", { code: "BCDF-GHJK" }))],
    ["ask", () => ask(call("POST", "/api/computers/jobs", {}))],
    ["read an answer", () => readAnswer(call("GET", "/api/computers/jobs/1"), idOf("1"))],
  ])("%s answers with the gate's refusal, and needs compare:read", async (_name, route) => {
    mockGate = { ok: false, response: refused };
    expect((await route()).status).toBe(401);
    expect(mockRequirePermission).toHaveBeenCalledWith("compare:read");
  });

  it("remove answers with the gate's refusal, and needs compare:read or users:delete", async () => {
    mockGate = { ok: false, response: refused };
    expect((await removeComputer(call("DELETE", "/api/computers/1"), idOf("1"))).status).toBe(401);
    expect(mockRequirePermission).toHaveBeenCalledWith("compare:read", "users:delete");
    expect(db.removeComputer).not.toHaveBeenCalled();
    expect(db.removeOrgComputer).not.toHaveBeenCalled();
  });
});

describe("GET /api/computers", () => {
  it("lists this person's computers in this organization", async () => {
    db.listComputers.mockResolvedValue([]);
    expect(await (await computers(call("GET", "/api/computers"))).json()).toEqual({ computers: [] });
    expect(db.listComputers).toHaveBeenCalledWith(member.orgId, 12, false);
  });

  it("adds the unshared connections only when asked, for the Connections page", async () => {
    db.listComputers.mockResolvedValue([]);
    await computers(call("GET", "/api/computers?connections=all"));
    expect(db.listComputers).toHaveBeenCalledWith(member.orgId, 12, true);
  });

  it("has none under the sign-in bypass, where nobody has an account", async () => {
    mockGate = { ok: true, principal: inBypass };
    expect(await (await computers(call("GET", "/api/computers"))).json()).toEqual({ computers: [] });
    expect(db.listComputers).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/computers/[id]", () => {
  it("removes one of theirs", async () => {
    db.removeComputer.mockResolvedValue(true);
    expect((await removeComputer(call("DELETE", "/api/computers/9"), idOf("9"))).status).toBe(200);
    expect(db.removeComputer).toHaveBeenCalledWith(member.orgId, 12, 9);
    // Someone who may not remove members reaches nobody else's computer.
    expect(db.removeOrgComputer).not.toHaveBeenCalled();
  });

  it("lets someone who may remove members unlink any computer of the organization", async () => {
    mockGate = { ok: true, principal: admin };
    db.removeOrgComputer.mockResolvedValue(true);
    expect((await removeComputer(call("DELETE", "/api/computers/9"), idOf("9"))).status).toBe(200);
    expect(db.removeOrgComputer).toHaveBeenCalledWith(admin.orgId, 9);
    expect(db.removeComputer).not.toHaveBeenCalled();
  });

  it("tells them when the organization has no such computer", async () => {
    mockGate = { ok: true, principal: admin };
    db.removeOrgComputer.mockResolvedValue(false);
    const response = await removeComputer(call("DELETE", "/api/computers/9"), idOf("9"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "That computer is not linked to this organization." });
  });

  it("has none to remove under the sign-in bypass, for a role that may not remove members", async () => {
    mockGate = { ok: true, principal: inBypass };
    expect((await removeComputer(call("DELETE", "/api/computers/9"), idOf("9"))).status).toBe(404);
    expect(db.removeComputer).not.toHaveBeenCalled();
    expect(db.removeOrgComputer).not.toHaveBeenCalled();
  });

  it("finds nothing that is not theirs", async () => {
    db.removeComputer.mockResolvedValue(false);
    expect((await removeComputer(call("DELETE", "/api/computers/9"), idOf("9"))).status).toBe(404);
    expect((await removeComputer(call("DELETE", "/api/computers/x"), idOf("x"))).status).toBe(404);
  });
});

describe("/api/computers/link", () => {
  it("reads which computer is asking, however the code was typed", async () => {
    const openedAt = "2026-11-10T09:30:00.000Z";
    db.readLink.mockResolvedValue({ computerName: "Ada's laptop", openedAt });
    const response = await readLink(call("GET", "/api/computers/link?code=bcdf-ghjk"));
    // The name and when it asked, for the person to check before saying yes.
    expect(await response.json()).toEqual({ computerName: "Ada's laptop", openedAt });
    expect(db.readLink).toHaveBeenCalledWith("BCDFGHJK");
  });

  it("gives one answer to a wrong code and an expired one", async () => {
    db.readLink.mockResolvedValue(null);
    const wrong = await readLink(call("GET", "/api/computers/link?code=BCDF-GHJK"));
    const notACode = await readLink(call("GET", "/api/computers/link?code=nope"));
    expect(wrong.status).toBe(404);
    expect(await notACode.json()).toEqual(await wrong.json());
  });

  it("links the computer to the person and organization on the page", async () => {
    db.approveLink.mockResolvedValue(true);
    const response = await approve(call("POST", "/api/computers/link", { code: "BCDF-GHJK" }));
    expect(await response.json()).toEqual({ ok: true });
    expect(db.approveLink).toHaveBeenCalledWith("BCDFGHJK", member.orgId, 12);
  });

  it("will not link one under the sign-in bypass, with nobody to link it to", async () => {
    mockGate = { ok: true, principal: inBypass };
    expect((await approve(call("POST", "/api/computers/link", { code: "BCDF-GHJK" }))).status).toBe(409);
    expect(db.approveLink).not.toHaveBeenCalled();
  });

  it("says when the code ran out", async () => {
    db.approveLink.mockResolvedValue(false);
    expect((await approve(call("POST", "/api/computers/link", { code: "BCDF-GHJK" }))).status).toBe(404);
    expect((await approve(call("POST", "/api/computers/link", { code: "nope" }))).status).toBe(404);
  });

  it("turns a computer away, and shrugs at a code that is no code", async () => {
    expect((await turnAway(call("DELETE", "/api/computers/link", { code: "BCDF-GHJK" }))).status).toBe(200);
    expect(db.denyLink).toHaveBeenCalledWith("BCDFGHJK");
    db.denyLink.mockClear();
    expect((await turnAway(call("DELETE", "/api/computers/link", { code: "nope" }))).status).toBe(200);
    expect(db.denyLink).not.toHaveBeenCalled();
  });
});

describe("POST /api/computers/jobs", () => {
  const question = { computerId: 41, method: "schemas.list", params: { connectionId: 1 } };
  const post = (body: unknown) => ask(call("POST", "/api/computers/jobs", body));

  it("leaves the question and gives its id", async () => {
    db.createAgentJob.mockResolvedValue({ kind: "created", id: 77 });
    const response = await post(question);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 77 });
    expect(db.createAgentJob).toHaveBeenCalledWith(
      member.orgId,
      12,
      41,
      { method: "schemas.list", params: { connectionId: 1 } },
      [1]
    );
  });

  it.each([
    ["no-computer", 404, /not linked to your account/],
    ["off", 409, /off or asleep/],
    ["not-shared", 409, /not shared from this computer/],
    ["too-many", 429, /too many questions/],
  ] as const)("%s reads as a sentence for the person", async (kind, status, sentence) => {
    db.createAgentJob.mockResolvedValue({ kind });
    const response = await post(question);
    expect(response.status).toBe(status);
    expect((await response.json()).error).toMatch(sentence);
  });

  it("refuses a question a computer must never be asked, before it is left", async () => {
    expect((await post({ ...question, method: "deploy.run" })).status).toBe(400);
    expect(
      (await post({ computerId: 41, method: "compare.run", params: {
        source: { connectionId: 1, schema: "a" },
        targets: [{ connectionId: 2, schema: "a" }, { connectionId: 3, schema: "a" }],
      } })).status
    ).toBe(400);
    expect(db.createAgentJob).not.toHaveBeenCalled();
  });

  it.each([[{ ...question, computerId: "41" }], [{ ...question, computerId: 0 }], ["nope"]])(
    "finds no computer for %j",
    async (body) => {
      expect((await post(body)).status).toBe(404);
      expect(db.createAgentJob).not.toHaveBeenCalled();
    }
  );

  it("has no computers under the sign-in bypass", async () => {
    mockGate = { ok: true, principal: inBypass };
    expect((await post(question)).status).toBe(404);
  });
});

describe("GET /api/computers/jobs/[id]", () => {
  const read = (id = "77") => readAnswer(call("GET", `/api/computers/jobs/${id}`), idOf(id));

  it("says it is still waiting", async () => {
    db.readAgentJobFor.mockResolvedValue({ status: "waiting" });
    expect(await (await read()).json()).toEqual({ status: "waiting" });
    expect(db.readAgentJobFor).toHaveBeenCalledWith(member.orgId, 12, 77);
  });

  it("gives the answer", async () => {
    db.readAgentJobFor.mockResolvedValue({ status: "done", result: { schemas: ["shop"] } });
    expect(await (await read()).json()).toEqual({ status: "done", result: { schemas: ["shop"] } });
  });

  it("turns a refusal into the site's own sentence", async () => {
    db.readAgentJobFor.mockResolvedValue({ status: "failed", refusal: "unreachable" });
    expect(await (await read()).json()).toEqual({
      status: "failed",
      error: "The computer could not reach that database.",
    });
  });

  it("says plainly when the computer never answered", async () => {
    db.readAgentJobFor.mockResolvedValue({ status: "timed-out" });
    const answer = await (await read()).json();
    expect(answer.status).toBe("failed");
    expect(answer.error).toMatch(/asleep or off/);
  });

  it("finds nothing that is not theirs", async () => {
    db.readAgentJobFor.mockResolvedValue(null);
    expect((await read()).status).toBe(404);
    expect((await read("x")).status).toBe(404);
  });
});
