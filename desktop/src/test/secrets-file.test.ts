/**
 * The layout of secrets.json and auth.json, and checking what is read back
 * (src/core/secrets-file.ts).
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  emptyAuthState,
  newSecretValues,
  parseAuthState,
  parseEnvelope,
  parseSecretValues,
  serializeEnvelope,
  type ProtectedEnvelope,
} from "../core/secrets-file";

function envelope(value: unknown): ProtectedEnvelope | null {
  return parseEnvelope(JSON.stringify(value));
}

test("reads a keyring envelope, with or without the keyring's name", () => {
  assert.deepEqual(envelope({ version: 1, protection: "keyring", backend: "gnome_libsecret", data: "QUJD" }), {
    version: 1,
    protection: "keyring",
    backend: "gnome_libsecret",
    data: "QUJD",
  });
  assert.deepEqual(envelope({ version: 1, protection: "keyring", data: "QQ==" }), {
    version: 1,
    protection: "keyring",
    data: "QQ==",
  });
});

test("refuses a keyring envelope whose data is not base64, or whose keyring name is not text", () => {
  for (const data of ["QUJ", "QU=D", "", "QU JD", 5]) {
    assert.equal(envelope({ version: 1, protection: "keyring", data }), null, String(data));
  }
  assert.equal(envelope({ version: 1, protection: "keyring", backend: 5, data: "QUJD" }), null);
});

test("reads a plain envelope, whatever its values are", () => {
  assert.deepEqual(envelope({ version: 1, protection: "plain", values: { a: 1 } }), {
    version: 1,
    protection: "plain",
    values: { a: 1 },
  });
  assert.deepEqual(envelope({ version: 1, protection: "plain", values: null }), {
    version: 1,
    protection: "plain",
    values: null,
  });
});

test("refuses anything else", () => {
  assert.equal(envelope({ version: 1, protection: "plain" }), null);
  assert.equal(envelope({ version: 2, protection: "plain", values: {} }), null);
  assert.equal(envelope({ version: 1, protection: "rot13", data: "QUJD" }), null);
  assert.equal(envelope([]), null);
  assert.equal(envelope(null), null);
  assert.equal(parseEnvelope("not json"), null);
});

test("what is written reads back the same", () => {
  const written: ProtectedEnvelope = { version: 1, protection: "keyring", backend: "kwallet6", data: "QUJD" };
  const text = serializeEnvelope(written);
  assert.ok(text.endsWith("}\n"));
  assert.deepEqual(parseEnvelope(text), written);
});

const FIXED = newSecretValues((size) => Buffer.alloc(size, 0xab));

test("makes new keys of the right shape from the random bytes it is given", () => {
  assert.deepEqual(FIXED, {
    nextauthSecret: Buffer.alloc(32, 0xab).toString("base64url"),
    appEncryptionKey: "ab".repeat(32),
    githubToken: null,
  });
  assert.equal(FIXED.nextauthSecret.length, 43);
});

test("new keys made from real random bytes always read back", () => {
  for (let i = 0; i < 50; i += 1) {
    const values = newSecretValues((size) => crypto.randomBytes(size));
    assert.deepEqual(parseSecretValues(values), values);
  }
});

test("reads back a saved GitHub token, and a missing one as none", () => {
  const token = "ghp_" + "A".repeat(36);
  assert.deepEqual(parseSecretValues({ ...FIXED, githubToken: token }), { ...FIXED, githubToken: token });
  const { githubToken, ...withoutToken } = FIXED;
  assert.equal(githubToken, null);
  assert.deepEqual(parseSecretValues(withoutToken), FIXED);
});

test("refuses keys that are not exactly what the app writes", () => {
  const bad: [string, unknown][] = [
    ["a sign-in key one character short", { ...FIXED, nextauthSecret: FIXED.nextauthSecret.slice(1) }],
    ["a sign-in key with a character base64url never uses", { ...FIXED, nextauthSecret: "+" + FIXED.nextauthSecret.slice(1) }],
    ["a password key in capital letters", { ...FIXED, appEncryptionKey: FIXED.appEncryptionKey.toUpperCase() }],
    ["a password key one digit short", { ...FIXED, appEncryptionKey: FIXED.appEncryptionKey.slice(1) }],
    ["an empty GitHub token", { ...FIXED, githubToken: "" }],
    ["a GitHub token with a space in it", { ...FIXED, githubToken: "ab cd" }],
    ["a GitHub token that is not text", { ...FIXED, githubToken: 5 }],
    ["no sign-in key", { appEncryptionKey: FIXED.appEncryptionKey }],
    ["nothing", null],
    ["a list", []],
  ];
  for (const [what, value] of bad) assert.equal(parseSecretValues(value), null, what);
});

test("a new sign-in file holds nothing", () => {
  assert.deepEqual(emptyAuthState(), { msalCache: null, lastOnlineCheck: null });
  assert.deepEqual(parseAuthState({}), { msalCache: null, lastOnlineCheck: null });
});

test("reads back the saved sign-in as it was written", () => {
  const state = { msalCache: '{"Account":{}}', lastOnlineCheck: 1_792_000_000_000 };
  assert.deepEqual(parseAuthState(state), state);
  assert.deepEqual(parseAuthState({ msalCache: null, lastOnlineCheck: null }), emptyAuthState());
});

test("refuses a sign-in file that is not what the app writes", () => {
  for (const value of [
    { msalCache: 5 },
    { lastOnlineCheck: "123" },
    { lastOnlineCheck: Number.NaN },
    { lastOnlineCheck: Number.POSITIVE_INFINITY },
    [],
    null,
    "text",
  ]) {
    assert.equal(parseAuthState(value), null, JSON.stringify(value));
  }
});
