/** @jest-environment jsdom */

/**
 * The shared pieces many pages lean on: the one status system
 * (lib/status-look, StatusChip), errors that say what to do
 * (lib/friendly-error, ErrorNotice) and setup checklists (SetupChecklist).
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { STATUS_LOOK, STATUS_ORDER, statusKeyOf, statusVar } from "@/lib/status-look";
import { describeError } from "@/lib/friendly-error";
import { StatusChip } from "@/components/ui/StatusChip";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { SetupChecklist } from "@/components/ui/SetupChecklist";

jest.mock("../hooks/useOrg", () => ({
  useOrg: () => ({ slug: "acme", name: "Acme" }),
  useOrgHref: () => (path: string) => `/acme${path}`,
}));

describe("status system", () => {
  test("every state has its own word, tone and glyph", () => {
    const looks = STATUS_ORDER.map((k) => STATUS_LOOK[k]);
    expect(looks.map((l) => l.label)).toEqual(["In sync", "Drifted", "Can't be reached", "Not checked yet"]);
    expect(new Set(looks.map((l) => l.tone)).size).toBe(4);
    expect(new Set(looks.map((l) => l.glyph)).size).toBe(4);
  });

  test("older words map onto the four states", () => {
    expect(statusKeyOf("in_sync")).toBe("in_sync");
    expect(statusKeyOf("DRIFT")).toBe("drifted");
    expect(statusKeyOf("error")).toBe("unreachable");
    expect(statusKeyOf("failed")).toBe("unreachable");
    expect(statusKeyOf(null)).toBe("unchecked");
    expect(statusKeyOf("never")).toBe("unchecked");
  });

  test("statusVar names the theme variable", () => {
    expect(statusVar("drifted", "roof")).toBe("var(--st-drift-roof)");
    expect(statusVar(undefined, "ink")).toBe("var(--st-new-ink)");
  });

  test("a chip shows the word as well as the colour", () => {
    render(<StatusChip status="unreachable" />);
    const chip = screen.getByText("Can't be reached");
    expect(chip).toHaveClass("st-chip", "st--down");
    expect(chip).toHaveAttribute("data-status", "unreachable");
    expect(chip.querySelector("svg")).not.toBeNull();
  });

  test("a chip can carry its own words", () => {
    render(<StatusChip status="drifted" label="3 drifted" variant="mark" size="sm" />);
    expect(screen.getByText("3 drifted")).toHaveClass("st-mark", "st--drift", "st-chip--sm");
  });
});

describe("errors that say what to do", () => {
  test("a password the server cannot open names the connection", () => {
    const info = describeError("Stored credentials can't be read on this server", { connectionName: "shop_live" });
    expect(info.kind).toBe("password");
    expect(info.title).toBe("shop_live needs its password again");
    expect(info.technical).toMatch(/Stored credentials/);
  });

  test("a database that did not answer", () => {
    const info = describeError("connect ECONNREFUSED 127.0.0.1:5432");
    expect(info.kind).toBe("unreachable");
    expect(info.title).toBe("This connection can't be reached");
  });

  test("a slow query or a browser that lost Schema Studio is not blamed on the database", () => {
    expect(describeError("canceling statement due to statement timeout").kind).toBe("other");
    expect(describeError("Network error while listing schemas.").kind).toBe("other");
    expect(describeError("Connection timed out. The server may be unreachable or behind a firewall.").kind).toBe(
      "unreachable",
    );
  });

  test("an unreachable notice without a retry has no empty button row", () => {
    const { container } = render(<ErrorNotice error="connect ECONNREFUSED 127.0.0.1:5432" />);
    expect(container.querySelector(".notice__actions")).toBeNull();
  });

  test("no schemas, and anything else passes through", () => {
    expect(describeError("No schemas found").kind).toBe("no-schemas");
    const other = describeError("Pick a target first.");
    expect(other).toMatchObject({ kind: "other", title: null, body: "Pick a target first.", technical: null });
    expect(describeError("").body).toMatch(/Something went wrong/);
  });

  test("the password notice opens that connection for editing", () => {
    render(<ErrorNotice error="credentials can't be read" connectionName="shop_live" connectionId={7} />);
    expect(screen.getByRole("alert")).toHaveClass("notice--warn");
    expect(screen.getByRole("link", { name: "Enter the password again" })).toHaveAttribute(
      "href",
      "/acme/connections?edit=7",
    );
    expect(screen.getByText("Technical details")).toBeInTheDocument();
  });

  test("an unreachable database offers Try again", () => {
    const onRetry = jest.fn();
    render(<ErrorNotice error="getaddrinfo ENOTFOUND db.example" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("no schemas points at Connections", () => {
    render(<ErrorNotice error="No schemas" />);
    expect(screen.getByRole("link", { name: "Open Connections" })).toHaveAttribute("href", "/acme/connections");
    expect(screen.queryByText("Technical details")).toBeNull();
  });

  test("nothing renders without an error", () => {
    const { container } = render(<ErrorNotice error="   " />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("setup checklist", () => {
  const steps = [
    { key: "a", label: "Add a connection", done: true, action: { label: "Add", href: "/acme/connections" } },
    { key: "b", label: "Set up GitHub", done: false, detail: "An Admin does this", action: { label: "Set up GitHub", href: "/acme/admin?tab=github" } },
    { key: "c", label: "Track a schema", done: false },
  ];

  test("counts what is done and offers a button only for open steps", () => {
    render(<SetupChecklist title="Getting started" steps={steps} />);
    expect(screen.getByRole("region", { name: "Getting started" })).toBeInTheDocument();
    expect(screen.getByText("1 of 3 done")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Add" })).toBeNull();
    expect(screen.getByRole("link", { name: "Set up GitHub" })).toHaveAttribute("href", "/acme/admin?tab=github");
    expect(screen.getByText("An Admin does this")).toBeInTheDocument();
    expect(screen.getByText("(done)", { exact: false })).toBeInTheDocument();
  });

  test("Hide shows only when the page allows it", () => {
    const onHide = jest.fn();
    const { rerender } = render(<SetupChecklist title="Getting started" steps={steps} />);
    expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
    rerender(<SetupChecklist title="Getting started" steps={steps} onHide={onHide} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(onHide).toHaveBeenCalled();
  });
});
