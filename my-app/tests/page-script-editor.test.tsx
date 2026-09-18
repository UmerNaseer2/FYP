/** @jest-environment jsdom */

/**
 * The Script Editor, on the two things it is trusted to get right: the number
 * the next version gets, and what Save is allowed to publish.
 *
 * The number is worked out from two reads that can disagree, arrive late or
 * fail — the versions GitHub already holds, and the version applied to the
 * target — and a number that lands at or below either of them is not a
 * cosmetic slip. Deploy orders work by version, so a version saved under the
 * floor is applied out of order or never applied at all. The refusals are the
 * other half: a version with no rollback cannot be undone from Deploy, and a
 * script that opens or closes its own transaction is rejected at apply time,
 * long after the person who wrote it has stopped watching.
 *
 * What is NOT here:
 *  - The two ways a rollback is added to a version that is already saved (the
 *    offer below Save, and the "Add a missing rollback" card). Both send the
 *    push route's attach request and report what it answers; the rules about
 *    when a rollback may be added at all belong to that route. They are not
 *    covered by any test in this file.
 *  - How the SQL is graded. gradeSql (lib/change-type) has its own suite, and
 *    the fixtures below use it only to reach a known suggestion.
 *  - The draft banner handed over from Performance, which is its own
 *    component: tests/component-migration-draft-banner.test.tsx. What this
 *    page contributes is loadDraft, which turns an accepted offer into the
 *    editor's own state — it has no test of its own, and planDraftLoad,
 *    which decides what it sets, is in tests/migration-draft.test.ts.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import ScriptEditorPage from "@/app/(studio)/script-editor/page";
import { fetchCalls, flushAsync, holdNext, resetPageState, setRoutes } from "./helpers/render-page";

const CONNECTIONS = [{ id: 1, name: "Orders DB", host: "db.internal", database_name: "shop" }];

/** SQL that grades additive, so the suggested bump is minor. */
const ADDS_A_COLUMN = "ALTER TABLE invoices\n  ADD COLUMN due_date date;";
/** Its rollback, which has statements and so satisfies the rollback rule. */
const DROPS_THE_COLUMN = "ALTER TABLE invoices\n  DROP COLUMN due_date;";

/** One saved version, as GET /api/github/pull lists it. */
function savedScript(over: Record<string, unknown> = {}) {
  return {
    database_name: "shop",
    schema_name: "public",
    script_name: "add_invoices",
    version: "1.0.0",
    path: "shop/public/add_invoices/v1.0.0.sql",
    sql_content: ADDS_A_COLUMN,
    rollback_state: "usable",
    ...over,
  };
}

/**
 * Answers for a working server with an empty registry.
 *
 * Every route this page touches is here, because an unmatched request throws:
 * a page that quietly renders "no versions" because a URL was misspelled in a
 * fixture is exactly the test that passes while proving nothing. Tests that
 * need a different answer put their own route FIRST — the first match wins.
 */
function baseRoutes() {
  return [
    { match: "/api/connections", body: CONNECTIONS },
    { match: "/api/github/pull", body: { ok: true, scripts: [], warnings: [] } },
    { match: "/api/scripts/schemas", body: { schemas: ["public", "shop_dev"] } },
    { match: "/api/github/family", body: { ok: true, versions: [] } },
    { match: "/api/scripts/preflight", method: "POST", body: { currentVersion: null } },
  ];
}

/**
 * Pick the connection, the schema and a family name — the three settings the
 * version reads are keyed on. Nothing is asked of GitHub until all three are
 * set, so every test that is about a version starts here.
 */
async function pickTarget(family: string, useExisting = false) {
  fireEvent.click(screen.getByRole("combobox", { name: "Connection" }));
  fireEvent.click(await screen.findByRole("option", { name: /Orders DB/ }));

  const schemaBox = screen.getByRole("combobox", { name: "Schema" });
  await waitFor(() => expect(schemaBox).toBeEnabled());
  fireEvent.click(schemaBox);
  fireEvent.click(screen.getByRole("option", { name: "public" }));

  if (useExisting) {
    fireEvent.click(screen.getByRole("combobox", { name: "Script family" }));
    fireEvent.click(screen.getByRole("option", { name: family }));
    return;
  }
  fireEvent.click(screen.getByRole("button", { name: "+ New family" }));
  fireEvent.change(screen.getByLabelText("New script family name"), {
    target: { value: family },
  });
}

/** Type into one of the two SQL boxes. */
function writeSql(box: "SQL" | RegExp, text: string) {
  fireEvent.change(screen.getByLabelText(box), { target: { value: text } });
}

