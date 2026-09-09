"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Select } from "@/components/ui/Select";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, ConfirmDialog } from "@/components/ui";
import {
  VersionSyncIcon,
  ConnectionsIcon,
  AlertTriangleIcon,
  CheckIcon,
  RefreshIcon,
  InfoIcon,
} from "@/components/ui/icons";
import { EnvironmentPill } from "@/components/ui/EnvironmentPill";
import { diffLedgers, type LedgerEntry } from "@/lib/version-sync";
import {
  isProduction,
  louderEnvironment,
  toEnvironment,
  DEFAULT_ENVIRONMENT,
  type Environment,
} from "@/lib/environments";

// Version Sync (version replay). Pick a Source (ahead) and a Target (behind);
// we diff their applied-script ledgers and show the versions the Target is
// missing, each with its stored SQL (read-only — it's history). Applying the
// missing scripts to catch the Target up lands in P4; here the run controls are
// present but inert.

type Connection = {
  id: number;
  name: string;
  host: string;
  database_name: string;
  /** dev / staging / prod, or "unset" when nobody has labelled it. */
  environment: Environment;
};
type Phase = "idle" | "loading" | "error" | "ready";

/** A confirmed-but-not-yet-run replay: exactly what the dialog is promising. */
type PendingApply = {
  /** The versions that will be sent — the selection up to the first gap. */
  runnable: LedgerEntry[];
  /** The first version with no stored SQL, when the batch stops before one. */
  stoppedBefore: LedgerEntry | null;
  /** How many versions after that gap stay missing. */
  skipped: number;
};

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
};
const entryKey = (e: { scriptName: string; version: string }) => JSON.stringify([e.scriptName, e.version]);

