/** @jest-environment jsdom */

/**
 * The Deploy screen, on the stops in front of the only button in this app that
 * runs SQL against somebody's real database.
 *
 * Everything else here can be read again or thrown away. A deploy cannot: it
 * commits on a live target, and this page's own words are what the reader
 * trusts when deciding to press it. So the tests below are about refusals —
 * who may run at all, which boxes have to be ticked first, and whether an
 * approval covers the SQL actually selected — and then about the two moments
 * where a wrong screen becomes a wrong database: what the run sends, and what
 * it says afterwards about what happened.
 *
 * What is NOT here:
 *  - The "Roll back to" panel and the revert route. A rollback is a second run
 *    with its own preview, its own ticks and its own approval; reaching it
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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import DeployPage from "@/app/(studio)/deploy/page";
import { sha256Hex } from "@/components/studio/ApprovalPanel";
import { fingerprintBody } from "@/lib/approval-fingerprint";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  resetPageState,
  setRoutes,
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
    environment: "dev",
  },
  {
    id: 2,
    name: "Prod box",
    host: "prod.internal",
    port: 5432,
    database_name: "shop",
    type: "PostgreSQL",
    environment: "prod",
  },
  {
    id: 3,
    name: "Admins only",
    host: "locked.internal",
    port: 5432,
    database_name: "shop",
    type: "PostgreSQL",
    environment: "dev",
    execute_role: "admin",
  },
  {
    id: 4,
    name: "Reference copy",
    host: "reference.internal",
    port: 5432,
    database_name: "shop",
    type: "PostgreSQL",
    environment: "dev",
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

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("who is allowed to run anything here", () => {
  it("refuses a connection whose role outranks the viewer, and names both roles", async () => {
    // A 403 from the apply route says "forbidden" about a request the reader
    // already believed was fine. The button greys itself out for the stated
    // reason instead — and the reason has to name both halves, because either
    // one can be the thing that changes.
    setUser("editor");
    setRoutes(baseRoutes());
    render(<DeployPage />);
    await selectBothVersions(/Admins only/);

    expect(await deployButton()).toBeDisabled();
    expect(await dryRunButton()).toBeDisabled();
    expect(
      screen.getByText('Running migrations on this connection needs the "admin" role and yours is "editor"')
    ).toBeInTheDocument();
  });

  it("runs nothing at all against a read-only connection, rehearsals included", async () => {
    // Read-only is a fact about the database, not a rank to be outranked, so
    // an admin is refused here as well — and the sentence must not say "your
    // role is too low", because raising it changes nothing.
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
    expect(screen.queryByText(/needs the "none" role/)).not.toBeInTheDocument();
  });
});

describe("the boxes in front of a run", () => {
  it("holds both buttons while the drift check is still out", async () => {
    // The check's result replaces the record the apply route holds a run to,
    // so between asking and answering this page cannot yet show the tick that
    // record may turn out to demand. A run started in that window would come
    // back refused over a warning the reader was never shown.
    setRoutes([
      { match: "/api/lineage/lookup", body: { tracked: true, trackedSchemaId: 7, environment: "dev" } },
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

  it("asks for a tick when the target has drifted, and tells the server it got one", async () => {
    // Drift means the target is not the database these migrations were written
    // against, so a statement may hit an object that is not the one it expects.
    // That is a reason to stop and read, not a reason to forbid the run — so it
    // is a tick. The tick then has to reach the server, because the route reads
    // the same risk from the same SQL and refuses a run nobody acknowledged.
    setRoutes([
      { match: "/api/lineage/lookup", body: { tracked: true, trackedSchemaId: 7, environment: "dev" } },
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

    expect(await deployButton()).toBeDisabled();
    expect(screen.getByText("Tick every box above to enable this")).toBeInTheDocument();
    expect(screen.getByText("The target has drifted")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "I have read the drift and mean to run anyway." })
    );
    const deploy = await deployButton();
    await waitFor(() => expect(deploy).toBeEnabled());
    fireEvent.click(deploy);

    await screen.findByText("Deploy complete \u00b7 up to v1.0.2", undefined, { timeout: 3000 });
    expect(lastApply()).toMatchObject({ acknowledgeDrift: true, acknowledgeProduction: false });
    // The run re-reads the ledger and re-checks drift on its way out; let those
    // land inside act rather than after the test has finished with the page.
    await flushAsync();
  });

  it("holds the rehearsal too until production is confirmed, then frees only the rehearsal", async () => {
    // Two separate rules land on the same screen and it is worth pinning down
    // which is which: the production tick covers a rehearsal as well, because
    // a rehearsal really executes the SQL and can take the same heavy lock —
    // while the approval covers only the run that commits.
    setRoutes(baseRoutes());
    render(<DeployPage />);
    await selectBothVersions(/Prod box/);

    expect(await dryRunButton()).toBeDisabled();
    expect(screen.getByText("Tick every box above to enable this")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I understand, and I mean to run 2 migrations against production.",
      })
    );

    const dryRun = await dryRunButton();
    await waitFor(() => expect(dryRun).toBeEnabled());
    expect(await deployButton(" to production")).toBeDisabled();
    expect(
      screen.getByText("Deploy on production needs an approval — a dry run does not")
    ).toBeInTheDocument();
  });
});

describe("the two-person rule", () => {
  it("does not count an approval recorded for different SQL, and says why", async () => {
    // The failure this exists for is a conversation: the panel says "Needs a
    // second person" while the approver insists they approved it. Both are
    // true — the approval is on the list, and it covers SQL that has since
    // changed — so the panel has to name it rather than stay silent.
    setRoutes([
      { match: "/api/deploy/approvals", body: { approvals: [approval()] } },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await selectBothVersions(/Prod box/);

    const panel = (await screen.findByText("Needs a second person")).closest(".appr") as HTMLElement;
    expect(panel).toHaveTextContent("Approved for a different selection: through v1.0.2");
    expect(panel).toHaveTextContent(/has changed since it was approved/);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I understand, and I mean to run 2 migrations against production.",
      })
    );
    const dryRun = await dryRunButton();
    await waitFor(() => expect(dryRun).toBeEnabled());
    expect(await deployButton(" to production")).toBeDisabled();
  });

  it("clears the deploy when the approval covers exactly the SQL on screen", async () => {
    // Hashed here the way the server hashes it, from the same module the page
    // uses, so this passes only if the page really compared the two rather
    // than settling for "an approval exists for this target".
    setRoutes([
      {
        match: "/api/deploy/approvals",
        body: { approvals: [approval({ run_fingerprint: await runFingerprint() })] },
      },
      ...baseRoutes(),
    ]);
    render(<DeployPage />);
    await selectBothVersions(/Prod box/);

    expect(await screen.findByText("Approved by a second person")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I understand, and I mean to run 2 migrations against production.",
      })
    );
    const deploy = await deployButton(" to production");
    await waitFor(() => expect(deploy).toBeEnabled());
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
      acknowledgeProduction: false,
      acknowledgeBreaking: false,
      acknowledgeDataLoss: false,
      acknowledgeDrift: false,
    });
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
    ).closest(".mig-row") as HTMLElement;
    expect(failed).toHaveTextContent("v1.0.1");

    const skipped = screen
      .getByText("skipped · the run rolled back before this one could commit")
      .closest(".mig-row") as HTMLElement;
    expect(skipped).toHaveTextContent("v1.0.2");

    expect(screen.getByText(/0 of 2 applied/)).toBeInTheDocument();
    expect(screen.queryByText(/applied · committed with the run/)).not.toBeInTheDocument();
    expect(screen.getByText("Deploy failed — nothing was applied")).toBeInTheDocument();
  });
});
