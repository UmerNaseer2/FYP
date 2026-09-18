/** @jest-environment jsdom */

/**
 * The panel that publishes a generated migration to the GitHub registry.
 *
 * Two things here are worth a suite of their own. The first is the version
 * number, which nobody types: it is worked out from two reads (what the target
 * has applied, what GitHub already holds) and the change level picked beside
 * it. Getting it wrong is not a cosmetic bug — a number at or below the
 * family's highest sorts before scripts already published, so Deploy would
 * never offer it to a database that has reached them, and the version would
 * sit in the registry looking published while being unreachable.
 *
 * The second is whyPushIsBlocked(), a ladder of about ten reasons the button
 * is disabled. Only the first one is ever shown, so the ORDER is part of the
 * behaviour, not an implementation detail: a person whose script name is
 * invalid AND whose rollback is empty must be told about the name, because
 * fixing the rollback first would leave the button just as dead with a
 * different message. Every rung is a sentence that says what to do about it,
 * and a disabled button with no sentence is the failure this ladder exists to
 * prevent.
 *
 * What is NOT here:
 *  - Whether the push route accepts what this panel sends. The body it builds
 *    is asserted below; what the server does with it is tests/github-push.
 *  - The rules this panel applies, which are pure functions with their own
 *    suites: validateScriptName, rollbackChoiceProblem, describePush
 *    (tests/registry-push.test.ts), quieterLevelWarning, gradeSql
 *    (tests/change-type.test.ts), bumpVersion (tests/script-status.test.ts),
 *    backwardsWarning (tests/compare-timeline.test.ts). What is checked here
 *    is that the panel ASKS them, and about the right thing — a screen can
 *    call a correct rule with the wrong arguments and be wrong anyway.
 *  - The Copy button. navigator.clipboard does not exist in jsdom, and the
 *    component already treats a blocked clipboard as nothing to report, so
 *    there is no state to observe either way.
 *  - The 400ms debounce on both reads as a timing claim. The tests wait for
 *    the answer rather than counting requests, because a test that pinned the
 *    delay would fail on a change that only made the panel more responsive.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MigrationWorkbench } from "@/components/studio/MigrationWorkbench";
import { fetchCalls, holdNext, resetPageState, setRoutes } from "./helpers/render-page";

type Props = Parameters<typeof MigrationWorkbench>[0];

const UP = "ALTER TABLE invoices ADD COLUMN due_date date;\n";
const DOWN = "ALTER TABLE invoices DROP COLUMN due_date;\n";

const BASE: Props = {
  initialSql: UP,
  statementCount: 1,
  heldBackCount: 0,
  manualCount: 0,
  rollbackManualCount: 0,
  initialRollbackSql: DOWN,
  rollbackStatementCount: 1,
  rollbackCounts: { breaking: 1, safe: 0, info: 0 },
  rollbackWarnings: [],
  suggestedName: "add_due_date",
  suggestedDescription: "Add the due date column",
  targetLabel: "shop.public",
  targetSchema: "public",
  targetDatabase: "shop",
  suggestedKind: "additive",
  counts: { breaking: 0, safe: 1, info: 0 },
  warnings: [],
  targetConnectionId: 7,
  versionVerdict: null,
  sourceVersion: null,
  targetVersion: null,
  sourceName: "dev.public",
  targetName: "prod.public",
  swapHref: null,
};

/** GitHub's answer for the family folder. */
const inGitHub = (versions: string[]) => ({ match: "/api/github/family", body: { ok: true, versions } });
/** What the target says is applied. */
const appliedToTarget = (version: string | null) => ({
  match: "/api/scripts/preflight",
  body: { currentVersion: version },
});
/** A push that succeeds, with whatever extra fields the case needs. */
const pushSucceeds = (extra: Record<string, unknown> = {}) => ({
  match: "/api/github/push",
  body: { ok: true, url: "https://github.com/x/y/blob/main/v1.1.0.sql", ...extra },
});

/** What a schema's own version table says about itself, as Compare hands it over. */
const declared = (version: string) => ({
  table: "schema_version",
  version,
  recent: [],
  recentComplete: true,
  familyHeads: null,
  message: `Read from schema_version.`,
});

const sqlBox = () => screen.getByLabelText("Migration SQL — editable");
const downBox = () => screen.getByLabelText("Rollback SQL — editable");
const nameBox = () => screen.getByLabelText("Migration name");
/** The Push button, whichever of its two labels it is wearing. */
const pushButton = () => screen.getByRole("button", { name: /to GitHub$/ });
const bodyOf = (index: number) => JSON.parse(fetchCalls[index].body ?? "{}");

function show(over: Partial<Props> = {}) {
  return render(<MigrationWorkbench {...BASE} {...over} />);
}

/**
 * Wait until both reads are back.
 *
 * The button's own label is the signal: it says "Push to GitHub" until the
 * number is known and "Push v1.2.3 to GitHub" once it is, which is exactly the
 * versionsReady the panel gates its preview on. Waiting on a spinner that the
 * panel does not have would be waiting on nothing.
 */
async function versionReady() {
  await waitFor(() => expect(pushButton()).toHaveTextContent(/^Push v/));
}

