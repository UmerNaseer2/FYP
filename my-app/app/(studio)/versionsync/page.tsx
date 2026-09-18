"use client";

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { Select } from "@/components/ui/Select";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal, Skeleton } from "@/components/ui";
import {
  VersionSyncIcon,
  ConnectionsIcon,
  AlertTriangleIcon,
  CheckIcon,
  RefreshIcon,
  InfoIcon,
} from "@/components/ui/icons";
import { EnvironmentPill } from "@/components/ui/EnvironmentPill";
import { ProductionGate, RiskGate } from "@/components/studio/RiskGate";
import { ApprovalPanel, sha256Hex, type ApprovalRow } from "@/components/studio/ApprovalPanel";
import { VersionTimeline } from "@/components/studio/VersionTimeline";
import { ChangeLevelPill } from "@/components/studio/ChangeLevelPill";
import { useUser } from "@/hooks/useUser";
import {
  cutForwardOnly,
  diffLedgers,
  entryKey,
  headsByFamily,
  readReplayAnswer,
  type LedgerEntry,
  type ReplayAnswer,
  type ReplayOutcome,
} from "@/lib/version-sync";
import { describeRegistry, type RegistryNote } from "@/lib/registry-report";
import {
  displayVersion,
  ledgerTimelineEntries,
  mergeTimelines,
  outdatedSideOfEntries,
  versionTitle,
} from "@/lib/version-timeline";
import { analyseRunRisk, readScriptLevel, scriptLabel } from "@/lib/deploy-risk";
import { changeLevelWord, normalizeChangeLevel } from "@/lib/change-level";
import { ROW_DESTROYING_NOT_BREAKING } from "@/lib/sql-guard";
import { fingerprintBody } from "@/lib/approval-fingerprint";
import { countOf } from "@/lib/plural";
import { utcStamp } from "@/lib/format-date";
import {
  isProduction,
  louderEnvironment,
  toEnvironment,
  DEFAULT_ENVIRONMENT,
  type Environment,
} from "@/lib/environments";

// Version Sync (version replay). Pick a Source (ahead) and a Target (behind).
// The page compares their applied-script ledgers (lib/version-sync) and shows:
//   - the versions the Target is missing and can still take, each with the SQL
//     the Source's ledger stored for it (read-only: it is history);
//   - the versions the Target lacks but is already past ("Cannot be replayed
//     forward"): a replay only moves forward, so none of those can run;
//   - the versions only the Target has (the schemas have diverged);
//   - both ledgers side by side, as a Source vs Target timeline.
// Each row's Run button and Run all open the replay check (ReplayDialog, at the
// bottom of this file): what the run risks, a dry run, the Target's last drift
// check, and a production approval where one is needed. Confirming it sends the
// versions to /api/scripts/apply as ONE request, which runs them in ONE
// transaction. Every run stops before the first version the route would refuse
// — one with no stored SQL, or one that does not move its script group forward
// — so the screen never offers a run the server is certain to turn down.

type Connection = {
  id: number;
  name: string;
  host: string;
  database_name: string;
  /** dev / staging / prod, or "unset" when nobody has labelled it. */
  environment: Environment;
};
type Phase = "idle" | "loading" | "error" | "ready";

// The UTC stamp every screen prints (utcStamp). A ledger value that isn't a
// timestamp is shown as it is rather than hidden.
const fmtDate = (iso: string) => utcStamp(iso) || iso;

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

/** How far a replay of some versions, in order, gets before the apply route would refuse one. */
type Reach = {
  /** The leading versions that can run. */
  runnable: LedgerEntry[];
  /** The first version the route would refuse, or null when every one can run. */
  stoppedBefore: LedgerEntry | null;
  reason: "no-sql" | "out-of-order" | null;
  /** For "out-of-order": the version it would have had to be above. */
  blockedBy: string | null;
};

/**
 * Cut a replay before the first version the apply route would refuse.
 *
 * Two things stop a run, and the route refuses the WHOLE run for either one:
 *   - "no-sql": the Source applied the version before this tool stored the SQL
 *     it ran, so there is nothing to send (the route refuses blank SQL);
 *   - "out-of-order": the version does not move its script group forward
 *     (cutForwardOnly in lib/version-sync, which follows the route's rule).
 * Whichever comes first in the list is the one the run stops before.
 */
function reachOf(entries: LedgerEntry[], targetEntries: LedgerEntry[]): Reach {
  const cut = cutForwardOnly(entries, targetEntries);
  const gap = cut.runnable.findIndex((e) => !e.hasSql);
  if (gap === -1) return cut;
  return {
    runnable: cut.runnable.slice(0, gap),
    stoppedBefore: cut.runnable[gap],
    reason: "no-sql",
    blockedBy: null,
  };
}

/** Why a run stops before `reach.stoppedBefore`, as one sentence ("" when it does not stop). */
function stopSentence(reach: Reach): string {
  const stop = reach.stoppedBefore;
  if (!stop) return "";
  const label = scriptLabel(stop.scriptName, stop.version);
  if (reach.reason === "no-sql") {
    return `${label} was applied to the Source before this tool stored the SQL it ran, so there is nothing to replay for it.`;
  }
  // For a missing version blockedBy is always a version earlier in the same
  // list (the list only holds versions above the Target's head), which is why
  // this can say the Source applied it first.
  const before = scriptLabel(stop.scriptName, reach.blockedBy ?? "");
  return (
    `The Source applied ${label} after ${before}, and ${label} is not above it, ` +
    `so the server would refuse it: a replay only moves forward.`
  );
}

/** The four ticks the apply route checks, sent with a dry run as well as a real one. */
type ReplayFlags = {
  acknowledgeProduction: boolean;
  acknowledgeBreaking: boolean;
  acknowledgeDataLoss: boolean;
  acknowledgeDrift: boolean;
};

/**
 * Send versions to the apply route as ONE run, which it applies in ONE
 * transaction: every version in it applies, or none does.
 *
 * The answer is read by readReplayAnswer (lib/version-sync), which reads a
 * failure with readApplyFailure (lib/apply-failure), the same reading Deploy
 * uses:
 *   refused      a 4xx other than 422: the route turned the run away and none
 *                of its versions were applied;
 *   not-started  a 5xx the route marks nothingRan: it stopped before its
 *                first write, so nothing ran;
 *   rolled-back  the run reached its transaction and did not commit;
 *   unknown      nothing here saw how it ended.
 * A `results` list in the answer says nothing about which: the route's ledger
 * refusals (409) list the run's scripts too, and reading "has results" as
 * "rolled back" used to turn those refusals into "Replay failed".
 */
