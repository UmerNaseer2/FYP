/** @jest-environment jsdom */

/**
 * The two-person rule as the operator reads it, and the browser-side hash that
 * decides whether an approval covers the run on screen.
 *
 * Nothing in this panel can start a deploy. The gate is the apply route's: it
 * claims an approval row before it runs any SQL, and refuses if none covers the
 * run. What the panel does is *report* — who asked, who cleared it, and whether
 * the approval still covers the SQL currently selected — and a panel that
 * reports wrongly is how a production run gets pressed by somebody who believed
 * a second person had read it. So the tests below are about sentences: which
 * state the panel claims, which button it offers to whom, and which of the
 * near-miss states it refuses to round off into "cleared".
 *
 * The hash has its own block at the end. It is the one thing in this file that
 * is not a sentence, and the only one that can make an approval which genuinely
 * covers a run read as one that does not.
 *
 * What is NOT here:
 *  - Enforcement. Whether a run can actually start turns on the apply and
 *    revert routes claiming a row, which tests/approvals-action.test.ts and
 *    tests/deploy-safety.test.ts cover against the database calls themselves.
 *    Every button below is offered or withheld; none of them is a gate.
 *  - Working out WHICH row is `approved`, `pending`, `latest` or
 *    `otherApproval`. The panel is handed four rows already sorted; the pages
 *    that sort them (Deploy, Version Sync) are covered by their own suites, and
 *    duplicating that here would test the fixture rather than the panel.
 *  - What happens after a button is pressed. onRequest and onDecide are the
 *    page's, and the requests they make are covered where they are made.
 *  - The `appr--ok` / `appr--wait` / `appr--no` class, which is colour. The
 *    words carry the state, and a test that pinned the class would pass on a
 *    panel whose sentence said the opposite.
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

import { ApprovalPanel, sha256Hex, type ApprovalRow } from "@/components/studio/ApprovalPanel";
import { fingerprintBody, rollbackFingerprintBody, type ApprovalScript } from "@/lib/approval-fingerprint";
import { runFingerprint } from "@/lib/approvals-db";

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
  isAdmin: true,
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

afterEach(() => cleanup());

describe("before there is anything to say", () => {
  it("does not ask for an approval when no migrations are selected", () => {
    const panel = show({ migrationCount: 0 });

    expect(panel).toHaveTextContent(
      "Pick a target version first — an approval covers one exact set of migrations"
    );
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
    expect(screen.queryByText("Needs a second person")).not.toBeInTheDocument();
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
    expect(screen.queryByText("Needs a second person")).not.toBeInTheDocument();
  });
});

describe("a list nobody could read", () => {
  it("says the state is unknown rather than reporting it as unapproved", () => {
    const panel = show({ unreadable: true, error: "connection refused" });

    // The failure that matters is the other direction — an unreadable list
    // falling through to "Needs a second person" reports the approval state as
    // read when nothing read it.
    expect(screen.getByText("Approval state unknown")).toBeInTheDocument();
    expect(panel).toHaveTextContent("this page cannot say whether this run is cleared");
    expect(panel).toHaveTextContent("The server checks again when you press Deploy");
    expect(panel).toHaveTextContent("connection refused");
    expect(screen.queryByText("Needs a second person")).not.toBeInTheDocument();
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

describe("who may clear a request", () => {
  it("offers both decisions to a second person", () => {
    const decisions: [number, string][] = [];
    show({
      pending: row(),
      onDecide: (id, decision) => decisions.push([id, decision]),
    });

    expect(screen.getByText("Waiting for a second person")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve this run" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(decisions).toEqual([
      [11, "approve"],
      [11, "reject"],
    ]);
  });

  it("withholds them from the person who asked", () => {
    const panel = show({ pending: row({ requested_by: "me@example.com" }) });

    expect(panel).toHaveTextContent("You asked for this deploy, so you cannot approve it.");
    expect(panel).toHaveTextContent("A production run needs a second person.");
    expect(screen.queryByRole("button", { name: /^Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("treats an address that differs only in case as the same person", () => {
    // Email local parts are case-insensitive in every mailbox anyone signs in
    // with here, and the server's own check lowercases both sides. A panel that
    // compared them raw would hand the requester the Approve button and then
    // watch the server refuse the decision they were invited to make.
    show({ pending: row({ requested_by: "Me@Example.COM" }) });

    expect(screen.queryByRole("button", { name: /^Approve/ })).not.toBeInTheDocument();
  });

  it("withholds them from a non-admin who did not ask either", () => {
    const panel = show({ isAdmin: false, pending: row() });

    expect(panel).toHaveTextContent("Clearing a production run needs the admin role.");
    expect(screen.queryByRole("button", { name: /^Approve/ })).not.toBeInTheDocument();
    // No note box either: it is only read back off an approval this person
    // cannot record.
    expect(screen.queryByLabelText(/Note for the approval record/)).not.toBeInTheDocument();
  });

  it("lets the one principal under the bypass clear their own request", () => {
    // With the bypass on everyone is the same principal, so the requester is
    // also the only possible approver. The server allows it and marks the row
    // self_approved; refusing here would leave a production deploy that nobody
    // in the whole install could ever clear.
    const panel = show({ bypass: true, pending: row({ requested_by: "me@example.com" }) });

    expect(screen.getByText("Waiting for your approval")).toBeInTheDocument();
    expect(panel).toHaveTextContent("there is only one principal, so you clear these migrations yourself");
    expect(screen.getByRole("button", { name: "Approve this run" })).toBeEnabled();
  });

  it("still names a second person under the bypass when someone else asked", () => {
    // The bypass makes the viewer the sole approver, not the sole requester: a
    // row written before the bypass was turned on still carries another name.
    const panel = show({ bypass: true, pending: row({ requested_by: "asker@example.com" }) });

    expect(screen.getByText("Waiting for a second person")).toBeInTheDocument();
    expect(panel).toHaveTextContent("Someone else has to read these migrations and clear them");
  });

  it("holds both decisions while one is in flight", () => {
    show({ busy: true, pending: row() });

    expect(screen.getByRole("button", { name: "Approve this run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("names the rollback in the refusal a requester gets", () => {
    const panel = show({
      action: "revert",
      versionsLabel: "v3.0.0 and v2.0.0",
      pending: row({ requested_by: "me@example.com" }),
    });

    expect(panel).toHaveTextContent("You asked for this rollback, so you cannot approve it.");
    expect(panel).toHaveTextContent("A rollback on production needs a second person.");
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

    expect(screen.getByText("Approved by a second person")).toBeInTheDocument();
    expect(panel).toHaveTextContent("Cleared for exactly these 2 migrations through v1.0.2");
    expect(panel).toHaveTextContent("Edit any of the SQL and this stops applying.");
    expect(panel).toHaveTextContent(
      "Requested by asker@example.com · approved by boss@example.com · 2026-09-18 09:30 UTC"
    );
  });

  it("says migration once when there is one", () => {
    const panel = show({ migrationCount: 1, approved: row({ status: "approved", migration_count: 1 }) });

    expect(panel).toHaveTextContent("Cleared for exactly these 1 migration through");
    expect(panel).not.toHaveTextContent("1 migrations");
  });

  it("does not call a self-approval a second person", () => {
    // A self-approval is only possible under the bypass, and the row records it
    // as one. Reading it back as "Approved by a second person" would state the
    // opposite of what the audit log holds.
    const panel = show({
      approved: row({ status: "approved", self_approved: true, decided_by: "me@example.com" }),
    });

    expect(screen.getByText("Self-approved under the auth bypass")).toBeInTheDocument();
    expect(screen.queryByText("Approved by a second person")).not.toBeInTheDocument();
    expect(panel).toHaveTextContent("Recorded on the row as a self-approval");
  });

  it("says when the approval stops covering the run", () => {
    // Nothing breaks at that moment — the run simply reads as unapproved
    // again — so the reader has to be told before they plan around it.
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
    // A rollback's approval covers the rollback SQL of specific versions, and
    // "2 migrations" would be both the wrong noun and the wrong direction.
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
    // Without this line the panel says "Needs a second person" while the
    // approver insists they approved it — and they did, before the SQL moved.
    const panel = show({ otherApproval: other({ target_version: "1.0.2" }) });

    expect(screen.getByText("Needs a second person")).toBeInTheDocument();
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

describe("what the reader is told about earlier attempts", () => {
  it("repeats a rejection and who wrote it", () => {
    const panel = show({
      latest: row({ status: "rejected", decided_by: "boss@example.com", note: "wait for the window" }),
    });

    expect(panel).toHaveTextContent(
      'The last request for this exact SQL was rejected by boss@example.com — "wait for the window".'
    );
    // Asking again is allowed; the button says which it is, so nobody requests
    // a second time believing it is the first.
    expect(screen.getByRole("button", { name: "Request approval again" })).toBeEnabled();
  });

  it("says when an approval for this SQL has already been spent", () => {
    // The row is approved and the run is not: an approval is good for one run,
    // and without this the panel reads as though nobody ever cleared it.
    const panel = show({ latest: row({ status: "used" }) });

    expect(panel).toHaveTextContent("has already been spent on a run");
  });

  it("says spent on a rollback when that is what spent it", () => {
    const panel = show({ action: "revert", versionsLabel: "v3.0.0", latest: row({ status: "used" }) });

    expect(panel).toHaveTextContent("has already been spent on a rollback");
  });

  it("calls it the first request when there has been none", () => {
    show({});

    expect(screen.getByRole("button", { name: "Request approval" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Request approval again" })).not.toBeInTheDocument();
  });

  it("asks for an approval, not a second person, when the viewer is the only one", () => {
    const panel = show({ bypass: true });

    expect(screen.getByText("Needs an approval")).toBeInTheDocument();
    expect(screen.queryByText("Needs a second person")).not.toBeInTheDocument();
    expect(panel).toHaveTextContent("you request it and then clear it yourself");
  });
});

describe("the note", () => {
  it("is labelled for the approver when the requester writes it", () => {
    const typed: string[] = [];
    show({ onNoteChange: (value) => typed.push(value) });

    const box = screen.getByLabelText("Note for the record — shown to whoever approves this");
    fireEvent.change(box, { target: { value: "ticket 412" } });
    expect(typed).toEqual(["ticket 412"]);
  });

  it("is labelled for the record when the approver writes it", () => {
    const typed: string[] = [];
    show({ pending: row(), onNoteChange: (value) => typed.push(value) });

    fireEvent.change(screen.getByLabelText("Note for the approval record"), {
      target: { value: "read it all" },
    });
    expect(typed).toEqual(["read it all"]);
  });

  it("shows a placeholder and a real value apart", () => {
    // A placeholder vanishes on the first keystroke and is never stored; this
    // note is read back later as audit copy, so the box must not look filled in
    // when it is empty.
    show({ note: "" });

    const box = screen.getByLabelText("Note for the record — shown to whoever approves this");
    expect(box).toHaveValue("");
    expect(box).toHaveAttribute("placeholder", "Optional note for the approver");
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
    // a genuinely approved production run would read as unapproved for ever —
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
