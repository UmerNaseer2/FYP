"use client";

import "@/app/styles/atelier-dashboard.css";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AskAdmin } from "@/components/studio/AskAdmin";
import {
  Button,
  Pill,
  Card,
  Skeleton,
  Drawer,
  ConfirmDialog,
  Label,
  Input,
  EnvironmentPill,
  type PillTone,
} from "@/components/ui";
import {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  ENVIRONMENT_META,
  isProduction,
  toEnvironment,
  type Environment,
} from "@/lib/environments";
import { Select } from "@/components/ui/Select";
import { HelpHint } from "@/components/ui/HelpHint";
import { PageHeader } from "@/components/studio/PageHeader";
import { useDriftCheckRefusal } from "@/components/studio/RecheckDriftButton";
import { useNow } from "@/hooks/useNow";
import { useOrgHref } from "@/hooks/useOrg";
import { useUser } from "@/hooks/useUser";
import { describeCadence } from "@/lib/drift-schedule";
import { refusalMessage, refusalMessageForAll, type PermissionKey } from "@/lib/permissions";
import { displayVersion } from "@/lib/version-timeline";
import {
  CheckIcon,
  AlertTriangleIcon,
  AlertCircleIcon,
  RefreshIcon,
  PlusIcon,
  TrashIcon,
  InfoIcon,
} from "@/components/ui/icons";
import { apiFetch } from "@/lib/api-fetch";

/**
 * Dashboard: "The Skyline".
 *
 * Every tracked schema (GET /api/lineage) is drawn as one building in a small
 * city. The roof colour is what the last drift check found, and the height is
 * a real number about the schema: how many versions it has recorded, or how
 * many tables its latest recorded version had. Press a building to read about
 * it and to act on it. Drifted schemas stand at the front. Real data only.
 *
 * Tracking, checking and untracking each have their own box on the Roles tab
 * (Drift tracking: Create, Run and Delete). A button the role may not use
 * stays on screen but off, and the page says why once, under the header.
 */

// ── Types — mirror of GET /api/lineage (TrackedSchemaListItem) ───────────────
type DriftStatus = "in_sync" | "drifted" | "unreachable";

type TrackedSchema = {
  id: number;
  connectionId: number;
  schemaName: string;
  label: string | null;
  // dev / staging / prod. Optional because a response written before the column
  // existed simply omits it; read it through toEnvironment(), never directly.
  environment?: string | null;
  createdAt: string;
  connectionName: string | null;
  connectionHost: string | null;
  connectionDatabase: string | null;
  headVersion: string | null;
  headSeq: number | null;
  migrationCount: number;
  driftStatus: DriftStatus | null;
  driftSummary: string | null;
  driftCheckedAt: string | null;
  // How often this schema is checked on its own, in minutes; 0 is manual only.
  driftIntervalMinutes?: number;
  // When a check last RAN. A scheduled check that changes nothing records no
  // event, so driftCheckedAt (the last recorded RESULT) can be much older.
  lastCheckedAt?: string | null;
};

/** A saved connection as GET /api/connections returns it (only fields we use). */
type ConnectionRow = {
  id: number;
  name: string;
  host: string;
  database_name: string;
  type: string;
  environment?: string | null;
};

/** What a building's height stands for. */
type HeightBy = "versions" | "tables";

/** Where the saved-connections fetch has got to. */
type ConnPhase = { kind: "idle" } | { kind: "loading" } | { kind: "ready" } | { kind: "error" };

// ── Small pure helpers ───────────────────────────────────────────────────────

/** Compact "3m ago" style relative time. Client-only, so no SSR mismatch. */
function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** How each drift status reads on a card: pill tone, label, and hero flag. */
function driftMeta(status: DriftStatus | null): {
  tone: PillTone;
  label: string;
  hero: boolean;
} {
  switch (status) {
    case "drifted":
      return { tone: "drift", label: "Drifted", hero: true };
    case "in_sync":
      return { tone: "sync", label: "In sync", hero: false };
    case "unreachable":
      return { tone: "break", label: "Unreachable", hero: false };
    default:
      return { tone: "neutral", label: "Not checked", hero: false };
  }
}