async function sendReplay({
  connectionId,
  schemaName,
  sourceSchema,
  entries,
  dryRun,
  flags,
}: {
  connectionId: string;
  schemaName: string;
  sourceSchema: string;
  entries: LedgerEntry[];
  dryRun: boolean;
  flags: ReplayFlags;
}): Promise<ReplayOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/scripts/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionId: Number(connectionId),
        schemaName,
        dryRun,
        ...flags,
        scripts: entries.map((e) => ({
          script_name: e.scriptName,
          version: e.version,
          sql_content: e.sqlContent ?? "",
          // Carried across so the replayed version is revertable on the
          // Target too, not just on the Source it came from.
          down_sql: e.downSql ?? undefined,
          change_type: e.changeType,
          // The Source's own words for the version. Without them the apply
          // route titles the Target's row with the bare version number.
          title: e.title ?? undefined,
          description: e.description ?? undefined,
          source_ref: `version-sync: replayed from ${sourceSchema}`,
        })),
      }),
    });
  } catch {
    return readReplayAnswer(null, null);
  }

  // Read the body as text first: a proxy error or a Next.js error page is
  // HTML, and letting res.json() throw would report "could not reach the
  // server" about a request that reached it.
  let data: ReplayAnswer | null = null;
  try {
    const parsed: unknown = JSON.parse(await res.text());
    data = parsed !== null && typeof parsed === "object" ? (parsed as ReplayAnswer) : null;
  } catch {
    data = null;
  }
  return readReplayAnswer(res.status, data);
}

/** What a failed replay's banner says. Every one offers to read the Target's ledger again. */
type ApplyError = {
  title: string;
  detail: string;
};

/** Ledger entries as the risk checks read them: the same fields the apply route is sent. */
function riskScriptsOf(entries: ReadonlyArray<LedgerEntry>) {
  return entries.map((e) => ({
    scriptName: e.scriptName,
    version: e.version,
    sqlContent: e.sqlContent ?? "",
    changeType: e.changeType,
  }));
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

  // How far a run down the missing list can get before the apply route would
  // refuse a version (reachOf). Run buttons are offered only on rows it reaches.
  const reach = useMemo(() => {
    if (diff === null || target.entries === null) return null;
    return reachOf(diff.missing, target.entries);
  }, [diff, target.entries]);

  // Only the Target is written to, so only the Target's label gates anything.
  // The Source still shows its own pill, because replaying prod history onto a
  // dev box is a very different act from the reverse and the pair is worth
  // reading at a glance.
  const sourceEnvironment = sideEnvironment(source, connections);
  const targetEnvironment = sideEnvironment(target, connections);
  const targetIsProduction = isProduction(targetEnvironment);
  const targetDatabase =
    connections.find((c) => String(c.id) === target.connectionId)?.database_name ?? "";

  // More than one script group? Then a version is named with its group.
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

  // ── Replay ────────────────────────────────────────────────────────────────
  // The versions the replay check is open for (null = closed).
  const [pendingRun, setPendingRun] = useState<LedgerEntry[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState("");
  const [applyError, setApplyError] = useState<ApplyError | null>(null);
  const [applyDone, setApplyDone] = useState("");
  // What the apply route recorded in GitHub for the last replay (spec 07 —
  // automatically push approved scripts). Null when there is nothing to say:
  // GitHub not configured, or the Target's registry already had the file.
  const [registryNote, setRegistryNote] = useState<RegistryNote | null>(null);

  // Open the replay check for these versions. The buttons only offer runs that
  // reach their last version, so this refusal only shows if the ledgers moved
  // under the list; it is here so a run the route would refuse is never sent.
  function requestApply(entries: LedgerEntry[]) {
    if (entries.length === 0 || target.entries === null) return;
    const check = reachOf(entries, target.entries);
    if (check.stoppedBefore) {
      setApplyDone("");
      setRegistryNote(null);
      setApplyError({ title: "Replay did not start — nothing ran", detail: stopSentence(check) });
      return;
    }
    setApplyError(null);
    setApplyDone("");
    setRegistryNote(null);
    setPendingRun(entries);
  }

  // Replay the versions onto the Target in ONE request, which the apply route
  // runs in ONE transaction. All of them or none: a replay that failed halfway
  // used to leave the earlier versions applied and the Target stranded
  // mid-chain, which is the exact state Version Sync exists to get a schema
  // out of. `flags` are the ticks given in the replay check.
  async function runEntries(entries: LedgerEntry[], flags: ReplayFlags) {
    setApplying(true);
    setApplyError(null);
    setApplyDone("");
    setRegistryNote(null);
    setProgress(
      entries.length === 1
        ? `Replaying ${scriptLabel(entries[0].scriptName, entries[0].version)} onto ${target.schema}…`
        : `Replaying ${entries.length} versions onto ${target.schema} in one transaction…`,
    );

    const result = await sendReplay({
      connectionId: target.connectionId,
      schemaName: target.schema,
      sourceSchema: source.schema,
      entries,
      dryRun: false,
      flags,
    });
    setProgress("");
    setApplying(false);

    if (!result.ok) {
      if (result.failure === "refused") {
        // "None of its versions", not "nothing ran": the route's last
        // forward-only check runs under its locks, after a real run has
        // committed the enum values it adds, and answers 409 too. Its error
        // names the enum values that stay.
        setApplyError({ title: "Replay refused — none of its versions were applied", detail: result.error });
      } else if (result.failure === "not-started") {
        // A 5xx the route marks nothingRan: it stopped before its first write.
        setApplyError({ title: "Replay did not start — nothing ran", detail: result.error });
      } else if (result.failure === "rolled-back") {
        // The one part of a run that can outlive its rollback.
        const enumNote =
          analyseRunRisk(riskScriptsOf(entries)).enumAdditions.length > 0
            ? " Any enum value the run added before its transaction opened stays: PostgreSQL has no statement that removes one."
            : "";
        setApplyError({
          title: "Replay failed — none of its versions were applied",
          detail: result.error + enumNote,
        });
      } else {
        setApplyError({
          title: "Replay result not known",
          detail:
            `${result.error} Nothing here saw how the run ended. ` +
            `Read the Target's ledger again before you run anything else.`,
        });
      }
      return;
    }

    // Mark the versions applied here, as the route recorded them (trimmed
    // version, graded change type), so the list and timeline update without a
    // re-read and a loading flash.
    const appliedAt = new Date().toISOString();
    for (const e of entries) {
      target.appendEntry({
        ...e,
        version: e.version.trim(),
        changeType: readScriptLevel({ sqlContent: e.sqlContent ?? "", changeType: e.changeType }).stored,
        appliedAt,
      });
    }
    setApplyDone(`Replayed ${countOf(entries.length, "version")} onto ${target.schema}.`);
    // A replayed version's SQL came from the Source's ledger, so the Target's
    // registry folder had no file for it until the apply route wrote one. This
    // is the case spec 07's automatic push exists for, so say plainly what
    // reached GitHub — and what did not.
    const note = describeRegistry(result.registry);
    setRegistryNote(note.saved || note.problem ? note : null);
  }

  // Clear any apply feedback when the Source/Target selection changes, so a
  // stale "Replayed N versions" / error banner never lingers over a new pair.
  useEffect(() => {
    setApplyDone("");
    setRegistryNote(null);
    setApplyError(null);
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
          Replay the exact scripts an ahead schema already ran onto a behind one, in the order it
          ran them — keeping the version history (a structural compare jumps straight to the end
          state instead). A replay records each version in the Target&apos;s own ledger, never in
          the GitHub registry. Pick a <b>Source</b> (ahead) and a <b>Target</b>{" "}
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
          {/* Locked while a replay runs: the run's banner and the ledgers it
              updates belong to the pair it was started on. */}
          <div className="card p-5">
            <div className="vsync-pickers">
              <SidePicker
                side={source}
                label="Source"
                sub="ahead"
                connections={connections}
                loaded={connectionsLoaded}
                environment={sourceEnvironment}
                locked={applying}
              />
              <button
                type="button"
                className="vsync-swap btn btn-ghost btn-sm"
                title="Swap Source and Target"
                aria-label="Swap source and target"
                disabled={applying}
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
                locked={applying}
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
            ) : diff && reach ? (
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
                  target={target}
                  reach={reach}
                  multiFamily={multiFamily}
                  apply={{
                    applying,
                    progress,
                    error: applyError,
                    done: applyDone,
                    registry: registryNote,
                    onRun: requestApply,
                    onReread: () => {
                      setApplyError(null);
                      target.retry();
                    },
                    targetIsProduction,
                  }}
                />
              </>
            ) : null}
          </div>
        </>
      )}

      <ReplayDialog
        entries={pendingRun}
        onClose={() => setPendingRun(null)}
        onReplay={(flags) => {
          const run = pendingRun;
          setPendingRun(null);
          if (run) void runEntries(run, flags);
        }}
        connectionId={target.connectionId}
        schema={target.schema}
        databaseName={targetDatabase}
        sourceSchema={source.schema}
        pageEnvironment={targetEnvironment}
        diverged={diff?.diverged.length ?? 0}
      />
    </div>
  );
}

