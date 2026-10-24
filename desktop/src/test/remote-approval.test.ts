/**
 * Tests for the hashes a phone's decision on a request rests on
 * (src/shared/remote/approval.ts).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { approvalChallenge, approvalFingerprint, approvalRunText, isFingerprint, type ApprovalScript } from "../shared/remote/approval.js";
import { toBase64Url } from "../shared/remote/bytes.js";

// The run and hashes my-app/tests/approvals-phone.test.ts pins for the app's
// server, so the two copies are held to the same answer. The names and SQL
// hold characters outside ASCII, one of them outside the Basic Multilingual
// Plane, where UTF-16 code units and characters count differently.
const VECTOR_RUN: ApprovalScript[] = [
  { name: "caf" + String.fromCodePoint(0xe9) + "_fix", version: "1.0.0", sql: "SELECT '" + String.fromCodePoint(0x1f600) + "';" },
  { name: "orders", version: "1.1.0", sql: "DROP TABLE t;\n" },
];
const DEPLOY_HEX = "13ebe903a2fef8fc68e82206f4397b2f2318db3d42c22493f5f6185f6e12eb61";
const REVERT_HEX = "50fc1681c9bc0d722a1ee91d09f9fa1ce74142082c569279bdb67b35ecdbc2ad";

test("a deploy's fingerprint is the one the app's server works out", async () => {
  assert.equal(await approvalFingerprint(VECTOR_RUN, "deploy"), DEPLOY_HEX);
});

test("a rollback's fingerprint is the one the app's server works out", async () => {
  assert.equal(await approvalFingerprint(VECTOR_RUN, "revert"), REVERT_HEX);
});

test("lengths count UTF-16 code units", () => {
  const lines = approvalRunText(VECTOR_RUN, "deploy").split("\n");
  assert.equal(lines[0], "2 migrations");
  assert.equal(lines[1], "8:caf" + String.fromCodePoint(0xe9) + "_fix5:1.0.012:SELECT '" + String.fromCodePoint(0x1f600) + "';");
  assert.equal(lines[2], "6:orders5:1.1.014:DROP TABLE t;");
});

test("an empty run says so", () => {
  assert.equal(approvalRunText([], "deploy"), "0 migrations");
  assert.equal(approvalRunText([], "revert"), "0 rollbacks");
});

test("text moved from one field to the next changes the fingerprint", async () => {
  const before = await approvalFingerprint([{ name: "ab", version: "1", sql: "x" }], "deploy");
  const after = await approvalFingerprint([{ name: "a", version: "b1", sql: "x" }], "deploy");
  assert.notEqual(before, after);
});

test("the order of the scripts is part of the fingerprint", async () => {
  assert.notEqual(await approvalFingerprint([...VECTOR_RUN].reverse(), "deploy"), DEPLOY_HEX);
});

test("the challenge is a SHA-256 of the nonce, the request, the decision and the fingerprint", async () => {
  const nonce = new Uint8Array(32).map((_, index) => index * 7);
  const text = ["schema-studio approval v1", Buffer.from(nonce).toString("base64url"), "42", "approve", DEPLOY_HEX].join("\n");
  const expected = createHash("sha256").update(text, "utf8").digest();
  assert.deepEqual(Buffer.from(await approvalChallenge(nonce, 42, "approve", DEPLOY_HEX)), expected);
});

test("a challenge is for one nonce, request, decision and fingerprint only", async () => {
  const nonce = new Uint8Array(32).fill(1);
  const challenge = toBase64Url(await approvalChallenge(nonce, 7, "approve", DEPLOY_HEX));
  const others = [
    await approvalChallenge(new Uint8Array(32).fill(2), 7, "approve", DEPLOY_HEX),
    await approvalChallenge(nonce, 8, "approve", DEPLOY_HEX),
    await approvalChallenge(nonce, 7, "reject", DEPLOY_HEX),
    await approvalChallenge(nonce, 7, "approve", REVERT_HEX),
  ];
  for (const other of others) assert.notEqual(toBase64Url(other), challenge);
});

test("isFingerprint takes 64 lowercase hex characters and nothing else", () => {
  assert.equal(isFingerprint(DEPLOY_HEX), true);
  for (const value of [DEPLOY_HEX.toUpperCase(), DEPLOY_HEX.slice(1), DEPLOY_HEX + "0", DEPLOY_HEX + "\n", "g" + DEPLOY_HEX.slice(1), 64, null, undefined]) {
    assert.equal(isFingerprint(value), false);
  }
});
