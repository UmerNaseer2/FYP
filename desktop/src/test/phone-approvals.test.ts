/**
 * Tests for deciding the app's approval requests from a paired phone
 * (src/main/phone-approvals.ts). A fake plays the app's server, a passkey
 * made in software (software-passkey.ts) plays the phone's, and a clock the
 * tests move on by hand drives the 5-minute windows.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import type { PhonePasskey } from "../core/phone-link-file";
import type { Clock } from "../main/clock";
import { initLog, logFilePaths } from "../main/log";
import { ALLOW_MS, DECISION_MS, PhoneApprovals } from "../main/phone-approvals";
import { Refused, type AppAnswer, type AppCaller, type PhoneApprovalRequests } from "../main/phone-requests";
import { approvalChallenge, approvalFingerprint, type ApprovalDecision, type ApprovalScript } from "../shared/remote/approval.js";
import { fromBase64Url, type Bytes } from "../shared/remote/bytes.js";
import { objectFields } from "../shared/remote/json.js";
import type { ApprovalSummary, DecideParams, NewPasskeyParams, PasskeyState } from "../shared/remote/rpc.js";
import { assertion, newSoftwarePasskey, registration, RELAY_ORIGIN, type SoftwarePasskey } from "./software-passkey";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-phone-approvals-"));
initLog(path.join(root, "logs"), { echo: false });
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** How much of the log the tests have read so far. */
let logRead = 0;

/** What has been logged since the last call. */
function newLogLines(): string {
  const file = logFilePaths()?.main;
  assert.ok(file, "the log has a folder");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // Nothing logged yet.
  }
  const fresh = text.slice(logRead);
  logRead = text.length;
  return fresh;
}

/** How many lines of this text match. */
function countLines(text: string, pattern: RegExp): number {
  return text.split("\n").filter((line) => pattern.test(line)).length;
}

type Timer = { at: number; run: () => void; id: number };

/** A clock that moves only when a test moves it on. */
class FakeClock implements Clock {
  time = 1_700_000_000_000;
  private timers: Timer[] = [];
  private lastId = 0;

  now = (): number => this.time;

  setTimeout = (run: () => void, ms: number): unknown => {
    this.lastId += 1;
    this.timers.push({ at: this.time + ms, run, id: this.lastId });
    return this.lastId;
  };

  clearTimeout = (timer: unknown): void => {
    this.timers = this.timers.filter((entry) => entry.id !== timer);
  };

  /** Moves time on, running each timer that comes due on the way, in the order they come due. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let due: Timer | undefined;
      for (const entry of this.timers) {
        if (entry.at > end) continue;
        if (due === undefined || entry.at < due.at || (entry.at === due.at && entry.id < due.id)) due = entry;
      }
      if (due === undefined) break;
      const running = due;
      this.timers = this.timers.filter((entry) => entry !== running);
      this.time = running.at;
      running.run();
    }
    this.time = end;
  }
}

/** The hash of the email of whoever is signed in on the computer, as the app's queue route gives it. */
const APPROVER = "a1".repeat(32);
/** The same for someone else. */
const OTHER_APPROVER = "b2".repeat(32);
/** The SQL request 12 runs. */
const SCRIPTS: ApprovalScript[] = [{ name: "add_order_note", version: "1.1.0", sql: "ALTER TABLE orders ADD COLUMN note text;" }];

const QUEUE = "GET /api/deploy/approvals/phone";
const SQL_12 = "GET /api/deploy/approvals/12/phone";
const DECIDE_12 = "POST /api/deploy/approvals/12";

/** Never aborted: these tests never give up on the app. */
const SIGNAL = new AbortController().signal;

/** The fingerprints of SCRIPTS deployed and rolled back, worked out before the tests run. */
let deployFingerprint = "";
let revertFingerprint = "";
before(async () => {
  deployFingerprint = await approvalFingerprint(SCRIPTS, "deploy");
  revertFingerprint = await approvalFingerprint(SCRIPTS, "revert");
});

/** Request 12, waiting on connection 5 with its SQL kept, as GET /api/deploy/approvals/phone lists it. */
function summary(changes: Partial<ApprovalSummary> = {}): ApprovalSummary {
  return {
    id: 12,
    connectionId: 5,
    schemaName: "public",
    scriptName: "add_order_note",
    targetVersion: "1.1.0",
    action: "deploy",
    migrationCount: 1,
    breakingCount: 0,
    requestedBy: "someone@example.com",
    requestedAt: "2026-10-20T09:30:00.000Z",
    note: null,
    fingerprint: deployFingerprint,
    sql: "kept",
    ownRequest: false,
    ...changes,
  };
}

/** What the queue route answers with these requests waiting, for whoever APPROVER stands for unless changed. */
function queueAnswer(approvals: unknown[], changes: Record<string, unknown> = {}): AppAnswer {
  return { status: 200, json: { approver: APPROVER, canApprove: true, approvals, ...changes } };
}

/** What request 12's SQL route answers: the scripts kept with it, in the app's own field names, or null for none. */
function sqlAnswer(scripts: ApprovalScript[] | null, changes: Record<string, unknown> = {}): AppAnswer {
  const kept = scripts === null ? null : scripts.map((script) => ({ scriptName: script.name, version: script.version, sqlContent: script.sql }));
  return { status: 200, json: { id: 12, action: "deploy", fingerprint: deployFingerprint, scripts: kept, ...changes } };
}

/** An answer, or a way to make one when the call comes, for a test that acts while the app is being asked. */
type Route = AppAnswer | ((body: unknown) => AppAnswer);

/** Plays the app's server: each route answers as the test set it, and 404 otherwise. Every call is noted. */
class FakeApp {
  readonly calls: Array<{ route: string; body: unknown }> = [];
  readonly answers = new Map<string, Route>();

