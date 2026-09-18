/** @jest-environment jsdom */

/**
 * The centred overlay every "are you sure?" in this app is built on.
 *
 * A dialog is the one piece of chrome that can do real damage by being almost
 * right. `role="dialog" aria-modal="true"` tells a screen reader that the rest
 * of the page is unavailable — so if Tab then walks out of the panel, the user
 * is being moved around a page they have just been told is not there. And the
 * thing behind a confirm dialog is usually a drop, a re-baseline or a run
 * against production, so "the button did nothing" and "the button ran it
 * anyway" are both expensive.
 *
 * Both files here are that dialog: Modal is the shell, ConfirmDialog is the
 * confirm gate built on it, and the keyboard behaviour they borrow comes from
 * hooks/useDialogFocus.ts, which has no suite of its own and is exercised here
 * through the component that wires it.
 *
 * ONE THING IS STUBBED, and it is worth being plain about. The hook decides
 * what is reachable with `el.offsetParent !== null`, and jsdom does no layout,
 * so it reports null for everything — every control would look hidden and the
 * trap could not be tested at all. The block below gives offsetParent the three
 * rules a browser actually follows (null for display:none, null for a
 * fixed-position element, otherwise the parent) and puts the original back
 * afterwards. Everything the tests then assert is the hook's own arithmetic
 * over that.
 *
 * What is NOT here:
 *  - The drawer, the other overlay built on the same hook: it is
 *    tests/component-drawer.test.tsx, which covers what a drawer adds — the
 *    body scroll lock, the edge it slides from, and bare mode — and leans on
 *    this file for the trap the two share.
 *  - The screens that open these dialogs. The drift bar's re-baseline gate is
 *    tests/component-drift-resolution-bar.test.tsx, which clicks through the
 *    dialog to reach the request behind it and asserts nothing about the
 *    dialog itself; the studio and admin pages' dialogs are
 *    tests/page-studio.test.tsx and tests/page-admin.test.tsx.
 *  - That the panel is centred, dimmed, or above the page. Those are the
 *    classes and the z-index, and jsdom applies no stylesheet — the widths
 *    below are asserted because a width is an inline style the component
 *    computes, not one the sheet supplies.
 *  - The `|| el === document.activeElement` fallback is held to the case it
 *    exists for (a focused fixed-position control, which a real browser gives
 *    no offset parent) and no further.
 *  - ConfirmDialog no longer has an `acknowledge` prop. It was never passed:
 *    RiskGate, MigrationWorkbench and the Script Editor all write their own
 *    acknowledgement tick, because each of them gates an inline panel rather
 *    than a dialog. The last test below is what holds it gone.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { ConfirmDialog, Modal } from "@/components/ui";

// jsdom has no layout, so nothing has an offset parent. See the note above.
const realOffsetParent = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetParent"
);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.style.display === "none") return null;
      if (this.style.position === "fixed") return null;
      return this.parentElement;
    },
  });
});

afterAll(() => {
  if (realOffsetParent) {
    Object.defineProperty(HTMLElement.prototype, "offsetParent", realOffsetParent);
  }
});

afterEach(() => cleanup());

const panel = () => screen.getByRole("dialog");
/** The dim sheet behind the card — the portal's first child, the card its second. */
const scrim = () => panel().parentElement?.firstElementChild as HTMLElement;
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const focused = () => document.activeElement;

