// comparison-sets-save: which Comparison sets box a save needs
// (POST /api/comparison-sets, and saveComparisonSet in lib/comparison-sets.ts).
//
// Save is one button for two acts. A name nobody has used makes a new set,
// which needs Comparison sets: Create. A name that is taken rewrites that set,
// which needs Comparison sets: Update. The route lets in a role with either
// box, because only the save can tell which act this is, and the save then
// refuses the one the role is missing.
//
// These tests run the real route over the real save, with a stand-in database
// underneath (tests/helpers/fake-pg.ts), and check that:
//
//   - A refusal names the box the role is missing, in the words the screen
//     shows, and offers "save it under a new name" only when that would work.
//   - The refusal is decided before "a set with that name already exists", so
//     a role that may not overwrite is never asked whether it wants to.
//   - A refused save writes nothing: it rolls back before any INSERT.
//   - The connection goes back exactly once, however the save ends.
//   - The save stays inside the caller's organization: every statement carries
//     it, and a connection that is not the organization's own is refused the
//     same way as one that was deleted, before anything is written.
import { NextRequest, NextResponse } from "next/server";
import type { Gate, Principal } from "@/lib/auth-guard";
import { createFakeClient, queryTexts, type FakeClient } from "./helpers/fake-pg";
import { TEST_ORG, principalFor } from "./helpers/principals";

let mockGate: Gate;
/** The keys each call to requirePermission asked for, in order. */
let mockAskedFor: string[][] = [];

jest.mock("../lib/auth-guard", () => ({
  requirePermission: async (...keys: string[]) => {
    mockAskedFor.push(keys);
    return mockGate;
  },
}));

let mockPool: FakeClient = createFakeClient([]);
let mockClient: FakeClient = createFakeClient([]);
let mockConnects = 0;

// The save's transaction runs on the client connect() hands out; reading the
// set back afterwards goes through the pool's own query(). Both are looked up
// when called, not when the mock is made, because this factory runs before
// the lines above do.
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {
    query: (text: string, values?: unknown[]) => mockPool.query(text, values),
    connect: async () => {
      mockConnects += 1;
      return mockClient;
    },
  },
  syncMetadataTables: async () => undefined,
}));

import { POST } from "@/app/api/comparison-sets/route";
import { parseSaveBody } from "@/lib/comparison-set-rules";
import { saveComparisonSet } from "@/lib/comparison-sets";

/** Two roles an admin might make, each with one of the two boxes. */
const SET_KEEPER = principalFor("viewer", {
  role: "set-keeper",
  roleLabel: "Set keeper",
  permissions: ["comparison_sets:create", "comparison_sets:read"],
});
const SET_TIDIER = principalFor("viewer", {
  role: "set-tidier",
  roleLabel: "Set tidier",
  permissions: ["comparison_sets:read", "comparison_sets:update"],
});
const EDITOR = principalFor("editor");

const NO_CREATE =
  "Your role (Set tidier) can't save a new comparison set. " +
  `Ask an admin to allow "Comparison sets: Create" for this role.`;
const NO_UPDATE =
  "Your role (Set keeper) can't overwrite a saved comparison set. " +
  `Ask an admin to allow "Comparison sets: Update" for this role.`;
const OR_A_NEW_NAME = " Or save it under a new name.";

/** What the Compare screen sends to save "Nightly": one source, one target. */
const NIGHTLY = {
  name: "Nightly",
  sourceConnectionId: 1,
  sourceSchema: "public",
  targets: [{ connectionId: 2, schema: "public" }],
};

/** The id a save of a free name comes back with. */
const NEW_ID = 9;

/** A save that was turned down at the database: it looked, then rolled back. */
const LOOKED_AND_ROLLED_BACK = ["BEGIN", "SELECT id FROM comparison_sets", "ROLLBACK"];
const WRITTEN = [
  "BEGIN",
  "SELECT id FROM comparison_sets",
  "SELECT id FROM connections",
  "INSERT INTO comparison_sets",
  "DELETE FROM comparison_set_targets",
  "INSERT INTO comparison_set_targets",
  "COMMIT",
];

