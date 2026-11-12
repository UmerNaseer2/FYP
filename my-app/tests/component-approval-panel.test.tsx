/** @jest-environment jsdom */

/**
 * The approval panel as people read it, and the browser-side hash that
 * decides whether an approval covers the run on screen.
 *
 * Somebody whose role may not run on a connection asks for approval of one
 * exact run, and an Admin (or whoever may approve) answers. The panel has two
 * modes: the asker's (askToRun) and the answer panel for somebody else's ask.
 *
 * Nothing in this panel can start a deploy. The apply route claims an
 * approval row before it runs any SQL, and refuses if none covers the run.
 * What the panel does is report, so the tests below are about sentences:
 * which state the panel claims and which button it offers to whom.
 *
 * What is NOT here:
 *  - Enforcement, which tests/approvals-action.test.ts and
 *    tests/deploy-safety.test.ts cover.
 *  - Working out which row is approved, pending or latest. The pages that
 *    sort them (Deploy, Version Sync) have their own suites.
 *  - What happens after a button is pressed. onRequest and onDecide are the
 *    page's.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * lib/approvals-db is reached for one export — runFingerprint, the server's
 * half of the hash — and importing it pulls in the metadata pool. A stand-in
 * keeps this suite off every database; nothing below calls a query.
 * Relative, not "@/lib/...": next/jest rewrites that alias inside import
 * statements only, so a jest.mock of the alias would not resolve.
 */
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: async () => ({ rows: [] }) },
  syncMetadataTables: async () => undefined,
}));
// The link to ask for a box reads who is signed in.
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);
jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import { ApprovalPanel, sha256Hex, type ApprovalRow } from "@/components/studio/ApprovalPanel";
import { fingerprintBody, rollbackFingerprintBody, type ApprovalScript } from "@/lib/approval-fingerprint";
import { runFingerprint } from "@/lib/approvals-db";
import { resetPageState } from "./helpers/render-page";

type PanelProps = Parameters<typeof ApprovalPanel>[0];

/** A run of two migrations through v1.0.2, with everything else at rest. */
const BASE: PanelProps = {
  migrationCount: 2,
  targetVersion: "1.0.2",
  hashReady: true,
  hashError: null,
  loading: false,
  error: null,
  unreadable: false,
  busy: false,
  approved: null,
  pending: null,
  latest: null,
  viewerEmail: "me@example.com",
  roleLabel: "Admin",
  mayApprove: true,
  bypass: false,
  note: "",
  onNoteChange: () => {},
  onRequest: () => {},
  onDecide: () => {},
};

function row(over: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: 11,
    target_version: "1.0.2",
    run_fingerprint: "f1",
    migration_count: 2,
    breaking_count: 0,
    requested_by: "asker@example.com",
    requested_at: "2026-09-18T09:00:00.000Z",
    status: "pending",
    decided_by: null,
    decided_at: null,
    self_approved: false,
    note: null,
    used_at: null,
    ...over,
  };
}

/**
 * Render and hand back the panel element. Assertions go through
 * toHaveTextContent on this rather than getByText for anything that spans a
 * <span className="mono"> — a version number sits inside one, so the sentence
 * around it is not a single text node and getByText would not see it whole.
 */