/**
 * The Save button, once the version is worked out.
 *
 * Both reads are debounced by 400ms and then have to come back, so this waits
 * rather than reading: before they land the button says "Save to GitHub" with
 * no number, which is the page refusing to guess.
 */
function saveButton(version?: string) {
  const name = version === undefined ? "Save to GitHub" : `Save v${version} to GitHub`;
  return screen.findByRole("button", { name }, { timeout: 3000 });
}

/**
 * The one reason Save is refusing, read off the button itself.
 *
 * Most of these sentences are also printed beside the box they are about, so
 * a text query matches twice and says nothing about which one stopped the
 * save. The button's title holds exactly the reason it is disabled for — and
 * the order those reasons are picked in is the part worth pinning down: a
 * screen that names the second problem while the first is still there sends
 * somebody to fix the wrong thing.
 */
async function refusal(version: string) {
  const button = await saveButton(version);
  expect(button).toBeDisabled();
  return button.getAttribute("title");
}

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("when the editor cannot do its job", () => {
  it("does not call an unreadable connection list an empty one", async () => {
    // The route answered, but not with a list. Telling the reader to add their
    // first connection would be advice about a database they may well already
    // have saved, and following it makes a duplicate.
    setRoutes([{ match: "/api/connections", body: { error: "The connection store is down." } }, ...baseRoutes()]);
    render(<ScriptEditorPage />);

    expect(await screen.findByText("Could not load your connections")).toBeInTheDocument();
    expect(screen.queryByText("Add a connection first")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Go to Connections/ })).not.toBeInTheDocument();
  });

  it("sends somebody with no connections to the page that makes one", async () => {
    setRoutes([{ match: "/api/connections", body: [] }, ...baseRoutes()]);
    render(<ScriptEditorPage />);

    expect(await screen.findByText("Add a connection first")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to Connections/ })).toHaveAttribute(
      "href",
      "/connections"
    );
  });

  it("says a registry that is not set up cannot be saved to either", async () => {
    // Read from the pull's CODE, not the wording of its message: without the
    // three settings the save would fail the same way the listing did, so the
    // editor stops here instead of letting somebody write a script, press
    // Save and be told then.
    setRoutes([
      {
        match: "/api/github/pull",
        status: 500,
        body: { error: "GitHub is not configured.", code: "github_unconfigured" },
      },
      ...baseRoutes(),
    ]);
    render(<ScriptEditorPage />);
    await pickTarget("add_invoices");
    writeSql("SQL", ADDS_A_COLUMN);

    expect(await screen.findByText(/Set GITHUB_REPO_OWNER/)).toBeInTheDocument();
    expect(
      screen.getByText(/The next version can't be worked out until the GitHub registry is configured/)
    ).toBeInTheDocument();
    const button = await saveButton();
    expect(button).toBeDisabled();
    expect(
      screen.getByText("The GitHub registry is not configured, so nothing can be saved.")
    ).toBeInTheDocument();
  });

  it("still offers a new family when the listing alone failed", async () => {
    // A pull that failed for any other reason took the family LIST with it,
    // but not the ability to save: the version is checked against GitHub
    // directly, by a different request. Blocking here would strand somebody
    // over a listing they do not need.
    setRoutes([
      { match: "/api/github/pull", status: 502, body: { error: "GitHub returned 502." } },
      ...baseRoutes(),
    ]);
    render(<ScriptEditorPage />);
    await pickTarget("add_invoices");
    writeSql("SQL", ADDS_A_COLUMN);
    writeSql(/Rollback SQL/, DROPS_THE_COLUMN);

    expect(await screen.findByText(/you can still add a new one/)).toBeInTheDocument();
    expect(await saveButton("1.0.0")).toBeEnabled();
  });

  it("names the parts of the registry it could not read", async () => {
    // A pull that mostly worked. The families it did read are listed, and the
    // rest is said out loud — a family missing from a list that claims to be
    // complete is how somebody ends up creating a second copy of one.
    const warnings = [1, 2, 3, 4, 5, 6].map((n) => `shop/public/family_${n}: unreadable`);
    setRoutes([
      { match: "/api/github/pull", body: { ok: true, scripts: [], warnings } },
      ...baseRoutes(),
    ]);
    render(<ScriptEditorPage />);

    expect(await screen.findByText("Some of the registry could not be read:")).toBeInTheDocument();
    expect(screen.getByText("shop/public/family_5: unreadable")).toBeInTheDocument();
    // Cut at five, and the cut is counted rather than dropped.
    expect(screen.queryByText("shop/public/family_6: unreadable")).not.toBeInTheDocument();
    expect(screen.getByText("…and 1 more.")).toBeInTheDocument();
  });
});

