"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DeployIcon,
  RefreshIcon,
  CheckIcon,
  XIcon,
  AlertCircleIcon,
  AlertTriangleIcon,
  DriftIcon,
  InfoIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  EyeIcon,
  LogoIcon,
  UsersIcon,
} from "@/components/ui/icons";
import {
  compareVersions,
  buildVersionLedger,
  type LedgerEntry,
} from "@/lib/script-status";
import { containsTransactionControl, findRowDestroyingStatements } from "@/lib/sql-guard";
import { changeTypeOf, type ScriptChangeType } from "@/lib/change-type";
import { countOf } from "@/lib/plural";
import { Select } from "@/components/ui/Select";
import { EnvironmentPill } from "@/components/ui/EnvironmentPill";
import {
  isProduction,
  louderEnvironment,
  toEnvironment,
  DEFAULT_ENVIRONMENT,
  type Environment,
} from "@/lib/environments";
import { fingerprintBody } from "@/lib/approval-fingerprint";
import { useUser } from "@/hooks/useUser";

// ---------------------------------------------------------------------------
// Deploy (S5) — Pre-flight → Run → Verify stepper.
//
// This is the Pass-6 reskin of the deploy panel that used to live inside the
// legacy /scripts page. The backend flow is reused verbatim (it is proven):
//   • GitHub is the source of truth for migration scripts (/api/github/pull).
//   • /api/scripts/preflight reads the target DB's script_patch ledger and
//     tells us the current version + applied history.
//   • pendingScripts = GitHub scripts for (schema, group) whose semver is
//     greater than the target's current version.
//   • /api/scripts/apply takes the WHOLE batch in one request and runs it in
//     one transaction. All of them or none of them — a failure anywhere rolls
//     the run back, so there is no partial deploy to unwind by hand. The same
//     call with dryRun rehearses the batch and always ends in ROLLBACK.
//
// Honest-stub rule ("stub, don't fake"): two pieces depend on schema snapshots
// that don't exist until a later phase, so they are shown clearly stubbed and
// never wired to fake-but-real-looking data:
//   • the drift pre-check (stage 1) and
//   • the post-deploy verify re-diff (stage 3).
// Everything else — versions, pending list, per-step timing, the ledger
// re-read after a run — is real.
// ---------------------------------------------------------------------------

// The deploy screen's own name for a script's change type. The grading itself
// lives in lib/change-type, so this screen and the generator can never disagree
// about what a script does.
type ChangeKind = ScriptChangeType;

// A migration script, loaded from the GitHub repo (the source of truth).
type GitHubScript = {
  database_name: string;
  schema_name: string;
  script_name: string;
  version: string;
  path: string;
  sql_content: string;
  /**
   * The rollback saved beside this version in the registry (v<ver>.down.sql).
   * Absent for versions pushed without one.
   */
  down_sql?: string;
};

// A saved connection from /api/connections.
type Connection = {
  id: number;
  name: string;
  host: string;
  port: number;
  database_name: string;
  type: string;
  /** dev / staging / prod, or "unset" when nobody has labelled it. */
  environment: Environment;
};

// One row of the target's applied history.
type PatchEntry = {
  version: string;
  title: string | null;
  change_type: string;
  applied_at: string;
  /** Whether the ledger row kept its own rollback. Optional: an older API. */
  has_down_sql?: boolean;
};

// What /api/scripts/preflight returns.
type PreflightResult = {
  hasVersionTable: boolean;
  needsInit: boolean;
  currentVersion: string | null;
  timeline: PatchEntry[];
  schema: string;
  scriptName: string | null;
  message: string;
};

// Live status of a single migration during a run.
//
// "rehearsed" is a dry run's version of "applied": the SQL really executed
// against the target and then the whole run was rolled back.
type RunStatus =
  | "queued"
  | "running"
  | "applied"
  | "rehearsed"
  | "failed"
  | "skipped";
// `statements` is how many statements PostgreSQL ran for this migration, as the
// server counted them. There is deliberately no per-migration duration: the run
// is one request and one transaction, so the only honest timing is the run's.
type RunCell = { status: RunStatus; error?: string; statements?: number };

// What POST /api/scripts/apply reports for one migration in the run.
type ApplyOutcome = {
  script_name: string;
  version: string;
  status: "applied" | "rehearsed" | "failed" | "skipped";
  statements?: number;
  error?: string;
};
// The parts of the apply response this page reads.
type ApplyResponse = {
  success?: boolean;
  error?: string;
  results?: ApplyOutcome[];
  message?: string;
  /** Set on a dry run the server could not rehearse — see the 55P04 branch. */
  dryRunLimitation?: boolean;
};

// ── Phase 6 drift pre-check (lineage) ──────────────────────────────────────
// The bits we use from POST /api/lineage/drift. The deploy page shows the
// status + human summary; the full Expected-vs-Actual report belongs to the
// drift detail screen, so we deliberately don't pull it in here.
type DriftCounts = {
  tablesAdded: number;
  tablesRemoved: number;
  tablesChanged: number;
  constraintsChanged: number;
};
type DriftResult = {
  status: "in_sync" | "drifted" | "unreachable";
  summary: string;
  counts: DriftCounts | null;
  expectedVersion: string | null;
  checkedAt: string;
};
// Where the lineage drift check stands for the chosen target.
type DriftPhase = "idle" | "loading" | "untracked" | "ready" | "error";

