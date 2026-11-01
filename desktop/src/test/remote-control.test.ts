/**
 * Tests for what a passkey signs when a paired phone starts a deploy or a
 * rollback, or cancels a query (src/shared/remote/control.ts).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { approvalChallenge } from "../shared/remote/approval.js";
import { toBase64Url } from "../shared/remote/bytes.js";
import { CONTROL_TICKS, cancelChallenge, deployChallenge, ticksFor, type CancelTarget, type DeployTarget, type RunRisks } from "../shared/remote/control.js";

const NONCE = new Uint8Array(32).map((_, index) => index * 7);
const FINGERPRINT = "13ebe903a2fef8fc68e82206f4397b2f2318db3d42c22493f5f6185f6e12eb61";
const OTHER_FINGERPRINT = "50fc1681c9bc0d722a1ee91d09f9fa1ce74142082c569279bdb67b35ecdbc2ad";

const DEPLOY: DeployTarget = {
  connectionId: 7,
  schemaName: "public",
  scriptName: "users_migration",
  action: "deploy",
  targetVersion: "2.0.0",
  fingerprint: FINGERPRINT,
  step: "run",
  ticks: ["production", "data-loss"],
};
const CANCEL: CancelTarget = { connectionId: 7, pid: 4242, queryStart: "2026-10-30T09:59:48.123456Z" };

const NO_RISKS: RunRisks = { production: false, breaking: [], dataLoss: [], otherScripts: [], drift: null };

function sha256Of(fields: readonly unknown[]): Buffer {
  return createHash("sha256").update(JSON.stringify(fields), "utf8").digest();
}

test("a run's challenge is a SHA-256 of its label, the nonce and every field of the run", async () => {
  const expected = sha256Of(["schema-studio control v1", Buffer.from(NONCE).toString("base64url"), "run", "deploy", 7, "public", "users_migration", "2.0.0", FINGERPRINT, "run", ["production", "data-loss"]]);
  assert.deepEqual(Buffer.from(await deployChallenge(NONCE, DEPLOY)), expected);
});

test("a cancel's challenge is a SHA-256 of its label, the nonce and which query", async () => {
  const expected = sha256Of(["schema-studio control v1", Buffer.from(NONCE).toString("base64url"), "cancel", 7, 4242, "2026-10-30T09:59:48.123456Z"]);
  assert.deepEqual(Buffer.from(await cancelChallenge(NONCE, CANCEL)), expected);
});

test("a run's challenge is for one nonce and one run only", async () => {
  const challenge = toBase64Url(await deployChallenge(NONCE, DEPLOY));
  const others = [
    await deployChallenge(new Uint8Array(32).fill(2), DEPLOY),
    await deployChallenge(NONCE, { ...DEPLOY, connectionId: 8 }),
    await deployChallenge(NONCE, { ...DEPLOY, schemaName: "sales" }),
    await deployChallenge(NONCE, { ...DEPLOY, scriptName: "orders_migration" }),
    await deployChallenge(NONCE, { ...DEPLOY, action: "revert" }),
    await deployChallenge(NONCE, { ...DEPLOY, targetVersion: "2.0.1" }),
    await deployChallenge(NONCE, { ...DEPLOY, targetVersion: null }),
    await deployChallenge(NONCE, { ...DEPLOY, fingerprint: OTHER_FINGERPRINT }),
    await deployChallenge(NONCE, { ...DEPLOY, step: "ask" }),
    await deployChallenge(NONCE, { ...DEPLOY, ticks: ["production"] }),
    await deployChallenge(NONCE, { ...DEPLOY, ticks: ["data-loss", "production"] }),
  ];
  for (const other of others) assert.notEqual(toBase64Url(other), challenge);
});

test("a cancel's challenge is for one nonce and one query only", async () => {
  const challenge = toBase64Url(await cancelChallenge(NONCE, CANCEL));
  const others = [
    await cancelChallenge(new Uint8Array(32).fill(2), CANCEL),
    await cancelChallenge(NONCE, { ...CANCEL, connectionId: 8 }),
    await cancelChallenge(NONCE, { ...CANCEL, pid: 4243 }),
    await cancelChallenge(NONCE, { ...CANCEL, queryStart: "2026-10-30T09:59:48.123457Z" }),
  ];
  for (const other of others) assert.notEqual(toBase64Url(other), challenge);
});

test("a name cannot pass for other fields, whatever characters it holds", async () => {
  const joined = await deployChallenge(NONCE, { ...DEPLOY, schemaName: 'public","users_migration', scriptName: "x" });
  const apart = await deployChallenge(NONCE, { ...DEPLOY, schemaName: "public", scriptName: 'users_migration","x' });
  assert.notEqual(toBase64Url(joined), toBase64Url(apart));
  const withBreak = await deployChallenge(NONCE, { ...DEPLOY, schemaName: "public\nusers_migration", scriptName: "x" });
  const withoutBreak = await deployChallenge(NONCE, { ...DEPLOY, schemaName: "public", scriptName: "users_migration\nx" });
  assert.notEqual(toBase64Url(withBreak), toBase64Url(withoutBreak));
});

test("a signature for one kind of thing can serve for no other", async () => {
  const run = toBase64Url(await deployChallenge(NONCE, DEPLOY));
  const cancel = toBase64Url(await cancelChallenge(NONCE, CANCEL));
  const approval = toBase64Url(await approvalChallenge(NONCE, 7, "approve", FINGERPRINT));
  assert.notEqual(run, cancel);
  assert.notEqual(run, approval);
  assert.notEqual(cancel, approval);
});

test("a run with no risks needs no ticks", () => {
  assert.deepEqual(ticksFor(NO_RISKS), []);
});

test("each risk needs its own tick, in one fixed order", () => {
  assert.deepEqual(ticksFor({ ...NO_RISKS, production: true }), ["production"]);
  assert.deepEqual(ticksFor({ ...NO_RISKS, breaking: ["a v1"] }), ["breaking"]);
  assert.deepEqual(ticksFor({ ...NO_RISKS, dataLoss: ["a v1"] }), ["data-loss"]);
  assert.deepEqual(ticksFor({ ...NO_RISKS, otherScripts: ["b v3"] }), ["other-scripts"]);
  assert.deepEqual(ticksFor({ ...NO_RISKS, drift: "drifted" }), ["drift"]);
  assert.deepEqual(ticksFor({ ...NO_RISKS, drift: "unreachable" }), ["drift"]);
  const every: RunRisks = { production: true, breaking: ["a v1"], dataLoss: ["a v1"], otherScripts: ["b v3"], drift: "drifted" };
  assert.deepEqual(ticksFor(every), CONTROL_TICKS);
});
