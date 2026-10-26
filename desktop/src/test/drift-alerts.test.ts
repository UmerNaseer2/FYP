/**
 * Which drift checks earn a desktop notification, and its words
 * (src/core/drift-alerts.ts).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  driftAlert,
  driftNotification,
  ORG_SLUG_PATTERN,
  readCounts,
  readDriftRow,
  type DriftAlert,
  type DriftCounts,
  type DriftNotification,
  type DriftRow,
} from "../core/drift-alerts";

const ELLIPSIS = String.fromCharCode(0x2026);
const BULLET = String.fromCharCode(0x2022);
const NONE: DriftCounts = { tablesAdded: 0, tablesRemoved: 0, tablesChanged: 0, constraintsChanged: 0, objectsChanged: 0 };

/** A scheduled check that found drift where there was none, with the given changes. */
function rowWith(changes: Partial<DriftRow>): DriftRow {
  return {
    id: 10,
    trackedSchemaId: 3,
    status: "drifted",
    source: "scheduled",
    fingerprint: "fp-new",
    counts: { ...NONE, tablesAdded: 2 },
    schemaName: "public",
    label: "Orders",
    connectionId: 5,
    connectionName: "Production",
    previousStatus: "in_sync",
    lastFingerprint: null,
    orgSlug: "acme",
    ...changes,
  };
}

/** The alert a row earns, failing the test when it earns none. */
function alertFor(changes: Partial<DriftRow>): DriftAlert {
  const alert = driftAlert(rowWith(changes));
  assert.ok(alert, "the row earns an alert");
  return alert;
}

/** The kind of alert a row earns, or null for none. */
function kindOf(changes: Partial<DriftRow>): string | null {
  return driftAlert(rowWith(changes))?.kind ?? null;
}

/** The notification for these alerts, failing the test when there is none. */
function notificationFor(alerts: DriftAlert[], markup = false): DriftNotification {
  const text = driftNotification(alerts, { markup });
  assert.ok(text, "the alerts make a notification");
  return text;
}

test("reads the five counts a check saves, with 0 for any left out", () => {
  assert.deepEqual(
    readCounts({ tablesAdded: 1, tablesRemoved: 2, tablesChanged: 3, constraintsChanged: 4, objectsChanged: 5 }),
    { tablesAdded: 1, tablesRemoved: 2, tablesChanged: 3, constraintsChanged: 4, objectsChanged: 5 },
  );
  // Rows saved before the server counted other objects have no objectsChanged.
  assert.deepEqual(readCounts({ tablesAdded: 1, tablesRemoved: 0, tablesChanged: 0, constraintsChanged: 2 }), {
    ...NONE,
    tablesAdded: 1,
    constraintsChanged: 2,
  });
  assert.deepEqual(readCounts({}), NONE);
});

test("a count that is not a whole number of 0 or more counts as 0", () => {
  assert.deepEqual(
    readCounts({
      tablesAdded: -1,
      tablesRemoved: 1.5,
      tablesChanged: "3",
      constraintsChanged: Number.MAX_SAFE_INTEGER + 1,
      objectsChanged: Number.NaN,
    }),
    NONE,
  );
  assert.deepEqual(readCounts({ tablesAdded: null, tablesRemoved: Number.POSITIVE_INFINITY, tablesChanged: true }), NONE);
});

test("has no counts for a value that is not an object of them", () => {
  for (const detail of [null, undefined, 3, "{}", true, [], [1, 2]]) {
    assert.equal(readCounts(detail), null, JSON.stringify(detail) ?? "undefined");
  }
});

test("reads a row of the watcher's query by its column names, but never the summary", () => {
  assert.deepEqual(
    readDriftRow({
      id: 12,
      tracked_schema_id: "4",
      status: "drifted",
      source: "scheduled",
      summary: "Drift vs v3: 1 table(s) added.",
      fingerprint: "abc",
      detail: { tablesAdded: 1 },
      schema_name: "public",
      label: null,
      connection_id: 5,
      connection_name: "Production",
      previous_status: "in_sync",
      last_fingerprint: null,
      org_slug: "acme",
    }),
    {
      id: 12,
      trackedSchemaId: 4,
      status: "drifted",
      source: "scheduled",
      fingerprint: "abc",
      counts: { ...NONE, tablesAdded: 1 },
      schemaName: "public",
      label: null,
      connectionId: 5,
      connectionName: "Production",
      previousStatus: "in_sync",
      lastFingerprint: null,
      orgSlug: "acme",
    },
  );
});

