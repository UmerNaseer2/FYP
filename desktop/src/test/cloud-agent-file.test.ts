/**
 * Reading what cloud-link.json holds (src/core/cloud-agent-file.ts). What fails
 * these checks counts as a damaged file, so that a hand-edited or half-written
 * one can never send the token to an address nobody chose.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseCloudLinkState, type CloudLinkState } from "../core/cloud-agent-file";

const GOOD: CloudLinkState = {
  origin: "https://site.example.test",
  token: `ssa_${"t".repeat(43)}`,
  orgName: "Acme Data",
  orgSlug: "acme-data",
  linkedAt: 1_700_000_000_000,
};

test("a link that was saved reads back the same", () => {
  assert.deepEqual(parseCloudLinkState(structuredClone(GOOD)), GOOD);
});

test("an address is read the one way a browser writes it", () => {
  assert.equal(parseCloudLinkState({ ...GOOD, origin: "https://SITE.example.test" })?.origin, "https://site.example.test");
  assert.equal(parseCloudLinkState({ ...GOOD, origin: "http://localhost:3000" })?.origin, "http://localhost:3000");
});

test("anything that is not a whole link is refused", () => {
  for (const value of [null, undefined, "text", 7, []]) assert.equal(parseCloudLinkState(value), null);
  for (const key of Object.keys(GOOD)) {
    const missing: Record<string, unknown> = { ...GOOD };
    delete missing[key];
    assert.equal(parseCloudLinkState(missing), null, key);
  }
});

test("an address the token must not go to is refused", () => {
  for (const origin of [
    "http://site.example.test",
    "https://site.example.test/path",
    "https://site.example.test/?next=1",
    "https://person:word@site.example.test",
    "ftp://site.example.test",
    "site.example.test",
    7,
  ]) {
    assert.equal(parseCloudLinkState({ ...GOOD, origin }), null, String(origin));
  }
});

test("a token that is not one of the site's is refused", () => {
  for (const token of [`abc_${"t".repeat(43)}`, `ssa_${"t".repeat(200)}`, "", 7, null]) {
    assert.equal(parseCloudLinkState({ ...GOOD, token }), null, String(token).slice(0, 10));
  }
});

test("organization text must be there and be short", () => {
  for (const key of ["orgName", "orgSlug"]) {
    for (const text of ["", "x".repeat(201), 7, null]) {
      assert.equal(parseCloudLinkState({ ...GOOD, [key]: text }), null, key);
    }
  }
});

test("a time that is not a time is refused", () => {
  for (const linkedAt of [-1, Number.NaN, Number.POSITIVE_INFINITY, "soon", null]) {
    assert.equal(parseCloudLinkState({ ...GOOD, linkedAt }), null, String(linkedAt));
  }
});
