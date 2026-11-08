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
 *  - That the organization half disappears on a narrow window. That is a CSS
 *    rule hung on the crumb-org class and jsdom applies no stylesheet, so what
 *    is asserted is that the class is on both halves of the crumb (the name and
 *    the chevron after it), because hiding one without the other leaves a stray
 *    arrow pointing at nothing.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { OrgProvider } from "@/components/OrgProvider";
import { StudioTopbar } from "@/components/studio/StudioTopbar";

/** The bar as every studio page draws it: inside an organization. */
function renderInOrg(screenName: string) {
  return render(
    <OrgProvider slug="acme" name="Acme Ltd">
      <StudioTopbar breadcrumbScreen={screenName} />
    </OrgProvider>
  );
}

describe("the breadcrumb", () => {
  test("says which screen you are on", () => {
    render(<StudioTopbar breadcrumbScreen="Version Sync" />);
    expect(screen.getByText("Version Sync")).toBeInTheDocument();
  });

  test("puts it under the organization the page is open in", () => {
    // It said "Workspace" in every organization, a word the studio uses
    // nowhere else, so someone in two could not tell which one they were in.
    renderInOrg("Drift");
    expect(screen.getByRole("navigation")).toHaveTextContent("Acme Ltd");
    expect(screen.getByRole("navigation")).toHaveTextContent("Drift");
    expect(screen.getByRole("navigation")).not.toHaveTextContent("Workspace");
  });

  test("is the screen name alone outside every organization", () => {
    const { container } = render(<StudioTopbar breadcrumbScreen="Drift" />);
    expect(screen.getByRole("navigation")).toHaveTextContent(/^Drift$/);
    expect(container.querySelectorAll(".crumb-org")).toHaveLength(0);
  });

  test("marks the organization half so a narrow window can drop it whole", () => {
    const { container } = renderInOrg("Drift");
    const dropped = container.querySelectorAll(".crumb-org");
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toHaveTextContent("Acme Ltd");
  });

  test("leaves the screen name itself alone, whatever the width", () => {
    // The screen you are on is the one thing the bar cannot afford to hide.
    renderInOrg("Drift");
    expect(screen.getByText("Drift")).not.toHaveClass("crumb-org");
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
