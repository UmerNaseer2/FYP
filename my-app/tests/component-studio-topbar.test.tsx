/** @jest-environment jsdom */

/**
 * The strip across the top of every studio screen.
 *
 * It is deliberately almost empty. Every screen puts its own working controls
 * in the page body rather than up here, so what is left is a breadcrumb saying
 * where you are and — on a phone, where the rail has been folded away into a
 * drawer — the button that brings the rail back.
 *
 * That button is the part worth pinning down. It is an icon with no words, so
 * the only thing naming it is its aria-label, and it is the sole way to reach
 * navigation on a phone: unnamed, or absent, and a screen reader user on a
 * narrow window has no route to any other screen.
 *
 * What is NOT here:
 *  - Who decides the screen name or when the menu shows:
 *    tests/component-studio-shell.test.tsx, which owns both.
 *  - That the group half disappears on a narrow window. That is a CSS rule
 *    hung on the crumb-group class and jsdom applies no stylesheet, so what
 *    is asserted is that the class is on both halves of the crumb (the group
 *    and the chevron after it), because hiding one without the other leaves a
 *    stray arrow pointing at nothing.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { OrgProvider } from "@/components/OrgProvider";
import { StudioTopbar } from "@/components/studio/StudioTopbar";

/** The bar as every studio page draws it: inside an organization. */
function renderInOrg(screenName: string, group?: string) {
  return render(
    <OrgProvider slug="acme" name="Acme Ltd">
      <StudioTopbar breadcrumbScreen={screenName} breadcrumbGroup={group} />
    </OrgProvider>
  );
}

describe("the breadcrumb", () => {
  test("says which screen you are on", () => {
    render(<StudioTopbar breadcrumbScreen="Version Sync" />);
    expect(screen.getByText("Version Sync")).toBeInTheDocument();
  });

  test("puts it under its menu group, and names the organization in the tooltip", () => {
    // The crumb reads "Watch › Drift", the same words as the menu. The
    // organization's name is in the rail, so here it is only the tooltip.
    renderInOrg("Drift", "Watch");
    expect(screen.getByRole("navigation")).toHaveTextContent(/^Watch\s*Drift$/);
    expect(screen.getByRole("navigation")).toHaveAttribute("title", "Drift, in Acme Ltd");
    expect(screen.getByText("Drift")).toHaveAttribute("aria-current", "page");
  });

  test("is the screen name alone for a page with no group, such as the Dashboard", () => {
    const { container } = renderInOrg("Dashboard");
    expect(screen.getByRole("navigation")).toHaveTextContent(/^Dashboard$/);
    expect(container.querySelectorAll(".crumb-group")).toHaveLength(0);
  });

  test("is the screen name alone outside every organization", () => {
    const { container } = render(<StudioTopbar breadcrumbScreen="Drift" />);
    expect(screen.getByRole("navigation")).toHaveTextContent(/^Drift$/);
    expect(container.querySelectorAll(".crumb-group")).toHaveLength(0);
  });

  test("marks the group half so a narrow window can drop it whole", () => {
    const { container } = renderInOrg("Drift", "Watch");
    const dropped = container.querySelectorAll(".crumb-group");
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toHaveTextContent("Watch");
  });

  test("leaves the screen name itself alone, whatever the width", () => {
    // The screen you are on is the one thing the bar cannot afford to hide.
    renderInOrg("Drift", "Watch");
    expect(screen.getByText("Drift")).not.toHaveClass("crumb-group");
  });
});

describe("the menu button", () => {
  test("is not there unless it is asked for", () => {
    render(<StudioTopbar breadcrumbScreen="Drift" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("says what it opens, since it is an icon and nothing else", () => {
    render(<StudioTopbar breadcrumbScreen="Drift" showMenu />);
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
  });

  test("carries a dot, and says so in words, while requests wait", () => {
    // The dot alone would be colour and shape only, so the count is in the name.
    const { container, rerender } = render(<StudioTopbar breadcrumbScreen="Drift" showMenu menuWaiting={2} />);
    expect(screen.getByRole("button", { name: "Open navigation, 2 requests waiting on you" })).toBeInTheDocument();
    expect(container.querySelector(".tb-dot")).toHaveAttribute("aria-hidden");
    rerender(<StudioTopbar breadcrumbScreen="Drift" showMenu menuWaiting={1} />);
    expect(screen.getByRole("button", { name: "Open navigation, 1 request waiting on you" })).toBeInTheDocument();
    rerender(<StudioTopbar breadcrumbScreen="Drift" showMenu menuWaiting={0} />);
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
    expect(container.querySelector(".tb-dot")).toBeNull();
  });

  test("hands the tap back to whoever owns the drawer", () => {
    const onMenuClick = jest.fn();
    render(<StudioTopbar breadcrumbScreen="Drift" showMenu onMenuClick={onMenuClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(onMenuClick).toHaveBeenCalledTimes(1);
  });

  test("survives being shown with nobody listening", () => {
    // onMenuClick is optional in the type, so the button has to be harmless
    // without one rather than throwing on the first tap.
    render(<StudioTopbar breadcrumbScreen="Drift" showMenu />);
    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: "Open navigation" }))
    ).not.toThrow();
  });
});