beforeEach(() => {
  resetPageState();
  setRoutes([inGitHub(["1.0.0"]), appliedToTarget("1.0.0")]);
});
afterEach(() => cleanup());

describe("when the schemas already match", () => {
  it("offers nothing to save", () => {
    show({ statementCount: 0 });

    expect(
      screen.getByText(/No migration statements are needed/)
    ).toHaveTextContent("There is nothing to save.");
    expect(screen.queryByRole("button", { name: /to GitHub$/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Migration SQL — editable")).not.toBeInTheDocument();
  });

  it("asks GitHub nothing", async () => {
    // Nothing can be pushed, so reading the family would be a request made to
    // answer a question nobody is asking.
    show({ statementCount: 0 });
    await new Promise((r) => setTimeout(r, 450));

    expect(fetchCalls).toHaveLength(0);
  });
});

describe("the script name", () => {
  it("saves under the typed name when it is already usable", async () => {
    show();
    await versionReady();

    expect(screen.getByText(/Creates/)).toHaveTextContent("in shop/public/add_due_date/");
  });

  it("says what a name with spaces and symbols becomes", async () => {
    show();
    fireEvent.change(nameBox(), { target: { value: "add due date!" } });

    expect(screen.getByText(/spaces and symbols become _/)).toHaveTextContent(
      "Saved as add_due_date_ — spaces and symbols become _."
    );
  });

  it("falls back to the suggestion when the field is cleared", () => {
    show();
    fireEvent.change(nameBox(), { target: { value: "  " } });

    expect(screen.getByText(/the suggested name/)).toHaveTextContent(
      "Saved as add_due_date, the suggested name."
    );
  });

  it("refuses a name that is only punctuation, and says why", async () => {
    // "@@@" survives the replace as "___": a folder name that says nothing
    // about the script, so the registry would fill with them.
    show();
    fireEvent.change(nameBox(), { target: { value: "@@@" } });

    await waitFor(() => expect(pushButton()).toBeDisabled());
    expect(pushButton()).toHaveAttribute(
      "title",
      expect.stringContaining("Add at least one letter or digit")
    );
  });

  it("stops looking up a version it could not use", async () => {
    show();
    fireEvent.change(nameBox(), { target: { value: "@@@" } });
    await new Promise((r) => setTimeout(r, 450));

    expect(screen.getByText("The next version is worked out once the script name can be used.")).toBeInTheDocument();
    expect(fetchCalls.filter((c) => c.url.includes("/api/github/family"))).toHaveLength(0);
  });
});

describe("the two reads behind the next version", () => {
  it("says which read it is waiting on, in both the places it matters", async () => {
    // The same sentence twice on purpose: once where the version would be, for
    // someone watching for the number, and once beside the button, for someone
    // who has just found it dead and wants to know why. Either alone leaves
    // one of those two readers with an unexplained gap.
    const release = holdNext("/api/github/family");
    show();

    await waitFor(() =>
      expect(screen.getAllByText("Checking GitHub for the versions of add_due_date…")).toHaveLength(2)
    );
    expect(pushButton()).toBeDisabled();
    release();
    await versionReady();
  });

  it("names the target while waiting on it", async () => {
    const release = holdNext("/api/scripts/preflight");
    show();

    await screen.findAllByText("Checking which version of add_due_date is applied to shop.public…");
    release();
    await versionReady();
  });

  it("refuses with GitHub's own reason rather than guessing a number", async () => {
    // A guessed number is the one outcome worth blocking for: it would land in
    // the registry below versions already published and never be offered.
    setRoutes([
      { match: "/api/github/family", status: 403, body: { ok: false, error: "GitHub refused the token." } },
      appliedToTarget("1.0.0"),
    ]);
    show();

    // Stated where the version would be AND beside the button, for the same
    // reason the waiting sentence is.
    await waitFor(() => expect(screen.getAllByText("GitHub refused the token.")).toHaveLength(2));
    expect(pushButton()).toBeDisabled();
    expect(screen.queryByText(/Next version/)).not.toBeInTheDocument();
  });

  it("offers to read GitHub again, and uses what comes back", async () => {
    let attempt = 0;
    setRoutes([
      {
        match: "/api/github/family",
        body: () => {
          attempt += 1;
          return attempt === 1 ? { ok: false, error: "GitHub is having problems." } : { ok: true, versions: ["2.0.0"] };
        },
      },
      appliedToTarget(null),
    ]);
    show();

    await screen.findAllByText("GitHub is having problems.");
    fireEvent.click(screen.getByRole("button", { name: "Check GitHub again" }));

    await versionReady();
    expect(pushButton()).toHaveTextContent("Push v2.1.0 to GitHub");
  });

  it("carries on when only GitHub can be read", async () => {
    // No saved connection: the applied version is unknowable, and a panel that
    // stayed silent about that would look like it had checked both.
    setRoutes([inGitHub(["1.4.0"])]);
    show({ targetConnectionId: null });

    await versionReady();
    expect(
      screen.getByText(
        "The applied version can't be read — this target has no saved connection, so only GitHub is checked."
      )
    ).toBeInTheDocument();
    expect(fetchCalls.filter((c) => c.url.includes("preflight"))).toHaveLength(0);
  });

  it("carries on when the target refuses the read", async () => {
    setRoutes([inGitHub(["1.4.0"]), { match: "/api/scripts/preflight", status: 500, body: { error: "down" } }]);
    show();

    await versionReady();
    expect(
      screen.getByText("Couldn't read the versions applied to shop.public; only GitHub is checked.")
    ).toBeInTheDocument();
  });

  it("treats a GitHub answer about another name as no answer at all", async () => {
    // Nothing clears the previous answer when the name changes — it simply
    // stops matching the question. Without that check the old answer would
    // still be sitting in state, and the next version for a brand-new script
    // would be computed from another script's history entirely.
    //
    // No saved connection here on purpose. With one, the applied read goes
    // stale on the same keystroke and blocks the push by itself, so this
    // check would be carried by its neighbour and could be deleted unnoticed.
    setRoutes([
      {
        match: "/api/github/family",
        body: (url: string) => ({ ok: true, versions: url.includes("renamed") ? ["9.0.0"] : ["1.0.0"] }),
      },
    ]);
    show({ targetConnectionId: null });
    await versionReady();
    expect(pushButton()).toHaveTextContent("Push v1.1.0 to GitHub");

    fireEvent.change(nameBox(), { target: { value: "renamed" } });
    // The only answer in hand is about add_due_date, so there is no number yet.
    expect(pushButton()).toHaveTextContent("Push to GitHub");
    expect(pushButton()).toBeDisabled();

    await versionReady();
    expect(pushButton()).toHaveTextContent("Push v9.1.0 to GitHub");
  });

  it("treats a version applied to another connection as no answer at all", async () => {
    // The applied read is keyed by connection as well as by name, because two
    // targets can hold the same script at different versions — staging on
    // v3.0.0 while production is still on v1.0.0. Reading the answer from the
    // connection that was on screen a moment ago works the next version out
    // from the wrong database's history, and the folder name gives no hint
    // that anything is wrong because it is the same script either way.
    setRoutes([
      inGitHub(["1.0.0"]),
      {
        match: "/api/scripts/preflight",
        body: (_url: string, init?: RequestInit) => ({
          currentVersion: JSON.parse(String(init?.body)).connectionId === 7 ? "3.0.0" : "1.0.0",
        }),
      },
    ]);
    const { rerender } = render(<MigrationWorkbench {...BASE} />);
    await versionReady();
    expect(pushButton()).toHaveTextContent("Push v3.1.0 to GitHub");

    // Same script, same folder, different database behind it.
    rerender(<MigrationWorkbench {...BASE} targetConnectionId={9} />);
    expect(pushButton()).toBeDisabled();

    await versionReady();
    expect(pushButton()).toHaveTextContent("Push v1.1.0 to GitHub");
  });

  it("re-asks both reads when the name changes, and waits for both", async () => {
    // The pair of them, as a rename actually happens: each read is about one
    // script, so a new name means neither answer applies any more.
    setRoutes([
      {
        match: "/api/github/family",
        body: (url: string) => ({ ok: true, versions: url.includes("renamed") ? ["4.0.0"] : ["1.0.0"] }),
      },
      { match: "/api/scripts/preflight", body: { currentVersion: "2.0.0" } },
    ]);
    show();
    await versionReady();
    expect(pushButton()).toHaveTextContent("Push v2.1.0 to GitHub");

    fireEvent.change(nameBox(), { target: { value: "renamed" } });
    expect(pushButton()).toBeDisabled();

    await versionReady();
    expect(pushButton()).toHaveTextContent("Push v4.1.0 to GitHub");
    expect(fetchCalls.filter((c) => c.url.includes("renamed"))).toHaveLength(1);
    expect(fetchCalls.filter((c) => c.url.includes("preflight"))).toHaveLength(2);
  });
});

describe("the number the push will use", () => {
  it("takes the highest of what GitHub holds and what the target has applied", async () => {
    // Either side can be ahead: GitHub has versions nobody has deployed, and a
    // target can hold one pushed from another machine. Reading only one would
    // offer a number that already exists.
    setRoutes([inGitHub(["1.0.0", "1.2.0"]), appliedToTarget("1.5.0")]);
    show();

    await versionReady();
    expect(pushButton()).toHaveTextContent("Push v1.6.0 to GitHub");
    expect(screen.getByText(/In GitHub:/)).toHaveTextContent(
      "Applied to shop.public: v1.5.0 · In GitHub: v1.2.0 · a minor (additive) change makes v1.6.0"
    );
  });

  it("starts a family nobody has published at 1.0.0", async () => {
    setRoutes([inGitHub([]), appliedToTarget(null)]);
    show();

    await versionReady();
    expect(pushButton()).toHaveTextContent("Push v1.0.0 to GitHub");
    expect(screen.getByText(/First version of this family/)).toHaveTextContent(
      "First version of this family: v1.0.0"
    );
  });

  it("moves the number when the level is picked", async () => {
    setRoutes([inGitHub(["2.3.4"]), appliedToTarget(null)]);
    show();
    await versionReady();
    expect(pushButton()).toHaveTextContent("Push v2.4.0 to GitHub");

    fireEvent.click(screen.getByRole("button", { name: "breaking" }));
    await waitFor(() => expect(pushButton()).toHaveTextContent("Push v3.0.0 to GitHub"));

    fireEvent.click(screen.getByRole("button", { name: "patch" }));
    await waitFor(() => expect(pushButton()).toHaveTextContent("Push v2.3.5 to GitHub"));
  });

  it("lists the exact files it will write", async () => {
    setRoutes([inGitHub(["1.0.0"]), appliedToTarget(null)]);
    show();
    await versionReady();

    const preview = screen.getByText(/Creates/);
    expect(preview).toHaveTextContent("Creates v1.1.0.sql and v1.1.0.down.sql in shop/public/add_due_date/");
    expect(screen.getByText("Will become a minor bump: v1.0.0 → v1.1.0")).toBeInTheDocument();
  });

  it("says a rollback will not be written when none is going", async () => {
    setRoutes([inGitHub(["1.0.0"]), appliedToTarget(null)]);
    show({ initialRollbackSql: "" });
    await versionReady();

    fireEvent.click(screen.getByRole("checkbox", { name: /Save without a rollback/ }));
    expect(screen.getByText(/Creates/)).toHaveTextContent("Creates v1.1.0.sql in shop/public/add_due_date/");
    expect(
      screen.getByText("No rollback file will be written, so Deploy will not be able to undo v1.1.0.")
    ).toBeInTheDocument();
  });

  it("keeps the preview hidden until the number is known", async () => {
    const release = holdNext("/api/github/family");
    show();

    expect(screen.queryByText(/Creates/)).not.toBeInTheDocument();
    expect(screen.queryByText(/What this will do/)).not.toBeInTheDocument();
    release();
    await versionReady();
    expect(screen.getByText("What this will do")).toBeInTheDocument();
  });
});

describe("the change level", () => {
  it("follows the generator until someone picks one", async () => {
    show();
    await versionReady();
    expect(screen.getByRole("button", { name: "additive" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("auto-suggested")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "patch" }));
    expect(screen.getByRole("button", { name: "patch" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("suggested: additive")).toBeInTheDocument();
  });

  it("raises the suggestion when an edit adds something destructive", async () => {
    // The generator graded what IT wrote. A hand-typed DROP TABLE is not in
    // that grade, and publishing it as additive is how a breaking change gets
    // a minor version number.
    show();
    await versionReady();

    fireEvent.change(sqlBox(), { target: { value: "DROP TABLE invoices;" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "breaking" })).toHaveAttribute("aria-pressed", "true"));
  });

  it("blocks a quieter level than the grade until it is agreed to", async () => {
    setRoutes([inGitHub(["1.0.0"]), appliedToTarget(null)]);
    show({ suggestedKind: "breaking" });
    await versionReady();

    fireEvent.click(screen.getByRole("button", { name: "patch" }));
    await waitFor(() => expect(pushButton()).toBeDisabled());
    expect(pushButton()).toHaveAttribute(
      "title",
      'Tick "Publish it as patch anyway" under Change level, or pick breaking.'
    );

    const tick = screen.getByRole("checkbox", {
      name: "This is graded breaking. Publish it as patch anyway — the version number will understate the change.",
    });
    fireEvent.click(tick);
    await waitFor(() => expect(pushButton()).toBeEnabled());
  });

  it("says it is the recorded level that understates a first version", async () => {
    // 1.0.0 whatever the level, so the number cannot understate anything —
    // only the Change-type line written into the file can.
    setRoutes([inGitHub([]), appliedToTarget(null)]);
    show({ suggestedKind: "breaking" });
    await versionReady();

    fireEvent.click(screen.getByRole("button", { name: "patch" }));
    await screen.findByText(
      "This is graded breaking. Publish it as patch anyway — the level recorded with it will understate the change."
    );
  });

  it("takes the tick back when the SQL it agreed to changes", async () => {
    setRoutes([inGitHub(["1.0.0"]), appliedToTarget(null)]);
    show({ suggestedKind: "breaking" });
    await versionReady();

    fireEvent.click(screen.getByRole("button", { name: "patch" }));
    const tick = await screen.findByRole("checkbox", { name: /Publish it as patch anyway/ });
    fireEvent.click(tick);
    await waitFor(() => expect(pushButton()).toBeEnabled());

    fireEvent.change(sqlBox(), { target: { value: "ALTER TABLE invoices ADD COLUMN paid boolean;" } });
    await waitFor(() => expect(pushButton()).toBeDisabled());
  });
});

describe("why Push can't be pressed", () => {
  it("shows the same reason beside the button and on it", async () => {
    // The button is disabled, so it has no hover of its own to explain itself
    // to a mouse; the title covers that, and the line beside it covers a
    // reader who never hovers.
    show({ initialRollbackSql: "" });
    await versionReady();

    const why = "Write a rollback, or tick Save without a rollback. Without one, Deploy cannot undo this version.";
    expect(screen.getByText(why)).toBeInTheDocument();
    expect(pushButton()).toHaveAttribute("title", why);
  });

  it("puts the name before everything else", async () => {
    // Both are wrong. Fixing the rollback first would leave the button just as
    // dead, with a message that had said nothing about the real problem.
    show({ initialRollbackSql: "" });
    fireEvent.change(nameBox(), { target: { value: "@@@" } });

    await waitFor(() =>
      expect(pushButton()).toHaveAttribute("title", expect.stringContaining("Add at least one letter or digit"))
    );
  });

  it("refuses a migration that would run nothing", async () => {
    show();
    fireEvent.change(sqlBox(), { target: { value: "-- thought better of it\n" } });

    await waitFor(() =>
      expect(pushButton()).toHaveAttribute(
        "title",
        "The migration contains no statements (only comments or blank lines), so it would change nothing."
      )
    );
  });

  it("refuses transaction control in the migration", async () => {
    // Deploy wraps the run in one transaction, so a BEGIN inside a script
    // breaks the run it is part of.
    show();
    fireEvent.change(sqlBox(), { target: { value: "BEGIN;\nALTER TABLE invoices ADD COLUMN x int;\nCOMMIT;" } });

    await waitFor(() =>
      expect(pushButton()).toHaveAttribute(
        "title",
        "Remove BEGIN / COMMIT / ROLLBACK from the migration script before pushing."
      )
    );
    expect(screen.getByText(/Transaction control isn't allowed/)).toBeInTheDocument();
  });

  it("refuses it in the rollback too, while the migration pane is showing", async () => {
    // Both files are saved by one push, so a rollback nobody is looking at can
    // still block it — and the message has to name which script it means.
    show({ initialRollbackSql: "ROLLBACK;\nALTER TABLE invoices DROP COLUMN due_date;" });
    await versionReady();

    expect(pushButton()).toHaveAttribute(
      "title",
      "Remove BEGIN / COMMIT / ROLLBACK from the rollback script before pushing."
    );
    // The inline warning is about the pane on screen, which is clean.
    expect(screen.queryByText(/Transaction control isn't allowed/)).not.toBeInTheDocument();
  });

  it("refuses a rollback that is only comments", async () => {
    show({ initialRollbackSql: "-- undo it by hand\n" });
    await versionReady();

    expect(pushButton()).toHaveAttribute(
      "title",
      "This rollback contains only comments, so it would undo nothing. Write the statements that undo the migration, or tick Save without a rollback."
    );
  });

  it("refuses a rollback that is both written and waived", async () => {
    show();
    await versionReady();
    // One textarea serves both panes, so the rollback is only editable from
    // its own tab. The tick box is beside Push and reachable from either.
    fireEvent.click(screen.getByRole("tab", { name: "Rollback" }));
    fireEvent.change(downBox(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Save without a rollback/ }));
    fireEvent.change(downBox(), { target: { value: DOWN } });

    await waitFor(() =>
      expect(pushButton()).toHaveAttribute(
        "title",
        "You wrote a rollback and also ticked Save without a rollback. Untick the box to save the rollback with this version, or clear the rollback."
      )
    );
  });
});

describe("a push that would move the target back", () => {
  const VERDICT = { newer: "right" as const, reason: "prod.public declares v2.0.0." };

  it("states it, and holds the push until it is agreed to", async () => {
    setRoutes([inGitHub(["1.0.0"]), appliedToTarget(null)]);
    show({
      versionVerdict: VERDICT,
      sourceVersion: declared("1.0.0"),
      targetVersion: declared("2.0.0"),
    });
    await versionReady();

    expect(screen.getByText("This would move prod.public backwards")).toBeInTheDocument();
    expect(pushButton()).toBeDisabled();
    expect(pushButton()).toHaveAttribute(
      "title",
      "Tick the box above to confirm prod.public should move back to the older schema."
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: "I have checked this and want prod.public to match the older schema." })
    );
    await waitFor(() => expect(pushButton()).toBeEnabled());
  });

  it("offers the comparison the other way when there is one", async () => {
    setRoutes([inGitHub(["1.0.0"]), appliedToTarget(null)]);
    show({ versionVerdict: VERDICT, swapHref: "/compare?a=prod&b=dev" });
    await versionReady();

    expect(screen.getByRole("link", { name: "Compare the other way instead" })).toHaveAttribute(
      "href",
      "/compare?a=prod&b=dev"
    );
  });

  it("says nothing when the schemas already match", () => {
    // Nothing moves, so there is nothing to move backwards.
    show({ versionVerdict: VERDICT, statementCount: 0 });

    expect(screen.queryByText(/would move prod.public backwards/)).not.toBeInTheDocument();
  });
});

describe("the two panes", () => {
  it("edits, counts and warns about the pane on screen", async () => {
    show({
      rollbackWarnings: ["Rows dropped by the migration do not come back."],
      rollbackStatementCount: 3,
      rollbackCounts: { breaking: 2, safe: 0, info: 1 },
    });
    await versionReady();

    expect(screen.getByText("0 breaking")).toBeInTheDocument();
    expect(screen.queryByText(/This restores structure, not data/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Rollback" }));

    expect(screen.getByText("2 breaking")).toBeInTheDocument();
    expect(screen.getByText("Rows dropped by the migration do not come back.", { exact: false })).toBeInTheDocument();
    expect(downBox()).toHaveValue(DOWN);
  });

  it("keeps each pane's edits when the other is reset", async () => {
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(true);
    show();
    await versionReady();

    fireEvent.change(sqlBox(), { target: { value: "ALTER TABLE invoices ADD COLUMN paid boolean;" } });
    fireEvent.click(screen.getByRole("tab", { name: "Rollback" }));
    fireEvent.change(downBox(), { target: { value: "ALTER TABLE invoices DROP COLUMN paid;" } });

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(confirm).toHaveBeenCalledWith(
      "Discard your edits to the rollback script? The migration pane is not affected."
    );
    expect(downBox()).toHaveValue(DOWN);

    fireEvent.click(screen.getByRole("tab", { name: "Migration" }));
    expect(sqlBox()).toHaveValue("ALTER TABLE invoices ADD COLUMN paid boolean;");
    confirm.mockRestore();
  });

  it("keeps the edits when the reset is declined", async () => {
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
    show();
    await versionReady();

    fireEvent.change(sqlBox(), { target: { value: "DROP TABLE invoices;" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(sqlBox()).toHaveValue("DROP TABLE invoices;");
    confirm.mockRestore();
  });

  it("does not ask before resetting a pane nobody edited", async () => {
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(true);
    show();
    await versionReady();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("points at the rollback's warnings from the pane Push is pressed on", async () => {
    show({ rollbackWarnings: ["Dropped rows do not come back.", "A renamed column keeps its new name."] });
    await versionReady();

    expect(screen.getByText(/read them before pushing/)).toHaveTextContent(
      "The rollback has 2 warnings about what it cannot put back — read them before pushing."
    );
    fireEvent.click(screen.getByRole("button", { name: "Open the Rollback tab" }));
    expect(screen.getByRole("tab", { name: "Rollback" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("what the push sends", () => {
  it("sends the SQL, the level and the rollback under the sanitised name", async () => {
    setRoutes([inGitHub(["1.0.0"]), appliedToTarget(null), pushSucceeds({ version: "2.0.0", rollback_saved: true })]);
    show();
    await versionReady();

    fireEvent.click(screen.getByRole("button", { name: "breaking" }));
    await waitFor(() => expect(pushButton()).toHaveTextContent("Push v2.0.0 to GitHub"));
    fireEvent.click(pushButton());

    await screen.findByText(/pushed to shop\/public\/add_due_date on GitHub, with its rollback\./);
    const sent = bodyOf(fetchCalls.length - 1);
    expect(sent).toEqual({
      database_name: "shop",
      schema_name: "public",
      script_name: "add_due_date",
      version: "2.0.0",
      change_level: "breaking",
      sql_content: UP,
      down_sql: DOWN,
      description: "Add the due date column",
    });
  });

  it("leaves out the rollback when the box is ticked", async () => {
    setRoutes([inGitHub(["1.0.0"]), appliedToTarget(null), pushSucceeds({ version: "1.1.0" })]);
    show({ initialRollbackSql: "" });
    await versionReady();

    fireEvent.click(screen.getByRole("checkbox", { name: /Save without a rollback/ }));
    fireEvent.click(pushButton());

    await screen.findByText("No rollback was saved, so Deploy cannot undo this version.");
    expect(bodyOf(fetchCalls.length - 1).down_sql).toBeUndefined();
  });

  it("leaves out an empty description rather than sending a blank one", async () => {
    setRoutes([inGitHub(["1.0.0"]), appliedToTarget(null), pushSucceeds({ version: "1.1.0", rollback_saved: true })]);
    show({ suggestedDescription: "" });
    await versionReady();

    fireEvent.click(pushButton());
    await screen.findByText(/pushed to shop/);
    expect(bodyOf(fetchCalls.length - 1)).not.toHaveProperty("description");
  });

  it("reports the push it actually made, not the one on screen when it answered", async () => {
    // The person keeps typing while the request is in flight. The answer is
    // about what was sent, so the version in the message must be that one.
    setRoutes([inGitHub(["1.0.0"]), appliedToTarget(null), pushSucceeds({ version: "1.1.0", rollback_saved: true })]);
    const release = holdNext("/api/github/push", "POST");
    show();
    await versionReady();

    fireEvent.click(pushButton());
    fireEvent.click(screen.getByRole("button", { name: "breaking" }));
    release();

    await screen.findByText("v1.1.0 pushed to shop/public/add_due_date on GitHub, with its rollback.");
  });

  it("says nothing has run yet, and where to run it", async () => {
    // A green tick straight after a comparison reads as "done". It is not:
    // the version is in a repository and no database has seen it.
    setRoutes([inGitHub(["1.0.0"]), appliedToTarget(null), pushSucceeds({ version: "1.1.0", rollback_saved: true })]);
    show();
    await versionReady();
    fireEvent.click(pushButton());

    const done = await screen.findByText("Nothing has run yet — deploy it");
    expect(done).toHaveAttribute("href", "/deploy");
    expect(screen.getByRole("link", { name: "View on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/x/y/blob/main/v1.1.0.sql"
    );
  });
});

describe("a push that does not go through", () => {
  it("offers the next free number when the server says it is taken", async () => {
    let attempt = 0;
    setRoutes([
      {
        match: "/api/github/family",
        body: () => ({ ok: true, versions: attempt === 0 ? ["1.0.0"] : ["1.0.0", "1.1.0"] }),
      },
      appliedToTarget(null),
      {
        match: "/api/github/push",
        status: 409,
        body: () => {
          attempt += 1;
          return {
            ok: false,
            code: "version_exists",
            error: 'v1.1.0 of "add_due_date" is already in GitHub.',
            highest_version: "1.1.0",
            suggested: "1.2.0",
          };
        },
      },
    ]);
    show();
    await versionReady();
    fireEvent.click(pushButton());

    await screen.findByText('v1.1.0 of "add_due_date" is already in GitHub.');
    // The refused number is learned at once, so the offer is above it.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Push as v/ })).toHaveTextContent("Push as v1.2.0 instead")
    );
  });

  it("says so when GitHub moved on again between the refusal and the re-read", async () => {
    setRoutes([
      { match: "/api/github/family", body: { ok: true, versions: ["1.0.0", "3.0.0"] } },
      appliedToTarget(null),
      {
        match: "/api/github/push",
        status: 409,
        body: {
          ok: false,
          code: "version_exists",
          error: "Taken.",
          highest_version: "1.1.0",
          suggested: "1.2.0",
        },
      },
    ]);
    show();
    await versionReady();
    fireEvent.click(pushButton());

    await screen.findByText("GitHub changed again since then, so the next free number is now v3.1.0.");
  });

  it("does not claim a dropped connection failed", async () => {
    // The request may well have reached GitHub. Saying it did not is the one
    // answer that could send someone to push a duplicate.
    setRoutes([
      inGitHub(["1.0.0"]),
      appliedToTarget(null),
      { match: "/api/github/push", networkError: true },
    ]);
    show();
    await versionReady();
    fireEvent.click(pushButton());

    await screen.findByText(
      "The connection to the server dropped while pushing v1.1.0, so it is not known whether it was saved. GitHub is being read again: if it now lists v1.1.0, the push went through."
    );
  });

  it("explains a refusal the server gave no words for", async () => {
    setRoutes([
      inGitHub(["1.0.0"]),
      appliedToTarget(null),
      { match: "/api/github/push", status: 500, body: {} },
    ]);
    show();
    await versionReady();
    fireEvent.click(pushButton());

    await screen.findByText(/The server answered with an error \(status 500\) and no explanation/);
    expect(screen.queryByRole("button", { name: /^Push as v/ })).not.toBeInTheDocument();
  });

  it("clears an error that no longer describes the screen", async () => {
    setRoutes([
      inGitHub(["1.0.0"]),
      appliedToTarget(null),
      { match: "/api/github/push", status: 500, body: { error: "Something went wrong." } },
    ]);
    show();
    await versionReady();
    fireEvent.click(pushButton());
    await screen.findByText("Something went wrong.");

    fireEvent.change(sqlBox(), { target: { value: "ALTER TABLE invoices ADD COLUMN paid boolean;" } });
    await waitFor(() => expect(screen.queryByText("Something went wrong.")).not.toBeInTheDocument());
  });
});

describe("pushing the same migration again", () => {
  async function pushOnce(rollbackSaved: boolean) {
    setRoutes([
      inGitHub(["1.0.0"]),
      appliedToTarget(null),
      pushSucceeds({ version: "1.1.0", ...(rollbackSaved ? { rollback_saved: true } : {}) }),
    ]);
    show();
    await versionReady();
    fireEvent.click(pushButton());
    await screen.findByText(/pushed to shop\/public\/add_due_date on GitHub/);
  }

  it("refuses, rather than publishing a copy as the next number", async () => {
    await pushOnce(true);

    await waitFor(() => expect(pushButton()).toBeDisabled());
    expect(pushButton()).toHaveAttribute(
      "title",
      "v1.1.0 was pushed with this same migration and already has a rollback, which can't be changed. Edit the migration to push a new version."
    );
  });

  it("lets it through again once the migration is edited", async () => {
    await pushOnce(true);
    await waitFor(() => expect(pushButton()).toBeDisabled());

    fireEvent.change(sqlBox(), { target: { value: "ALTER TABLE invoices ADD COLUMN paid boolean;" } });
    await waitFor(() => expect(pushButton()).toBeEnabled());
    // The version just pushed is known even before GitHub lists it.
    expect(pushButton()).toHaveTextContent("Push v1.2.0 to GitHub");
  });

  it("points at the offer below instead, when a rollback can still be added", async () => {
    setRoutes([
      inGitHub(["1.0.0"]),
      appliedToTarget(null),
      pushSucceeds({ version: "1.1.0", rollback_error: "GitHub refused the rollback file." }),
    ]);
    show();
    await versionReady();
    fireEvent.click(pushButton());

    await screen.findByText("GitHub refused the rollback file.");
    expect(pushButton()).toHaveAttribute(
      "title",
      "Add the rollback to v1.1.0 with the button below, rather than pushing the same migration again."
    );
  });

  it("does not offer to deploy a version whose rollback failed", async () => {
    // The amber box means it went out without one, and the offer directly
    // below fixes that. Deploy is still allowed; it is just not what to
    // suggest while something better is one button away.
    setRoutes([
      inGitHub(["1.0.0"]),
      appliedToTarget(null),
      pushSucceeds({ version: "1.1.0", rollback_error: "GitHub refused the rollback file." }),
    ]);
    show();
    await versionReady();
    fireEvent.click(pushButton());

    await screen.findByText("GitHub refused the rollback file.");
    expect(screen.queryByText("Nothing has run yet — deploy it")).not.toBeInTheDocument();
  });
});

describe("adding the rollback afterwards", () => {
  async function pushWithoutSavedRollback() {
    setRoutes([
      inGitHub(["1.0.0"]),
      appliedToTarget(null),
      { match: "/api/github/push", body: (_url: string, init?: RequestInit) =>
          JSON.parse(String(init?.body)).attach_rollback === true
            ? { ok: true }
            : { ok: true, version: "1.1.0", url: null, rollback_error: "The rollback was not saved." } },
    ]);
    show();
    await versionReady();
    fireEvent.click(pushButton());
    await screen.findByText("The rollback was not saved.");
  }

  it("adds it to the version already pushed, making no new version", async () => {
    await pushWithoutSavedRollback();

    fireEvent.click(screen.getByRole("button", { name: "Retry saving the rollback" }));
    await screen.findByText("Rollback saved. Deploy can now undo v1.1.0.");

    const sent = bodyOf(fetchCalls.length - 1);
    expect(sent).toEqual({
      attach_rollback: true,
      database_name: "shop",
      schema_name: "public",
      script_name: "add_due_date",
      version: "1.1.0",
      down_sql: DOWN,
    });
  });

  it("stops saying the rollback is missing once it is there", async () => {
    await pushWithoutSavedRollback();
    fireEvent.click(screen.getByRole("button", { name: "Retry saving the rollback" }));
    await screen.findByText("Rollback saved. Deploy can now undo v1.1.0.");

    expect(screen.queryByText("The rollback was not saved.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry saving the rollback/ })).not.toBeInTheDocument();
  });

  it("calls it adding, not retrying, when the rollback has changed since", async () => {
    await pushWithoutSavedRollback();
    fireEvent.click(screen.getByRole("tab", { name: "Rollback" }));
    fireEvent.change(downBox(), { target: { value: "DROP TABLE invoices;" } });

    expect(screen.getByRole("button", { name: "Add this rollback to v1.1.0" })).toBeInTheDocument();
  });

  it("does not claim somebody else's rollback is in the way", async () => {
    // After a dropped connection it may well be ours that is already there.
    setRoutes([
      inGitHub(["1.0.0"]),
      appliedToTarget(null),
      { match: "/api/github/push", body: (_url: string, init?: RequestInit) =>
          JSON.parse(String(init?.body)).attach_rollback === true
            ? { ok: false, code: "rollback_exists" }
            : { ok: true, version: "1.1.0", url: null, rollback_error: "The rollback was not saved." } },
    ]);
    show();
    await versionReady();
    fireEvent.click(pushButton());
    await screen.findByText("The rollback was not saved.");

    fireEvent.click(screen.getByRole("button", { name: "Retry saving the rollback" }));
    await screen.findByText(
      "v1.1.0 already has a rollback with statements, so nothing more was saved. A saved rollback never changes."
    );
    // No rollback can be added now, so the offer goes with it.
    expect(screen.queryByRole("button", { name: /rollback/i })).not.toBeInTheDocument();
  });

  it("says a dropped connection leaves the outcome unknown, and retrying is safe", async () => {
    setRoutes([
      inGitHub(["1.0.0"]),
      appliedToTarget(null),
      { match: "/api/github/push", method: "POST", body: (_url: string, init?: RequestInit) => {
          if (JSON.parse(String(init?.body)).attach_rollback === true) throw new Error("network");
          return { ok: true, version: "1.1.0", url: null, rollback_error: "The rollback was not saved." };
        } },
    ]);
    show();
    await versionReady();
    fireEvent.click(pushButton());
    await screen.findByText("The rollback was not saved.");

    fireEvent.click(screen.getByRole("button", { name: "Retry saving the rollback" }));
    await screen.findByText(/it is not known whether it was saved. Trying again is safe/);
    // Still offered, because it may genuinely not be there.
    expect(screen.getByRole("button", { name: "Retry saving the rollback" })).toBeEnabled();
  });
});

describe("what the editor reports about the script", () => {
  it("counts lines and statements, and names notes nothing will run", async () => {
    show({ statementCount: 4, manualCount: 2, heldBackCount: 1 });
    await versionReady();

    const line = screen.getByText(/statements/).closest("span");
    expect(line).toHaveTextContent("2 lines · 4 statements (2 notes, nothing to run) (1 held back — commented out) · SQL");
  });

  it("marks the script as edited only once it differs", async () => {
    show();
    await versionReady();
    expect(screen.getByText("Unedited")).toBeInTheDocument();

    fireEvent.change(sqlBox(), { target: { value: "DROP TABLE invoices;" } });
    expect(screen.getByText("Edited")).toBeInTheDocument();
  });

  it("lists what the generator left out", async () => {
    show({ warnings: ["orders exists only in the target and is not dropped."] });
    await versionReady();

    expect(screen.getByText("Not included in this migration (1)")).toBeInTheDocument();
    expect(screen.getByText("orders exists only in the target and is not dropped.")).toBeInTheDocument();
  });
});
