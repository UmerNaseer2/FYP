"use client";

// ---------------------------------------------------------------------------
// Quick run: type SQL (or describe the change and let AI write it) and run it
// on one schema straight from the Deploy page.
//
// It is an ordinary versioned run, not a side door:
//   - the SQL goes to /api/scripts/apply like every Deploy run, so it runs in
//     one transaction and lands in the schema's script_patch ledger as one
//     version of one script group (quick-changes unless the user names another);
//   - the apply route saves that version, and its rollback, to GitHub right
//     after the commit, the same step every Deploy run takes;
//   - the version is picked from the change level, the way every screen that
//     saves a script picks it (lib/deploy/quick-run.ts);
//   - roles and approvals decide who may run it, as on the rest of Deploy.
// Two presses: Dry run, then Deploy. Deploy opens only for the exact text the
// dry run passed; any edit locks it again.
//
// The layout and the words follow the Quick run boards in Claude Design.
// ---------------------------------------------------------------------------

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Drawer } from "@/components/ui/Drawer";
import { Select } from "@/components/ui/Select";
import {
  AlertTriangleIcon,
  CheckIcon,
  InfoIcon,
  SparkIcon,
  XIcon,
} from "@/components/ui/icons";
import { useAiAccess } from "@/components/studio/AiPanel";
import { apiFetch } from "@/lib/ui/api-fetch";
import { newRunId } from "@/lib/deploy/run-id";
import { readApplyFailure } from "@/lib/deploy/apply-failure";
import { describeRegistry, readArchivedVersions, type RegistryNote } from "@/lib/github/registry-report";
import { describeChangeType } from "@/lib/versions/change-type";
import { canExecute, toExecuteRole } from "@/lib/connections/access";
import { readAppliedVersion, readFamilyVersions } from "@/lib/versions/family-reads";
import { compareVersions } from "@/lib/versions/script-status";
import {
  isRollbackWriteAnswer,
  isRollbackWriteChecks,
  MAX_ROLLBACK_SOURCE_CHARS,
  type RollbackWriteAnswer,
  type RollbackWriteChecks,
} from "@/lib/ai/features/rollback-write-view";
import {
  isSqlGenerateAnswer,
  isSqlGenerateChecks,
  MAX_REQUEST_CHARS,
  type SqlGenerateAnswer,
  type SqlGenerateChecks,
  type SqlTrial,
} from "@/lib/ai/features/sql-generate-view";
import {
  nextQuickVersion,
  QUICK_RUN_GROUP,
  quickGroupProblem,
  quickLevelLabel,
  quickRunSql,
  quickSqlProblem,
} from "@/lib/deploy/quick-run";

export type QuickRunConnection = {
  id: number | string;
  name: string;
  database_name: string;
  execute_role?: string | null;
};

/** Where a quick run went, so the page can refresh or show that group. */
export type QuickRunTarget = { connectionId: string; schema: string; group: string };

type Props = {
  open: boolean;
  onClose: () => void;
  connections: QuickRunConnection[];
  /** The page's own picks, used when the panel opens. */
  initialConnectionId: string;
  initialSchema: string;
  /** GitHub is not set up for this organization. */
  githubMissing: boolean;
  isAdmin: boolean;
  /** The role may run deploys (deploy:run). */
  mayDeploy: boolean;
  /** The role may save scripts to GitHub (scripts:create). */
  maySaveScripts: boolean;
  sessionLoading: boolean;
  settingsHref: string;
  historyHref: string;
  showToast: (msg: string, kind?: "ok" | "bad") => void;
  /** A real run committed: the page refreshes what it shows for this target. */
  onRan: (target: QuickRunTarget) => void;
  /** Open this group on the Deploy page (after asking an Admin). */
  onShowGroup: (target: QuickRunTarget) => void;
};

type VersionRead =
  | { status: "loading" }
  | { status: "ok"; applied: string | null; github: string[] }
  | { status: "error"; message: string };

type RunResult = { name: string; statements: number | null };

type Phase =
  | { kind: "idle" }
  | { kind: "dry-running" }
  | { kind: "dry-passed"; key: string; results: RunResult[] }
  | { kind: "dry-failed"; message: string; detail: string | null }
  | { kind: "running"; key: string }
  | { kind: "failed"; message: string; detail: string | null; unknown: boolean }
  | {
      kind: "done";
      version: string;
      floor: string | null;
      group: string;
      schema: string;
      connectionId: string;
      connectionName: string;
      withRollback: boolean;
      registry: RegistryNote;
    };

type AiRollback = { summary: string; cannot: string; checks: RollbackWriteChecks | null };
type AiScript = { answer: SqlGenerateAnswer; checks: SqlGenerateChecks | null };