/** The organization's own connections answering for NIGHTLY's source and target. */
const OWN_CONNECTIONS = { match: /SELECT id FROM connections/, rows: [{ id: 1 }, { id: 2 }] };

/**
 * Set up the stand-in database for one save: is the name already taken, and
 * by which set? A taken name rewrites that set; a free one makes set 9.
 */
function nameTakenBy(owner: number | null) {
  const id = owner ?? NEW_ID;
  mockClient = createFakeClient([
    {
      match: /SELECT id FROM comparison_sets WHERE lower\(name\)/,
      rows: owner === null ? [] : [{ id: owner }],
    },
    OWN_CONNECTIONS,
    // What `(xmax = 0) AS created` answers: true only for a row the INSERT made.
    { match: /INSERT INTO comparison_sets\s/, rows: [{ id, created: owner === null }] },
  ]);
  // The read-back once the save has committed. Its targets don't matter here,
  // so that query is left to answer no rows.
  mockPool = createFakeClient([
    {
      match: /FROM comparison_sets s/,
      rows: [
        {
          id,
          name: "Nightly",
          source_connection_id: 1,
          source_connection_label: "Dev",
          source_schema: "public",
          allow_data_loss: false,
          compare_data: false,
          data_tables: [],
          created_at: "2026-10-17T09:00:00.000Z",
          updated_at: "2026-10-17T09:00:00.000Z",
          last_run_at: null,
          live_source_name: "Dev",
        },
      ],
    },
  ]);
}

