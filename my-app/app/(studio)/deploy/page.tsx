"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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
  LogoIcon,
} from "@/components/ui/icons";
import {
  compareVersions,
  buildVersionLedger,
  type LedgerEntry,
} from "@/lib/script-status";
import { containsTransactionControl } from "@/lib/sql-guard";

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
//   • /api/scripts/apply runs ONE migration inside its own transaction.
//     We drive it sequentially, stopping on the first failure (earlier steps
//     stay applied — each is its own committed transaction).
//
// Honest-stub rule ("stub, don't fake"): two pieces depend on schema snapshots
// that don't exist until a later phase, so they are shown clearly stubbed and
// never wired to fake-but-real-looking data:
//   • the drift pre-check (stage 1) and
//   • the post-deploy verify re-diff (stage 3).
// Everything else — versions, pending list, per-step timing, the ledger
// re-read after a run — is real.
// ---------------------------------------------------------------------------

type ChangeKind = "breaking" | "additive" | "patch";

// A migration script, loaded from the GitHub repo (the source of truth).
type GitHubScript = {
  database_name: string;
  schema_name: string;
  script_name: string;
  version: string;
  path: string;
  download_url: string;
  sql_content: string;
};

// A saved connection from /api/connections.
type Connection = {
  id: number;
  name: string;
  host: string;
  port: number;
  database_name: string;
  type: string;
};