// ── One side's picker (connection + schema) ──────────────────────────────────
function SidePicker({
  side, label, sub, connections, loaded, environment, locked,
}: {
  side: Side; label: string; sub: string; connections: Connection[]; loaded: boolean;
  environment: Environment;
  /** True while a replay runs: the pair cannot change under it. */
  locked: boolean;
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
              disabled={locked}
              placeholder="Select a connection…"
              options={connections.map((c) => ({ value: String(c.id), label: `${c.name} — ${c.host}/${c.database_name}` }))}
              onChange={(v) => { side.setConnectionId(v); side.setSchema(""); }}
            />
            <Select
              variant="input"
              mono
              ariaLabel={`${label} schema`}
              value={side.schema}
              disabled={locked || side.schemasLoading || !side.connectionId}
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
  error: ApplyError | null;
  done: string;
  /** What the run added to the GitHub registry, and what it could not. */
  registry: RegistryNote | null;
  /** Open the replay check for these versions. */
  onRun: (entries: LedgerEntry[]) => void;
  /** Read the Target's ledger again, after any failed run: the list may be out of date. */
  onReread: () => void;
  /** Draw Run all red when the Target is live, same as Deploy does. */
  targetIsProduction: boolean;
};

const SYNC_BANNER = {
  background: "var(--sync-soft)",
  borderColor: "color-mix(in oklab, var(--sync) 30%, transparent)",
};
const DRIFT_BANNER = {
  background: "color-mix(in oklab, var(--drift) 8%, var(--surface))",
  borderColor: "color-mix(in oklab, var(--drift) 35%, var(--border))",
};

// ── The diff result: status, missing list, what cannot run, timeline ────────
function Result({
  diff, source, target, reach, multiFamily, apply,
}: {
  diff: ReturnType<typeof diffLedgers>;
  source: Side;
  target: Side;
  reach: Reach;
  multiFamily: boolean;
  apply: ApplyCtl;
}) {
  const sourceEntries = useMemo(() => source.entries ?? [], [source.entries]);
  const targetEntries = useMemo(() => target.entries ?? [], [target.entries]);
  const sourceEmpty = sourceEntries.length === 0;
  // "Up to date" = nothing is left to replay forward (missing is empty). Any
  // divergence (Target-only versions) is a separate concern, shown in its own
  // banner — it must NOT flip this to the "N behind" branch.
  const inSync = diff.upToDate;

  const missing = diff.missing;
  const total = missing.length;
  // The run buttons: rows 0..reachable-1 can run; the row at `reachable` (if
  // any) is where every run stops, and the rows after it wait behind it.
  const reachable = reach.runnable.length;
  const stop = reach.stoppedBefore;
  const stopLabel = stop ? scriptLabel(stop.scriptName, stop.version) : "";
  const waiting = stop ? total - reachable - 1 : 0;
  // Run all only when it runs the whole list and is not the same as Run.
  const showRunAll = reachable === total && total > 1;
  // A version named alone ("v1.2.0") is enough with one script group.
  const runLabel = (e: LedgerEntry) =>
    multiFamily ? scriptLabel(e.scriptName, e.version) : displayVersion(e.version, true);

  const targetHeads = useMemo(() => headsByFamily(targetEntries), [targetEntries]);
  const belowCount = diff.belowTarget.length;

  // The timeline reads the same ledgers the list does, matched by the same key.
  const sourceTimeline = useMemo(() => ledgerTimelineEntries(sourceEntries), [sourceEntries]);
  const targetTimeline = useMemo(() => ledgerTimelineEntries(targetEntries), [targetEntries]);
  const timelineRows = useMemo(
    () => mergeTimelines(sourceTimeline, targetTimeline),
    [sourceTimeline, targetTimeline],
  );
  const outdatedSide = useMemo(
    () => outdatedSideOfEntries(sourceTimeline, targetTimeline),
    [sourceTimeline, targetTimeline],
  );
  const pairKey = JSON.stringify([source.connectionId, source.schema, target.connectionId, target.schema]);

  const upToDateHelp =
    (belowCount === 1
      ? "1 version the Source has is not on the Target, but the Target is already at or past it in that script, so a replay cannot run it — see Cannot be replayed forward below."
      : belowCount > 1
        ? `${belowCount} versions the Source has are not on the Target, but the Target is already at or past them in their scripts, so a replay cannot run them — see Cannot be replayed forward below.`
        : "The Target has every version the Source has.") +
    (diff.diverged.length > 0
      ? ` It also has ${countOf(diff.diverged.length, "version")} the Source does not — see below.`
      : "");

  const listHelp =
    "These are the exact scripts the Source ran, in the order it ran them. A replay runs them " +
    "onto the Target in that order, as one transaction: every version in it applies, or none does." +
    (reachable === 0
      ? ""
      : reachable === 1
        ? " The Run button replays the first version. It opens a check of what will run, " +
          "and nothing runs until you confirm it there."
        : " Each Run button replays the versions from the top of the list down to its own row" +
          (showRunAll ? ", and Run all replays the whole list" : "") +
          ". Each opens a check of what will run, and nothing runs until you confirm it there.");

  // What to do about the version every run stops before.
  const stopFix =
    reach.reason === "no-sql"
      ? (reachable > 0
          ? `Replay ${reachable === 1 ? "the version" : "the versions"} before it first; then, if`
          : "If") +
        ` the GitHub registry still has ${stopLabel}, deploy it to the Target from the Deploy screen, and this list moves past it.`
      : reach.reason === "out-of-order" && stop
        ? `Replay ${reachable === 1 ? "the version" : "the versions"} listed before it first: once ` +
          `${scriptLabel(stop.scriptName, reach.blockedBy ?? "")} is on the Target, ${stopLabel} moves to ` +
          `Cannot be replayed forward` +
          (waiting > 0 ? ", and the list carries on with the versions after it." : ".")
        : "";

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
          <div className="body">
            <div className="title">{apply.error.title}</div>
            <div className="help mt-0.5">{apply.error.detail}</div>
            {/* On every failure, not only an unknown one: a refusal can mean
                the Target moved under this list (another deploy or a
                rollback), and a list read before that offers runs that no
                longer fit. */}
            <button className="btn btn-secondary btn-sm mt-2" onClick={apply.onReread}>
              <RefreshIcon size={13} />{" "}
              Read the Target&apos;s ledger again
            </button>
          </div>
        </div>
      )}
      {apply.done && (
        <div className="banner" style={SYNC_BANNER}>
          <CheckIcon size={16} className="ico" />
          <div className="body">
            <div className="title" style={{ color: "var(--sync)" }}>{apply.done}</div>
            {/* Inside the success banner, not beside it: the registry write is
                part of what this replay did, and a banner of its own would read
                as a second, separate thing having happened. */}
            {apply.registry?.saved && <div>{apply.registry.saved}</div>}
          </div>
        </div>
      )}
      {/* The other half, and amber rather than green: the replay succeeded, so
          this is not a failure — but the Target now holds a version GitHub does
          not list, which is the drift this feature exists to stop and is worth
          acting on. */}
      {apply.registry?.problem && (
        <div className="warn-inline">
          <AlertTriangleIcon size={16} className="ico" />
          <div className="body">
            <div className="title">Applied, but not recorded in GitHub</div>
            <div>{apply.registry.problem}</div>
          </div>
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
        <div className="banner" style={SYNC_BANNER}>
          <CheckIcon size={16} className="ico" />
          <div className="body">
            <div className="title" style={{ color: "var(--sync)" }}>You’re up-to-date!</div>
            <div className="help mt-0.5">{upToDateHelp}</div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="pill pill-pending">{countOf(total, "version")} behind</span>
          {diff.missingWithoutSql > 0 && (
            <span className="pill pill-drift" title="Applied before SQL was stored — can't be replayed">
              {diff.missingWithoutSql} without stored SQL
            </span>
          )}
        </div>
      )}

      {/* Missing list */}
      {total > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <h2 className="section-title">Missing on the Target ({total})</h2>
            {showRunAll && (
              <button
                className={`btn btn-sm ${apply.targetIsProduction ? "btn-destructive" : "btn-primary"}`}
                disabled={apply.applying}
                title="Replay every version in this list, in one transaction"
                onClick={() => apply.onRun(missing)}
              >
                {apply.applying ? <RefreshIcon size={13} className="spin-icon" /> : null}
                Run all ({total})…
              </button>
            )}
          </div>
          <p className="help mb-3" style={{ color: "var(--text-3)" }}>{listHelp}</p>

          {stop && (
            <div className="warn-inline mb-3">
              <span className="ico"><AlertTriangleIcon size={14} /></span>
              <span>
                <b>A run stops before {stopLabel}.</b>{" "}
                {stopSentence(reach)}
                {waiting > 0 ? ` The ${countOf(waiting, "version")} after it wait behind it.` : ""}{" "}
                {stopFix}
              </span>
            </div>
          )}

          <div className="space-y-3">
            {missing.map((e, i) => {
              // The Source's own title for this version, or null when it
              // would only repeat the version number or the script group.
              const title = versionTitle(e.title, e.version, e.scriptName);
              return (
                <div key={entryKey(e)} className="card p-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <ChangeLevelPill level={normalizeChangeLevel(e.changeType)} />
                      <span className="mono text-[14px] font-semibold">{displayVersion(e.version, true)}</span>
                      {title !== null && <span className="text-[13px] font-medium">{title}</span>}
                      <span className="text-[12px]" style={{ color: "var(--text-3)" }}>
                        {e.scriptName} · applied to Source {fmtDate(e.appliedAt)}
                      </span>
                    </div>
                    {i < reachable ? (
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={apply.applying}
                        title={
                          i === 0
                            ? `Replay ${runLabel(e)} onto the Target`
                            : `Replay the first ${i + 1} versions in this list, ${runLabel(missing[0])} ` +
                              `through ${runLabel(e)}, onto the Target in one transaction`
                        }
                        onClick={() => apply.onRun(missing.slice(0, i + 1))}
                      >
                        {/* Named the way Deploy names its Run buttons: the one
                            version, or the first and last with how many. */}
                        {i === 0
                          ? `Run ${runLabel(e)}…`
                          : `Run ${runLabel(missing[0])} → ${runLabel(e)} (${i + 1})…`}
                      </button>
                    ) : i === reachable ? (
                      <span className="vsync-stopnote">Runs stop before this version</span>
                    ) : (
                      <span className="vsync-stopnote">Can&apos;t be reached yet: runs stop before {stopLabel}</span>
                    )}
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
              );
            })}
          </div>
        </div>
      )}

      {/* Versions the Target lacks but is already past */}
      {belowCount > 0 && (
        <div className="banner" style={DRIFT_BANNER}>
          <AlertTriangleIcon size={16} className="ico" style={{ color: "var(--drift)" }} />
          <div className="body">
            <div className="title">Cannot be replayed forward ({belowCount})</div>
            <div className="help mt-0.5">
              The Target already runs a version of each of these scripts that is at or above the one
              listed, and a replay only moves forward, so the server refuses them. To bring one
              of these changes over, write it as a new version in the Script Editor and deploy it.
            </div>
            {diff.belowTarget.map((e) => (
              <details key={entryKey(e)} className="mt-1">
                <summary className="help">
                  {scriptLabel(e.scriptName, e.version)} — {changeLevelWord(e.changeType)} · the Target runs{" "}
                  {scriptLabel(e.scriptName, targetHeads.get(e.scriptName) ?? "")}
                </summary>
                <pre className="vsync-sql mono mt-2">
                  {e.sqlContent ?? "No stored script for this version."}
                </pre>
              </details>
            ))}
          </div>
        </div>
      )}

      {/* Divergence warning */}
      {diff.diverged.length > 0 && (
        <div className="banner" style={DRIFT_BANNER}>
          <AlertTriangleIcon size={16} className="ico" style={{ color: "var(--drift)" }} />
          <div className="body">
            <div className="title">These schemas have diverged.</div>
            <div className="help mt-0.5">
              The Target has {countOf(diff.diverged.length, "version")}{" "}
              the Source doesn&apos;t — they&apos;re on different branches.
              Review before syncing; nothing is merged automatically.
            </div>
            {/* "Review before syncing" needs something to review, so the
                stored script is one click away here. */}
            {diff.diverged.map((e) => (
              <details key={entryKey(e)} className="mt-1">
                <summary className="help">
                  {scriptLabel(e.scriptName, e.version)} — {changeLevelWord(e.changeType)}
                </summary>
                <pre className="vsync-sql mono mt-2">
                  {e.sqlContent ?? "No stored script for this version."}
                </pre>
              </details>
            ))}
          </div>
        </div>
      )}

      {/* Both ledgers, side by side. Keyed on the pair: the table keeps which
          rows are open, and that belongs to one pair. */}
      {(sourceEntries.length > 0 || targetEntries.length > 0) && (
        <div>
          <h2 className="section-title mb-2">Source vs Target</h2>
          <VersionTimeline
            key={pairKey}
            leftLabel="Source"
            rightLabel="Target"
            rows={timelineRows}
            outdatedSide={outdatedSide}
            showHeadVersions
          />
        </div>
      )}
    </div>
  );
}

