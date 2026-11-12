"use client";

// ---------------------------------------------------------------------------
// Asking for approval of one exact run, on screen (ApprovalPanel), and the browser-side hash
// that tells it whether an approval covers the run on screen (sha256Hex).
// They lived in the Deploy page; they live here so Version Sync's replay
// dialog reads and requests approvals with the same panel and the same hash.
// Moving them changed nothing about how they behave.
// ---------------------------------------------------------------------------
import { CheckIcon, UsersIcon, XIcon } from "@/components/ui/icons";
import { utcStamp } from "@/lib/format-date";
import { permissionLabel } from "@/lib/permissions";
import { countOf } from "@/lib/plural";
import { vLabel } from "@/lib/rollback-plan";
import { versionKey } from "@/lib/script-status";
import { HelpHint } from "@/components/ui/HelpHint";
import { AskAdmin } from "./AskAdmin";

/** How an approval works, one click away beside the panel's title. */
function ApprovalHint() {
  return (
    <HelpHint label="Approval">
      An approval covers one run of this exact SQL. Change the SQL and it needs
      approving again.
    </HelpHint>
  );
}

// ── Deploy approvals ───────────────────────────────────────────────────────
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
  /**
   * When the approval stops authorising the run. Optional, and null on a row
   * decided before approvals expired at all — those stay good.
   */
  expires_at?: string | null;
  /**
   * True when the person who asked may not run this by themselves, so the
   * approval is a one-off that only they can spend. Optional: older routes
   * did not send it, and every older row was an ordinary approval.
   */
  run_by_requester?: boolean;
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
 * An ask for approval, on screen.
 *
 * Somebody whose role may not run on a target asks for approval of one exact
 * run, and an Admin (or whoever may approve) answers. The gate itself is the
 * apply route's: it claims an approval row before it runs anything, so
 * nothing here can talk a run into starting. This panel makes the state
 * readable (who asked, who approved it, and whether the approval still
 * covers the SQL currently selected) and gives each side its buttons.
 *
 * With `askToRun` it is the asker's panel. Without it, it is the answer
 * panel: the page passes somebody else's waiting ask as `pending`.
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
  roleLabel,
  askToRun = false,
  mayApprove,
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
  /** The viewer's role as people read it, for the lines that say what it may not do. */
  roleLabel: string;
  /**
   * The viewer may not run this by themselves (their role, or the
   * connection's "who may run"), so the approval is them asking an Admin for
   * this one run. They may always ask, and never answer their own request.
   * When false, this is the answer panel for somebody else's ask.
   */
  askToRun?: boolean;
  /** The role may clear one ("Approvals: Approve"). Admins always may. */
  mayApprove: boolean;
  bypass: boolean;
  note: string;
  onNoteChange: (value: string) => void;
  onRequest: () => void;
  onDecide: (id: number, decision: "approve" | "reject") => void;
  /**
   * Deploy only: the newest approved, unspent approval for this target whose
   * fingerprint is not this run's (it was approved for another range, or for
   * SQL that has changed since). Shown only while `approved` is null, so the
   * panel never says an approval is needed next to an approval without
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
          <ApprovalHint />
        </div>
        <p className="appr__body">
          {action === "revert"
            ? "Nothing to approve yet: not every version above has a rollback that can run."
            : "Pick a target version first. There is nothing to approve yet."}
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
  // states for connections. Falling through to "Needs an approval" reports
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

  // Nobody answers their own ask. The same rule runs on the server and again
  // as a CHECK constraint on the table. This copy exists so the button is not
  // offered in the first place, not to enforce anything.
  const mine = pending !== null && pending.requested_by.toLowerCase() === viewerEmail.toLowerCase();
  const what = action === "revert" ? "rollback" : "run";
  const pendingWhy = askToRun
    ? ` Your role may not do this ${what} by itself, so an Admin has to approve it. ` +
      `Once they do, you can run it once, within 7 days.`
    : mine
      ? ""
      : ` Their role may not do this ${what} by itself. Read the SQL above, then approve or reject it.`;

  // What this role may not do here. Under the auth bypass the way round it is
  // View as rather than an admin: whoever is testing already is the admin,
  // looking at the app as another role.
  const switchBack = 'Switch "View as" back to Admin to do that.';
  const approveRefusal =
    `Your role (${roleLabel}) can't approve a ${what}. ` +
    (bypass
      ? switchBack
      : `Ask an admin to turn on "${permissionLabel("approvals:approve")}" for this role.`);

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
          {askToRun
            ? approved
              ? "Approved for you, once"
              : pending
                ? "Waiting for an Admin"
                : "Needs an Admin's approval"
            : approved
              ? "Approved"
              : pending
                ? mine
                  ? "Waiting for somebody else"
                  : "Waiting for your answer"
                : "Needs an approval"}
        </span>
        <ApprovalHint />
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
              Cleared for exactly {migrationCount === 1 ? "this migration" : `these ${migrationCount} migrations`}
              {targetVersion ? <> through <span className="mono">{vLabel(targetVersion)}</span></> : null}, and
              good for one run. Edit any of the SQL and this stops applying.
            </p>
          )}
          <p className="appr__meta">
            Requested by {approved.requested_by} · approved by{" "}
            {approved.decided_by ?? "—"}
            {utcStamp(approved.decided_at) ? ` · ${utcStamp(approved.decided_at)}` : ""}
          </p>
          {utcStamp(approved.expires_at ?? null) && (
            // Said on the screen because it changes what the reader can rely
            // on: after this, the same run needs asking again. Nothing breaks
            // at that moment — the run simply reads as unapproved.
            <p className="appr__meta">
              Good until {utcStamp(approved.expires_at ?? null)}; after that this run
              needs approving again.
            </p>
          )}
          {approved.note && <p className="appr__meta">Note: {approved.note}</p>}
        </>
      ) : pending ? (
        <>
          <p className="appr__body">
            Requested by {pending.requested_by}
            {utcStamp(pending.requested_at) ? ` · ${utcStamp(pending.requested_at)}` : ""}.
            {pendingWhy}
          </p>
          {pending.note && <p className="appr__meta">Note: {pending.note}</p>}
          {askToRun && mine ? (
            <p className="appr__meta">
              Admins see it on their Requests page, and you see their answer here.
            </p>
          ) : mine ? (
            // The server's own words (decisionBlockReason in lib/approvals-db),
            // so this line and the refusal it would give read the same.
            <p className="appr__meta">
              {action === "revert"
                ? "You asked for this rollback, so somebody else has to approve it."
                : "You asked for this run, so somebody else has to approve it."}
            </p>
          ) : !mayApprove ? (
            <p className="appr__meta">
              {approveRefusal}
              <AskAdmin permission="approvals:approve" />
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
            {askToRun
              ? `Your role (${roleLabel}) may not ${
                  action === "revert" ? "roll back" : "run migrations"
                } on this connection by itself. Ask an Admin to approve this exact ${what}. ` +
                `Once they do, you can run it once, within 7 days. If the SQL changes, it needs approving again.`
              : `Somebody whose role may not do this ${what} by itself can ask for approval of it. ` +
                `Nobody has asked for this exact ${what}.`}
            {latest?.status === "rejected" ? (
              <>
                {" "}
                The last request for this exact SQL was rejected by{" "}
                {latest.decided_by ?? "someone"}
                {latest.note ? `, with the note "${latest.note}"` : ""}.
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
          {askToRun && (
            <>
              <input
                className="input mt-2"
                style={{ fontSize: "12px" }}
                aria-label="Note for the record, shown to whoever approves this"
                placeholder="Optional note for the approver"
                value={note}
                onChange={(event) => onNoteChange(event.target.value)}
              />
              <div className="appr__actions">
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  disabled={busy}
                  onClick={onRequest}
                >
                  <UsersIcon size={13} />
                  {latest ? "Ask for approval again" : "Ask for approval"}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {/* An approval that is on the list but clears a different run. Without
          this line the panel says an approval is needed while the approver
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
