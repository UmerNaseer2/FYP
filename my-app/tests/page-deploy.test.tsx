/** @jest-environment jsdom */

/**
 * The Deploy screen, on the stops in front of the only button in this app that
 * runs SQL against somebody's real database.
 *
 * Everything else here can be read again or thrown away. A deploy cannot: it
 * commits on a live target, and this page's own words are what the reader
 * trusts when deciding to press it. So the tests below are about refusals —
 * who may run at all, what the page warns about first, and whether an
 * approval covers the SQL actually selected — and then about the two moments
 * where a wrong screen becomes a wrong database: what the run sends, and what
 * it says afterwards about what happened.
 *
 * What is NOT here:
 *  - The "Roll back to" panel and the revert route. A rollback is a second run
 *    with its own preview, its own warnings and its own approval; reaching it
 *    through this page would be a suite of its own, not a few more cases.
 *  - A run whose outcome is not known — the recovery bar, and the rows that
 *    say so. It turns on an answer the page could not read at all, which is a
 *    different reply, a different set of row wordings and a different thing to
 *    tell the reader than the failure the last test below covers.
 *  - The pin a clean rehearsal leaves behind, and the offer to run for real
 *    that comes with it.
 *  - The audit trail (/api/scripts/attempts). Its failures are swallowed on
 *    purpose — a metadata database that is briefly unreachable must not put an
 *    error banner over a deploy screen that is otherwise working — so there is
 *    nothing here for a test to see.
 *  - The Verify stage: the ledger re-read and the drift check that follow a
 *    successful run.
 *  - An empty or unversioned target (lib/deploy-init's "needs-init" and
 *    "unversioned" stages). Every test here starts from a target that already
 *    has a version applied, so the initialise path is untested by this file.
 *  - The "Applies-to" restriction, which lib/application-targeting decides and
 *    tests/application-targeting.test.ts already covers.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);
jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import DeployPage from "@/app/[org]/(studio)/deploy/page";
import { sha256Hex } from "@/components/studio/ApprovalPanel";
import { REQUESTS_CHANGED_EVENT } from "@/lib/access-requests";
import { fingerprintBody } from "@/lib/approval-fingerprint";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  render,
  resetPageState,
  setCustomRole,
  setRoutes,
  setSearchParams,
  setUser,
  type FetchRoute,
} from "./helpers/render-page";

/**
 * Four targets, differing only in what they are allowed to have run against
 * them. The SQL and the schema are the same on all of them, so a refusal below
 * can only be about the connection.
 */
const CONNECTIONS = [
  {
    id: 1,
    name: "Dev box",
    host: "dev.internal",
    port: 5432,
    database_name: "shop",
    type: "PostgreSQL",
  },
  {
    id: 2,
    name: "Prod box",
    host: "prod.internal",
    port: 5432,
    database_name: "shop",
    type: "PostgreSQL",
  },
  {
    id: 3,
    name: "Admins only",
    host: "locked.internal",
    port: 5432,
    database_name: "shop",
    type: "PostgreSQL",
    execute_role: "admin",
  },
  {
    id: 4,
    name: "Reference copy",
    host: "reference.internal",
    port: 5432,
    database_name: "shop",
    type: "PostgreSQL",
    execute_role: "none",
  },
];

// Two additive migrations: nothing breaking, nothing that deletes rows, no
// transaction statement. Every gate that fires in this file is therefore one
// the test asked for rather than one the SQL brought with it.
const ADD_DUE_DATE = "ALTER TABLE invoices\n  ADD COLUMN due_date date;";
const ADD_NOTES = "ALTER TABLE invoices\n  ADD COLUMN notes text;";

const SCRIPTS = [
  {
    database_name: "shop",
    schema_name: "public",
    script_name: "invoices",
    version: "1.0.1",
    path: "shop/public/invoices/1.0.1.sql",
    sql_content: ADD_DUE_DATE,
  },
  {
    database_name: "shop",
    schema_name: "public",
    script_name: "invoices",
    version: "1.0.2",
    path: "shop/public/invoices/1.0.2.sql",
    sql_content: ADD_NOTES,
  },
];

/** A target already carrying v1.0.0, so both scripts above are pending. */
function preflight() {
  return {
    hasVersionTable: true,
    needsInit: false,
    applications: { known: false, names: [], source: null },
    schemaExists: true,
    tableCount: 12,
    currentVersion: "1.0.0",
    timeline: [
      {
        version: "1.0.0",
        title: "invoices",
        change_type: "additive",
        applied_at: "2026-01-01T09:00:00.000Z",
      },
    ],
    schema: "public",
    scriptName: "invoices",
    message: "Target is at v1.0.0.",
  };
}

