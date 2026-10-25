/**
 * The phone app's screens and their addresses (src/phone/routes.ts): every
 * screen's address reads back as the same screen, and any other address,
 * a pairing link's among them, opens the home screen.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { HOME, parentOf, readRoute, writeRoute, type Route } from "../phone/routes.js";

/** One of each screen, with schema names that need escaping and the biggest ID and longest name there can be. */
const ROUTES: Route[] = [
  { screen: "home" },
  { screen: "connection", connectionId: 1 },
  { screen: "connection", connectionId: Number.MAX_SAFE_INTEGER },
  { screen: "schema", connectionId: 7, schema: "public" },
  { screen: "schema", connectionId: 7, schema: "sales/2026" },
  { screen: "schema", connectionId: 7, schema: "a#b" },
  { screen: "schema", connectionId: 7, schema: "100%" },
  { screen: "schema", connectionId: 7, schema: "my schema" },
  { screen: "schema", connectionId: 7, schema: "caf\u{e9} \u{1F4D6}" },
  { screen: "schema", connectionId: 7, schema: "x".repeat(128) },
  { screen: "compare" },
  { screen: "settings" },
  { screen: "scan" },
  { screen: "approvals" },
  { screen: "approval", approvalId: 1 },
  { screen: "approval", approvalId: Number.MAX_SAFE_INTEGER },
];

test("reads each screen's address back as the same screen", () => {
  for (const route of ROUTES) {
    assert.deepEqual(readRoute(writeRoute(route)), route, `The address ${writeRoute(route)} read back as another screen.`);
  }
});

test("writes no address for the home screen, and one under \"#/\" for every other screen", () => {
  assert.equal(writeRoute(HOME), "");
  assert.equal(writeRoute({ screen: "connection", connectionId: 12 }), "#/connections/12");
  assert.equal(writeRoute({ screen: "schema", connectionId: 12, schema: "public" }), "#/connections/12/schemas/public");
  assert.equal(writeRoute({ screen: "compare" }), "#/compare");
  assert.equal(writeRoute({ screen: "settings" }), "#/settings");
  assert.equal(writeRoute({ screen: "scan" }), "#/scan");
  assert.equal(writeRoute({ screen: "approvals" }), "#/approvals");
  assert.equal(writeRoute({ screen: "approval", approvalId: 31 }), "#/approvals/31");
});

test("escapes a schema name, so that the name stays one part of the address", () => {
  assert.equal(writeRoute({ screen: "schema", connectionId: 3, schema: "a/b#c%d e" }), "#/connections/3/schemas/a%2Fb%23c%25d%20e");
});

test("reads an address with or without its \"#\"", () => {
  assert.deepEqual(readRoute("#/settings"), { screen: "settings" });
  assert.deepEqual(readRoute("/settings"), { screen: "settings" });
  assert.deepEqual(readRoute("/connections/5/schemas/public"), { screen: "schema", connectionId: 5, schema: "public" });
});

test("opens the home screen for no address and for any address it does not know", () => {
  const unknown = [
    "",
    "#",
    "#/",
    "#//",
    "#settings",
    "#x/settings",
    "#x/connections/5",
    "#//settings",
    "#/settings/",
    "#/settings/more",
    "#/Settings",
    "#/home",
    "#/nothing",
    "#/connections",
    "#/connections/",
    "#/connections/5/",
    "#/connections/5/schemas",
    "#/connections/5/schemas/",
    "#/connections/5/schemas/public/",
    "#/connections/5/schemas/public/more",
    "#/connections/5/tables/public",
    "#/connection/5",
    "#/tables/5/schemas/public",
    "#/schemas/public",
    "#/approvals/",
    "#/approvals/5/",
    "#/approvals/5/more",
    "#/approval/5",
    "#/Approvals",
  ];
  for (const hash of unknown) assert.deepEqual(readRoute(hash), HOME, `${hash} did not open the home screen.`);
});

test("opens the home screen for a connection's or a request's ID that is not a whole number from 1", () => {
  const ids = ["0", "00", "007", "-1", "+1", "1.5", "1e3", "0x1f", " 1", "1 ", "%31", "one", "9007199254740992", "12345678901234567"];
  for (const id of ids) {
    assert.deepEqual(readRoute(`#/connections/${id}`), HOME, `The ID ${id} was read as a connection's.`);
    assert.deepEqual(readRoute(`#/connections/${id}/schemas/public`), HOME, `The ID ${id} was read as a connection's.`);
    assert.deepEqual(readRoute(`#/approvals/${id}`), HOME, `The ID ${id} was read as a request's.`);
  }
});

test("opens the home screen for a schema name that is broken, has spaces at an end or is too long", () => {
  const names = ["%E0%A4%A", "%", "%zz", "%20public", "public%20", "%20", "x".repeat(129)];
  for (const name of names) assert.deepEqual(readRoute(`#/connections/5/schemas/${name}`), HOME, `${name} was read as a schema's name.`);
});

test("never reads a pairing link's code as a screen", () => {
  // The shape of a pairing link's "#..." part, with made-up parts.
  const pairing = `#pair=v1.${"A".repeat(22)}.${"B".repeat(43)}.${"C".repeat(43)}`;
  assert.deepEqual(readRoute(pairing), HOME);
});

test("writes a schema name that cannot be escaped as its connection's address instead", () => {
  // Half of an emoji on its own, which encodeURIComponent refuses.
  const broken = `a${String.fromCharCode(0xd83d)}b`;
  assert.equal(writeRoute({ screen: "schema", connectionId: 4, schema: broken }), "#/connections/4");
});

test("goes back from a schema to its connection, from a request to the list of requests, and from every other screen but home to home", () => {
  assert.equal(parentOf(HOME), null);
  assert.deepEqual(parentOf({ screen: "schema", connectionId: 9, schema: "sales" }), { screen: "connection", connectionId: 9 });
  assert.deepEqual(parentOf({ screen: "connection", connectionId: 9 }), HOME);
  assert.deepEqual(parentOf({ screen: "compare" }), HOME);
  assert.deepEqual(parentOf({ screen: "settings" }), HOME);
  assert.deepEqual(parentOf({ screen: "scan" }), HOME);
  assert.deepEqual(parentOf({ screen: "approval", approvalId: 4 }), { screen: "approvals" });
  assert.deepEqual(parentOf({ screen: "approvals" }), HOME);
});
