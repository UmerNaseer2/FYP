"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Button,
  Pill,
  Card,
  EmptyState,
  Skeleton,
  Drawer,
  ConfirmDialog,
  Label,
  Input,
  EnvironmentPill,
  FilterPill,
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
import {
  DashboardIcon,
  CheckIcon,
  AlertTriangleIcon,
  AlertCircleIcon,
  RefreshIcon,
  PlusIcon,
  TrashIcon,
} from "@/components/ui/icons";

/**
 * Phase 7 — Dashboard / Tracked Schemas.
 *
 * The showpiece. Every tracked schema from the Phase 6 lineage backend shows up
 * here as a card: its lineage HEAD version and its latest drift status. The
 * DRIFTED card is the hero — drifted schemas sort to the front and get a louder
 * treatment. Real data only (GET /api/lineage); no mocks.
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
  // The tracked-schema list (the grid + summary strip read from this).
  const [items, setItems] = useState<TrackedSchema[]>([]);
  const [listPhase, setListPhase] = useState<"loading" | "ready" | "error">("loading");
  const [checkingId, setCheckingId] = useState<number | null>(null);
  const [cardError, setCardError] = useState<{ id: number; msg: string } | null>(null);
  // "all", or one environment. Filtering the grid is how you answer "what is
  // actually in production right now?" without reading every card.
  const [envFilter, setEnvFilter] = useState<"all" | Environment>("all");

  // Track-a-schema drawer.
  const [trackOpen, setTrackOpen] = useState(false);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [connLoaded, setConnLoaded] = useState(false);
  const [connFailed, setConnFailed] = useState(false);
  const [trackConnId, setTrackConnId] = useState("");
  const [schemaOptions, setSchemaOptions] = useState<string[]>([]);
  const [schemaPhase, setSchemaPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [trackSchema, setTrackSchema] = useState("");
  const [trackLabel, setTrackLabel] = useState("");
  // Seeded from the chosen connection, then editable: one server can host a
  // staging schema and a production one.
  const [trackEnv, setTrackEnv] = useState<Environment>(DEFAULT_ENVIRONMENT);
  const [trackEnvTouched, setTrackEnvTouched] = useState(false);
  const [trackSubmitting, setTrackSubmitting] = useState(false);
  const [trackError, setTrackError] = useState<string | null>(null);

  // Untrack confirm.
  const [untrackTarget, setUntrackTarget] = useState<TrackedSchema | null>(null);
  const [untracking, setUntracking] = useState(false);

  // ── Load the list ──────────────────────────────────────────────────────────
  const loadList = useCallback(async () => {
    setListPhase("loading");
    try {
      const res = await fetch("/api/lineage", { cache: "no-store" });
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

  async function openTrack() {
    resetTrackForm();
    setTrackOpen(true);
    // Pull the connection list fresh each time the drawer opens.
    try {
      const res = await fetch("/api/connections", { cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      if (!Array.isArray(data)) {
        setConnections([]);
        setConnFailed(true);
        return;
      }
      setConnections(data.filter((c: ConnectionRow) => c.type === "PostgreSQL"));
      setConnFailed(false);
    } catch {
      setConnections([]);
      setConnFailed(true);
    } finally {
      setConnLoaded(true);
    }
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
    if (!id) {
      setSchemaPhase("idle");
      return;
    }
    setSchemaPhase("loading");
    try {
      const res = await fetch(`/api/lineage/schemas?connectionId=${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) {
        setSchemaError(data.error ?? "Could not list schemas for this connection.");
        setSchemaPhase("error");
        return;
      }
      setSchemaOptions(Array.isArray(data.schemas) ? data.schemas : []);
      setSchemaPhase("ready");
    } catch {
      setSchemaError("Network error while listing schemas.");
      setSchemaPhase("error");
    }
  }

  async function submitTrack() {
    if (!trackConnId || !trackSchema) return;
    setTrackSubmitting(true);
    setTrackError(null);
    try {
      const res = await fetch("/api/lineage/track", {
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

  // ── Per-card actions ───────────────────────────────────────────────────────
  async function checkDrift(item: TrackedSchema) {
    setCheckingId(item.id);
    setCardError(null);
    try {
      const res = await fetch("/api/lineage/drift", {
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
    if (!untrackTarget) return;
    setUntracking(true);
    try {
      await fetch("/api/lineage", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: untrackTarget.id }),
      });
      setUntrackTarget(null);
      await loadList();
    } catch {
      // Keep the dialog open on a hard failure so the user can retry.
    } finally {
      setUntracking(false);
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

  const trackButton = (
    <Button variant="primary" onClick={openTrack}>
      <PlusIcon size={14} /> Track a schema
    </Button>
  );

  return (
    <div className="max-w-[1100px] mx-auto px-4 sm:px-8 py-8 sm:py-10 space-y-8">
      {/* Header */}
      <header className="flex items-end justify-between gap-6 flex-wrap">
        <div>
          <div className="section-title">Dashboard</div>
          <h1 className="text-[28px] font-semibold tracking-[-0.02em] mt-1">Tracked schemas</h1>
          <p className="text-[13.5px] mt-1.5 max-w-[56ch]" style={{ color: "var(--text-2)" }}>
            Every schema under version control, with its lineage version and the latest drift check.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => void loadList()}
            disabled={listPhase === "loading"}
            aria-label="Refresh"
          >
            <RefreshIcon size={14} /> Refresh
          </Button>
          {trackButton}
        </div>
      </header>

      {/* Summary strip — only meaningful once we have data. Every tile counts
          what is on screen, so the strip and the grid can never disagree. */}
      {listPhase === "ready" && total > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <SummaryTile label="Tracked" value={visible.length} />
          <SummaryTile
            label="Production"
            value={prodShown}
            tone={prodShown > 0 ? "break" : undefined}
          />
          <SummaryTile label="Drifted" value={drifted} tone={drifted > 0 ? "drift" : undefined} />
          <SummaryTile label="In sync" value={inSync} tone={inSync > 0 ? "sync" : undefined} />
          <SummaryTile
            label="Unreachable"
            value={unreachable}
            tone={unreachable > 0 ? "break" : undefined}
          />
          <SummaryTile label="Not checked" value={notChecked} />
        </div>
      )}

      {/* Environment filter — the reason the label is typed rather than a word
          somebody wrote inside a name. Counts are over everything tracked, so
          they stay put while you move between filters. */}
      {listPhase === "ready" && total > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <FilterPill
            active={envFilter === "all"}
            onClick={() => setEnvFilter("all")}
            count={total}
          >
            All
          </FilterPill>
          <span className="hsep mx-1" />
          {ENVIRONMENTS.map((environment) => (
            <FilterPill
              key={environment}
              active={envFilter === environment}
              onClick={() => setEnvFilter(environment)}
              count={envCount(environment)}
            >
              {ENVIRONMENT_META[environment].label}
            </FilterPill>
          ))}
        </div>
      )}

      {/* Only while something is genuinely unlabelled — that is the state in
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
            Label them so Compare and Deploy can tell you when a target is production.
          </div>
        </div>
      )}

      {/* Body */}
      {listPhase === "loading" && <LoadingGrid />}

      {listPhase === "error" && (
        <Card className="p-0 overflow-hidden">
          <div style={{ height: 260 }}>
            <EmptyState
              icon={<AlertCircleIcon size={22} />}
              title="Couldn't load tracked schemas"
              description="The app database may be unreachable. Try again in a moment."
              actions={
                <Button variant="secondary" size="sm" onClick={() => void loadList()}>
                  <RefreshIcon size={14} /> Retry
                </Button>
              }
            />
          </div>
        </Card>
      )}

      {listPhase === "ready" && total === 0 && (
        <Card className="p-0 overflow-hidden">
          <div style={{ height: 320 }}>
            <EmptyState
              icon={<DashboardIcon size={22} />}
              title="Nothing tracked yet"
              description="Track a schema to capture a baseline and watch it for drift against its lineage."
              actions={trackButton}
            />
          </div>
        </Card>
      )}

      {listPhase === "ready" && total > 0 && sorted.length === 0 && (
        <Card className="p-0 overflow-hidden">
          <div style={{ height: 220 }}>
            <EmptyState
              icon={<DashboardIcon size={22} />}
              title={`Nothing tracked in ${ENVIRONMENT_META[envFilter as Environment].label}`}
              description="Every tracked schema is in another environment."
              actions={
                <Button variant="secondary" size="sm" onClick={() => setEnvFilter("all")}>
                  Show all environments
                </Button>
              }
            />
          </div>
        </Card>
      )}

      {listPhase === "ready" && sorted.length > 0 && (
        <div className="grid md:grid-cols-3 gap-5">
          {sorted.map((item) => (
            <SchemaCard
              key={item.id}
              item={item}
              checking={checkingId === item.id}
              error={cardError?.id === item.id ? cardError.msg : null}
              onCheckDrift={() => void checkDrift(item)}
              onUntrack={() => setUntrackTarget(item)}
            />
          ))}
        </div>
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
          Pick a saved connection and one of its schemas. We capture a baseline snapshot now and
          record it as lineage <span className="mono">v1.0.0</span>.
        </p>

        <div>
          <Label className="mb-1 block">Connection</Label>
          <Select
            variant="input"
            ariaLabel="Connection"
            value={trackConnId}
            placeholder="Select a connection…"
            options={connections.map((c) => ({
              value: String(c.id),
              label: `${c.name} — ${c.host}/${c.database_name}`,
            }))}
            onChange={(value) => void onPickConnection(value)}
          />
          {connLoaded && connections.length === 0 && (
            <p className="help mt-1">
              {connFailed
                ? "Could not read your saved connections. Reload the page to try again."
                : "No PostgreSQL connections saved yet. Add one on the Connections page first."}
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
          <Label className="mb-1 block">Label (optional)</Label>
          <Input
            placeholder="e.g. Billing service"
            value={trackLabel}
            onChange={(e) => setTrackLabel(e.target.value)}
          />
          <p className="help mt-1">
            A human name for this schema. The environment above is the typed
            field — don&apos;t write &quot;prod&quot; in here and expect a warning.
          </p>
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
        confirmLabel={untracking ? "Removing…" : "Stop tracking"}
      />
    </div>
  );
}

// ── Presentational pieces ────────────────────────────────────────────────────

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "drift" | "sync" | "break";
}) {
  const color =
    tone === "drift"
      ? "var(--drift)"
      : tone === "sync"
        ? "var(--sync)"
        : tone === "break"
          ? "var(--break)"
          : "var(--text)";
  return (
    <Card className="p-4">
      <div className="text-[11px] uppercase tracking-wide" style={{ color: "var(--text-3)" }}>
        {label}
      </div>
      <div className="mono text-[26px] font-semibold mt-1" style={{ color }}>
        {value}
      </div>
    </Card>
  );
}

