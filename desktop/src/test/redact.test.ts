/**
 * Taking private things out of diagnostics (src/core/redact.ts).
 *
 * The token-shaped values are put together while the test runs, so the
 * repository itself holds nothing a secret scanner would mistake for a real
 * one.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { redact } from "../core/redact";

const NONE = { secrets: [], home: null };
const PASSWORD = "typed-for-" + "another-server";
const JWT = ["eyJ" + "hbGciOiJSUzI1NiJ9", "eyJ" + "zdWIiOiJ0ZXN0In0", "c2lnbmF0dXJl"].join(".");
const CLASSIC_TOKEN = "ghp_" + "A".repeat(36);
const FINE_GRAINED_TOKEN = "github_pat_" + "B".repeat(30);

test("removes the app's own secrets wherever they appear, the longest first", () => {
  const text = "key abcdefgh12345678 and abcdefgh";
  const secrets = ["abcdefgh", "abcdefgh12345678", null, undefined, "short"];
  assert.equal(redact(text, { secrets, home: null }), "key <secret> and <secret>");
});

test("leaves alone a secret too short to be told apart from ordinary words", () => {
  assert.equal(redact("the word short stays", { secrets: ["short"], home: null }), "the word short stays");
});

test("removes the password from a connection address", () => {
  assert.equal(
    redact("postgres://alice:" + PASSWORD + "@db.example.com:5432/app", NONE),
    "postgres://alice:<password>@db.example.com:5432/app",
  );
});

test("removes what follows Authorization, in a header or in JSON", () => {
  assert.equal(redact("Authorization: Bearer abc.def", NONE), "Authorization: <redacted>");
  assert.equal(redact('{"authorization":"Basic dXNlcjpwYXNz"}', NONE), '{"authorization":"<redacted>"}');
});

test("removes sign-in tokens", () => {
  assert.equal(redact(`token was ${JWT} ok`, NONE), "token was <token> ok");
  assert.equal(redact(`id_token=${JWT}`, NONE), "id_token=<token>");
});

test("removes GitHub tokens of both kinds", () => {
  assert.equal(redact(`pushed with ${CLASSIC_TOKEN} today`, NONE), "pushed with <github-token> today");
  assert.equal(redact(`pushed with ${FINE_GRAINED_TOKEN} today`, NONE), "pushed with <github-token> today");
});

test("removes codes and passwords from addresses, but keeps the rest of the address", () => {
  assert.equal(redact("/?code=abc123&state=xyz", NONE), "/?code=<redacted>&state=xyz");
  assert.equal(redact("https://example.com/?password=" + PASSWORD, NONE), "https://example.com/?password=<redacted>");
});

test("removes the values of password, token and secret settings", () => {
  assert.equal(redact('{"token": "abc"}', NONE), '{"token": "<redacted>"}');
  assert.equal(redact("password=" + PASSWORD, NONE), "password=<redacted>");
  assert.equal(redact("client_secret: abc123", NONE), "client_secret: <redacted>");
});

test("removes email addresses", () => {
  assert.equal(redact("signed in as sam.lee@example.com today", NONE), "signed in as <email> today");
});

test("shows the home folder as ~, but only as a whole folder name", () => {
  const home = { secrets: [], home: "/home/sam" };
  assert.equal(redact("/home/sam/.config", home), "~/.config");
  assert.equal(redact("/home/samantha", home), "/home/samantha");
  assert.equal(redact("(/home/sam)", home), "(~)");
  assert.equal(redact("/home/sam\n/home/sam/logs", home), "~\n~/logs");
  assert.equal(redact("/home/sam/.config", { secrets: [], home: "/home/sam/" }), "~/.config");
  assert.equal(redact("/home/aXb/x", { secrets: [], home: "/home/a.b" }), "/home/aXb/x");
  assert.equal(redact("/etc/os-release", { secrets: [], home: "/" }), "/etc/os-release");
});

test("leaves alone the ordinary lines diagnostics are made of", () => {
  for (const line of [
    "postgres://schema_studio@localhost/schema_studio?host=%2Frun%2Fuser%2F1000%2Fschema-studio&sslmode=disable",
    "Secrets kept in: keyring",
    "GitHub access token saved: yes",
    "The server stopped (exit status 1)",
  ]) {
    assert.equal(redact(line, NONE), line);
  }
});
