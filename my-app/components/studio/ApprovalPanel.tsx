"use client";

// ---------------------------------------------------------------------------
// The two-person rule on screen (ApprovalPanel), and the browser-side hash
// that tells it whether an approval covers the run on screen (sha256Hex).
// They lived in the Deploy page; they live here so Version Sync's replay
// dialog reads and requests approvals with the same panel and the same hash.
// Moving them changed nothing about how they behave.
// ---------------------------------------------------------------------------
import { CheckIcon, UsersIcon, XIcon } from "@/components/ui/icons";
import { utcStamp } from "@/lib/format-date";
import { countOf } from "@/lib/plural";
import { vLabel } from "@/lib/rollback-plan";
import { versionKey } from "@/lib/script-status";

// ── Deploy approvals (the two-person rule) ─────────────────────────────────
// One row of `deploy_approvals`, exactly as /api/deploy/approvals returns it.
// Mirrors DeployApproval in lib/approvals-db, which cannot be imported here —
// that module opens a database pool, and this file runs in the browser.
export type ApprovalRow = {
  id: number;
  target_version: string;
  run_fingerprint: string;
  migration_count: number;
  breaking_count: number;
  requested_by: string;
  requested_at: string;
  status: "pending" | "approved" | "rejected" | "used";
  decided_by: string | null;
  decided_at: string | null;
  self_approved: boolean;
  note: string | null;
  used_at: string | null;
  /**
   * Which route may spend it: "deploy" for a migration run, "revert" for a
   * rollback. Optional because an older route did not send it, and every row
   * from before rollbacks needed approval was a deploy.
   */
  action?: "deploy" | "revert";
};

/**
 * Hash the text of a run the same way the server does.
 *
 * The server uses node:crypto and this uses the Web Crypto API, but both hash
 * the string lib/approval-fingerprint builds, so the two hex strings match and
 * this screen can tell whether the run in front of the user is the approved
 * one. crypto.subtle only exists in a secure context — https or localhost — so
 * the caller has to cope with this throwing rather than assume it cannot.
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The two-person rule, on screen.
 *
 * The gate itself is the apply route's: it claims an approval row before it
 * runs anything, so nothing here can talk a production deploy into starting.
 * What this panel does is make the state readable — who asked, who cleared it,
 * and whether the approval still covers the SQL currently selected — and give
 * the two people the buttons for their halves of it.
 *
 * An approval is pinned to a fingerprint of the exact SQL. That is why the
 * panel says "these N migrations" rather than "this deploy": change one
 * character of one migration and the approval stops matching, which is the
 * point of having one.
 */
