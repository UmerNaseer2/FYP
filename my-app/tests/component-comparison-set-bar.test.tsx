/** @jest-environment jsdom */

/**
 * ComparisonSetBar: the strip above the Compare pickers that opens, saves and
 * deletes a saved comparison (spec feature 4).
 *
 * The rest of Compare is a GET form — the URL is the selection, so it stays
 * safe to reload and share. This bar is the one part that writes, and three of
 * its rules are the reason it is a component of its own:
 *
 *   Save stores the selection the page last loaded, not the one being typed.
 *   So while a picker has been changed and Compare not yet pressed, Save is
 *   off and says why. Saving then would store something other than what the
 *   reader is looking at, under the name they just gave it.
 *
 *   Both Save and Delete end in a navigation, and Compare remounts on every
 *   new URL. A confirmation kept in this bar's own state goes with the bar
 *   before anyone reads it, so the message is handed to the bar that comes
 *   after — and only to one that opened on the set the message is about.
 *
 *   A name that belongs to somebody else's saved set is a conflict, not an
 *   overwrite. The server answers 409, the reader is asked, and declining
 *   leaves both sets alone and says so.
 *
 * What is NOT here:
 *  - The rules themselves. saveButtonLabel, setOptionLabel, matchesSet and
 *    validateSaveInput are lib/comparison-set-rules, with their own suite;
 *    selectionToQuery is lib/compare-selection, with its own. This suite
 *    checks what the bar does with their answers, not the answers.
 *  - The endpoint. /api/comparison-sets does the real name-conflict check and
 *    the writing; here it is a canned reply.
 *  - Whether the selection on screen still matches the set. The Compare page
 *    works that out and passes `modified` in.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  ComparisonSetBar,
  type ComparisonSetOption,
} from "@/components/studio/ComparisonSetBar";
import type { CurrentSelection } from "@/lib/compare-selection";
import {
  fetchCalls,
  flushAsync,
  resetPageState,
  routerCalls,
  setRoutes,
  setSearchParams,
  setUser,
} from "./helpers/render-page";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

/* ----------------------------------------------------------------- fixtures */

const SELECTION: CurrentSelection = {
  sourceConnectionId: 3,
  sourceConnectionLabel: "Staging",
  sourceSchema: "public",
  allowDataLoss: false,
  compareData: false,
  dataTables: [],
  targets: [{ connectionId: 4, connectionLabel: "Prod shop", schema: "public" }],
};

/** What the selection above spells out in a URL, for the bar's own navigations. */
const SELECTION_QUERY =
  "sourceConnection=3&sourceSchema=public&targetConnection=4&targetSchema=public";

const set = (over: Partial<ComparisonSetOption> = {}): ComparisonSetOption => ({
  id: 7,
  name: "Nightly check",
  targetCount: 1,
  hasProduction: false,
  compareData: false,
  hasMissingConnection: false,
  lastRunAt: null,
  ...over,
});

const SETS = [set()];

/* ------------------------------------------------------------------ helpers */

type BarProps = Parameters<typeof ComparisonSetBar>[0];

function show(props: Partial<BarProps> = {}) {
  const merged: BarProps = {
    sets: SETS,
    activeSetId: null,
    modified: false,
    selection: SELECTION,
    hasUnappliedChanges: false,
    asked: true,
    ...props,
  };
  return render(<ComparisonSetBar {...merged} />);
}

/** What window.confirm was asked, and what it will answer. */
let asked: string[] = [];
let confirmAnswer = true;

const nameBox = () => screen.getByLabelText("Comparison set name");
const saveButton = () => screen.getByRole("button", { name: /^(Save|Update|Saving)/ });
const deleteButton = () => screen.getByRole("button", { name: /^Delete the set/ });
const posts = () => fetchCalls.filter((call) => call.method === "POST");
const sent = (index = 0) => JSON.parse(posts()[index].body ?? "{}");

/** The reply a successful save sends back. */
const saved = (id: number, created: boolean) => [
  {
    match: "/api/comparison-sets",
    method: "POST",
    body: { ok: true, created, set: { id, name: "Nightly check" } },
  },
];

beforeEach(() => {
  resetPageState();
  setUser("editor");
  asked = [];
  confirmAnswer = true;
  // jsdom has no dialogs at all: window.confirm logs "not implemented" and
  // returns undefined, which would read as "the user said no" everywhere.
  window.confirm = (message?: string) => {
    asked.push(String(message));
    return confirmAnswer;
  };
});