describe("the number the next version gets", () => {
  it("clears both the applied version and the highest one in GitHub", async () => {
    // The floor is the higher of the two, and here they disagree: GitHub's
    // newest is v1.2.0 but the target already has v2.0.0 applied, which can
    // happen when a version was pushed from another checkout. A next version
    // read off GitHub alone would be v1.2.1 — below what is already there.
    setRoutes([
      { match: "/api/github/family", body: { ok: true, versions: ["1.0.0", "1.2.0"] } },
      { match: "/api/scripts/preflight", method: "POST", body: { currentVersion: "2.0.0" } },
      {
        match: "/api/github/pull",
        body: { ok: true, scripts: [savedScript(), savedScript({ version: "1.2.0" })], warnings: [] },
      },
      ...baseRoutes(),
    ]);
    render(<ScriptEditorPage />);
    await pickTarget("add_invoices", true);
    writeSql("SQL", ADDS_A_COLUMN);

    expect(
      await screen.findByText(/Applied to Orders DB: v2\.0\.0/, undefined, { timeout: 3000 })
    ).toHaveTextContent("In GitHub: v1.2.0");
    // The suggestion follows the SQL, which adds a column: a minor bump.
    expect(await saveButton("2.1.0")).toBeInTheDocument();
    // And every button offers a number above the floor, not above GitHub.
    fireEvent.click(screen.getByRole("button", { name: /^patch/ }));
    expect(await saveButton("2.0.1")).toBeInTheDocument();
  });

  it("says so when only GitHub could be checked", async () => {
    // The target could not be read. GitHub still can be, so a number is still
    // offered — but it is only above what GitHub holds, and the pill says as
    // much rather than letting it pass for the whole answer.
    setRoutes([
      { match: "/api/github/family", body: { ok: true, versions: ["1.2.0"] } },
      { match: "/api/scripts/preflight", method: "POST", status: 500, body: { error: "unreachable" } },
      ...baseRoutes(),
    ]);
    render(<ScriptEditorPage />);
    await pickTarget("add_invoices");
    writeSql("SQL", ADDS_A_COLUMN);

    expect(
      await screen.findByText(/couldn't read the applied version/, undefined, { timeout: 3000 })
    ).toBeInTheDocument();
    expect(screen.getByText(/Applied to Orders DB: unknown/)).toBeInTheDocument();
    expect(await saveButton("1.3.0")).toBeInTheDocument();
  });

  it("calls a family with nothing saved a first version", async () => {
    setRoutes(baseRoutes());
    render(<ScriptEditorPage />);
    await pickTarget("add_invoices");
    writeSql("SQL", ADDS_A_COLUMN);

    expect(
      await screen.findByText("First version of this family", undefined, { timeout: 3000 })
    ).toBeInTheDocument();
    // 1.0.0 at every level, so the level recorded with the file is the only
    // thing that can carry how big the change is.
    expect(await saveButton("1.0.0")).toBeInTheDocument();
  });

  it("stops showing one family's versions the moment the name changes", async () => {
    // The answer for the family asked about last stays in state until the new
    // one lands, and between those two moments sits a 400ms debounce plus a
    // round trip to GitHub. Read without checking which family it answered
    // for, it fills that window with another family's highest version — and
    // the number offered is one above THAT, which is not a new version of the
    // family being written at all.
    setRoutes([
      {
        match: "/api/github/family",
        body: (url: string) =>
          url.includes("script=slow_family")
            ? { ok: true, versions: ["3.0.0"] }
            : { ok: true, versions: ["1.0.0"] },
      },
      ...baseRoutes(),
    ]);
    render(<ScriptEditorPage />);
    await pickTarget("slow_family");
    writeSql("SQL", ADDS_A_COLUMN);
    expect(
      await screen.findByText(/In GitHub: v3\.0\.0/, undefined, { timeout: 3000 })
    ).toBeInTheDocument();

    // Hold the next family's read, so the window under test stays open for
    // the length of the assertions rather than closing on its own.
    const releaseQuick = holdNext("script=quick_family");
    fireEvent.change(screen.getByLabelText("New script family name"), {
      target: { value: "quick_family" },
    });

    // Gone on the same commit as the name change, not once the read answers.
    expect(screen.queryByText(/In GitHub: v3\.0\.0/)).not.toBeInTheDocument();
    expect(screen.getByText("Checking versions…")).toBeInTheDocument();
    const waiting = await saveButton();
    expect(waiting).toBeDisabled();
    expect(waiting).toHaveAttribute(
      "title",
      "Checking GitHub for the versions of quick_family…"
    );

    releaseQuick();
    await flushAsync();
    expect(
      await screen.findByText(/In GitHub: v1\.0\.0/, undefined, { timeout: 3000 })
    ).toBeInTheDocument();
  });

  it("stops using the applied version read for the family that was open before", async () => {
    // The two reads race each other, and GitHub's usually wins: it is one GET
    // against a registry where the other is a connection to the target
    // database. So the family read can land for the new family while the
    // applied read is still out — and an applied version accepted without
    // checking which family it was read for puts the FIRST version of a
    // brand-new family above whatever the previous family had reached.
    setRoutes([
      {
        match: "/api/scripts/preflight",
        method: "POST",
        body: (_url: string, init?: RequestInit) =>
          String(init?.body ?? "").includes("old_family")
            ? { currentVersion: "5.0.0" }
            : { currentVersion: null },
      },
      ...baseRoutes(),
    ]);
    render(<ScriptEditorPage />);
    await pickTarget("old_family");
    writeSql("SQL", ADDS_A_COLUMN);
    expect(await saveButton("5.1.0")).toBeInTheDocument();

    const releaseApplied = holdNext("/api/scripts/preflight", "POST");
    fireEvent.change(screen.getByLabelText("New script family name"), {
      target: { value: "new_family" },
    });

    // Waited for rather than read straight away: this is the moment GitHub has
    // answered for the new family and the target has not, which is the whole
    // window under test.
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: "Save to GitHub" })).toHaveAttribute(
          "title",
          "Checking which version of new_family is applied to Orders DB…"
        ),
      { timeout: 3000 }
    );
    expect(screen.queryByText(/v5\.0\.0/)).not.toBeInTheDocument();

    releaseApplied();
    await flushAsync();
    // Nothing of the old family survives the move: this one starts at 1.0.0.
    expect(await saveButton("1.0.0")).toBeInTheDocument();
  });
});