export function ApprovalPanel({
  action = "deploy",
  migrationCount,
  targetVersion,
  versionsLabel = "",
  hashReady,
  hashError,
  loading,
  error,
  unreadable,
  busy,
  approved,
  pending,
  latest,
  viewerEmail,
  isAdmin,
  bypass,
  note,
  onNoteChange,
  onRequest,
  onDecide,
  otherApproval = null,
  onSelectOther,
  runButton,
}: {
  /**
   * What the approval clears. "revert" is a rollback: it covers the rollback
   * SQL of the versions being undone, and only the revert route can spend it,
   * so every sentence below names a rollback instead of a run.
   */
  action?: "deploy" | "revert";
  /**
   * How many migrations the run holds, or, for a rollback, how many versions
   * it undoes. 0 means there is nothing an approval could cover yet.
   */
  migrationCount: number;
  targetVersion: string;
  /** For a rollback: the versions it undoes, as "v3.0.0 and v2.0.0". */
  versionsLabel?: string;
  /** False until the run's fingerprint has been computed in the browser. */
  hashReady: boolean;
  hashError: string | null;
  loading: boolean;
  error: string | null;
  /** The list could not be read at all — not the same as "there are none". */
  unreadable: boolean;
  busy: boolean;
  /** The approval that covers this exact run, if there is one. */
  approved: ApprovalRow | null;
  pending: ApprovalRow | null;
  /** Newest row for this run whatever its state — explains a rejection. */
  latest: ApprovalRow | null;
  viewerEmail: string;
  isAdmin: boolean;
  bypass: boolean;
  note: string;
  onNoteChange: (value: string) => void;
  onRequest: () => void;
  onDecide: (id: number, decision: "approve" | "reject") => void;
  /**
   * Deploy only: the newest approved, unspent approval for this target whose
   * fingerprint is not this run's (it was approved for another range, or for
   * SQL that has changed since). Shown only while `approved` is null, so the
   * panel never says "Needs a second person" next to an approval without
   * saying why that approval does not count.
   */
  otherApproval?: ApprovalRow | null;
  /**
   * Selects the range `otherApproval` covers. Pass it whenever that version
   * is still pending; leave it out when it is not, and the panel says it can
   * no longer be selected. Not used when it is the version already selected.
   */
  onSelectOther?: () => void;
  /**
   * The name of the button that spends the approval, for the sentence that
   * says the server checks again when it is pressed. Defaults to "Deploy",
   * or "Roll back" for a rollback.
   */
  runButton?: string;
}) {
  if (migrationCount === 0) {
    return (
      <div className="appr">
        <div className="appr__head" style={{ color: "var(--text-2)" }}>
          <UsersIcon size={15} className="ico" />
          <span>Approval</span>
        </div>
        <p className="appr__body">
          {action === "revert"
            ? "Nothing to approve yet — an approval covers the exact rollback SQL " +
              "that will run, and not every version above has a rollback that can run."
            : "Pick a target version first — an approval covers one exact set of " +
              "migrations, so there is nothing to approve yet."}
        </p>
      </div>
    );
  }

  if (hashError || !hashReady || loading) {
    return (
      <div className="appr">
        <div className="appr__head" style={{ color: "var(--text-2)" }}>
          <UsersIcon size={15} className="ico" />
          <span>Approval</span>
        </div>
        <p className="appr__body">
          {hashError
            ? hashError
            : hashReady
              ? "Reading the approvals for this target…"
              : action === "revert"
                ? "Working out which approval covers this rollback…"
                : "Working out which approval covers this run…"}
        </p>
      </div>
    );
  }

  // An unreadable list is not an empty one — the same rule this page already
  // states for connections. Falling through to "Needs a second person" reports
  // the approval state as read when nothing managed to read it.
  if (unreadable) {
    return (
      <div className="appr appr--wait">
        <div className="appr__head">
          <UsersIcon size={15} className="ico" />
          <span>Approval state unknown</span>
        </div>
        <p className="appr__body">
          {action === "revert"
            ? "The approvals for this target could not be read, so this page cannot " +
              "say whether this rollback is cleared. The server checks again when you " +
              `press ${runButton ?? "Roll back"}, and refuses the rollback if nothing covers it.`
            : "The approvals for this target could not be read, so this page cannot " +
              "say whether this run is cleared. The server checks again when you " +
              `press ${runButton ?? "Deploy"}, and refuses the run if nothing covers it.`}
        </p>
        {error && (
          <p className="appr__meta" style={{ color: "var(--break)" }}>
            {error}
          </p>
        )}
      </div>
    );
  }

  // Why this person may not decide this request. The same rule runs server-side
  // and again as a CHECK constraint on the table — this copy exists so the
  // button is not offered in the first place, not to enforce anything.
  const selfDecision =
    pending !== null &&
    !bypass &&
    pending.requested_by.toLowerCase() === viewerEmail.toLowerCase();

  // Under the auth bypass everyone is the same principal, so the person who
  // asked is also the only one who can clear it — the server allows that and
  // marks the row self_approved. "Someone else has to clear them" above an
  // Approve button offered to the requester would contradict itself, and so
  // would "Needs a second person" before anything has been requested.
  const soleApprover = bypass && isAdmin;
  const bypassSelf =
    pending !== null &&
    soleApprover &&
    pending.requested_by.toLowerCase() === viewerEmail.toLowerCase();
  const pendingWhy = bypassSelf
    ? action === "revert"
      ? " With the auth bypass on there is only one principal, so you clear these " +
        "rollbacks yourself, and the row records it as a self-approval."
      : " With the auth bypass on there is only one principal, so you clear these " +
        "migrations yourself, and the row records it as a self-approval."
    : action === "revert"
      ? " Someone else has to read these rollbacks and clear them before the " +
        "rollback can run."
      : " Someone else has to read these migrations and clear them before the " +
        "run can start.";

  const tone = approved ? "ok" : pending ? "wait" : "no";

  // Why the approval named under the panel does not clear this run. With a
  // different target the range says it; with the same target, what runs
  // through it changed after the approval; with no way to select it, that
  // version has already run or left the registry.
  let otherWhy = "";
  if (otherApproval) {
    const otherTarget = vLabel(otherApproval.target_version);
    if (versionKey(otherApproval.target_version) === versionKey(targetVersion)) {
      otherWhy =
        ` What runs through ${otherTarget} has changed since it was approved (a migration’s ` +
        "SQL, or which migrations are pending), so it does not clear this run.";
    } else if (!onSelectOther) {
      otherWhy = ` ${otherTarget} is not pending any more, so that range cannot be selected here.`;
    }
  }

  return (
    <div className={`appr appr--${tone}`}>
      <div className="appr__head">
        {approved ? <CheckIcon size={15} className="ico" /> : <UsersIcon size={15} className="ico" />}
        <span>
          {/* A self-approval is only possible under the auth bypass. Calling it
              "a second person" would contradict the line below that says so.
              Under the bypass nobody else exists to wait for either, so the
              waiting and needed states do not name one. */}
          {approved
            ? approved.self_approved
              ? "Self-approved under the auth bypass"
              : "Approved by a second person"
            : pending
              ? bypassSelf
                ? "Waiting for your approval"
                : "Waiting for a second person"
              : soleApprover
                ? "Needs an approval"
                : "Needs a second person"}
        </span>
      </div>

      {approved ? (
        <>
          {action === "revert" ? (
            <p className="appr__body">
              Cleared to undo exactly {versionsLabel}, with the rollback SQL shown
              above, and good for one rollback. If any of that SQL changes, this
              stops applying.
            </p>
          ) : (
            <p className="appr__body">
              Cleared for exactly these {migrationCount} migration
              {migrationCount === 1 ? "" : "s"}
              {targetVersion ? <> through <span className="mono">{vLabel(targetVersion)}</span></> : null}, and
              good for one run. Edit any of the SQL and this stops applying.
            </p>
          )}
          <p className="appr__meta">
            Requested by {approved.requested_by} · approved by{" "}
            {approved.decided_by ?? "—"}
            {utcStamp(approved.decided_at) ? ` · ${utcStamp(approved.decided_at)}` : ""}
          </p>
          {approved.self_approved && (
            <p className="appr__meta">
              Recorded on the row as a self-approval, because with the bypass on
              there is only one principal to be.
            </p>
          )}
          {approved.note && <p className="appr__meta">Note: {approved.note}</p>}
        </>
      ) : pending ? (
        <>
          <p className="appr__body">
            Requested by {pending.requested_by}
            {utcStamp(pending.requested_at) ? ` · ${utcStamp(pending.requested_at)}` : ""}.
            {pendingWhy} A dry run does not need it.
          </p>
          {pending.note && <p className="appr__meta">Note: {pending.note}</p>}
          {!isAdmin ? (
            <p className="appr__meta">
              {action === "revert"
                ? "Clearing a production rollback needs the admin role."
                : "Clearing a production run needs the admin role."}
            </p>
          ) : selfDecision ? (
            // The server's own words (decisionBlockReason in lib/approvals-db),
            // so this line and the refusal it would give read the same.
            <p className="appr__meta">
              {action === "revert"
                ? "You asked for this rollback, so you cannot approve it. " +
                  "A rollback on production needs a second person."
                : "You asked for this deploy, so you cannot approve it. " +
                  "A production run needs a second person."}
            </p>
          ) : (
            <>
              {/* A placeholder is not a name: it vanishes on the first
                  keystroke, and this note is read back later as audit copy. */}
              <input
                className="input mt-2"
                style={{ fontSize: "12px" }}
                aria-label="Note for the approval record"
                placeholder="Optional note for the record"
                value={note}
                onChange={(event) => onNoteChange(event.target.value)}
              />
              <p className="text-[11.5px] mt-1" style={{ color: "var(--text-3)" }}>
                Stored with the approval and shown in the audit log.
              </p>
              <div className="appr__actions">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => onDecide(pending.id, "approve")}
                >
                  <CheckIcon size={13} />
                  {action === "revert" ? "Approve this rollback" : "Approve this run"}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  disabled={busy}
                  onClick={() => onDecide(pending.id, "reject")}
                >
                  <XIcon size={13} />
                  Reject
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <p className="appr__body">
            {soleApprover
              ? action === "revert"
                ? "This target is labelled production, so the rollback needs an " +
                  "approval. With the auth bypass on there is only one principal, so " +
                  "you request it and then clear it yourself."
                : "This target is labelled production, so the run needs an approval. " +
                  "With the auth bypass on there is only one principal, so you " +
                  "request it and then clear it yourself."
              : action === "revert"
                ? "This target is labelled production, so the rollback needs an " +
                  "approval from someone other than you."
                : "This target is labelled production, so the run needs an approval " +
                  "from someone other than you."}
            {latest?.status === "rejected" ? (
              <>
                {" "}
                The last request for this exact SQL was rejected by{" "}
                {latest.decided_by ?? "someone"}
                {latest.note ? ` — "${latest.note}"` : ""}.
              </>
            ) : latest?.status === "used" ? (
              <>
                {" "}
                {action === "revert"
                  ? "An earlier approval for this exact SQL has already been spent on a rollback."
                  : "An earlier approval for this exact SQL has already been spent on a run."}
              </>
            ) : null}
          </p>
          <input
            className="input mt-2"
            style={{ fontSize: "12px" }}
            aria-label="Note for the record — shown to whoever approves this"
            placeholder="Optional note for the approver"
            value={note}
            onChange={(event) => onNoteChange(event.target.value)}
          />
          <p className="text-[11.5px] mt-1" style={{ color: "var(--text-3)" }}>
            Whoever approves this will see it.
          </p>
          <div className="appr__actions">
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={busy}
              onClick={onRequest}
            >
              <UsersIcon size={13} />
              {latest ? "Request approval again" : "Request approval"}
            </button>
          </div>
        </>
      )}

      {/* An approval that is on the list but clears a different run. Without
          this line the panel says "Needs a second person" while the approver
          insists they approved it. Deploy only: a rollback's approval covers
          one fixed set of versions, so there is no other range to pick. */}
      {!approved && action === "deploy" && otherApproval ? (
        <div className="appr__other">
          <p className="appr__meta">
            Approved for a different selection: through{" "}
            <span className="mono">{vLabel(otherApproval.target_version)}</span> (
            {countOf(otherApproval.migration_count, "migration")}).{otherWhy}
          </p>
          {onSelectOther && versionKey(otherApproval.target_version) !== versionKey(targetVersion) && (
            <div className="appr__actions">
              {/* Selects, never runs: the gates and the Deploy button still
                  stand between this click and the database. */}
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={busy}
                onClick={onSelectOther}
              >
                Select that range
              </button>
            </div>
          )}
        </div>
      ) : null}

      {error && (
        <p className="appr__meta" style={{ color: "var(--break)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