function show(over: Partial<PanelProps> = {}): HTMLElement {
  render(<ApprovalPanel {...BASE} {...over} />);
  const panel = document.querySelector(".appr");
  if (!panel) throw new Error("The panel rendered nothing at all");
  return panel as HTMLElement;
}

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("before there is anything to say", () => {
  it("does not ask for an approval when no migrations are selected", () => {
    const panel = show({ migrationCount: 0 });

    expect(panel).toHaveTextContent("Pick a target version first. There is nothing to approve yet.");
    // Why there is nothing to approve is one click away, in the "?" beside the title.
    fireEvent.click(screen.getByRole("button", { name: "Help: Approval" }));
    expect(screen.getByRole("note")).toHaveTextContent("An approval covers one run of this exact SQL");
    // An approval covers exact SQL, so one requested against an empty selection
    // would be an approval of nothing that a later selection could inherit.
    expect(screen.queryByRole("button", { name: /Request approval/ })).not.toBeInTheDocument();
  });

  it("says the same about a rollback in the rollback's own words", () => {
    const panel = show({ action: "revert", migrationCount: 0 });

    // Not every version has a rollback that can run, so "pick a target version"
    // would send the reader to do something they may have done already.
    expect(panel).toHaveTextContent("Nothing to approve yet");
    expect(panel).toHaveTextContent("not every version above has a rollback that can run");
  });

  it("waits rather than guessing while the run is still being hashed", () => {
    const panel = show({ hashReady: false });

    expect(panel).toHaveTextContent("Working out which approval covers this run");
    // The approval state is not known yet, and the difference between "not yet"
    // and "there isn't one" is the whole value of the panel.
    expect(screen.queryByText("Needs an approval")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request approval/ })).not.toBeInTheDocument();
  });

  it("distinguishes hashing the run from reading the list", () => {
    const panel = show({ hashReady: true, loading: true });

    expect(panel).toHaveTextContent("Reading the approvals for this target");
  });

  it("shows the hash failure itself instead of an approval state", () => {
    // sha256Hex needs crypto.subtle, which only exists over https or on
    // localhost. On a plain-http deployment this is the state every operator
    // sees, so it has to say what went wrong rather than report the run as
    // unapproved and send them to request one that would never match.
    const panel = show({ hashError: "This page must be served over https to check approvals." });

    expect(panel).toHaveTextContent("This page must be served over https to check approvals.");
    expect(screen.queryByText("Needs an approval")).not.toBeInTheDocument();
  });
});

describe("a list nobody could read", () => {
  it("says the state is unknown rather than reporting it as unapproved", () => {
    const panel = show({ unreadable: true, error: "connection refused" });

    // The failure that matters is the other direction — an unreadable list
    // falling through to "Needs an approval" reports the approval state as
    // read when nothing read it.
    expect(screen.getByText("Approval state unknown")).toBeInTheDocument();
    expect(panel).toHaveTextContent("this page cannot say whether this run is cleared");
    expect(panel).toHaveTextContent("The server checks again when you press Deploy");
    expect(panel).toHaveTextContent("connection refused");
    expect(screen.queryByText("Needs an approval")).not.toBeInTheDocument();
    // Requesting one now would post against a list that could not be read, so
    // the reader cannot tell whether they are asking for a second time.
    expect(screen.queryByRole("button", { name: /Request approval/ })).not.toBeInTheDocument();
  });

  it("names the button the reader will actually press", () => {
    // Version Sync spends the same approvals from a button called something
    // else, and "press Deploy" on a screen with no Deploy button reads as a
    // different screen's message.
    const panel = show({ unreadable: true, runButton: "Replay to here" });

    expect(panel).toHaveTextContent("when you press Replay to here");
  });

  it("names the rollback button by default on a rollback", () => {
    const panel = show({ action: "revert", unreadable: true });

    expect(panel).toHaveTextContent("whether this rollback is cleared");
    expect(panel).toHaveTextContent("when you press Roll back");
  });
});


const ASKER = { askToRun: true, mayApprove: false, roleLabel: "Editor" } as const;