function LoadingGrid() {
  return (
    <div className="grid md:grid-cols-3 gap-5">
      {[0, 1, 2].map((i) => (
        <Card key={i} className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <Skeleton width={92} height={20} />
            <Skeleton width={54} height={20} />
          </div>
          <div className="space-y-2">
            <Skeleton width="55%" height={18} />
            <Skeleton width="70%" height={12} />
          </div>
          <Skeleton width="40%" height={16} />
          <div className="flex gap-2 pt-1">
            <Skeleton width={96} height={30} />
            <Skeleton width={72} height={30} />
          </div>
        </Card>
      ))}
    </div>
  );
}

function SchemaCard({
  item,
  checking,
  error,
  onCheckDrift,
  onUntrack,
}: {
  item: TrackedSchema;
  checking: boolean;
  error: string | null;
  onCheckDrift: () => void;
  onUntrack: () => void;
}) {
  const meta = driftMeta(item.driftStatus);
  const environment = toEnvironment(item.environment);
  const connectionGone = item.connectionName === null;
  const source =
    item.label ??
    (item.connectionName
      ? `${item.connectionName} — ${item.connectionDatabase ?? "?"}`
      : "Connection removed");

  // The drifted card is the hero: louder border + a subtle top-tint gradient.
  const heroStyle = meta.hero
    ? {
        borderColor: "color-mix(in oklab, var(--drift) 60%, var(--border))",
        background:
          "linear-gradient(180deg, color-mix(in oklab, var(--drift) 8%, var(--surface)) 0%, var(--surface) 60%)",
      }
    : undefined;

  return (
    <Card className="p-5 relative overflow-hidden flex flex-col" style={heroStyle}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Pill tone={meta.tone}>
            {meta.hero && <AlertTriangleIcon size={11} />}
            {meta.label}
          </Pill>
          <EnvironmentPill environment={environment} />
        </div>
        {connectionGone ? (
          <Pill tone="neutral">no connection</Pill>
        ) : (
          <Pill tone="neutral" dot={false}>
            {item.migrationCount} in lineage
          </Pill>
        )}
      </div>

      <div className="mt-1">
        <div className="mono text-[18px] font-semibold tracking-tight">{item.schemaName}</div>
        <div className="mono text-[12px]" style={{ color: "var(--text-3)" }}>
          {source}
        </div>
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <span className="mono text-[18px] font-semibold">{item.headVersion ?? "—"}</span>
        {item.headSeq !== null && (
          <span className="mono text-[12px]" style={{ color: "var(--text-3)" }}>
            · {String(item.headSeq).padStart(4, "0")} head
          </span>
        )}
      </div>

      {/* Drift detail line */}
      <div className="mt-3 text-[12px] min-h-[16px]" style={{ color: "var(--text-2)" }}>
        {item.driftSummary ? (
          <span className="inline-flex items-center gap-1.5">
            {item.driftStatus === "in_sync" && (
              <CheckIcon size={12} style={{ color: "var(--sync)" }} />
            )}
            {item.driftStatus === "drifted" && (
              <AlertTriangleIcon size={12} style={{ color: "var(--drift)" }} />
            )}
            {item.driftStatus === "unreachable" && (
              <AlertCircleIcon size={12} style={{ color: "var(--break)" }} />
            )}
            <span>{item.driftSummary}</span>
          </span>
        ) : (
          <span style={{ color: "var(--text-3)" }}>No drift check yet.</span>
        )}
      </div>
      {item.driftCheckedAt && (
        <div className="text-[11px] mt-0.5" style={{ color: "var(--text-3)" }}>
          Checked {timeAgo(item.driftCheckedAt)}
        </div>
      )}

      {error && (
        <div className="text-[11.5px] mt-2" style={{ color: "var(--break)" }}>
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 pt-4 flex items-center gap-2 flex-wrap" style={{ borderTop: "1px solid var(--border)" }}>
        <Link href={`/schemas/${item.id}`} className="btn btn-secondary btn-sm">
          Open
        </Link>
        <Button
          variant={meta.hero ? "primary" : "secondary"}
          size="sm"
          onClick={onCheckDrift}
          disabled={checking}
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
            href={`/compare?rightConnection=${item.connectionId}&rightSchema=${encodeURIComponent(item.schemaName)}`}
            className="btn btn-ghost btn-sm"
          >
            Compare
          </Link>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm ml-auto"
          aria-label="Stop tracking"
          onClick={onUntrack}
        >
          <TrashIcon size={14} />
        </button>
      </div>
    </Card>
  );
}