/** Drifted first (hero), then unreachable, then never-checked, then in-sync. */
function sortPriority(status: DriftStatus | null): number {
  switch (status) {
    case "drifted":
      return 0;
    case "unreachable":
      return 1;
    case "in_sync":
      return 3;
    default:
      return 2; // null — tracked but never drift-checked
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const orgPath = useOrgHref();
  // What this role may do here, one box per write.
  const { roleLabel, loading: sessionLoading, can } = useUser();
  const trackRefusal =
    sessionLoading || can("drift:create") ? null : refusalMessage(roleLabel, "drift:create");
  const checkRefusal = useDriftCheckRefusal();
  const untrackRefusal =
    sessionLoading || can("drift:delete") ? null : refusalMessage(roleLabel, "drift:delete");

  // The tracked-schema list (the grid + summary strip read from this).
  const [items, setItems] = useState<TrackedSchema[]>([]);
  const [listPhase, setListPhase] = useState<"loading" | "ready" | "error">("loading");
  const [checkingId, setCheckingId] = useState<number | null>(null);
  const [cardError, setCardError] = useState<{ id: number; msg: string } | null>(null);
  // "all", or one environment. Filtering the grid is how you answer "what is
  // actually in production right now?" without reading every card.
  const [envFilter, setEnvFilter] = useState<"all" | Environment>("all");
  // The building whose details are on screen. Null means the first one.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [heightBy, setHeightBy] = useState<HeightBy>("versions");
  // Tables in each schema's latest recorded version, by tracked schema id.
  // Missing means not read yet; null means the read failed.
  const [tableCounts, setTableCounts] = useState<Record<number, number | null>>({});
  // Which schemas we have already asked about, so each is asked once.
  const askedTables = useRef(new Set<number>());

  // Track-a-schema drawer.
  const [trackOpen, setTrackOpen] = useState(false);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [connPhase, setConnPhase] = useState<ConnPhase>({ kind: "idle" });
  const [trackConnId, setTrackConnId] = useState("");
  const [schemaOptions, setSchemaOptions] = useState<string[]>([]);
  const [schemaPhase, setSchemaPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [schemaError, setSchemaError] = useState<string | null>(null);
  // Which schema-list request is the current one. Picking a second connection
  // while the first is still loading used to let the SLOWER answer land last
  // and overwrite the newer list, so the box offered schemas that live on a
  // connection nobody had selected any more — and tracking one of them failed
  // with "schema not found" naming a schema this screen had just offered.
  // Same guard the compare screen's slot pickers take.
  const latestSchemaRequest = useRef(0);
  const [trackSchema, setTrackSchema] = useState("");
  const [trackLabel, setTrackLabel] = useState("");
  // Seeded from the chosen connection, then editable: one server can host a
  // staging schema and a production one.
  const [trackEnv, setTrackEnv] = useState<Environment>(DEFAULT_ENVIRONMENT);
  const [trackEnvTouched, setTrackEnvTouched] = useState(false);
  const [trackSubmitting, setTrackSubmitting] = useState(false);
  const [trackError, setTrackError] = useState<string | null>(null);

  // Untrack confirm. No "removing" flag — ConfirmDialog closes on confirm, so
  // a busy label on its button could never be seen.
  const [untrackTarget, setUntrackTarget] = useState<TrackedSchema | null>(null);

  // ── Load the list ──────────────────────────────────────────────────────────
  const loadList = useCallback(async () => {
    setListPhase("loading");
    try {
      const res = await apiFetch("/api/lineage", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      // The route answers with an error object, not a list, when it cannot read
      // the database. Checking the status matters more than the shape: an empty
      // dashboard has to mean "you track nothing", never "the query failed".
      if (!res.ok || !Array.isArray(data)) {
        setItems([]);
        setListPhase("error");
        return;
      }
      setItems(data);
      setListPhase("ready");
    } catch {
      setItems([]);
      setListPhase("error");
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // ── Read the table counts ──────────────────────────────────────────────────
  // Only once somebody picks "Tables" as the height. The list does not carry
  // the number, so each schema's own details are read (GET /api/lineage/[id])
  // and the newest version's snapshot says how many tables it had.
  useEffect(() => {
    if (heightBy !== "tables") return;

    async function readTableCount(id: number) {
      let count: number | null = null;
      try {
        const res = await apiFetch(`/api/lineage/${id}`, { cache: "no-store" });
        const data = res.ok ? await res.json() : null;
        const tables = data?.migrations?.[0]?.snapshot?.tableCount;
        if (typeof tables === "number") count = tables;
      } catch {
        count = null;
      }
      setTableCounts((previous) => ({ ...previous, [id]: count }));
    }

    for (const item of items) {
      if (askedTables.current.has(item.id)) continue;
      askedTables.current.add(item.id);
      void readTableCount(item.id);
    }
  }, [heightBy, items]);

  // ── Load the saved connections ─────────────────────────────────────────────
  // On mount as well as on every drawer open: the dashboard has to know whether
  // tracking is even possible before it offers "Track a schema" as the only
  // thing a first-time user can press.
  const loadConnections = useCallback(async () => {
    setConnPhase({ kind: "loading" });
    try {
      const res = await apiFetch("/api/connections", { cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      if (!Array.isArray(data)) {
        setConnections([]);
        setConnPhase({ kind: "error" });
        return;
      }
      setConnections(data.filter((c: ConnectionRow) => c.type === "PostgreSQL"));
      setConnPhase({ kind: "ready" });
    } catch {
      setConnections([]);
      setConnPhase({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  // ── Track flow ─────────────────────────────────────────────────────────────
  function resetTrackForm() {
    setTrackConnId("");
    setSchemaOptions([]);
    setSchemaPhase("idle");
    setSchemaError(null);
    setTrackSchema("");
    setTrackLabel("");
    setTrackEnv(DEFAULT_ENVIRONMENT);
    setTrackEnvTouched(false);
    setTrackError(null);
  }

  function openTrack() {
    // The buttons that open it are off already.
    if (trackRefusal !== null) return;
    resetTrackForm();
    setTrackOpen(true);
    // Pull the connection list fresh each time the drawer opens — one may have
    // been saved on the Connections page since this dashboard loaded. It also
    // clears a previous failure, so reopening the drawer is the retry.
    void loadConnections();
  }

  async function onPickConnection(id: string) {
    setTrackConnId(id);
    // Inherit the connection's environment — the user already said which
    // environment this server is, so asking again would be asking twice. Once
    // they change it by hand we stop overwriting their answer.
    if (!trackEnvTouched) {
      const picked = connections.find((c) => String(c.id) === id);
      setTrackEnv(toEnvironment(picked?.environment));
    }
    setTrackSchema("");
    setSchemaOptions([]);
    setSchemaError(null);
    setTrackError(null);
    // Claimed BEFORE the empty-id exit, not after. Clearing the picker is also
    // a newer answer than a request still in flight: leaving the counter alone
    // here let that older request land and fill the box for a connection that
    // is no longer selected at all.
    const request = ++latestSchemaRequest.current;
    if (!id) {
      setSchemaPhase("idle");
      return;
    }
    setSchemaPhase("loading");
    try {
      const res = await apiFetch(`/api/lineage/schemas?connectionId=${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      const data = await res.json();
      // Every exit below is guarded, not just the success one: a stale ERROR
      // would paint a working connection as broken just as wrongly as a stale
      // list paints it with the wrong schemas.
      if (request !== latestSchemaRequest.current) return;
      if (!res.ok) {
        setSchemaError(data.error ?? "Could not list schemas for this connection.");
        setSchemaPhase("error");
        return;
      }
      setSchemaOptions(Array.isArray(data.schemas) ? data.schemas : []);
      setSchemaPhase("ready");
    } catch {
      if (request !== latestSchemaRequest.current) return;
      setSchemaError("Network error while listing schemas.");
      setSchemaPhase("error");
    }
  }

  async function submitTrack() {
    if (!trackConnId || !trackSchema || trackRefusal !== null) return;
    setTrackSubmitting(true);
    setTrackError(null);
    try {
      const res = await apiFetch("/api/lineage/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(trackConnId),
          schemaName: trackSchema,
          label: trackLabel.trim() || undefined,
          environment: trackEnv,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTrackError(data.error ?? "Could not track this schema.");
        return;
      }
      setTrackOpen(false);
      await loadList();
    } catch {
      setTrackError("Network error while tracking the schema.");
    } finally {
      setTrackSubmitting(false);
    }
  }

  // ── Actions on the picked schema ───────────────────────────────────────────────────────
  async function checkDrift(item: TrackedSchema) {
    if (checkRefusal !== null) return;
    setCheckingId(item.id);
    setCardError(null);
    try {
      const res = await apiFetch("/api/lineage/drift", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackedSchemaId: item.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.status) {
        setCardError({ id: item.id, msg: data.error ?? "Drift check failed." });
        return;
      }
      // The check wrote a drift_event; reload so the card + summary reflect it.
      await loadList();
    } catch {
      setCardError({ id: item.id, msg: "Network error during the drift check." });
    } finally {
      setCheckingId(null);
    }
  }

  async function confirmUntrack() {
    if (!untrackTarget || untrackRefusal !== null) return;
    // ConfirmDialog closes itself the moment you press confirm, so the failure
    // has to land on the card — the dialog is gone before the fetch resolves,
    // and a schema that is still tracked looks exactly like one that was
    // removed.
    const target = untrackTarget;
    try {
      const res = await apiFetch("/api/lineage", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: target.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setCardError({
          id: target.id,
          msg: data?.error ?? "Could not stop tracking this schema.",
        });
        setUntrackTarget(null);
        return;
      }
      setCardError(null);
      setUntrackTarget(null);
      await loadList();
    } catch {
      setCardError({ id: target.id, msg: "Network error while untracking the schema." });
      setUntrackTarget(null);
    }
  }

  // ── Derived: summary counts + hero-first ordering ──────────────────────────
  const total = items.length;
  const envCount = (environment: Environment) =>
    items.filter((i) => toEnvironment(i.environment) === environment).length;
  const unlabelledCount = envCount("unset");

  const visible =
    envFilter === "all"
      ? items
      : items.filter((i) => toEnvironment(i.environment) === envFilter);

  // The tiles count what is on screen, so they agree with the grid under it.
  const drifted = visible.filter((i) => i.driftStatus === "drifted").length;
  const inSync = visible.filter((i) => i.driftStatus === "in_sync").length;
  const unreachable = visible.filter((i) => i.driftStatus === "unreachable").length;
  // The fourth state, and the one every schema starts in. Without a tile of its
  // own a freshly tracked schema showed as "Tracked 1" over "Drifted 0 · In
  // sync 0 · Unreachable 0" — three zeros that do not add up to one, which
  // reads as the dashboard having lost it. Counting it here makes the strip
  // account for every row: drifted + in sync + unreachable + not checked
  // is always the tracked count.
  const notChecked = visible.length - drifted - inSync - unreachable;
  const prodShown = visible.filter((i) => isProduction(toEnvironment(i.environment))).length;
  const sorted = [...visible].sort(
    (a, b) => sortPriority(a.driftStatus) - sortPriority(b.driftStatus)
  );

  // The building on show: the one picked, or the first if that one has gone
  // (untracked, or hidden by the environment filter).
  const selected = sorted.find((i) => i.id === selectedId) ?? sorted[0] ?? null;
  const needsYou = sorted.filter(
    (i) => i.driftStatus === "drifted" || i.driftStatus === "unreachable"
  );
  const noConnections = connPhase.kind === "ready" && connections.length === 0;

  const buildings: Building[] = sorted.map((item) => {
    const tables = tableCounts[item.id];
    const amount =
      heightBy === "versions"
        ? `${item.migrationCount} recorded version${item.migrationCount === 1 ? "" : "s"}`
        : typeof tables === "number"
          ? `${tables} table${tables === 1 ? "" : "s"}`
          : "table count not known";
    return {
      id: item.id,
      name: item.schemaName,
      status: item.driftStatus ?? "unchecked",
      value: heightBy === "versions" ? item.migrationCount : (tables ?? null),
      label:
        `${item.schemaName}, ${ENVIRONMENT_META[toEnvironment(item.environment)].label}, ` +
        `${driftMeta(item.driftStatus).label}, ${amount}`,
    };
  });

  const trackButton = (
    <Button
      variant="primary"
      onClick={openTrack}
      disabled={trackRefusal !== null}
      title={trackRefusal ?? undefined}
    >
      <PlusIcon size={14} /> Track a schema
    </Button>
  );

  // Why buttons on this page are off for this role, in one sentence rather
  // than a paragraph per button. The card buttons only count once there are
  // cards to press them on. A single refusal opens Requests with it picked.
  // A check is allowed by Drift: Run or Deploy: Run (useDriftCheckRefusal),
  // and its refusal names the Drift one.
  const refusedKeys: PermissionKey[] = [];
  if (trackRefusal) refusedKeys.push("drift:create");
  if (total > 0 && checkRefusal) refusedKeys.push("drift:run");
  if (total > 0 && untrackRefusal) refusedKeys.push("drift:delete");
  const roleNote = refusedKeys.length > 0 ? refusalMessageForAll(roleLabel, refusedKeys) : null;

  return (
    <div className="sk-page max-w-[1100px] mx-auto px-4 sm:px-8 py-8 sm:py-10 space-y-6">
      {/* Header. The title and its one line come from lib/help/studio.ts. */}
      <PageHeader
        page="/studio"
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => void loadList()}
              disabled={listPhase === "loading"}
              aria-label="Refresh"
            >
              <RefreshIcon size={14} /> Refresh
            </Button>
            {trackButton}
          </>
        }
      />

      {/* Said once for the page rather than beside every button. */}
      {roleNote && (
        <div className="role-note">
          <InfoIcon size={15} className="ico" />
          <div className="body">
            <p>
              {roleNote}
              <AskAdmin permission={refusedKeys.length === 1 ? refusedKeys[0] : undefined} />
            </p>
          </div>
        </div>
      )}

      {/* Only while something is genuinely unlabelled. That is the state in
          which nothing downstream can warn you that a target is production. */}
      {listPhase === "ready" && unlabelledCount > 0 && (
        <div className="warn-inline">
          <span className="ico">
            <AlertCircleIcon size={14} />
          </span>
          <div className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
            <b>
              {unlabelledCount} tracked schema{unlabelledCount === 1 ? " has" : "s have"} no
              environment.
            </b>{" "}
            {sessionLoading || can("drift:update")
              ? "Label them so Compare and Deploy can tell you when a target is production."
              : "Compare and Deploy can't tell you when a target is production until they are " +
                "labelled. Ask someone who may change schema environments to label them."}
          </div>
        </div>
      )}

      {listPhase === "loading" && (
        <div role="status" aria-label="Loading the dashboard">
          <Skeleton width="100%" height={380} radius={24} />
        </div>
      )}

      {listPhase === "error" && (
        <StateCard
          tone="break"
          icon={<AlertCircleIcon size={22} />}
          title="Couldn't load tracked schemas"
          description="The app database may be unreachable. Try again in a moment."
        >
          <Button variant="secondary" onClick={() => void loadList()}>
            <RefreshIcon size={14} /> Retry
          </Button>
        </StateCard>
      )}

      {/* Two first-run states, not one. Offering "Track a schema" to somebody
          with no saved connection sends them into a drawer whose only option is
          an empty list, so the connections are read on mount and we can tell
          them first. A failed connections read deliberately falls through to
          the second card rather than claiming they have no connections. */}
      {listPhase === "ready" && total === 0 && noConnections && (
        <FirstRun
          step={1}
          title="Add a connection first"
          description="Save a PostgreSQL connection, then come back and track a schema on it."
        >
          <Link href={orgPath("/connections")} className="btn btn-primary">
            <PlusIcon size={14} /> Add a connection
          </Link>
        </FirstRun>
      )}

      {listPhase === "ready" && total === 0 && !noConnections && (
        <FirstRun
          step={2}
          title="Nothing tracked yet"
          description="Track a schema to record what it looks like today and to hear when the live database changes."
        >
          {trackButton}
        </FirstRun>
      )}

      {listPhase === "ready" && total > 0 && (
        <>
          <section className="sk-stage" aria-label="The skyline">
            <div className="sk-top">
              {/* Counts are over everything tracked, so they stay put while
                  you move between environments. */}
              <div className="sk-envs" role="group" aria-label="Environment">
                <button
                  type="button"
                  aria-pressed={envFilter === "all"}
                  onClick={() => setEnvFilter("all")}
                >
                  All <span>{total}</span>
                </button>
                {ENVIRONMENTS.map((environment) => (
                  <button
                    key={environment}
                    type="button"
                    aria-pressed={envFilter === environment}
                    onClick={() => setEnvFilter(environment)}
                  >
                    {ENVIRONMENT_META[environment].label} <span>{envCount(environment)}</span>
                  </button>
                ))}
              </div>
              <div className="sk-seg" role="radiogroup" aria-label="Height shows">
                <span aria-hidden="true">Height shows</span>
                <button
                  type="button"
                  role="radio"
                  aria-checked={heightBy === "versions"}
                  onClick={() => setHeightBy("versions")}
                >
                  Versions
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={heightBy === "tables"}
                  onClick={() => setHeightBy("tables")}
                >
                  Tables
                </button>
              </div>
            </div>

            {sorted.length === 0 && (
              <div className="sk-none">
                <h2>Nothing tracked in {ENVIRONMENT_META[envFilter as Environment].label}</h2>
                <p>Every tracked schema is in another environment.</p>
                <Button variant="secondary" onClick={() => setEnvFilter("all")}>
                  Show all environments
                </Button>
              </div>
            )}

            {sorted.length > 0 && selected && (
              <>
                <div className="sk-mid">
                  <div className="sk-city">
                    <Skyline
                      buildings={buildings}
                      selectedId={selected.id}
                      onSelect={setSelectedId}
                    />
                  </div>
                  <Inspector
                    key={selected.id}
                    item={selected}
                    tables={tableCounts[selected.id]}
                    heightBy={heightBy}
                    checking={checkingId === selected.id}
                    error={cardError?.id === selected.id ? cardError.msg : null}
                    checkRefusal={checkRefusal}
                    untrackRefusal={untrackRefusal}
                    onCheckDrift={() => void checkDrift(selected)}
                    onUntrack={() => setUntrackTarget(selected)}
                  />
                </div>

                <div className="sk-bot">
                  <span>
                    {heightBy === "versions"
                      ? "Each building is one tracked schema. A taller one has more recorded versions."
                      : "Each building is one tracked schema. A taller one had more tables in its latest recorded version."}
                  </span>
                  <span className="sk-leg">
                    <span data-s="drifted">
                      <i /> Drifted
                    </span>
                    <span data-s="unreachable">
                      <i /> Unreachable
                    </span>
                    <span data-s="unchecked">
                      <i /> Not checked
                    </span>
                    <span data-s="in_sync">
                      <i /> In sync
                    </span>
                  </span>
                </div>

                <details className="sk-tb">
                  <summary>Show as a table</summary>
                  <div className="sk-tb-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Schema</th>
                          <th scope="col">Environment</th>
                          <th scope="col">Last check found</th>
                          <th scope="col">Versions</th>
                          {heightBy === "tables" && <th scope="col">Tables</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((item) => (
                          <tr key={item.id}>
                            <td>
                              <button
                                type="button"
                                aria-label={`Show ${item.schemaName} in the skyline`}
                                onClick={() => setSelectedId(item.id)}
                              >
                                {item.schemaName}
                              </button>
                            </td>
                            <td>{ENVIRONMENT_META[toEnvironment(item.environment)].label}</td>
                            <td>{driftMeta(item.driftStatus).label}</td>
                            <td>{item.migrationCount}</td>
                            {heightBy === "tables" && <td>{tablesText(tableCounts[item.id])}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )}
          </section>

          {/* Every number counts what is on screen, so the numbers and the
              city can never disagree. Drifted, in sync, unreachable and not
              checked always add up to the first one. */}
          <div className="sk-vit">
            <Vital label={envFilter === "all" ? "Tracked" : "Showing"} value={visible.length} />
            <Vital label="Production" value={prodShown} tone={prodShown > 0 ? "break" : undefined} />
            <Vital label="Drifted" value={drifted} tone={drifted > 0 ? "drift" : undefined} />
            <Vital label="In sync" value={inSync} tone={inSync > 0 ? "sync" : undefined} />
            <Vital
              label="Unreachable"
              value={unreachable}
              tone={unreachable > 0 ? "break" : undefined}
            />
            <Vital label="Not checked" value={notChecked} />
          </div>

          <Card className="sk-need">
            <div className="sk-hd">
              <h2>Needs you</h2>
              <small>
                {needsYou.length} of {visible.length}
              </small>
            </div>
            {needsYou.length === 0 && (
              <p className="sk-quiet">Nothing here has drifted or stopped answering.</p>
            )}
            {needsYou.map((item) => (
              <button
                key={item.id}
                type="button"
                className="sk-nr"
                data-s={item.driftStatus ?? undefined}
                aria-pressed={selected?.id === item.id}
                onClick={() => setSelectedId(item.id)}
              >
                <i aria-hidden="true" />
                <span>
                  <b>{item.schemaName}</b>
                  <em>{driftMeta(item.driftStatus).label}</em>
                  <span>{item.driftSummary ?? "No details were recorded."}</span>
                </span>
                <span className="sk-nr-go">Show in the skyline</span>
              </button>
            ))}
          </Card>
        </>
      )}

      {/* Track-a-schema drawer */}
      <Drawer
        open={trackOpen}
        onClose={() => setTrackOpen(false)}
        title="Track a schema"
        badge={<Pill tone="brand" dot={false}>new baseline</Pill>}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setTrackOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void submitTrack()}
              disabled={!trackConnId || !trackSchema || trackSubmitting}
            >
              {trackSubmitting ? "Tracking…" : "Track schema"}
            </Button>
          </>
        }
      >
        <p className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
          A baseline snapshot is taken now, as lineage <span className="mono">v1.0.0</span>.
        </p>

        <div>
          <Label className="mb-1 block">Connection</Label>
          <Select
            variant="input"
            ariaLabel="Connection"
            value={trackConnId}
            disabled={connPhase.kind !== "ready"}
            placeholder={
              connPhase.kind === "loading" ? "Loading connections…" : "Select a connection…"
            }
            options={connections.map((c) => ({
              value: String(c.id),
              label: `${c.name} — ${c.host}/${c.database_name}`,
            }))}
            onChange={(value) => void onPickConnection(value)}
          />
          {/* Only once the fetch has settled — while it is in flight the Select
              is disabled and says so, and an empty list means nothing yet. */}
          {connPhase.kind === "error" && (
            <p className="help mt-1" style={{ color: "var(--break)" }}>
              Could not read your saved connections. Close this and press “Track a
              schema” again.
            </p>
          )}
          {connPhase.kind === "ready" && connections.length === 0 && (
            <p className="help mt-1">
              No PostgreSQL connections saved yet.{" "}
              <Link href={orgPath("/connections")} style={{ color: "var(--brand)" }}>
                Add one on the Connections page
              </Link>
              .
            </p>
          )}
        </div>

        <div>
          <Label className="mb-1 block">Schema</Label>
          <Select
            variant="input"
            ariaLabel="Schema"
            value={trackSchema}
            disabled={!trackConnId || schemaPhase !== "ready"}
            placeholder={
              schemaPhase === "loading"
                ? "Loading schemas…"
                : schemaPhase === "ready"
                  ? "Select a schema…"
                  : "Pick a connection first"
            }
            options={schemaOptions.map((s) => ({ value: s, label: s }))}
            onChange={(value) => setTrackSchema(value)}
          />
          {schemaPhase === "error" && schemaError && (
            <p className="help mt-1" style={{ color: "var(--break)" }}>
              {schemaError}
            </p>
          )}
          {schemaPhase === "ready" && schemaOptions.length === 0 && (
            <p className="help mt-1">This connection has no user schemas to track.</p>
          )}
        </div>

        {/* Environment — inherited from the connection, still editable, because
            one server can host a staging schema and a production one. */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <Label>Environment</Label>
            <span className="help">
              {trackEnvTouched ? "Set for this schema" : "Inherited from the connection"}
            </span>
          </div>
          <div
            className="seg"
            role="radiogroup"
            aria-label="Environment"
            style={{ display: "flex" }}
          >
            {ENVIRONMENTS.map((environment) => (
              <button
                key={environment}
                className={trackEnv === environment ? "active" : ""}
                role="radio"
                aria-checked={trackEnv === environment}
                onClick={() => {
                  setTrackEnv(environment);
                  setTrackEnvTouched(true);
                }}
                type="button"
                style={{ flex: 1 }}
              >
                {ENVIRONMENT_META[environment].label}
              </button>
            ))}
          </div>
          <p className="help mt-1.5">{ENVIRONMENT_META[trackEnv].help}</p>
        </div>

        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <Label>Label (optional)</Label>
            <HelpHint label="Label">
              A friendly name to show on its card. Production warnings come from the Environment
              setting above, not from this label.
            </HelpHint>
          </div>
          <Input
            placeholder="e.g. Billing service"
            value={trackLabel}
            onChange={(e) => setTrackLabel(e.target.value)}
          />
        </div>

        {trackError && (
          <div
            className="flex items-start gap-2 p-2.5 rounded-lg"
            style={{
              background: "color-mix(in oklab, var(--break) 10%, transparent)",
              border: "1px solid color-mix(in oklab, var(--break) 30%, transparent)",
            }}
          >
            <AlertTriangleIcon size={14} style={{ color: "var(--break)", marginTop: 1 }} />
            <span className="text-[12.5px]" style={{ color: "var(--break)" }}>
              {trackError}
            </span>
          </div>
        )}
      </Drawer>

      {/* Untrack confirm */}
      <ConfirmDialog
        open={untrackTarget !== null}
        onClose={() => setUntrackTarget(null)}
        onConfirm={() => void confirmUntrack()}
        destructive
        title="Stop tracking this schema?"
        description={
          <>
            <span className="mono">{untrackTarget?.schemaName}</span>{" "}
            and its captured snapshots, lineage, and drift history will be
            removed. This can&apos;t be undone.
            {untrackTarget && isProduction(toEnvironment(untrackTarget.environment)) && (
              <span className="block mt-2" style={{ color: "var(--break)" }}>
                This schema is labelled production. Untracking leaves the live database
                untouched, but you lose every baseline you could compare it against.
              </span>
            )}
          </>
        }
        confirmLabel="Stop tracking"
      />
    </div>
  );
}

// ── Presentational pieces ────────────────────────────────────────────────────

/** One big number above the "Needs you" list. */
function Vital({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "drift" | "sync" | "break";
}) {
  return (
    <Card className="sk-v" data-tone={tone}>
      <small>{label}</small>
      <b>{value}</b>
    </Card>
  );
}

/** A plain card for "this went wrong": an icon, what happened, and a way on. */
function StateCard({
  tone,
  icon,
  title,
  description,
  children,
}: {
  tone?: "break";
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card className="sk-state" data-tone={tone}>
      <div className="sk-state-ico">{icon}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      <div className="sk-go">{children}</div>
    </Card>
  );
}

const FIRST_RUN_STEPS = ["Add a connection", "Track a schema", "See the skyline grow"];

/**
 * The dashboard before anything is tracked: an empty plot of land, the three
 * steps to a first building, and the one button for the step you are on.
 */
function FirstRun({
  step,
  title,
  description,
  children,
}: {
  /** Which of the three steps comes next: 1 or 2. */
  step: 1 | 2;
  title: string;
  description: string;
  children: ReactNode;
}) {
  // Nine empty plots. The middle one is dashed: that is where the first
  // building will go.
  const plots = [];
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      const cx = 270 + ((x - y) * CELL_W) / 2;
      const cy = 70 + ((x + y) * CELL_H) / 2;
      plots.push(
        <polygon
          key={`${x}-${y}`}
          className={x === 1 && y === 1 ? "sk-plot-next" : "sk-plot"}
          points={diamond(cx, cy, CELL_W / 2 - 4, CELL_H / 2 - 2)}
        />
      );
    }
  }

  return (
    <Card className="sk-first">
      <div className="sk-first-stage" aria-hidden="true">
        <svg viewBox="0 0 540 270">{plots}</svg>
      </div>
      <div className="sk-first-side">
        <ol className="sk-steps">
          {FIRST_RUN_STEPS.map((name, i) => (
            <li
              key={name}
              data-step={i + 1 < step ? "done" : i + 1 === step ? "on" : undefined}
              aria-current={i + 1 === step ? "step" : undefined}
            >
              {i + 1 < step && <CheckIcon size={12} />} {name}
            </li>
          ))}
        </ol>
        <small>Step {step} of 3</small>
        <h2>{title}</h2>
        <p>{description}</p>
        <div className="sk-go">{children}</div>
      </div>
    </Card>
  );
}

// ── The skyline drawing ──────────────────────────────────────────────────────

/** What the drawing needs to know about one tracked schema. */
type Building = {
  id: number;
  name: string;
  /** Sets the roof colour. "unchecked" is a schema nobody has checked yet. */
  status: DriftStatus | "unchecked";
  /** What the height stands for, or null when the number is not known. */
  value: number | null;
  /** The whole building in words, for a screen reader and the tooltip. */
  label: string;
};

// The size of one plot of land, and how tall the tallest building is drawn.
const CELL_W = 116;
const CELL_H = 58;
const FOOTPRINT = 0.72; // a building covers this much of its plot
const MIN_HEIGHT = 10;
const EXTRA_HEIGHT = 168;

/** The four corners of a diamond around (cx, cy), as an SVG points string. */
function diamond(cx: number, cy: number, halfWidth: number, halfHeight: number): string {
  return [
    `${cx - halfWidth},${cy}`,
    `${cx},${cy - halfHeight}`,
    `${cx + halfWidth},${cy}`,
    `${cx},${cy + halfHeight}`,
  ].join(" ");
}

/**
 * The city: one building per tracked schema, on a square grid seen from above
 * and to the side. A building's height is its value against the largest value
 * on screen, so the tallest building always has the most.
 */
function Skyline({
  buildings,
  selectedId,
  onSelect,
}: {
  buildings: Building[];
  selectedId: number;
  onSelect: (id: number) => void;
}) {
  const columns = Math.ceil(Math.sqrt(buildings.length));
  const largest = Math.max(1, ...buildings.map((b) => b.value ?? 0));
  const halfW = (CELL_W / 2) * FOOTPRINT;
  const halfH = (CELL_H / 2) * FOOTPRINT;

  // Where each building stands and how tall it is.
  const placed = buildings.map((building, i) => {
    const x = i % columns;
    const y = Math.floor(i / columns);
    return {
      building,
      depth: x + y,
      cx: ((x - y) * CELL_W) / 2,
      cy: ((x + y) * CELL_H) / 2,
      height: MIN_HEIGHT + (EXTRA_HEIGHT * (building.value ?? 0)) / largest,
    };
  });
  // Back to front, so a building in front is drawn over the one behind it.
  placed.sort((a, b) => a.depth - b.depth);

  // A frame just big enough for every building and its name.
  const left = Math.min(...placed.map((p) => p.cx)) - CELL_W / 2 - 12;
  const right = Math.max(...placed.map((p) => p.cx)) + CELL_W / 2 + 12;
  const top = Math.min(...placed.map((p) => p.cy - halfH - p.height)) - 30;
  const bottom = Math.max(...placed.map((p) => p.cy)) + CELL_H / 2 + 12;

  return (
    <svg
      viewBox={`${left} ${top} ${right - left} ${bottom - top}`}
      role="group"
      aria-label="Tracked schemas, drawn as buildings"
    >
      {placed.map(({ building, cx, cy }) => (
        <polygon
          key={building.id}
          className="sk-tile"
          points={diamond(cx, cy, CELL_W / 2, CELL_H / 2)}
        />
      ))}
      {placed.map(({ building, cx, cy, height }, i) => {
        const roofY = cy - height;
        return (
          <g
            key={building.id}
            className="sk-b"
            data-s={building.status}
            role="button"
            tabIndex={0}
            aria-pressed={building.id === selectedId}
            aria-label={building.label}
            style={{ animationDelay: `${i * 40}ms` }}
            onClick={() => onSelect(building.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(building.id);
              }
            }}
          >
            <title>{building.label}</title>
            <polygon className="sk-gd" points={diamond(cx, cy, CELL_W / 2, CELL_H / 2)} />
            <polygon
              className="sk-fl"
              points={`${cx - halfW},${cy} ${cx},${cy + halfH} ${cx},${roofY + halfH} ${cx - halfW},${roofY}`}
            />
            <polygon
              className="sk-fr"
              points={`${cx},${cy + halfH} ${cx + halfW},${cy} ${cx + halfW},${roofY} ${cx},${roofY + halfH}`}
            />
            <polygon className="sk-ft" points={diamond(cx, roofY, halfW, halfH)} />
          </g>
        );
      })}
      {/* Names last, so a taller building in front never hides one. */}
      {placed.map(({ building, cx, cy, height }) => (
        <text key={building.id} className="sk-name" x={cx} y={cy - height - halfH - 8}>
          {building.name.length > 16 ? `${building.name.slice(0, 15)}…` : building.name}
        </text>
      ))}
    </svg>
  );
}

/** "12", or why there is no number: still being read, or could not be read. */
function tablesText(count: number | null | undefined): string {
  if (count === undefined) return "Reading…";
  if (count === null) return "Couldn't read";
  return String(count);
}

/**
 * "Checked 3m ago · every 15m" for the picked schema.
 *
 * Two facts, deliberately together. The age on its own reads as the last thing
 * that happened and says nothing about whether anything will happen next; the
 * cadence on its own is a promise with no evidence. Side by side they answer
 * the only question a watched schema raises: is this still being looked at?
 *
 * The age ticks (useNow) because a dashboard is a screen people leave open.
 */
function CheckedLine({
  lastCheckedAt,
  intervalMinutes,
}: {
  lastCheckedAt: string | null;
  intervalMinutes: number;
}) {
  // Subscribing to the clock keeps timeAgo honest on a page nobody is clicking.
  const now = useNow(30_000);
  const cadence = intervalMinutes > 0 ? describeCadence(intervalMinutes) : null;

  if (!lastCheckedAt) {
    return <p>{cadence ? `Not checked yet. Due ${cadence}.` : "Automatic checking is off."}</p>;
  }

  return (
    <p>
      {/* now === null is the pre-hydration frame; showing nothing for it beats
          showing a relative age the browser then has to correct. */}
      {now === null ? " " : `Checked ${timeAgo(lastCheckedAt)}`}
      {cadence ? ` · ${cadence}` : " · manual only"}
    </p>
  );
}

/**
 * The picked building in words: what it is, what the last drift check found,
 * and everything you can do with it.
 */
function Inspector({
  item,
  tables,
  heightBy,
  checking,
  error,
  checkRefusal,
  untrackRefusal,
  onCheckDrift,
  onUntrack,
}: {
  item: TrackedSchema;
  /** Tables in the latest recorded version: undefined until read, null if unreadable. */
  tables: number | null | undefined;
  heightBy: HeightBy;
  checking: boolean;
  error: string | null;
  /** Why this role may not check drift, or null. The page says it once. */
  checkRefusal: string | null;
  /** Why this role may not stop tracking, or null. */
  untrackRefusal: string | null;
  onCheckDrift: () => void;
  onUntrack: () => void;
}) {
  const orgPath = useOrgHref();
  const meta = driftMeta(item.driftStatus);
  const environment = toEnvironment(item.environment);
  const connectionGone = item.connectionName === null;
  // Where the schema lives. Shown under the label rather than replaced by it,
  // because a label says nothing about which database this is.
  const source = item.connectionName
    ? `${item.connectionName} · ${item.connectionDatabase ?? "?"}`
    : "Connection removed";

  return (
    <div className="sk-ins" aria-live="polite">
      <div className="sk-chips">
        <span className="sk-chip" data-s={item.driftStatus ?? "unchecked"}>
          <i aria-hidden="true" />
          {meta.label}
        </span>
        <EnvironmentPill environment={environment} />
        {connectionGone && <span className="sk-chip">no connection</span>}
      </div>

      <h2>{item.schemaName}</h2>
      <p>
        {item.label && (
          <>
            <b>{item.label}</b>
            <br />
          </>
        )}
        <span className="mono">{source}</span>
      </p>

      <dl className="sk-st">
        <div className={heightBy === "versions" ? "sk-on" : undefined}>
          <dt>Versions</dt>
          <dd>{item.migrationCount}</dd>
        </div>
        {heightBy === "tables" && (
          <div className="sk-on">
            <dt>Tables</dt>
            <dd>{tablesText(tables)}</dd>
          </div>
        )}
        {/* "lineage" is spelled out because this number is Schema Studio's own
            counter for the tracked schema, and without the word it reads like
            the script version Deploy shows as "Applied to target". */}
        <div title="Schema Studio's lineage number for this tracked schema. It moves when a deploy or re-baseline changes the structure, and is separate from the script versions in GitHub.">
          <dt>Lineage</dt>
          <dd>{item.headVersion ? displayVersion(item.headVersion, true) : "None yet"}</dd>
        </div>
        {item.headSeq !== null && (
          <div>
            <dt>Latest seq</dt>
            <dd>{String(item.headSeq).padStart(4, "0")}</dd>
          </div>
        )}
      </dl>

      <p>{item.driftSummary ?? "No drift check yet."}</p>
      <CheckedLine
        lastCheckedAt={item.lastCheckedAt ?? item.driftCheckedAt}
        intervalMinutes={item.driftIntervalMinutes ?? 0}
      />

      {error && (
        <p className="sk-err" role="alert">
          {error}
        </p>
      )}

      <div className="sk-acts">
        {/* A drifted schema needs the drift detail (what changed, and the
            ways to resolve it) more than another check, so that is the
            loud button when it has drifted. */}
        {item.driftStatus === "drifted" && (
          <Link
            href={orgPath(`/drift?tab=detail&schema=${item.id}`)}
            className="btn btn-primary btn-sm"
            aria-label={`Review drift on ${item.schemaName}`}
          >
            Review drift
          </Link>
        )}
        <Link
          href={orgPath(`/schemas/${item.id}`)}
          className="btn btn-secondary btn-sm"
          aria-label={`Open ${item.schemaName}`}
        >
          Open
        </Link>
        <Button
          variant="secondary"
          size="sm"
          onClick={onCheckDrift}
          disabled={checking || checkRefusal !== null}
          title={checkRefusal ?? undefined}
        >
          {checking ? (
            "Checking…"
          ) : (
            <>
              <RefreshIcon size={13} /> Check drift
            </>
          )}
        </Button>
        {!connectionGone && (
          <Link
            href={orgPath(
              `/compare?targetConnection=${item.connectionId}&targetSchema=${encodeURIComponent(item.schemaName)}`
            )}
            className="btn btn-ghost btn-sm"
          >
            Compare
          </Link>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm sk-stop"
          aria-label={`Stop tracking ${item.schemaName}`}
          onClick={onUntrack}
          disabled={untrackRefusal !== null}
          title={untrackRefusal ?? undefined}
        >
          <TrashIcon size={14} />
        </button>
      </div>
    </div>
  );
}