describe("somebody whose role may not run this by itself", () => {
  it("offers to ask an Admin for this exact run", () => {
    const panel = show(ASKER);
    expect(panel).toHaveTextContent("Needs an Admin's approval");
    expect(panel).toHaveTextContent("Your role (Editor) may not run migrations on this connection by itself.");
    expect(panel).toHaveTextContent("you can run it once, within 7 days");
    expect(screen.getByRole("button", { name: "Ask for approval" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Ask for approval again" })).not.toBeInTheDocument();
  });

  it("says rollback when it is a rollback", () => {
    const panel = show({ ...ASKER, action: "revert", versionsLabel: "v3.0.0" });
    expect(panel).toHaveTextContent("may not roll back on this connection by itself");
  });

  it("waits for an Admin once asked, with no button to answer it themselves", () => {
    const panel = show({ ...ASKER, pending: row({ requested_by: "me@example.com" }) });
    expect(panel).toHaveTextContent("Waiting for an Admin");
    expect(panel).toHaveTextContent("Admins see it on their Requests page");
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ask for approval/ })).not.toBeInTheDocument();
  });

  it("says the approval is theirs, once", () => {
    const panel = show({ ...ASKER, approved: row({ status: "approved", decided_by: "boss@example.com" }) });
    expect(panel).toHaveTextContent("Approved for you, once");
  });

  it("repeats a rejection and who wrote it, and lets them ask again", () => {
    const panel = show({
      ...ASKER,
      latest: row({ status: "rejected", decided_by: "boss@example.com", note: "wait for the window" }),
    });

    expect(panel).toHaveTextContent(
      'The last request for this exact SQL was rejected by boss@example.com, with the note "wait for the window".'
    );
    expect(screen.getByRole("button", { name: "Ask for approval again" })).toBeEnabled();
  });

  it("says when an approval for this SQL has already been spent", () => {
    const panel = show({ ...ASKER, latest: row({ status: "used" }) });
    expect(panel).toHaveTextContent("has already been spent on a run");
  });

  it("says spent on a rollback when that is what spent it", () => {
    const panel = show({ ...ASKER, action: "revert", versionsLabel: "v3.0.0", latest: row({ status: "used" }) });
    expect(panel).toHaveTextContent("has already been spent on a rollback");
  });

  it("holds the ask button while a request is in flight", () => {
    show({ ...ASKER, busy: true });
    expect(screen.getByRole("button", { name: "Ask for approval" })).toBeDisabled();
  });

  it("labels the note for whoever approves", () => {
    const typed: string[] = [];
    show({ ...ASKER, onNoteChange: (value) => typed.push(value) });

    const box = screen.getByLabelText("Note for the record, shown to whoever approves this");
    expect(box).toHaveValue("");
    expect(box).toHaveAttribute("placeholder", "Optional note for the approver");
    fireEvent.change(box, { target: { value: "ticket 412" } });
    expect(typed).toEqual(["ticket 412"]);
  });
});

