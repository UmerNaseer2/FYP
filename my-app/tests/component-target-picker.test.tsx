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
  it("lists the connections and the schemas, and says whose schemas are listed", () => {
    show();
    fireEvent.click(changeButton());

    expect(within(list("Connections")).getAllByRole("button")).toHaveLength(2);
    expect(within(list("Schemas")).getAllByRole("button")).toHaveLength(2);
    expect(
      within(panel()).getByText("Only schemas your role can read are listed.")
    ).toBeInTheDocument();
  });

  it("hands back the schema that was picked, and closes", () => {
    show();
    fireEvent.click(changeButton());
    fireEvent.click(within(list("Schemas")).getByRole("button", { name: "public" }));

    expect(changes).toEqual([{ connectionId: "1", schema: "public" }]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(changeButton()).toHaveFocus();
  });

  it("hands back a new connection with no schema, and stays open for the schema", () => {
    show();
    fireEvent.click(changeButton());
    fireEvent.click(within(list("Connections")).getByRole("button", { name: /^Warehouse/ }));

    // The old connection's schema means nothing on the new one.
    expect(changes).toEqual([{ connectionId: "2", schema: "" }]);
    expect(panel()).toBeInTheDocument();
  });

  it("narrows both lists as the search box is typed in", () => {
    show();
    fireEvent.click(changeButton());
    fireEvent.change(screen.getByLabelText("Search connections and schemas"), {
      target: { value: "shop_d" },
    });

    expect(
      within(list("Schemas"))
        .getAllByRole("button")
        .map((row) => row.textContent)
    ).toEqual(["shop_dev"]);
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
    fireEvent.keyDown(screen.getByLabelText("Search connections and schemas"), { key: "Escape" });

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