/**
 * Every answer the screen needs to get as far as a run, with no risk on any of
 * them: the schema is not tracked, so the drift check has nothing to compare
 * and stops there, and the approvals list is empty.
 */
function baseRoutes(): FetchRoute[] {
  return [
    { match: "/api/connections", body: CONNECTIONS },
    { match: "/api/github/pull", body: { ok: true, scripts: SCRIPTS, warnings: [] } },
    { match: "/api/scripts/schemas", body: { schemas: ["public"] } },
    { match: "/api/scripts/preflight", method: "POST", body: preflight() },
    { match: "/api/scripts/attempts", body: { attempts: [] } },
    { match: "/api/lineage/lookup", body: { tracked: false } },
    { match: "/api/deploy/approvals", body: { approvals: [] } },
  ];
}

/** One approval row, in the shape /api/deploy/approvals returns. */
function approval(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    target_version: "1.0.2",
    run_fingerprint: "not-the-hash-of-anything-on-screen",
    migration_count: 2,
    breaking_count: 0,
    requested_by: "someone@example.com",
    run_by_requester: true,
    requested_at: "2026-01-02T09:00:00.000Z",
    status: "approved",
    decided_by: "boss@example.com",
    decided_at: "2026-01-02T10:00:00.000Z",
    self_approved: false,
    note: null,
    used_at: null,
    action: "deploy",
    ...over,
  };
}

/** The fingerprint the page will compute for both versions, as the server spells it. */
function runFingerprint() {
  return sha256Hex(
    fingerprintBody(
      SCRIPTS.map((s) => ({
        scriptName: s.script_name,
        version: s.version,
        sqlContent: s.sql_content,
      }))
    )
  );
}

/** Open one of the three pickers and take an option out of it. */
async function pick(box: "Connection" | "Schema" | "Script group", option: string | RegExp) {
  const combobox = await screen.findByRole("combobox", { name: box });
  await waitFor(() => expect(combobox).toBeEnabled());
  fireEvent.click(combobox);
  fireEvent.click(await screen.findByRole("option", { name: option }, { timeout: 3000 }));
}

/**
 * Pick a target, read it, and select both pending versions for the run.
 *
 * "Run all" selects; it never runs. Everything after this point is the panel
 * of stops between that selection and the database.
 */
async function selectBothVersions(connection: string | RegExp) {
  await pick("Connection", connection);
  await pick("Schema", "public");
  await pick("Script group", "invoices");
  const check = await screen.findByRole("button", { name: "Check database" });
  await waitFor(() => expect(check).toBeEnabled());
  fireEvent.click(check);
  fireEvent.click(await screen.findByRole("button", { name: "Run all (2)…" }, { timeout: 3000 }));
}

const deployButton = (suffix = "") =>
  screen.findByRole("button", { name: `Deploy v1.0.1 → v1.0.2 (2)${suffix}` }, { timeout: 3000 });
const dryRunButton = () =>
  screen.findByRole("button", { name: "Dry run v1.0.1 → v1.0.2" }, { timeout: 3000 });

/** What the page sent to the apply route, parsed. */
function lastApply(): Record<string, unknown> {
  const call = [...fetchCalls].reverse().find((c) => c.url.includes("/api/scripts/apply"));
  if (!call?.body) throw new Error("The page never called the apply route");
  return JSON.parse(call.body) as Record<string, unknown>;
}