  call: AppCaller = async (method, url, body) => {
    const route = `${method} ${url}`;
    this.calls.push({ route, body });
    const answer = this.answers.get(route);
    if (answer === undefined) return { status: 404, json: { error: "Not found." } };
    return typeof answer === "function" ? answer(body) : answer;
  };

  /** The routes called so far, in order. */
  routes(): string[] {
    return this.calls.map((call) => call.route);
  }

  /** What was sent to the decision route for request 12. */
  decisions(): unknown[] {
    return this.calls.filter((call) => call.route === DECIDE_12).map((call) => call.body);
  }
}

/** A paired phone as the approvals module sees it. */
type KeptPhone = { name: string; passkey?: PhonePasskey };

/**
 * The approvals module with fakes for everything around it: the app's
 * server, the paired phones as phone-link.json keeps them, the connections
 * shared in Settings and the relay's address. Request 12 waits on shared
 * connection 5 with its SQL kept, and the app records whatever decision it
 * is sent.
 */
class Fixture {
  readonly app = new FakeApp();
  readonly clock = new FakeClock();
  readonly phones = new Map<string, KeptPhone>();
  /** Every passkey kept or taken away, in order. */
  readonly saved: Array<{ phoneKey: string; passkey: PhonePasskey | null }> = [];
  shared: number[] = [5];
  relayOrigin: string | null = RELAY_ORIGIN;
  /** How many times Settings was told to show the phones again. */
  changes = 0;
  readonly approvals: PhoneApprovals;

  constructor() {
    this.app.answers.set(QUEUE, queueAnswer([summary()]));
    this.app.answers.set(SQL_12, sqlAnswer(SCRIPTS));
    this.app.answers.set(DECIDE_12, (body) => {
      const status = objectFields(body)?.decision === "approve" ? "approved" : "rejected";
      return { status: 200, json: { approval: { id: 12, status } } };
    });
    this.approvals = new PhoneApprovals({
      call: this.app.call,
      sharedConnectionIds: () => this.shared,
      relayOrigin: () => this.relayOrigin,
      phone: (phoneKey) => this.phones.get(phoneKey),
      savePasskey: (phoneKey, passkey) => {
        this.saved.push({ phoneKey, passkey });
        const phone = this.phones.get(phoneKey);
        if (phone !== undefined) this.phones.set(phoneKey, passkey === null ? { name: phone.name } : { name: phone.name, passkey });
      },
      onChange: () => {
        this.changes += 1;
      },
      clock: this.clock,
    });
  }

  /** Pairs a phone, with a passkey already set up on it or not, and gives its key. */
  addPhone(name = "Test phone", passkey?: PhonePasskey): string {
    const phoneKey = crypto.randomBytes(32).toString("base64url");
    this.phones.set(phoneKey, passkey === undefined ? { name } : { name, passkey });
    return phoneKey;
  }
}

/** A software passkey as phone-link.json keeps it once set up, as the person APPROVER stands for. */
function keptPasskey(passkey: SoftwarePasskey, changes: Partial<PhonePasskey> = {}): PhonePasskey {
  return {
    credentialId: passkey.credentialId.toString("base64url"),
    publicKey: { x: passkey.x.toString("base64url"), y: passkey.y.toString("base64url") },
    signCount: passkey.signCount,
    approver: APPROVER,
    addedAt: 1_640_000_000_000,
    ...changes,
  };
}

/** The bytes of base64url text the module gave out. */
function decoded(text: string): Bytes {
  const bytes = fromBase64Url(text);
  assert.ok(bytes, "the text is base64url");
  return bytes;
}

/** The refusal a request ends in. Fails the test if it ends any other way. */
async function refusalOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof Refused, `the request was refused, not ${String(error)}`);
    return error.refusal;
  }
  assert.fail("the request was not refused");
}

/** What the phone app sends with passkey.finish for a passkey it made. */
function finishParams(made: { clientDataJSON: Buffer; attestationObject: Buffer }): NewPasskeyParams {
  return { clientDataJSON: made.clientDataJSON.toString("base64url"), attestationObject: made.attestationObject.toString("base64url") };
}

/** Sets up approvals on a phone as the phone app would, once Allow approvals is chosen for it in Settings. */
async function setUpPasskey(fixture: Fixture, phoneKey: string, passkey: SoftwarePasskey): Promise<{ passkey: PasskeyState }> {
  fixture.approvals.allow(phoneKey);
  const requests = fixture.approvals.forPhone(phoneKey);
  const { challenge } = requests.beginPasskey();
  return requests.finishPasskey(finishParams(registration(passkey, decoded(challenge))), SIGNAL);
}