describe("the answer panel, for somebody else's ask", () => {
  it("offers both decisions to somebody who may approve", () => {
    const decided: Array<[number, string]> = [];
    const panel = show({ pending: row(), onDecide: (id, decision) => decided.push([id, decision]) });

    expect(panel).toHaveTextContent("Waiting for your answer");
    expect(panel).toHaveTextContent("Requested by asker@example.com");
    expect(panel).toHaveTextContent("Their role may not do this run by itself.");
    fireEvent.click(screen.getByRole("button", { name: "Approve this run" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(decided).toEqual([
      [11, "approve"],
      [11, "reject"],
    ]);
  });

  it("calls it a rollback when it is one", () => {
    show({ action: "revert", versionsLabel: "v3.0.0", pending: row({ action: "revert" }) });
    expect(screen.getByRole("button", { name: "Approve this rollback" })).toBeEnabled();
  });

  it("withholds them from the person who asked, in the server's words", () => {
    const panel = show({ pending: row({ requested_by: "me@example.com" }) });

    expect(panel).toHaveTextContent("Waiting for somebody else");
    expect(panel).toHaveTextContent("You asked for this run, so somebody else has to approve it.");
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
  });

  it("treats an address that differs only in case as the same person", () => {
    show({ pending: row({ requested_by: "ME@Example.com" }) });
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
  });

  it("names the rollback in the line the asker gets", () => {
    const panel = show({
      action: "revert",
      versionsLabel: "v3.0.0",
      pending: row({ requested_by: "me@example.com", action: "revert" }),
    });
    expect(panel).toHaveTextContent("You asked for this rollback, so somebody else has to approve it.");
  });

  it("withholds them from a role that may not approve, and names what it needs", () => {
    const panel = show({ pending: row(), mayApprove: false, roleLabel: "Editor" });

    expect(panel).toHaveTextContent("Your role (Editor) can't approve a run.");
    expect(panel).toHaveTextContent("Ask an admin to turn on");
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
  });

  it("sends a tester viewing as another role back to Admin", () => {
    const panel = show({ pending: row(), mayApprove: false, roleLabel: "Editor", bypass: true });

    expect(panel).toHaveTextContent('Switch "View as" back to Admin to do that.');
    expect(panel).not.toHaveTextContent("Ask an admin to turn on");
  });

  it("holds both decisions while one is in flight", () => {
    show({ pending: row(), busy: true });

    expect(screen.getByRole("button", { name: "Approve this run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("offers nothing to ask for when nobody has asked", () => {
    const panel = show({});

    expect(panel).toHaveTextContent("Needs an approval");
    expect(panel).toHaveTextContent("Nobody has asked for this exact run.");
    expect(screen.queryByRole("button", { name: /Ask for approval|Approve|Reject/ })).not.toBeInTheDocument();
  });

  it("labels the note for the record", () => {
    const typed: string[] = [];
    show({ pending: row(), onNoteChange: (value) => typed.push(value) });

    fireEvent.change(screen.getByLabelText("Note for the approval record"), {
      target: { value: "read it all" },
    });
    expect(typed).toEqual(["read it all"]);
  });
});

describe("what an approval says it covers", () => {
  it("names the exact run, and that it is good for one", () => {
    const panel = show({
      approved: row({
        status: "approved",
        decided_by: "boss@example.com",
        decided_at: "2026-09-18T09:30:00.000Z",
      }),
    });

    expect(panel).toHaveTextContent("Approved");
    expect(panel).toHaveTextContent("Cleared for exactly these 2 migrations through v1.0.2");
    expect(panel).toHaveTextContent("Edit any of the SQL and this stops applying.");
    expect(panel).toHaveTextContent(
      "Requested by asker@example.com · approved by boss@example.com · 2026-09-18 09:30 UTC"
    );
  });

  it("reads properly when there is one migration", () => {
    const panel = show({ migrationCount: 1, approved: row({ status: "approved", migration_count: 1 }) });

    expect(panel).toHaveTextContent("Cleared for exactly this migration through");
    expect(panel).not.toHaveTextContent("1 migration");
  });

  it("says when the approval stops covering the run", () => {
    const panel = show({
      approved: row({ status: "approved", expires_at: "2026-09-19T09:00:00.000Z" }),
    });

    expect(panel).toHaveTextContent("Good until 2026-09-19 09:00 UTC");
    expect(panel).toHaveTextContent("after that this run needs approving again");
  });

  it("stays quiet about expiry on a row decided before approvals expired", () => {
    const panel = show({ approved: row({ status: "approved", expires_at: null }) });

    expect(panel).not.toHaveTextContent("Good until");
  });

  it("names the versions a rollback undoes rather than a count", () => {
    const panel = show({
      action: "revert",
      versionsLabel: "v3.0.0 and v2.0.0",
      approved: row({ status: "approved", decided_by: "boss@example.com" }),
    });

    expect(panel).toHaveTextContent("Cleared to undo exactly v3.0.0 and v2.0.0");
    expect(panel).toHaveTextContent("good for one rollback");
  });

  it("carries the approver's note through to the run", () => {
    const panel = show({ approved: row({ status: "approved", note: "agreed on the call" }) });

    expect(panel).toHaveTextContent("Note: agreed on the call");
  });
});

describe("an approval that covers something else", () => {
  const other = (over: Partial<ApprovalRow> = {}) =>
    row({ id: 22, status: "approved", target_version: "2.0.0", migration_count: 3, ...over });

  it("says what changed when the approval is for this very target", () => {
    // Without this line the panel says "Needs an approval" while the
    // approver insists they approved it — and they did, before the SQL moved.
    const panel = show({ otherApproval: other({ target_version: "1.0.2" }) });

    expect(screen.getByText("Needs an approval")).toBeInTheDocument();
    expect(panel).toHaveTextContent("Approved for a different selection: through v1.0.2 (3 migrations)");
    expect(panel).toHaveTextContent("has changed since it was approved");
    // There is nothing to select: it is already the selected range.
    expect(screen.queryByRole("button", { name: "Select that range" })).not.toBeInTheDocument();
  });

  it("offers the other range when it can still be selected", () => {
    let selected = 0;
    show({ otherApproval: other(), onSelectOther: () => (selected += 1) });

    fireEvent.click(screen.getByRole("button", { name: "Select that range" }));
    expect(selected).toBe(1);
  });

  it("says why the other range cannot be selected when it cannot", () => {
    const panel = show({ otherApproval: other() });

    expect(panel).toHaveTextContent("v2.0.0 is not pending any more, so that range cannot be selected here");
    expect(screen.queryByRole("button", { name: "Select that range" })).not.toBeInTheDocument();
  });

  it("drops the whole aside once an approval does cover this run", () => {
    const panel = show({
      approved: row({ status: "approved" }),
      otherApproval: other(),
      onSelectOther: () => {},
    });

    // The aside exists to explain a refusal. Beside a cleared run it reads as a
    // second, competing approval.
    expect(panel).not.toHaveTextContent("Approved for a different selection");
    expect(screen.queryByRole("button", { name: "Select that range" })).not.toBeInTheDocument();
  });

  it("never offers another range on a rollback", () => {
    // A rollback's approval covers one fixed set of versions, so there is no
    // other range to move to — and a button that moved the selection here would
    // change which SQL is about to be undone.
    const panel = show({
      action: "revert",
      versionsLabel: "v3.0.0",
      otherApproval: other(),
      onSelectOther: () => {},
    });

    expect(panel).not.toHaveTextContent("Approved for a different selection");
  });
});

describe("the hash the panel matches an approval by", () => {
  const RUN: ApprovalScript[] = [
    { scriptName: "invoices", version: "1.0.1", sqlContent: "ALTER TABLE invoices ADD COLUMN due_date date;" },
    { scriptName: "invoices", version: "1.0.2", sqlContent: "ALTER TABLE invoices ADD COLUMN notes text;" },
  ];

  it("reaches the same hex the server stored", async () => {
    // The one assertion in this file that is not about wording, and the one
    // failure nothing else would catch: the server hashes with node:crypto and
    // this panel with the Web Crypto API. If those ever disagreed, every
    // approval would be recorded under one hex and looked up under another, so
    // a genuinely approved run would read as unapproved for ever —
    // and the page suites would not notice, because they hash both sides of
    // their own fixtures with this same function.
    await expect(sha256Hex(fingerprintBody(RUN))).resolves.toBe(runFingerprint(RUN, "deploy"));
  });

  it("reaches the server's rollback hex too", async () => {
    await expect(sha256Hex(rollbackFingerprintBody(RUN))).resolves.toBe(runFingerprint(RUN, "revert"));
  });

  it("gives a deploy and a rollback of the same SQL different hexes", async () => {
    // Both kinds share one approvals table. Equal hexes would let an approval
    // for one be spent on the other, which is the opposite change to a database.
    await expect(sha256Hex(fingerprintBody(RUN))).resolves.not.toBe(
      await sha256Hex(rollbackFingerprintBody(RUN))
    );
  });

  it("is the plain SHA-256 of the text, with no salt or truncation", async () => {
    // A fixed vector rather than another call to the same helper: an assertion
    // written as "hash(x) === hash(x)" passes on any implementation at all.
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