/** The address setUser("editor") signs in with. */
const EDITOR = "editor@example.com";

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("who is allowed to run anything here", () => {
  it("lets an editor ask for approval on a connection limited to admins", async () => {
    // An editor may run deployments elsewhere, but not on a connection kept for
    // admins. They are not refused outright: they can ask an Admin to approve
    // this exact run, and then run it once. Until then nothing runs, and a
    // rehearsal is not open to them either (it executes the SQL too).
    setUser("editor");
    setRoutes(baseRoutes());
    render(<DeployPage />);
    await selectBothVersions(/Admins only/);

    expect(await deployButton()).toBeDisabled();
    expect(await dryRunButton()).toBeDisabled();
    expect(await screen.findByText("Needs an Admin's approval")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask for approval" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your role may not run migrations here by itself, so the deploy waits for an Admin to " +
          "approve it. A dry run is not open to you here"
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/may run deployments/)).not.toBeInTheDocument();
  });

  it("lets a role without Deploy: Run ask for approval of one exact run", async () => {
    // A viewer may read everything on this page (Deploy: Read), which is why
    // the page opens at all. Running needs the second box, or an Admin's yes
    // for this exact run.
    setUser("viewer");
    setRoutes(baseRoutes());
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);

    expect(await deployButton()).toBeDisabled();
    expect(await dryRunButton()).toBeDisabled();
    expect(await screen.findByText("Needs an Admin's approval")).toBeInTheDocument();
    expect(screen.getByText(/Execution · Viewer may run this only with an Admin's approval/)).toBeInTheDocument();
    expect(screen.queryByText(/Running migrations on this connection needs a role/)).toBeNull();
  });

  it("does not read approvals for a role that may run by itself and may not answer", async () => {
    // A role an admin made with "Deploy: Run" but without any approval box.
    // It just runs, so the page must not ask for a list nobody needs.
    setCustomRole("deployer", "Deployer", ["deploy:read", "deploy:run"]);
    setRoutes(baseRoutes());
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);

    const deploy = await deployButton();
    await waitFor(() => expect(deploy).toBeEnabled());
    expect(await dryRunButton()).toBeEnabled();
    expect(screen.queryByText("Approval state unknown")).not.toBeInTheDocument();
    expect(fetchCalls.some((call) => call.url.includes("/api/deploy/approvals"))).toBe(false);
  });

  it("keeps Deploy shut for a role that has to ask but may not read approvals", async () => {
    // The page must not ask for a list the route would refuse, and must not
    // read the missing list as "nothing approved yet" either: the state is
    // unknown, and Deploy stays shut because nothing on screen can show it is
    // cleared. (The server checks again on the press either way.)
    setCustomRole("reader", "Reader", ["deploy:read"]);
    setRoutes(baseRoutes());
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);

    expect(await screen.findByText("Approval state unknown")).toBeInTheDocument();
    expect(screen.getByText(/^Your role \(Reader\) can't see approval requests\./)).toBeInTheDocument();
    expect(fetchCalls.some((call) => call.url.includes("/api/deploy/approvals"))).toBe(false);
    expect(await deployButton()).toBeDisabled();
  });

  it("runs nothing at all against a read-only connection, rehearsals included", async () => {
    // Read-only is a fact about the database, not a permission to be granted,
    // so an admin is refused here as well, and the sentence must not blame the
    // role, because no box on the Admin screen changes it.
    setUser("admin");
    setRoutes(baseRoutes());
    render(<DeployPage />);
    await selectBothVersions(/Reference copy/);

    expect(await deployButton()).toBeDisabled();
    // The rehearsal too: a dry run really executes the SQL against the target
    // before rolling it back, so it is a write this connection does not allow.
    expect(await dryRunButton()).toBeDisabled();
    expect(
      screen.getByText(
        "This connection is marked read-only on Connections, so nothing here will run " +
          "against it — not a deploy and not a dry run"
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/limited to admins|may run deployments/)).not.toBeInTheDocument();
  });
});

describe("the warnings in front of a run", () => {
  it("holds both buttons while the drift check is still out", async () => {
    // The check's result replaces the record the apply route holds a run to,
    // so between asking and answering this page cannot yet show the warning
    // that record may turn out to carry. A run started in that window would
    // go ahead past a warning the reader was never shown.
    setRoutes([
      { match: "/api/lineage/lookup", body: { tracked: true, trackedSchemaId: 7 } },
      {
        match: "/api/lineage/drift",
        method: "POST",
        body: {
          status: "in_sync",
          summary: "The live schema matches the snapshot.",
          counts: null,
          expectedVersion: "1.0.0",
          checkedAt: "2026-01-03T09:00:00.000Z",
        },
      },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);

    const releaseDrift = holdNext("/api/lineage/drift", "POST");
    await selectBothVersions(/Dev box/);

    expect(await deployButton()).toBeDisabled();
    expect(await dryRunButton()).toBeDisabled();
    expect(
      screen.getByText("Checking the target for drift first — these unlock when the check finishes")
    ).toBeInTheDocument();

    releaseDrift();
    // Waited for rather than read straight away: the answer has to land and
    // the gates recompute before either button can change.
    await waitFor(async () => expect(await deployButton()).toBeEnabled(), { timeout: 3000 });
    expect(await dryRunButton()).toBeEnabled();
  });

  it("shows the drift as a warning, with nothing to tick", async () => {
    // Drift means the target is not the database these migrations were written
    // against, so a statement may hit an object that is not the one it expects.
    // That is a reason to stop and read, not a reason to forbid the run, so it
    // is a warning and nothing else.
    setRoutes([
      { match: "/api/lineage/lookup", body: { tracked: true, trackedSchemaId: 7 } },
      {
        match: "/api/lineage/drift",
        method: "POST",
        body: {
          status: "drifted",
          summary: "2 tables differ from the snapshot.",
          counts: null,
          expectedVersion: "1.0.0",
          checkedAt: "2026-01-03T09:00:00.000Z",
        },
      },
      {
        match: "/api/scripts/apply",
        method: "POST",
        body: {
          success: true,
          results: SCRIPTS.map((s) => ({
            script_name: s.script_name,
            version: s.version,
            status: "applied",
            statements: 1,
          })),
        },
      },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);

    // The drift is shown, but nothing has to be ticked.
    expect(await screen.findByText("The target has drifted")).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "I have read the drift and mean to run anyway." })
    ).not.toBeInTheDocument();
    const deploy = await deployButton();
    await waitFor(() => expect(deploy).toBeEnabled());
    fireEvent.click(deploy);

    await screen.findByText("Deploy complete \u00b7 up to v1.0.2", undefined, { timeout: 3000 });
    expect(Object.keys(lastApply()).filter((key) => key.startsWith("acknowledge"))).toEqual([]);
    // The run re-reads the ledger and re-checks drift on its way out; let those
    // land inside act rather than after the test has finished with the page.
    await flushAsync();
  });
});