type Decision = { approvalId: number; decision: ApprovalDecision; fingerprint: string };

/** The phone's decision on request 12, as the phone read it: to approve it, unless a test changes that. */
function decision(changes: Partial<Decision> = {}): Decision {
  return { approvalId: 12, decision: "approve", fingerprint: deployFingerprint, ...changes };
}

/**
 * A decision as the phone app sends it with approvals.decide: a one-time
 * number asked for, then the passkey's signature over the challenge made
 * from that number and `signs`, which is the decision sent unless a test
 * says otherwise.
 */
async function signed(requests: PhoneApprovalRequests, passkey: SoftwarePasskey, sent: Decision, signs: Decision = sent): Promise<DecideParams> {
  const { nonce } = requests.beginDecision();
  const made = assertion(passkey, await approvalChallenge(decoded(nonce), signs.approvalId, signs.decision, signs.fingerprint));
  return {
    ...sent,
    assertion: {
      credentialId: passkey.credentialId.toString("base64url"),
      authenticatorData: made.authenticatorData.toString("base64url"),
      clientDataJSON: made.clientDataJSON.toString("base64url"),
      signature: made.signature.toString("base64url"),
    },
  };
}

/** Signs a decision with the passkey, and sends it. */
async function decide(requests: PhoneApprovalRequests, passkey: SoftwarePasskey, sent = decision()): Promise<{ status: "approved" | "rejected" }> {
  return requests.decide(await signed(requests, passkey, sent), SIGNAL);
}

test("lists only the requests on shared connections, with what this phone can do about them", async () => {
  const fixture = new Fixture();
  const key = fixture.addPhone();
  const requests = fixture.approvals.forPhone(key);
  const onShared = summary();
  const onOther = summary({ id: 13, connectionId: 6 });
  // A field the app adds one day stays on the computer.
  fixture.app.answers.set(QUEUE, queueAnswer([{ ...onShared, requestedByName: "Someone" }, onOther]));
  const listed = await requests.list(SIGNAL);
  assert.deepEqual(listed, { approvals: [onShared], passkey: "none", canApprove: true });
  // Who is signed in on the computer is never sent to a phone.
  assert.ok(!JSON.stringify(listed).includes(APPROVER));

  fixture.approvals.allow(key);
  assert.equal((await requests.list(SIGNAL)).passkey, "allowed");
  fixture.approvals.forget(key);
  fixture.phones.set(key, { name: "Test phone", passkey: keptPasskey(newSoftwarePasskey()) });
  assert.equal((await requests.list(SIGNAL)).passkey, "ready");
  // Setting approvals up again shows as that, even on a phone with a passkey.
  fixture.approvals.allow(key);
  assert.equal((await requests.list(SIGNAL)).passkey, "allowed");
  fixture.approvals.forget(key);

  // Someone else signed in on the computer, who may only read the queue.
  fixture.app.answers.set(QUEUE, queueAnswer([onShared], { approver: OTHER_APPROVER, canApprove: false }));
  assert.deepEqual(await requests.list(SIGNAL), { approvals: [onShared], passkey: "other-person", canApprove: false });
  fixture.shared = [];
  assert.deepEqual((await requests.list(SIGNAL)).approvals, []);
  assert.deepEqual(
    fixture.app.routes(),
    Array.from({ length: 6 }, () => QUEUE),
  );
});

