/**
 * @jest-environment jsdom
 *
 * TargetPicker, the one way every page picks a connection and then a schema.
 *
 * These tests walk its five states (empty, loading, chosen, no schemas, can't
 * connect), the panel that Change opens, and the one error line two pickers
 * share when they sit side by side.
 */
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import {
  TargetPicker,
  TargetPickerPair,
  type TargetChoice,
  type TargetPickerProps,
} from "@/components/studio/TargetPicker";

const CONNECTIONS = [
  { id: 1, name: "Local Postgres", detail: "shop" },
  { id: 2, name: "Warehouse", detail: "warehouse" },
];

/** Every choice the picker handed back, oldest first. */
let changes: TargetChoice[] = [];

function show(over: Partial<TargetPickerProps> = {}) {
  return render(
    <TargetPicker
      label="Target"
      connections={CONNECTIONS}
      connectionId="1"
      schema="shop_dev"
      schemas={["public", "shop_dev"]}
      onChange={(next) => changes.push(next)}
      {...over}
    />
  );
}

const changeButton = () =>
  screen.getByRole("button", { name: "Change target connection and schema" });
const panel = () => screen.getByRole("dialog", { name: "Choose target connection and schema" });
const list = (name: "Connections" | "Schemas") => within(panel()).getByRole("group", { name });

beforeEach(() => {
  changes = [];
});
afterEach(() => cleanup());

