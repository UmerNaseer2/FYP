/** @jest-environment jsdom */

/**
 * The slide-over every add/edit flow and the mobile nav live in.
 *
 * A drawer is the modal's wider sibling: same portal, same scrim, same
 * `role="dialog" aria-modal="true"`, same borrowed focus trap. What it adds is
 * chrome — a titled header with a close button, a scrolling body and a sticky
 * footer for Test / Cancel / Save — plus two things a centred card never needs.
 * It has an edge it comes in from, and it stops the page behind it scrolling,
 * because on a phone a drag inside a drawer otherwise scrolls the list
 * underneath and the person loses their place in the form they were filling in.
 *
 * It also has a bare mode, which exists for one caller: the mobile nav, whose
 * sidebar brings its own header, footer and surface. Bare mode hands the whole
 * panel over — which means the drawer loses the visible heading it normally
 * names itself by, and has to be told a name instead or it announces itself to
 * a screen reader as "dialog" and nothing more.
 *
 * As in tests/component-modal.test.tsx, jsdom does no layout and reports no
 * offsetParent, so the block below gives it the three rules a browser follows
 * for the duration of this file. The focus trap itself — wrapping, the ends,
 * handing focus back — is that file's; what is checked here is that a drawer
 * is wired to it at all.
 *
 * What is NOT here:
 *  - hooks/useDialogFocus.ts, which both overlays share:
 *    tests/component-modal.test.tsx.
 *  - The sidebar that bare mode exists for:
 *    tests/component-studio-sidebar.test.tsx. What is held here is the
 *    drawer's half of that arrangement.
 *  - The screens that open drawers — connections, admin, the studio — are
 *    tests/page-connections.test.tsx, tests/page-admin.test.tsx and
 *    tests/page-studio.test.tsx.
 *  - That it slides, dims, or sits above the page. The animation and the scrim
 *    colour are CSS, and jsdom applies no stylesheet. The edge below is
 *    asserted as the class that positions the panel, because which side a
 *    drawer comes from is a decision this component makes rather than one the
 *    sheet makes for it.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { Drawer } from "@/components/ui";

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

afterEach(() => {
  cleanup();
  // The scroll lock writes to the one <body> every test in this file shares.
  document.body.style.overflow = "";
});

const panel = () => screen.getByRole("dialog");
/** The dim sheet behind the panel — the portal's first child, the panel its second. */
const scrim = () => panel().parentElement?.firstElementChild as HTMLElement;
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const focused = () => document.activeElement;
const scrollingBody = () => panel().querySelector(".overflow-y-auto") as HTMLElement;

