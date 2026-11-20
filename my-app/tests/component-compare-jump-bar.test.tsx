/** @jest-environment jsdom */

/**
 * The bar over a Compare result: Summary, Map, Tables and Script.
 *
 * A tester found the migration panel easy to miss and a result long to scroll
 * through. The bar is the answer to both, so these check what it promises: it
 * names every part with its count, it marks the part on screen, and a press
 * takes the reader there with focus on the part's own heading.
 *
 * jsdom has no layout, so each test says where things are on screen by giving
 * getBoundingClientRect a top for each element.
 */

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CompareJumpBar } from "@/components/studio/CompareJumpBar";

/** The parts of one result, laid out the way the Compare page lays them out. */
function Result({ map = true, statements = 7 }: { map?: boolean; statements?: number }) {
  return (
    <section className="cp-outcome">
      <CompareJumpBar label="Parts of this result" tables={3} statements={statements} />
      <div className="cp-counts">tiles</div>
      {map && (
        <section className="cp-map" aria-labelledby="map-title">
          <h3 id="map-title">Map of changes</h3>
        </section>
      )}
      <div className="cp-grid">
        <div className="cp-col">
          <div data-jump="tables">
            <div>
              <span className="section-title">Changes to the target</span>
            </div>
          </div>
        </div>
        <aside>
          <div className="sticky-panel">
            <div className="card">
              <span className="section-title">Generated migration</span>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

/** Put each element matching a selector at a top on screen. Anything else is at 0. */
function layout(tops: Record<string, number>) {
  jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const match = Object.keys(tops).find((selector) => this.matches(selector));
    const top = match ? tops[match] : 0;
    const height = this.matches(".cp-jump") ? 48 : 300;
    return {
      top,
      bottom: top + height,
      left: 0,
      right: 800,
      width: 800,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

/** Scroll the page, and wait for the frame the bar reads the page in. */
async function scrollTo(tops: Record<string, number>) {
  jest.restoreAllMocks();
  layout(tops);
  await act(async () => {
    window.dispatchEvent(new Event("scroll"));
    await new Promise((done) => requestAnimationFrame(() => done(null)));
  });
}

/** The page before any scrolling: the result's head at the top, the bar under it. */
const AT_REST = {
  ".cp-outcome": 100,
  ".cp-jump": 160,
  ".cp-counts": 220,
  ".cp-map": 420,
  ".cp-grid": 900,
  ".cp-col": 900,
  "aside": 900,
};

const bar = () => screen.getByRole("navigation", { name: "Parts of this result" });
const button = (name: string | RegExp) => screen.getByRole("button", { name });

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe("the bar over a Compare result", () => {
  it("names every part, with the number of tables and statements", () => {
    layout(AT_REST);
    render(<Result />);
    expect(bar()).toBeInTheDocument();
    expect(button("Summary")).toBeInTheDocument();
    expect(button("Map")).toBeInTheDocument();
    expect(button("Tables 3 with changes")).toBeInTheDocument();
    expect(button("Script 7 statements")).toBeInTheDocument();
  });

  it("says statement, not statements, for one", () => {
    layout(AT_REST);
    render(<Result statements={1} />);
    expect(button("Script 1 statement")).toBeInTheDocument();
  });

  it("leaves out a part the result does not have", () => {
    layout(AT_REST);
    render(<Result map={false} />);
    expect(screen.queryByRole("button", { name: "Map" })).not.toBeInTheDocument();
    expect(button("Summary")).toBeInTheDocument();
  });

  it("marks Summary at rest and is not stuck yet", () => {
    layout(AT_REST);
    render(<Result />);
    expect(button("Summary")).toHaveAttribute("aria-current", "location");
    expect(button("Map")).not.toHaveAttribute("aria-current");
    expect(bar()).not.toHaveAttribute("data-stuck");
  });

  it("follows the page down and sticks once the result's top has gone by", async () => {
    layout(AT_REST);
    render(<Result />);
    await scrollTo({
      ".cp-outcome": -700,
      ".cp-jump": 10,
      ".cp-counts": -640,
      ".cp-map": -440,
      ".cp-grid": 40,
      ".cp-col": 40,
      "aside": 40,
    });
    expect(button("Tables 3 with changes")).toHaveAttribute("aria-current", "location");
    expect(button("Summary")).not.toHaveAttribute("aria-current");
    // Beside the list, the script never takes a turn: it is on screen anyway.
    expect(button("Script 7 statements")).not.toHaveAttribute("aria-current");
    expect(bar()).toHaveAttribute("data-stuck");
  });

  it("marks Script once the panel under the list reaches the top", async () => {
    layout(AT_REST);
    render(<Result />);
    await scrollTo({
      ".cp-outcome": -2400,
      ".cp-jump": 10,
      ".cp-counts": -2340,
      ".cp-map": -2140,
      ".cp-grid": -1700,
      ".cp-col": -1700,
      "aside": 30,
    });
    expect(button("Script 7 statements")).toHaveAttribute("aria-current", "location");
    expect(button("Tables 3 with changes")).not.toHaveAttribute("aria-current");
  });

  it("takes the reader to the migration panel: it rings and its heading gets focus", () => {
    layout(AT_REST);
    const { container } = render(<Result />);
    fireEvent.click(button("Script 7 statements"));
    const card = container.querySelector("aside .card");
    expect(card).toHaveClass("card-flash");
    const heading = screen.getByText("Generated migration");
    expect(heading).toHaveFocus();
    // Focusable for the jump, but never a stop on the Tab key.
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(button("Script 7 statements")).toHaveAttribute("aria-current", "location");
  });

  it("keeps Script lit beside the list after a press, until the reader scrolls on", async () => {
    layout(AT_REST);
    render(<Result />);
    fireEvent.click(button("Script 7 statements"));
    // The page scrolls to the list, with the panel beside it, and goes still.
    await scrollTo({
      ".cp-outcome": -700,
      ".cp-jump": 10,
      ".cp-counts": -640,
      ".cp-map": -440,
      ".cp-grid": 40,
      ".cp-col": 40,
      "aside": 40,
    });
    await act(async () => {
      await new Promise((done) => setTimeout(done, 200));
    });
    expect(button("Script 7 statements")).toHaveAttribute("aria-current", "location");
    // Back up to the map, and the bar follows the page again.
    await scrollTo({
      ".cp-outcome": -300,
      ".cp-jump": 10,
      ".cp-counts": -240,
      ".cp-map": 40,
      ".cp-grid": 520,
      ".cp-col": 520,
      "aside": 520,
    });
    expect(button("Map")).toHaveAttribute("aria-current", "location");
    expect(button("Script 7 statements")).not.toHaveAttribute("aria-current");
  });

  it("puts focus on the map's own heading and the list's title", () => {
    layout(AT_REST);
    render(<Result />);
    fireEvent.click(button("Map"));
    expect(screen.getByRole("heading", { name: "Map of changes" })).toHaveFocus();
    expect(button("Map")).toHaveAttribute("aria-current", "location");
    fireEvent.click(button("Tables 3 with changes"));
    expect(screen.getByText("Changes to the target")).toHaveFocus();
  });
});