beforeEach(() => {
  mockGate = { ok: true, principal: EDITOR };
  mockAskedFor = [];
  mockConnects = 0;
  nameTakenBy(null);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** A save request with this exact body text, the way a browser would send it. */
function send(body: string): NextRequest {
  return new NextRequest("http://localhost/api/comparison-sets", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

/** Save as this principal, the way the gate would hand it over. */
async function saveAs(principal: Principal, body: unknown): Promise<[number, unknown]> {
  mockGate = { ok: true, principal };
  const response = await POST(send(JSON.stringify(body)));
  return [response.status, await response.json()];
}

/** The parts of a successful reply that these tests are about. */
function saved(body: unknown) {
  const reply = body as { success: boolean; created: boolean; set: { id: number } };
  return { success: reply.success, created: reply.created, id: reply.set.id };
}

/** What the save said to the database: each statement's verb and table. */
function statements(): string[] {
  return queryTexts(mockClient).map(
    (text) =>
      /^(BEGIN|COMMIT|ROLLBACK|SELECT id FROM \w+|INSERT INTO \w+|DELETE FROM \w+)/.exec(
        text
      )?.[1] ?? text
  );
}

function expectNothingWritten() {
  expect(statements()).toEqual(LOOKED_AND_ROLLED_BACK);
  expect(mockPool.queries).toEqual([]);
  expect([mockConnects, mockClient.releaseCount]).toEqual([1, 1]);
}

function expectWritten() {
  expect(statements()).toEqual(WRITTEN);
  expect([mockConnects, mockClient.releaseCount]).toEqual([1, 1]);
}

/** Keep the route's own console.error out of the test output, and count it. */
function quietErrors() {
  return jest.spyOn(console, "error").mockImplementation(() => {});
}

describe("the gate", () => {
  test("lets in a role with either box, since only the save knows which it needs", async () => {
    await saveAs(SET_KEEPER, NIGHTLY);
    expect(mockAskedFor).toEqual([["comparison_sets:create", "comparison_sets:update"]]);
  });

  test("a refusal goes back as the gate made it, before the body is read", async () => {
    const refusal = NextResponse.json(
      { error: "Your role (Viewer) can't do that." },
      { status: 403 }
    );
    mockGate = { ok: false, response: refusal };
    const request = send(JSON.stringify(NIGHTLY));

    expect(await POST(request)).toBe(refusal);
    expect([request.bodyUsed, mockConnects]).toEqual([false, 0]);
  });
});

describe("a name nobody has used makes a new set", () => {
  test("which needs Comparison sets: Create", async () => {
    expect(await saveAs(SET_TIDIER, NIGHTLY)).toEqual([
      403,
      { error: NO_CREATE, conflict: false },
    ]);
    expectNothingWritten();
  });

  test("even with a set open, because saving under a new name is still a new set", async () => {
    expect(await saveAs(SET_TIDIER, { ...NIGHTLY, id: 5, name: "Nightly copy" })).toEqual([
      403,
      { error: NO_CREATE, conflict: false },
    ]);
    expectNothingWritten();
  });

  test("goes through for a role that has only Create", async () => {
    const [status, body] = await saveAs(SET_KEEPER, NIGHTLY);
    expect([status, saved(body)]).toEqual([200, { success: true, created: true, id: NEW_ID }]);
    expectWritten();
  });
});

describe("a name that is taken rewrites that set", () => {
  test("which needs Comparison sets: Update, and says a new name would do", async () => {
    nameTakenBy(5);
    expect(await saveAs(SET_KEEPER, { ...NIGHTLY, id: 5 })).toEqual([
      403,
      { error: NO_UPDATE + OR_A_NEW_NAME, conflict: false },
    ]);
    expectNothingWritten();
  });

  test("and the advice holds: the same role can save it under a new name", async () => {
    nameTakenBy(null);
    const [status, body] = await saveAs(SET_KEEPER, { ...NIGHTLY, id: 5, name: "Nightly copy" });
    expect([status, saved(body)]).toEqual([200, { success: true, created: true, id: NEW_ID }]);
    expectWritten();
  });

  test("goes through for a role that has only Update, on the set it has open", async () => {
    nameTakenBy(5);
    const [status, body] = await saveAs(SET_TIDIER, { ...NIGHTLY, id: 5 });
    expect([status, saved(body)]).toEqual([200, { success: true, created: false, id: 5 }]);
    expectWritten();
  });

  test("is refused before anyone is asked about replacing a different set", async () => {
    // Set 3 owns the name and set 5 is open. Answering 409 here would put up
    // "replace it?" for a role that could never say yes.
    nameTakenBy(3);
    expect(await saveAs(SET_KEEPER, { ...NIGHTLY, id: 5 })).toEqual([
      403,
      { error: NO_UPDATE + OR_A_NEW_NAME, conflict: false },
    ]);
    expectNothingWritten();
  });

  test("asks before replacing a different set, for a role that may", async () => {
    nameTakenBy(3);
    expect(await saveAs(EDITOR, { ...NIGHTLY, id: 5 })).toEqual([
      409,
      { error: 'A saved set called "Nightly" already exists.', conflict: true },
    ]);
    expectNothingWritten();
  });

  test("replaces it once the person has said yes", async () => {
    nameTakenBy(3);
    const [status, body] = await saveAs(EDITOR, { ...NIGHTLY, id: 5, overwrite: true });
    expect([status, saved(body)]).toEqual([200, { success: true, created: false, id: 3 }]);
    expectWritten();
  });

  test("offers no new name to a role that could not save one either", async () => {
    // The route's gate never lets a role with neither box this far, but the
    // save keeps its own rule all the same, so it is checked on its own.
    nameTakenBy(5);
    const result = await saveComparisonSet(TEST_ORG.id, parseSaveBody({ ...NIGHTLY, id: 5 }), {
      mayCreate: false,
      mayUpdate: false,
      roleLabel: "Viewer",
    });
    expect(result).toEqual({
      ok: false,
      error:
        "Your role (Viewer) can't overwrite a saved comparison set. " +
        `Ask an admin to allow "Comparison sets: Update" for this role.`,
      conflict: false,
      refused: true,
    });
    expectNothingWritten();
  });
});

describe("around the database", () => {
  test("a set that can't be saved is explained before a connection is taken", async () => {
    expect(await saveAs(SET_KEEPER, { ...NIGHTLY, name: "   " })).toEqual([
      400,
      { error: "Give the set a name so you can find it again.", conflict: false },
    ]);
    expect(mockConnects).toBe(0);
  });

  test("a body that isn't JSON is turned down before a connection is taken", async () => {
    const response = await POST(send("{not json"));
    expect([response.status, await response.json()]).toEqual([
      400,
      { error: "Expected a JSON body." },
    ]);
    expect(mockConnects).toBe(0);
  });

  test("a failed write rolls back, gives the connection back once, and says so", async () => {
    const errors = quietErrors();
    mockClient = createFakeClient([
      OWN_CONNECTIONS,
      { match: /INSERT INTO comparison_sets\s/, error: { message: "Connection terminated" } },
    ]);

    expect(await saveAs(SET_KEEPER, NIGHTLY)).toEqual([
      500,
      { error: "Could not save that comparison set." },
    ]);
    expect(statements()).toEqual([
      "BEGIN",
      "SELECT id FROM comparison_sets",
      "SELECT id FROM connections",
      "INSERT INTO comparison_sets",
      "ROLLBACK",
    ]);
    expect([mockConnects, mockClient.releaseCount]).toEqual([1, 1]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toBe("POST comparison set error:");
  });
});

describe("inside the caller's organization", () => {
  test("every statement of a save carries the caller's organization", async () => {
    const [status] = await saveAs(EDITOR, NIGHTLY);
    expect(status).toBe(200);

    const sent = mockClient.queries;
    const find = (pattern: RegExp) => sent.find((q) => pattern.test(q.text))?.values ?? [];
    expect(find(/SELECT id FROM comparison_sets/)).toEqual(["Nightly", TEST_ORG.id]);
    expect(find(/SELECT id FROM connections/)).toEqual([TEST_ORG.id, [1, 2]]);
    expect(find(/INSERT INTO comparison_sets\s/)[7]).toBe(TEST_ORG.id);
    expect(find(/DELETE FROM comparison_set_targets/)).toEqual([NEW_ID, TEST_ORG.id]);
    expect(find(/INSERT INTO comparison_set_targets/)[5]).toBe(TEST_ORG.id);
    // The read-back after COMMIT asks for the set in the same organization.
    expect(mockPool.queries[0].values).toEqual([NEW_ID, TEST_ORG.id]);
  });

  test("a connection that is not the organization's own is refused before anything is written", async () => {
    // Target 2 is another organization's connection, or one that was deleted:
    // the lookup cannot tell them apart and neither can the person saving.
    mockClient = createFakeClient([
      { match: /SELECT id FROM comparison_sets WHERE lower\(name\)/, rows: [] },
      { match: /SELECT id FROM connections/, rows: [{ id: 1 }] },
    ]);

    expect(await saveAs(EDITOR, NIGHTLY)).toEqual([
      400,
      {
        error: "One of the connections in this set no longer exists. Pick it again, then save.",
        conflict: false,
      },
    ]);
    expect(statements()).toEqual([
      "BEGIN",
      "SELECT id FROM comparison_sets",
      "SELECT id FROM connections",
      "ROLLBACK",
    ]);
    expect(mockPool.queries).toEqual([]);
    expect([mockConnects, mockClient.releaseCount]).toEqual([1, 1]);
  });

  test("the same connection named twice is looked up once", async () => {
    // Source and target on one server, different schemas: a normal set. The
    // check counts distinct ids, so one row back is the whole answer.
    mockClient = createFakeClient([
      { match: /SELECT id FROM comparison_sets WHERE lower\(name\)/, rows: [] },
      { match: /SELECT id FROM connections/, rows: [{ id: 1 }] },
      { match: /INSERT INTO comparison_sets\s/, rows: [{ id: NEW_ID, created: true }] },
    ]);
    const [status] = await saveAs(EDITOR, {
      ...NIGHTLY,
      targets: [{ connectionId: 1, schema: "staging" }],
    });

    expect(status).toBe(200);
    expect(mockClient.queries.find((q) => /FROM connections/.test(q.text))?.values).toEqual([
      TEST_ORG.id,
      [1],
    ]);
  });
});