test("refuses a row without a usable number, status, source or schema name", () => {
  const good = { id: 12, tracked_schema_id: 4, status: "drifted", source: "scheduled", schema_name: "public" };
  assert.ok(readDriftRow(good));
  // The connection is not needed to tell about drift, though an alert without one goes to no phone.
  assert.equal(readDriftRow(good)?.connectionId, null);
  assert.equal(readDriftRow({ ...good, connection_id: "0" })?.connectionId, null);
  assert.equal(readDriftRow({ ...good, id: "9007199254740991" })?.id, Number.MAX_SAFE_INTEGER);
  const bad: [string, unknown][] = [
    ["id", 0],
    ["id", -1],
    ["id", 1.5],
    ["id", "01"],
    ["id", "12a"],
    ["id", "9007199254740993"],
    ["id", "12345678901234567"],
    ["id", null],
    ["tracked_schema_id", undefined],
    ["tracked_schema_id", "0"],
    ["status", null],
    ["status", 3],
    ["source", undefined],
    ["schema_name", null],
  ];
  for (const [column, value] of bad) {
    assert.equal(readDriftRow({ ...good, [column]: value }), null, `${column} = ${String(value)}`);
  }
});

test("only a scheduled check is news, as people saw the rest happen", () => {
  for (const source of ["manual", "tracking", "deploy", "rebaseline", "acknowledged"]) {
    assert.equal(kindOf({ source }), null, source);
  }
  assert.equal(kindOf({ source: "scheduled" }), "drifted");
});

test("tells about drift found and fixed, and a database lost and found, once each", () => {
  const cases: [string, string | null, string | null][] = [
    ["drifted", "in_sync", "drifted"],
    ["drifted", null, "drifted"],
    ["drifted", "unreachable", "reachable"],
    ["in_sync", "drifted", "in_sync"],
    ["in_sync", "unreachable", "reachable"],
    ["in_sync", "in_sync", null],
    ["in_sync", null, null],
    ["unreachable", "in_sync", "unreachable"],
    ["unreachable", "drifted", "unreachable"],
    ["unreachable", null, "unreachable"],
    ["unreachable", "unreachable", null],
    ["some_new_status", "in_sync", null],
  ];
  for (const [status, previousStatus, expected] of cases) {
    assert.equal(kindOf({ status, previousStatus }), expected, `${String(previousStatus)} then ${status}`);
  }
});

test("tells about drift that changed only when both fingerprints are known and differ", () => {
  assert.equal(kindOf({ previousStatus: "drifted", fingerprint: "b", lastFingerprint: "a" }), "changed");
  assert.equal(kindOf({ previousStatus: "drifted", fingerprint: "a", lastFingerprint: "a" }), null);
  assert.equal(kindOf({ previousStatus: "drifted", fingerprint: null, lastFingerprint: "a" }), null);
  assert.equal(kindOf({ previousStatus: "drifted", fingerprint: "a", lastFingerprint: null }), null);
});

test("an alert carries the row's number, schema, connection, counts and whether it found drift", () => {
  assert.deepEqual(alertFor({ id: 41, trackedSchemaId: 7 }), {
    kind: "drifted",
    eventId: 41,
    trackedSchemaId: 7,
    name: "Orders",
    connectionId: 5,
    connectionName: "Production",
    counts: { ...NONE, tablesAdded: 2 },
    drifted: true,
    orgSlug: "acme",
  });
  const back = alertFor({ status: "in_sync", previousStatus: "unreachable", counts: NONE });
  assert.equal(back.kind, "reachable");
  assert.equal(back.drifted, false);
});

test("names a schema by its label, or else by its schema name", () => {
  assert.equal(alertFor({ label: "Orders" }).name, "Orders");
  assert.equal(alertFor({ label: null }).name, "public");
  assert.equal(alertFor({ label: "   " }).name, "public");
  assert.equal(alertFor({ label: null, schemaName: String.fromCharCode(0x200b) }).name, "Schema 3");
});