describe("what Save refuses to publish", () => {
  it("will not save a version with no rollback until that is a choice", async () => {
    setRoutes(baseRoutes());
    render(<ScriptEditorPage />);
    await pickTarget("add_invoices");
    writeSql("SQL", ADDS_A_COLUMN);

    expect(await refusal("1.0.0")).toBe(
      "Write a rollback, or tick Save without a rollback. Without one, Deploy cannot undo this version."
    );

    // Ticking is the whole point: a version that cannot be undone is a choice
    // somebody made, not something the editor let through.
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Save without a rollback/ })
    );
    expect(await saveButton("1.0.0")).toBeEnabled();
  });

  it("will not take a rollback and the no-rollback tick together", async () => {
    setRoutes(baseRoutes());
    render(<ScriptEditorPage />);
    await pickTarget("add_invoices");
    writeSql("SQL", ADDS_A_COLUMN);
    // Tick first, then write the rollback anyway: the tick drops the rollback
    // from the push, so saving now would throw away the text on screen.
    fireEvent.click(screen.getByRole("checkbox", { name: /Save without a rollback/ }));
    writeSql(/Rollback SQL/, DROPS_THE_COLUMN);

    expect(await refusal("1.0.0")).toBe(
      "You wrote a rollback and also ticked Save without a rollback. Untick the box to save the rollback with this version, or clear the rollback."
    );
  });

  it("will not let a script open or close its own transaction", async () => {
    setRoutes(baseRoutes());
    render(<ScriptEditorPage />);
    await pickTarget("add_invoices");
    writeSql("SQL", `${ADDS_A_COLUMN}\nCOMMIT;`);
    writeSql(/Rollback SQL/, DROPS_THE_COLUMN);

    // Deploy runs the script inside a transaction of its own and rejects this
    // there. Catching it here is the difference between a typo and a failed
    // deploy against a real database.
    expect(await refusal("1.0.0")).toBe(
      "Remove COMMIT, ROLLBACK or other transaction statements from the SQL (see the note above)."
    );
    expect(
      screen.getByText(/Deploy runs the whole script in one transaction of its own/)
    ).toBeInTheDocument();
  });

  it("will not record a quieter level than the SQL reads as without a tick", async () => {
    setRoutes(baseRoutes());
    render(<ScriptEditorPage />);
    await pickTarget("drop_invoices");
    writeSql("SQL", "DROP TABLE invoices;");
    writeSql(/Rollback SQL/, "CREATE TABLE invoices (id integer);");

    // The SQL drops a table, so the suggestion is major. Picking patch is
    // allowed — sometimes the table really is unused — but the version number
    // is how everyone downstream judges the risk, so it takes a tick.
    await saveButton("1.0.0");
    fireEvent.click(screen.getByRole("button", { name: /^patch/ }));
    const tick = await screen.findByRole("checkbox", { name: /Publish it as patch anyway/ });
    expect(await refusal("1.0.0")).toBe('Tick "Publish it as patch anyway" above, or pick major.');

    fireEvent.click(tick);
    expect(await saveButton("1.0.0")).toBeEnabled();
  });
});