// One row of the target's applied history.
type PatchEntry = {
  version: string;
  title: string | null;
  change_type: string;
  applied_at: string;
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
type RunStatus = "queued" | "running" | "applied" | "failed" | "skipped";
type RunCell = { status: RunStatus; error?: string; ms?: number };

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

function inferChangeKind(sql: string): ChangeKind {
  const normalized = sql.toLowerCase();
  if (
    normalized.includes("drop table") ||
    normalized.includes("drop column") ||
    normalized.includes("drop constraint") ||
    normalized.includes(" set not null") ||
    normalized.includes(" alter column") ||
    normalized.includes(" rename ")
  ) {
    return "breaking";
  }
  if (
    normalized.includes("create table") ||
    normalized.includes("add column") ||
    normalized.includes("add constraint") ||
    normalized.includes("create index")
  ) {
    return "additive";
  }
  return "patch";
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
  if (cell.status === "applied") {
    return (
      <span className="right-status" style={{ color: "var(--sync)" }}>
        <span className="status-ico applied">
          <CheckIcon size={11} />
        </span>
        applied{cell.ms !== undefined ? ` · ${fmtSecs(cell.ms)}` : ""}
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
}: {
  seq: string;
  name: string;
  kind: ChangeKind;
  sub: string;
  rightPill: string;
  cell: RunCell;
  selected?: boolean;
}) {
  const cls = ["mig-row", cell.status, selected ? "selected" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div>
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
    </div>
  );
}

export default function DeployPage() {
  // ── Selection state ──────────────────────────────────────────────────────
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
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

  // ── Drift pre-check (Phase 6 lineage) ────────────────────────────────────
  const [driftPhase, setDriftPhase] = useState<DriftPhase>("idle");
  const [driftResult, setDriftResult] = useState<DriftResult | null>(null);
  const [driftError, setDriftError] = useState<string | null>(null);

  // ── Stepper + run ────────────────────────────────────────────────────────
  const [stage, setStage] = useState<1 | 2 | 3>(1);
  const [isDeploying, setIsDeploying] = useState(false);
  // The exact ordered batch captured at run start — the run/verify lists render
  // from this, so a post-run preflight refresh can't reshuffle them.
  const [runScripts, setRunScripts] = useState<GitHubScript[]>([]);
  const [runStatus, setRunStatus] = useState<Record<string, RunCell>>({});
  const [runComplete, setRunComplete] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const stopRef = useRef(false);
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
      .then((r) => r.json())
      .then((data: unknown) => {
        if (Array.isArray(data)) setConnections(data as Connection[]);
      })
      .catch(() => {
        /* leave empty — the UI shows a "no connections" hint */
      })
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
    (s) => inferChangeKind(s.sql_content) === "breaking"
  ).length;
  const linesOfSql = scriptsUpToTarget.reduce(
    (sum, s) => sum + getSqlLineCount(s.sql_content),
    0
  );
  const bumps = useMemo(() => {
    const order: Array<"major" | "minor" | "patch"> = ["major", "minor", "patch"];
    const present = new Set(
      scriptsUpToTarget.map((s) => bumpWord(inferChangeKind(s.sql_content)))
    );
    return order.filter((b) => present.has(b)).join(" + ") || "—";
  }, [scriptsUpToTarget]);
  const txnViolationScripts = scriptsUpToTarget.filter((s) => containsTransactionControl(s.sql_content));
  const hasTxnViolation = txnViolationScripts.length > 0;

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

  function resetDrift() {
    setDriftPhase("idle");
    setDriftResult(null);
    setDriftError(null);
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
    try {
      const lookupRes = await fetch(
        `/api/lineage/lookup?connectionId=${encodeURIComponent(id)}&schemaName=${encodeURIComponent(sch)}`,
        { cache: "no-store" }
      );
      const lookup = (await lookupRes.json()) as {
        tracked?: boolean;
        trackedSchemaId?: number;
      };
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
    stopRef.current = false;
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsDeploying(false);
    setRunScripts([]);
    setRunStatus({});
    setRunComplete(false);
    setElapsedMs(0);
  }

  // ── The deploy run ───────────────────────────────────────────────────────
  // Drives /api/scripts/apply once per migration, in ascending order. Each call
  // is its own transaction on the server, so a failure stops the run with every
  // earlier step already committed and every later step left untouched.
  async function handleDeploy() {
    const batch = scriptsUpToTarget;
    if (batch.length === 0 || isDeploying) return;

    setRunScripts(batch);
    setRunStatus(
      Object.fromEntries(batch.map((s) => [scriptKey(s), { status: "queued" } as RunCell]))
    );
    setRunComplete(false);
    setIsDeploying(true);
    stopRef.current = false;
    setStage(2);

    runStartRef.current = performance.now();
    setElapsedMs(0);
    timerRef.current = window.setInterval(() => {
      setElapsedMs(performance.now() - runStartRef.current);
    }, 100);

    let anyFailed = false;
    let stopped = false;

    for (const script of batch) {
      const key = scriptKey(script);
      if (stopRef.current) {
        stopped = true;
        break;
      }
      setRunStatus((prev) => ({ ...prev, [key]: { status: "running" } }));
      const startedAt = performance.now();
      try {
        const res = await fetch("/api/scripts/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectionId: Number(connectionId),
            schemaName: schema || "public",
            script_name: script.script_name,
            sql_content: script.sql_content,
            version: script.version,
            title: script.script_name,
            description: undefined,
            change_type: inferChangeKind(script.sql_content),
            // Link the applied row back to the GitHub file it came from.
            source_ref: script.path,
          }),
        });
        const data = (await res.json()) as { success?: boolean; error?: string };
        const ms = performance.now() - startedAt;
        if (!res.ok || !data.success) {
          setRunStatus((prev) => ({
            ...prev,
            [key]: { status: "failed", error: data.error ?? "Unknown error from apply API.", ms },
          }));
          anyFailed = true;
          break;
        }
        setRunStatus((prev) => ({ ...prev, [key]: { status: "applied", ms } }));
      } catch {
        const ms = performance.now() - startedAt;
        setRunStatus((prev) => ({
          ...prev,
          [key]: { status: "failed", error: "Network error — could not reach /api/scripts/apply.", ms },
        }));
        anyFailed = true;
        break;
      }
    }

    // Anything still queued after a stop/failure becomes "skipped".
    if (anyFailed || stopped) {
      setRunStatus((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          if (next[k].status === "queued") next[k] = { status: "skipped" };
        }
        return next;
      });
    }

    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsDeploying(false);
    setRunComplete(true);

    // Always re-read the ledger so the current version reflects what truly got
    // applied — whether the run finished, was stopped, or failed partway.
    await runPreflightCheck(connectionId, schema, scriptGroup);
    // Re-run the drift check so the Verify step reflects the post-deploy state.
    void runDriftCheck(connectionId, schema);

    if (!anyFailed && !stopped) {
      setStage(3);
      showToast(`Deploy complete · up to v${targetVersion}`);
    } else if (stopped) {
      showToast("Stopped — earlier steps stay applied");
    } else {
      showToast("Deploy halted — a migration failed");
    }
  }

  function requestStop() {
    stopRef.current = true;
    showToast("Stopping after the current step…");
  }

  // ── Stepper helpers ──────────────────────────────────────────────────────
  const appliedScripts = runScripts.filter(
    (s) => runStatus[scriptKey(s)]?.status === "applied"
  );
  const allApplied =
    runScripts.length > 0 &&
    runScripts.every((s) => runStatus[scriptKey(s)]?.status === "applied");
  const runProgress = appliedScripts.length;
  const totalAppliedMs = appliedScripts.reduce(
    (sum, s) => sum + (runStatus[scriptKey(s)]?.ms ?? 0),
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
    { n: 2, name: "Run", sub: "transactional · one at a time" },
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
          Each migration runs in its own transaction. Pick a target connection, schema, and
          script group, then apply pending migrations one at a time.
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
            <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
              <div>
                <label className="label" htmlFor="dep-conn">Connection</label>
                <select
                  id="dep-conn"
                  className="input mt-1"
                  value={connectionId}
                  onChange={(e) => {
                    setConnectionId(e.target.value);
                    setSchema("");
                    setScriptGroup("");
                    setPreflightResult(null);
                    setPreflightError(null);
                    setTargetVersion("");
                    resetRun();
                    resetDrift();
                  }}
                >
                  <option value="">Select a connection…</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} — {c.host}/{c.database_name}
                    </option>
                  ))}
                </select>
                {connectionsLoaded && connections.length === 0 && (
                  <p className="help mt-1">
                    No connections saved yet. Add one on the Connections page first.
                  </p>
                )}
              </div>

              <div>
                <label className="label" htmlFor="dep-schema">Schema</label>
                <select
                  id="dep-schema"
                  className="input mt-1"
                  value={schema}
                  disabled={schemasLoading || !connectionId}
                  onChange={(e) => {
                    setSchema(e.target.value);
                    setScriptGroup("");
                    setPreflightResult(null);
                    setPreflightError(null);
                    setTargetVersion("");
                    resetRun();
                    resetDrift();
                  }}
                >
                  <option value="">
                    {!connectionId
                      ? "Select a connection first"
                      : schemasLoading
                        ? "Loading schemas…"
                        : "Select a schema…"}
                  </option>
                  {schemas.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                {schemasError && <p className="help mt-1" style={{ color: "var(--break)" }}>{schemasError}</p>}
              </div>

              <div>
                <label className="label" htmlFor="dep-group">Script group</label>
                <select
                  id="dep-group"
                  className="input mt-1"
                  value={scriptGroup}
                  disabled={!schema}
                  onChange={(e) => {
                    setScriptGroup(e.target.value);
                    setPreflightResult(null);
                    setPreflightError(null);
                    setTargetVersion("");
                    resetRun();
                    resetDrift();
                  }}
                >
                  <option value="">
                    {!schema ? "Select a schema first" : "Select a script group…"}
                  </option>
                  {schemaScriptNames.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
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
                    {versionLedger.map((entry) => (
                      <div
                        key={entry.version}
                        className="flex items-center justify-between gap-3 py-1.5"
                        style={{ borderTop: "1px solid var(--border)" }}
                      >
                        <span className="mono text-[13px]">v{entry.version}</span>
                        <div className="flex items-center gap-2.5">
                          {entry.status === "applied" && entry.appliedAt && (
                            <span className="text-[11px]" style={{ color: "var(--text-3)" }}>
                              {fmtDate(entry.appliedAt)}
                            </span>
                          )}
                          {ledgerPill(entry.status)}
                        </div>
                      </div>
                    ))}
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
                <div className="grid gap-6" style={{ gridTemplateColumns: "minmax(0,1fr) 360px" }}>
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
                        <select
                          className="input"
                          style={{ width: "auto" }}
                          value={targetVersion}
                          onChange={(e) => setTargetVersion(e.target.value)}
                        >
                          {pendingScripts.map((s, i) => (
                            <option key={scriptKey(s)} value={s.version}>
                              v{s.version}{i === pendingScripts.length - 1 ? " (latest)" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div>
                      {pendingScripts.map((script, i) => {
                        const kind = inferChangeKind(script.sql_content);
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
                            sub={`${from} → v${script.version} · ${getSqlLineCount(script.sql_content)} lines`}
                            rightPill={bumpWord(kind)}
                            cell={{ status: "queued" }}
                            selected={inRun}
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
                        <div className="flex justify-between"><span style={{ color: "var(--text-3)" }}>Strategy</span><span>txn-per-step</span></div>
                      </div>

                      <button
                        type="button"
                        className="btn btn-primary btn-lg w-full mt-5"
                        disabled={scriptsUpToTarget.length === 0 || hasTxnViolation || isDeploying}
                        onClick={handleDeploy}
                      >
                        <DeployIcon size={14} />
                        Deploy {scriptsUpToTarget.length} migration{scriptsUpToTarget.length === 1 ? "" : "s"}
                      </button>
                      <div className="text-[11px] mt-2 text-center" style={{ color: "var(--text-3)" }}>
                        {hasTxnViolation
                          ? "Resolve the transaction-control issue below first"
                          : "Each step commits before the next begins"}
                      </div>
                    </div>

                    <div className="card p-5">
                      <div className="section-title mb-3">Pre-flight checklist</div>
                      <ul className="space-y-2 text-[12.5px]" style={{ color: "var(--text-2)" }}>
                        <ChecklistItem ok>Target reachable · {activeConn.host}</ChecklistItem>
                        <ChecklistItem ok>
                          Applied state read · {preflightResult.currentVersion ? <>at <span className="mono">v{preflightResult.currentVersion}</span></> : "fresh — no versions yet"}
                        </ChecklistItem>
                        <ChecklistItem ok={!hasTxnViolation}>
                          {hasTxnViolation
                            ? `Transaction control found in ${txnViolationScripts.length} script${txnViolationScripts.length === 1 ? "" : "s"}`
                            : "No transaction-control in SQL"}
                        </ChecklistItem>
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
                            <ChecklistItem ok={false}>Drift check · live schema has drifted</ChecklistItem>
                          ) : (
                            <ChecklistItem ok={false}>Drift check · target unreachable</ChecklistItem>
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
                {isDeploying ? "Applying migrations…" : runComplete && allApplied ? "Run finished" : "Run halted"}
              </div>
              <div className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
                Each migration runs in its own transaction. A failure stops the run and rolls that step back.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="mono text-[12.5px]" style={{ color: "var(--text-3)" }}>elapsed {fmtSecs(elapsedMs)}</span>
              {isDeploying && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={requestStop}>
                  Stop
                </button>
              )}
            </div>
          </div>

          <div>
            {runScripts.map((script, i) => {
              const kind = inferChangeKind(script.sql_content);
              const cell = runStatus[scriptKey(script)] ?? { status: "queued" };
              const subByStatus: Record<RunStatus, string> = {
                queued: "queued · waiting",
                running: "running · in its own transaction",
                applied: `applied · txn committed${cell.ms !== undefined ? ` · ${fmtSecs(cell.ms)}` : ""}`,
                failed: "failed · txn rolled back · earlier steps stay applied",
                skipped: "skipped · run stopped before this step",
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
                />
              );
            })}
          </div>

          <div className="mt-6 flex items-center justify-between text-[12px] flex-wrap gap-2" style={{ color: "var(--text-3)" }}>
            <span>
              {runProgress} of {runScripts.length} applied ·{" "}
              <span className="mono">{schema} @ {activeConn?.name}</span>
            </span>
            <span>txn rollback on failure · earlier steps stay applied</span>
          </div>

          {/* Recovery bar — only after a stop/failure */}
          {runComplete && !allApplied && (
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
                  Applied steps stay committed · the failed/stopped step was rolled back · later steps were skipped.
                  The ledger has been re-read.
                </div>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={isDeploying || scriptsUpToTarget.length === 0}
                onClick={handleDeploy}
              >
                Retry remaining
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
                    {fmtSecs(totalAppliedMs)} · {appliedScripts.length} migration{appliedScripts.length === 1 ? "" : "s"} · 0 errors
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
                      applied · {fmtSecs(runStatus[scriptKey(s)]?.ms ?? 0)}
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