// ── The replay check ─────────────────────────────────────────────────────────

/** What the Target's tracking record says, as far as a replay cares. */
type TrackingRecord =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; environment: Environment; drift: "in_sync" | "drifted" | "unreachable" | null };

type ReplayDialogProps = {
  /** The versions to replay, in order; null while the dialog is closed. */
  entries: LedgerEntry[] | null;
  onClose: () => void;
  /** Confirmed: run it, sending these ticks. */
  onReplay: (flags: ReplayFlags) => void;
  connectionId: string;
  schema: string;
  databaseName: string;
  sourceSchema: string;
  /** The Target's environment as the page reads it (connection and schema labels). */
  pageEnvironment: Environment;
  /** How many versions only the Target has. */
  diverged: number;
};

/**
 * The check a replay goes through before anything runs: what it holds and
 * risks, a dry run, and the ticks and approval the apply route will ask for.
 *
 * The body is its own component, mounted each time the dialog opens, so no
 * tick, dry-run result or approval note carries over from one run to the next.
 */
function ReplayDialog(props: ReplayDialogProps) {
  const titleId = useId();
  const { entries, onClose } = props;
  return (
    <Modal open={entries !== null} onClose={onClose} width={640} labelledBy={titleId}>
      {entries !== null && entries.length > 0 && (
        <ReplayBody {...props} entries={entries} titleId={titleId} />
      )}
    </Modal>
  );
}

