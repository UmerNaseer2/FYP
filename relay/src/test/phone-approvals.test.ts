/**
 * The phone app's rules and words for deploy and rollback requests
 * (src/phone/approvals.ts): their names and sizes, who asked, what the phone
 * offers for each one, and what it says when a passkey could not be used.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_LABELS,
  DECIDED_TEXT,
  decisionChoices,
  passkeyErrorText,
  requestedText,
  requestSize,
  requestTitle,
  versionText,
} from "../phone/approvals.js";
import { dayText } from "../phone/format.js";
import { approvalFingerprint, type ApprovalScript } from "../shared/remote/approval.js";
import type { ApprovalList, ApprovalRead, ApprovalSummary, PasskeyState } from "../shared/remote/rpc.js";

const SCRIPTS: ApprovalScript[] = [
  { name: "add_orders", version: "2", sql: "CREATE TABLE orders (id integer PRIMARY KEY);" },
  { name: "add_order_total", version: "3", sql: "ALTER TABLE orders ADD COLUMN total numeric;" },
];

/** A deploy request waiting for a decision, for SCRIPTS, with `fingerprint` as the computer gave it. */
function summary(fingerprint: string, changes: Partial<ApprovalSummary> = {}): ApprovalSummary {
  return {
    id: 7,
    connectionId: 2,
    schemaName: "public",
    scriptName: "orders",
    targetVersion: "3",
    action: "deploy",
    migrationCount: 2,
    breakingCount: 0,
    requestedBy: "sam@example.com",
    requestedAt: "2026-10-23T09:30:00.000Z",
    note: null,
    fingerprint,
    sql: "kept",
    ownRequest: false,
    ...changes,
  };
}

function list(passkey: PasskeyState = "ready", canApprove = true): Pick<ApprovalList, "passkey" | "canApprove"> {
  return { passkey, canApprove };
}

function read(fingerprint: string, changes: Partial<ApprovalRead> = {}): ApprovalRead {
  return { id: 7, action: "deploy", fingerprint, scripts: SCRIPTS, ...changes };
}

test("names each kind of request, and what each decision did", () => {
  assert.deepEqual(ACTION_LABELS, { deploy: "Deploy", revert: "Rollback" });
  assert.equal(DECIDED_TEXT.approve, "Approved. The person who asked can run it from the Deploy screen in Schema Studio.");
  assert.equal(DECIDED_TEXT.reject, "Rejected. It will not run unless someone asks for approval again.");
});

test("writes versions as the web app does, with one v", () => {
  assert.equal(versionText("3"), "v3");
  assert.equal(versionText("v3"), "v3");
  assert.equal(versionText(" V12 "), "v12");
});

test("names a request by what it runs", () => {
  assert.equal(requestTitle({ action: "deploy", targetVersion: "3" }), "Run migrations through v3");
  assert.equal(requestTitle({ action: "revert", targetVersion: "v2" }), "Roll back through v2");
});

test("says how much a request runs, and how much of it breaks things", () => {
  assert.equal(requestSize({ action: "deploy", migrationCount: 1, breakingCount: 0 }), "1 migration");
  assert.equal(requestSize({ action: "deploy", migrationCount: 3, breakingCount: 1 }), "3 migrations, 1 breaking change");
  assert.equal(requestSize({ action: "revert", migrationCount: 1, breakingCount: 0 }), "1 version to undo");
  assert.equal(requestSize({ action: "revert", migrationCount: 2, breakingCount: 2 }), "2 versions to undo, 2 breaking changes");
});

test("says who asked and when, leaving out a day it cannot read", () => {
  const at = "2026-10-23T09:30:00.000Z";
  assert.equal(requestedText({ requestedBy: "sam@example.com", requestedAt: at }), `Asked for by sam@example.com on ${dayText(Date.parse(at))}`);
  assert.equal(requestedText({ requestedBy: "sam@example.com", requestedAt: "not a time" }), "Asked for by sam@example.com");
});

test("offers both decisions for a request whose SQL the phone checked", async () => {
  const fingerprint = await approvalFingerprint(SCRIPTS, "deploy");
  assert.deepEqual(decisionChoices(list(), summary(fingerprint), read(fingerprint), fingerprint), { approve: true, reject: true, reason: null });
});

test("offers nothing to a role that may not decide requests, before anything else", async () => {
  const fingerprint = await approvalFingerprint(SCRIPTS, "deploy");
  const choices = decisionChoices(list("none", false), summary(fingerprint, { ownRequest: true }), read(fingerprint), fingerprint);
  assert.deepEqual(choices, { approve: false, reject: false, reason: "The role signed in on the computer may not approve or reject requests." });
});

