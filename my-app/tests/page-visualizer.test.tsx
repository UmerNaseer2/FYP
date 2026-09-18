/** @jest-environment jsdom */

/**
 * The Visualizer page shell: the two panes, the divider between them, and what
 * the screen says when there is nothing to draw.
 *
 * The diagram itself is not below. It is a React Flow canvas, code-split and
 * loaded only once a schema has been read, and it measures a viewport jsdom
 * does not have — so a test that reached it would be testing a canvas of zero
 * by zero pixels. Everything around it is ordinary DOM and is tested here: the
 * two empty states that must not be confused with each other, the mode toggle,
 * and the divider, which was mouse-only until it was given a keyboard.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import VisualizerPage from "@/app/(studio)/visualizer/page";
import { resetPageState, setRoutes } from "./helpers/render-page";

const CONNECTIONS = [
  { id: 1, name: "Local Postgres", host: "localhost", database_name: "shop" },
  { id: 2, name: "Warehouse", host: "dw.internal", database_name: "dw" },
];

/** How many panes are on screen: each one owns its own connection picker. */
const paneCount = () => screen.getAllByRole("combobox", { name: "Connection" }).length;

/**
 * Wait for a pane to have its pickers.
 *
 * The page draws its header and the mode toggle before the connections have
 * been read — only the panes wait — so waiting on the toggle would leave the
 * panes as skeletons and count none of them.
 */
const firstPane = () => screen.findByRole("combobox", { name: "Connection" });

const divider = () => screen.getByRole("separator", { name: "Resize panes" });

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("the visualizer with nothing to draw", () => {
  it("does not turn a failed read into 'you have no connections'", async () => {
    // The two states look alike and lead opposite ways. "Add a connection
    // first" points at a page that would not be able to save one either, and
    // tells a reader with a full list that their connections are gone.
    setRoutes([{ match: "/api/connections", status: 500, body: { error: "db down" } }]);
    render(<VisualizerPage />);

    expect(await screen.findByText("Could not load your connections")).toBeInTheDocument();
    expect(screen.queryByText("Add a connection first")).not.toBeInTheDocument();
  });

  it("sends a reader with no connections to the page that makes one", async () => {
    setRoutes([{ match: "/api/connections", body: [] }]);
    render(<VisualizerPage />);

    expect(await screen.findByText("Add a connection first")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to Connections/ })).toHaveAttribute(
      "href",
      "/connections"
    );
    // Nothing to view, so neither the mode toggle nor the way onward is offered.
    expect(screen.queryByRole("group", { name: "View mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Compare them properly/ })).not.toBeInTheDocument();
  });
});

describe("the visualizer with connections", () => {
  beforeEach(() => {
    setRoutes([
      { match: "/api/connections", body: CONNECTIONS },
      { match: "/api/scripts/schemas", body: { schemas: ["public"] } },
    ]);
  });

  it("opens on one pane and splits into two", async () => {
    render(<VisualizerPage />);
    await firstPane();
    expect(paneCount()).toBe(1);
    expect(screen.getByRole("button", { name: /Single/ })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: /Side by side/ }));
    expect(paneCount()).toBe(2);
    expect(screen.getByRole("button", { name: /Side by side/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("offers a way onward from a screen that otherwise only draws", async () => {
    render(<VisualizerPage />);
    expect(await screen.findByRole("link", { name: /Compare them properly/ })).toHaveAttribute(
      "href",
      "/compare"
    );
  });

  it("lets the split be moved from the keyboard", async () => {
    // The divider had pointer handlers and no tabIndex, which reads to a screen
    // reader as decoration and cannot be operated without a mouse at all.
    render(<VisualizerPage />);
    await firstPane();
    fireEvent.click(screen.getByRole("button", { name: /Side by side/ }));

    expect(divider()).toHaveAttribute("aria-valuenow", "50");
    fireEvent.keyDown(divider(), { key: "ArrowRight" });
    expect(divider()).toHaveAttribute("aria-valuenow", "52");
    fireEvent.keyDown(divider(), { key: "ArrowLeft" });
    expect(divider()).toHaveAttribute("aria-valuenow", "50");

    // The ends are clamped, so holding a key cannot push a pane to nothing.
    fireEvent.keyDown(divider(), { key: "Home" });
    expect(divider()).toHaveAttribute("aria-valuenow", "26");
    fireEvent.keyDown(divider(), { key: "End" });
    expect(divider()).toHaveAttribute("aria-valuenow", "74");
    fireEvent.keyDown(divider(), { key: "Enter" });
    expect(divider()).toHaveAttribute("aria-valuenow", "50");
  });

  it("drops the split on a narrow screen but keeps the way out", async () => {
    // matchMedia is stubbed for every suite as "nothing matches", which is the
    // desktop answer. This one test needs the other answer, so it says so here
    // rather than changing what every other suite sees.
    const real = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        media: query,
        matches: query.includes("768px"),
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList) as typeof window.matchMedia;
    try {
      render(<VisualizerPage />);
      // Two diagrams and a draggable divider do not fit on a phone.
      await firstPane();
      expect(screen.getByRole("link", { name: /Compare them properly/ })).toBeInTheDocument();
      expect(screen.queryByRole("group", { name: "View mode" })).not.toBeInTheDocument();
      expect(paneCount()).toBe(1);
      // And the reason the link sits outside that guard: the reader with the
      // least room to compare two diagrams by eye is the one who most needs
      // the screen that compares them properly.
    } finally {
      window.matchMedia = real;
    }
  });
});
