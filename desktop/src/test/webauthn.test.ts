/**
 * Tests for checking a phone's passkey (src/core/webauthn.ts), with a
 * passkey made in software (software-passkey.ts).
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { checkAssertion, nextSignCount, readNewPasskey, type Expected } from "../core/webauthn";
import { assertion, attestedCredential, authenticatorData, cbor, coseKey, newSoftwarePasskey, registration, RELAY_ORIGIN, type SoftwarePasskey } from "./software-passkey";

function expected(): Expected {
  return { challenge: new Uint8Array(crypto.randomBytes(32)), origin: RELAY_ORIGIN };
}

function bytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buffer);
}

function keyOf(passkey: SoftwarePasskey) {
  return { x: passkey.x.toString("base64url"), y: passkey.y.toString("base64url") };
}

function register(passkey: SoftwarePasskey, wanted: Expected, made = registration(passkey, wanted.challenge)) {
  return readNewPasskey(bytes(made.clientDataJSON), bytes(made.attestationObject), wanted);
}

function check(passkey: SoftwarePasskey, wanted: Expected, signed = assertion(passkey, wanted.challenge), lastCount = 0) {
  return checkAssertion({ authenticatorData: bytes(signed.authenticatorData), clientDataJSON: bytes(signed.clientDataJSON), signature: bytes(signed.signature) }, keyOf(passkey), lastCount, wanted);
}

function reasonOf(result: { ok: boolean; reason?: string }): string | undefined {
  assert.equal(result.ok, false);
  return result.reason;
}

test("a new passkey is read with its ID, key and counter", () => {
  const passkey = newSoftwarePasskey(5);
  const result = register(passkey, expected());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Buffer.from(result.passkey.credentialId), passkey.credentialId);
  assert.deepEqual(result.passkey.key, keyOf(passkey));
  assert.equal(result.passkey.signCount, 5);
});

test("a new passkey made for another challenge, page or type is refused", () => {
  const passkey = newSoftwarePasskey();
  const wanted = expected();
  assert.equal(reasonOf(register(passkey, wanted, registration(passkey, new Uint8Array(32)))), "The passkey signed some other challenge.");
  assert.equal(reasonOf(register(passkey, wanted, registration(passkey, wanted.challenge, { origin: "https://evil.example.test" }))), "The passkey was used on another page than the phone app.");
  assert.equal(reasonOf(register(passkey, wanted, registration(passkey, wanted.challenge, { type: "webauthn.get" }))), "The browser's clientDataJSON is not for webauthn.create.");
  assert.equal(reasonOf(register(passkey, wanted, registration(passkey, wanted.challenge, { clientData: { crossOrigin: true } }))), "The passkey was used inside a frame.");
});

test("a new passkey for another site, or made without the person verified, is refused", () => {
  const passkey = newSoftwarePasskey();
  const wanted = expected();
  assert.equal(reasonOf(register(passkey, wanted, registration(passkey, wanted.challenge, { rpId: "evil.example.test" }))), "The passkey is not for the relay's address.");
  assert.equal(reasonOf(register(passkey, wanted, registration(passkey, wanted.challenge, { flags: 0x41 }))), "The passkey was used without Face ID, a fingerprint or the phone's code.");
  assert.equal(reasonOf(register(passkey, wanted, registration(passkey, wanted.challenge, { flags: 0x44 }))), "The passkey was used without the person there.");
});

test("a new passkey that is not an ES256 key on P-256 is refused", () => {
  const passkey = newSoftwarePasskey();
  const wanted = expected();
  const withKey = (key: Map<number, unknown>) => {
    const authData = authenticatorData(0, {}, attestedCredential(passkey, key as never));
    const made = registration(passkey, wanted.challenge);
    return register(passkey, wanted, { clientDataJSON: made.clientDataJSON, attestationObject: cbor(new Map<string, never>([["fmt", "none" as never], ["attStmt", new Map() as never], ["authData", authData as never]])) });
  };
  const rs256 = new Map(coseKey(passkey)).set(3, -257);
  const extra = new Map(coseKey(passkey)).set(-4, Buffer.alloc(32));
  const offCurve = new Map(coseKey(passkey)).set(-3, Buffer.alloc(32, 1));
  for (const key of [rs256, extra, offCurve]) assert.equal(reasonOf(withKey(key)), "The passkey is not a P-256 key for ES256.");
});

test("an attestation object that is not CBOR a browser writes is refused", () => {
  const passkey = newSoftwarePasskey();
  const wanted = expected();
  const made = registration(passkey, wanted.challenge);
  const broken = [made.attestationObject.subarray(0, made.attestationObject.length - 1), Buffer.concat([made.attestationObject, Buffer.from([0])]), Buffer.from([0xbf, 0xff]), cbor(["fmt"])];
  for (const attestationObject of broken) {
    const result = register(passkey, wanted, { clientDataJSON: made.clientDataJSON, attestationObject });
    assert.equal(result.ok, false);
  }
});

test("a signature by the passkey over the challenge is taken", () => {
  const passkey = newSoftwarePasskey();
  const result = check(passkey, expected());
  assert.deepEqual(result, { ok: true, signCount: 0 });
});

test("a signature by another passkey, or over anything else, is refused", () => {
  const passkey = newSoftwarePasskey();
  const other = newSoftwarePasskey();
  const wanted = expected();
  assert.equal(reasonOf(check(passkey, wanted, assertion(other, wanted.challenge))), "The signature is not the passkey's.");
  assert.equal(reasonOf(check(passkey, wanted, assertion(passkey, new Uint8Array(32)))), "The passkey signed some other challenge.");
  const signed = assertion(passkey, wanted.challenge);
  signed.authenticatorData[33] ^= 1;
  assert.equal(reasonOf(check(passkey, wanted, signed)), "The signature is not the passkey's.");
  assert.equal(reasonOf(check(passkey, wanted, { ...assertion(passkey, wanted.challenge), signature: Buffer.from("not DER") })), "The signature is not the passkey's.");
});

test("a signature for another site, page or type, or without the person verified, is refused", () => {
  const passkey = newSoftwarePasskey();
  const wanted = expected();
  assert.equal(reasonOf(check(passkey, wanted, assertion(passkey, wanted.challenge, { rpId: "evil.example.test" }))), "The passkey is not for the relay's address.");
  assert.equal(reasonOf(check(passkey, wanted, assertion(passkey, wanted.challenge, { origin: "https://evil.example.test" }))), "The passkey was used on another page than the phone app.");
  assert.equal(reasonOf(check(passkey, wanted, assertion(passkey, wanted.challenge, { type: "webauthn.create" }))), "The browser's clientDataJSON is not for webauthn.get.");
  assert.equal(reasonOf(check(passkey, wanted, assertion(passkey, wanted.challenge, { flags: 0x01 }))), "The passkey was used without Face ID, a fingerprint or the phone's code.");
});

test("a signature whose authenticator data carries a new passkey is refused", () => {
  const passkey = newSoftwarePasskey();
  const wanted = expected();
  const authData = authenticatorData(0, {}, attestedCredential(passkey));
  const signed = assertion(passkey, wanted.challenge);
  const signature = crypto.sign("sha256", Buffer.concat([authData, crypto.createHash("sha256").update(signed.clientDataJSON).digest()]), { key: passkey.privateKey, dsaEncoding: "der" });
  assert.equal(reasonOf(check(passkey, wanted, { authenticatorData: authData, clientDataJSON: signed.clientDataJSON, signature })), "The authenticator data could not be read.");
});

test("a passkey's counter must go up, unless it keeps none", () => {
  const passkey = newSoftwarePasskey(10);
  const wanted = expected();
  assert.deepEqual(check(passkey, wanted, assertion(passkey, wanted.challenge), 10), { ok: true, signCount: 11 });
  assert.equal(reasonOf(check(passkey, wanted, assertion(passkey, wanted.challenge), 50)), "The passkey's signature counter went back, so the passkey may have been copied.");
  assert.equal(nextSignCount(0, 0), 0);
  assert.equal(nextSignCount(3, 4), 4);
  assert.equal(nextSignCount(4, 4), null);
  assert.equal(nextSignCount(4, 0), null);
});