describe("after a save", () => {
  it("sends what the screen showed, and says nothing has run yet", async () => {
    setRoutes([
      {
        match: "/api/github/push",
        method: "POST",
        body: {
          ok: true,
          version: "1.0.0",
          rollback_saved: true,
          url: "https://github.test/shop/public/add_invoices/v1.0.0.sql",
          paths: { migration: "shop/public/add_invoices/v1.0.0.sql" },
        },
      },
      ...baseRoutes(),
    ]);
    render(<ScriptEditorPage />);
    await pickTarget("add_invoices");
    writeSql("SQL", ADDS_A_COLUMN);
    writeSql(/Rollback SQL/, DROPS_THE_COLUMN);
    fireEvent.click(await saveButton("1.0.0"));

    expect(
      await screen.findByText("v1.0.0 saved to shop/public/add_invoices on GitHub, with its rollback.")
    ).toBeInTheDocument();
    const push = fetchCalls.find((c) => c.url.includes("/api/github/push"));
    expect(JSON.parse(push?.body ?? "null")).toMatchObject({
      database_name: "shop",
      schema_name: "public",
      script_name: "add_invoices",
      version: "1.0.0",
      // The level written into the file's header, so Deploy shows this
      // version as what the SQL was read as here.
      change_level: "additive",
      sql_content: ADDS_A_COLUMN,
      down_sql: DROPS_THE_COLUMN,
    });
    // A green "Saved" reads as "applied" unless something says otherwise, and
    // the page that applies it was only reachable through the sidebar.
    expect(
      screen.getByRole("link", { name: /Nothing has run yet — deploy it on the Deploy page/ })
    ).toHaveAttribute("href", "/deploy");
  });

  it("says a version saved without its rollback cannot be undone", async () => {
    setRoutes([
      {
        match: "/api/github/push",
        method: "POST",
        body: { ok: true, version: "1.0.0", rollback_saved: false, paths: {} },
      },
      ...baseRoutes(),
    ]);
    render(<ScriptEditorPage />);
    await pickTarget("add_invoices");
    writeSql("SQL", ADDS_A_COLUMN);
    fireEvent.click(screen.getByRole("checkbox", { name: /Save without a rollback/ }));
    fireEvent.click(await saveButton("1.0.0"));

    expect(
      await screen.findByText("v1.0.0 saved to shop/public/add_invoices on GitHub.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("No rollback was saved, so Deploy cannot undo this version.")
    ).toBeInTheDocument();
    // Nothing was sent for the rollback, so nothing can claim one was saved.
    const push = fetchCalls.find((c) => c.url.includes("/api/github/push"));
    expect(JSON.parse(push?.body ?? "null")).not.toHaveProperty("down_sql");
  });

  it("re-works the number when GitHub turns out to hold a higher one", async () => {
    // The listing can lag behind a write, so the number offered can be taken
    // by the time it is sent. The route answers with the highest version it
    // really has; saying only "version exists" would leave the reader to
    // guess the next one, and guessing lands under the floor again.
    let pushes = 0;
    setRoutes([
      {
        match: "/api/github/push",
        method: "POST",
        status: 409,
        body: () => {
          pushes += 1;
          return { ok: false, code: "version_exists", error: "v1.0.0 already exists.", highest_version: "2.0.0" };
        },
      },
      ...baseRoutes(),
    ]);
    render(<ScriptEditorPage />);
    await pickTarget("add_invoices");
    writeSql("SQL", ADDS_A_COLUMN);
    writeSql(/Rollback SQL/, DROPS_THE_COLUMN);
    fireEvent.click(await saveButton("1.0.0"));

    expect(
      await screen.findByText(/Nothing was saved: GitHub already has v2\.0\.0 of add_invoices/)
    ).toBeInTheDocument();
    expect(pushes).toBe(1);
    // The version it offers next is worked out again, from a floor that now
    // includes what the route said. A minor bump above v2.0.0 is v2.1.0.
    expect(await saveButton("2.1.0")).toBeEnabled();
  });
});