describe("what the page says about deleting rows", () => {
  /** The usual two scripts, with the second one's SQL swapped. */
  function routesWithSecondScript(sql: string): FetchRoute[] {
    const scripts = [SCRIPTS[0], { ...SCRIPTS[1], sql_content: sql }];
    return [{ match: "/api/github/pull", body: { ok: true, scripts, warnings: [] } }, ...baseRoutes()];
  }

  it("says what was checked when it found nothing, not that nothing deletes rows", async () => {
    // The reader looks for statements. A function the script calls can still
    // delete rows, so "nothing deletes rows" was more than the page knew.
    setRoutes(baseRoutes());
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);

    expect(await screen.findByText("No statement found that deletes rows")).toBeInTheDocument();
    expect(screen.queryByText("Nothing in this run deletes rows")).not.toBeInTheDocument();
  });

  it("says a TRUNCATE deletes rows", async () => {
    setRoutes(routesWithSecondScript("TRUNCATE invoices;"));
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);

    expect(await screen.findByText("1 migration deletes rows")).toBeInTheDocument();
    expect(screen.getByText(/This run contains TRUNCATE\. Those take rows out of a live table/)).toBeInTheDocument();
    expect(screen.getByText(/Deletes rows · TRUNCATE in 1 script/)).toBeInTheDocument();
    // The warning only tells: there is no sentence to tick.
    expect(screen.queryByText(/know which rows they delete/)).not.toBeInTheDocument();
  });

  it("says SQL it could not read may delete rows, not that it does", async () => {
    // EXECUTE in a DO block runs SQL from a string. The reader cannot see what
    // the string will be, so it may be a TRUNCATE and it may be nothing of the kind.
    setRoutes(
      routesWithSecondScript("DO $$\nBEGIN\n  EXECUTE 'ALTER TABLE ' || 'invoices' || ' ADD COLUMN notes text';\nEND\n$$;")
    );
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);

    expect(await screen.findByText("1 migration may delete rows")).toBeInTheDocument();
    expect(screen.getByText(/Part of the SQL could not be read: an EXECUTE inside a DO block/)).toBeInTheDocument();
    expect(screen.getByText(/May delete rows · part of the SQL could not be read in 1 script/)).toBeInTheDocument();

    // None of the words that say rows are deleted for certain.
    expect(screen.queryByText(/Those take rows out of a live table/)).not.toBeInTheDocument();
    expect(screen.queryByText(/migration deletes rows/)).not.toBeInTheDocument();
    expect(screen.queryByText(/know whether it deletes rows/)).not.toBeInTheDocument();
  });

  it("says both when a run has a TRUNCATE and SQL it could not read", async () => {
    setRoutes(
      routesWithSecondScript("TRUNCATE invoices;\nDO $$\nBEGIN\n  EXECUTE 'ANALYZE ' || 'invoices';\nEND\n$$;")
    );
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);

    expect(await screen.findByText("1 migration deletes rows")).toBeInTheDocument();
    expect(
      screen.getByText(/This run contains TRUNCATE\. Those take rows out of a live table.*Part of the SQL could not be read/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Deletes rows · TRUNCATE, and part of the SQL could not be read in 1 script/)
    ).toBeInTheDocument();
  });
});

