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
 *  - An empty or unversioned target (lib/deploy/init's "needs-init" and
 *    "unversioned" stages). Every test here starts from a target that already
 *    has a version applied, so the initialise path is untested by this file.
 *  - The "Applies-to" restriction, which lib/deploy/application-targeting decides and
 *    tests/application-targeting.test.ts already covers.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);
jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import DeployPage from "@/app/[org]/(studio)/deploy/page";
import { sha256Hex } from "@/components/studio/ApprovalPanel";
import { REQUESTS_CHANGED_EVENT } from "@/lib/roles/access-requests";
import { fingerprintBody } from "@/lib/deploy/approval-fingerprint";
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

/** The Target picker's field once a connection is chosen: its name, then the schema. */
const targetField = () => screen.getByRole("group", { name: /^Target/ });

/** The panel the Target picker opens, opened first when it is shut. */
async function targetPanel(): Promise<HTMLElement> {
  const open = screen.queryByRole("dialog", { name: "Choose target connection and schema" });
  if (open) return open;
  const opener = await screen.findByRole("button", {
    name: /Choose a connection and schema|Change target connection and schema/,
  });
  await waitFor(() => expect(opener).toBeEnabled());
  fireEvent.click(opener);
  return screen.findByRole("dialog", { name: "Choose target connection and schema" });
}

/**
 * Choose a connection or a schema in the Target picker, or a script group in
 * its own list.
 */