// ── Deploy approvals (the two-person rule) ─────────────────────────────────
// One row of `deploy_approvals`, exactly as /api/deploy/approvals returns it.
// Mirrors DeployApproval in lib/approvals-db, which cannot be imported here —
// that module opens a database pool, and this file runs in the browser.
type ApprovalRow = {
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
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A short, readable stamp for an approval's timeline. */
function approvalTime(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString();
}

// Version comparison + the Applied/Pending ledger live in lib/script-status so
// they can be unit-tested in isolation; compareVersions is imported above.
function sortGitHubScriptsByVersion(scripts: GitHubScript[]): GitHubScript[] {
  return [...scripts].sort((a, b) => compareVersions(a.version, b.version));
}

// Stable unique key — must include schema_name because two schemas can hold the
// same script_name@version pair.
function scriptKey(s: GitHubScript): string {
  return `${s.schema_name}@${s.script_name}@${s.version}`;
}

function getSqlLineCount(sql: string): number {
  return sql.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

// The version bump a change kind implies — used for the "bump" summary.
function bumpWord(kind: ChangeKind): "major" | "minor" | "patch" {
  if (kind === "breaking") return "major";
  if (kind === "additive") return "minor";
  return "patch";
}

// The COMMIT/ROLLBACK pre-flight check uses the SAME helper as the server apply
// route (lib/sql-guard), so the advisory warning here can never disagree with
// what the route actually rejects — including the dollar-quoted-body handling.

// "1 statement" / "4 statements" — the count PostgreSQL reported for one script.
function fmtStatements(n: number): string {
  return `${n} statement${n === 1 ? "" : "s"}`;
}

function fmtSecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// Short, safe date for the ledger's applied rows. Returns "" for a missing or
// unparseable timestamp rather than "Invalid Date".
function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Applied / Pending / Superseded → status pill for the version ledger.
function ledgerPill(status: LedgerEntry["status"]) {
  if (status === "applied") {
    return (
      <span className="pill pill-sync">
        <span className="dot" />
        applied
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="pill pill-pending">
        <span className="dot" />
        pending
      </span>
    );
  }
  return (
    <span className="pill pill-neutral">
      <span className="dot" style={{ background: "var(--text-3)" }} />
      superseded
    </span>
  );
}

// Change-kind → status pill.
function kindPill(kind: ChangeKind) {
  if (kind === "breaking") {
    return (
      <span className="pill pill-break">
        <span className="dot" />
        breaking
      </span>
    );
  }
  if (kind === "additive") {
    return (
      <span className="pill pill-pending">
        <span className="dot" />
        additive
      </span>
    );
  }
  return (
    <span className="pill pill-neutral">
      <span className="dot" style={{ background: "var(--text-3)" }} />
      patch
    </span>
  );
}

// The right-hand status cell of a mig-row.
function RightStatus({ cell }: { cell: RunCell }) {
  if (cell.status === "running") {
    return (
      <span className="right-status">
        <span className="spin" style={{ width: 12, height: 12 }} />
        running…
      </span>
    );
  }
  if (cell.status === "applied" || cell.status === "rehearsed") {
    return (
      <span className="right-status" style={{ color: "var(--sync)" }}>
        <span className="status-ico applied">
          <CheckIcon size={11} />
        </span>
        {cell.status}
        {cell.statements !== undefined ? ` · ${fmtStatements(cell.statements)}` : ""}
      </span>
    );
  }
  if (cell.status === "failed") {
    return (
      <span className="right-status" style={{ color: "var(--break)" }}>
        <span className="status-ico failed">
          <XIcon size={11} />
        </span>
        failed
      </span>
    );
  }
  if (cell.status === "skipped") {
    return (
      <span className="right-status">
        <span className="status-ico skipped">
          <XIcon size={11} />
        </span>
        skipped
      </span>
    );
  }
  // queued
  return (
    <span className="right-status">
      <AlertCircleIcon size={12} />
      queued
    </span>
  );
}

// One migration row, shared by the pending list (stage 1) and run list (stage 2/3).
function MigRow({
  seq,
  name,
  kind,
  sub,
  rightPill,
  cell,
  selected,
  sql,
  sqlOpen,
}: {
  seq: string;
  name: string;
  kind: ChangeKind;
  sub: string;
  rightPill: string;
  cell: RunCell;
  selected?: boolean;
  /**
   * The statements this row will run. When given, the row opens to show them.
   *
   * The checklist beside this list asks the reader to tick "I have read the
   * breaking migrations and know what they remove" — an attestation about SQL
   * that, until this existed, appeared nowhere on the page and had no link out
   * to it. A tick box in front of text nobody can read is not a safety gate,
   * it is a formality, so the text is here.
   */
  sql?: string;
  /** Start expanded. Used for the breaking ones, which are the point. */
  sqlOpen?: boolean;
}) {
  const cls = ["mig-row", cell.status, selected ? "selected" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="mig-item">
      <div className={cls}>
        <div className="seq-circle">{seq}</div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="name">{name}</span>
            {kindPill(kind)}
          </div>
          <div className="sub mono">{sub}</div>
        </div>
        <span className="pill pill-outline mono">{rightPill}</span>
        <RightStatus cell={cell} />
      </div>
      {cell.error && <pre className="err-pre">{cell.error}</pre>}
      {sql && (
        <details className="mig-sql" open={sqlOpen}>
          <summary>
            <ChevronDownIcon className="chev" size={12} />
            <span>SQL</span>
            <span className="mono">{countOf(getSqlLineCount(sql), "line")}</span>
          </summary>
          <pre className="sql">{sql.trim()}</pre>
        </details>
      )}
    </div>
  );
}

/**
 * The gate in front of anything that runs SQL on a production database.
 *
 * Everything else on this page can be undone or retried. This cannot: the
 * migration commits on a live database with real rows in it. So a production
 * target does not just get a louder colour, it gets a stop — the button below
 * stays disabled until someone reads this and ticks the box.
 *
 * The tick is deliberately per-action and short-lived. It is cleared whenever
 * the target, the schema, the script family or the version range changes, so it
 * can never be carried from the dev run you meant to the prod run you did not.
 */
function ProductionGate({
  what,
  acknowledged,
  onAcknowledge,
}: {
  /** What is about to happen, in the user's words. "run 3 migrations", etc. */
  what: string;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
}) {
  return (
    <div className="prod-gate">
      <div className="prod-gate__head">
        <AlertTriangleIcon size={15} className="ico" />
        <span>Production target</span>
      </div>
      <p className="prod-gate__body">
        This connection is labelled production. Live data is behind it, and a
        migration that goes wrong here is not something a rollback brings back —
        a rollback restores structure, not rows.
      </p>
      <label className="prod-gate__ack">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => onAcknowledge(event.target.checked)}
        />
        <span>I understand, and I mean to {what} against production.</span>
      </label>
    </div>
  );
}

/**
 * A second stop, for a risk that is not "this is production".
 *
 * The Deploy screen used to print `breakingCount` and a red drift row and then
 * let you press Deploy anyway — information on screen that gated nothing. Each
 * of these now has to be read and ticked, for the same reason the production
 * gate exists: being on screen was not enough.
 */
function RiskGate({
  tone,
  title,
  body,
  ack,
  acknowledged,
  onAcknowledge,
}: {
  /** "break" is red (a migration that destroys structure), "drift" is amber. */
  tone: "break" | "drift";
  title: string;
  body: string;
  /** The sentence beside the checkbox, in the user's words. */
  ack: string;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
}) {
  return (
    <div className={tone === "drift" ? "prod-gate prod-gate--drift" : "prod-gate"}>
      <div className="prod-gate__head">
        <AlertTriangleIcon size={15} className="ico" />
        <span>{title}</span>
      </div>
      <p className="prod-gate__body">{body}</p>
      <label className="prod-gate__ack">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => onAcknowledge(event.target.checked)}
        />
        <span>{ack}</span>
      </label>
    </div>
  );
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
function ApprovalPanel({
  migrationCount,
  targetVersion,
  hashReady,
  hashError,
  loading,
  error,
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
}: {
  migrationCount: number;
  targetVersion: string;
  /** False until the run's fingerprint has been computed in the browser. */
  hashReady: boolean;
  hashError: string | null;
  loading: boolean;
  error: string | null;
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
}) {
  if (migrationCount === 0) {
    return (
      <div className="appr">
        <div className="appr__head" style={{ color: "var(--text-2)" }}>
          <UsersIcon size={15} className="ico" />
          <span>Approval</span>
        </div>
        <p className="appr__body">
          Pick a target version first — an approval covers one exact set of
          migrations, so there is nothing to approve yet.
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
              : "Working out which approval covers this run…"}
        </p>
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

  const tone = approved ? "ok" : pending ? "wait" : "no";

  return (
    <div className={`appr appr--${tone}`}>
      <div className="appr__head">
        {approved ? <CheckIcon size={15} className="ico" /> : <UsersIcon size={15} className="ico" />}
        <span>
          {approved
            ? "Approved by a second person"
            : pending
              ? "Waiting for a second person"
              : "Needs a second person"}
        </span>
      </div>

      {approved ? (
        <>
          <p className="appr__body">
            Cleared for exactly these {migrationCount} migration
            {migrationCount === 1 ? "" : "s"}
            {targetVersion ? <> through <span className="mono">v{targetVersion}</span></> : null}, and
            good for one run. Edit any of the SQL and this stops applying.
          </p>
          <p className="appr__meta">
            Requested by {approved.requested_by} · approved by{" "}
            {approved.decided_by ?? "—"}
            {approvalTime(approved.decided_at) ? ` · ${approvalTime(approved.decided_at)}` : ""}
          </p>
          {approved.self_approved && (
            <p className="appr__meta">
              Self-approved under the auth bypass — recorded on the row, because
              with the bypass on there is only one principal to be.
            </p>
          )}
          {approved.note && <p className="appr__meta">Note: {approved.note}</p>}
        </>
      ) : pending ? (
        <>
          <p className="appr__body">
            Requested by {pending.requested_by}
            {approvalTime(pending.requested_at) ? ` · ${approvalTime(pending.requested_at)}` : ""}.
            Someone else has to read these migrations and clear them before the
            run can start. A dry run does not need it.
          </p>
          {pending.note && <p className="appr__meta">Note: {pending.note}</p>}
          {!isAdmin ? (
            <p className="appr__meta">Clearing a production run needs the admin role.</p>
          ) : selfDecision ? (
            <p className="appr__meta">
              You asked for this deploy, so you cannot approve it. That is the
              whole rule — it needs someone else.
            </p>
          ) : (
            <>
              <input
                className="input mt-2"
                style={{ fontSize: "12px" }}
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
                  Approve this run
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
            This target is labelled production, so the run needs an approval from
            someone other than you.
            {latest?.status === "rejected" ? (
              <>
                {" "}
                The last request for this exact SQL was rejected by{" "}
                {latest.decided_by ?? "someone"}
                {latest.note ? ` — "${latest.note}"` : ""}.
              </>
            ) : latest?.status === "used" ? (
              <> An earlier approval for this exact SQL has already been spent on a run.</>
            ) : null}
          </p>
          <input
            className="input mt-2"
            style={{ fontSize: "12px" }}
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
              {latest ? "Request approval again" : "Request approval"}
            </button>
          </div>
        </>
      )}

      {error && (
        <p className="appr__meta" style={{ color: "var(--break)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

export default function DeployPage() {
  // Who is looking. The approval panel needs two things from this: whether to
  // offer Approve at all (admins decide), and whether this is the same person
  // who asked for the run (nobody clears their own).
  const { user, isAdmin, bypass } = useUser();

  // ── Selection state ──────────────────────────────────────────────────────
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [connectionsFailed, setConnectionsFailed] = useState(false);
  const [connectionId, setConnectionId] = useState<string>("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [schemasError, setSchemasError] = useState<string | null>(null);
  const [schema, setSchema] = useState<string>("");
  const [scriptGroup, setScriptGroup] = useState<string>("");

  // ── GitHub script source ─────────────────────────────────────────────────
  const [githubScripts, setGithubScripts] = useState<GitHubScript[] | null>(null);
  const [pullLoading, setPullLoading] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);

  // ── Pre-flight + target ──────────────────────────────────────────────────
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [targetVersion, setTargetVersion] = useState<string>("");

  // ── Environment of the chosen target ─────────────────────────────────────
  // The connection carries one label; the tracked schema can carry a louder one
  // (a prod schema on a box nobody labelled). We learn the schema's only when
  // the lineage lookup runs, so this starts unset and is filled in by the
  // pre-flight check — the connection's label alone is enough to warn with in
  // the meantime.
  const [schemaEnvironment, setSchemaEnvironment] =
    useState<Environment>(DEFAULT_ENVIRONMENT);
  // Ticked in the ProductionGate. One per destructive action, never shared.
  const [deployAcknowledged, setDeployAcknowledged] = useState(false);
  const [revertAcknowledged, setRevertAcknowledged] = useState(false);

  // Ticked beside the risk they belong to, never shared with each other or
  // with the production tick — three different things to have read.
  const [breakingAcknowledged, setBreakingAcknowledged] = useState(false);
  const [dataLossAcknowledged, setDataLossAcknowledged] = useState(false);
  const [driftAcknowledged, setDriftAcknowledged] = useState(false);

  // ── Deploy approvals (the two-person rule) ───────────────────────────────
  // runHash identifies the exact batch on screen. It is compared against the
  // run_fingerprint of the rows below, so the panel can only ever call a run
  // approved when the approved SQL is the SQL that would run.
  const [runHash, setRunHash] = useState<string | null>(null);
  const [hashError, setHashError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [approvalsLoading, setApprovalsLoading] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalNote, setApprovalNote] = useState("");
  // Bumped after a request or a decision to re-read the list. A counter rather
  // than a shared loader function keeps the fetch in one effect, with one
  // cancellation path.
  const [approvalReloadKey, setApprovalReloadKey] = useState(0);

  // ── Drift pre-check (Phase 6 lineage) ────────────────────────────────────
  const [driftPhase, setDriftPhase] = useState<DriftPhase>("idle");
  const [driftResult, setDriftResult] = useState<DriftResult | null>(null);
  const [driftError, setDriftError] = useState<string | null>(null);

  // ── Revert (roll one applied version back off the target) ────────────────
  // revertVersion is the version whose confirmation panel is open — the button
  // never fires straight into a rollback, because this is destructive and the
  // user should read the SQL first.
  const [revertVersion, setRevertVersion] = useState<string | null>(null);
  const [revertBusy, setRevertBusy] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);

  // ── Stepper + run ────────────────────────────────────────────────────────
  const [stage, setStage] = useState<1 | 2 | 3>(1);
  const [isDeploying, setIsDeploying] = useState(false);
  // The exact ordered batch captured at run start — the run/verify lists render
  // from this, so a post-run preflight refresh can't reshuffle them.
  const [runScripts, setRunScripts] = useState<GitHubScript[]>([]);
  const [runStatus, setRunStatus] = useState<Record<string, RunCell>>({});
  const [runComplete, setRunComplete] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  // True while the run on screen is a rehearsal. Kept separate from the button
  // that started it so the whole stage-2 view can say so, including after it
  // finishes and the button is no longer in the picture.
  const [runIsDryRun, setRunIsDryRun] = useState(false);
  // A failure that belongs to the run rather than to any one migration — a
  // rejected request, an unreadable response, a connection that never landed.
  const [runError, setRunError] = useState<string | null>(null);

  const timerRef = useRef<number | null>(null);
  const runStartRef = useRef(0);

  // ── Toast ────────────────────────────────────────────────────────────────
  const [toastMsg, setToastMsg] = useState("");
  const [toastShow, setToastShow] = useState(false);
  const toastTimer = useRef<number | null>(null);

  function showToast(msg: string) {
    setToastMsg(msg);
    setToastShow(true);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastShow(false), 1900);
  }

  // ── Load connections + GitHub scripts on mount ───────────────────────────
  useEffect(() => {
    fetch("/api/connections", { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as unknown) : null))
      .then((data: unknown) => {
        // An unreadable list is not an empty one. Saying "add a connection
        // first" when the app database is down sends the user to a page that
        // will fail the same way.
        if (Array.isArray(data)) setConnections(data as Connection[]);
        else setConnectionsFailed(true);
      })
      .catch(() => setConnectionsFailed(true))
      .finally(() => setConnectionsLoaded(true));

    void handlePull();
  }, []);

  // Clean up the elapsed-time interval if the user navigates away mid-run.
  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  // Load schemas from the target DB whenever the connection changes.
  useEffect(() => {
    if (!connectionId) {
      setSchemas([]);
      setSchemasError(null);
      return;
    }
    void fetchSchemas(connectionId);
  }, [connectionId]);

  // ── Derived data ─────────────────────────────────────────────────────────
  const activeConn = useMemo(
    () => connections.find((c) => String(c.id) === connectionId) ?? null,
    [connections, connectionId]
  );

  // What we warn about. louderEnvironment is the same rule the compare screen
  // uses, so a target cannot look calmer here — where the SQL actually runs —
  // than it does there.
  const targetEnvironment = louderEnvironment(
    toEnvironment(activeConn?.environment),
    schemaEnvironment
  );
  const targetIsProduction = isProduction(targetEnvironment);

  // Scope the pulled scripts to the selected connection's database. GitHub now
  // stores scripts under <database_name>/<schema>/..., so a script only belongs
  // to this deploy if its database_name matches the chosen connection. With no
  // connection picked yet we don't scope, so nothing is hidden prematurely.
  const scopedScripts = useMemo(
    () =>
      (githubScripts ?? []).filter(
        (s) => !activeConn || s.database_name === activeConn.database_name
      ),
    [githubScripts, activeConn]
  );

  const groupedScripts = useMemo(() => {
    return scopedScripts.reduce<Record<string, GitHubScript[]>>((acc, s) => {
      (acc[s.script_name] ??= []).push(s);
      return acc;
    }, {});
  }, [scopedScripts]);

  // Script groups that actually exist in the chosen schema's GitHub folder.
  const schemaScriptNames = useMemo(() => {
    if (!schema) return [];
    return Array.from(
      new Set(
        scopedScripts.filter((s) => s.schema_name === schema).map((s) => s.script_name)
      )
    ).sort();
  }, [scopedScripts, schema]);

  // Scripts not yet applied to the target — strictly greater than its version.
  const pendingScripts = useMemo<GitHubScript[]>(() => {
    if (!scriptGroup || !preflightResult) return [];
    const groupVersions = (groupedScripts[scriptGroup] ?? []).filter(
      (s) => s.schema_name === schema
    );
    const sorted = sortGitHubScriptsByVersion(groupVersions);
    if (!preflightResult.currentVersion) return sorted;
    return sorted.filter(
      (s) => compareVersions(s.version, preflightResult.currentVersion!) > 0
    );
  }, [scriptGroup, preflightResult, groupedScripts, schema]);

  // Everything we'd apply to reach the chosen target version (ascending order).
  const scriptsUpToTarget = useMemo(() => {
    if (!targetVersion) return [];
    return pendingScripts.filter((s) => compareVersions(s.version, targetVersion) <= 0);
  }, [pendingScripts, targetVersion]);

  // Forward view (Phase 3): every GitHub version of the chosen family labelled
  // Applied / Pending / Superseded against the target's applied history. Both
  // inputs are scoped to one (database, schema, script_name) — scopedScripts is
  // already database-filtered, the schema filter narrows it, and the preflight
  // timeline is the target DB's script_patch for this exact family — so two
  // databases sharing a script_name@version can never cross-contaminate.
  const versionLedger = useMemo<LedgerEntry[]>(() => {
    if (!scriptGroup || !preflightResult) return [];
    const familyVersions = (groupedScripts[scriptGroup] ?? [])
      .filter((s) => s.schema_name === schema)
      .map((s) => s.version);
    return buildVersionLedger(familyVersions, preflightResult.timeline);
  }, [scriptGroup, preflightResult, groupedScripts, schema]);

  const appliedCount = versionLedger.filter((e) => e.status === "applied").length;
  const pendingCount = versionLedger.filter((e) => e.status === "pending").length;

  // The newest applied version of this family. It is the ONLY one the Revert
  // button is offered on: a rollback assumes nothing later has touched the same
  // structure, so undoing v1.0.0 while v2.0.0 is still applied would run the
  // wrong undo. The revert route enforces the same rule server-side.
  const newestApplied = useMemo<string | null>(() => {
    let newest: string | null = null;
    for (const entry of versionLedger) {
      if (entry.status !== "applied") continue;
      if (newest === null || compareVersions(entry.version, newest) > 0) {
        newest = entry.version;
      }
    }
    return newest;
  }, [versionLedger]);

  // Registry entry per version of the chosen family, so a ledger row can reach
  // its stored rollback (down_sql) without re-scanning the pulled scripts.
  const scriptByVersion = useMemo(() => {
    const map = new Map<string, GitHubScript>();
    for (const s of groupedScripts[scriptGroup] ?? []) {
      if (s.schema_name === schema) map.set(s.version, s);
    }
    return map;
  }, [groupedScripts, scriptGroup, schema]);

  // Versions whose ledger row carries its own rollback. This is the second
  // source: a version replayed here by Version Sync has no registry file for
  // this schema, so scriptByVersion cannot reach it, but the apply route stored
  // its down script on the row.
  const storedRollbackVersions = useMemo(() => {
    const set = new Set<string>();
    for (const row of preflightResult?.timeline ?? []) {
      if (row.has_down_sql) set.add(row.version);
    }
    return set;
  }, [preflightResult]);

  // Can this version be rolled back at all — from a registry file, or from the
  // copy stored beside the applied row?
  const canRollBack = useCallback(
    (version: string) =>
      Boolean(scriptByVersion.get(version)?.down_sql) ||
      storedRollbackVersions.has(version),
    [scriptByVersion, storedRollbackVersions]
  );

  // Close a stale confirmation panel when the user changes what they're looking
  // at — a "Roll back v2.0.0" prompt must not survive a switch to another
  // schema or script family.
  useEffect(() => {
    setRevertVersion(null);
    setRevertError(null);
    setRevertAcknowledged(false);
  }, [connectionId, schema, scriptGroup]);

  // An acknowledgement is for one exact batch against one exact target. Change
  // any part of what would run and it has to be given again — otherwise a tick
  // meant for two patch migrations on dev could carry over to a breaking one on
  // production. targetVersion is in here because it decides how far the run
  // goes, not just where.
  useEffect(() => {
    setDeployAcknowledged(false);
    setBreakingAcknowledged(false);
    setDataLossAcknowledged(false);
    setDriftAcknowledged(false);
  }, [connectionId, schema, scriptGroup, targetVersion]);

  // The schema's own label belongs to one (connection, schema) pair. Drop it the
  // moment that pair changes, so a prod schema's label can never linger over a
  // dev one picked next.
  useEffect(() => {
    setSchemaEnvironment(DEFAULT_ENVIRONMENT);
  }, [connectionId, schema]);

  // Default the target to the latest pending version once pre-flight returns.
  // Re-runs after a partial deploy keep a still-valid pick, else snap to latest.
  useEffect(() => {
    if (stage !== 1) return;
    if (pendingScripts.length === 0) {
      if (targetVersion) setTargetVersion("");
      return;
    }
    const versions = pendingScripts.map((s) => s.version);
    if (!targetVersion || !versions.includes(targetVersion)) {
      setTargetVersion(pendingScripts[pendingScripts.length - 1].version);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScripts, stage]);

  // Summary stats for the chosen batch.
  const breakingCount = scriptsUpToTarget.filter(
    (s) => changeTypeOf(s.sql_content) === "breaking"
  ).length;
  const linesOfSql = scriptsUpToTarget.reduce(
    (sum, s) => sum + getSqlLineCount(s.sql_content),
    0
  );
  const bumps = useMemo(() => {
    const order: Array<"major" | "minor" | "patch"> = ["major", "minor", "patch"];
    const present = new Set(
      scriptsUpToTarget.map((s) => bumpWord(changeTypeOf(s.sql_content)))
    );
    return order.filter((b) => present.has(b)).join(" + ") || "—";
  }, [scriptsUpToTarget]);
  const txnViolationScripts = scriptsUpToTarget.filter((s) => containsTransactionControl(s.sql_content));
  const hasTxnViolation = txnViolationScripts.length > 0;
  // Asked separately from the change type, because they are separate questions.
  // changeTypeOf answers "how far does the version move", and a TRUNCATE moves
  // it not at all — so a run that empties a table used to arrive here graded
  // "patch" with the checklist reporting that nothing in it was breaking.
  const dataLossScripts = useMemo(
    () =>
      scriptsUpToTarget
        .map((s) => ({ script: s, statements: findRowDestroyingStatements(s.sql_content) }))
        .filter((entry) => entry.statements.length > 0),
    [scriptsUpToTarget]
  );
  // Named rather than counted: "TRUNCATE, DELETE" tells the reader what to go
  // and look for, where "3 statements" tells them only that there are three.
  const dataLossKinds = useMemo(
    () => [...new Set(dataLossScripts.flatMap((entry) => entry.statements))].join(", "),
    [dataLossScripts]
  );

  // ── What the approval covers ─────────────────────────────────────────────
  // Hash the batch the same way the server does, so this screen can say
  // "approved" only when the approved SQL is the SQL that would run. Recomputed
  // whenever the batch changes, which includes an edited migration arriving in
  // a fresh GitHub pull.
  useEffect(() => {
    if (scriptsUpToTarget.length === 0) {
      setRunHash(null);
      setHashError(null);
      return;
    }
    const body = fingerprintBody(
      scriptsUpToTarget.map((s) => ({
        scriptName: s.script_name,
        version: s.version,
        sqlContent: s.sql_content,
      }))
    );
    let cancelled = false;
    setHashError(null);
    sha256Hex(body)
      .then((hex) => {
        if (!cancelled) setRunHash(hex);
      })
      .catch(() => {
        if (cancelled) return;
        // crypto.subtle is missing outside a secure context. Say so instead of
        // silently reporting every run as unapproved, which would look like the
        // approval had gone missing.
        setRunHash(null);
        setHashError(
          "This browser cannot check the approval — crypto.subtle needs " +
            "https or localhost. Open the app over https to approve a run."
        );
      });
    return () => {
      cancelled = true;
    };
  }, [scriptsUpToTarget]);

  // Approvals are only read for a production target, because production is the
  // only place the server asks for one. Fetching them elsewhere would put a
  // panel on screen that gates nothing.
  useEffect(() => {
    if (!targetIsProduction || !connectionId || !schema || !scriptGroup) {
      setApprovals([]);
      setApprovalError(null);
      return;
    }
    let cancelled = false;
    setApprovalsLoading(true);
    const url =
      `/api/deploy/approvals?connectionId=${encodeURIComponent(connectionId)}` +
      `&schemaName=${encodeURIComponent(schema)}` +
      `&scriptName=${encodeURIComponent(scriptGroup)}`;
    fetch(url, { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json()) as { approvals?: ApprovalRow[]; error?: string };
        if (cancelled) return;
        if (!res.ok || !data.approvals) {
          setApprovals([]);
          setApprovalError(data.error ?? "Could not read the approvals for this target.");
          return;
        }
        setApprovals(data.approvals);
        setApprovalError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setApprovals([]);
        setApprovalError("Network error reading the approvals for this target.");
      })
      .finally(() => {
        if (!cancelled) setApprovalsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [targetIsProduction, connectionId, schema, scriptGroup, approvalReloadKey]);

  // Every approval row for this exact batch, newest first (the API orders by
  // id DESC). Anything with a different fingerprint belongs to different SQL
  // and must not count towards this run.
  const runApprovals = useMemo(
    () => (runHash ? approvals.filter((a) => a.run_fingerprint === runHash) : []),
    [approvals, runHash]
  );
  const approvedRun = runApprovals.find((a) => a.status === "approved") ?? null;
  const pendingRun = runApprovals.find((a) => a.status === "pending") ?? null;
  const latestRun = runApprovals[0] ?? null;
  // What stops a run starting at all. Deploy and Dry run share it: a rehearsal
  // writes nothing but still executes every statement against the real target,
  // so the same preconditions apply to both.
  // A drift result that is not "in sync" means the target is not the database
  // these migrations were written against. That is a reason to stop and look,
  // not a reason to forbid the run outright — so it is a tick, like production.
  const driftBlocks =
    driftPhase === "ready" && driftResult !== null && driftResult.status !== "in_sync";
  const runBlocked =
    scriptsUpToTarget.length === 0 ||
    hasTxnViolation ||
    isDeploying ||
    (targetIsProduction && !deployAcknowledged) ||
    (breakingCount > 0 && !breakingAcknowledged) ||
    (dataLossScripts.length > 0 && !dataLossAcknowledged) ||
    (driftBlocks && !driftAcknowledged);
  // What additionally stops a real deploy. A dry run is exempt because the
  // server exempts it: a rehearsal writes nothing, and charging a second person
  // for a rehearsal would make the careful path the expensive one.
  const deployBlocked = runBlocked || (targetIsProduction && !approvedRun);

  // ── Data loaders ─────────────────────────────────────────────────────────
  async function handlePull() {
    setPullLoading(true);
    setPullError(null);
    try {
      const res = await fetch("/api/github/pull");
      const data = (await res.json()) as { scripts?: GitHubScript[]; error?: string };
      if (!res.ok || !data.scripts) {
        setPullError(data.error ?? "Could not fetch scripts from GitHub.");
      } else {
        setGithubScripts(data.scripts);
      }
    } catch {
      setPullError("Network error fetching scripts from GitHub.");
    } finally {
      setPullLoading(false);
    }
  }

  async function fetchSchemas(id: string) {
    setSchemasLoading(true);
    setSchemasError(null);
    setSchemas([]);
    try {
      const res = await fetch(`/api/scripts/schemas?connectionId=${id}`);
      const data = (await res.json()) as { schemas?: string[]; error?: string };
      if (!res.ok || !data.schemas) {
        setSchemasError(data.error ?? "Could not load schemas from this connection.");
      } else {
        setSchemas(data.schemas);
      }
    } catch {
      setSchemasError("Network error loading schemas.");
    } finally {
      setSchemasLoading(false);
    }
  }

  // Bare pre-flight call — also used to refresh the ledger after a run.
  async function runPreflightCheck(id: string, sch: string, group: string) {
    setPreflightLoading(true);
    setPreflightError(null);
    try {
      const res = await fetch("/api/scripts/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(id),
          schemaName: sch || "public",
          scriptName: group || undefined,
        }),
      });
      const data = (await res.json()) as PreflightResult & { error?: string };
      if (!res.ok) {
        setPreflightError(data.error ?? "Pre-flight check failed.");
        setPreflightResult(null);
        return;
      }
      setPreflightResult(data);
    } catch {
      setPreflightError("Network error during pre-flight check.");
      setPreflightResult(null);
    } finally {
      setPreflightLoading(false);
    }
  }

  // Run one version's stored rollback against the target, then re-read the
  // ledger so the row flips from Applied back to Pending. The server does the
  // real checking (is it applied, is it the newest); this only refuses to send
  // a request it already knows is incomplete.
  async function handleRevert(version: string) {
    // The registry file when there is one. When there is not, this is left out
    // of the request and the server runs the copy stored on the ledger row.
    const downSql = scriptByVersion.get(version)?.down_sql;
    if (!connectionId || !scriptGroup || !canRollBack(version)) return;
    // The disabled button already says this, but a disabled button is a hint,
    // not a rule — this is the rule.
    if (targetIsProduction && !revertAcknowledged) return;

    setRevertBusy(true);
    setRevertError(null);
    try {
      const res = await fetch("/api/scripts/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(connectionId),
          script_name: scriptGroup,
          version,
          sql_content: downSql,
          schemaName: schema || "public",
          acknowledgeProduction: revertAcknowledged,
        }),
      });
      const data = (await res.json()) as { success?: boolean; message?: string; error?: string };
      if (!res.ok || !data.success) {
        setRevertError(data.error ?? "The rollback failed.");
        return;
      }
      setRevertVersion(null);
      showToast(`v${version} rolled back`);
      // The run panel below still describes the deploy that put this version on
      // the target, so clear it — leaving it up would contradict the ledger.
      resetRun();
      setStage(1);
      await runPreflightCheck(connectionId, schema, scriptGroup);
    } catch {
      setRevertError("Network error while running the rollback.");
    } finally {
      setRevertBusy(false);
    }
  }

  // ── Approvals ────────────────────────────────────────────────────────────
  // Ask for a second person's sign-off on exactly the batch on screen. The
  // server hashes the SQL again from this request body rather than trusting a
  // fingerprint the browser sends, so a tampered request cannot approve one set
  // of migrations and run another.
  async function handleRequestApproval() {
    if (!connectionId || !schema || !scriptGroup || !targetVersion) return;
    if (scriptsUpToTarget.length === 0 || approvalBusy) return;

    setApprovalBusy(true);
    setApprovalError(null);
    try {
      const res = await fetch("/api/deploy/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(connectionId),
          schemaName: schema || "public",
          scriptName: scriptGroup,
          targetVersion,
          breakingCount,
          note: approvalNote.trim() || undefined,
          scripts: scriptsUpToTarget.map((script) => ({
            script_name: script.script_name,
            version: script.version,
            sql_content: script.sql_content,
          })),
        }),
      });
      const data = (await res.json()) as { approval?: ApprovalRow; error?: string };
      if (!res.ok || !data.approval) {
        setApprovalError(data.error ?? "Could not record the approval request.");
        return;
      }
      setApprovalNote("");
      showToast("Approval requested — someone else has to clear it");
    } catch {
      setApprovalError("Network error requesting the approval.");
    } finally {
      setApprovalBusy(false);
      setApprovalReloadKey((key) => key + 1);
    }
  }

  // The second person's half. A 409 here means someone decided it first; their
  // decision stands, and the reload below puts it on screen.
  async function handleDecideApproval(id: number, decision: "approve" | "reject") {
    if (approvalBusy) return;
    setApprovalBusy(true);
    setApprovalError(null);
    try {
      const res = await fetch(`/api/deploy/approvals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: approvalNote.trim() || undefined }),
      });
      const data = (await res.json()) as { approval?: ApprovalRow; error?: string };
      if (!res.ok || !data.approval) {
        setApprovalError(data.error ?? "Could not record the decision.");
        return;
      }
      setApprovalNote("");
      showToast(decision === "approve" ? "Run approved" : "Run rejected");
    } catch {
      setApprovalError("Network error recording the decision.");
    } finally {
      setApprovalBusy(false);
      setApprovalReloadKey((key) => key + 1);
    }
  }

  function resetDrift() {
    setDriftPhase("idle");
    setDriftResult(null);
    setDriftError(null);
    // An acknowledgement belongs to one drift result. Dropping it here means a
    // fresh check always has to be read again, rather than inheriting a tick
    // given for a report that no longer exists.
    setDriftAcknowledged(false);
  }

  // Phase 6 drift pre-check. If the chosen target (connection + schema) is
  // tracked, compare its live structure against its expected snapshot via the
  // real lineage APIs. When it isn't tracked we say so honestly — never a fake
  // diff. The drift POST also records a drift_events row, which feeds the audit
  // log. Used both as a stage-1 pre-check and a stage-3 post-deploy verify.
  async function runDriftCheck(id: string, sch: string) {
    if (!id || !sch) {
      resetDrift();
      return;
    }
    setDriftPhase("loading");
    setDriftError(null);
    setDriftResult(null);
    setDriftAcknowledged(false);
    try {
      const lookupRes = await fetch(
        `/api/lineage/lookup?connectionId=${encodeURIComponent(id)}&schemaName=${encodeURIComponent(sch)}`,
        { cache: "no-store" }
      );
      // A failed lookup must not read as "not tracked" — that answer skips the
      // drift pre-check and leaves the environment label unset, so a dead
      // metadata database would quietly remove both warnings.
      if (!lookupRes.ok) {
        setDriftPhase("error");
        return;
      }
      const lookup = (await lookupRes.json()) as {
        tracked?: boolean;
        trackedSchemaId?: number;
        environment?: string;
      };
      // Worth keeping even when the drift check itself can't run: the warning
      // above the Deploy button needs this, and an untracked schema simply has
      // no label of its own to add.
      setSchemaEnvironment(toEnvironment(lookup.environment));
      if (!lookup.tracked || !lookup.trackedSchemaId) {
        setDriftPhase("untracked");
        return;
      }
      const driftRes = await fetch("/api/lineage/drift", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackedSchemaId: lookup.trackedSchemaId }),
      });
      const data = (await driftRes.json()) as DriftResult & { error?: string };
      if (!driftRes.ok || !data.status) {
        setDriftError(data.error ?? "Drift check failed.");
        setDriftPhase("error");
        return;
      }
      setDriftResult(data);
      setDriftPhase("ready");
    } catch {
      setDriftError("Network error during the drift check.");
      setDriftPhase("error");
    }
  }

  // "Check database" button — resets the run and re-reads the ledger.
  async function handlePreflight() {
    if (!connectionId || !schema || !scriptGroup) return;
    resetRun();
    setStage(1);
    setPreflightResult(null);
    setTargetVersion("");
    await runPreflightCheck(connectionId, schema, scriptGroup);
    void runDriftCheck(connectionId, schema);
  }

  function resetRun() {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsDeploying(false);
    setRunScripts([]);
    setRunStatus({});
    setRunComplete(false);
    setRunError(null);
    setRunIsDryRun(false);
    setElapsedMs(0);
  }

  // ── The deploy run ───────────────────────────────────────────────────────
  // One call to /api/scripts/apply carrying the whole batch. The server runs
  // every migration inside ONE transaction, so the run is all-or-nothing: there
  // is no state where some of these are applied and the rest are not, and there
  // is nothing to "stop" partway — by the time a failure is visible here, the
  // database has already put itself back.
  //
  // `dryRun` rehearses instead: the SQL really executes against the target and
  // the transaction ends in ROLLBACK. Later scripts see the earlier ones' work,
  // which is why the rehearsal has to be one request too.
  async function handleRun(dryRun: boolean) {
    const batch = scriptsUpToTarget;
    // The disabled buttons say all of this already, but a disabled button is a
    // hint, not a rule — this is the rule. A rehearsal is held to everything
    // except the approval, exactly as the apply route holds it.
    if (dryRun ? runBlocked : deployBlocked) return;

    setRunScripts(batch);
    setRunIsDryRun(dryRun);
    setRunError(null);
    // Every migration goes to "running" at once because they really do run
    // together. Ticking them off one at a time would be a story about a loop
    // that no longer exists.
    setRunStatus(
      Object.fromEntries(batch.map((s) => [scriptKey(s), { status: "running" } as RunCell]))
    );
    setRunComplete(false);
    setIsDeploying(true);
    setStage(2);

    runStartRef.current = performance.now();
    setElapsedMs(0);
    timerRef.current = window.setInterval(() => {
      setElapsedMs(performance.now() - runStartRef.current);
    }, 100);

    let outcomes: ApplyOutcome[] | null = null;
    let failure: string | null = null;

    try {
      const res = await fetch("/api/scripts/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(connectionId),
          schemaName: schema || "public",
          dryRun,
          acknowledgeProduction: deployAcknowledged,
          scripts: batch.map((script) => ({
            script_name: script.script_name,
            sql_content: script.sql_content,
            version: script.version,
            title: script.script_name,
            change_type: changeTypeOf(script.sql_content),
            // Link the applied row back to the GitHub file it came from.
            source_ref: script.path,
          })),
        }),
      });

      // Read the body as text and parse it separately. A proxy 502 or a Next.js
      // error page is HTML, and letting res.json() throw inside this try would
      // drop into the catch below and report "could not reach the server" about
      // a request that reached it — and, before the run became one transaction,
      // may well have committed something.
      const raw = await res.text();
      let data: ApplyResponse | null = null;
      try {
        data = JSON.parse(raw) as ApplyResponse;
      } catch {
        data = null;
      }

      if (data?.results) outcomes = data.results;
      if (!res.ok || !data?.success) {
        failure =
          data?.error ??
          `The apply API answered ${res.status} with a response this page could ` +
          `not read. Re-check the target before retrying.`;
      }
    } catch {
      // A genuine transport failure: the request may or may not have reached the
      // server, so this must not claim nothing happened.
      failure =
        "Could not reach /api/scripts/apply — the request never completed. " +
        "Re-check the target before retrying; the run may still have been applied.";
    }

    // Map the server's verdict onto the rows. A migration the server said
    // nothing about never ran, so it is skipped — including when the whole
    // request was refused before anything executed.
    setRunStatus(() => {
      const next: Record<string, RunCell> = {};
      for (const script of batch) {
        const outcome = outcomes?.find(
          (o) => o.script_name === script.script_name && o.version === script.version
        );
        next[scriptKey(script)] = outcome
          ? { status: outcome.status, error: outcome.error, statements: outcome.statements }
          : { status: "skipped" };
      }
      return next;
    });
    setRunError(failure);

    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setElapsedMs(performance.now() - runStartRef.current);
    setIsDeploying(false);
    setRunComplete(true);

    // Always re-read the ledger so the current version reflects what is really
    // applied — a dry run should leave it exactly where it was, and this is what
    // proves that on screen rather than asserting it.
    await runPreflightCheck(connectionId, schema, scriptGroup);
    // Re-run the drift check so the Verify step reflects the post-deploy state.
    void runDriftCheck(connectionId, schema);
    // A real run spends its approval. Re-read them so the panel says so rather
    // than still offering a green light that the server would now refuse.
    setApprovalReloadKey((key) => key + 1);

    if (failure) {
      showToast(dryRun ? "Dry run failed — nothing was written" : "Deploy failed — nothing was applied");
    } else if (dryRun) {
      showToast(`Dry run clean · ${batch.length} migration${batch.length === 1 ? "" : "s"} rehearsed`);
    } else {
      setStage(3);
      showToast(`Deploy complete · up to v${targetVersion}`);
    }
  }

  // ── Stepper helpers ──────────────────────────────────────────────────────
  const appliedScripts = runScripts.filter(
    (s) => runStatus[scriptKey(s)]?.status === "applied"
  );
  // A clean run: every migration came back applied, or — for a rehearsal —
  // every one came back rehearsed. Only the first unlocks Verify, because only
  // the first left anything behind to verify.
  const allApplied =
    runScripts.length > 0 &&
    runScripts.every((s) => runStatus[scriptKey(s)]?.status === "applied");
  const allRehearsed =
    runScripts.length > 0 &&
    runScripts.every((s) => runStatus[scriptKey(s)]?.status === "rehearsed");
  const runProgress = runScripts.filter((s) => {
    const status = runStatus[scriptKey(s)]?.status;
    return status === "applied" || status === "rehearsed";
  }).length;
  const totalStatements = runScripts.reduce(
    (sum, s) => sum + (runStatus[scriptKey(s)]?.statements ?? 0),
    0
  );

  function canGoStage(n: 1 | 2 | 3): boolean {
    if (isDeploying) return false;
    if (n === 1) return true;
    if (n === 2) return runScripts.length > 0;
    return allApplied; // verify only after a fully clean run
  }

  function stepClass(n: 1 | 2 | 3): string {
    if (n === stage) {
      if (n === 2 && isDeploying) return "step running";
      return "step active";
    }
    return n < stage ? "step done" : "step";
  }

  const STEPS: { n: 1 | 2 | 3; name: string; sub: string }[] = [
    { n: 1, name: "Pre-flight", sub: "checks · pending list" },
    { n: 2, name: "Run", sub: "one transaction · all or nothing" },
    { n: 3, name: "Verify", sub: "ledger re-read" },
  ];

  const currentLabel = preflightResult?.currentVersion
    ? `v${preflightResult.currentVersion}`
    : "fresh";

  return (
    <div style={{ background: "var(--bg)", minHeight: "100%" }}>
      {/* ——— Page header ——— */}
      <section className="px-8 pt-8 pb-2">
        <div className="section-title mb-2">Deploy</div>
        <h1 className="text-[28px] font-semibold tracking-[-0.018em]">
          Bring the database up to a version.
        </h1>
        <p className="text-[13.5px] mt-1.5 max-w-[64ch]" style={{ color: "var(--text-2)" }}>
          Pick a target connection, schema and script group, then rehearse or apply the
          pending migrations. The whole run goes in one transaction — all of them or none.
        </p>
        {pullError && (
          <div className="banner mt-3">
            <span className="ico">
              <AlertCircleIcon size={16} />
            </span>
            <span>{pullError}</span>
          </div>
        )}
      </section>

      {/* ——— Stepper ——— */}
      <section className="px-8 pt-6 pb-4">
        <div className="stepper">
          {STEPS.map((s, i) => (
            <Fragment key={s.n}>
              {i > 0 && (
                <div
                  className={`step-sep${stage > i ? " done" : stage === i ? " active" : ""}`}
                />
              )}
              <button
                type="button"
                className={stepClass(s.n)}
                disabled={!canGoStage(s.n)}
                onClick={() => canGoStage(s.n) && setStage(s.n)}
              >
                <div className="n">
                  {s.n === 2 && isDeploying ? <span className="spin" /> : s.n}
                </div>
                <div className="label">
                  <div className="name">{s.name}</div>
                  <div className="sub">{s.sub}</div>
                </div>
              </button>
            </Fragment>
          ))}
        </div>
      </section>

      {/* ═══════════════════ STAGE 1 — PRE-FLIGHT ═══════════════════ */}
      {stage === 1 && (
        <section className="px-8 pb-12 space-y-6">
          {/* Selection */}
          <div className="card p-5">
            <div className="section-title mb-3">Target</div>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor="dep-conn">Connection</label>
                <Select
                  variant="input"
                  id="dep-conn"
                  className="mt-1"
                  ariaLabel="Connection"
                  value={connectionId}
                  placeholder="Select a connection…"
                  options={connections.map((c) => ({
                    value: String(c.id),
                    label: `${c.name} — ${c.host}/${c.database_name}`,
                  }))}
                  onChange={(value) => {
                    setConnectionId(value);
                    setSchema("");
                    setScriptGroup("");
                    setPreflightResult(null);
                    setPreflightError(null);
                    setTargetVersion("");
                    resetRun();
                    resetDrift();
                  }}
                />
                {connectionsLoaded && connections.length === 0 && (
                  <p className="help mt-1">
                    {connectionsFailed
                      ? "Could not read your saved connections. Reload the page to try again."
                      : "No connections saved yet. Add one on the Connections page first."}
                  </p>
                )}
                {activeConn && (
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <EnvironmentPill environment={targetEnvironment} />
                    {targetEnvironment === "unset" && (
                      <span className="help">
                        Unlabelled — label it on Connections so this page can warn you.
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label className="label" htmlFor="dep-schema">Schema</label>
                <Select
                  variant="input"
                  id="dep-schema"
                  className="mt-1"
                  ariaLabel="Schema"
                  value={schema}
                  disabled={schemasLoading || !connectionId}
                  placeholder={
                    !connectionId
                      ? "Select a connection first"
                      : schemasLoading
                        ? "Loading schemas…"
                        : "Select a schema…"
                  }
                  options={schemas.map((s) => ({ value: s, label: s }))}
                  onChange={(value) => {
                    setSchema(value);
                    setScriptGroup("");
                    setPreflightResult(null);
                    setPreflightError(null);
                    setTargetVersion("");
                    resetRun();
                    resetDrift();
                  }}
                />
                {schemasError && <p className="help mt-1" style={{ color: "var(--break)" }}>{schemasError}</p>}
              </div>

              <div>
                <label className="label" htmlFor="dep-group">Script group</label>
                <Select
                  variant="input"
                  id="dep-group"
                  className="mt-1"
                  ariaLabel="Script group"
                  value={scriptGroup}
                  disabled={!schema}
                  placeholder={!schema ? "Select a schema first" : "Select a script group…"}
                  options={schemaScriptNames.map((name) => ({ value: name, label: name }))}
                  onChange={(value) => {
                    setScriptGroup(value);
                    setPreflightResult(null);
                    setPreflightError(null);
                    setTargetVersion("");
                    resetRun();
                    resetDrift();
                  }}
                />
              </div>
            </div>

            <div className="flex items-center gap-3 mt-4">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!connectionId || !schema || !scriptGroup || preflightLoading || pullLoading}
                onClick={handlePreflight}
              >
                {preflightLoading ? <span className="spin" style={{ width: 13, height: 13 }} /> : <RefreshIcon size={13} />}
                {preflightLoading ? "Checking…" : "Check database"}
              </button>
              {githubScripts && schema && scriptGroup && schemaScriptNames.length === 0 && (
                <span className="help">No script groups found in the <span className="mono">{schema}</span> folder on GitHub.</span>
              )}
            </div>
          </div>

          {preflightError && (
            <div className="banner">
              <span className="ico"><AlertCircleIcon size={16} /></span>
              <span>{preflightError}</span>
            </div>
          )}

          {/* Target context card + pending grid — once pre-flight has run */}
          {preflightResult && activeConn && (
            <>
              <div className="target-card flex-wrap">
                <div
                  className="w-11 h-11 rounded-xl grid place-items-center flex-none"
                  style={{ background: "var(--brand-soft)", color: "var(--brand)" }}
                >
                  <LogoIcon size={20} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="mono text-[16px] font-semibold">{preflightResult.schema}</span>
                    <span className="mono text-[12px]" style={{ color: "var(--text-3)" }}>@</span>
                    <span className="mono text-[14px]" style={{ color: "var(--text-2)" }}>{activeConn.name}</span>
                    <EnvironmentPill environment={targetEnvironment} />
                    <span className="pill pill-sync"><span className="dot" />reachable</span>
                  </div>
                  <div className="text-[12px]" style={{ color: "var(--text-3)" }}>
                    <span className="mono">{activeConn.host}:{activeConn.port}/{activeConn.database_name}</span>
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-4 flex-wrap">
                  <div className="text-center">
                    <div className="section-title">Target at</div>
                    <div className="mono text-[18px] font-semibold mt-1">{currentLabel}</div>
                  </div>
                  <ChevronRightIcon size={20} />
                  <div className="text-center">
                    <div className="section-title">Deploy to</div>
                    <div className="mono text-[18px] font-semibold mt-1" style={{ color: "var(--brand)" }}>
                      {targetVersion ? `v${targetVersion}` : "—"}
                    </div>
                  </div>
                </div>
              </div>

              {/* Forward view (Phase 3): every GitHub version of this family,
                  labelled Applied / Pending / Superseded against the target's
                  script_patch history. Always shown once pre-flight has run. */}
              {versionLedger.length > 0 && (
                <div className="card p-4">
                  <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                    <div className="section-title">
                      Version ledger · <span className="mono">{scriptGroup}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="pill pill-sync"><span className="dot" />{appliedCount} applied</span>
                      <span className="pill pill-pending"><span className="dot" />{pendingCount} pending</span>
                    </div>
                  </div>
                  <div>
                    {versionLedger.map((entry) => {
                      // Revert is offered on the newest applied version only —
                      // see the newestApplied comment above for why.
                      const canOfferRevert =
                        entry.status === "applied" && entry.version === newestApplied;
                      const hasRollback = canRollBack(entry.version);
                      // Only a registry file can be shown here. A rollback that
                      // lives on the ledger row is run by the server and never
                      // travels to the browser.
                      const registryDownSql =
                        scriptByVersion.get(entry.version)?.down_sql ?? null;
                      const confirming = revertVersion === entry.version;
                      return (
                        <div
                          key={entry.version}
                          className="py-1.5"
                          style={{ borderTop: "1px solid var(--border)" }}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="mono text-[13px]">
                              v{entry.version}
                              {!entry.inRegistry && (
                                <span
                                  className="ml-2 text-[11px]"
                                  style={{ color: "var(--text-3)" }}
                                  title={
                                    `v${entry.version} is applied to this schema but has no ` +
                                    `file in the GitHub registry for it — it was applied ` +
                                    `directly, or replayed here by Version Sync.`
                                  }
                                >
                                  not in registry
                                </span>
                              )}
                            </span>
                            <div className="flex items-center gap-2.5">
                              {entry.status === "applied" && entry.appliedAt && (
                                <span className="text-[11px]" style={{ color: "var(--text-3)" }}>
                                  {fmtDate(entry.appliedAt)}
                                </span>
                              )}
                              {ledgerPill(entry.status)}
                              {canOfferRevert && (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  disabled={!hasRollback || revertBusy || isDeploying}
                                  title={
                                    hasRollback
                                      ? `Run the stored rollback for v${entry.version} to undo this version`
                                      : `No rollback stored for v${entry.version}. Versions pushed before rollbacks were saved, or pushed without one, cannot be reverted from here.`
                                  }
                                  onClick={() => {
                                    setRevertError(null);
                                    setRevertAcknowledged(false);
                                    setRevertVersion(confirming ? null : entry.version);
                                  }}
                                >
                                  {confirming ? "Close" : "Revert"}
                                </button>
                              )}
                            </div>
                          </div>

                          {confirming && hasRollback && (
                            <div className="mt-2 mb-1 space-y-2">
                              <div className="warn-inline">
                                <AlertTriangleIcon size={14} className="ico" />
                                <div className="min-w-0">
                                  <div className="font-semibold">This restores structure, not data.</div>
                                  <div className="mt-1" style={{ color: "var(--text-2)" }}>
                                    Running the rollback for v{entry.version} against{" "}
                                    <span className="mono">{preflightResult.schema}</span>{" "}
                                    undoes the structural change and removes v{entry.version} from
                                    the ledger, so it becomes pending again. Rows this rollback
                                    drops are gone, and rows the original migration deleted do not
                                    come back.
                                  </div>
                                </div>
                              </div>

                              {registryDownSql ? (
                                <details>
                                  <summary
                                    className="text-[12px] cursor-pointer select-none"
                                    style={{ color: "var(--text-3)" }}
                                  >
                                    Show{" "}
                                    <span className="mono">v{entry.version}.down.sql</span> (
                                    {countOf(getSqlLineCount(registryDownSql), "line")})
                                  </summary>
                                  <pre className="err-pre">{registryDownSql}</pre>
                                </details>
                              ) : (
                                <div className="text-[12px]" style={{ color: "var(--text-3)" }}>
                                  This version has no file in the registry for{" "}
                                  <span className="mono">{preflightResult.schema}</span> — it was
                                  applied here directly. The rollback recorded with it at that
                                  time is what runs.
                                </div>
                              )}

                              {revertError && <pre className="err-pre">{revertError}</pre>}

                              {targetIsProduction && (
                                <ProductionGate
                                  what={`roll back v${entry.version}`}
                                  acknowledged={revertAcknowledged}
                                  onAcknowledge={setRevertAcknowledged}
                                />
                              )}

                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  className="btn btn-destructive btn-sm"
                                  disabled={
                                    revertBusy ||
                                    (targetIsProduction && !revertAcknowledged)
                                  }
                                  onClick={() => void handleRevert(entry.version)}
                                >
                                  {revertBusy ? "Rolling back…" : `Roll back v${entry.version}`}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  disabled={revertBusy}
                                  onClick={() => setRevertVersion(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {pendingScripts.length === 0 ? (
                <div className="card p-8 text-center">
                  <div className="w-12 h-12 rounded-full grid place-items-center mx-auto mb-3" style={{ background: "var(--sync-soft)", color: "var(--sync)" }}>
                    <CheckIcon size={22} />
                  </div>
                  <div className="text-[15px] font-semibold">Already up to date</div>
                  <p className="help mt-1">
                    No pending migrations for <span className="mono">{scriptGroup}</span> in{" "}
                    <span className="mono">{preflightResult.schema}</span>. The ledger is at{" "}
                    <span className="mono">{currentLabel}</span>.
                  </p>
                </div>
              ) : (
                <div className="grid gap-6 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]">
                  {/* Left: pending list + (stubbed) drift pre-check */}
                  <div className="space-y-4">
                    <div className="flex items-end justify-between gap-3 flex-wrap">
                      <div>
                        <div className="section-title">Pending migrations</div>
                        <h2 className="text-[18px] font-semibold tracking-[-0.005em] mt-1">
                          {pendingScripts.length} pending · {scriptsUpToTarget.length} in this run
                        </h2>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[12px]" style={{ color: "var(--text-3)" }}>Deploy up to</span>
                        <Select
                          variant="input"
                          ariaLabel="Deploy up to version"
                          style={{ width: "auto" }}
                          mono
                          value={targetVersion}
                          options={pendingScripts.map((s, i) => ({
                            value: s.version,
                            label: `v${s.version}${i === pendingScripts.length - 1 ? " (latest)" : ""}`,
                          }))}
                          onChange={(value) => setTargetVersion(value)}
                        />
                      </div>
                    </div>

                    <div>
                      {pendingScripts.map((script, i) => {
                        const kind = changeTypeOf(script.sql_content);
                        const from = i === 0 ? currentLabel : `v${pendingScripts[i - 1].version}`;
                        const inRun = targetVersion
                          ? compareVersions(script.version, targetVersion) <= 0
                          : false;
                        return (
                          <MigRow
                            key={scriptKey(script)}
                            seq={String(i + 1).padStart(2, "0")}
                            name={script.script_name}
                            kind={kind}
                            sub={`${from} → v${script.version} · ${countOf(getSqlLineCount(script.sql_content), "line")}`}
                            rightPill={bumpWord(kind)}
                            cell={{ status: "queued" }}
                            selected={inRun}
                            sql={script.sql_content}
                            sqlOpen={inRun && kind === "breaking"}
                          />
                        );
                      })}
                    </div>

                    {/* Drift pre-check — real lineage compare when the target is tracked */}
                    <DriftPanel
                      phase={driftPhase}
                      result={driftResult}
                      error={driftError}
                      context="precheck"
                      targetVersion={targetVersion}
                    />
                  </div>

                  {/* Right: summary + checklist */}
                  <aside className="space-y-4">
                    <div className="card p-5">
                      <div className="section-title mb-2">Summary</div>
                      <div className="vline mt-2">
                        <span className="vchip">{currentLabel}</span>
                        <ChevronRightIcon size={16} />
                        <span className="vchip next"><b>{targetVersion ? `v${targetVersion}` : "—"}</b></span>
                      </div>
                      <div className="grid grid-cols-2 gap-y-2 gap-x-4 mt-4 text-[12.5px]">
                        <div className="flex justify-between"><span style={{ color: "var(--text-3)" }}>Migrations</span><span className="mono">{scriptsUpToTarget.length}</span></div>
                        <div className="flex justify-between"><span style={{ color: "var(--text-3)" }}>Bump</span><span>{bumps}</span></div>
                        <div className="flex justify-between"><span style={{ color: "var(--text-3)" }}>Breaking</span><span className="mono">{breakingCount}</span></div>
                        <div className="flex justify-between"><span style={{ color: "var(--text-3)" }}>Lines of SQL</span><span className="mono">{linesOfSql}</span></div>
                        <div className="flex justify-between"><span style={{ color: "var(--text-3)" }}>Strategy</span><span>one transaction</span></div>
                      </div>

                      <div className="space-y-3 mt-4">
                        {targetIsProduction && (
                          <ProductionGate
                            what={`run ${scriptsUpToTarget.length} migration${scriptsUpToTarget.length === 1 ? "" : "s"}`}
                            acknowledged={deployAcknowledged}
                            onAcknowledge={setDeployAcknowledged}
                          />
                        )}
                        {breakingCount > 0 && (
                          <RiskGate
                            tone="break"
                            title={`${breakingCount} breaking migration${breakingCount === 1 ? "" : "s"}`}
                            body={
                              "A breaking migration drops or rewrites structure that is " +
                              "already there. Anything reading the old shape — an app, a " +
                              "view, a report — stops working the moment this commits, and " +
                              "the rollback restores the structure, not the rows that were " +
                              "in it. The breaking ones in the list on the left are open " +
                              "already, showing the statements they will run."
                            }
                            ack={`I have read the ${breakingCount === 1 ? "breaking migration" : "breaking migrations"} and know what they remove.`}
                            acknowledged={breakingAcknowledged}
                            onAcknowledge={setBreakingAcknowledged}
                          />
                        )}
                        {dataLossScripts.length > 0 && (
                          <RiskGate
                            tone="break"
                            title={`${dataLossScripts.length} migration${dataLossScripts.length === 1 ? "" : "s"} deletes rows`}
                            body={
                              `This run contains ${dataLossKinds}. Those take rows out of ` +
                              "a live table, and no rollback puts them back — a down " +
                              "script rebuilds structure, not data. Nothing else on this " +
                              "page catches this: a TRUNCATE changes no structure, so it " +
                              "is graded a patch and shows no breaking pill. Have a " +
                              "backup you can restore from before running this."
                            }
                            ack="I have read these statements and know which rows they delete."
                            acknowledged={dataLossAcknowledged}
                            onAcknowledge={setDataLossAcknowledged}
                          />
                        )}
                        {driftBlocks && driftResult && (
                          <RiskGate
                            tone="drift"
                            title={
                              driftResult.status === "drifted"
                                ? "The target has drifted"
                                : "The target could not be checked"
                            }
                            body={
                              driftResult.status === "drifted"
                                ? "The live schema no longer matches the snapshot these " +
                                  "migrations were written against, so a migration may hit " +
                                  "an object that is not the one it expects. Read the drift " +
                                  "report on the left before running this."
                                : "The drift check could not reach the target, so nothing " +
                                  "here has confirmed what state it is in. The run will " +
                                  "still connect — this only means it starts unverified."
                            }
                            ack={
                              driftResult.status === "drifted"
                                ? "I have read the drift and mean to run anyway."
                                : "I mean to run without a drift check."
                            }
                            acknowledged={driftAcknowledged}
                            onAcknowledge={setDriftAcknowledged}
                          />
                        )}
                        {targetIsProduction && (
                          <ApprovalPanel
                            migrationCount={scriptsUpToTarget.length}
                            targetVersion={targetVersion}
                            hashReady={runHash !== null}
                            hashError={hashError}
                            loading={approvalsLoading}
                            error={approvalError}
                            busy={approvalBusy}
                            approved={approvedRun}
                            pending={pendingRun}
                            latest={latestRun}
                            viewerEmail={user?.email ?? ""}
                            isAdmin={isAdmin}
                            bypass={bypass}
                            note={approvalNote}
                            onNoteChange={setApprovalNote}
                            onRequest={handleRequestApproval}
                            onDecide={handleDecideApproval}
                          />
                        )}
                      </div>

                      <button
                        type="button"
                        className={`btn btn-lg w-full mt-5 ${targetIsProduction ? "btn-destructive" : "btn-primary"}`}
                        disabled={deployBlocked}
                        onClick={() => handleRun(false)}
                      >
                        <DeployIcon size={14} />
                        Deploy {scriptsUpToTarget.length} migration{scriptsUpToTarget.length === 1 ? "" : "s"}
                        {targetIsProduction ? " to production" : ""}
                      </button>
                      {/* A rehearsal writes nothing, but it really runs the SQL —
                          including any statement that takes a heavy lock — so it
                          sits behind the same production confirmation. */}
                      <button
                        type="button"
                        className="btn btn-secondary w-full mt-2"
                        disabled={runBlocked}
                        onClick={() => handleRun(true)}
                      >
                        <EyeIcon size={14} />
                        Dry run — execute and roll back
                      </button>
                      <div className="text-[11px] mt-2 text-center" style={{ color: "var(--text-3)" }}>
                        {hasTxnViolation
                          ? "Resolve the transaction-control issue below first"
                          : (targetIsProduction && !deployAcknowledged) ||
                              (breakingCount > 0 && !breakingAcknowledged) ||
                              (driftBlocks && !driftAcknowledged)
                            ? "Tick every box above to enable this"
                            : targetIsProduction && !approvedRun
                              ? "Deploy needs a second person's approval — a dry run does not"
                              : "All migrations run in one transaction — all of them or none"}
                      </div>
                    </div>

                    <div className="card p-5">
                      <div className="section-title mb-3">Pre-flight checklist</div>
                      <ul className="space-y-2 text-[12.5px]" style={{ color: "var(--text-2)" }}>
                        <ChecklistItem ok>Target reachable · {activeConn.host}</ChecklistItem>
                        {targetIsProduction ? (
                          <ChecklistItem ok={deployAcknowledged}>
                            Environment · production —{" "}
                            {deployAcknowledged ? "confirmed" : "needs an explicit confirmation"}
                          </ChecklistItem>
                        ) : targetEnvironment === "unset" ? (
                          <ChecklistItem info>
                            Environment · unlabelled — nothing here can warn you about this target
                          </ChecklistItem>
                        ) : (
                          <ChecklistItem ok>
                            Environment · {targetEnvironment}
                          </ChecklistItem>
                        )}
                        <ChecklistItem ok>
                          Applied state read · {preflightResult.currentVersion ? <>at <span className="mono">v{preflightResult.currentVersion}</span></> : "fresh — no versions yet"}
                        </ChecklistItem>
                        <ChecklistItem ok={!hasTxnViolation}>
                          {hasTxnViolation
                            ? `Transaction control found in ${txnViolationScripts.length} script${txnViolationScripts.length === 1 ? "" : "s"}`
                            : "No transaction-control in SQL"}
                        </ChecklistItem>
                        {breakingCount > 0 ? (
                          <ChecklistItem ok={breakingAcknowledged}>
                            Breaking changes · {breakingCount}{" "}
                            {breakingAcknowledged ? "· acknowledged" : "· need acknowledging"}
                          </ChecklistItem>
                        ) : (
                          <ChecklistItem ok>
                            Nothing in this run drops or rewrites structure
                          </ChecklistItem>
                        )}
                        {dataLossScripts.length > 0 ? (
                          <ChecklistItem ok={dataLossAcknowledged}>
                            Deletes rows · {dataLossKinds} in{" "}
                            {countOf(dataLossScripts.length, "script")}{" "}
                            {dataLossAcknowledged ? "· acknowledged" : "· needs acknowledging"}
                          </ChecklistItem>
                        ) : (
                          <ChecklistItem ok>Nothing in this run deletes rows</ChecklistItem>
                        )}
                        {targetIsProduction && (
                          <ChecklistItem ok={Boolean(approvedRun)}>
                            {approvedRun
                              ? `Approved by ${approvedRun.decided_by ?? "a second person"}`
                              : pendingRun
                                ? "Approval requested · waiting for a second person"
                                : "Approval · not requested yet"}
                          </ChecklistItem>
                        )}
                        {preflightResult.needsInit ? (
                          <ChecklistItem info>Ledger table will be created on first deploy</ChecklistItem>
                        ) : (
                          <ChecklistItem ok>Ledger table present · <span className="mono">script_patch</span></ChecklistItem>
                        )}
                        {driftPhase === "loading" && (
                          <ChecklistItem info>Drift check · checking the target…</ChecklistItem>
                        )}
                        {driftPhase === "untracked" && (
                          <ChecklistItem stub>Drift check · target not tracked</ChecklistItem>
                        )}
                        {driftPhase === "error" && (
                          <ChecklistItem ok={false}>Drift check · check failed</ChecklistItem>
                        )}
                        {driftPhase === "ready" && driftResult && (
                          driftResult.status === "in_sync" ? (
                            <ChecklistItem ok>
                              Drift check · in sync
                              {driftResult.expectedVersion ? (
                                <> with <span className="mono">v{driftResult.expectedVersion}</span></>
                              ) : null}
                            </ChecklistItem>
                          ) : driftResult.status === "drifted" ? (
                            <ChecklistItem ok={driftAcknowledged}>
                              Drift check · live schema has drifted
                              {driftAcknowledged ? " · acknowledged" : ""}
                            </ChecklistItem>
                          ) : (
                            <ChecklistItem ok={driftAcknowledged}>
                              Drift check · target unreachable
                              {driftAcknowledged ? " · acknowledged" : ""}
                            </ChecklistItem>
                          )
                        )}
                        {driftPhase === "idle" && (
                          <ChecklistItem stub>Drift check · run a check to see status</ChecklistItem>
                        )}
                      </ul>
                    </div>
                  </aside>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* ═══════════════════ STAGE 2 — RUN ═══════════════════ */}
      {stage === 2 && (
        <section className="px-8 pb-12">
          <div
            className="card p-5 mb-5 flex items-center gap-3 flex-wrap"
            style={{
              background: "color-mix(in oklab, var(--brand) 4%, var(--surface))",
              borderColor: "color-mix(in oklab, var(--brand) 35%, var(--border))",
            }}
          >
            <DeployIcon size={18} />
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold">
                {isDeploying
                  ? runIsDryRun
                    ? "Rehearsing migrations…"
                    : "Applying migrations…"
                  : allApplied
                    ? "Run finished"
                    : allRehearsed
                      ? "Dry run finished — nothing was written"
                      : runIsDryRun
                        ? "Dry run halted"
                        : "Run halted — nothing was applied"}
              </div>
              <div className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
                {runIsDryRun
                  ? "Every migration really runs against the target, inside one transaction that always ends in ROLLBACK."
                  : "Every migration runs inside one transaction. A failure rolls the whole run back — all of them or none."}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Which database this is landing on, while it is landing. */}
              <EnvironmentPill environment={targetEnvironment} />
              {runIsDryRun && (
                <span className="pill pill-neutral">
                  <span className="dot" style={{ background: "var(--text-3)" }} />
                  dry run
                </span>
              )}
              <span className="mono text-[12.5px]" style={{ color: "var(--text-3)" }}>elapsed {fmtSecs(elapsedMs)}</span>
            </div>
          </div>

          {/* A failure that belongs to the run, not to any one migration. */}
          {runError && (
            <div
              className="card p-4 mb-5 flex items-start gap-3"
              style={{
                borderColor: "color-mix(in oklab, var(--break) 40%, var(--border))",
                background: "color-mix(in oklab, var(--break) 5%, var(--surface))",
              }}
            >
              <AlertTriangleIcon size={16} />
              <div className="text-[12.5px] min-w-0" style={{ color: "var(--text-2)" }}>
                {runError}
              </div>
            </div>
          )}

          <div>
            {runScripts.map((script, i) => {
              const kind = changeTypeOf(script.sql_content);
              const cell = runStatus[scriptKey(script)] ?? { status: "queued" };
              const ran = cell.statements !== undefined ? ` · ${fmtStatements(cell.statements)}` : "";
              const subByStatus: Record<RunStatus, string> = {
                queued: "queued · waiting",
                running: "running · in the run's transaction",
                applied: `applied · committed with the run${ran}`,
                rehearsed: `rehearsed · rolled back with the run${ran}`,
                failed: `failed · the whole run was rolled back${cell.error ? ` · ${cell.error}` : ""}`,
                skipped: "skipped · the run rolled back before this one could commit",
              };
              return (
                <MigRow
                  key={scriptKey(script)}
                  seq={String(i + 1).padStart(2, "0")}
                  name={script.script_name}
                  kind={kind}
                  sub={subByStatus[cell.status]}
                  rightPill={`v${script.version}`}
                  cell={cell}
                  sql={script.sql_content}
                />
              );
            })}
          </div>

          <div className="mt-6 flex items-center justify-between text-[12px] flex-wrap gap-2" style={{ color: "var(--text-3)" }}>
            <span>
              {runProgress} of {runScripts.length} {runIsDryRun ? "rehearsed" : "applied"}
              {totalStatements > 0 ? ` · ${fmtStatements(totalStatements)}` : ""} ·{" "}
              <span className="mono">{schema} @ {activeConn?.name}</span>
            </span>
            <span>one transaction · a failure rolls the whole run back</span>
          </div>

          {/* Clean rehearsal — say what it proved, and offer the real thing. */}
          {runComplete && allRehearsed && (
            <div
              className="card p-4 mt-4 flex items-center gap-3 flex-wrap"
              style={{
                borderColor: "color-mix(in oklab, var(--sync) 40%, var(--border))",
                background: "color-mix(in oklab, var(--sync) 5%, var(--surface))",
              }}
            >
              <CheckIcon size={16} />
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-semibold">
                  Rehearsal clean — the target accepted every migration.
                </div>
                <div className="text-[12px]" style={{ color: "var(--text-2)" }}>
                  Then it was rolled back: no ledger rows, no lineage advance, no schema
                  change. The ledger has been re-read and still reads{" "}
                  <span className="mono">
                    {preflightResult?.currentVersion ? `v${preflightResult.currentVersion}` : "no versions yet"}
                  </span>.
                </div>
                {targetIsProduction && !approvedRun && (
                  <div className="text-[12px] mt-1" style={{ color: "var(--drift)" }}>
                    A clean rehearsal is not an approval. Go back to Pre-flight to ask
                    someone else to clear the real run.
                  </div>
                )}
              </div>
              <button
                type="button"
                className={`btn btn-sm ${targetIsProduction ? "btn-destructive" : "btn-primary"}`}
                disabled={deployBlocked}
                onClick={() => handleRun(false)}
              >
                <DeployIcon size={13} />
                Deploy for real
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setStage(1)}>
                Back to Pre-flight
              </button>
            </div>
          )}

          {/* Recovery bar — only after a failed run */}
          {runComplete && !allApplied && !allRehearsed && (
            <div
              className="card p-4 mt-4 flex items-center gap-3 flex-wrap"
              style={{
                borderColor: "color-mix(in oklab, var(--break) 40%, var(--border))",
                background: "color-mix(in oklab, var(--break) 5%, var(--surface))",
              }}
            >
              <AlertCircleIcon size={16} />
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-semibold">Run did not complete.</div>
                <div className="text-[12px]" style={{ color: "var(--text-2)" }}>
                  The transaction rolled back, so the target is exactly as it was — including
                  the migrations listed above the failure. Fix the script and run it again.
                  The ledger has been re-read.
                </div>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={runIsDryRun ? runBlocked : deployBlocked}
                onClick={() => handleRun(runIsDryRun)}
              >
                {runIsDryRun ? "Rehearse again" : "Run again"}
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setStage(1)}>
                Back to Pre-flight
              </button>
            </div>
          )}
        </section>
      )}

      {/* ═══════════════════ STAGE 3 — VERIFY ═══════════════════ */}
      {stage === 3 && (
        <section className="px-8 pb-12">
          <div className="verify-hero">
            <div className="ring" />
            <div className="relative flex items-start gap-5 flex-wrap">
              <div className="check-big">
                <CheckIcon size={28} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="section-title" style={{ color: "color-mix(in oklab, var(--sync) 70%, var(--text-3))" }}>
                  Deployed
                </div>
                <h2 className="text-[26px] font-semibold tracking-[-0.015em] mt-1">
                  Migrations applied to the target.
                </h2>
                <p className="text-[14px] mt-2" style={{ color: "var(--text-2)" }}>
                  <span className="mono" style={{ color: "var(--text)" }}>{schema}</span> on{" "}
                  <span className="mono" style={{ color: "var(--text)" }}>{activeConn?.name}</span>{" "}
                  now reports{" "}
                  <span className="mono" style={{ color: "var(--text)" }}>
                    v{preflightResult?.currentVersion ?? targetVersion}
                  </span>{" "}
                  in its migration ledger.
                </p>
                <div className="vline mt-4">
                  <span className="vchip">{currentLabel}</span>
                  <ChevronRightIcon size={16} />
                  <span className="vchip ok"><b>v{targetVersion}</b></span>
                  <span className="text-[12px] ml-2" style={{ color: "var(--text-3)" }}>
                    {fmtSecs(elapsedMs)} · {appliedScripts.length} migration{appliedScripts.length === 1 ? "" : "s"} in one transaction · 0 errors
                  </span>
                </div>
                <div className="flex gap-2 mt-5 flex-wrap">
                  <button type="button" className="btn btn-primary" onClick={handlePreflight}>
                    Re-check target
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => setStage(1)}>
                    Back to Pre-flight
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-5 mt-5">
            <div className="card p-5">
              <div className="section-title mb-3">What was applied</div>
              <div className="space-y-1">
                {appliedScripts.map((s, i) => (
                  <div key={scriptKey(s)} className="ssr">
                    <span className="mono">
                      <span style={{ color: "var(--text-3)" }}>{String(i + 1).padStart(2, "0")}</span>{" "}
                      {s.script_name} <span style={{ color: "var(--text-3)" }}>v{s.version}</span>
                    </span>
                    <span className="pill pill-sync">
                      <span className="dot" />
                      applied · {fmtStatements(runStatus[scriptKey(s)]?.statements ?? 0)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Verify re-diff — real lineage compare when the target is tracked */}
            <div className="card p-5">
              <div className="section-title mb-3">Verify diff</div>
              <DriftPanel
                phase={driftPhase}
                result={driftResult}
                error={driftError}
                context="verify"
                targetVersion={targetVersion}
              />
            </div>
          </div>
        </section>
      )}

      <footer className="px-8 pb-8 text-[12px]" style={{ color: "var(--text-3)" }}>
        Schema Studio · Deploy (S5)
      </footer>

      {/* Toast */}
      <div className={`toast${toastShow ? " show" : ""}`}>
        <CheckIcon size={14} />
        <span>{toastMsg}</span>
      </div>
    </div>
  );
}

// Drift pre-check panel (Phase 6). Renders the real lineage drift state for the
// chosen target — or an honest "not tracked" message — in place of the old stub.
// Shared by the stage-1 pre-check and the stage-3 post-deploy verify; the copy
// shifts slightly via `context`.
function DriftPanel({
  phase,
  result,
  error,
  context,
  targetVersion,
}: {
  phase: DriftPhase;
  result: DriftResult | null;
  error: string | null;
  context: "precheck" | "verify";
  targetVersion: string;
}) {
  // Defaults cover the loading state; each case below overrides what it needs.
  let icon = <span className="spin" style={{ width: 16, height: 16 }} />;
  let circle: React.CSSProperties = { background: "var(--surface-3)", color: "var(--text-3)" };
  let title =
    context === "verify" ? "Re-checking the schema…" : "Checking the target for drift…";
  let body: React.ReactNode = "Comparing the live schema against its tracked snapshot.";
  let pillClass = "pill pill-neutral";
  let pillText = "checking";

  if (phase === "idle") {
    icon = <DriftIcon size={16} />;
    title = "Drift check not run yet";
    body = "Run a database check to compare the live schema against its tracked snapshot.";
    pillText = "idle";
  } else if (phase === "untracked") {
    icon = <DriftIcon size={16} />;
    title = "Target schema isn't tracked";
    body =
      "Track this schema on the Dashboard to capture a baseline snapshot — drift checks then compare the live structure against it. Until then this deploy assumes the target matches its migration ledger.";
    pillText = "not tracked";
  } else if (phase === "error") {
    icon = <AlertCircleIcon size={16} />;
    title = "Drift check couldn't run";
    body = error ?? "Something went wrong running the drift check.";
    pillText = "error";
  } else if (phase === "ready" && result) {
    const v = result.expectedVersion ? `v${result.expectedVersion}` : "its snapshot";
    if (result.status === "unreachable") {
      icon = <AlertTriangleIcon size={16} />;
      circle = {
        background: "color-mix(in oklab, var(--drift) 12%, var(--surface))",
        color: "var(--drift)",
      };
      title = "Target unreachable";
      body = result.summary;
      pillText = "unreachable";
    } else if (result.status === "in_sync") {
      icon = <CheckIcon size={16} />;
      circle = { background: "var(--sync-soft)", color: "var(--sync)" };
      title =
        context === "verify"
          ? `Verified — live schema matches ${v}`
          : `No drift — target matches ${v}`;
      body = result.summary;
      pillClass = "pill pill-sync";
      pillText = "in sync";
    } else {
      // drifted
      icon = <DriftIcon size={16} />;
      circle = {
        background: "color-mix(in oklab, var(--drift) 12%, var(--surface))",
        color: "var(--drift)",
      };
      title = "Schema drift detected";
      body = (
        <>
          {result.summary}{" "}
          {context === "verify" ? (
            <>
              Re-snapshot the target on the Dashboard to record{" "}
              <span className="mono">v{targetVersion}</span> as its new expected baseline.
            </>
          ) : (
            "Review before deploying — the live structure differs from its tracked snapshot."
          )}
        </>
      );
      pillClass = "pill pill-pending";
      pillText = "drift";
    }
  }

  return (
    <div className="precheck-muted">
      <div
        className="w-9 h-9 rounded-full grid place-items-center flex-none"
        style={circle}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-semibold">{title}</div>
        <div className="text-[12.5px] mt-0.5" style={{ color: "var(--text-2)" }}>
          {body}
        </div>
      </div>
      <span className={pillClass}>{pillText}</span>
    </div>
  );
}

// Small checklist line — green check (ok), warn (ok=false), info, or stub.
function ChecklistItem({
  ok,
  info,
  stub,
  children,
}: {
  ok?: boolean;
  info?: boolean;
  stub?: boolean;
  children: React.ReactNode;
}) {
  let icon = <CheckIcon size={13} style={{ color: "var(--sync)" }} />;
  if (stub) icon = <span className="w-[13px] h-[13px] rounded-full inline-block flex-none" style={{ border: "1.5px dashed var(--text-3)" }} />;
  else if (info) icon = <InfoIcon size={13} style={{ color: "var(--pending)" }} />;
  else if (ok === false) icon = <AlertTriangleIcon size={13} style={{ color: "var(--drift)" }} />;
  return (
    <li className="flex items-center gap-2">
      <span className="flex-none grid place-items-center">{icon}</span>
      <span style={stub ? { color: "var(--text-3)" } : undefined}>{children}</span>
    </li>
  );
}