test("offers nothing for the signed-in person's own request", async () => {
  const fingerprint = await approvalFingerprint(SCRIPTS, "deploy");
  const choices = decisionChoices(list("none"), summary(fingerprint, { ownRequest: true }), read(fingerprint), fingerprint);
  assert.equal(choices.approve || choices.reject, false);
  assert.equal(choices.reason, "The person signed in on the computer asked for this request, so someone else has to decide it.");
});

test("offers nothing until the phone has a passkey for whoever is signed in", async () => {
  const fingerprint = await approvalFingerprint(SCRIPTS, "deploy");
  const reasons: Record<Exclude<PasskeyState, "ready">, string> = {
    none: "To approve or reject requests from this phone, set up approvals on it first. Requests shows how.",
    allowed: "Set up approvals on this phone first: go back to Requests and choose Set up approvals.",
    "other-person":
      "The person signed in on the computer is not the one who set up approvals on this phone. Set them up again to decide as whoever is signed in now.",
  };
  for (const [passkey, reason] of Object.entries(reasons) as [PasskeyState, string][]) {
    assert.deepEqual(decisionChoices(list(passkey), summary(fingerprint), read(fingerprint), fingerprint), { approve: false, reject: false, reason }, passkey);
  }
});

test("offers nothing when what the computer showed is not the request in the list", async () => {
  const fingerprint = await approvalFingerprint(SCRIPTS, "deploy");
  const other = await approvalFingerprint(SCRIPTS, "revert");
  const changed = "This request changed on the computer while it was open here. Go back to Requests and open it again.";
  const cases: [string, ApprovalRead, string | null][] = [
    ["another request", read(fingerprint, { id: 8 }), fingerprint],
    ["another action", read(fingerprint, { action: "revert" }), fingerprint],
    ["another fingerprint", read(other), other],
    // The computer said the SQL has this fingerprint, but the SQL it sent has another one.
    ["SQL that is not what it says", read(fingerprint), other],
    ["SQL the phone could not check", read(fingerprint), null],
  ];
  for (const [label, shown, hashed] of cases) {
    assert.deepEqual(decisionChoices(list(), summary(fingerprint), shown, hashed), { approve: false, reject: false, reason: changed }, label);
  }
});

test("only lets a request be rejected when the computer cannot show its SQL", async () => {
  const fingerprint = await approvalFingerprint(SCRIPTS, "deploy");
  const reason =
    "The computer cannot show the SQL this request runs, so it cannot be approved from a phone. Reject it here, or decide it in Schema Studio on the computer.";
  assert.deepEqual(decisionChoices(list(), summary(fingerprint, { sql: "missing" }), read(fingerprint, { scripts: null }), null), { approve: false, reject: true, reason });
  assert.deepEqual(decisionChoices(list(), summary(fingerprint, { sql: "missing" }), read(fingerprint), fingerprint), { approve: false, reject: true, reason });
});

test("checks a rollback's SQL as a rollback", async () => {
  const fingerprint = await approvalFingerprint(SCRIPTS, "revert");
  const request = summary(fingerprint, { action: "revert", targetVersion: "2" });
  assert.deepEqual(decisionChoices(list(), request, read(fingerprint, { action: "revert" }), fingerprint).approve, true);
  // The same SQL hashed as a deploy is another fingerprint, so it does not pass for the rollback.
  assert.equal(decisionChoices(list(), request, read(fingerprint, { action: "revert" }), await approvalFingerprint(SCRIPTS, "deploy")).approve, false);
});

test("explains a passkey the browser would not make or use, without the browser's own words", () => {
  assert.equal(passkeyErrorText("NotAllowedError", "create"), "The passkey was not made, because it was cancelled or took too long. Try again.");
  assert.equal(passkeyErrorText("AbortError", "create"), "The passkey was not made, because it was cancelled or took too long. Try again.");
  assert.equal(passkeyErrorText("NotAllowedError", "get"), "Nothing was decided, because the passkey check was cancelled or took too long. Try again.");
  for (const kind of ["create", "get"] as const) {
    assert.equal(
      passkeyErrorText("NotSupportedError", kind),
      "This browser cannot make the kind of passkey approvals need. Try the phone's own browser: Safari on an iPhone, or Chrome on Android.",
    );
    assert.equal(passkeyErrorText("SecurityError", kind), "This browser would not use a passkey for this address. Approvals need the relay to be opened over HTTPS.");
  }
  assert.equal(passkeyErrorText("UnknownError", "create"), "The phone could not make a passkey. Try again.");
  assert.equal(passkeyErrorText("", "get"), "The phone could not use its passkey. Try again.");
});