test("keeps names to one clean line of at most 48 characters", () => {
  const zeroWidth = String.fromCharCode(0x200b);
  const turnAround = String.fromCharCode(0x202e);
  const bell = String.fromCharCode(7);
  assert.equal(alertFor({ label: `Ord${zeroWidth}ers${turnAround}` }).name, "Orders");
  assert.equal(alertFor({ label: "Orders\n\tand\r\nmore" }).name, "Orders and more");
  assert.equal(alertFor({ label: `Orders${bell}more` }).name, "Orders more");
  assert.equal(alertFor({ connectionName: ` Prod${bell} ` }).connectionName, "Prod");
  assert.equal(alertFor({ connectionName: "" }).connectionName, null);
  assert.equal(alertFor({ label: "x".repeat(48) }).name, "x".repeat(48));
  assert.equal(alertFor({ label: "x".repeat(60) }).name, `${"x".repeat(47)}${ELLIPSIS}`);
  // Cut before a space, the space goes too.
  assert.equal(alertFor({ label: `${"x".repeat(46)} ${"y".repeat(10)}` }).name, `${"x".repeat(46)}${ELLIPSIS}`);
  // An emoji is two UTF-16 units but one character, and is never cut in half.
  const face = String.fromCodePoint(0x1f600);
  assert.equal(alertFor({ label: face.repeat(50) }).name, `${face.repeat(47)}${ELLIPSIS}`);
});

test("says what changed when a schema drifts, and opens that schema on the Drift page", () => {
  assert.deepEqual(notificationFor([alertFor({ counts: { ...NONE, tablesAdded: 2, constraintsChanged: 1 } })]), {
    title: "Drift found",
    body: "Orders on Production no longer matches its baseline: 2 tables added and 1 constraint changed.",
    page: "/acme/drift?tab=detail&schema=3",
  });
  assert.equal(
    notificationFor([alertFor({ connectionName: null })]).body,
    "Orders no longer matches its baseline: 2 tables added.",
  );
  for (const counts of [null, NONE]) {
    assert.equal(notificationFor([alertFor({ counts })]).body, "Orders on Production no longer matches its baseline.");
  }
});

test("words each other kind of news", () => {
  const changed = notificationFor([
    alertFor({ previousStatus: "drifted", fingerprint: "b", lastFingerprint: "a", counts: { ...NONE, tablesChanged: 1 } }),
  ]);
  assert.equal(changed.title, "Drift changed");
  assert.equal(changed.body, "The drift in Orders on Production has changed. Now: 1 table changed.");
  assert.equal(
    notificationFor([alertFor({ previousStatus: "drifted", fingerprint: "b", lastFingerprint: "a", counts: NONE })]).body,
    "The drift in Orders on Production has changed.",
  );

  const fixed = notificationFor([alertFor({ status: "in_sync", previousStatus: "drifted", counts: NONE })]);
  assert.equal(fixed.title, "Back in sync");
  assert.equal(fixed.body, "Orders on Production matches its baseline again.");

  const lost = notificationFor([alertFor({ status: "unreachable", previousStatus: "in_sync", counts: null, fingerprint: null })]);
  assert.equal(lost.title, "Database not reachable");
  assert.equal(
    lost.body,
    "Schema Studio could not reach Orders on Production to check it for drift. It tries again at the next check.",
  );

  const found = notificationFor([alertFor({ status: "in_sync", previousStatus: "unreachable", counts: NONE })]);
  assert.equal(found.title, "Database reachable again");
  assert.equal(found.body, "Schema Studio can reach Orders on Production again, and it matches its baseline.");

  const foundDrifted = notificationFor([
    alertFor({ status: "drifted", previousStatus: "unreachable", counts: { ...NONE, tablesRemoved: 1 } }),
  ]);
  assert.equal(foundDrifted.title, "Database reachable again");
  assert.equal(
    foundDrifted.body,
    "Schema Studio can reach Orders on Production again, but it differs from its baseline: 1 table removed.",
  );
  assert.equal(
    notificationFor([alertFor({ status: "drifted", previousStatus: "unreachable", counts: null })]).body,
    "Schema Studio can reach Orders on Production again, but it differs from its baseline.",
  );
});

