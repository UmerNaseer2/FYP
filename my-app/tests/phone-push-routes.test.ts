// The routes that turn phone alerts on and off, and send a test one.
//
// The gate and the store are replaced, so this is about the routes' own
// decisions. tests/push-db.test.ts runs the queries on a real database.
import { NextRequest } from "next/server";
import type { Gate } from "@/lib/auth-guard";
import { principalFor, TEST_ORG } from "./helpers/principals";
import { newPhone, subscriptionOf } from "./helpers/push-phone";

let mockGate: Gate;
jest.mock("../lib/auth-guard", () => ({
  requireMember: async () => mockGate,
}));

jest.mock("../lib/push-db", () => ({
  deletePushSubscription: jest.fn(),
  listOwnSubscriptions: jest.fn(),
  pushPublicKey: jest.fn(),
  rememberSiteOrigin: jest.fn(),
  savePushSubscription: jest.fn(),
}));

jest.mock("../lib/push-send", () => ({
  sendAlert: jest.fn(),
}));

import * as pushDb from "../lib/push-db";
import * as pushSend from "../lib/push-send";
import { DELETE, GET, POST } from "../app/api/phone/push/route";
import { POST as TEST } from "../app/api/phone/push/test/route";
import { NextResponse } from "next/server";

const db = jest.mocked(pushDb);
const send = jest.mocked(pushSend);

const SITE = "fyp.example.test";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";
const device = subscriptionOf(newPhone(), ENDPOINT);
const BODY = { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } };

function call(method: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://${SITE}/api/phone/push`, {
    method,
    headers: { "content-type": "application/json", host: SITE, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const viewer = principalFor("viewer");
const inBypass = { ...viewer, profileId: null, bypass: true };

beforeEach(() => {
  jest.resetAllMocks();
  mockGate = { ok: true, principal: viewer };
  db.pushPublicKey.mockResolvedValue("the-public-key");
  send.sendAlert.mockResolvedValue({ sent: 2, failed: 0 });
});

describe("who may use them", () => {
  const refused = NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  it.each([
    ["GET", () => GET()],
    ["POST", () => POST(call("POST", BODY))],
    ["DELETE", () => DELETE(call("DELETE", { endpoint: ENDPOINT }))],
    ["the test", () => TEST()],
  ])("%s answers with the gate's refusal", async (_name, route) => {
    mockGate = { ok: false, response: refused };
    expect((await route()).status).toBe(401);
    expect(db.savePushSubscription).not.toHaveBeenCalled();
    expect(db.deletePushSubscription).not.toHaveBeenCalled();
    expect(send.sendAlert).not.toHaveBeenCalled();
  });

  it("gives a Viewer alerts too, since what reaches them depends on what they may read", async () => {
    expect((await POST(call("POST", BODY))).status).toBe(200);
  });

  it.each([
    ["POST", () => POST(call("POST", BODY))],
    ["DELETE", () => DELETE(call("DELETE", { endpoint: ENDPOINT }))],
    ["the test", () => TEST()],
  ])("%s needs an account to tie a device to", async (_name, route) => {
    mockGate = { ok: true, principal: inBypass };
    const response = await route();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("signed-in account");
  });
});

describe("GET", () => {
  it("gives the public key, and says when alerts cannot be used", async () => {
    expect(await (await GET()).json()).toEqual({ publicKey: "the-public-key", available: true });
    mockGate = { ok: true, principal: inBypass };
    expect(await (await GET()).json()).toEqual({ publicKey: "the-public-key", available: false });
  });

  it("does not quote a failure", async () => {
    const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
    db.pushPublicKey.mockRejectedValue(new Error("db.secret.example refused"));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("db.secret.example");
    expect(JSON.stringify(quiet.mock.calls)).not.toContain("db.secret.example");
    quiet.mockRestore();
  });
});

describe("POST", () => {
  it("keeps the device for the person asking, and hands nothing back", async () => {
    const response = await POST(call("POST", BODY));
    expect(await response.json()).toEqual({ ok: true });
    expect(db.savePushSubscription).toHaveBeenCalledWith(viewer.profileId, device);
  });

  it.each([
    ["no body", undefined],
    ["an address that is not a push service", { ...BODY, endpoint: "https://db.example.test/x" }],
    ["plain http", { ...BODY, endpoint: "http://fcm.googleapis.com/fcm/send/abc" }],
    ["no keys", { endpoint: ENDPOINT }],
    ["a short key", { ...BODY, keys: { ...BODY.keys, p256dh: "AAAA" } }],
  ])("refuses %s in plain words", async (_name, body) => {
    const response = await POST(call("POST", body));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("This browser's alert details could not be read.");
    expect(db.savePushSubscription).not.toHaveBeenCalled();
  });

  it("remembers the address the request came to", async () => {
    await POST(call("POST", BODY, { origin: `https://${SITE}` }));
    expect(db.rememberSiteOrigin).toHaveBeenCalledWith(`https://${SITE}`);
  });

  it("goes by the host a proxy saw", async () => {
    await POST(call("POST", BODY, { origin: "https://public.example.test", "x-forwarded-host": "public.example.test" }));
    expect(db.rememberSiteOrigin).toHaveBeenCalledWith("https://public.example.test");
  });

  it("does not believe an Origin that is not this site", async () => {
    await POST(call("POST", BODY, { origin: "https://elsewhere.example.test" }));
    expect(db.rememberSiteOrigin).toHaveBeenCalledWith(null);
  });

  it("copes with no Origin, or a nonsense one", async () => {
    await POST(call("POST", BODY));
    expect(db.rememberSiteOrigin).toHaveBeenLastCalledWith(null);
    await POST(call("POST", BODY, { origin: "not a url" }));
    expect(db.rememberSiteOrigin).toHaveBeenLastCalledWith(null);
  });

  it("does not quote a failure", async () => {
    const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
    db.savePushSubscription.mockRejectedValue(new Error(`could not store ${ENDPOINT}`));
    const response = await POST(call("POST", BODY));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(ENDPOINT);
    expect(JSON.stringify(quiet.mock.calls)).not.toContain(ENDPOINT);
    quiet.mockRestore();
  });
});

describe("DELETE", () => {
  it("forgets only the person's own device", async () => {
    expect((await DELETE(call("DELETE", { endpoint: ENDPOINT }))).status).toBe(200);
    expect(db.deletePushSubscription).toHaveBeenCalledWith(viewer.profileId, ENDPOINT);
  });

  it("refuses something that is not a device", async () => {
    expect((await DELETE(call("DELETE", { endpoint: "https://db.example.test" }))).status).toBe(400);
    expect(db.deletePushSubscription).not.toHaveBeenCalled();
  });
});

describe("the test alert", () => {
  it("goes to the person's own devices, and says how it went", async () => {
    const own = [{ id: 1, ...device }];
    db.listOwnSubscriptions.mockResolvedValue(own);
    const response = await TEST();
    expect(await response.json()).toEqual({ sent: 2, failed: 0 });
    expect(db.listOwnSubscriptions).toHaveBeenCalledWith(viewer.profileId);
    expect(send.sendAlert).toHaveBeenCalledWith(own, {
      kind: "test",
      title: "Schema Studio",
      body: "Alerts are working on this device.",
      url: `/${TEST_ORG.slug}/phone?tab=alerts`,
    });
  });
});