describe("a drawer nobody has opened", () => {
  test("renders nothing at all", () => {
    render(
      <Drawer open={false} onClose={() => {}} title="Add a connection">
        <input aria-label="Host" />
      </Drawer>
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Host")).not.toBeInTheDocument();
  });

  test("leaves the page behind it scrolling", () => {
    render(
      <Drawer open={false} onClose={() => {}} title="Add a connection">
        <p>Nothing yet.</p>
      </Drawer>
    );
    expect(document.body.style.overflow).toBe("");
  });

  test("stops listening for Escape once it has been closed", () => {
    const onClose = jest.fn();
    const { rerender } = render(
      <Drawer open onClose={onClose} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <Drawer open={false} onClose={onClose} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("stops listening once it has been taken off the page", () => {
    const onClose = jest.fn();
    const { unmount } = render(
      <Drawer open onClose={onClose} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("the panel", () => {
  test("is portaled to the body, not left inside whatever rendered it", () => {
    const { container } = render(
      <Drawer open onClose={() => {}} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    // A drawer rendered in place is clipped by the first scrolling ancestor it
    // has, which is usually the card holding the button that opened it.
    expect(container).not.toContainElement(panel());
    expect(document.body).toContainElement(panel());
  });

  test("tells a screen reader that the page behind is out of play", () => {
    render(
      <Drawer open onClose={() => {}} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    expect(panel()).toHaveAttribute("aria-modal", "true");
  });

  test("names itself by the title the reader can see", () => {
    render(
      <Drawer open onClose={() => {}} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    const heading = screen.getByRole("heading", { name: "Add a connection" });
    // Pointing at the heading rather than repeating it in an aria-label means
    // the spoken name and the printed one cannot drift apart.
    expect(panel()).toHaveAttribute("aria-labelledby", heading.id);
    expect(panel()).not.toHaveAttribute("aria-label");
  });

  test("is 460px wide unless the caller says otherwise", () => {
    render(
      <Drawer open onClose={() => {}} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    expect(panel()).toHaveStyle({ width: "460px" });
  });

  test("takes a width as a number of pixels or as any CSS length", () => {
    const { rerender } = render(
      <Drawer open onClose={() => {}} width={620} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    expect(panel()).toHaveStyle({ width: "620px" });

    rerender(
      <Drawer open onClose={() => {}} width="50rem" title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    expect(panel()).toHaveStyle({ width: "50rem" });
  });

  test("never takes the whole width of a phone", () => {
    render(
      <Drawer open onClose={() => {}} width={620} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    // A 620px drawer on a 390px screen would cover the page completely, and
    // the scrim is the only way back out with a mouse or a thumb.
    expect(panel()).toHaveStyle({ maxWidth: "94vw" });
  });

  test("comes in from the right, or from the left when asked", () => {
    const { rerender } = render(
      <Drawer open onClose={() => {}} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    expect(panel()).toHaveClass("right-0");
    expect(panel()).not.toHaveClass("left-0");

    rerender(
      <Drawer open onClose={() => {}} side="left" title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    expect(panel()).toHaveClass("left-0");
    expect(panel()).not.toHaveClass("right-0");
  });
});

describe("the chrome around the contents", () => {
  test("shows the title, and a status beside it when there is one", () => {
    render(
      <Drawer
        open
        onClose={() => {}}
        title="Edit shop_prod"
        badge={<span>Unreachable</span>}
      >
        <p>Fields go here.</p>
      </Drawer>
    );
    const heading = screen.getByRole("heading", { name: "Edit shop_prod" });
    expect(heading).toBeInTheDocument();
    // Beside the title rather than down in the body: the state of the thing
    // being edited belongs with its name.
    expect(heading.parentElement).toContainElement(screen.getByText("Unreachable"));
  });

  test("closes from the close button", () => {
    const onClose = jest.fn();
    render(
      <Drawer open onClose={onClose} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    // The glyph is an ✕, which reads as nothing at all out loud.
    fireEvent.click(button("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("puts the contents in the part that scrolls, and the title in the part that does not", () => {
    render(
      <Drawer open onClose={() => {}} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    // A header that scrolls away takes the close button with it, and a long
    // form is exactly where somebody needs it.
    expect(scrollingBody()).toContainElement(screen.getByText("Fields go here."));
    expect(scrollingBody()).not.toContainElement(
      screen.getByRole("heading", { name: "Add a connection" })
    );
  });

  test("keeps the footer out of the scrolling part", () => {
    render(
      <Drawer
        open
        onClose={() => {}}
        title="Add a connection"
        footer={<button>Save</button>}
      >
        <p>Fields go here.</p>
      </Drawer>
    );
    expect(button("Save")).toBeInTheDocument();
    // Save has to stay reachable however long the form is.
    expect(scrollingBody()).not.toContainElement(button("Save"));
  });

  test("leaves the footer out entirely when there is nothing to put in it", () => {
    render(
      <Drawer open onClose={() => {}} title="What changed">
        <p>Read-only.</p>
      </Drawer>
    );
    // An empty bordered strip at the bottom of a read-only drawer reads as a
    // row of buttons that failed to load.
    expect(panel().children).toHaveLength(2);
  });
});

describe("bare mode, for the mobile nav", () => {
  test("hands the whole panel to the child", () => {
    render(
      <Drawer open onClose={() => {}} bare label="Menu">
        <nav>
          <a href="/studio">Studio</a>
        </nav>
      </Drawer>
    );
    expect(screen.getByRole("link", { name: "Studio" })).toBeInTheDocument();
    // The sidebar brings its own header and its own way out, so the drawer's
    // would be a second close button and a second title on the same surface.
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  test("takes a name in words, since it has no heading left to point at", () => {
    render(
      <Drawer open onClose={() => {}} bare label="Menu">
        <nav>
          <a href="/studio">Studio</a>
        </nav>
      </Drawer>
    );
    // aria-labelledby pointing at a heading that bare mode does not render
    // would leave the dialog announcing itself as "dialog" and nothing else.
    expect(panel()).toHaveAttribute("aria-label", "Menu");
    expect(panel()).not.toHaveAttribute("aria-labelledby");
  });
});

describe("closing it", () => {
  test("Escape closes it", () => {
    const onClose = jest.fn();
    render(
      <Drawer open onClose={onClose} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("any other key is left to the page", () => {
    const onClose = jest.fn();
    render(
      <Drawer open onClose={onClose} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("clicking the dimmed sheet beside it closes it", () => {
    const onClose = jest.fn();
    render(
      <Drawer open onClose={onClose} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    fireEvent.click(scrim());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking inside the panel does not", () => {
    const onClose = jest.fn();
    render(
      <Drawer open onClose={onClose} title="Add a connection">
        <input aria-label="Host" />
      </Drawer>
    );
    // The sheet is a sibling of the panel, not its parent — one onClick around
    // both would throw away a half-filled form on the first click in a field.
    fireEvent.click(screen.getByLabelText("Host"));
    fireEvent.click(panel());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("the page behind it", () => {
  test("stops scrolling while the drawer is open", () => {
    render(
      <Drawer open onClose={() => {}} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    // Without this a drag inside the drawer scrolls the list underneath, and
    // the row that was being edited is somewhere else when the drawer closes.
    expect(document.body.style.overflow).toBe("hidden");
  });

  test("gets back exactly what it had, not a guess at it", () => {
    document.body.style.overflow = "scroll";
    const { rerender } = render(
      <Drawer open onClose={() => {}} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    expect(document.body.style.overflow).toBe("hidden");

    rerender(
      <Drawer open={false} onClose={() => {}} title="Add a connection">
        <p>Fields go here.</p>
      </Drawer>
    );
    // Clearing it instead of restoring it would quietly unlock a page that was
    // deliberately locked — the drawer opened from inside another one, say.
    expect(document.body.style.overflow).toBe("scroll");
  });
});

describe("the keyboard", () => {
  test("puts focus inside the panel, on the first thing there", () => {
    render(
      <Drawer open onClose={() => {}} title="Add a connection">
        <input aria-label="Host" />
      </Drawer>
    );
    // The close button is the first control in the header, so it is where the
    // first Tab starts from.
    expect(focused()).toBe(button("Close"));
  });

  test("holds focus itself when the child has nothing to focus", () => {
    render(
      <Drawer open onClose={() => {}} bare label="Menu">
        <p>Nothing here can be focused.</p>
      </Drawer>
    );
    expect(focused()).toBe(panel());
  });

  test("keeps Tab inside the panel", () => {
    render(
      <Drawer open onClose={() => {}} title="Add a connection">
        <input aria-label="Host" />
      </Drawer>
    );
    screen.getByLabelText("Host").focus();
    // The full wrap in both directions is tests/component-modal.test.tsx; what
    // matters here is that a drawer is wired to the same trap at all.
    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(false);
    expect(focused()).toBe(button("Close"));
  });

  test("hands focus back to whatever opened it", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Add a connection</button>
          <Drawer open={open} onClose={() => setOpen(false)} title="Add a connection">
            <input aria-label="Host" />
          </Drawer>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Add a connection" });
    opener.focus();
    fireEvent.click(opener);
    expect(focused()).toBe(button("Close"));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(focused()).toBe(opener);
  });
});