test("counts in plain words, one or many, with commas and a last and", () => {
  const ones: DriftCounts = { tablesAdded: 1, tablesRemoved: 1, tablesChanged: 1, constraintsChanged: 1, objectsChanged: 1 };
  assert.equal(
    notificationFor([alertFor({ counts: ones })]).body,
    "Orders on Production no longer matches its baseline: 1 table added, 1 table removed, 1 table changed, 1 constraint changed and 1 other object changed.",
  );
  const twos: DriftCounts = { tablesAdded: 2, tablesRemoved: 2, tablesChanged: 2, constraintsChanged: 2, objectsChanged: 2 };
  assert.equal(
    notificationFor([alertFor({ counts: twos })]).body,
    "Orders on Production no longer matches its baseline: 2 tables added, 2 tables removed, 2 tables changed, 2 constraints changed and 2 other objects changed.",
  );
  assert.equal(
    notificationFor([alertFor({ counts: { ...NONE, objectsChanged: 3 } })]).body,
    "Orders on Production no longer matches its baseline: 3 other objects changed.",
  );
});

test("says only the newest news about each schema", () => {
  const drifted = alertFor({ id: 5 });
  const fixed = alertFor({ id: 9, status: "in_sync", previousStatus: "drifted" });
  assert.equal(notificationFor([drifted, fixed]).title, "Back in sync");
  assert.equal(notificationFor([fixed, drifted]).title, "Back in sync");
});

test("lists the news about several schemas, the most pressing first", () => {
  const alerts = [
    alertFor({ id: 1, trackedSchemaId: 1, label: "A", status: "in_sync", previousStatus: "drifted" }),
    alertFor({ id: 2, trackedSchemaId: 2, label: "B", status: "unreachable", previousStatus: "in_sync" }),
    alertFor({ id: 3, trackedSchemaId: 3, label: "C", connectionName: null }),
    alertFor({ id: 4, trackedSchemaId: 4, label: "D", previousStatus: "drifted", fingerprint: "b", lastFingerprint: "a" }),
  ];
  assert.deepEqual(notificationFor(alerts), {
    title: "Drift alerts for 4 schemas",
    body: [
      `${BULLET} C has drifted`,
      `${BULLET} The drift in D on Production has changed`,
      `${BULLET} B on Production cannot be reached`,
      `${BULLET} A on Production is back in sync`,
    ].join("\n"),
    page: "/acme/drift",
  });
  const back = alertFor({ id: 5, trackedSchemaId: 5, label: "E", status: "in_sync", previousStatus: "unreachable" });
  assert.equal(notificationFor([alerts[0], back]).body, `${BULLET} E on Production can be reached again\n${BULLET} A on Production is back in sync`);
});

test("shows at most four lines however many schemas have news", () => {
  const many = Array.from({ length: 6 }, (_, index) => alertFor({ id: 20 + index, trackedSchemaId: 100 + index, label: `S${index}` }));
  const text = notificationFor(many);
  assert.equal(text.title, "Drift alerts for 6 schemas");
  assert.deepEqual(text.body.split("\n"), [
    `${BULLET} S0 on Production has drifted`,
    `${BULLET} S1 on Production has drifted`,
    `${BULLET} S2 on Production has drifted`,
    "And 3 more.",
  ]);
  assert.equal(notificationFor(many.slice(0, 5)).body.split("\n")[3], "And 2 more.");
  assert.deepEqual(notificationFor(many.slice(0, 4)).body.split("\n").length, 4);
  assert.ok(!notificationFor(many.slice(0, 4)).body.includes("more"));
});