describe("what the field shows", () => {
  it("asks for a choice when nothing is chosen", () => {
    show({ connectionId: "", schema: "", schemas: [] });

    expect(
      screen.getByRole("button", { name: /Choose a connection and schema/ })
    ).toBeInTheDocument();
  });

  it("names the connection whose schemas are loading", () => {
    show({ loading: true, schemas: [] });

    expect(screen.getByRole("status")).toHaveTextContent("Loading schemas from Local Postgres…");
  });

  it("shows the connection and the schema once both are chosen", () => {
    show();

    const field = screen.getByRole("group", { name: /^Target/ });
    expect(field).toHaveTextContent("Local Postgres");
    expect(field).toHaveTextContent("shop_dev");
    expect(changeButton()).toHaveTextContent("Change");
  });

  it("says so in plain words when the connection has no schemas to show", () => {
    show({ schema: "", schemas: [] });

    expect(screen.getByRole("alert")).toHaveTextContent("No schemas to show");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("offers Try again when the connection cannot be reached", () => {
    let retried = 0;
    show({
      schemas: [],
      error: "connect ECONNREFUSED 127.0.0.1:5432",
      onRetry: () => retried++,
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Local Postgres can't be reached");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retried).toBe(1);
  });

  it("cannot be opened while it is disabled", () => {
    show({ disabled: true });

    expect(changeButton()).toBeDisabled();
  });
});

describe("the panel that Change opens", () => {
  const back = () => within(panel()).getByRole("button", { name: "Back to connections" });
  const rowNames = (name: "Connections" | "Schemas") =>
    within(list(name))
      .queryAllByRole("button")
      .map((row) => row.querySelector(".tp__name")?.textContent);

  it("opens on the chosen connection's schemas, and shows only them", () => {
    show();
    fireEvent.click(changeButton());

    // One step at a time: the connections are one press away, not on screen.
    expect(rowNames("Schemas")).toEqual(["public", "shop_dev"]);
    expect(within(panel()).queryByRole("group", { name: "Connections" })).toBeNull();
    expect(within(panel()).getByText("Local Postgres", { selector: "b" })).toBeInTheDocument();
    expect(
      within(panel()).getByText("Only schemas your role can read are listed.")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Search schemas")).toHaveFocus();
  });

  it("opens on the connections when nothing is chosen yet", () => {
    show({ connectionId: "", schema: "", schemas: [] });
    fireEvent.click(screen.getByRole("button", { name: /Choose a connection and schema/ }));

    expect(rowNames("Connections")).toEqual(["Local Postgres", "Warehouse"]);
    expect(within(panel()).queryByRole("group", { name: "Schemas" })).toBeNull();
    expect(within(panel()).queryByRole("button", { name: "Back to connections" })).toBeNull();
  });

  it("steps back to the connections, and into the same one again without a change", () => {
    show();
    fireEvent.click(changeButton());
    fireEvent.click(back());

    expect(rowNames("Connections")).toEqual(["Local Postgres", "Warehouse"]);
    expect(within(panel()).queryByRole("group", { name: "Schemas" })).toBeNull();
    expect(screen.getByLabelText("Search connections")).toHaveFocus();

    fireEvent.click(within(list("Connections")).getByRole("button", { name: /^Local Postgres/ }));
    expect(rowNames("Schemas")).toEqual(["public", "shop_dev"]);
    expect(changes).toEqual([]);
  });

  it("hands back the schema that was picked, and closes", () => {
    show();
    fireEvent.click(changeButton());
    fireEvent.click(within(list("Schemas")).getByRole("button", { name: "public" }));

    expect(changes).toEqual([{ connectionId: "1", schema: "public" }]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(changeButton()).toHaveFocus();
  });

  it("hands back a new connection with no schema, and moves on to its schemas", () => {
    show();
    fireEvent.click(changeButton());
    fireEvent.click(back());
    fireEvent.click(within(list("Connections")).getByRole("button", { name: /^Warehouse/ }));

    // The old connection's schema means nothing on the new one.
    expect(changes).toEqual([{ connectionId: "2", schema: "" }]);
    expect(panel()).toBeInTheDocument();
    expect(list("Schemas")).toBeInTheDocument();
  });

  it("stands in rows while a connection's schemas are on their way", () => {
    show({ loading: true, schemas: [], schema: "" });
    fireEvent.click(changeButton());

    expect(within(list("Schemas")).queryAllByRole("button")).toHaveLength(0);
    expect(within(list("Schemas")).getByRole("status")).toHaveTextContent(
      "Loading schemas from Local Postgres…"
    );
    expect(list("Schemas").querySelectorAll(".tp__skel")).toHaveLength(3);
  });

  it("searches only the step on screen", () => {
    show();
    fireEvent.click(changeButton());
    fireEvent.change(screen.getByLabelText("Search schemas"), { target: { value: "shop_d" } });
    expect(rowNames("Schemas")).toEqual(["shop_dev"]);

    // A new step starts with an empty search box.
    fireEvent.click(back());
    expect(screen.getByLabelText("Search connections")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Search connections"), { target: { value: "ware" } });
    expect(rowNames("Connections")).toEqual(["Warehouse"]);
  });

  it("takes the one row left when Enter is pressed in the search box", () => {
    show();
    fireEvent.click(changeButton());
    fireEvent.click(back());
    const search = screen.getByLabelText("Search connections");
    fireEvent.change(search, { target: { value: "ware" } });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(changes).toEqual([{ connectionId: "2", schema: "" }]);
    expect(list("Schemas")).toBeInTheDocument();
  });

  it("steps back on Backspace in an empty search box, and not while it has text", () => {
    show();
    fireEvent.click(changeButton());
    const search = screen.getByLabelText("Search schemas");
    fireEvent.change(search, { target: { value: "pub" } });
    fireEvent.keyDown(search, { key: "Backspace" });
    expect(list("Schemas")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "" } });
    fireEvent.keyDown(search, { key: "Backspace" });
    expect(list("Connections")).toBeInTheDocument();
  });

  it("walks the rows with the arrow keys and comes back up to the search box", () => {
    show();
    fireEvent.click(changeButton());
    const search = screen.getByLabelText("Search schemas");
    const [first, second] = within(list("Schemas")).getAllByRole("button");

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "ArrowUp" });
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(search).toHaveFocus();
  });

  it("shows a schema's status only when the page knows it", () => {
    show({ statuses: { shop_dev: "in_sync" } });
    fireEvent.click(changeButton());

    const rows = within(list("Schemas")).getAllByRole("button");
    expect(rows[0].querySelector(".st-chip")).toBeNull();
    expect(rows[1].querySelector(".st-chip")).not.toBeNull();
  });

  it("closes on Escape and puts the keyboard back on Change", () => {
    show();
    fireEvent.click(changeButton());
    fireEvent.keyDown(screen.getByLabelText("Search schemas"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(changeButton()).toHaveFocus();
    expect(changes).toEqual([]);
  });
});

describe("two pickers side by side", () => {
  it("share one error line under the pair", () => {
    render(
      <TargetPickerPair
        source={<span>source picker</span>}
        target={<span>target picker</span>}
        error="Source and target are the same schema. Pick a different target."
      />
    );

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Source and target are the same schema. Pick a different target."
    );
  });

  it("say nothing when there is nothing wrong", () => {
    render(
      <TargetPickerPair source={<span>source picker</span>} target={<span>target picker</span>} />
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