describe("a modal nobody has opened", () => {
  test("renders nothing at all", () => {
    render(
      <Modal open={false} onClose={() => {}} label="Stop tracking shop_dev">
        <button>Stop tracking</button>
      </Modal>
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop tracking" })).not.toBeInTheDocument();
  });

  test("stops listening for Escape once it has been closed", () => {
    const onClose = jest.fn();
    const { rerender } = render(
      <Modal open onClose={onClose} label="Stop tracking shop_dev">
        <button>Stop tracking</button>
      </Modal>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <Modal open={false} onClose={onClose} label="Stop tracking shop_dev">
        <button>Stop tracking</button>
      </Modal>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("stops listening once it has been taken off the page", () => {
    const onClose = jest.fn();
    const { unmount } = render(
      <Modal open onClose={onClose} label="Stop tracking shop_dev">
        <button>Stop tracking</button>
      </Modal>
    );
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("the panel", () => {
  test("is portaled to the body, not left inside whatever rendered it", () => {
    const { container } = render(
      <Modal open onClose={() => {}} label="Stop tracking shop_dev">
        <p>Really?</p>
      </Modal>
    );
    // A dialog rendered in place inherits its opener's stacking context and
    // overflow, which is how a "modal" ends up clipped inside a scrolling card.
    expect(container).not.toContainElement(panel());
    expect(document.body).toContainElement(panel());
  });

  test("tells a screen reader what it is and that the page behind is out of play", () => {
    render(
      <Modal open onClose={() => {}} label="Stop tracking shop_dev">
        <p>Really?</p>
      </Modal>
    );
    expect(panel()).toHaveAttribute("aria-modal", "true");
    expect(panel()).toHaveAttribute("aria-label", "Stop tracking shop_dev");
  });

  test("points at the caller's own heading instead when it has one", () => {
    render(
      <Modal open onClose={() => {}} label="ignored" labelledBy="own-title">
        <h4 id="own-title">Stop tracking shop_dev</h4>
      </Modal>
    );
    // Both at once would leave two names for one dialog, and aria-label wins in
    // the browser — so the heading the reader can see would be the one dropped.
    expect(panel()).toHaveAttribute("aria-labelledby", "own-title");
    expect(panel()).not.toHaveAttribute("aria-label");
  });

  test("is 380px wide unless the caller says otherwise", () => {
    render(
      <Modal open onClose={() => {}} label="Stop tracking shop_dev">
        <p>Really?</p>
      </Modal>
    );
    expect(panel()).toHaveStyle({ maxWidth: "380px" });
  });

  test("takes a width as a number of pixels or as any CSS length", () => {
    const { rerender } = render(
      <Modal open onClose={() => {}} width={560} label="Stop tracking shop_dev">
        <p>Really?</p>
      </Modal>
    );
    expect(panel()).toHaveStyle({ maxWidth: "560px" });

    rerender(
      <Modal open onClose={() => {}} width="40rem" label="Stop tracking shop_dev">
        <p>Really?</p>
      </Modal>
    );
    expect(panel()).toHaveStyle({ maxWidth: "40rem" });
  });
});

describe("closing it", () => {
  test("Escape closes it", () => {
    const onClose = jest.fn();
    render(
      <Modal open onClose={onClose} label="Stop tracking shop_dev">
        <button>Stop tracking</button>
      </Modal>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("any other key is left to the page", () => {
    const onClose = jest.fn();
    render(
      <Modal open onClose={onClose} label="Stop tracking shop_dev">
        <button>Stop tracking</button>
      </Modal>
    );
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: "Esc" });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("clicking the dimmed sheet behind the card closes it", () => {
    const onClose = jest.fn();
    render(
      <Modal open onClose={onClose} label="Stop tracking shop_dev">
        <button>Stop tracking</button>
      </Modal>
    );
    fireEvent.click(scrim());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking inside the card does not", () => {
    const onClose = jest.fn();
    render(
      <Modal open onClose={onClose} label="Stop tracking shop_dev">
        <button>Stop tracking</button>
      </Modal>
    );
    // The sheet is a sibling of the card rather than its parent, which is the
    // whole reason this works: one onClick on a wrapper around both would shut
    // the dialog on every click the person made inside it.
    fireEvent.click(button("Stop tracking"));
    fireEvent.click(panel());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("the keyboard, while it is open", () => {
  test("puts focus on the first control in the panel", () => {
    render(
      <Modal open onClose={() => {}} label="Stop tracking shop_dev">
        <p>Really?</p>
        <button>Cancel</button>
        <button>Stop tracking</button>
      </Modal>
    );
    expect(focused()).toBe(button("Cancel"));
  });

  test("steps over a control that is disabled", () => {
    render(
      <Modal open onClose={() => {}} label="Stop tracking shop_dev">
        <button disabled>Not yet</button>
        <button>Cancel</button>
      </Modal>
    );
    // Landing on a disabled button strands the keyboard user: it cannot be
    // activated and Tab has already been spent getting there.
    expect(focused()).toBe(button("Cancel"));
  });

  test("steps over a control nobody can see", () => {
    render(
      <Modal open onClose={() => {}} label="Stop tracking shop_dev">
        <button style={{ display: "none" }}>Hidden</button>
        <button>Cancel</button>
      </Modal>
    );
    expect(focused()).toBe(button("Cancel"));
  });

  test("steps over a container that is only focusable by script", () => {
    render(
      <Modal open onClose={() => {}} label="Stop tracking shop_dev">
        <div tabIndex={-1}>The rows this will stop watching</div>
        <button>Cancel</button>
      </Modal>
    );
    // tabIndex={-1} is how a container is made focusable by code and left out
    // of the tab order — the panel itself is one. Treating it as somewhere to
    // land would drop the person onto a div they cannot do anything with.
    expect(focused()).toBe(button("Cancel"));
  });

  test("holds focus itself when there is nothing inside to focus", () => {
    render(
      <Modal open onClose={() => {}} label="What changed">
        <p>Nothing here can be focused.</p>
      </Modal>
    );
    // The panel carries tabIndex={-1} for exactly this: focus has to be
    // somewhere inside, or the first Tab starts from the page behind.
    expect(focused()).toBe(panel());
  });

  test("Tab off the last control comes back to the first", () => {
    render(
      <Modal open onClose={() => {}} label="Stop tracking shop_dev">
        <button>Cancel</button>
        <button>Stop tracking</button>
      </Modal>
    );
    button("Stop tracking").focus();
    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(false);
    expect(focused()).toBe(button("Cancel"));
  });

  test("Shift+Tab off the first control goes to the last", () => {
    render(
      <Modal open onClose={() => {}} label="Stop tracking shop_dev">
        <button>Cancel</button>
        <button>Stop tracking</button>
      </Modal>
    );
    expect(fireEvent.keyDown(document, { key: "Tab", shiftKey: true })).toBe(false);
    expect(focused()).toBe(button("Stop tracking"));
  });

  test("Tab in the middle of the panel is left to the browser", () => {
    render(
      <Modal open onClose={() => {}} label="Stop tracking shop_dev">
        <button>Cancel</button>
        <button>Keep</button>
        <button>Stop tracking</button>
      </Modal>
    );
    button("Keep").focus();
    // Taking over Tab everywhere would break every widget that steers itself,
    // so the hook only intervenes at the two ends.
    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(true);
    expect(focused()).toBe(button("Keep"));
  });

  test("Tab goes nowhere when the panel has nothing to move to", () => {
    render(
      <Modal open onClose={() => {}} label="What changed">
        <p>Nothing here can be focused.</p>
      </Modal>
    );
    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(false);
    expect(focused()).toBe(panel());
  });

  test("keeps the focused control in the loop even with no offset parent", () => {
    render(
      <Modal open onClose={() => {}} label="Stop tracking shop_dev">
        <button style={{ position: "fixed" }}>Pinned</button>
        <button>Cancel</button>
      </Modal>
    );
    // A fixed-position element has no offset parent in a real browser. It is
    // skipped when focus is looking for somewhere to land, but once it HAS
    // focus, dropping it from the list would leave the keyboard user standing
    // on a control the trap does not believe exists.
    expect(focused()).toBe(button("Cancel"));
    button("Pinned").focus();
    expect(fireEvent.keyDown(document, { key: "Tab", shiftKey: true })).toBe(false);
    expect(focused()).toBe(button("Cancel"));
  });

  test("hands focus back to whatever opened it", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Stop tracking…</button>
          <Modal open={open} onClose={() => setOpen(false)} label="Stop tracking shop_dev">
            <button>Cancel</button>
          </Modal>
        </>
      );
    }
    render(<Harness />);
    const opener = button("Stop tracking…");
    opener.focus();
    fireEvent.click(opener);
    expect(focused()).toBe(button("Cancel"));

    fireEvent.keyDown(document, { key: "Escape" });
    // Without this the keyboard user is dropped at the top of the document and
    // has to walk back down to the row they were on.
    expect(focused()).toBe(opener);
  });
});

describe("the confirm gate", () => {
  test("is named by the heading the reader can see", () => {
    render(
      <ConfirmDialog
        open
        onClose={() => {}}
        onConfirm={() => {}}
        title="Re-baseline to the live schema?"
      />
    );
    const heading = screen.getByRole("heading", { name: "Re-baseline to the live schema?" });
    expect(panel()).toHaveAttribute("aria-labelledby", heading.id);
    expect(panel()).not.toHaveAttribute("aria-label");
  });

  test("says what is about to happen", () => {
    render(
      <ConfirmDialog
        open
        onClose={() => {}}
        onConfirm={() => {}}
        title="Re-baseline to the live schema?"
        description="This does not revert anything."
      />
    );
    expect(screen.getByText("This does not revert anything.")).toBeInTheDocument();
  });

  test("labels its two buttons, and takes the caller's words when given them", () => {
    const { rerender } = render(
      <ConfirmDialog open onClose={() => {}} onConfirm={() => {}} title="Re-baseline?" />
    );
    expect(button("Confirm")).toBeInTheDocument();
    expect(button("Cancel")).toBeInTheDocument();

    rerender(
      <ConfirmDialog
        open
        onClose={() => {}}
        onConfirm={() => {}}
        title="Re-baseline?"
        confirmLabel="Re-baseline"
        cancelLabel="Leave it"
      />
    );
    expect(button("Re-baseline")).toBeInTheDocument();
    expect(button("Leave it")).toBeInTheDocument();
  });

  test("cancelling closes without doing the thing", () => {
    const onConfirm = jest.fn();
    const onClose = jest.fn();
    render(
      <ConfirmDialog open onClose={onClose} onConfirm={onConfirm} title="Re-baseline?" />
    );
    fireEvent.click(button("Cancel"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Escape cancels too", () => {
    const onConfirm = jest.fn();
    const onClose = jest.fn();
    render(
      <ConfirmDialog open onClose={onClose} onConfirm={onConfirm} title="Re-baseline?" />
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("confirming runs the action and then closes", () => {
    const order: string[] = [];
    render(
      <ConfirmDialog
        open
        onClose={() => order.push("close")}
        onConfirm={() => order.push("confirm")}
        title="Re-baseline?"
      />
    );
    fireEvent.click(button("Confirm"));
    // Closing first would unmount this body mid-click and leave the action to
    // run against a dialog that is already gone.
    expect(order).toEqual(["confirm", "close"]);
  });

  test("marks a destructive action as one", () => {
    render(
      <ConfirmDialog
        open
        onClose={() => {}}
        onConfirm={() => {}}
        title="Drop 3 tables?"
        confirmLabel="Drop"
        destructive
      />
    );
    expect(button("Drop")).toHaveClass("btn-destructive");
    expect(panel().querySelector("svg")).toBeInTheDocument();
  });

  test("and leaves an ordinary one alone", () => {
    render(
      <ConfirmDialog open onClose={() => {}} onConfirm={() => {}} title="Re-baseline?" />
    );
    expect(button("Confirm")).toHaveClass("btn-primary");
    expect(button("Confirm")).not.toHaveClass("btn-destructive");
    // The warning triangle is the only icon in this dialog, so its absence is
    // what says "this one is not dangerous".
    expect(panel().querySelector("svg")).toBeNull();
  });
});

describe("what the dialog does NOT do", () => {
  test("never renders a tick-this-first checkbox", () => {
    // ConfirmDialog used to carry an `acknowledge` prop that put a checkbox in
    // front of the confirm button and disabled it until the box was ticked.
    // Nothing ever passed it — the three screens that gate on a tick use an
    // inline panel, not a dialog — so it went, along with the `acknowledged`
    // argument it made every caller's onConfirm accept.
    //
    // This stays as the guard on that: a dialog with a hidden disabled state is
    // exactly the kind of thing that gets put back by accident, and a confirm
    // button that silently refuses to fire is very hard to read from outside.
    const onConfirm = jest.fn();
    render(
      <ConfirmDialog open onClose={() => {}} onConfirm={onConfirm} title="Re-baseline?" />
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(button("Confirm")).toBeEnabled();
    fireEvent.click(button("Confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