test("writes out markup characters in the body only, and only when asked", () => {
  const alert = alertFor({ label: "<b>Orders</b> & co", connectionName: "R&D" });
  const plain = notificationFor([alert]);
  const escaped = notificationFor([alert], true);
  assert.equal(plain.body, "<b>Orders</b> & co on R&D no longer matches its baseline: 2 tables added.");
  assert.equal(escaped.body, "&lt;b&gt;Orders&lt;/b&gt; &amp; co on R&amp;D no longer matches its baseline: 2 tables added.");
  assert.equal(escaped.title, plain.title);
  assert.equal(escaped.page, plain.page);
  const two = notificationFor([alert, alertFor({ id: 11, trackedSchemaId: 4, label: "a<b" })], true);
  assert.equal(two.title, "Drift alerts for 2 schemas");
  assert.ok(two.body.includes("a&lt;b on Production"));
});

test("never says what the database answered", () => {
  const row = readDriftRow({
    id: 30,
    tracked_schema_id: 3,
    status: "unreachable",
    source: "scheduled",
    summary: "connect ECONNREFUSED db.internal.example:5432",
    fingerprint: null,
    detail: null,
    schema_name: "public",
    label: null,
    connection_name: "Production",
    previous_status: "in_sync",
    last_fingerprint: null,
  });
  assert.ok(row);
  const alert = driftAlert(row);
  assert.ok(alert);
  const text = notificationFor([alert]);
  assert.ok(!JSON.stringify(text).includes("internal"), "no part of the database's answer");
});

test("makes no notification from no alerts", () => {
  assert.equal(driftNotification([], { markup: false }), null);
  assert.equal(driftNotification([], { markup: true }), null);
});

test("reads an organization's address only when it has the shape of one", () => {
  const good = { id: 12, tracked_schema_id: 4, status: "drifted", source: "scheduled", schema_name: "public" };
  for (const slug of ["acme", "abc", "team-2", "a".repeat(40)]) {
    assert.equal(readDriftRow({ ...good, org_slug: slug })?.orgSlug, slug);
  }
  // It goes into the page a click opens, so nothing that could make that page
  // something else gets through: no slash, no query, no dots, no capitals.
  for (const slug of ["Acme", "//example.com", "acme/drift", "acme?x=1", "..", "ab", "-acme", "acme-", "a".repeat(41), "", 5, null]) {
    assert.equal(readDriftRow({ ...good, org_slug: slug })?.orgSlug, null, String(slug));
  }
  assert.equal(readDriftRow(good)?.orgSlug, null);
});

test("opens the Drift page in the schema's organization, or in the one opened last when it is not known", () => {
  assert.equal(notificationFor([alertFor({ orgSlug: "beta-team" })]).page, "/beta-team/drift?tab=detail&schema=3");
  // The app sends an address without an organization on to the one opened last.
  assert.equal(notificationFor([alertFor({ orgSlug: null })]).page, "/drift?tab=detail&schema=3");

  const inAcme = [alertFor({ id: 1, trackedSchemaId: 1 }), alertFor({ id: 2, trackedSchemaId: 2 })];
  assert.equal(notificationFor(inAcme).page, "/acme/drift");
  // The Drift page shows one organization at a time, so schemas in two open it in neither.
  const elsewhere = alertFor({ id: 3, trackedSchemaId: 3, orgSlug: "beta-team" });
  assert.equal(notificationFor([...inAcme, elsewhere]).page, "/drift");
  const unknown = alertFor({ id: 4, trackedSchemaId: 4, orgSlug: null });
  assert.equal(notificationFor([...inAcme, unknown]).page, "/drift");
  // Only the newest alert about a schema counts, and so only its organization.
  const moved = alertFor({ id: 9, trackedSchemaId: 1, orgSlug: "beta-team" });
  assert.equal(notificationFor([alertFor({ id: 1, trackedSchemaId: 1 }), moved]).page, "/beta-team/drift?tab=detail&schema=1");
});

test("reads an organization's address by the web app's own rule", () => {
  // This file runs from out/test, two folders below desktop/.
  const source = fs.readFileSync(path.resolve(__dirname, "../../../my-app/lib/org-slug.ts"), "utf8");
  const match = /export const ORG_SLUG_PATTERN = "([^"]+)";/.exec(source);
  assert.ok(match, "my-app/lib/org-slug.ts still sets ORG_SLUG_PATTERN on one line");
  assert.equal(ORG_SLUG_PATTERN, match[1], "Copy ORG_SLUG_PATTERN from my-app/lib/org-slug.ts into src/core/drift-alerts.ts.");
});