function ReplayBody({
  entries,
  titleId,
  onClose,
  onReplay,
  connectionId,
  schema,
  databaseName,
  sourceSchema,
  pageEnvironment,
  diverged,
}: Omit<ReplayDialogProps, "entries"> & { entries: LedgerEntry[]; titleId: string }) {
  const { user, isAdmin, bypass } = useUser();
  const count = entries.length;
  const first = entries[0];
  const last = entries[count - 1];
  // The script groups this run replays. A run across groups goes through no
  // one version (app_core can reach 3.1.0 while reports reaches 1.0.0), so the
  // approval panel names a target version only when there is a single group.
  const families = [...new Set(entries.map((e) => e.scriptName.trim()))];
  const runName = count === 1 ?scriptLabel(first.scriptName, first.version) : countOf(count, "version");

  // ── The Target's tracking record ──────────────────────────────────────────
  // The apply route reads two things from it before it runs anything: whether
  // the schema is labelled production, and what its last drift check found.
  // This reads the same record, so the ticks below are the ticks it asks for.
  const [record, setRecord] = useState<TrackingRecord>({ state: "loading" });
  const [recordTry, setRecordTry] = useState(0);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/lineage/lookup?connectionId=${encodeURIComponent(connectionId)}&schemaName=${encodeURIComponent(schema)}`,
          { cache: "no-store" },
        );
        const data = (await res.json()) as {
          tracked?: boolean;
          environment?: string;
          driftStatus?: string | null;
          error?: string;
        };
        if (!active) return;
        if (!res.ok) {
          setRecord({ state: "error", message: data.error ?? `The tracking lookup answered ${res.status}.` });
          return;
        }
        // An untracked schema has no label of its own and no drift check.
        const tracked = data.tracked === true;
        const drift =
          tracked &&
          (data.driftStatus === "in_sync" || data.driftStatus === "drifted" || data.driftStatus === "unreachable")
            ? data.driftStatus
            : null;
        setRecord({ state: "ready", environment: toEnvironment(tracked ? data.environment : undefined), drift });
      } catch {
        if (active) setRecord({ state: "error", message: "Could not reach the server, or could not read its reply." });
      }
    })();
    return () => {
      active = false;
    };
  }, [connectionId, schema, recordTry]);

  const ready = record.state === "ready";
  // The louder of the page's reading and the record's, as the route does.
  const environment =
    record.state === "ready" ? louderEnvironment(pageEnvironment, record.environment) : pageEnvironment;
  const production = isProduction(environment);
  const drift = record.state === "ready" && (record.drift === "drifted" || record.drift === "unreachable");

  // ── What the run risks (the same reading the route makes) ─────────────────
  const risk = useMemo(() => analyseRunRisk(riskScriptsOf(entries)), [entries]);
  const breakingCount = risk.breaking.length;
  const louderCount = risk.breaking.filter((b) => b.louderNote !== null).length;
  const dataLossCount = risk.dataLoss.length;
  const dataLossKinds = [...new Set(risk.dataLoss.flatMap((d) => d.kinds))];
  const unflaggedKinds = dataLossKinds.filter((kind) => ROW_DESTROYING_NOT_BREAKING.includes(kind));
  const mightFailKinds = [...new Set(risk.mightFail.flatMap((m) => m.kinds))].join(", ");
  const enumCount = risk.enumAdditions.length;
  const listed = (e: LedgerEntry, list: ReadonlyArray<{ scriptName: string; version: string }>) =>
    list.some((r) => r.scriptName === e.scriptName && r.version === e.version);

  // ── The ticks ─────────────────────────────────────────────────────────────
  const [prodAck, setProdAck] = useState(false);
  const [breakingAck, setBreakingAck] = useState(false);
  const [dataLossAck, setDataLossAck] = useState(false);
  const [driftAck, setDriftAck] = useState(false);
  const unticked =
    (production && !prodAck) ||
    (breakingCount > 0 && !breakingAck) ||
    (dataLossCount > 0 && !dataLossAck) ||
    (drift && !driftAck);
  // Each flag is true only for a risk this run has AND a box the reader ticked.
  const flags: ReplayFlags = {
    acknowledgeProduction: production && prodAck,
    acknowledgeBreaking: breakingCount > 0 && breakingAck,
    acknowledgeDataLoss: dataLossCount > 0 && dataLossAck,
    acknowledgeDrift: drift && driftAck,
  };

  // ── Production approval ───────────────────────────────────────────────────
  // The route claims an approval by the run's fingerprint: these exact
  // scripts, in this order, on this schema. Worked out here the same way
  // (lib/approval-fingerprint), so the panel can say whether one covers it.
  const fingerprint = useMemo(
    () =>
      fingerprintBody(
        entries.map((e) => ({
          scriptName: e.scriptName.trim(),
          version: e.version.trim(),
          sqlContent: e.sqlContent ?? "",
        })),
      ),
    [entries],
  );
  const [runHash, setRunHash] = useState<string | null>(null);
  const [hashError, setHashError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    sha256Hex(fingerprint).then(
      (hash) => {
        if (active) setRunHash(hash);
      },
      () => {
        if (active) {
          setHashError(
            "This browser cannot check the approval — crypto.subtle needs https or localhost. Open the app over https to approve a run.",
          );
        }
      },
    );
    return () => {
      active = false;
    };
  }, [fingerprint]);

  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [approvalsLoading, setApprovalsLoading] = useState(true);
  const [approvalsReadError, setApprovalsReadError] = useState<string | null>(null);
  const [approvalsTry, setApprovalsTry] = useState(0);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalNotice, setApprovalNotice] = useState("");
  const [approvalNote, setApprovalNote] = useState("");

  // Only a production run needs one, so only then is the list read.
  useEffect(() => {
    if (!production) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/deploy/approvals?connectionId=${encodeURIComponent(connectionId)}&schemaName=${encodeURIComponent(schema)}`,
          { cache: "no-store" },
        );
        const data = (await res.json()) as { approvals?: ApprovalRow[]; error?: string };
        if (!active) return;
        if (res.ok && Array.isArray(data.approvals)) {
          setApprovals(data.approvals);
          setApprovalsReadError(null);
        } else {
          setApprovalsReadError(data.error ?? "Could not read the approvals for this target.");
        }
      } catch {
        if (active) setApprovalsReadError("Network error reading the approvals for this target.");
      } finally {
        if (active) setApprovalsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [production, connectionId, schema, approvalsTry]);

  function reloadApprovals() {
    setApprovalsLoading(true);
    setApprovalsTry((t) => t + 1);
  }

  const runApprovals =
    runHash === null
      ? []
      : approvals.filter((a) => (a.action ?? "deploy") === "deploy" && a.run_fingerprint === runHash);
  const approved = runApprovals.find((a) => a.status === "approved") ?? null;
  const pending = runApprovals.find((a) => a.status === "pending") ?? null;
  const latest = runApprovals[0] ?? null;

  async function requestApproval() {
    setApprovalBusy(true);
    setApprovalError(null);
    setApprovalNotice("");
    // The script name only labels the request. The route claims an approval by
    // its connection, schema and run fingerprint (claimApproval never reads
    // script_name), and this dialog finds its approvals by fingerprint too. A
    // run across script groups is labelled "version-sync", not a list of every
    // group's name joined into one, which read as one long script name.
    try {
      const res = await fetch("/api/deploy/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "deploy",
          connectionId: Number(connectionId),
          schemaName: schema,
          scriptName: families.length === 1 ? families[0] : "version-sync",
          targetVersion: last.version.trim(),
          note: approvalNote.trim() || undefined,
          scripts: entries.map((e) => ({
            script_name: e.scriptName,
            version: e.version,
            sql_content: e.sqlContent ?? "",
            change_type: e.changeType,
          })),
        }),
      });
      const data = (await res.json().catch(() => null)) as { approval?: ApprovalRow; error?: string } | null;
      if (!res.ok || !data?.approval) {
        setApprovalError(data?.error ?? "Could not record the approval request.");
        return;
      }
      setApprovalNote("");
      // Under the auth bypass the one principal clears its own request, with
      // the Approve button the panel shows right under this line.
      setApprovalNotice(
        bypass && isAdmin
          ? "Approval requested — with the auth bypass on, you clear it yourself below."
          : "Approval requested — someone else has to clear it."
      );
      reloadApprovals();
    } catch {
      setApprovalError("Network error requesting the approval.");
    } finally {
      setApprovalBusy(false);
    }
  }

  async function decide(id: number, decision: "approve" | "reject") {
    setApprovalBusy(true);
    setApprovalError(null);
    setApprovalNotice("");
    try {
      const res = await fetch(`/api/deploy/approvals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: approvalNote.trim() || undefined }),
      });
      const data = (await res.json().catch(() => null)) as { approval?: ApprovalRow; error?: string } | null;
      if (!res.ok || !data?.approval) {
        setApprovalError(data?.error ?? "Could not record the decision.");
        return;
      }
      setApprovalNote("");
      setApprovalNotice(decision === "approve" ? "Run approved." : "Run rejected.");
      reloadApprovals();
    } catch {
      setApprovalError("Network error recording the decision.");
    } finally {
      setApprovalBusy(false);
    }
  }

  // ── Dry run ───────────────────────────────────────────────────────────────
  const [dryRunning, setDryRunning] = useState(false);
  const [dryResult, setDryResult] = useState<{ ok: boolean; title: string; detail: string } | null>(null);

  async function rehearse() {
    setDryRunning(true);
    setDryResult(null);
    const result = await sendReplay({ connectionId, schemaName: schema, sourceSchema, entries, dryRun: true, flags });
    setDryRunning(false);
    if (result.ok) {
      setDryResult({
        ok: true,
        title: `Dry run clean: rehearsed ${countOf(count, "version")} on ${schema}. Nothing was written.`,
        detail: "",
      });
      return;
    }
    setDryResult({
      ok: false,
      title:
        result.failure === "refused"
          ? "Dry run refused — nothing was run"
          : result.failure === "not-started"
            ? "Dry run did not start — nothing was run"
            : result.failure === "rolled-back"
              ? "Dry run failed — nothing was written"
              : "Dry run result not known",
      detail:
        result.failure === "unknown"
          ? `${result.error} A dry run never commits, so the Target is unchanged. Try it again.`
          : result.error,
    });
  }

  // ── What the buttons may do ───────────────────────────────────────────────
  // The same rule as Deploy: every box ticked for both buttons, and on
  // production an approval for exactly this run before Replay.
  const runBlocked = !ready || unticked || dryRunning || approvalBusy;
  const replayBlocked = runBlocked || (production && approved === null);
  const replayLabel = `Replay ${countOf(count, "version")}${production ? " on production" : ""}`;
  const hint =
    record.state === "loading"
      ? "Both buttons wait for the Target's tracking record."
      : record.state === "error"
        ? "Both buttons stay off until the Target's tracking record can be read."
        : unticked
          ? "Tick every box above to turn on Dry run and Replay."
          : production && approved === null
            ? "Replay also needs the approval above. A dry run does not."
            : "";

  const louderSentence =
    louderCount === 0
      ? ""
      : breakingCount === 1
        ? " It is marked less than breaking but has a statement that is always breaking, so it is counted here."
        : louderCount === 1
          ? " One of them is marked less than breaking but has a statement that is always breaking, so it is counted here."
          : ` ${louderCount} of them are marked less than breaking but have a statement that is always breaking, so they are counted here.`;
  const unflaggedSentence =
    unflaggedKinds.length === 0
      ? ""
      : unflaggedKinds.length === 1
        ? `A ${unflaggedKinds[0]} changes no structure, so it is never graded breaking and gets no breaking pill — this box is the only warning it gets. `
        : `${unflaggedKinds.join(" and ")} change no structure, so they are never graded breaking and get no breaking pill — this box is the only warning they get. `;
  const oneEnum = enumCount === 1;

  return (
    <div className="vsync-dialog">
      <div>
        <h4 id={titleId} className="text-[15px] font-semibold">
          Replay {runName} onto {schema}?
        </h4>
        <p className="text-[13px] mt-1" style={{ color: "var(--text-2)" }}>
          {"This runs on "}
          <b className="mono">{schema}</b>
          {`${databaseName ? ` (${databaseName})` : ""} — a live database — as one transaction: every version in it applies, or none does${
            enumCount > 0 ? " — apart from the enum values named below" : ""
          }. Each version is recorded in that schema's applied-script ledger, just as a Deploy run records it; nothing is written to GitHub.`}
        </p>
        {diverged > 0 && (
          <p className="text-[13px] mt-2" style={{ color: "var(--drift)" }}>
            {`The schemas have diverged: the Target has ${countOf(diverged, "version")} the Source does not, so a replayed script may clash with the Target's own changes.`}
          </p>
        )}
      </div>

      <div className="vsync-dialog__body">
        <div className="section-title mb-2">What runs, in order</div>
        <div className="vsync-runlist">
          {entries.map((e, i) => {
            // The level the Target records: the Source's, raised to what the
            // SQL itself reads as when that is louder (the apply route's rule,
            // readScriptLevel). The Source may have recorded less, so the line
            // says so rather than listing "patch" for a row that lands as
            // "additive".
            const recorded = readScriptLevel({ sqlContent: e.sqlContent ?? "", changeType: e.changeType }).stored;
            const sourceLevel = normalizeChangeLevel(e.changeType);
            return (
              <details key={entryKey(e)} open={listed(e, risk.breaking) || listed(e, risk.dataLoss)}>
                <summary>
                  {i + 1}. <span className="mono">{scriptLabel(e.scriptName, e.version)}</span> — {recorded}
                  {sourceLevel === "unknown"
                    ? " (the Source recorded no level, so the Target records what its SQL reads as)"
                    : sourceLevel !== recorded
                      ? ` (the Source recorded ${sourceLevel}, but its SQL reads as ${recorded}, so the Target records ${recorded})`
                      : null}
                </summary>
                <pre className="vsync-sql mono mt-2">{e.sqlContent}</pre>
              </details>
            );
          })}
        </div>

        <div className="space-y-3 mt-4">
          {record.state === "loading" && (
            <p className="help">{"Checking the Target's tracking record…"}</p>
          )}
          {record.state === "error" && (
            <div className="banner">
              <AlertTriangleIcon size={16} className="ico" />
              <div className="body">
                <div className="title">{"Could not read the Target's tracking record"}</div>
                <div className="help mt-0.5">
                  {`${record.message} Dry run and Replay stay off until it can be read, because the record says whether ${schema} is production and what its last drift check found — the two things the server checks before it runs anything. Nothing has run.`}
                </div>
                <button
                  className="btn btn-secondary btn-sm mt-2"
                  onClick={() => {
                    setRecord({ state: "loading" });
                    setRecordTry((t) => t + 1);
                  }}
                >
                  <RefreshIcon size={13} /> Try again
                </button>
              </div>
            </div>
          )}

          {production && (
            <ProductionGate
              what={`replay ${countOf(count, "version")}`}
              acknowledged={prodAck}
              onAcknowledge={setProdAck}
            />
          )}

          {breakingCount > 0 && (
            <RiskGate
              tone="break"
              title={`${breakingCount} breaking migration${breakingCount === 1 ? "" : "s"}`}
              body={
                "A breaking migration drops or rewrites structure that is already there. Anything " +
                "reading the old shape — an app, a view, a report — stops working the moment this " +
                "commits. The breaking ones are open in the list above, showing the statements they " +
                "will run." +
                louderSentence
              }
              ack={`I have read the ${breakingCount === 1 ? "breaking migration" : "breaking migrations"} and know what stops working.`}
              acknowledged={breakingAck}
              onAcknowledge={setBreakingAck}
            />
          )}

          {dataLossCount > 0 && (
            <RiskGate
              tone="break"
              title={`${dataLossCount} ${dataLossCount === 1 ? "migration deletes" : "migrations delete"} rows`}
              body={
                `This replay contains ${dataLossKinds.join(", ")}. Those take rows out of a live table, ` +
                "and no rollback puts them back — a down script rebuilds structure, not data. " +
                unflaggedSentence +
                "Have a backup you can restore from before running this."
              }
              ack="I have read these statements and know which rows they delete."
              acknowledged={dataLossAck}
              onAcknowledge={setDataLossAck}
            >
              <ul className="prod-gate__body" style={{ paddingLeft: 18, listStyle: "disc" }}>
                {risk.dataLoss.map((d) => (
                  <li key={d.label}>
                    <span className="mono">{d.label}</span>: {d.kinds.join(", ")}
                  </li>
                ))}
              </ul>
            </RiskGate>
          )}

          {risk.mightFail.length > 0 && (
            // No tick: the replay is one transaction, so this is the risk that
            // costs nothing when it happens.
            <div className="warn-inline">
              <span className="ico">
                <AlertTriangleIcon size={14} />
              </span>
              <span>
                <b>{countOf(risk.mightFail.length, "version")} may be refused by the data already in the table.</b>{" "}
                {`This replay contains ${mightFailKinds}. Those are valid SQL that PostgreSQL checks against every existing row — one NULL, one duplicate or one value that will not cast and the statement stops. Nothing is half-applied if that happens: the replay is one transaction, so it rolls back and the Target is left as it is now. A dry run finds this out without writing anything.`}
              </span>
            </div>
          )}

          {enumCount > 0 && (
            <RiskGate
              tone="drift"
              title={oneEnum ? "1 enum value runs before the transaction" : `${enumCount} enum values run before the transaction`}
              body={
                "PostgreSQL will not let a value added by ALTER TYPE … ADD VALUE be used by another " +
                "statement in the same transaction, so the run adds " +
                (oneEnum ? "this one first, on its own. It commits" : "these first, on their own. They commit") +
                " straight away. If the run then fails, everything else is rolled back and " +
                (oneEnum ? "this stays" : "these stay") +
                " — there is no statement in PostgreSQL that removes an enum value, so it cannot be " +
                "undone by hand either. A label nothing uses does no harm; it is simply the one part " +
                "of the run that is not all-or-nothing. A dry run cannot lift them out without leaving " +
                "them behind, so it runs them inside the transaction instead — which is why rehearsing " +
                "a script that uses its own new value fails where the real run succeeds."
              }
            >
              <ul className="prod-gate__body" style={{ paddingLeft: 18, listStyle: "disc" }}>
                {risk.enumAdditions.map((value) => (
                  <li key={value} className="mono">{value}</li>
                ))}
              </ul>
            </RiskGate>
          )}

          {drift && record.state === "ready" && (
            <RiskGate
              tone="drift"
              title={
                record.drift === "drifted"
                  ? "The last drift check found the target drifted"
                  : "The last drift check could not reach the target"
              }
              body={
                `The last drift check on record ${
                  record.drift === "drifted"
                    ? `found ${schema} different from the snapshot it is tracked against`
                    : `could not reach ${schema}`
                }. The server holds every run on ${schema} to that result, a dry run included, ` +
                "until a drift check passes. Run the drift check again on the Drift screen, or " +
                "tick below to run anyway."
              }
              ack="I mean to run without a drift check that passed."
              acknowledged={driftAck}
              onAcknowledge={setDriftAck}
            >
              <p className="prod-gate__body">
                <Link href="/drift" style={{ textDecoration: "underline" }}>
                  Open the Drift screen
                </Link>
              </p>
            </RiskGate>
          )}

          {production && (
            <ApprovalPanel
              migrationCount={count}
              targetVersion={families.length === 1 ? last.version.trim() : ""}
              hashReady={runHash !== null}
              hashError={hashError}
              loading={approvalsLoading}
              error={approvalError ?? approvalsReadError}
              unreadable={approvalsReadError !== null && approvals.length === 0}
              busy={approvalBusy}
              approved={approved}
              pending={pending}
              latest={latest}
              viewerEmail={user?.email ?? ""}
              isAdmin={isAdmin}
              bypass={bypass}
              note={approvalNote}
              onNoteChange={setApprovalNote}
              onRequest={() => void requestApproval()}
              onDecide={(id, decision) => void decide(id, decision)}
              runButton={replayLabel}
            />
          )}
          {approvalNotice && (
            <p className="help" style={{ color: "var(--sync)" }}>{approvalNotice}</p>
          )}

          {dryResult &&
            (dryResult.ok ? (
              <div className="banner" style={SYNC_BANNER}>
                <CheckIcon size={16} className="ico" />
                <div className="body">
                  <div className="title" style={{ color: "var(--sync)" }}>{dryResult.title}</div>
                </div>
              </div>
            ) : (
              <div className="banner">
                <AlertTriangleIcon size={16} className="ico" />
                <div className="body">
                  <div className="title">{dryResult.title}</div>
                  <div className="help mt-0.5">{dryResult.detail}</div>
                </div>
              </div>
            ))}
        </div>
      </div>

      <div className="vsync-dialog__foot">
        {hint && <p className="help mb-2">{hint}</p>}
        <div className="flex justify-end gap-2 flex-wrap">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-secondary btn-sm"
            disabled={runBlocked}
            title="Rehearse the replay: it runs inside a transaction that is always rolled back, so nothing is written"
            onClick={() => void rehearse()}
          >
            {dryRunning ? (
              <>
                <RefreshIcon size={13} className="spin-icon" /> Rehearsing…
              </>
            ) : (
              "Dry run"
            )}
          </button>
          <button
            className={`btn btn-sm ${production ? "btn-destructive" : "btn-primary"}`}
            disabled={replayBlocked}
            onClick={() => onReplay(flags)}
          >
            {replayLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