const APPROVAL_TOAST = "Asked for approval. Once an Admin says yes, you can run it";

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function errorOf(data: Record<string, unknown> | null, fallback: string): string {
  const value = data?.error;
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/** The first error a failed apply's results carry, for the mono line. */
function resultError(data: Record<string, unknown> | null): string | null {
  const results = Array.isArray(data?.results) ? (data.results as Array<Record<string, unknown>>) : [];
  for (const result of results) {
    if (typeof result?.error === "string" && result.error.trim() !== "") return result.error;
  }
  return null;
}

function trialWords(trial: SqlTrial, what: "both" | "rollback"): { ok: boolean; text: string } {
  if (trial.status === "passed") {
    return {
      ok: true,
      text:
        what === "rollback" || trial.rollbackTried
          ? "Tried your SQL, then this rollback, on the schema. Both ran, then everything was rolled back."
          : "Tried on the schema. It ran, then everything was rolled back.",
    };
  }
  return { ok: false, text: `Not tried on the database. ${trial.reason}` };
}

export function QuickRun(props: Props) {
  const {
    open,
    onClose,
    connections,
    initialConnectionId,
    initialSchema,
    githubMissing,
    isAdmin,
    mayDeploy,
    maySaveScripts,
    sessionLoading,
    settingsHref,
    historyHref,
    showToast,
    onRan,
    onShowGroup,
  } = props;
  const ids = {
    conn: useId(),
    schema: useId(),
    sql: useId(),
    rollback: useId(),
    ask: useId(),
    group: useId(),
  };

  // ── Where it runs ──────────────────────────────────────────────────────
  const [connectionId, setConnectionId] = useState(initialConnectionId);
  const [schema, setSchema] = useState(initialSchema);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schemasError, setSchemasError] = useState<string | null>(null);
  const schemasFor = useRef("");

  // Each time the panel opens it starts on the page's own picks.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
       
      setConnectionId(initialConnectionId);
      setSchema(initialSchema);
    }
    wasOpen.current = open;
  }, [open, initialConnectionId, initialSchema]);

  useEffect(() => {
    if (!open || !connectionId) return;
    schemasFor.current = connectionId;
    let current = true;
     
    setSchemasError(null);
    void (async () => {
      try {
        const res = await apiFetch(`/api/scripts/schemas?connectionId=${encodeURIComponent(connectionId)}`);
        const data = await readJson(res);
        if (!current || schemasFor.current !== connectionId) return;
        const list = Array.isArray(data?.schemas) ? (data.schemas as unknown[]).filter((s): s is string => typeof s === "string") : null;
        if (!res.ok || !list) {
          setSchemas([]);
          setSchemasError(errorOf(data, "Could not load schemas from this connection."));
          return;
        }
        setSchemas(list);
        setSchema((picked) => (list.includes(picked) ? picked : list.length === 1 ? list[0] : list.includes("public") ? "public" : ""));
      } catch {
        if (current) setSchemasError("Network error loading schemas.");
      }
    })();
    return () => {
      current = false;
    };
  }, [open, connectionId]);

  const connection = connections.find((c) => String(c.id) === connectionId) ?? null;
  const executeRole = toExecuteRole(connection?.execute_role);
  const readOnly = executeRole === "none";
  const mayRun = canExecute({ isAdmin, mayDeploy }, executeRole);
  const mustAsk = !sessionLoading && !mayRun && !readOnly;

  // ── What runs ──────────────────────────────────────────────────────────
  const [tab, setTab] = useState<"write" | "describe">("write");
  const [sql, setSql] = useState("");
  const [saveRollback, setSaveRollback] = useState(true);
  const [rollback, setRollback] = useState("");
  const [aiRollback, setAiRollback] = useState<AiRollback | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  const [request, setRequest] = useState("");
  const [wantRollback, setWantRollback] = useState(true);
  const [scriptBusy, setScriptBusy] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [aiScript, setAiScript] = useState<AiScript | null>(null);
  const aiAbort = useRef<AbortController | null>(null);

  const ai = useAiAccess("sql-generate");
  const aiOff = ai.kind === "off";

  // ── Where it is saved ──────────────────────────────────────────────────
  const [group, setGroup] = useState(QUICK_RUN_GROUP);
  const [groupDraft, setGroupDraft] = useState<string | null>(null);
  const groupDraftProblem = groupDraft === null ? null : quickGroupProblem(groupDraft);

  const [versions, setVersions] = useState<VersionRead>({ status: "loading" });
  const [versionsKey, setVersionsKey] = useState(0);
  useEffect(() => {
    if (!open || !connectionId || !schema || !connection) return;
    let current = true;
     
    setVersions({ status: "loading" });
    void (async () => {
      const [applied, github] = await Promise.all([
        readAppliedVersion(Number(connectionId), schema, group),
        githubMissing
          ? Promise.resolve({ ok: true as const, versions: [] as string[] })
          : readFamilyVersions(connection.database_name, schema, group),
      ]);
      if (!current) return;
      if (!applied.ok) {
        setVersions({
          status: "error",
          message: `Could not read which version of ${group} this schema has run. The next version can't be picked until it can.`,
        });
        return;
      }
      if (!github.ok) {
        setVersions({ status: "error", message: github.error });
        return;
      }
      setVersions({ status: "ok", applied: applied.version, github: github.versions });
    })();
    return () => {
      current = false;
    };
    // The connection object changes identity on every page render; its id is the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connectionId, schema, group, githubMissing, versionsKey]);

  // ── The run ────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [asked, setAsked] = useState<QuickRunTarget | null>(null);

  const reading = useMemo(() => describeChangeType(sql), [sql]);
  const sqlProblem = sql.trim() === "" ? null : quickSqlProblem(sql, "SQL");
  const rollbackText = saveRollback ? rollback : "";
  const rollbackProblem = saveRollback && rollback.trim() !== "" ? quickSqlProblem(rollback, "rollback") : null;
  const pickedVersion =
    versions.status === "ok" && sql.trim() !== ""
      ? nextQuickVersion(sql, [versions.applied, ...versions.github])
      : null;
  const githubAhead =
    versions.status === "ok"
      ? versions.github.filter((v) => !versions.applied || compareVersions(v, versions.applied) > 0)
      : [];

  const ready =
    !!connection &&
    !!schema &&
    sql.trim() !== "" &&
    !sqlProblem &&
    !rollbackProblem &&
    groupDraft === null &&
    !!pickedVersion &&
    !rollbackBusy &&
    !scriptBusy;
  const runKey = pickedVersion
    ? JSON.stringify([connectionId, schema, group, pickedVersion.version, sql, rollbackText.trim()])
    : "";
  const dryPassedFor = phase.kind === "dry-passed" ? phase.key : null;
  const deployOpen = ready && dryPassedFor === runKey;
  const busy = phase.kind === "dry-running" || phase.kind === "running" || asking;

  // An edit after a dry run locks Deploy again; the result stays on screen
  // until then so the person can read it.
  const changedSinceDry = phase.kind === "dry-passed" && phase.key !== runKey;

  function resetRun() {
    if (phase.kind !== "idle") setPhase({ kind: "idle" });
    setAskError(null);
  }

  function scriptPayload() {
    const version = pickedVersion!;
    const down = rollbackText.trim();
    return {
      script_name: group,
      sql_content: quickRunSql(sql),
      version: version.version,
      title: group,
      change_type: version.level,
      ...(down ? { down_sql: down } : {}),
    };
  }

  async function run(dryRun: boolean) {
    if (!ready || busy || !connection) return;
    if (!dryRun && !deployOpen) return;
    const key = runKey;
    const version = pickedVersion!;
    setPhase(dryRun ? { kind: "dry-running" } : { kind: "running", key });
    let status: number | null = null;
    let data: Record<string, unknown> | null = null;
    try {
      const res = await apiFetch("/api/scripts/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(connectionId),
          schemaName: schema,
          dryRun,
          runId: newRunId(),
          scripts: [scriptPayload()],
        }),
      });
      status = res.status;
      data = await readJson(res);
    } catch {
      status = null;
    }

    const results = Array.isArray(data?.results) ? (data.results as Array<Record<string, unknown>>) : [];
    if (dryRun) {
      const passed =
        status !== null &&
        status < 300 &&
        data?.success === true &&
        results.length > 0 &&
        results.every((r) => r?.status === "rehearsed");
      if (passed) {
        setPhase({
          kind: "dry-passed",
          key,
          results: results.map((r) => ({
            name: typeof r.script_name === "string" ? r.script_name : group,
            statements: typeof r.statements === "number" ? r.statements : null,
          })),
        });
        return;
      }
      setPhase({
        kind: "dry-failed",
        message: status === null ? "Could not reach the server, so the dry run did not start." : errorOf(data, "The dry run stopped."),
        detail: resultError(data),
      });
      return;
    }

    const committed = status !== null && status < 300 && data?.success === true;
    if (committed) {
      setPhase({
        kind: "done",
        version: version.version,
        floor: version.floor,
        group,
        schema,
        connectionId,
        connectionName: connection.name,
        withRollback: rollbackText.trim() !== "",
        registry: describeRegistry(readArchivedVersions(data?.registry)),
      });
      showToast(`Deployed ${group} v${version.version} to ${schema}`);
      onRan({ connectionId, schema, group });
      return;
    }
    const failure = readApplyFailure(status, data);
    const unknown = failure === "unknown";
    setPhase({
      kind: "failed",
      unknown,
      message: unknown
        ? "We couldn't tell whether it ran. Open History and check this schema before you run it again."
        : failure === "refused"
          ? errorOf(data, "The run was refused. Nothing changed.")
          : `${errorOf(data, "The run stopped.")} Nothing changed.`,
      detail: resultError(data),
    });
    if (unknown) onRan({ connectionId, schema, group });
  }

  // ── AI: the rollback for the person's own SQL ──────────────────────────
  async function writeRollback() {
    if (aiOff || rollbackBusy || !connection || !schema) return;
    if (sql.trim() === "" || sqlProblem) return;
    if (sql.length > MAX_ROLLBACK_SOURCE_CHARS) {
      setRollbackError(`The AI writes rollbacks for SQL under ${MAX_ROLLBACK_SOURCE_CHARS.toLocaleString("en")} characters. Write this one by hand.`);
      return;
    }
    setRollbackBusy(true);
    setRollbackError(null);
    resetRun();
    try {
      const res = await apiFetch("/api/scripts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "rollback", connectionId: Number(connectionId), schemaName: schema, sql }),
      });
      const data = await readJson(res);
      if (!res.ok || !isRollbackWriteAnswer(data?.answer)) {
        setRollbackError(errorOf(data, "The AI could not write a rollback this time. Try again, or write it yourself."));
        return;
      }
      const answer: RollbackWriteAnswer = data.answer;
      setRollback(answer.rollbackSql);
      setSaveRollback(answer.rollbackSql.trim() !== "");
      setAiRollback({
        summary: answer.summary,
        cannot: answer.cannot,
        checks: isRollbackWriteChecks(data?.checks) ? data.checks : null,
      });
    } catch {
      setRollbackError("Network error asking the AI for a rollback.");
    } finally {
      setRollbackBusy(false);
    }
  }

  // ── AI: the whole script from plain words ──────────────────────────────
  async function writeScript() {
    if (aiOff || scriptBusy || !connection || !schema) return;
    const words = request.trim();
    if (!words) {
      setScriptError("Say what should change first.");
      return;
    }
    aiAbort.current?.abort();
    const controller = new AbortController();
    aiAbort.current = controller;
    setScriptBusy(true);
    setScriptError(null);
    setAiScript(null);
    resetRun();
    try {
      const res = await apiFetch("/api/scripts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: Number(connectionId), schemaName: schema, request: words }),
        signal: controller.signal,
      });
      const data = await readJson(res);
      if (controller.signal.aborted) return;
      if (!res.ok || !isSqlGenerateAnswer(data?.answer)) {
        setScriptError(errorOf(data, "The AI could not write this one. Try saying it another way, or write the SQL yourself."));
        return;
      }
      const answer: SqlGenerateAnswer = data.answer;
      if (answer.sql.trim() === "") {
        setScriptError(answer.cannot || "The AI could not write SQL for that. Try saying it another way.");
        return;
      }
      const checks = isSqlGenerateChecks(data?.checks) ? data.checks : null;
      setAiScript({ answer, checks });
      setSql(answer.sql);
      const down = wantRollback ? answer.rollbackSql : "";
      setRollback(down);
      setSaveRollback(down.trim() !== "");
      setAiRollback(null);
    } catch {
      if (!controller.signal.aborted) setScriptError("Network error asking the AI for SQL.");
    } finally {
      if (aiAbort.current === controller) {
        aiAbort.current = null;
        setScriptBusy(false);
      }
    }
  }

  useEffect(() => () => aiAbort.current?.abort(), []);

  // ── Ask an Admin ───────────────────────────────────────────────────────
  const askBlock: string | null = !mustAsk
    ? null
    : githubMissing
      ? "Asking an Admin needs GitHub, because the Admin's yes is for a saved version. Set up GitHub in Settings, or ask an Admin to run it for you."
      : !maySaveScripts
        ? "Your role can't save scripts, so it can't ask for this one either. Ask an Admin to run it for you."
        : githubAhead.length > 0
          ? `GitHub already has ${group} v${githubAhead[githubAhead.length - 1]}, which this schema hasn't run. Ask for that on Deploy first, or save this under another group.`
          : null;

  async function askAdmin() {
    if (!mustAsk || askBlock || !ready || asking || !connection) return;
    const payload = scriptPayload();
    const version = pickedVersion!;
    setAsking(true);
    setAskError(null);
    try {
      const push = await apiFetch("/api/github/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          database_name: connection.database_name,
          schema_name: schema,
          script_name: group,
          version: version.version,
          sql_content: payload.sql_content,
          change_level: version.level,
          ...(payload.down_sql ? { down_sql: payload.down_sql, attach_rollback: true } : {}),
        }),
      });
      const pushed = await readJson(push);
      if (!push.ok) {
        setAskError(errorOf(pushed, "Could not save it to GitHub, so no Admin was asked."));
        return;
      }
      const res = await apiFetch("/api/deploy/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "deploy",
          connectionId: Number(connectionId),
          schemaName: schema,
          scriptName: group,
          targetVersion: version.version,
          scripts: [
            {
              script_name: group,
              version: version.version,
              sql_content: payload.sql_content,
              change_type: version.level,
            },
          ],
        }),
      });
      const data = await readJson(res);
      if (!res.ok || !data?.approval) {
        setAskError(
          `Saved ${group} v${version.version} to GitHub, but the approval request failed: ${errorOf(data, "no reason given")}. Ask for it from Deploy on ${group}.`
        );
        setVersionsKey((k) => k + 1);
        return;
      }
      showToast(APPROVAL_TOAST);
      setAsked({ connectionId, schema, group });
      setVersionsKey((k) => k + 1);
    } catch {
      setAskError("Network error. Check Deploy on this group before you ask again.");
    } finally {
      setAsking(false);
    }
  }

  function runAnother() {
    setSql("");
    setRollback("");
    setAiRollback(null);
    setAiScript(null);
    setRequest("");
    setSaveRollback(true);
    setPhase({ kind: "idle" });
    setAsked(null);
    setAskError(null);
    setTab("write");
    setVersionsKey((k) => k + 1);
  }

  const connectionOptions = connections.map((c) => ({ value: String(c.id), label: c.name }));
  const schemaOptions = schemas.map((s) => ({ value: s, label: s }));
  const levelLabel = sql.trim() ? quickLevelLabel(reading.recorded) : null;
  const levelWhy = reading.grade.because;
  const savesAs = pickedVersion ? `${group} v${pickedVersion.version}` : null;

  // ── Footer ─────────────────────────────────────────────────────────────
  let footer: React.ReactNode;
  if (phase.kind === "done") {
    footer = (
      <div className="qr-foot__row">
        <button type="button" className="btn btn-primary qr-btn" onClick={runAnother}>
          Run another
        </button>
        <Link href={historyHref} className="btn btn-secondary qr-btn">
          See it in History
        </Link>
      </div>
    );
  } else if (readOnly) {
    footer = (
      <p className="qr-foot__hint">
        This connection is read-only, so nothing can run on it from Schema Studio. Pick another connection.
      </p>
    );
  } else if (mustAsk) {
    footer = asked ? (
      <div className="qr-foot__stack">
        <p className="qr-foot__hint">
          Asked. Once an Admin says yes, run {asked.group} from Deploy. You can follow it on the Approvals tab.
        </p>
        <button
          type="button"
          className="btn btn-primary qr-btn qr-btn--wide"
          onClick={() => {
            onShowGroup(asked);
            onClose();
          }}
        >
          Show it on Deploy
        </button>
      </div>
    ) : (
      <div className="qr-foot__stack">
        <strong className="qr-foot__title">An Admin runs this one</strong>
        <p className="qr-foot__hint">
          Your role can&apos;t run changes on this connection, not even a dry run. Save it and an Admin gets a
          request with this exact SQL.
        </p>
        {askBlock && <p className="qr-note qr-note--warn">{askBlock}</p>}
        {askError && <p className="qr-note qr-note--bad" role="alert">{askError}</p>}
        <button
          type="button"
          className="btn btn-primary qr-btn qr-btn--wide"
          disabled={!ready || !!askBlock || asking}
          onClick={askAdmin}
        >
          {asking ? <span className="spin" /> : null}
          Save to GitHub and ask an Admin
        </button>
        <span className="qr-foot__small">You can follow it on the Approvals tab.</span>
      </div>
    );
  } else {
    const hint =
      phase.kind === "dry-passed" && !changedSinceDry
        ? "Change the SQL and Deploy locks until the next dry run."
        : changedSinceDry
          ? "You changed it after the dry run. Dry run again to open Deploy."
          : "Dry run first. Deploy opens when it passes.";
    footer = (
      <div className="qr-foot__stack">
        <p className="qr-foot__hint">{hint}</p>
        <div className="qr-foot__row">
          <button
            type="button"
            className="btn btn-secondary qr-btn"
            disabled={!ready || busy || sessionLoading}
            onClick={() => run(true)}
          >
            {phase.kind === "dry-running" ? <span className="spin" /> : null}
            {phase.kind === "dry-passed" || phase.kind === "dry-failed" ? "Dry run again" : "Dry run"}
          </button>
          <button
            type="button"
            className="btn btn-primary qr-btn"
            disabled={!deployOpen || busy}
            onClick={() => run(false)}
          >
            {phase.kind === "running" ? <span className="spin" /> : null}
            Deploy
          </button>
        </div>
      </div>
    );
  }

  return (
    <Drawer open={open} onClose={onClose} bare label="Quick run" width={480}>
      <div className="qr">
        <header className="qr-head">
          <div className="qr-head__title">
            <span className="qr-bolt" aria-hidden="true">
              <BoltIcon />
            </span>
            <h2>Quick run</h2>
          </div>
          <button type="button" className="qr-close" aria-label="Close Quick run" onClick={onClose}>
            <XIcon size={20} />
          </button>
        </header>

        <div className="qr-body">
          {phase.kind === "done" ? (
            <DoneView
              phase={phase}
              githubMissing={githubMissing}
              onUndone={() => onRan({ connectionId: phase.connectionId, schema: phase.schema, group: phase.group })}
            />
          ) : (
            <>
              {/* Where it runs */}
              <div className="qr-where">
                <div className="qr-field">
                  <label className="qr-label" htmlFor={ids.conn}>
                    Connection
                  </label>
                  <Select
                    id={ids.conn}
                    variant="input"
                    value={connectionId}
                    options={connectionOptions}
                    placeholder="Pick a connection"
                    disabled={busy}
                    onChange={(value) => {
                      setConnectionId(value);
                      resetRun();
                      setAsked(null);
                    }}
                  />
                </div>
                <div className="qr-field">
                  <label className="qr-label" htmlFor={ids.schema}>
                    Schema
                  </label>
                  <Select
                    id={ids.schema}
                    variant="input"
                    value={schema}
                    options={schemaOptions}
                    placeholder={schemas.length ? "Pick a schema" : "Loading…"}
                    disabled={busy || schemas.length === 0}
                    onChange={(value) => {
                      setSchema(value);
                      resetRun();
                      setAsked(null);
                    }}
                  />
                </div>
              </div>
              {schemasError && <p className="qr-note qr-note--bad">{schemasError}</p>}

              {/* How it is written */}
              <div className="qr-tabs" role="tablist" aria-label="How to write the change">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "write"}
                  className="qr-tab"
                  onClick={() => setTab("write")}
                >
                  Write SQL
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "describe"}
                  aria-disabled={aiOff || undefined}
                  className="qr-tab"
                  onClick={() => !aiOff && setTab("describe")}
                >
                  <SparkIcon size={13} className="qr-spark" />
                  Describe it
                </button>
              </div>
              {aiOff && (
                <p className="qr-note">
                  AI writing is off for this organisation. Write the SQL and rollback yourself, or ask an Admin to
                  switch AI on in Settings.
                </p>
              )}

              {tab === "describe" && !aiOff ? (
                <div className="qr-card">
                  <label className="qr-label" htmlFor={ids.ask}>
                    Say what should change
                  </label>
                  <textarea
                    id={ids.ask}
                    className="qr-ask"
                    rows={3}
                    maxLength={MAX_REQUEST_CHARS}
                    value={request}
                    placeholder="Add a gift note to orders, up to 200 characters."
                    onChange={(e) => setRequest(e.target.value)}
                  />
                  <div className="qr-row">
                    <label className="qr-check">
                      <input type="checkbox" checked={wantRollback} onChange={(e) => setWantRollback(e.target.checked)} />
                      Write a rollback too
                    </label>
                    <button
                      type="button"
                      className="btn qr-btn qr-btn--ink"
                      disabled={scriptBusy || !schema || request.trim() === ""}
                      onClick={writeScript}
                    >
                      {scriptBusy ? <span className="spin" /> : null}
                      {scriptBusy ? "Writing…" : "Write the SQL"}
                    </button>
                  </div>
                  {scriptError && <p className="qr-note qr-note--bad" role="alert">{scriptError}</p>}
                  {aiScript && (
                    <AiScriptView
                      ai={aiScript}
                      sql={sql}
                      rollback={rollbackText}
                      onEdit={() => setTab("write")}
                      onAgain={writeScript}
                    />
                  )}
                </div>
              ) : (
                <>
                  <div className="qr-field">
                    <label className="qr-label" htmlFor={ids.sql}>
                      SQL to run
                    </label>
                    <textarea
                      id={ids.sql}
                      className="qr-code"
                      rows={6}
                      spellCheck={false}
                      value={sql}
                      placeholder="ALTER TABLE orders ADD COLUMN gift_note text;"
                      onChange={(e) => {
                        setSql(e.target.value);
                        setAiScript(null);
                      }}
                    />
                    {sqlProblem ? (
                      <p className="qr-note qr-note--bad">{sqlProblem}</p>
                    ) : levelLabel ? (
                      <div className="qr-level">
                        <span className={`qr-chip qr-chip--${reading.recorded}`}>{levelLabel}</span>
                        {levelWhy && <span className="qr-level__why">{levelWhy}</span>}
                      </div>
                    ) : null}
                    {reading.louderNote && <p className="qr-note qr-note--warn">{reading.louderNote}</p>}
                  </div>

                  {/* Rollback */}
                  <div className="qr-card">
                    <div className="qr-row">
                      <span className="qr-card__title">Rollback</span>
                      <label className="qr-check">
                        <input
                          type="checkbox"
                          checked={saveRollback}
                          onChange={(e) => setSaveRollback(e.target.checked)}
                        />
                        Save a rollback
                      </label>
                    </div>
                    {saveRollback ? (
                      <>
                        {aiRollback && (
                          <span className="qr-byai">
                            <SparkIcon size={12} /> Written by AI from your SQL
                          </span>
                        )}
                        <label className="sr-only" htmlFor={ids.rollback}>
                          Rollback SQL
                        </label>
                        <textarea
                          id={ids.rollback}
                          className="qr-code qr-code--soft"
                          rows={3}
                          spellCheck={false}
                          value={rollback}
                          placeholder="ALTER TABLE orders DROP COLUMN gift_note;"
                          onChange={(e) => setRollback(e.target.value)}
                        />
                        {rollbackProblem && <p className="qr-note qr-note--bad">{rollbackProblem}</p>}
                        {rollback.trim() === "" && !rollbackBusy && (
                          <p className="qr-note qr-note--warn">
                            <AlertTriangleIcon size={15} /> Without a rollback, this run can&apos;t be undone from Schema
                            Studio.
                          </p>
                        )}
                        {aiRollback && <AiRollbackNotes ai={aiRollback} />}
                        {rollbackError && <p className="qr-note qr-note--bad" role="alert">{rollbackError}</p>}
                        {!aiOff && (
                          <div className="qr-row qr-row--start">
                            <button
                              type="button"
                              className="btn qr-btn qr-btn--soft"
                              disabled={rollbackBusy || sql.trim() === "" || !!sqlProblem || !schema}
                              onClick={writeRollback}
                            >
                              {rollbackBusy ? <span className="spin" /> : <SparkIcon size={13} className="qr-spark" />}
                              {rollbackBusy ? "Writing…" : aiRollback ? "Write it again" : "Write the rollback with AI"}
                            </button>
                            {aiRollback && (
                              <button
                                type="button"
                                className="btn btn-ghost qr-btn"
                                onClick={() => {
                                  setRollback("");
                                  setAiRollback(null);
                                }}
                              >
                                Clear
                              </button>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="qr-note qr-note--warn">
                        <AlertTriangleIcon size={15} /> Without a rollback, this run can&apos;t be undone from Schema
                        Studio.
                      </p>
                    )}
                  </div>
                </>
              )}

              {/* Saves as */}
              <div className="qr-saves">
                {groupDraft !== null ? (
                  <div className="qr-field">
                    <label className="qr-label" htmlFor={ids.group}>
                      Script group
                    </label>
                    <div className="qr-row">
                      <input
                        id={ids.group}
                        className="qr-input"
                        value={groupDraft}
                        autoFocus
                        spellCheck={false}
                        onChange={(e) => setGroupDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !groupDraftProblem) {
                            setGroup(groupDraft.trim());
                            setGroupDraft(null);
                            resetRun();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary qr-btn"
                        disabled={!!groupDraftProblem}
                        onClick={() => {
                          setGroup(groupDraft.trim());
                          setGroupDraft(null);
                          resetRun();
                        }}
                      >
                        Done
                      </button>
                    </div>
                    {groupDraftProblem && <p className="qr-note qr-note--bad">{groupDraftProblem}</p>}
                  </div>
                ) : (
                  <>
                    <div className="qr-row">
                      <span>
                        <span className="qr-dim">Saves as</span>{" "}
                        <strong className="qr-mono">{savesAs ?? `${group}, next version`}</strong>
                        {savesAs && rollbackText.trim() !== "" ? ", with the rollback beside it." : null}
                      </span>
                      <button
                        type="button"
                        className="qr-link"
                        disabled={busy}
                        onClick={() => setGroupDraft(group)}
                      >
                        Change group
                      </button>
                    </div>
                    {versions.status === "loading" && connection && schema ? (
                      <p className="qr-small">Reading the versions this group already has…</p>
                    ) : versions.status === "error" ? (
                      <p className="qr-note qr-note--bad">{versions.message}</p>
                    ) : pickedVersion ? (
                      <p className="qr-small">
                        {pickedVersion.floor
                          ? `Next version after v${pickedVersion.floor}, picked from the change level.`
                          : "The first version of this group."}{" "}
                        {githubMissing
                          ? "When it runs, it goes in this schema's scripts table."
                          : "When it runs, it goes in this schema's scripts table and in GitHub."}
                      </p>
                    ) : null}
                    {versions.status === "ok" && githubAhead.length > 0 && !mustAsk && (
                      <p className="qr-note qr-note--warn">
                        GitHub has {group} v{githubAhead[githubAhead.length - 1]}, which this schema hasn&apos;t run.
                        This run saves above it, so Deploy won&apos;t offer that version here any more.
                      </p>
                    )}
                  </>
                )}
                {githubMissing && (
                  <div className="qr-note qr-note--warn qr-note--block">
                    <strong>Saves to the scripts table only</strong>
                    <span>
                      GitHub isn&apos;t set up for this organisation, so the run is kept in this schema&apos;s scripts
                      table and nowhere else.
                    </span>
                    <Link href={settingsHref} className="qr-link">
                      Set up GitHub in Settings
                    </Link>
                  </div>
                )}
              </div>

              {/* Result */}
              {phase.kind === "dry-passed" && (
                <DryPassed phase={phase} savesAs={savesAs} stale={changedSinceDry} githubMissing={githubMissing} />
              )}
              {(phase.kind === "dry-failed" || phase.kind === "failed") && (
                <div className="qr-result qr-result--bad" role="alert">
                  <span className="qr-result__mark qr-result__mark--bad">
                    <XIcon size={18} />
                  </span>
                  <div className="qr-result__body">
                    <strong>
                      {phase.kind === "dry-failed"
                        ? "Dry run stopped"
                        : phase.unknown
                          ? "Not sure it ran"
                          : "The run stopped"}
                    </strong>
                    <span>{phase.message}</span>
                    {phase.detail && phase.detail !== phase.message && <code className="qr-mono">{phase.detail}</code>}
                    {phase.kind === "dry-failed" && (
                      <span>Nothing changed. Fix the SQL and dry run again. Deploy stays locked until a dry run passes.</span>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <footer className="qr-foot">{footer}</footer>
      </div>
    </Drawer>
  );
}

function BoltIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </svg>
  );
}

/** The Quick run button for the Deploy page header. */
export function QuickRunButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="btn btn-primary qr-open"
      data-tour="deploy-quick-run"
      onClick={onClick}
      disabled={disabled}
    >
      <BoltIcon />
      Quick run
    </button>
  );
}

function AiRollbackNotes({ ai }: { ai: AiRollback }) {
  const trial = ai.checks ? trialWords(ai.checks.trial, "rollback") : null;
  return (
    <div className="qr-ai-notes">
      {ai.summary && <p className="qr-small">{ai.summary.replace(/`/g, "")}</p>}
      {ai.cannot && (
        <p className="qr-note qr-note--warn">
          <AlertTriangleIcon size={15} /> It can&apos;t put everything back: {ai.cannot}
        </p>
      )}
      {trial && (
        <p className={`qr-trial${trial.ok ? " qr-trial--ok" : ""}`}>
          {trial.ok ? <CheckIcon size={14} /> : <InfoIcon size={14} />}
          {trial.text}
        </p>
      )}
    </div>
  );
}

function AiScriptView({
  ai,
  sql,
  rollback,
  onEdit,
  onAgain,
}: {
  ai: AiScript;
  sql: string;
  rollback: string;
  onEdit: () => void;
  onAgain: () => void;
}) {
  const trial = ai.checks?.trial ?? null;
  const tried = trial?.status === "passed";
  return (
    <div className="qr-ai">
      <div className="qr-row">
        <span className="qr-card__title">The AI wrote this</span>
        {tried ? (
          <span className="qr-chip qr-chip--good">
            <CheckIcon size={13} /> Tried on the schema
          </span>
        ) : (
          <span className="qr-chip">Not tried</span>
        )}
      </div>
      {ai.answer.summary && <p className="qr-small">{ai.answer.summary.replace(/`/g, "")}</p>}
      <span className="qr-label">SQL to run</span>
      <pre className="qr-code qr-code--read">{sql}</pre>
      {rollback.trim() !== "" && (
        <>
          <span className="qr-label">Rollback</span>
          <pre className="qr-code qr-code--read qr-code--soft">{rollback}</pre>
        </>
      )}
      {ai.answer.assumptions.length > 0 && (
        <ul className="qr-assume">
          {ai.answer.assumptions.map((item) => (
            <li key={item}>{item.replace(/`/g, "")}</li>
          ))}
        </ul>
      )}
      <p className="qr-small">
        {tried
          ? trial.rollbackTried
            ? "Both ran inside a transaction that was rolled back, so nothing changed. Read it before you run it."
            : "It ran inside a transaction that was rolled back, so nothing changed. Read it before you run it."
          : trial
            ? `Not tried on the database. ${trial.status === "not-tried" ? trial.reason : ""} Read it before you run it.`
            : "Read it before you run it."}
      </p>
      <div className="qr-row qr-row--start">
        <button type="button" className="btn btn-secondary qr-btn" onClick={onEdit}>
          Edit it in Write SQL
        </button>
        <button type="button" className="btn btn-ghost qr-btn qr-btn--brand" onClick={onAgain}>
          Ask again
        </button>
      </div>
    </div>
  );
}

function DryPassed({
  phase,
  savesAs,
  stale,
  githubMissing,
}: {
  phase: Extract<Phase, { kind: "dry-passed" }>;
  savesAs: string | null;
  stale: boolean;
  githubMissing: boolean;
}) {
  const statements = phase.results.reduce((sum, r) => sum + (r.statements ?? 0), 0);
  return (
    <div className={`qr-result qr-result--good${stale ? " qr-result--stale" : ""}`} role="status">
      <span className="qr-result__mark qr-result__mark--good">
        <CheckIcon size={18} />
      </span>
      <div className="qr-result__body">
        <strong>Dry run passed</strong>
        <span>It ran, then everything was rolled back. Nothing changed.</span>
        {statements > 0 && (
          <span className="qr-small">
            {statements === 1 ? "1 statement ran" : `${statements} statements ran`}, plus the ledger row for{" "}
            {savesAs ?? "this version"}.
          </span>
        )}
        {!stale && savesAs && (
          <div className="qr-when">
            <strong>When you press Deploy</strong>
            <span>
              The same SQL runs for real in one transaction. Then {savesAs} and its rollback are saved to this
              schema&apos;s scripts table{githubMissing ? "" : " and to GitHub"}.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// The undo on the done screen: the saved rollback, through the same route as
// Deploy's own rollback (POST /api/scripts/revert), dry run first and then for
// real. That route reads the rollback from the scripts table and never calls
// GitHub, so a run saved only to the scripts table can be undone here too,
// even though Deploy's group picker (which lists GitHub's folders) can't show
// it.
type UndoState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "checked"; message: string }
  | { kind: "undoing" }
  | { kind: "undone"; message: string }
  | { kind: "failed"; message: string; detail: string | null; unknown: boolean };

function DoneView({
  phase,
  githubMissing,
  onUndone,
}: {
  phase: Extract<Phase, { kind: "done" }>;
  githubMissing: boolean;
  onUndone: () => void;
}) {
  const label = `${phase.group} v${phase.version}`;
  const [undo, setUndo] = useState<UndoState>({ kind: "idle" });
  const undone = undo.kind === "undone";
  const undoBusy = undo.kind === "checking" || undo.kind === "undoing";
  const onDeploy = !githubMissing && !phase.registry.problem;

  async function revert(dryRun: boolean) {
    if (undoBusy) return;
    setUndo(dryRun ? { kind: "checking" } : { kind: "undoing" });
    let status: number | null = null;
    let data: Record<string, unknown> | null = null;
    try {
      const res = await apiFetch("/api/scripts/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(phase.connectionId),
          schemaName: phase.schema,
          script_name: phase.group,
          versions: [phase.version],
          registryRollbacks: [],
          dryRun,
          runId: newRunId(),
        }),
      });
      status = res.status;
      data = await readJson(res);
    } catch {
      status = null;
    }
    const message = typeof data?.message === "string" ? data.message : "";
    if (status !== null && status < 300 && data?.success === true) {
      if (dryRun) {
        setUndo({ kind: "checked", message: message || "Dry run passed. Nothing changed." });
      } else {
        setUndo({ kind: "undone", message: message || `Rolled back ${label}.` });
        onUndone();
      }
      return;
    }
    const unknown = data?.outcomeUnknown === true;
    if (unknown) onUndone();
    setUndo({
      kind: "failed",
      unknown,
      message:
        status === null
          ? "Could not reach the server, so the rollback did not start. Nothing changed."
          : unknown
            ? "We couldn't tell whether the rollback ran. Open History and check this schema before you try again."
            : errorOf(data, dryRun ? "The rollback's dry run stopped. Nothing changed." : "The rollback stopped. Nothing changed."),
      detail: resultError(data),
    });
  }

  return (
    <div className="qr-done">
      <span className={`qr-done__mark${undone ? " qr-done__mark--undone" : ""}`} aria-hidden="true">
        {undone ? <UndoIcon /> : <CheckIcon size={26} />}
      </span>
      <h3>{undone ? `Rolled back on ${phase.schema}` : `Deployed to ${phase.schema}`}</h3>
      <p>
        {undone ? `${label} was undone on ${phase.connectionName}.` : `${label} ran on ${phase.connectionName} in one transaction.`}
      </p>
      {!undone && (
        <ul className="qr-done__list">
          <li>
            <CheckIcon size={16} />
            <div>
              <strong>Saved to the scripts table</strong>
              <span>
                A row in {phase.schema}.script_patch records v{phase.version}, its SQL
                {phase.withRollback ? " and its rollback" : ""}.
              </span>
            </div>
          </li>
          {!githubMissing && (
            <li className={phase.registry.problem ? "qr-done__warn" : undefined}>
              {phase.registry.problem ? <AlertTriangleIcon size={16} /> : <CheckIcon size={16} />}
              <div>
                <strong>{phase.registry.problem ? "Not saved to GitHub" : "Saved to GitHub"}</strong>
                {phase.registry.problem ? (
                  <span>{phase.registry.problem}</span>
                ) : (
                  <span className="qr-mono">
                    {phase.group}/v{phase.version}.sql
                    {phase.withRollback ? ` and v${phase.version}.down.sql` : ""}
                  </span>
                )}
              </div>
            </li>
          )}
        </ul>
      )}

      {!phase.withRollback ? (
        <p className="qr-small">There is no saved rollback, so this run can&apos;t be undone from Schema Studio.</p>
      ) : undone ? (
        <div className="qr-result qr-result--good qr-undo" role="status">
          <div className="qr-result__body">
            <strong>Rollback done</strong>
            <span>{undo.message}</span>
            <span>The scripts table no longer lists v{phase.version}, so it can run again later.</span>
          </div>
        </div>
      ) : (
        <div className="qr-card qr-undo">
          <span className="qr-card__title">Undo this run</span>
          <p className="qr-small">
            Runs the saved rollback in one transaction. Dry run it first, then roll back.
            {onDeploy
              ? ` Later on, Deploy can do the same: pick ${phase.group} and roll back to ${phase.floor ? `v${phase.floor}` : "before the first version"}.`
              : ""}
          </p>
          {undo.kind === "checked" && (
            <p className="qr-note qr-note--good" role="status">
              {undo.message}
            </p>
          )}
          {undo.kind === "failed" && (
            <div className="qr-note qr-note--bad" role="alert">
              <span>{undo.message}</span>
              {undo.detail && undo.detail !== undo.message && <code className="qr-mono">{undo.detail}</code>}
            </div>
          )}
          <div className="qr-row qr-row--start">
            {undo.kind === "checked" || undo.kind === "undoing" ? (
              <button type="button" className="btn btn-primary qr-btn" disabled={undoBusy} onClick={() => revert(false)}>
                {undo.kind === "undoing" ? <span className="spin" /> : null}
                Roll back now
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-secondary qr-btn"
                disabled={undoBusy || (undo.kind === "failed" && undo.unknown)}
                onClick={() => revert(true)}
              >
                {undo.kind === "checking" ? <span className="spin" /> : null}
                {undo.kind === "failed" ? "Dry run the rollback again" : "Dry run the rollback"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function UndoIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}