test("refuses when the app's queue is not in the shape it reads, and passes the app's own refusals on", async () => {
  const fixture = new Fixture();
  const requests = fixture.approvals.forPhone(fixture.addPhone());
  const shapes: AppAnswer[] = [
    queueAnswer([summary()], { approver: APPROVER.toUpperCase() }),
    queueAnswer([summary()], { approver: "someone@example.com" }),
    queueAnswer([summary()], { approver: null }),
    queueAnswer([summary()], { canApprove: "yes" }),
    queueAnswer([summary(), { ...summary({ id: 13 }), sql: "lost" }]),
    queueAnswer([{ ...summary(), fingerprint: "not a fingerprint" }]),
    { status: 200, json: { approver: APPROVER, canApprove: true } },
    { status: 200, json: [] },
  ];
  newLogLines();
  for (const answer of shapes) {
    fixture.app.answers.set(QUEUE, answer);
    assert.equal(await refusalOf(() => requests.list(SIGNAL)), "failed");
  }
  const lines = newLogLines();
  assert.equal(countLines(lines, /The app's approval queue for phones was not in the shape the phone link reads\./), shapes.length);
  assert.ok(!lines.includes("someone@example.com"));

  const refusals: Array<[number, string]> = [
    [401, "signed-out"],
    [403, "forbidden"],
    [503, "access-unknown"],
    [500, "failed"],
  ];
  for (const [status, refusal] of refusals) {
    fixture.app.answers.set(QUEUE, { status, json: { error: "The app's own words." } });
    assert.equal(await refusalOf(() => requests.list(SIGNAL)), refusal);
  }
  fixture.app.answers.set(QUEUE, () => {
    throw new Error("connect ECONNREFUSED");
  });
  assert.equal(await refusalOf(() => requests.list(SIGNAL)), "no-answer");
});

test("shows a request's SQL only when it hashes to the request's fingerprint", async () => {
  const fixture = new Fixture();
  const requests = fixture.approvals.forPhone(fixture.addPhone());
  assert.deepEqual(await requests.read(12, SIGNAL), { id: 12, action: "deploy", fingerprint: deployFingerprint, scripts: SCRIPTS });
  assert.deepEqual(fixture.app.routes(), [QUEUE, SQL_12]);

  // SQL other than the request's own.
  newLogLines();
  fixture.app.answers.set(SQL_12, sqlAnswer([{ ...SCRIPTS[0], sql: "DROP TABLE orders;" }]));
  assert.deepEqual(await requests.read(12, SIGNAL), { id: 12, action: "deploy", fingerprint: deployFingerprint, scripts: null });
  const lines = newLogLines();
  assert.equal(countLines(lines, /The SQL the app gave for approval request 12 does not hash to its fingerprint, so a phone is not shown it\./), 1);
  assert.ok(!lines.includes("DROP TABLE"));

  // The same SQL rolled back hashes to another fingerprint.
  fixture.app.answers.set(SQL_12, sqlAnswer(SCRIPTS));
  fixture.app.answers.set(QUEUE, queueAnswer([summary({ action: "revert" })]));
  assert.equal((await requests.read(12, SIGNAL)).scripts, null);
  fixture.app.answers.set(QUEUE, queueAnswer([summary({ action: "revert", fingerprint: revertFingerprint })]));
  assert.deepEqual(await requests.read(12, SIGNAL), { id: 12, action: "revert", fingerprint: revertFingerprint, scripts: SCRIPTS });

  // No copy was kept: the SQL route says so, or the queue does and the SQL is not asked for.
  fixture.app.answers.set(QUEUE, queueAnswer([summary()]));
  fixture.app.answers.set(SQL_12, sqlAnswer(null));
  assert.equal((await requests.read(12, SIGNAL)).scripts, null);
  fixture.app.answers.set(QUEUE, queueAnswer([summary({ sql: "missing" })]));
  const asked = fixture.app.calls.length;
  assert.equal((await requests.read(12, SIGNAL)).scripts, null);
  assert.deepEqual(fixture.app.routes().slice(asked), [QUEUE]);
});

test("refuses to show a request that is decided, on a connection not shared, or whose SQL it cannot read", async () => {
  const fixture = new Fixture();
  const requests = fixture.approvals.forPhone(fixture.addPhone());
  assert.equal(await refusalOf(() => requests.read(13, SIGNAL)), "already-decided");
  fixture.shared = [6];
  assert.equal(await refusalOf(() => requests.read(12, SIGNAL)), "not-shared");
  fixture.shared = [5];
  // Decided between the queue being read and its SQL.
  fixture.app.answers.delete(SQL_12);
  assert.equal(await refusalOf(() => requests.read(12, SIGNAL)), "already-decided");
  fixture.app.answers.set(SQL_12, { status: 403, json: { error: "Forbidden." } });
  assert.equal(await refusalOf(() => requests.read(12, SIGNAL)), "forbidden");

  newLogLines();
  const shapes: AppAnswer[] = [
    sqlAnswer(null, { scripts: [{ scriptName: "add_order_note", version: 1, sqlContent: "SELECT 1;" }] }),
    sqlAnswer(null, { scripts: "SELECT 1;" }),
    sqlAnswer(null, { scripts: undefined }),
    { status: 200, json: null },
  ];
  for (const answer of shapes) {
    fixture.app.answers.set(SQL_12, answer);
    assert.equal(await refusalOf(() => requests.read(12, SIGNAL)), "failed");
  }
  assert.equal(countLines(newLogLines(), /The app's SQL for approval request 12 was not in the shape the phone link reads\./), shapes.length);
});

test("lets a phone set up its passkey only in the 5 minutes after Allow approvals, and only once", async () => {
  const fixture = new Fixture();
  const key = fixture.addPhone();
  const requests = fixture.approvals.forPhone(key);
  assert.equal(await refusalOf(() => requests.beginPasskey()), "not-allowed");
  assert.equal(fixture.approvals.allowedUntil(key), null);

  fixture.approvals.allow(key);
  assert.equal(fixture.approvals.allowedUntil(key), fixture.clock.time + ALLOW_MS);
  assert.equal(fixture.changes, 1);
  fixture.clock.advance(ALLOW_MS - 1);
  assert.notEqual(fixture.approvals.allowedUntil(key), null);
  fixture.clock.advance(1);
  assert.equal(fixture.approvals.allowedUntil(key), null);
  assert.equal(fixture.changes, 2);
  assert.equal(await refusalOf(() => requests.beginPasskey()), "not-allowed");

  const passkey = newSoftwarePasskey(3);
  newLogLines();
  assert.deepEqual(await setUpPasskey(fixture, key, passkey), { passkey: "ready" });
  assert.equal(countLines(newLogLines(), /The phone "Test phone" set up approvals\./), 1);
  // Kept as the passkey of the person signed in on the computer, from now.
  assert.deepEqual(fixture.saved, [{ phoneKey: key, passkey: keptPasskey(passkey, { addedAt: fixture.clock.time }) }]);
  // Set up once: the 5 minutes end with it.
  assert.equal(fixture.approvals.allowedUntil(key), null);
  assert.equal(fixture.changes, 4);
  assert.equal(await refusalOf(() => requests.beginPasskey()), "not-allowed");
  assert.equal((await requests.list(SIGNAL)).passkey, "ready");
  // Setting it up asked the app who is signed in, and nothing else.
  assert.deepEqual(fixture.app.routes(), [QUEUE, QUEUE]);
});

test("keeps a setup the phone is in the middle of when Allow approvals is chosen again", async () => {
  const fixture = new Fixture();
  const key = fixture.addPhone();
  const requests = fixture.approvals.forPhone(key);
  fixture.approvals.allow(key);
  const { challenge } = requests.beginPasskey();
  fixture.clock.advance(ALLOW_MS - 1_000);
  fixture.approvals.allow(key);
  const until = fixture.clock.time + ALLOW_MS;
  assert.equal(fixture.approvals.allowedUntil(key), until);
  // Past the end of the first 5 minutes, the second still run.
  fixture.clock.advance(2_000);
  assert.equal(fixture.approvals.allowedUntil(key), until);
  assert.equal(fixture.changes, 2);
  const made = registration(newSoftwarePasskey(), decoded(challenge));
  assert.deepEqual(await requests.finishPasskey(finishParams(made), SIGNAL), { passkey: "ready" });
});

test("gives each phone a user ID of its own for its passkey, the same each time, and a new challenge each time", () => {
  const fixture = new Fixture();
  const first = fixture.addPhone("First phone");
  const second = fixture.addPhone("Second phone");
  fixture.approvals.allow(first);
  fixture.approvals.allow(second);
  const one = fixture.approvals.forPhone(first).beginPasskey();
  const again = fixture.approvals.forPhone(first).beginPasskey();
  const other = fixture.approvals.forPhone(second).beginPasskey();
  assert.equal(again.userId, one.userId);
  assert.notEqual(other.userId, one.userId);
  assert.equal(decoded(one.userId).length, 16);
  assert.equal(decoded(one.challenge).length, 32);
  assert.notEqual(again.challenge, one.challenge);
});

test("takes one try per challenge, and refuses a passkey made over another challenge or on another page", async () => {
  const fixture = new Fixture();
  const key = fixture.addPhone();
  const requests = fixture.approvals.forPhone(key);
  const passkey = newSoftwarePasskey();
  fixture.approvals.allow(key);
  newLogLines();
  const first = requests.beginPasskey();
  assert.equal(await refusalOf(() => requests.finishPasskey(finishParams(registration(passkey, new Uint8Array(32))), SIGNAL)), "passkey-refused");
  // That try used the challenge up.
  assert.equal(await refusalOf(() => requests.finishPasskey(finishParams(registration(passkey, decoded(first.challenge))), SIGNAL)), "not-allowed");

  const second = requests.beginPasskey();
  const elsewhere = registration(passkey, decoded(second.challenge), { origin: "https://evil.example.test" });
  assert.equal(await refusalOf(() => requests.finishPasskey(finishParams(elsewhere), SIGNAL)), "passkey-refused");
  requests.beginPasskey();
  assert.equal(await refusalOf(() => requests.finishPasskey({ clientDataJSON: "not base64url", attestationObject: "AA" }, SIGNAL)), "bad-request");

  const lines = newLogLines();
  assert.equal(countLines(lines, /The phone link did not take a phone's new passkey: The passkey signed some other challenge\./), 1);
  assert.equal(countLines(lines, /The phone link did not take a phone's new passkey: The passkey was used on another page than the phone app\./), 1);
  for (const challenge of [first.challenge, second.challenge]) assert.ok(!lines.includes(challenge));
  // None of it was kept or asked the app about, and the phone may still try again.
  assert.deepEqual(fixture.saved, []);
  assert.deepEqual(fixture.app.calls, []);
  assert.notEqual(fixture.approvals.allowedUntil(key), null);
});

test("keeps no passkey for someone who may not approve, or once Settings stops allowing it or the phone is forgotten meanwhile", async () => {
  const fixture = new Fixture();
  const key = fixture.addPhone();
  const passkey = newSoftwarePasskey();
  fixture.app.answers.set(QUEUE, queueAnswer([], { canApprove: false }));
  assert.equal(await refusalOf(() => setUpPasskey(fixture, key, passkey)), "forbidden");

  fixture.app.answers.set(QUEUE, () => {
    fixture.approvals.forget(key);
    return queueAnswer([]);
  });
  assert.equal(await refusalOf(() => setUpPasskey(fixture, key, passkey)), "not-allowed");
  fixture.app.answers.set(QUEUE, () => {
    fixture.phones.delete(key);
    return queueAnswer([]);
  });
  assert.equal(await refusalOf(() => setUpPasskey(fixture, key, passkey)), "not-allowed");
  assert.deepEqual(fixture.saved, []);

  // Without a relay there is no page to check the passkey was made on.
  fixture.phones.set(key, { name: "Test phone" });
  fixture.app.answers.set(QUEUE, queueAnswer([]));
  fixture.relayOrigin = null;
  newLogLines();
  assert.equal(await refusalOf(() => setUpPasskey(fixture, key, passkey)), "failed");
  assert.equal(countLines(newLogLines(), /The phone link has no relay address to check a passkey against\./), 1);
  assert.deepEqual(fixture.saved, []);
});

test("approves a request with the phone's passkey, as the person who set it up, after checking the SQL it runs", async () => {
  const fixture = new Fixture();
  const passkey = newSoftwarePasskey();
  const requests = fixture.approvals.forPhone(fixture.addPhone("Test phone", keptPasskey(passkey)));
  newLogLines();
  assert.deepEqual(await decide(requests, passkey), { status: "approved" });
  assert.deepEqual(fixture.app.routes(), [QUEUE, SQL_12, DECIDE_12]);
  // No note: nobody typed one.
  assert.deepEqual(fixture.app.decisions(), [{ decision: "approve", expectedFingerprint: deployFingerprint, expectedApprover: APPROVER }]);
  assert.equal(countLines(newLogLines(), /The phone "Test phone" approved approval request 12\./), 1);
  // A passkey that keeps no counter has nothing new to keep.
  assert.deepEqual(fixture.saved, []);
});

test("rejects a request whose SQL was not kept, which it could never approve", async () => {
  const fixture = new Fixture();
  const passkey = newSoftwarePasskey();
  const requests = fixture.approvals.forPhone(fixture.addPhone("Test phone", keptPasskey(passkey)));
  fixture.app.answers.set(QUEUE, queueAnswer([summary({ sql: "missing" })]));
  newLogLines();
  assert.equal(await refusalOf(() => decide(requests, passkey)), "sql-missing");
  assert.deepEqual(await decide(requests, passkey, decision({ decision: "reject" })), { status: "rejected" });
  // Rejecting runs nothing, so its SQL was never asked for.
  assert.deepEqual(fixture.app.routes(), [QUEUE, QUEUE, DECIDE_12]);
  assert.deepEqual(fixture.app.decisions(), [{ decision: "reject", expectedFingerprint: deployFingerprint, expectedApprover: APPROVER }]);
  assert.equal(countLines(newLogLines(), /The phone "Test phone" rejected approval request 12\./), 1);
});

test("takes each one-time number once, for 5 minutes, and only the newest one the phone asked for", async () => {
  const fixture = new Fixture();
  const passkey = newSoftwarePasskey();
  const key = fixture.addPhone("Test phone", keptPasskey(passkey));
  const requests = fixture.approvals.forPhone(key);

  const once = await signed(requests, passkey, decision());
  assert.deepEqual(await requests.decide(once, SIGNAL), { status: "approved" });
  assert.equal(await refusalOf(() => requests.decide(once, SIGNAL)), "expired");

  // A phone that never asked for one has none, whatever another phone was given.
  const other = fixture.approvals.forPhone(fixture.addPhone("Other phone", keptPasskey(passkey)));
  const fromFirst = await signed(requests, passkey, decision());
  assert.equal(await refusalOf(() => other.decide(fromFirst, SIGNAL)), "expired");

  // Just inside the 5 minutes, and just past them.
  const inTime = await signed(requests, passkey, decision());
  fixture.clock.advance(DECISION_MS - 1);
  assert.deepEqual(await requests.decide(inTime, SIGNAL), { status: "approved" });
  const late = await signed(requests, passkey, decision());
  fixture.clock.advance(DECISION_MS);
  assert.equal(await refusalOf(() => requests.decide(late, SIGNAL)), "expired");

  // Asking again replaces the number: a decision signed over the older one is not taken, and uses the newer one up.
  const older = await signed(requests, passkey, decision());
  const newer = await signed(requests, passkey, decision());
  assert.equal(await refusalOf(() => requests.decide(older, SIGNAL)), "passkey-refused");
  assert.equal(await refusalOf(() => requests.decide(newer, SIGNAL)), "expired");
  assert.equal(fixture.app.decisions().length, 2);
});

test("refuses a decision signed by another passkey, over another decision, or by a copy whose counter went back", async () => {
  const fixture = new Fixture();
  const passkey = newSoftwarePasskey(10);
  const key = fixture.addPhone("Test phone", keptPasskey(passkey));
  const requests = fixture.approvals.forPhone(key);
  newLogLines();

  assert.equal(await refusalOf(() => decide(requests, newSoftwarePasskey())), "passkey-refused");
  const forged: SoftwarePasskey = { ...newSoftwarePasskey(), credentialId: passkey.credentialId };
  assert.equal(await refusalOf(() => decide(requests, forged)), "passkey-refused");
  // Signed for another request, decision or SQL than the one sent.
  for (const signs of [decision({ approvalId: 13 }), decision({ decision: "reject" }), decision({ fingerprint: "cd".repeat(32) })]) {
    const sent = await signed(requests, passkey, decision(), signs);
    assert.equal(await refusalOf(() => requests.decide(sent, SIGNAL)), "passkey-refused");
  }
  const garbled = await signed(requests, passkey, decision());
  assert.equal(await refusalOf(() => requests.decide({ ...garbled, assertion: { ...garbled.assertion, signature: "not base64url" } }, SIGNAL)), "bad-request");
  assert.deepEqual(fixture.saved, []);
  assert.deepEqual(fixture.app.calls, []);

  // The passkey's own signature is taken, and its new counter kept.
  assert.deepEqual(await decide(requests, passkey), { status: "approved" });
  assert.deepEqual(fixture.saved, [{ phoneKey: key, passkey: keptPasskey(passkey) }]);
  // A copy of the passkey, one signature behind it, is refused.
  const copy: SoftwarePasskey = { ...passkey, signCount: passkey.signCount - 1 };
  assert.equal(await refusalOf(() => decide(requests, copy)), "passkey-refused");
  assert.equal(fixture.app.decisions().length, 1);

  const lines = newLogLines();
  assert.equal(countLines(lines, /did not take a phone's decision: it was signed by a passkey other than the one set up on the phone\./), 1);
  assert.equal(countLines(lines, /did not take a phone's decision: The signature is not the passkey's\./), 1);
  assert.equal(countLines(lines, /did not take a phone's decision: The passkey signed some other challenge\./), 3);
  assert.equal(countLines(lines, /did not take a phone's decision: The passkey's signature counter went back, so the passkey may have been copied\./), 1);
});

test("asks the app to record nothing for a request this phone should not decide, but keeps the passkey's counter", async () => {
  const fixture = new Fixture();
  const passkey = newSoftwarePasskey(1);
  const key = fixture.addPhone("Test phone", keptPasskey(passkey));
  const requests = fixture.approvals.forPhone(key);
  const cases: Array<[AppAnswer, string]> = [
    [queueAnswer([]), "already-decided"],
    [queueAnswer([summary({ connectionId: 6 })]), "not-shared"],
    [queueAnswer([summary()], { approver: OTHER_APPROVER }), "other-person"],
    [queueAnswer([summary()], { canApprove: false }), "forbidden"],
    [queueAnswer([summary({ ownRequest: true })]), "own-request"],
    [queueAnswer([summary({ fingerprint: "cd".repeat(32) })]), "changed"],
    [queueAnswer([summary({ sql: "missing" })]), "sql-missing"],
  ];
  for (const [answer, refusal] of cases) {
    fixture.app.answers.set(QUEUE, answer);
    assert.equal(await refusalOf(() => decide(requests, passkey)), refusal);
  }
  // SQL that no longer hashes to the request's fingerprint is never approved, though the request may still be rejected.
  fixture.app.answers.set(QUEUE, queueAnswer([summary()]));
  fixture.app.answers.set(SQL_12, sqlAnswer([{ ...SCRIPTS[0], sql: "DROP TABLE orders;" }]));
  assert.equal(await refusalOf(() => decide(requests, passkey)), "sql-missing");
  assert.deepEqual(await decide(requests, passkey, decision({ decision: "reject" })), { status: "rejected" });
  assert.deepEqual(fixture.app.decisions(), [{ decision: "reject", expectedFingerprint: deployFingerprint, expectedApprover: APPROVER }]);
  // Every signature counted, those that decided nothing too.
  assert.equal(fixture.saved.length, cases.length + 2);
  assert.equal(fixture.phones.get(key)?.passkey?.signCount, passkey.signCount);
});

test("decides nothing once approvals are turned off or set up again on the phone before the app is asked", async () => {
  const fixture = new Fixture();
  const passkey = newSoftwarePasskey();
  const key = fixture.addPhone("Test phone", keptPasskey(passkey));
  const requests = fixture.approvals.forPhone(key);
  const sent = await signed(requests, passkey, decision());
  fixture.phones.set(key, { name: "Test phone" });
  assert.equal(await refusalOf(() => requests.decide(sent, SIGNAL)), "no-passkey");

  // Turned off while the app is asked about the request.
  fixture.phones.set(key, { name: "Test phone", passkey: keptPasskey(passkey) });
  fixture.app.answers.set(QUEUE, () => {
    fixture.phones.set(key, { name: "Test phone" });
    return queueAnswer([summary()]);
  });
  assert.equal(await refusalOf(() => decide(requests, passkey)), "no-passkey");
  // And with no passkey there is no number to sign.
  assert.equal(await refusalOf(() => requests.beginDecision()), "no-passkey");

  // Set up again, with another passkey, while the app is asked.
  fixture.phones.set(key, { name: "Test phone", passkey: keptPasskey(passkey) });
  fixture.app.answers.set(QUEUE, () => {
    fixture.phones.set(key, { name: "Test phone", passkey: keptPasskey(newSoftwarePasskey()) });
    return queueAnswer([summary()]);
  });
  assert.equal(await refusalOf(() => decide(requests, passkey)), "no-passkey");
  assert.deepEqual(fixture.app.decisions(), []);
});

test("tells the phone what the app's answer to its decision means", async () => {
  const fixture = new Fixture();
  const passkey = newSoftwarePasskey();
  const requests = fixture.approvals.forPhone(fixture.addPhone("Test phone", keptPasskey(passkey)));
  const answers: Array<[AppAnswer, string]> = [
    [{ status: 404, json: { error: "That approval no longer exists." } }, "already-decided"],
    [{ status: 409, json: { error: "Already decided." } }, "already-decided"],
    [{ status: 412, json: { error: "The request changed." } }, "changed"],
    [{ status: 401, json: { error: "Sign in again." } }, "signed-out"],
    [{ status: 503, json: { error: "Access is unknown." } }, "access-unknown"],
    [{ status: 500, json: { error: "Something broke." } }, "failed"],
    [{ status: 200, json: { approval: { id: 12, status: "rejected" } } }, "failed"],
    [{ status: 200, json: { approval: { id: 12, status: "pending" } } }, "failed"],
    [{ status: 200, json: {} }, "failed"],
  ];
  newLogLines();
  for (const [answer, refusal] of answers) {
    fixture.app.answers.set(DECIDE_12, answer);
    assert.equal(await refusalOf(() => decide(requests, passkey)), refusal, `the app answered ${answer.status} ${JSON.stringify(answer.json)}`);
  }
  assert.equal(countLines(newLogLines(), /The app's answer to a phone's decision on approval request 12 was not the one the phone link expects\./), 3);

  // A 403 is the person's access while the request still waits, and a decision made meanwhile once it does not.
  fixture.app.answers.set(DECIDE_12, { status: 403, json: { error: "Forbidden." } });
  assert.equal(await refusalOf(() => decide(requests, passkey)), "forbidden");
  let reads = 0;
  fixture.app.answers.set(QUEUE, () => {
    reads += 1;
    return queueAnswer(reads === 1 ? [summary()] : []);
  });
  assert.equal(await refusalOf(() => decide(requests, passkey)), "already-decided");
  reads = 0;
  fixture.app.answers.set(QUEUE, () => {
    reads += 1;
    return reads === 1 ? queueAnswer([summary()]) : { status: 500, json: { error: "Something broke." } };
  });
  assert.equal(await refusalOf(() => decide(requests, passkey)), "forbidden");

  fixture.app.answers.set(QUEUE, queueAnswer([summary()]));
  fixture.app.answers.set(DECIDE_12, () => {
    throw new Error("connect ECONNREFUSED");
  });
  assert.equal(await refusalOf(() => decide(requests, passkey)), "no-answer");
});

test("forgets a phone's time to set up approvals and its one-time number when the phone or the link goes", async () => {
  const fixture = new Fixture();
  const passkey = newSoftwarePasskey();
  const first = fixture.addPhone("First phone", keptPasskey(passkey));
  const second = fixture.addPhone("Second phone");
  const requests = fixture.approvals.forPhone(first);
  fixture.approvals.allow(first);
  fixture.approvals.allow(second);
  const sent = await signed(requests, passkey, decision());

  // The phone link tells Settings itself when it forgets a phone.
  fixture.approvals.forget(first);
  assert.equal(fixture.changes, 2);
  assert.equal(fixture.approvals.allowedUntil(first), null);
  assert.notEqual(fixture.approvals.allowedUntil(second), null);
  assert.equal(await refusalOf(() => requests.decide(sent, SIGNAL)), "expired");

  const again = await signed(requests, passkey, decision());
  fixture.approvals.forgetAll();
  assert.equal(fixture.changes, 3);
  assert.equal(fixture.approvals.allowedUntil(second), null);
  assert.equal(await refusalOf(() => requests.decide(again, SIGNAL)), "expired");

  // With nothing open there is nothing to tell Settings.
  fixture.approvals.forgetAll();
  fixture.clock.advance(ALLOW_MS);
  assert.equal(fixture.changes, 3);
  assert.deepEqual(fixture.app.decisions(), []);
});

test("logs no challenge, one-time number, signature, SQL or who is signed in", async () => {
  const fixture = new Fixture();
  const key = fixture.addPhone();
  const requests = fixture.approvals.forPhone(key);
  // Notes each one-time number the phone is given.
  const nonces: string[] = [];
  const watched: PhoneApprovalRequests = {
    ...requests,
    beginDecision: () => {
      const begun = requests.beginDecision();
      nonces.push(begun.nonce);
      return begun;
    },
  };
  const passkey = newSoftwarePasskey(1);
  newLogLines();

  fixture.approvals.allow(key);
  const begun = requests.beginPasskey();
  const made = finishParams(registration(passkey, decoded(begun.challenge)));
  assert.deepEqual(await requests.finishPasskey(made, SIGNAL), { passkey: "ready" });
  await requests.list(SIGNAL);
  await requests.read(12, SIGNAL);
  const sent = await signed(watched, passkey, decision());
  assert.deepEqual(await watched.decide(sent, SIGNAL), { status: "approved" });
  // And one refused, whose reason is logged.
  const refused = await signed(watched, { ...passkey, signCount: passkey.signCount - 1 }, decision());
  assert.equal(await refusalOf(() => watched.decide(refused, SIGNAL)), "passkey-refused");

  const lines = newLogLines();
  assert.equal(countLines(lines, /The phone "Test phone" approved approval request 12\./), 1);
  assert.equal(nonces.length, 2);
  const secrets = [
    begun.challenge,
    begun.userId,
    made.clientDataJSON,
    made.attestationObject,
    ...nonces,
    sent.assertion.credentialId,
    sent.assertion.authenticatorData,
    sent.assertion.clientDataJSON,
    sent.assertion.signature,
    refused.assertion.signature,
    SCRIPTS[0].sql,
    APPROVER,
    "someone@example.com",
    key,
  ];
  for (const secret of secrets) assert.ok(!lines.includes(secret));
});