afterEach(() => {
  cleanup();
  // The bar leaves its confirmation in a module-level variable for whichever
  // bar renders next — which is how it survives the navigation. Nothing in the
  // next test should inherit one, so a throwaway mount takes it, exactly as a
  // remount does in the app.
  show();
  cleanup();
});

/* -------------------------------------------------------------------- tests */

describe("opening a saved set", () => {
  it("says how to make the first one when there are none", () => {
    show({ sets: [] });

    expect(
      screen.getByText("None yet — set up a comparison below, then name it and save it.")
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Open a saved comparison set")).not.toBeInTheDocument();
  });

  it("does not tell a viewer to save one", () => {
    setUser("viewer");
    show({ sets: [] });

    expect(screen.getByText("None saved yet.")).toBeInTheDocument();
  });

  it("puts everything worth knowing before opening it in the option", () => {
    show({
      sets: [
        set({
          targetCount: 2,
          hasProduction: true,
          compareData: true,
          hasMissingConnection: true,
        }),
      ],
    });

    fireEvent.click(screen.getByLabelText("Open a saved comparison set"));

    expect(
      screen.getByRole("option", {
        name: "Nightly check · 2 targets · prod · row data · connection deleted · never run",
      })
    ).toBeInTheDocument();
  });

  it("does not print a dash where a run time should be", () => {
    // timeAgo answers "—" for a timestamp it cannot read, which in the middle
    // of the option reads as a gap rather than an answer.
    show({ sets: [set({ lastRunAt: "not a date" })] });

    fireEvent.click(screen.getByLabelText("Open a saved comparison set"));

    expect(screen.getByRole("option", { name: /never run$/ })).toBeInTheDocument();
  });

  it("opens a set as a link anyone could have typed, and runs it", () => {
    show({ sets: [set({ id: 12 })] });

    fireEvent.click(screen.getByLabelText("Open a saved comparison set"));
    fireEvent.click(screen.getByRole("option", { name: /Nightly check/ }));

    expect(routerCalls.push).toEqual(["/compare?set=12&run=1"]);
  });
});

describe("the name box", () => {
  it("starts on the open set's name, so Save updates it", () => {
    show({ activeSetId: 7 });

    expect(nameBox()).toHaveValue("Nightly check");
    expect(saveButton()).toHaveTextContent("Update");
  });

  it("follows the set when a save renames it under the same id", () => {
    // Saving "Orders" over "orders" reloads the same URL, so this bar stays
    // mounted. Without this the next Save would write the old name back.
    const { rerender } = show({ activeSetId: 7 });

    rerender(
      <ComparisonSetBar
        sets={[set({ name: "Orders" })]}
        activeSetId={7}
        modified={false}
        selection={SELECTION}
        hasUnappliedChanges={false}
        asked
      />
    );

    expect(nameBox()).toHaveValue("Orders");
  });

  it("offers to save a new set beside the open one when the name is changed", () => {
    show({ activeSetId: 7 });

    fireEvent.change(nameBox(), { target: { value: "Weekly check" } });

    expect(saveButton()).toHaveTextContent("Save as new");
  });

  it("stops at the length the endpoint stores", () => {
    show();

    expect(nameBox()).toHaveAttribute("maxlength", "60");
  });
});

describe("when Save is off", () => {
  it("is off for a viewer, and says who can", () => {
    setUser("viewer");
    show();

    expect(saveButton()).toBeDisabled();
    expect(nameBox()).toBeDisabled();
    expect(screen.getByText("Only editors can save or delete comparison sets.")).toBeInTheDocument();
  });

  it("waits for Compare rather than saving a selection nobody can see", () => {
    // The guard: `selection` is what the page last loaded, so saving now would
    // store a comparison other than the one on screen.
    show({ hasUnappliedChanges: true });

    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAttribute("title", "Press Compare first");
    expect(
      screen.getByText(
        "Press Compare first — Save stores the selection as the page last loaded it, and your latest changes are not in it yet."
      )
    ).toBeInTheDocument();
  });

  it("is off when Update would write the set back exactly as it is", () => {
    show({ activeSetId: 7 });

    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAttribute(
      "title",
      "Nothing to update — this is the comparison the set already holds"
    );
  });

  it("is on again once the name's capitals are corrected", () => {
    // An exact test, so "nightly check" over "Nightly check" is a real change.
    show({ activeSetId: 7 });

    fireEvent.change(nameBox(), { target: { value: "nightly check" } });

    expect(saveButton()).toBeEnabled();
    expect(saveButton()).toHaveTextContent("Update");
  });

  it("asks for a name before asking the server for anything", async () => {
    show();

    fireEvent.click(saveButton());
    await flushAsync();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Give the set a name so you can find it again."
    );
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("saving", () => {
  it("sends the loaded selection under the typed name", async () => {
    setRoutes(saved(21, true));
    show();

    fireEvent.change(nameBox(), { target: { value: "  Nightly check  " } });
    fireEvent.click(saveButton());
    await flushAsync();

    expect(posts()).toHaveLength(1);
    expect(sent()).toMatchObject({
      name: "Nightly check",
      id: null,
      overwrite: false,
      sourceConnectionId: 3,
      sourceSchema: "public",
      targets: [{ connectionId: 4, connectionLabel: "Prod shop", schema: "public" }],
    });
  });

  it("names the set that is open, so saving over it is an update not a clash", async () => {
    setRoutes(saved(7, false));
    show({ activeSetId: 7 });

    fireEvent.change(nameBox(), { target: { value: "Nightly check v2" } });
    fireEvent.click(saveButton());
    await flushAsync();

    expect(sent().id).toBe(7);
  });

  it("lands on the set it just wrote, still run", async () => {
    setRoutes(saved(21, true));
    show();

    fireEvent.change(nameBox(), { target: { value: "Nightly check" } });
    fireEvent.click(saveButton());
    await flushAsync();

    expect(routerCalls.push).toEqual(["/compare?set=21&run=1"]);
    expect(screen.getByRole("status")).toHaveTextContent('Saved "Nightly check".');
  });

  it("leaves a set saved from untouched defaults unrun", async () => {
    setRoutes(saved(21, true));
    show({ asked: false });

    fireEvent.change(nameBox(), { target: { value: "Nightly check" } });
    fireEvent.click(saveButton());
    await flushAsync();

    expect(routerCalls.push).toEqual(["/compare?set=21"]);
  });

  it("reloads instead of pushing the URL it is already on", async () => {
    // Renaming the open set lands exactly where it started, and a push there
    // does nothing at all — the set list would keep the name it had before.
    // The query is written in the other order to show that is not what decides.
    setSearchParams("run=1&set=7");
    setRoutes(saved(7, false));
    const reloads: number[] = [];
    show({ activeSetId: 7, onDone: () => reloads.push(1) });

    fireEvent.change(nameBox(), { target: { value: "Nightly" } });
    fireEvent.click(saveButton());
    await flushAsync();

    expect(routerCalls.push).toEqual([]);
    expect(reloads).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent('Updated "Nightly".');
  });

  it("falls back to a router refresh when the screen fetches nothing of its own", async () => {
    setSearchParams("set=7&run=1");
    setRoutes(saved(7, false));
    show({ activeSetId: 7 });

    fireEvent.change(nameBox(), { target: { value: "Nightly" } });
    fireEvent.click(saveButton());
    await flushAsync();

    expect(routerCalls.refresh).toBe(1);
  });

  it("says what the server said when it refuses", async () => {
    setRoutes([
      {
        match: "/api/comparison-sets",
        method: "POST",
        status: 400,
        body: { ok: false, error: "A set can hold at most 6 targets." },
      },
    ]);
    show();

    fireEvent.change(nameBox(), { target: { value: "Nightly check" } });
    fireEvent.click(saveButton());
    await flushAsync();

    expect(screen.getByRole("alert")).toHaveTextContent("A set can hold at most 6 targets.");
    expect(routerCalls.push).toEqual([]);
  });

  it("says something when the network drops rather than looking saved", async () => {
    setRoutes([{ match: "/api/comparison-sets", method: "POST", networkError: true }]);
    show();

    fireEvent.change(nameBox(), { target: { value: "Nightly check" } });
    fireEvent.click(saveButton());
    await flushAsync();

    expect(screen.getByRole("alert")).toHaveTextContent("Network error while saving the set.");
  });
});

describe("a name that belongs to another set", () => {
  /** The 409 the endpoint answers a taken name with. */
  const conflictRoutes = () =>
    setRoutes([
      {
        match: "/api/comparison-sets",
        method: "POST",
        status: 409,
        body: { ok: false, conflict: true, error: "That name is taken." },
      },
    ]);

  /** The same, and then the plain 200 the confirmed retry gets. */
  const conflictThenSaved = () =>
    setRoutes([
      {
        match: "/api/comparison-sets",
        method: "POST",
        status: 409,
        body: () => {
          // Two different answers from one URL and method, so the route for
          // the retry is put in place as the first answer is handed over.
          setRoutes([
            {
              match: "/api/comparison-sets",
              method: "POST",
              body: { ok: true, created: false, set: { id: 30, name: "Nightly check" } },
            },
          ]);
          return { ok: false, conflict: true, error: "That name is taken." };
        },
      },
    ]);

  it("asks before replacing it", async () => {
    conflictRoutes();
    show();

    confirmAnswer = false;
    fireEvent.change(nameBox(), { target: { value: "Nightly check" } });
    fireEvent.click(saveButton());
    await flushAsync();

    expect(asked).toEqual([
      'A saved set called "Nightly check" already exists. Replace it with the comparison on screen?',
    ]);
  });

  it("leaves both sets alone when the answer is no", async () => {
    conflictRoutes();
    show();

    confirmAnswer = false;
    fireEvent.change(nameBox(), { target: { value: "Nightly check" } });
    fireEvent.click(saveButton());
    await flushAsync();

    expect(posts()).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Not saved — pick a different name, or confirm to replace it."
    );
    expect(routerCalls.push).toEqual([]);
  });

  it("sends the replacement only once the answer is yes", async () => {
    conflictThenSaved();
    show();

    fireEvent.change(nameBox(), { target: { value: "Nightly check" } });
    fireEvent.click(saveButton());
    await flushAsync();

    expect(posts()).toHaveLength(2);
    expect(sent(0).overwrite).toBe(false);
    expect(sent(1).overwrite).toBe(true);
    expect(routerCalls.push).toEqual(["/compare?set=30&run=1"]);
  });

  it("does not ask when the refusal was about something else", async () => {
    setRoutes([
      {
        match: "/api/comparison-sets",
        method: "POST",
        status: 409,
        body: { ok: false, error: "Someone else saved over it." },
      },
    ]);
    show();

    fireEvent.change(nameBox(), { target: { value: "Nightly check" } });
    fireEvent.click(saveButton());
    await flushAsync();

    expect(asked).toEqual([]);
    expect(screen.getByRole("alert")).toHaveTextContent("Someone else saved over it.");
  });
});

describe("deleting", () => {
  const deleted = (body: unknown = { ok: true }, status = 200) =>
    setRoutes([{ match: "/api/comparison-sets", method: "DELETE", status, body }]);

  it("is offered only on a set that is open", () => {
    show();

    expect(screen.queryByRole("button", { name: /^Delete the set/ })).not.toBeInTheDocument();
  });

  it("is not offered to a viewer", () => {
    setUser("viewer");
    show({ activeSetId: 7 });

    expect(screen.queryByRole("button", { name: /^Delete the set/ })).not.toBeInTheDocument();
  });

  it("says what stays behind before it asks", () => {
    deleted();
    show({ activeSetId: 7 });

    confirmAnswer = false;
    fireEvent.click(deleteButton());

    expect(asked).toEqual([
      'Delete the saved set "Nightly check"? The comparison on screen stays; only the saved set is removed.',
    ]);
    expect(fetchCalls).toHaveLength(0);
  });

  it("keeps the comparison on screen by spelling it out in the URL", async () => {
    // The bookmark is gone; what it described is still what the reader is
    // looking at, so the next URL says it in full.
    deleted();
    show({ activeSetId: 7 });

    fireEvent.click(deleteButton());
    await flushAsync();

    expect(fetchCalls[0].method).toBe("DELETE");
    expect(JSON.parse(fetchCalls[0].body ?? "{}")).toEqual({ id: 7 });
    expect(routerCalls.push).toEqual([`/compare?${SELECTION_QUERY}&run=1`]);
  });

  it("does not re-run a comparison that was never run", async () => {
    deleted();
    show({ activeSetId: 7, asked: false });

    fireEvent.click(deleteButton());
    await flushAsync();

    expect(routerCalls.push).toEqual([`/compare?${SELECTION_QUERY}`]);
  });

  it("says what the server said when it refuses", async () => {
    deleted({ ok: false, error: "That set is already gone." }, 404);
    show({ activeSetId: 7 });

    fireEvent.click(deleteButton());
    await flushAsync();

    expect(screen.getByRole("alert")).toHaveTextContent("That set is already gone.");
    expect(routerCalls.push).toEqual([]);
  });

  it("says something when the network drops", async () => {
    setRoutes([{ match: "/api/comparison-sets", method: "DELETE", networkError: true }]);
    show({ activeSetId: 7 });

    fireEvent.click(deleteButton());
    await flushAsync();

    expect(screen.getByRole("alert")).toHaveTextContent("Network error while deleting the set.");
  });
});

describe("the confirmation that outlives its own bar", () => {
  it("reaches the bar the navigation lands on", async () => {
    // Compare remounts on every new URL, so a message kept in this bar's state
    // went with the bar before anyone read it: Save worked and said nothing.
    setRoutes(saved(21, true));
    show();

    fireEvent.change(nameBox(), { target: { value: "Nightly check" } });
    fireEvent.click(saveButton());
    await flushAsync();

    cleanup();
    show({ activeSetId: 21, sets: [set({ id: 21 })] });

    expect(screen.getByRole("status")).toHaveTextContent('Saved "Nightly check".');
  });

  it("is not read out by a bar that opened on something else", async () => {
    setRoutes(saved(21, true));
    show();

    fireEvent.change(nameBox(), { target: { value: "Nightly check" } });
    fireEvent.click(saveButton());
    await flushAsync();

    cleanup();
    show({ activeSetId: 7 });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("is read out once and not by the bar after that", async () => {
    setRoutes(saved(21, true));
    show();

    fireEvent.change(nameBox(), { target: { value: "Nightly check" } });
    fireEvent.click(saveButton());
    await flushAsync();

    cleanup();
    show({ activeSetId: 21, sets: [set({ id: 21 })] });
    cleanup();
    show({ activeSetId: 21, sets: [set({ id: 21 })] });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("stops describing the screen once the comparison is changed again", async () => {
    setRoutes(saved(21, true));
    show();

    fireEvent.change(nameBox(), { target: { value: "Nightly check" } });
    fireEvent.click(saveButton());
    await flushAsync();

    cleanup();
    show({ activeSetId: 21, sets: [set({ id: 21 })], modified: true });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("the one sentence under the bar", () => {
  it("puts a deleted connection ahead of everything else", () => {
    show({
      activeSetId: 7,
      sets: [set({ hasMissingConnection: true })],
      modified: true,
      hasUnappliedChanges: true,
    });

    expect(
      screen.getByText(
        "A connection this set used has been deleted. Pick a replacement below, press Compare, then Update the set."
      )
    ).toBeInTheDocument();
  });

  it("does not tell a viewer to fix it", () => {
    setUser("viewer");
    show({ activeSetId: 7, sets: [set({ hasMissingConnection: true })] });

    expect(
      screen.getByText(
        "A connection this set used has been deleted. An editor can pick a replacement and update the set."
      )
    ).toBeInTheDocument();
  });

  it("puts an error ahead of even that", () => {
    show({ activeSetId: 7, sets: [set({ hasMissingConnection: true })] });

    fireEvent.change(nameBox(), { target: { value: "  " } });
    fireEvent.click(saveButton());

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Give the set a name so you can find it again."
    );
    expect(screen.queryByText(/A connection this set used/)).not.toBeInTheDocument();
  });

  it("offers a viewer the way back, not an Update they cannot press", () => {
    setUser("viewer");
    show({ activeSetId: 7, modified: true });

    expect(
      screen.getByText("Changed since it was saved — reopen the set to go back.")
    ).toBeInTheDocument();
  });

  it("offers an editor both ways out of a change", () => {
    show({ activeSetId: 7, modified: true });

    expect(
      screen.getByText(
        "Changed since it was saved — press Update to keep it, or reopen the set to go back."
      )
    ).toBeInTheDocument();
  });

  it("says nothing about roles while the session is still being read", () => {
    // The frame before next-auth answers is not a viewer, and saying so would
    // flash "only editors can" at an editor on every page load.
    require("./helpers/render-page").setSessionLoading();
    show();

    expect(
      screen.queryByText("Only editors can save or delete comparison sets.")
    ).not.toBeInTheDocument();
  });
});
