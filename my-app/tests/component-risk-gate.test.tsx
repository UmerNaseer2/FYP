/** @jest-environment jsdom */

/**
 * The stops that stand in front of SQL: the production gate, and the general
 * one for breaking changes, data loss and drift.
 *
 * Neither of these blocks anything by itself — they hand a boolean back up and
 * the screen above decides what to disable. What they own is the sentence the
 * reader ticks, and one rule that is easy to lose: a gate is only offered a
 * checkbox when there is a decision behind it. A tick box over a fact nobody
 * can change is a toll, not a decision, and every toll makes the boxes that ARE
 * decisions cheaper to tick without reading. So the tests below are mostly
 * about what is absent.
 *
 * Tested at the component rather than through a screen: Deploy and Version Sync
 * both render these, and the point is that both get the same words and the same
 * stops wherever they are rendered.
 *
 * What is NOT here:
 *  - Which gate appears when, and what each acknowledgement then unlocks. That
 *    is the screen's, and tests/page-deploy.test.tsx drives the real gates from
 *    a drifted target and a production one through to the request the run
 *    sends.
 *  - That the tick is cleared when the target, schema, family or version range
 *    changes. Nothing here holds the tick — `acknowledged` is a prop — so the
 *    clearing lives in the page that owns the state.
 *  - What the server does with the acknowledgements once they are sent, which
 *    tests/deploy-safety.test.ts and tests/apply-risk.test.ts cover.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ProductionGate, RiskGate } from "@/components/studio/RiskGate";

afterEach(() => cleanup());

const box = () => screen.getByRole("checkbox");

describe("the production gate", () => {
  it("says what a rollback cannot bring back, in the words of the action", () => {
    render(
      <ProductionGate what="run 3 migrations" acknowledged={false} onAcknowledge={() => {}} />
    );

    expect(screen.getByText("Production target")).toBeInTheDocument();
    // The one thing a reader most often assumes is untrue: that a rollback is
    // an undo. It restores structure; the rows are gone.
    expect(
      screen.getByText(/a rollback restores structure, not rows/)
    ).toBeInTheDocument();
    expect(
      screen.getByText("I understand, and I mean to run 3 migrations against production.")
    ).toBeInTheDocument();
  });

  it("does not offer a rollback as the way back from a rollback", () => {
    // The deploy copy points at a rollback as the recovery. A rollback cannot
    // point at itself, so its copy has to say what it will not restore instead
    // of naming a way out that does not exist.
    render(
      <ProductionGate
        kind="rollback"
        what="undo 2 versions"
        acknowledged={false}
        onAcknowledge={() => {}}
      />
    );

    const body = screen.getByText(/rows it drops are gone/);
    expect(body).toHaveTextContent("rows the original migration deleted do not come back");
    expect(body).toHaveTextContent("If you need them, you need a backup.");
    expect(screen.queryByText(/is not something a rollback brings back/)).not.toBeInTheDocument();
  });

  it("reports both directions of the tick", () => {
    const ticks: boolean[] = [];
    const { rerender } = render(
      <ProductionGate what="run 1 migration" acknowledged={false} onAcknowledge={(v) => ticks.push(v)} />
    );

    fireEvent.click(box());
    expect(ticks).toEqual([true]);

    // Untick matters as much: a reader who changes their mind has to be able to
    // put the stop back, and a gate that only ever reported `true` would leave
    // the run armed after they did.
    rerender(
      <ProductionGate what="run 1 migration" acknowledged onAcknowledge={(v) => ticks.push(v)} />
    );
    fireEvent.click(box());
    expect(ticks).toEqual([true, false]);
  });

  it("shows the tick the page is holding, not one of its own", () => {
    // The page clears this whenever the target or the version range changes. A
    // checkbox with its own state would keep looking ticked across that change,
    // which is exactly the carry-over — dev run ticked, prod run armed — the
    // clearing exists to prevent.
    const { rerender } = render(
      <ProductionGate what="run 1 migration" acknowledged onAcknowledge={() => {}} />
    );
    expect(box()).toBeChecked();

    rerender(<ProductionGate what="run 1 migration" acknowledged={false} onAcknowledge={() => {}} />);
    expect(box()).not.toBeChecked();
  });
});

describe("the general risk gate", () => {
  it("offers a tick when there is a decision behind it", () => {
    const ticks: boolean[] = [];
    render(
      <RiskGate
        tone="break"
        title="2 breaking changes"
        body="These drop or rewrite structure that other things may depend on."
        ack="I have read the breaking changes and mean to run them."
        acknowledged={false}
        onAcknowledge={(v) => ticks.push(v)}
      />
    );

    expect(screen.getByText("2 breaking changes")).toBeInTheDocument();
    fireEvent.click(box());
    expect(ticks).toEqual([true]);
  });

  it("drops the tick when the panel only states a fact", () => {
    // The whole reason `ack` is optional. A panel that says something true
    // about the run which the reader cannot act on is information, and asking
    // them to confirm it teaches them to tick without reading.
    render(
      <RiskGate
        tone="drift"
        title="The target has drifted"
        body="Someone changed this database outside the tool."
      />
    );

    expect(screen.getByText("The target has drifted")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("does not fall over when a tick is offered with nothing listening", () => {
    // `onAcknowledge` is optional beside an optional `ack`, so the pair can be
    // half-given. Throwing here would take the whole screen down over a panel
    // that is only meant to be read.
    render(<RiskGate tone="break" title="Data loss" body="A column goes." ack="I understand." />);

    expect(() => fireEvent.click(box())).not.toThrow();
    expect(box()).not.toBeChecked();
  });

  it("puts the detail above the tick, not after it", () => {
    // The children are the list the reader is being asked to confirm — the
    // tables that get dropped, the rows that go. Below the checkbox they are
    // something to scroll past after deciding.
    const { container } = render(
      <RiskGate
        tone="break"
        title="Data loss"
        body="These statements destroy rows."
        ack="I understand, and I mean to run them."
        onAcknowledge={() => {}}
      >
        <ul>
          <li>DROP TABLE invoices</li>
        </ul>
      </RiskGate>
    );

    const panel = container.firstElementChild as HTMLElement;
    const order = Array.from(panel.children).map((el) => el.tagName.toLowerCase());
    expect(order).toEqual(["div", "p", "ul", "label"]);
  });

  it("separates the amber risk from the red one", () => {
    // Every word in this panel arrives as a prop, so the tone is the only thing
    // the component itself decides — and a drift warning drawn in the colour of
    // a destructive change reads as one.
    const { container, rerender } = render(<RiskGate tone="drift" title="Drift" body="…" />);
    expect(container.firstElementChild).toHaveClass("prod-gate--drift");

    rerender(<RiskGate tone="break" title="Breaking" body="…" />);
    expect(container.firstElementChild).not.toHaveClass("prod-gate--drift");
  });
});