describe("an approval for somebody whose role may not run here", () => {
  // An editor on a connection kept for admins: they ask, an Admin approves
  // that exact run, and they may then run it once.
  beforeEach(() => setUser("editor"));

  it("does not count an approval recorded for different SQL, and says why", async () => {
    // The failure this exists for is a conversation: the panel says "Needs an
    // Admin's approval" while the approver insists they approved it. Both are
    // true, since the approval is on the list and covers SQL that has since
    // changed, so the panel has to name it rather than stay silent.
    setRoutes([
      { match: "/api/deploy/approvals", body: { approvals: [approval({ requested_by: EDITOR })] } },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await selectBothVersions(/Admins only/);

    const panel = (await screen.findByText("Needs an Admin's approval")).closest(".appr") as HTMLElement;
    expect(panel).toHaveTextContent("Approved for a different selection: through v1.0.2");
    expect(panel).toHaveTextContent(/has changed since it was approved/);
    await flushAsync();
    expect(await deployButton()).toBeDisabled();
  });

  it("does not count an approval somebody else asked for", async () => {
    // The route lets a person spend only the approval they asked for.
    setRoutes([
      {
        match: "/api/deploy/approvals",
        body: { approvals: [approval({ run_fingerprint: await runFingerprint() })] },
      },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await selectBothVersions(/Admins only/);

    expect(await screen.findByText("Needs an Admin's approval")).toBeInTheDocument();
    await flushAsync();
    expect(await deployButton()).toBeDisabled();
  });

  it("clears the deploy when their approval covers exactly the SQL on screen", async () => {
    // Hashed here the way the server hashes it, from the same module the page
    // uses, so this passes only if the page really compared the two rather
    // than settling for "an approval exists for this target".
    setRoutes([
      {
        match: "/api/deploy/approvals",
        body: {
          approvals: [approval({ run_fingerprint: await runFingerprint(), requested_by: EDITOR })],
        },
      },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await selectBothVersions(/Admins only/);

    expect(await screen.findByText("Approved for you, once")).toBeInTheDocument();
    const deploy = await deployButton();
    await waitFor(() => expect(deploy).toBeEnabled());
    // A dry run runs the SQL too, so it stays shut for them.
    expect(await dryRunButton()).toBeDisabled();
  });

  it("shows an Admin no approval panel when nobody has asked", async () => {
    setUser("admin");
    setRoutes(baseRoutes());
    render(<DeployPage />);
    await selectBothVersions(/Admins only/);

    const deploy = await deployButton();
    await waitFor(() => expect(deploy).toBeEnabled());
    expect(screen.queryByText(/Needs an/)).not.toBeInTheDocument();
  });
});

describe("the run itself", () => {
  it("sends exactly the range the button names", async () => {
    // Each pending row's own "Run …" picks a shorter run: from the first
    // pending version up to that row. What the button says is what the server
    // is asked to run, and the gap between those two is a version applied by
    // somebody who did not mean to apply it.
    setRoutes([
      {
        match: "/api/scripts/apply",
        method: "POST",
        body: {
          success: true,
          results: [
            { script_name: "invoices", version: "1.0.1", status: "applied", statements: 1 },
          ],
        },
      },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await pick("Connection", /Dev box/);
    await pick("Schema", "public");
    await pick("Script group", "invoices");
    fireEvent.click(await screen.findByRole("button", { name: "Check database" }));

    // The first row only, not both.
    fireEvent.click(await screen.findByRole("button", { name: "Run v1.0.1…" }, { timeout: 3000 }));
    const deploy = await screen.findByRole("button", { name: "Deploy v1.0.1" }, { timeout: 3000 });
    await waitFor(() => expect(deploy).toBeEnabled());
    fireEvent.click(deploy);

    // Named v1.0.1 on the button, and v1.0.1 is where the finished run says it
    // stopped.
    await screen.findByText("Deploy complete \u00b7 up to v1.0.1", undefined, { timeout: 3000 });
    const sent = lastApply();
    expect(sent).toMatchObject({
      connectionId: 1,
      schemaName: "public",
      dryRun: false,
    });
    // No tick is sent, because there is none to give.
    expect(Object.keys(sent).filter((key) => key.startsWith("acknowledge"))).toEqual([]);
    expect(sent.scripts).toEqual([
      expect.objectContaining({
        script_name: "invoices",
        version: "1.0.1",
        sql_content: ADD_DUE_DATE,
        source_ref: "shop/public/invoices/1.0.1.sql",
      }),
    ]);
    await flushAsync();
  });

  it("names the version that failed, and does not claim the others applied", async () => {
    // The whole run is one transaction, so a failure anywhere leaves nothing
    // behind. A row the server said nothing about is therefore skipped, not
    // unknown and certainly not applied — and the reader deciding whether to
    // retry is deciding on exactly this.
    setRoutes([
      {
        match: "/api/scripts/apply",
        method: "POST",
        status: 500,
        body: {
          success: false,
          error: 'relation "invoices" does not exist',
          results: [
            {
              script_name: "invoices",
              version: "1.0.1",
              status: "failed",
              error: 'relation "invoices" does not exist',
            },
          ],
        },
      },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);

    const deploy = await deployButton();
    await waitFor(() => expect(deploy).toBeEnabled());
    fireEvent.click(deploy);

    const failed = (
      await screen.findByText("failed · the whole run was rolled back", undefined, { timeout: 3000 })
    ).closest(".dp-mig-row") as HTMLElement;
    expect(failed).toHaveTextContent("v1.0.1");

    const skipped = screen
      .getByText("skipped · the run rolled back before this one could commit")
      .closest(".dp-mig-row") as HTMLElement;
    expect(skipped).toHaveTextContent("v1.0.2");

    expect(screen.getByText(/0 of 2 applied/)).toBeInTheDocument();
    expect(screen.queryByText(/applied · committed with the run/)).not.toBeInTheDocument();
    expect(screen.getByText("Deploy failed — nothing was applied")).toBeInTheDocument();
  });
});

describe("the number beside Requests on the rail", () => {
  const heard = jest.fn();
  beforeEach(() => {
    heard.mockClear();
    window.addEventListener(REQUESTS_CHANGED_EVENT, heard);
  });
  afterEach(() => window.removeEventListener(REQUESTS_CHANGED_EVENT, heard));

  it("is told when a decision is made here", async () => {
    setRoutes([
      { match: /\/api\/deploy\/approvals\/\d+$/, method: "POST", body: { approval: approval() } },
      {
        match: "/api/deploy/approvals",
        body: {
          approvals: [
            approval({ run_fingerprint: await runFingerprint(), status: "pending", decided_by: null, decided_at: null }),
          ],
        },
      },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await selectBothVersions(/Prod box/);
    const approve = await screen.findByRole("button", { name: "Approve this run" });
    expect(heard).not.toHaveBeenCalled();

    fireEvent.click(approve);
    await waitFor(() => expect(heard).toHaveBeenCalled());
  });

  it("is told when a run has finished here", async () => {
    setRoutes([
      {
        match: "/api/scripts/apply",
        method: "POST",
        body: { success: true, results: [{ script_name: "invoices", version: "1.0.1", status: "applied", statements: 1 }] },
      },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await pick("Connection", /Dev box/);
    await pick("Schema", "public");
    await pick("Script group", "invoices");
    fireEvent.click(await screen.findByRole("button", { name: "Check database" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run v1.0.1…" }, { timeout: 3000 }));
    const deploy = await screen.findByRole("button", { name: "Deploy v1.0.1" }, { timeout: 3000 });
    await waitFor(() => expect(deploy).toBeEnabled());
    expect(heard).not.toHaveBeenCalled();

    fireEvent.click(deploy);
    await screen.findByText(/^Deploy complete .* up to v1\.0\.1$/, undefined, { timeout: 3000 });
    await waitFor(() => expect(heard).toHaveBeenCalled());
    await flushAsync();
  });
});

describe("arriving from a link on the Requests page", () => {
  const box = (name: string) => screen.getByRole("combobox", { name });
  const reads = () => fetchCalls.filter((c) => c.url.includes("/api/scripts/preflight"));
  // Two schemas, because the page picks a lone schema by itself, and landing on
  // that one would prove nothing about the link.
  const twoSchemas: FetchRoute = {
    match: "/api/scripts/schemas",
    body: { schemas: ["archive", "public"] },
  };
  /** The version the run would end on, from the summary beside the run button. */
  const endsOn = () => document.querySelector(".dp-chip.dp-next");

  it("opens on the target the link names and reads it", async () => {
    setRoutes([twoSchemas, ...baseRoutes()]);
    setSearchParams("connection=2&schema=public&script=invoices");
    render(<DeployPage />);

    await waitFor(() => expect(box("Connection")).toHaveTextContent("Prod box"));
    await waitFor(() => expect(box("Schema")).toHaveTextContent("public"));
    await waitFor(() => expect(box("Script group")).toHaveTextContent("invoices"));
    await waitFor(() => expect(reads()).toHaveLength(1));
    expect(reads()[0].body).toContain("invoices");
  });

  it("picks the version the link names, not the latest", async () => {
    setRoutes(baseRoutes());
    setSearchParams("connection=1&schema=public&script=invoices&version=1.0.1");
    render(<DeployPage />);

    await waitFor(() => expect(endsOn()).toHaveTextContent("v1.0.1"));
  });

  it("takes the latest when the link names no version, as a rollback's link does not", async () => {
    setRoutes(baseRoutes());
    setSearchParams("connection=1&schema=public&script=invoices");
    render(<DeployPage />);

    await waitFor(() => expect(endsOn()).toHaveTextContent("v1.0.2"));
  });

  it("takes the latest when the version named is not waiting to run", async () => {
    setRoutes(baseRoutes());
    setSearchParams("connection=1&schema=public&script=invoices&version=9.9.9");
    render(<DeployPage />);

    await waitFor(() => expect(endsOn()).toHaveTextContent("v1.0.2"));
  });

  it("leaves a connection this organization doesn't have unpicked", async () => {
    setRoutes(baseRoutes());
    setSearchParams("connection=99&schema=public&script=invoices");
    render(<DeployPage />);

    await waitFor(() => expect(box("Connection")).toBeEnabled());
    await flushAsync();
    expect(box("Connection")).not.toHaveTextContent(/box/);
    expect(reads()).toHaveLength(0);
  });

  it("stops at the first thing it can't find, and reads nothing", async () => {
    setRoutes([twoSchemas, ...baseRoutes()]);
    setSearchParams("connection=1&schema=gone&script=invoices");
    render(<DeployPage />);

    await waitFor(() => expect(box("Connection")).toHaveTextContent("Dev box"));
    await flushAsync();
    expect(box("Schema")).not.toHaveTextContent(/gone|public|archive/);
    expect(reads()).toHaveLength(0);
  });

  it("forgets the rest of the link once the reader picks something by hand", async () => {
    setRoutes([twoSchemas, ...baseRoutes()]);
    setSearchParams("connection=1&schema=public&script=invoices");
    // Held, so the hand pick lands while the link is still being followed.
    const release = holdNext("/api/scripts/schemas");
    render(<DeployPage />);

    await waitFor(() => expect(box("Connection")).toHaveTextContent("Dev box"));
    await pick("Connection", /Prod box/);
    release();
    await flushAsync();

    expect(box("Connection")).toHaveTextContent("Prod box");
    expect(box("Schema")).not.toHaveTextContent("public");
    expect(reads()).toHaveLength(0);
  });
});

describe("picking another target while the first is still being read", () => {
  // Every answer this page shows belongs to one target. One still on its way
  // when the reader picks another target used to land anyway: it filled in
  // the new target's card with the old target's ledger, and its spinner kept
  // "Check database" disabled for a read nobody wanted any more.

  /** Prod is a version further on, so the two ledgers differ in what is left to run. */
  const prodPreflight = {
    ...preflight(),
    currentVersion: "1.0.1",
    timeline: [
      ...preflight().timeline,
      {
        version: "1.0.1",
        title: "invoices",
        change_type: "additive",
        applied_at: "2026-01-02T09:00:00.000Z",
      },
    ],
    message: "Target is at v1.0.1.",
  };
  const byConnection: FetchRoute = {
    match: "/api/scripts/preflight",
    method: "POST",
    body: (_url: string, init?: RequestInit) =>
      (JSON.parse(String(init?.body)) as { connectionId: number }).connectionId === 2
        ? prodPreflight
        : preflight(),
  };

  async function readTarget(connection: RegExp) {
    await pick("Connection", connection);
    await pick("Schema", "public");
    await pick("Script group", "invoices");
    const check = await screen.findByRole("button", { name: "Check database" });
    await waitFor(() => expect(check).toBeEnabled());
    fireEvent.click(check);
  }

  it("drops the old target's ledger when it lands", async () => {
    setRoutes(baseRoutes());
    render(<DeployPage />);

    const release = holdNext("/api/scripts/preflight", "POST");
    await readTarget(/Dev box/);
    await screen.findByRole("button", { name: "Checking…" });

    await pick("Connection", /Prod box/);
    // The spinner went with the read, so the new target can be read at once.
    expect(screen.queryByRole("button", { name: "Checking…" })).not.toBeInTheDocument();

    release();
    await flushAsync();
    expect(screen.queryByText("reachable")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Run all/ })).not.toBeInTheDocument();
  });

  it("keeps the new target's ledger when the old one lands after it", async () => {
    setRoutes([byConnection, ...baseRoutes()]);
    render(<DeployPage />);

    const releaseDev = holdNext("/api/scripts/preflight", "POST");
    await readTarget(/Dev box/);
    await screen.findByRole("button", { name: "Checking…" });

    await readTarget(/Prod box/);
    // The version timeline's count: Prod has one version left, Dev two.
    await screen.findByText("1 pending", undefined, { timeout: 3000 });

    releaseDev();
    await flushAsync();
    expect(screen.getByText("1 pending")).toBeInTheDocument();
    expect(screen.queryByText("2 pending")).not.toBeInTheDocument();
  });

  it("drops the old target's drift report when it lands", async () => {
    setRoutes([
      // Only Dev is tracked, so only Dev has a drift report to give.
      {
        match: "/api/lineage/lookup",
        body: (url: string) =>
          url.includes("connectionId=1")
            ? { tracked: true, trackedSchemaId: 7 }
            : { tracked: false },
      },
      {
        match: "/api/lineage/drift",
        method: "POST",
        body: {
          status: "drifted",
          summary: "2 tables differ from the snapshot.",
          counts: null,
          expectedVersion: "1.0.0",
          checkedAt: "2026-01-03T09:00:00.000Z",
        },
      },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);

    const releaseDrift = holdNext("/api/lineage/drift", "POST");
    await readTarget(/Dev box/);
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url.includes("/api/lineage/drift"))).toBe(true)
    );

    await readTarget(/Prod box/);
    fireEvent.click(await screen.findByRole("button", { name: "Run all (2)…" }, { timeout: 3000 }));

    releaseDrift();
    await flushAsync();
    expect(screen.queryByText("The target has drifted")).not.toBeInTheDocument();
  });
});

describe("the timeline of what has run", () => {
  // Rows shaped as /api/scripts/attempts sends them, dated from the clock so
  // they always fall inside the default 30 days. Newest first, as the route
  // sends them.
  function attemptsRoute() {
    const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    const row = (id: number, age: number, over: Record<string, unknown>) => ({
      id,
      connection_id: 1,
      schema_name: "public",
      scripts: [{ script_name: "invoices", version: "1.0.0" }],
      outcome: "applied",
      dry_run: false,
      http_status: 200,
      detail: null,
      actor: "dana@example.com",
      created_at: daysAgo(age),
      ...over,
    });
    return {
      match: "/api/scripts/attempts",
      body: {
        attempts: [
          row(3, 2, { outcome: "refused", http_status: 403, detail: "Your role cannot run this." }),
          row(2, 12, {}),
          row(1, 60, { dry_run: true }),
        ],
      },
    };
  }

  it("marks each attempt in range, and shows the reason of the one picked", async () => {
    setRoutes([attemptsRoute(), ...baseRoutes()]);
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);

    // Two of the three rows are inside the last 30 days.
    const shipped = await screen.findByRole("button", { name: /^Shipped: invoices v1\.0\.0/ });
    const stopped = screen.getByRole("button", { name: /^Stopped: invoices v1\.0\.0/ });
    expect(screen.queryByRole("button", { name: /^Rehearsed:/ })).not.toBeInTheDocument();
    expect(shipped).toHaveAttribute("aria-pressed", "false");

    // A refused run keeps the reason the server gave.
    fireEvent.click(stopped);
    expect(stopped).toHaveAttribute("aria-pressed", "true");
    const panel = document.querySelector(".dp-tl-d") as HTMLElement;
    expect(within(panel).getByText("Your role cannot run this.")).toBeInTheDocument();
    expect(within(panel).getByText(/Refused before anything ran/)).toBeInTheDocument();
    expect(within(panel).getByText(/by dana@example\.com/)).toBeInTheDocument();

    // A longer range brings the older rehearsal in.
    fireEvent.click(screen.getByRole("button", { name: "90 days" }));
    expect(screen.getByRole("button", { name: /^Rehearsed: invoices v1\.0\.0/ })).toBeInTheDocument();

    // The run picked on this page has its own marker, and it is not history.
    fireEvent.click(screen.getByRole("button", { name: /^This run, not started yet/ }));
    expect(within(panel).getByText(/Not started yet/)).toBeInTheDocument();

    // Every attempt is also in the list, whatever the range.
    expect(screen.getByText("Every attempt as a list (3)")).toBeInTheDocument();
  });

  it("says so when nothing has been run", async () => {
    setRoutes(baseRoutes());
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);

    expect(
      await screen.findByText("Nothing has been run on this schema from here yet.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Every attempt as a list/)).not.toBeInTheDocument();
  });
});