/** Everything one side (Source or Target) needs: connection + schema + its ledger. */
function useLedgerSource() {
  const [connectionId, setConnectionId] = useState("");
  const [schema, setSchema] = useState("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [schemasError, setSchemasError] = useState("");
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  // The tracked schema's own environment label, if this pair is tracked. A
  // schema can be labelled louder than the connection it lives on (a prod
  // schema on a box called "shared"), so both halves are needed before this
  // side can be called production.
  const [schemaEnvironment, setSchemaEnvironment] = useState<Environment>(DEFAULT_ENVIRONMENT);

  useEffect(() => {
    setSchemas([]);
    if (!connectionId) return;
    let active = true;
    setSchemasLoading(true);
    setSchemasError("");
    (async () => {
      try {
        const res = await fetch(`/api/scripts/schemas?connectionId=${connectionId}`, { cache: "no-store" });
        const data = await res.json();
        if (!active) return;
        if (Array.isArray(data?.schemas)) setSchemas(data.schemas);
        else setSchemasError(data?.error ?? "Could not load schemas.");
      } catch {
        if (active) setSchemasError("Could not load schemas. Is the database reachable?");
      } finally {
        if (active) setSchemasLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [connectionId]);

  useEffect(() => {
    setSchemaEnvironment(DEFAULT_ENVIRONMENT);
    if (!connectionId || !schema) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/lineage/lookup?connectionId=${encodeURIComponent(connectionId)}&schemaName=${encodeURIComponent(schema)}`,
          { cache: "no-store" },
        );
        const data = res.ok ? ((await res.json()) as { environment?: string }) : null;
        if (active) setSchemaEnvironment(toEnvironment(data?.environment));
      } catch {
        // An unreachable lookup leaves the label unset, which reads as
        // "nothing here can warn you" rather than as "safe".
      }
    })();
    return () => {
      active = false;
    };
  }, [connectionId, schema]);

  useEffect(() => {
    setEntries(null);
    setError("");
    if (!connectionId || !schema) {
      setPhase("idle");
      return;
    }
    let active = true;
    setPhase("loading");
    (async () => {
      try {
        const res = await fetch(
          `/api/versionsync/ledger?connectionId=${encodeURIComponent(connectionId)}&schema=${encodeURIComponent(schema)}`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (!active) return;
        if (res.ok) {
          setEntries(Array.isArray(data.entries) ? data.entries : []);
          setPhase("ready");
        } else {
          setError(data?.error ?? "Could not read the ledger.");
          setPhase("error");
        }
      } catch {
        if (active) {
          setError("Could not reach the server. Try again.");
          setPhase("error");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [connectionId, schema, retry]);

  return {
    connectionId, setConnectionId, schema, setSchema,
    schemas, schemasLoading, schemasError, schemaEnvironment,
    entries, phase, error, retry: () => setRetry((n) => n + 1),
    // Optimistically mark a version as now-applied (after a successful replay),
    // so the diff/timeline update instantly without a re-fetch + loading flash.
    appendEntry: (e: LedgerEntry) => setEntries((prev) => (prev ? [...prev, e] : [e])),
  };
}

type Side = ReturnType<typeof useLedgerSource>;

/**
 * What environment one side is really pointing at.
 *
 * The connection carries a label for the whole database and the tracked schema
 * carries one of its own; we take the louder, exactly as Deploy does. Both
 * screens end up running the same SQL through the same route, so they must not
 * be able to disagree about whether that route is aimed at production.
 */
function sideEnvironment(side: Side, connections: Connection[]): Environment {
  const conn = connections.find((c) => String(c.id) === side.connectionId);
  return louderEnvironment(toEnvironment(conn?.environment), side.schemaEnvironment);
}

function changeTone(t: string): string {
  return t === "breaking" ? "pill-break" : t === "additive" ? "pill-sync" : "pill-pending";
}

export default function VersionSyncPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [connectionsFailed, setConnectionsFailed] = useState(false);

  const source = useLedgerSource();
  const target = useLedgerSource();

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/connections", { cache: "no-store" });
        // "No connections" is a different answer from "could not read them";
        // only the first one is fixed by visiting the Connections page.
        const data = res.ok ? await res.json() : null;
        if (!active) return;
        if (Array.isArray(data)) setConnections(data);
        else setConnectionsFailed(true);
      } catch {
        if (active) setConnectionsFailed(true);
      } finally {
        if (active) setConnectionsLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const diff = useMemo(() => {
    if (source.entries === null || target.entries === null) return null;
    return diffLedgers(source.entries, target.entries);
  }, [source.entries, target.entries]);

  // Only the Target is written to, so only the Target's label gates anything.
  // The Source still shows its own pill, because replaying prod history onto a
  // dev box is a very different act from the reverse and the pair is worth
  // reading at a glance.
  const sourceEnvironment = sideEnvironment(source, connections);
  const targetEnvironment = sideEnvironment(target, connections);
  const targetIsProduction = isProduction(targetEnvironment);

  const missingKeys = useMemo(
    () => new Set((diff?.missing ?? []).map(entryKey)),
    [diff],
  );
  // Multi-family? Then show the family on each timeline node.
  const multiFamily = useMemo(
    () => new Set((source.entries ?? []).map((e) => e.scriptName)).size > 1,
    [source.entries],
  );

  function swap() {
    const sc = source.connectionId, ss = source.schema;
    source.setConnectionId(target.connectionId);
    source.setSchema(target.schema);
    target.setConnectionId(sc);
    target.setSchema(ss);
  }

  // ── Apply (replay) ──────────────────────────────────────────────────────--
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState("");
  const [applyError, setApplyError] = useState("");
  const [applyDone, setApplyDone] = useState("");
  const [pendingApply, setPendingApply] = useState<PendingApply | null>(null);

  // The confirm dialog has to promise the number of scripts that will actually
  // run, so the batch is cut here rather than inside runEntries: a version with
  // no stored SQL stops the run before it, and the dialog used to count the
  // whole selection — including the versions the run could never reach.
  function requestApply(entries: LedgerEntry[]) {
    if (entries.length === 0) return;
    const firstGap = entries.findIndex((e) => !e.hasSql);
    const runnable = firstGap === -1 ? entries : entries.slice(0, firstGap);
    const gap = firstGap === -1 ? null : entries[firstGap];
    if (runnable.length === 0) {
      setApplyDone("");
      setApplyError(
        `${gap?.scriptName} v${gap?.version} has no stored script, so there is ` +
        `nothing that can be replayed.`
      );
      return;
    }
    setApplyError("");
    setApplyDone("");
    setPendingApply({
      runnable,
      stoppedBefore: gap,
      skipped: firstGap === -1 ? 0 : entries.length - firstGap - 1,
    });
  }

  /**
   * How a failed replay ended, which decides what the banner may claim.
   *
   * "refused" is the run ending before any script SQL was sent — an
   * unapproved production target, a missing acknowledgement, a target that
   * could not be connected to, a schema that does not exist. Saying "the
   * transaction rolled back" there describes a transaction that never existed
   * and hides the actual problem, which is usually one the reader can fix.
   * "unknown" is the commit that did not report back, or a reply this page
   * could not read at all; neither of those saw how the run ended, so neither
   * may say nothing was applied.
   */
  type ApplyFailure = "refused" | "rolled-back" | "unknown";

  async function applyBatch(
    entries: LedgerEntry[],
    acknowledgeProduction: boolean,
  ): Promise<{ ok: true } | { ok: false; error: string; failure: ApplyFailure }> {
    try {
      const res = await fetch("/api/scripts/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(target.connectionId),
          schemaName: target.schema,
          acknowledgeProduction,
          scripts: entries.map((e) => ({
            script_name: e.scriptName,
            version: e.version,
            sql_content: e.sqlContent ?? "",
            // Carried across so the replayed version is revertable on the
            // Target too, not just on the Source it came from.
            down_sql: e.downSql ?? undefined,
            change_type: e.changeType,
            source_ref: `version-sync: replayed from ${source.schema}`,
          })),
        }),
      });
      // Read the body as text first: a proxy error or a Next.js error page is
      // HTML, and letting res.json() throw here would report "could not reach
      // the server" about a request that reached it.
      const raw = await res.text();
      let data: {
        success?: boolean;
        error?: string;
        outcomeUnknown?: boolean;
        results?: unknown;
      } | null = null;
      try {
        data = JSON.parse(raw) as {
          success?: boolean;
          error?: string;
          outcomeUnknown?: boolean;
          results?: unknown;
        };
      } catch {
        data = null;
      }
      // `success` as well as the status: the route answers 200 only on success
      // today, but a caller that reads just the status would silently treat a
      // future soft-failure shape as applied.
      if (!res.ok || !data?.success) {
        // 4xx here is always the route declining before it opened a
        // transaction — the request was wrong or unapproved. A body this page
        // could not parse is a proxy or framework error page, which says
        // nothing about what the database did.
        //
        // The status alone cannot separate the 5xx cases: the apply route
        // answers 503 both for a target it could not connect to (nothing ran)
        // and for a lock timeout inside the transaction (rolled back). It only
        // puts a per-script `results` array in a failure body once it has a
        // queue to report on, so a 5xx without one never got as far as running
        // the scripts.
        const reachedTheRun = res.status >= 500 && Array.isArray(data?.results);
        const failure: ApplyFailure = data?.outcomeUnknown
          ? "unknown"
          : data === null
            ? "unknown"
            : reachedTheRun
              ? "rolled-back"
              : "refused";
        return {
          ok: false,
          error: data?.error ?? `the apply API answered ${res.status}.`,
          failure,
        };
      }
      return { ok: true };
    } catch {
      return {
        ok: false,
        error: "Could not reach the server.",
        failure: "unknown",
      };
    }
  }

  // Replay entries onto the Target in ONE request, which the apply route runs in
  // ONE transaction. All of them or none: a replay that failed halfway used to
  // leave the earlier versions applied and the Target stranded mid-chain, which
  // is the exact state Version Sync exists to get a schema out of.
  //
  // An entry with no stored script cannot be replayed at all, so the run stops
  // BEFORE it: everything up to that point is sent as one atomic batch and the
  // gap is reported. Sending the whole list and letting the server discover the
  // hole would just fail the run. requestApply does that cut, so the confirm
  // dialog and this run agree on how many scripts are involved.
  async function runEntries(pending: PendingApply, acknowledgeProduction: boolean) {
    // A disabled confirm button is a hint; this is the rule. If the Target is
    // production and nobody ticked the box, nothing runs.
    if (targetIsProduction && !acknowledgeProduction) return;

    // Already cut to the runnable versions by requestApply, so what runs here
    // is exactly what the dialog counted.
    const batch = pending.runnable;
    const gap = pending.stoppedBefore;

    setApplying(true);
    setApplyError("");
    setApplyDone("");

    setProgress(
      batch.length === 1
        ? `Applying ${batch[0].scriptName} v${batch[0].version}…`
        : `Applying ${batch.length} versions in one transaction…`
    );

    const result = await applyBatch(batch, acknowledgeProduction);
    setProgress("");
    setApplying(false);

    if (!result.ok) {
      setApplyError(
        `Replay failed: ${result.error} ` +
        (result.failure === "refused"
          ? "Nothing ran — the replay stopped before any SQL was sent."
          : result.failure === "unknown"
            ? `Whether it was applied is not known: nothing here saw how the run ` +
              `ended. Read the ledger on ${target.schema} before trying again.`
            : "Nothing was applied — the transaction rolled back.")
      );
      return;
    }

    const appliedAt = new Date().toISOString();
    for (const e of batch) target.appendEntry({ ...e, appliedAt });
    setApplyDone(
      `Applied ${batch.length} script${batch.length === 1 ? "" : "s"} to ${target.schema}.` +
      (gap
        ? ` Stopped before ${gap.scriptName} v${gap.version}, which has no stored script.`
        : "")
    );
  }

  // Clear any apply feedback when the Source/Target selection changes, so a
  // stale "Applied N scripts" / error banner never lingers over a new pair.
  useEffect(() => {
    setApplyDone("");
    setApplyError("");
    setProgress("");
  }, [source.connectionId, source.schema, target.connectionId, target.schema]);

  const noConnections = connectionsLoaded && connections.length === 0;
  const bothPicked = !!(source.connectionId && source.schema && target.connectionId && target.schema);
  const sameTarget =
    bothPicked && source.connectionId === target.connectionId && source.schema === target.schema;
  const anyError = source.phase === "error" || target.phase === "error";
  const bothReady = source.phase === "ready" && target.phase === "ready";

  return (
    <div className="px-4 sm:px-8 py-6 sm:py-8 max-w-[1080px]">
      <div className="mb-5">
        <div className="section-title mb-2">Version Sync</div>
        <h1 className="text-[28px] font-semibold tracking-[-0.018em]">Catch a schema up by version.</h1>
        <p className="text-[13.5px] mt-1.5 max-w-[68ch]" style={{ color: "var(--text-2)" }}>
          Replay the actual scripts already applied to an ahead schema onto a behind one, version by
          version — preserving the lineage (unlike a structural compare, which jumps straight to the
          end state). A replay writes to the target&apos;s ledger only, never to the GitHub
          registry. Pick a <b>Source</b> (ahead) and a <b>Target</b>{" "}
          (behind) to see what&apos;s missing.
        </p>
      </div>

      {noConnections ? (
        connectionsFailed ? (
          <EmptyState
            tone="break"
            icon={<VersionSyncIcon size={22} />}
            title="Could not load your connections"
            description="The saved connections could not be read just now. Reload the page to try again."
          />
        ) : (
          <EmptyState
            icon={<VersionSyncIcon size={22} />}
            title="Add a connection first"
            description="Version Sync reads two saved PostgreSQL connections' applied-script ledgers."
            actions={
              <Link href="/connections" className="btn btn-primary btn-sm">
                <ConnectionsIcon size={14} /> Go to Connections
              </Link>
            }
          />
        )
      ) : (
        <>
          {/* ── Source → Target pickers ──────────────────────────────────── */}
          <div className="card p-5">
            <div className="vsync-pickers">
              <SidePicker
                side={source}
                label="Source"
                sub="ahead"
                connections={connections}
                loaded={connectionsLoaded}
                environment={sourceEnvironment}
              />
              <button
                type="button"
                className="vsync-swap btn btn-ghost btn-sm"
                title="Swap Source and Target"
                aria-label="Swap source and target"
                onClick={swap}
              >
                <VersionSyncIcon size={16} />
              </button>
              <SidePicker
                side={target}
                label="Target"
                sub="catch up"
                connections={connections}
                loaded={connectionsLoaded}
                environment={targetEnvironment}
              />
            </div>
          </div>

          {/* ── Result ───────────────────────────────────────────────────── */}
          <div className="mt-5">
            {!bothPicked ? (
              <div className="card p-0 overflow-hidden">
                <div style={{ height: 260 }}>
                  <EmptyState
                    icon={<VersionSyncIcon size={22} />}
                    title="Pick a Source and a Target"
                    description="Choose both schemas above and we'll show the versions the Target is missing."
                  />
                </div>
              </div>
            ) : anyError ? (
              <div className="banner">
                <AlertTriangleIcon size={16} className="ico" />
                <div className="body">
                  <div className="title">Couldn&apos;t read a ledger</div>
                  <div className="help mt-0.5">
                    {source.phase === "error" ? `Source: ${source.error}` : `Target: ${target.error}`}
                  </div>
                  <button
                    className="btn btn-secondary btn-sm mt-2"
                    onClick={() => (source.phase === "error" ? source.retry() : target.retry())}
                  >
                    <RefreshIcon size={13} /> Try again
                  </button>
                </div>
              </div>
            ) : !bothReady ? (
              <div className="card p-5 space-y-3">
                <Skeleton width="40%" height={16} />
                <Skeleton width="100%" height={44} radius={10} />
                <Skeleton width="70%" height={14} />
                <p className="help" style={{ color: "var(--text-3)" }}>Reading both ledgers…</p>
              </div>
            ) : diff ? (
              <>
                {sameTarget && (
                  <div className="banner mb-5">
                    <InfoIcon size={16} className="ico" />
                    <div className="body">
                      <div className="title">Source and Target are the same schema</div>
                      <div className="help mt-0.5">
                        Pick two different schemas to sync — there&apos;s nothing to replay between a schema and itself.
                      </div>
                    </div>
                  </div>
                )}
                <Result
                  diff={diff}
                  source={source}
                  missingKeys={missingKeys}
                  multiFamily={multiFamily}
                  apply={{
                    applying,
                    progress,
                    error: applyError,
                    done: applyDone,
                    onRun: requestApply,
                    targetIsProduction,
                  }}
                />
              </>
            ) : null}
          </div>
        </>
      )}

      <ConfirmDialog
        open={pendingApply !== null}
        onClose={() => setPendingApply(null)}
        onConfirm={(acknowledged) => {
          const pending = pendingApply;
          setPendingApply(null);
          if (pending) void runEntries(pending, acknowledged);
        }}
        destructive
        confirmLabel={
          pendingApply && pendingApply.runnable.length > 1
            ? `Apply ${pendingApply.runnable.length}${targetIsProduction ? " to production" : ""}`
            : targetIsProduction
              ? "Apply to production"
              : "Apply"
        }
        title={
          pendingApply && pendingApply.runnable.length === 1
            ? `Apply ${pendingApply.runnable[0].scriptName} v${pendingApply.runnable[0].version}?`
            : `Apply ${pendingApply?.runnable.length ?? 0} scripts to the Target?`
        }
        acknowledge={
          targetIsProduction
            ? `I understand, and I mean to replay ${pendingApply?.runnable.length ?? 0} script${
                (pendingApply?.runnable.length ?? 0) === 1 ? "" : "s"
              } against production.`
            : undefined
        }
        description={
          <>
            This runs on <b className="mono">{target.schema}</b> ({connections.find((c) => String(c.id) === target.connectionId)?.database_name}) —
            a live database — and is recorded in that schema&apos;s own applied-script ledger. It
            does not add anything to the GitHub registry, so these versions will show on Deploy as
            applied with no registry file behind them.
            {pendingApply?.stoppedBefore && (
              <span className="block mt-2">
                This stops before{" "}
                <b className="mono">
                  {pendingApply.stoppedBefore.scriptName} v{pendingApply.stoppedBefore.version}
                </b>{" "}
                — that version has no stored script
                {pendingApply.skipped > 0
                  ? `, so the ${pendingApply.skipped} version${
                      pendingApply.skipped === 1 ? "" : "s"
                    } after it cannot be replayed either.`
                  : ", so it stays missing."}
              </span>
            )}
            {targetIsProduction && (
              <span className="block mt-2" style={{ color: "var(--break)" }}>
                The Target is labelled production. A replay that goes wrong here is not
                something a rollback brings back — a rollback restores structure, not rows.
              </span>
            )}
            {targetIsProduction && (
              <span className="block mt-2" style={{ color: "var(--break)" }}>
                Ticking this box is not enough on its own. A production run also needs
                an approval from someone else, granted for these exact scripts — the
                same hand cannot both tick and press. Request it on the Deploy screen
                with this connection and schema selected; without one the replay is
                refused and nothing runs.
              </span>
            )}
            {diff && diff.diverged.length > 0 && (
              <span className="block mt-2" style={{ color: "var(--drift)" }}>
                The schemas have diverged, so a replayed script may conflict with the Target&apos;s own changes.
              </span>
            )}
          </>
        }
      />
    </div>
  );
}

// ── One side's picker (connection + schema) ──────────────────────────────────
function SidePicker({
  side, label, sub, connections, loaded, environment,
}: {
  side: Side; label: string; sub: string; connections: Connection[]; loaded: boolean;
  environment: Environment;
}) {
  return (
    <div className="vsync-side">
      <div className="vsync-side__head">
        <h2 className="section-title">{label}</h2>
        <span className="vsync-side__sub">{sub}</span>
        {side.connectionId && <EnvironmentPill environment={environment} className="ml-auto" />}
      </div>
      <div className="space-y-2 mt-2">
        {!loaded ? (
          <>
            <Skeleton width="100%" height={36} radius={8} />
            <Skeleton width="100%" height={36} radius={8} />
          </>
        ) : (
          <>
            <Select
              variant="input"
              ariaLabel={`${label} connection`}
              value={side.connectionId}
              placeholder="Select a connection…"
              options={connections.map((c) => ({ value: String(c.id), label: `${c.name} — ${c.host}/${c.database_name}` }))}
              onChange={(v) => { side.setConnectionId(v); side.setSchema(""); }}
            />
            <Select
              variant="input"
              mono
              ariaLabel={`${label} schema`}
              value={side.schema}
              disabled={side.schemasLoading || !side.connectionId}
              placeholder={
                !side.connectionId ? "Pick a connection first" : side.schemasLoading ? "Loading schemas…" : "Select a schema…"
              }
              options={side.schemas.map((s) => ({ value: s, label: s }))}
              onChange={(v) => side.setSchema(v)}
            />
            {side.schemasError && <p className="help" style={{ color: "var(--break)" }}>{side.schemasError}</p>}
            {side.connectionId && environment === "unset" && (
              <p className="help">
                Unlabelled — label it on Connections so this page can warn you.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

type ApplyCtl = {
  applying: boolean;
  progress: string;
  error: string;
  done: string;
  onRun: (entries: LedgerEntry[]) => void;
  /** Draw the run buttons red when the Target is live, same as Deploy does. */
  targetIsProduction: boolean;
};

// ── The diff result: status, timeline, missing list ──────────────────────────
function Result({
  diff, source, missingKeys, multiFamily, apply,
}: {
  diff: ReturnType<typeof diffLedgers>;
  source: Side;
  missingKeys: Set<string>;
  multiFamily: boolean;
  apply: ApplyCtl;
}) {
  const sourceEntries = source.entries ?? [];
  const sourceEmpty = sourceEntries.length === 0;
  // "Caught up" = the Target has every Source version (missing is empty). Any
  // divergence (Target-only versions) is a separate concern, shown in its own
  // banner — it must NOT flip this to the "N behind" branch (which would then
  // render a nonsensical "0 versions behind").
  const inSync = diff.upToDate;

  return (
    <div className="space-y-5">
      {/* Apply feedback */}
      {apply.progress && (
        <div className="banner">
          <RefreshIcon size={16} className="ico spin-icon" />
          <div className="body"><div className="title">{apply.progress}</div></div>
        </div>
      )}
      {apply.error && (
        <div className="banner">
          <AlertTriangleIcon size={16} className="ico" />
          <div className="body"><div className="title">{apply.error}</div></div>
        </div>
      )}
      {apply.done && (
        <div
          className="banner"
          style={{ background: "var(--sync-soft)", borderColor: "color-mix(in oklab, var(--sync) 30%, transparent)" }}
        >
          <CheckIcon size={16} className="ico" />
          <div className="body"><div className="title" style={{ color: "var(--sync)" }}>{apply.done}</div></div>
        </div>
      )}

      {/* Status banner */}
      {sourceEmpty ? (
        <div className="banner">
          <InfoIcon size={16} className="ico" />
          <div className="body">
            <div className="title">The Source has no applied scripts</div>
            <div className="help mt-0.5">
              Its ledger is empty — there&apos;s nothing to replay. Pick a Source that has migrations applied.
            </div>
          </div>
        </div>
      ) : inSync ? (
        <div
          className="banner"
          style={{ background: "var(--sync-soft)", borderColor: "color-mix(in oklab, var(--sync) 30%, transparent)" }}
        >
          <CheckIcon size={16} className="ico" />
          <div className="body">
            <div className="title" style={{ color: "var(--sync)" }}>
              {diff.diverged.length > 0 ? "Caught up on the Source." : "You’re up to date."}
            </div>
            <div className="help mt-0.5">
              The Target has every version the Source has
              {diff.diverged.length > 0 ? " (plus some of its own — see below)." : "."}
            </div>
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="pill pill-pending">
              {diff.missing.length} {diff.missing.length === 1 ? "version" : "versions"} behind
            </span>
            {diff.missingWithoutSql > 0 && (
              <span className="pill pill-drift" title="Applied before SQL was stored — can't be replayed">
                {diff.missingWithoutSql} without stored SQL
              </span>
            )}
          </div>
          {/* The pill's title attribute is the only place this used to be
              explained, and a span cannot be focused to read it — so the
              consequence (the run stops early) is on screen instead. */}
          {diff.missingWithoutSql > 0 && (
            <p className="help mt-2">
              {diff.missingWithoutSql} of these were applied before this tool stored SQL, so they
              cannot be replayed. A run stops at the first one — the versions after it stay missing.
            </p>
          )}
        </div>
      )}

      {/* Divergence warning */}
      {diff.diverged.length > 0 && (
        <div
          className="banner"
          style={{ background: "color-mix(in oklab, var(--drift) 8%, var(--surface))", borderColor: "color-mix(in oklab, var(--drift) 35%, var(--border))" }}
        >
          <AlertTriangleIcon size={16} className="ico" style={{ color: "var(--drift)" }} />
          <div className="body">
            <div className="title">These schemas have diverged.</div>
            <div className="help mt-0.5">
              The Target has {diff.diverged.length}{" "}
              {diff.diverged.length === 1 ? "version" : "versions"}{" "}
              the Source doesn&apos;t — they&apos;re on different branches.
              Review before syncing; nothing is merged automatically.
            </div>
            {/* "Review before syncing" needs something to review — a bare
                pill per version showed the name and nothing else, so the
                stored script is one click away here. */}
            {diff.diverged.map((e) => (
              <details key={entryKey(e)} className="mt-1">
                <summary className="help">
                  {e.scriptName} v{e.version} — {e.changeType}
                </summary>
                <pre className="vsync-sql mono mt-2">
                  {e.sqlContent ?? "No stored script for this version."}
                </pre>
              </details>
            ))}
          </div>
        </div>
      )}

      {/* Timeline */}
      {!sourceEmpty && (
        <div>
          <h2 className="section-title mb-2">Source timeline</h2>
          <div className="vsync-rail">
            {sourceEntries.map((e) => {
              const missing = missingKeys.has(entryKey(e));
              return (
                <div key={entryKey(e)} className={`vsync-node${missing ? " is-missing" : " is-applied"}`}>
                  <span className="vsync-node__dot" />
                  <span className="vsync-node__ver mono">v{e.version}</span>
                  {multiFamily && <span className="vsync-node__fam mono">{e.scriptName}</span>}
                  <span className="vsync-node__state">{missing ? "missing" : "on target"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Missing list */}
      {diff.missing.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <h2 className="section-title">To apply ({diff.missing.length})</h2>
            <div className="flex items-center gap-2">
              {/* Not "Bump by 1" — the Script Editor's version bump means
                  changing a version number, and this runs one script. */}
              <button
                className="btn btn-secondary btn-sm"
                disabled={apply.applying || !diff.missing[0]?.hasSql}
                onClick={() => apply.onRun([diff.missing[0]])}
              >
                Run next only
              </button>
              <button
                className={`btn btn-sm ${apply.targetIsProduction ? "btn-destructive" : "btn-primary"}`}
                disabled={apply.applying || diff.missing.length === 0}
                onClick={() => apply.onRun(diff.missing)}
              >
                {apply.applying ? <RefreshIcon size={13} className="spin-icon" /> : null}
                Run all{apply.targetIsProduction ? " on production" : ""}
              </button>
            </div>
          </div>
          <p className="help mb-3" style={{ color: "var(--text-3)" }}>
            The exact scripts already applied to the Source. Running them onto the Target catches it up —
            in order, and all of them in one transaction, so a replay that fails part way leaves the
            Target where it started rather than stranded mid-chain. Run next only applies the first
            missing version; Run all sends the rest as one transaction.
          </p>

          <div className="space-y-3">
            {diff.missing.map((e) => (
              <div key={entryKey(e)} className="card p-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`pill ${changeTone(e.changeType)}`}>{e.changeType}</span>
                    <span className="mono text-[14px] font-semibold">v{e.version}</span>
                    <span className="text-[12px]" style={{ color: "var(--text-3)" }}>
                      {e.scriptName} · applied to Source {fmtDate(e.appliedAt)}
                    </span>
                  </div>
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={apply.applying || !e.hasSql}
                    title={e.hasSql ? "Apply this version to the Target" : "No stored script to replay"}
                    onClick={() => apply.onRun([e])}
                  >
                    Run
                  </button>
                </div>
                {e.hasSql ? (
                  <pre className="vsync-sql mono mt-3">{e.sqlContent}</pre>
                ) : (
                  <div className="vsync-nosql mt-3">
                    <InfoIcon size={14} />
                    No stored script — this version was applied before SQL was tracked, so it can&apos;t be replayed.
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