async function pick(box: "Connection" | "Schema" | "Script group", option: string | RegExp) {
  if (box === "Script group") {
    const combobox = await screen.findByRole("combobox", { name: box });
    await waitFor(() => expect(combobox).toBeEnabled());
    fireEvent.click(combobox);
    fireEvent.click(await screen.findByRole("option", { name: option }, { timeout: 3000 }));
    return;
  }
  const panel = await targetPanel();
  // The panel shows one step at a time and opens on the schemas once a
  // connection is chosen, so a connection is picked after stepping back.
  const back = within(panel).queryByRole("button", { name: "Back to connections" });
  if (box === "Connection" && back) fireEvent.click(back);
  const list = within(panel).getByRole("group", { name: box === "Connection" ? "Connections" : "Schemas" });
  const name = typeof option === "string" ? new RegExp(`^${option}`) : option;
  fireEvent.click(await within(list).findByRole("button", { name }, { timeout: 3000 }));
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
          "approve it. A dry run runs the same SQL on the live database, so your role can't start one here either"
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
          "against it, not a deploy and not a dry run"
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
      screen.getByText("Checking the target for drift first. These unlock when the check finishes")
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
    expect(screen.getByText("Deploy failed, nothing was applied")).toBeInTheDocument();
  });

  it("stops the run that is going by its own id, and says nothing was applied", async () => {
    // The page makes the run's id and sends it with the run, so Stop can
    // name this run, and no other, while the run is still going.
    const stoppedMessage = "This deploy was stopped, as asked. Nothing was applied.";
    setRoutes([
      {
        match: "/api/scripts/apply",
        method: "POST",
        status: 503,
        body: {
          success: false,
          dryRun: false,
          code: "run_stopped",
          error: stoppedMessage,
          results: [
            {
              script_name: "invoices",
              version: "1.0.1",
              status: "failed",
              error: "Stopped before it finished.",
            },
          ],
        },
      },
      { match: "/api/scripts/cancel", method: "POST", body: { status: "stopping" } },
      ...baseRoutes(),
    ]);
    const release = holdNext("/api/scripts/apply", "POST");
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);
    const deploy = await deployButton();
    await waitFor(() => expect(deploy).toBeEnabled());
    fireEvent.click(deploy);

    fireEvent.click(await screen.findByRole("button", { name: "Stop" }, { timeout: 3000 }));
    expect(await screen.findByRole("button", { name: "Stopping…" })).toBeDisabled();
    await screen.findByText("Stopping the run…");

    const { runId } = lastApply();
    expect(runId).toEqual(expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
    const stops = fetchCalls.filter((call) => call.url.includes("/api/scripts/cancel"));
    expect(stops).toHaveLength(1);
    expect(stops[0].method).toBe("POST");
    expect(JSON.parse(stops[0].body ?? "null")).toEqual({ runId, connectionId: 1 });

    // The run's own answer then says how it ended, and the button goes.
    release();
    await screen.findByText(stoppedMessage, undefined, { timeout: 3000 });
    await screen.findByText("Deploy stopped, nothing was applied");
    expect(screen.queryByRole("button", { name: /^Stop/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/applied · committed with the run/)).not.toBeInTheDocument();
    await flushAsync();
  });

  it("says why when it is too late to stop, and lets the run finish", async () => {
    setRoutes([
      {
        match: "/api/scripts/apply",
        method: "POST",
        body: {
          success: true,
          results: [
            { script_name: "invoices", version: "1.0.1", status: "applied", statements: 1 },
            { script_name: "invoices", version: "1.0.2", status: "applied", statements: 1 },
          ],
        },
      },
      {
        match: "/api/scripts/cancel",
        method: "POST",
        status: 409,
        body: {
          ok: false,
          code: "too_late",
          error: "Too late to stop: the run is already saving its changes.",
        },
      },
      ...baseRoutes(),
    ]);
    const release = holdNext("/api/scripts/apply", "POST");
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);
    const deploy = await deployButton();
    await waitFor(() => expect(deploy).toBeEnabled());
    fireEvent.click(deploy);

    fireEvent.click(await screen.findByRole("button", { name: "Stop" }, { timeout: 3000 }));
    await screen.findByText("Too late to stop: the run is already saving its changes.");
    // The run is still going, so Stop is there to press again.
    expect(await screen.findByRole("button", { name: "Stop" })).toBeEnabled();

    release();
    await screen.findByText("Deploy complete · up to v1.0.2", undefined, { timeout: 3000 });
    expect(screen.queryByRole("button", { name: /^Stop/ })).not.toBeInTheDocument();
    await flushAsync();
  });

  it("shows what PostgreSQL warned under the version that warned", async () => {
    // A run can commit and still leave something undone, such as an owner
    // change the login may not make. The warning goes under its own row, and
    // the message at the end says there is something to read.
    const warned = 'The owner of table invoices was not changed: must be able to SET ROLE "postgres"';
    setRoutes([
      {
        match: "/api/scripts/apply",
        method: "POST",
        body: {
          success: true,
          results: [
            {
              script_name: "invoices",
              version: "1.0.1",
              status: "applied",
              statements: 1,
              warnings: [warned],
              moreWarnings: 2,
            },
            { script_name: "invoices", version: "1.0.2", status: "applied", statements: 1 },
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

    // A deploy moves on to Verify, so the warnings are under What was applied.
    await screen.findByText(
      "Deploy complete · up to v1.0.2 · 3 warnings from PostgreSQL, see What was applied",
      undefined,
      { timeout: 3000 }
    );
    const note = screen.getByText(`PostgreSQL warned: ${warned}`);
    expect(note).toHaveClass("dp-warn");
    const row = note.closest(".dp-applied") as HTMLElement;
    expect(row).toHaveTextContent("v1.0.1");
    expect(row).toHaveTextContent("PostgreSQL sent 2 more warnings for this version.");
    // Only the version that warned has a note from PostgreSQL.
    expect(screen.getAllByText(/^PostgreSQL warned:/)).toHaveLength(1);
    expect(screen.getByText(/in one transaction · 0 errors · 3 warnings$/)).toBeInTheDocument();
    // Back on the Run stage, the run row says the same.
    fireEvent.click(within(screen.getByRole("group", { name: "Deploy steps" })).getByRole("button", { name: /Run/ }));
    const runRow = (await screen.findByText(`PostgreSQL warned: ${warned}`)).closest(".dp-mig-row") as HTMLElement;
    expect(runRow).toHaveTextContent("v1.0.1");
    await flushAsync();
  });

  it("shows the warnings a dry run raised, before anything is applied", async () => {
    const warned = 'The owner of table invoices was not changed: must be able to SET ROLE "postgres"';
    setRoutes([
      {
        match: "/api/scripts/apply",
        method: "POST",
        body: {
          success: true,
          dryRun: true,
          results: [
            { script_name: "invoices", version: "1.0.1", status: "rehearsed", statements: 1 },
            { script_name: "invoices", version: "1.0.2", status: "rehearsed", statements: 1, warnings: [warned] },
          ],
        },
      },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);
    const dryRun = await dryRunButton();
    await waitFor(() => expect(dryRun).toBeEnabled());
    fireEvent.click(dryRun);

    await screen.findByText(
      "Dry run clean · 2 migrations rehearsed · 1 warning from PostgreSQL, see the rows",
      undefined,
      { timeout: 3000 }
    );
    const row = screen.getByText(`PostgreSQL warned: ${warned}`).closest(".dp-mig-row") as HTMLElement;
    expect(row).toHaveTextContent("v1.0.2");
    // The rehearsal card says a real deploy would warn the same way.
    expect(
      screen.getByText(
        "PostgreSQL sent 1 warning during the rehearsal, shown under its version above. " +
          "Deploy runs the same SQL, so expect it again."
      )
    ).toBeInTheDocument();
    expect(lastApply()).toMatchObject({ dryRun: true });
    await flushAsync();
  });

  it("warns when a rollback failed in the dry run, and still offers the real deploy", async () => {
    setRoutes([
      {
        match: "/api/scripts/apply",
        method: "POST",
        body: {
          success: true,
          dryRun: true,
          results: [
            { script_name: "invoices", version: "1.0.1", status: "rehearsed", statements: 1, rollbackCheck: "not_checked" },
            {
              script_name: "invoices",
              version: "1.0.2",
              status: "rehearsed",
              statements: 1,
              rollbackCheck: "failed",
              rollbackError: 'column "note" does not exist',
            },
          ],
        },
      },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);
    const dryRun = await dryRunButton();
    await waitFor(() => expect(dryRun).toBeEnabled());
    fireEvent.click(dryRun);

    const said =
      'The rollback of v1.0.2 failed in the rehearsal: column "note" does not exist. Fix it in Script Editor ' +
      "before the real run. The real run saves the rollback, and it can't be changed afterwards.";
    const notes = await screen.findAllByText(said, undefined, { timeout: 3000 });
    expect(notes.length).toBeGreaterThan(0);
    // A warning only: the real deploy stays open.
    expect(screen.getByRole("button", { name: /^Deploy for real/ })).toBeEnabled();
    await flushAsync();
  });

  it("says a dry run that hit its own limit is not a fault in the script", async () => {
    setRoutes([
      {
        match: "/api/scripts/apply",
        method: "POST",
        status: 422,
        body: {
          success: false,
          dryRunLimitation: true,
          error: "A dry run can't rehearse a new enum value that the same run then uses.",
          results: [
            { script_name: "invoices", version: "1.0.1", status: "failed", error: "unsafe use of new value" },
            { script_name: "invoices", version: "1.0.2", status: "skipped" },
          ],
        },
      },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);
    const dryRun = await dryRunButton();
    await waitFor(() => expect(dryRun).toBeEnabled());
    fireEvent.click(dryRun);

    const titles = await screen.findAllByText(/^A dry run can't rehearse this run\./, undefined, { timeout: 3000 });
    expect(titles.length).toBeGreaterThan(0);
    expect(screen.getAllByText("not rehearsed").length).toBeGreaterThan(0);
    expect(screen.queryByText("unsafe use of new value")).not.toBeInTheDocument();
    await flushAsync();
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

    await waitFor(() => expect(targetField()).toHaveTextContent("Prod box"));
    await waitFor(() => expect(targetField()).toHaveTextContent("public"));
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

    // Nothing chosen, so the whole field is still the button that opens the picker.
    const unpicked = () => screen.getByRole("button", { name: /Choose a connection and schema/ });
    await waitFor(() => expect(unpicked()).toBeEnabled());
    await flushAsync();
    expect(unpicked()).toBeInTheDocument();
    expect(reads()).toHaveLength(0);
  });

  it("stops at the first thing it can't find, and reads nothing", async () => {
    setRoutes([twoSchemas, ...baseRoutes()]);
    setSearchParams("connection=1&schema=gone&script=invoices");
    render(<DeployPage />);

    await waitFor(() => expect(targetField()).toHaveTextContent("Dev box"));
    await flushAsync();
    expect(targetField()).toHaveTextContent("No schema chosen");
    expect(targetField()).not.toHaveTextContent(/gone|public|archive/);
    expect(reads()).toHaveLength(0);
  });

  it("forgets the rest of the link once the reader picks something by hand", async () => {
    setRoutes([twoSchemas, ...baseRoutes()]);
    setSearchParams("connection=1&schema=public&script=invoices");
    // Held, so the hand pick lands while the link is still being followed.
    const release = holdNext("/api/scripts/schemas");
    render(<DeployPage />);

    await waitFor(() => expect(targetField()).toHaveTextContent("Dev box"));
    await pick("Connection", /Prod box/);
    release();
    await flushAsync();

    expect(targetField()).toHaveTextContent("Prod box");
    expect(targetField()).not.toHaveTextContent("public");
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

describe("a Deploy that is not set up yet", () => {
  /** The pull's answer when the organization has no GitHub repository saved. */
  const noGitHub: FetchRoute = {
    match: "/api/github/pull",
    status: 500,
    body: {
      ok: false,
      code: "github_unconfigured",
      error: "GitHub is not set up for this organization yet. Nothing was read from or written to GitHub.",
    },
  };
  const checklist = () => screen.findByRole("region", { name: "Deploy needs a few things first" });

  it("shows an Admin the checklist, with a button to set up GitHub", async () => {
    setUser("admin");
    setRoutes([noGitHub, ...baseRoutes()]);
    render(<DeployPage />);

    const list = await checklist();
    expect(list).toHaveTextContent("1 of 3 done");
    expect(list).toHaveTextContent("GitHub is not set up for this organization yet.");
    expect(within(list).getByRole("link", { name: "Set up GitHub" })).toHaveAttribute(
      "href",
      expect.stringContaining("/admin?tab=github")
    );
    // The steps it opens up are shown, and the controls that can't be used are not.
    expect(list).toHaveTextContent("Unlocks after setup");
    expect(screen.queryByRole("button", { name: "Check database" })).not.toBeInTheDocument();
    // The pull's refusal is a step on the list, not an error banner.
    expect(screen.queryByText(/Nothing was read from or written to GitHub/)).not.toBeInTheDocument();
  });

  it("tells an Editor that an Admin sets up GitHub, and where to ask", async () => {
    setUser("editor");
    setRoutes([noGitHub, ...baseRoutes()]);
    render(<DeployPage />);

    const list = await checklist();
    expect(list).toHaveTextContent("Deploys need GitHub, which an Admin sets up.");
    expect(within(list).getByRole("link", { name: "Ask an Admin" })).toHaveAttribute(
      "href",
      expect.stringContaining("/requests")
    );
    expect(within(list).queryByRole("link", { name: "Set up GitHub" })).not.toBeInTheDocument();
  });

  it("gives a Viewer one plain line and no checklist", async () => {
    setUser("viewer");
    setRoutes([noGitHub, ...baseRoutes()]);
    render(<DeployPage />);

    expect(
      await screen.findByText(/Viewers can't start deploys, so there is nothing to set up here\./)
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Deploy needs a few things first" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Ask an Admin" })).not.toBeInTheDocument();
    // What has run before is still theirs to read, for the target they pick.
    expect(screen.getByRole("heading", { name: "Run history" })).toBeInTheDocument();
  });

  it("asks for a saved migration when GitHub is set up but holds none", async () => {
    setUser("admin");
    setRoutes([
      { match: "/api/github/pull", body: { ok: true, scripts: [], warnings: [] } },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);

    const list = await checklist();
    expect(list).toHaveTextContent("2 of 3 done");
    expect(within(list).getByRole("link", { name: "Open Script Editor" })).toBeInTheDocument();
  });
});

describe("retiring a version that should never run", () => {
  // A run stops at the first version that fails, and every version after it
  // waits behind it. Retiring the failed one in GitHub (a .retired.md note
  // beside it) is the way past: Deploy stops offering it, and the next one
  // can run. Only a role with scripts:delete (Admin, out of the box) may.

  const FAILED_APPLY: FetchRoute = {
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
  };

  const RETIRED_NOTE = /^Retired: v1\.0\.1 was retired in GitHub, so Deploy no longer offers it/;

  /** The registry, with v1.0.1 retired once the page has asked for that. */
  function pullAfterRetire(): FetchRoute {
    return {
      match: "/api/github/pull",
      body: () => ({
        ok: true,
        scripts: fetchCalls.some((call) => call.url.includes("/api/github/retire"))
          ? [{ ...SCRIPTS[0], retired: true }, SCRIPTS[1]]
          : SCRIPTS,
        warnings: [],
      }),
    };
  }

  async function runAndFail() {
    const deploy = await deployButton();
    await waitFor(() => expect(deploy).toBeEnabled());
    fireEvent.click(deploy);
    await screen.findByText("failed · the whole run was rolled back", undefined, { timeout: 3000 });
  }

  const retireCalls = () => fetchCalls.filter((call) => call.url.includes("/api/github/retire"));

  it("lets an Admin retire the version a run failed on, and then offers the one after it", async () => {
    setRoutes([
      FAILED_APPLY,
      {
        match: "/api/github/retire",
        method: "POST",
        body: {
          ok: true,
          already: false,
          version: "1.0.1",
          path: "shop/public/invoices/v1.0.1.retired.md",
          url: null,
        },
      },
      pullAfterRetire(),
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);
    await runAndFail();

    expect(
      screen.getByText(
        "If invoices v1.0.1 should never run, you can retire it. Deploy then stops offering it, " +
          "and the versions after it can run."
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retire v1.0.1…" }));

    const dialog = await screen.findByRole("dialog", { name: "Retire invoices v1.0.1?" });
    expect(within(dialog).getByText("v1.0.1.retired.md")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Reason (optional)"), {
      target: { value: "  Needs a table this database does not have  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Retire v1.0.1" }));

    // Back on Pre-flight with the registry read again: v1.0.1 is named as
    // retired, and v1.0.2 is offered on its own.
    expect(await screen.findByText("Retired v1.0.1. Deploy no longer offers it.", undefined, { timeout: 3000 })).toBeInTheDocument();
    expect((await screen.findAllByText(RETIRED_NOTE, undefined, { timeout: 3000 })).length).toBeGreaterThan(0);
    expect(await screen.findByRole("button", { name: "Run v1.0.2…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run v1.0.1…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run all (2)…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Retire invoices v1.0.1?" })).not.toBeInTheDocument();

    const calls = retireCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body ?? "null")).toEqual({
      database_name: "shop",
      schema_name: "public",
      script_name: "invoices",
      version: "1.0.1",
      reason: "Needs a table this database does not have",
    });
    await flushAsync();
  });

  it("tells a role that may not retire who can, and offers no button", async () => {
    setUser("editor");
    setRoutes([FAILED_APPLY, ...baseRoutes()]);
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);
    await runAndFail();

    expect(
      screen.getByText(
        "If invoices v1.0.1 should never run, an Admin can retire it. Deploy then stops offering it, " +
          "and the versions after it can run."
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Retire/ })).not.toBeInTheDocument();

    // Nor on the pending list.
    fireEvent.click(screen.getByRole("button", { name: "Back to Pre-flight" }));
    expect(await screen.findByRole("button", { name: "Run v1.0.1…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Retire/ })).not.toBeInTheDocument();
    expect(retireCalls()).toHaveLength(0);
    await flushAsync();
  });

  it("skips a version that is retired already, names it, and marks it in the timeline", async () => {
    setRoutes([
      {
        match: "/api/github/pull",
        body: { ok: true, scripts: [{ ...SCRIPTS[0], retired: true }, SCRIPTS[1]], warnings: [] },
      },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await pick("Connection", /Dev box/);
    await pick("Schema", "public");
    await pick("Script group", "invoices");
    const check = await screen.findByRole("button", { name: "Check database" });
    await waitFor(() => expect(check).toBeEnabled());
    fireEvent.click(check);

    expect(await screen.findByRole("button", { name: "Run v1.0.2…" }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run v1.0.1…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Run all/ })).not.toBeInTheDocument();
    expect(screen.getAllByText(RETIRED_NOTE).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Retired").length).toBeGreaterThan(0);
    await flushAsync();
  });

  it("asks first from the pending list, and Cancel sends nothing", async () => {
    setRoutes(baseRoutes());
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);

    // One per pending row, for that row's version.
    const buttons = await screen.findAllByRole("button", { name: "Retire…" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    const dialog = await screen.findByRole("dialog", { name: "Retire invoices v1.0.2?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Retire invoices v1.0.2?" })).not.toBeInTheDocument()
    );
    expect(retireCalls()).toHaveLength(0);
    await flushAsync();
  });

  it("keeps the dialog open with the reason it failed, and reads nothing again", async () => {
    const refused =
      'GitHub refused to save the note that retires v1.0.1 of "invoices" (status 422). Nothing was changed in GitHub.';
    setRoutes([
      { match: "/api/github/retire", method: "POST", status: 502, body: { ok: false, code: "github_error", error: refused } },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);
    const pullsBefore = fetchCalls.filter((call) => call.url.includes("/api/github/pull")).length;

    fireEvent.click((await screen.findAllByRole("button", { name: "Retire…" }))[0]);
    const dialog = await screen.findByRole("dialog", { name: "Retire invoices v1.0.1?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Retire v1.0.1" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(refused);
    expect(screen.getByRole("dialog", { name: "Retire invoices v1.0.1?" })).toBeInTheDocument();
    // No reason typed, so none is sent.
    expect(JSON.parse(retireCalls()[0].body ?? "null")).not.toHaveProperty("reason");
    expect(fetchCalls.filter((call) => call.url.includes("/api/github/pull"))).toHaveLength(pullsBefore);
    // Still offered, since nothing changed.
    expect(screen.getByRole("button", { name: "Run all (2)…" })).toBeInTheDocument();
    await flushAsync();
  });

  it("says when it cannot tell whether the version was retired", async () => {
    setRoutes([{ match: "/api/github/retire", method: "POST", networkError: true }, ...baseRoutes()]);
    render(<DeployPage />);
    await selectBothVersions(/Dev box/);

    fireEvent.click((await screen.findAllByRole("button", { name: "Retire…" }))[0]);
    const dialog = await screen.findByRole("dialog", { name: "Retire invoices v1.0.1?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Retire v1.0.1" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The connection dropped, so it is not known whether v1.0.1 was retired. Try again: if it was, you will be told so."
    );
    await flushAsync();
  });
});
