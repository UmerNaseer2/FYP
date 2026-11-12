/** @jest-environment jsdom */

/**
 * The warning shown in front of SQL: a breaking change, rows that will be
 * deleted, drift on the target.
 *
 * The box only tells. It has no tick box and it disables nothing: whether the
 * person may run is decided by their role, and by an approval when their role
 * does not allow it. Deploy and Version Sync both draw it, so it is tested
 * here once.
 */

import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";

import { RiskGate } from "@/components/studio/RiskGate";

afterEach(() => cleanup());

describe("the risk warning", () => {
  it("shows the title and the body", () => {
    render(
      <RiskGate
        tone="break"
        title="2 breaking changes"
        body="These drop or rewrite structure that other things may depend on."
      />
    );

    expect(screen.getByText("2 breaking changes")).toBeInTheDocument();
    expect(
      screen.getByText("These drop or rewrite structure that other things may depend on.")
    ).toBeInTheDocument();
  });

  it("never asks for a tick", () => {
    render(
      <RiskGate tone="drift" title="The target has drifted" body="Someone changed this database outside the tool.">
        <ul>
          <li>DROP TABLE invoices</li>
        </ul>
      </RiskGate>
    );

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("puts the detail under the body", () => {
    const { container } = render(
      <RiskGate tone="break" title="Data loss" body="These statements destroy rows.">
        <ul>
          <li>DROP TABLE invoices</li>
        </ul>
      </RiskGate>
    );

    const panel = container.firstElementChild as HTMLElement;
    const order = Array.from(panel.children).map((el) => el.tagName.toLowerCase());
    expect(order).toEqual(["div", "p", "ul"]);
  });

  it("separates the amber risk from the red one", () => {
    // The tone is the only thing the component itself decides, and a drift
    // warning drawn in the colour of a destructive change reads as one.
    const { container, rerender } = render(<RiskGate tone="drift" title="Drift" body="..." />);
    expect(container.firstElementChild).toHaveClass("prod-gate--drift");

    rerender(<RiskGate tone="break" title="Breaking" body="..." />);
    expect(container.firstElementChild).not.toHaveClass("prod-gate--drift");
  });
});
