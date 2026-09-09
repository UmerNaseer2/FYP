"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Pill,
  Card,
  EmptyState,
  EnvironmentPill,
  Skeleton,
  type PillTone,
} from "@/components/ui";
import { isProduction } from "@/lib/environments";
import {
  DriftIcon,
  AlertTriangleIcon,
  AlertCircleIcon,
  CheckIcon,
  InfoIcon,
  CompareIcon,
  DashboardIcon,
} from "@/components/ui/icons";
import { DiffReport, tallyDelta } from "@/components/studio/DiffReport";
import { SummaryMatrix } from "@/components/studio/SummaryMatrix";
import { DriftResolutionBar } from "@/components/studio/DriftResolutionBar";
import { DriftSchemaPicker } from "@/components/studio/DriftSchemaPicker";
import { AuditLogTable, type AuditRow } from "@/components/studio/AuditLogTable";
// Types only. `import type` is erased at compile time, so importing the shape
// of a row does not pull the database module into the client bundle.
import type {
  DriftStatus,
  DriftDetailView,
  DriftCounts,
  DriftEventFeedItem,
  TrackedSchemaListItem,
} from "@/lib/lineage-db";

/**
 * Phase 9 — Drift & Audit.
 *
 * The drift loop closed in two tabs:
 *   • Detail (S6) — pick a tracked schema, see its live Expected-vs-Actual diff
 *     recomputed now (never stale), with the same <DiffReport> /compare uses, and
 *     resolution actions (author a migration · re-baseline · acknowledge · re-check).
 *   • Audit (S7)  — the dense, filterable history of every recorded drift check.
 *
 * Client component: everything comes through the API layer —
 * GET /api/lineage for the tracked list, GET /api/lineage/drift for the live
 * recompute, GET /api/lineage/audit for the recorded history. The screen holds
 * its own data, so the resolution bar reloads it directly after a write rather
 * than asking the server to re-render. No mock data.
 */

// ── Small pure formatters (server-safe, no Date.now → no hydration risk) ─────

/** Stable absolute timestamp, e.g. "2026-06-09 14:21 UTC". */
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** Drifted first, then unreachable, then never-checked, then in-sync. */
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

/** How each recorded drift status reads as a pill. */
function statusPill(status: DriftStatus): { tone: PillTone; label: string } {
  switch (status) {
    case "drifted":
      return { tone: "drift", label: "Drifted" };
    case "in_sync":
      return { tone: "sync", label: "In sync" };
    case "unreachable":
      return { tone: "break", label: "Unreachable" };
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DriftPage() {
  // useSearchParams has to sit under a Suspense boundary: while the page is
  // pre-rendered there is no URL to read, so React puts this fallback in the
  // static HTML and the real screen takes over as soon as it reaches a browser.
  return (
    <Suspense
      fallback={
        <Shell tab="detail" schema={undefined}>
          <ContentSkeleton tab="detail" />
        </Shell>
      }
    >
      <DriftScreen />
    </Suspense>
  );
}

function DriftScreen() {
  const sp = useSearchParams();
  const tab: "detail" | "audit" = sp.get("tab") === "audit" ? "audit" : "detail";
  const raw = sp.get("schema");
  const schema = raw && raw.trim() ? raw.trim() : undefined;

  // The shell (header + tab bar) renders the instant a tab is clicked; only the
  // tab content waits on the API, and it shows the skeleton while it does. The
  // key remounts the content on every tab/schema change so the skeleton always
  // shows rather than the previous schema's numbers sitting there looking live.
  return (
    <Shell tab={tab} schema={schema}>
      {tab === "detail" ? (
        <DetailContent key={schema ?? ""} schema={schema} />
      ) : (
        <AuditContent />
      )}
    </Shell>
  );
}

// ── Shared shell: header + tab bar (synchronous) ─────────────────────────────

function Shell({
  tab,
  schema,
  children,
}: {
  tab: "detail" | "audit";
  schema: string | undefined;
  children: React.ReactNode;
}) {
  // Carry the selected schema across tab switches so toggling detail↔audit
  // doesn't lose the schema you were looking at.
  const q = schema ? `&schema=${encodeURIComponent(schema)}` : "";
  return (
    <div className="max-w-[1100px] mx-auto px-4 sm:px-8 py-8 sm:py-10 space-y-7">
      <header>
        <div className="flex items-center gap-2">
          <span style={{ color: "var(--text-3)" }}>
            <DriftIcon size={16} />
          </span>
          <div className="section-title">Drift &amp; Audit</div>
        </div>
        <h1 className="text-[28px] font-semibold tracking-[-0.02em] mt-1">
          {tab === "detail" ? "Drift detail" : "Audit log"}
        </h1>
        <p className="text-[13.5px] mt-1.5 max-w-[64ch]" style={{ color: "var(--text-2)" }}>
          {tab === "detail"
            ? "Compare a tracked schema's live structure against its expected lineage snapshot, and resolve any drift."
            : "Every recorded drift check, newest first — filterable by status and searchable by schema, connection or summary."}
        </p>
      </header>

      {/* Tabs */}
      <div className="flex items-center gap-1" style={{ borderBottom: "1px solid var(--border)" }}>
        <Tab href={`/drift?tab=detail${q}`} active={tab === "detail"}>
          Drift detail
        </Tab>
        <Tab href={`/drift?tab=audit${q}`} active={tab === "audit"}>
          Audit log
        </Tab>
      </div>

      {children}
    </div>
  );
}

// ── Async tab content (Suspense-wrapped — only this hits the backend) ─────────

/**
 * The tracked list, which both tabs need before they can show anything: the
 * detail tab picks a schema out of it, the audit tab only uses it to tell
 * "nothing tracked yet" apart from "nothing has drifted yet".
 *
 * Returns null while it is still loading so a caller can show its skeleton.
 */
function useTrackedSchemas(): {
  tracked: TrackedSchemaListItem[] | null;
  failed: boolean;
} {
  const [tracked, setTracked] = useState<TrackedSchemaListItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/lineage");
        const data = res.ok ? await res.json() : null;
        if (cancelled) return;
        setTracked(Array.isArray(data) ? data : []);
        setFailed(!Array.isArray(data));
      } catch {
        if (cancelled) return;
        setTracked([]);
        setFailed(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { tracked, failed };
}

function DetailContent({ schema }: { schema: string | undefined }) {
  const { tracked, failed } = useTrackedSchemas();

  if (tracked === null) return <ContentSkeleton tab="detail" />;
  if (failed) return <ListUnreadable />;
  if (tracked.length === 0) return <NothingTracked />;

  // Worst-drift-first, so the default selection is the schema that needs eyes.
  const byPriority = [...tracked].sort(
    (a, b) => sortPriority(a.driftStatus) - sortPriority(b.driftStatus)
  );
  const requested = schema ? Number(schema) : NaN;
  const selected = tracked.find((t) => t.id === requested) ?? byPriority[0];
  return <DetailTab tracked={byPriority} selectedId={selected.id} />;
}

function AuditContent() {
  const { tracked, failed } = useTrackedSchemas();

  if (tracked === null) return <ContentSkeleton tab="audit" />;
  if (failed) return <ListUnreadable />;
  if (tracked.length === 0) return <NothingTracked />;
  return <AuditTab />;
}

/** The tracked list itself could not be read — say so instead of "nothing". */
function ListUnreadable() {
  return (
    <Card className="p-0 overflow-hidden">
      <div style={{ height: 280 }}>
        <EmptyState
          icon={<AlertCircleIcon size={22} />}
          title="Could not load your tracked schemas"
          description="The list could not be read just now. Reload the page to try again."
        />
      </div>
    </Card>
  );
}

function NothingTracked() {
  return (
    <Card className="p-0 overflow-hidden">
      <div style={{ height: 320 }}>
        <EmptyState
          icon={<DashboardIcon size={22} />}
          title="Nothing tracked yet"
          description="Drift compares a live schema against its lineage baseline. Track a schema on the dashboard to start watching it for drift."
          actions={
            <Link href="/studio" className="btn btn-primary btn-sm">
              <DashboardIcon size={14} /> Go to dashboard
            </Link>
          }
        />
      </div>
    </Card>
  );
}

// ── Content skeleton (shown while a tab's data loads) ────────────────────────

function ContentSkeleton({ tab }: { tab: "detail" | "audit" }) {
  if (tab === "audit") {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} className="p-4 space-y-2">
              <Skeleton width="60%" height={11} />
              <Skeleton width={40} height={26} />
            </Card>
          ))}
        </div>
        <Card className="p-5 space-y-4">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center justify-between">
              <Skeleton width={`${28 + (i % 3) * 14}%`} height={14} />
              <Skeleton width={88} height={20} radius={999} />
            </div>
          ))}
        </Card>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="space-y-1.5">
          <Skeleton width={110} height={11} />
          <Skeleton width={300} height={38} radius={8} />
        </div>
        <Skeleton width={220} height={28} />
      </div>
      <Skeleton width="100%" height={96} radius={14} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="p-4 space-y-2">
            <Skeleton width="70%" height={11} />
            <Skeleton width={40} height={26} />
          </Card>
        ))}
      </div>
      <Card className="p-5 space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center justify-between">
            <Skeleton width={`${40 + i * 8}%`} height={14} />
            <Skeleton width={60} height={18} radius={999} />
          </div>
        ))}
      </Card>
    </div>
  );
}

function Tab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="text-[13.5px] px-3.5 py-2.5 -mb-px font-medium transition-colors"
      style={{
        borderBottom: active ? "2px solid var(--brand)" : "2px solid transparent",
        color: active ? "var(--text)" : "var(--text-3)",
      }}
    >
      {children}
    </Link>
  );
}

// ── Detail tab ───────────────────────────────────────────────────────────────

function DetailTab({
  tracked,
  selectedId,
}: {
  tracked: TrackedSchemaListItem[];
  selectedId: number;
}) {
  const [view, setView] = useState<DriftDetailView | null>(null);
  const [history, setHistory] = useState<DriftEventFeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The live recompute for the selected schema, plus its recent recorded
  // history. The resolution bar calls this again after every write, because
  // this screen holds its own data — refreshing the router would show nothing.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [detailRes, historyRes] = await Promise.all([
        fetch("/api/lineage/drift?trackedSchemaId=" + selectedId),
        fetch("/api/lineage/audit?trackedSchemaId=" + selectedId + "&limit=6"),
      ]);
      const detail = await detailRes.json().catch(() => null);
      const events = await historyRes.json().catch(() => null);

      if (detailRes.ok && detail) {
        setView(detail as DriftDetailView);
        setError(null);
      } else {
        setView(null);
        // A 404 is "not tracked any more", which the empty state below already
        // explains. Anything else is a real failure worth naming.
        setError(
          detailRes.status === 404
            ? null
            : detail?.error ?? "Could not read this schema's drift."
        );
      }
      setHistory(Array.isArray(events) ? events : []);
    } catch {
      setView(null);
      setError("Network error while reading this schema's drift.");
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Only the first load blanks the screen. A re-check keeps the current diff on
  // screen until the new one lands, so the page doesn't flash back to skeleton
  // every time someone presses a button.
  if (loading && !view) return <ContentSkeleton tab="detail" />;

  if (!view) {
    return (
      <Card className="p-0 overflow-hidden">
        <div style={{ height: 280 }}>
          <EmptyState
            icon={<AlertCircleIcon size={22} />}
            title={error ? "Could not read this schema's drift" : "Tracked schema not found"}
            description={
              error ??
              "It may have been removed. Pick another schema or head back to the dashboard."
            }
            actions={
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
                Try again
              </button>
            }
          />
        </div>
      </Card>
    );
  }

  const pickerItems = tracked.map((t) => ({
    id: t.id,
    schemaName: t.schemaName,
    label: t.label,
    environment: t.environment,
    connectionName: t.connectionName,
    driftStatus: t.driftStatus,
  }));

  const compareHref = view.connection
    ? `/compare?rightConnection=${view.connection.id}&rightSchema=${encodeURIComponent(view.schemaName)}`
    : null;

  return (
    <div className="space-y-6">
      {/* Selector row */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="section-title mb-1.5">Tracked schema</div>
          <div className="flex items-center gap-2 flex-wrap">
            <DriftSchemaPicker items={pickerItems} selectedId={selectedId} />
            <EnvironmentPill environment={view.environment} />
          </div>
        </div>
        <div className="text-[12px] text-right" style={{ color: "var(--text-3)" }}>
          {view.connection ? (
            <span className="mono">
              {view.connection.host}:{view.connection.port}/{view.connection.database}
            </span>
          ) : (
            <span>Connection removed</span>
          )}
          <div className="mt-0.5">
            {view.lastRecorded
              ? `Last recorded check · ${fmtDate(view.lastRecorded.detectedAt)}`
              : "No check recorded yet"}
          </div>
        </div>
      </div>

      {/* Production is worth saying out loud whatever the drift state is: the
          resolution actions below can rewrite this schema's baseline. */}
      {isProduction(view.environment) && (
        <div className="warn-inline">
          <span className="ico" style={{ color: "var(--break)" }}>
            <AlertTriangleIcon size={14} />
          </span>
          <div className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
            <b>This is a production schema.</b> Re-baselining accepts the live structure as
            correct — on production that means whatever changed outside this app becomes the
            new expected state.
          </div>
        </div>
      )}

      {/* Status hero (state-aware) */}
      <DriftHero view={view} compareHref={compareHref} onResolved={() => void load()} />

      {/* Delta counts — only when we actually computed a comparison */}
      {view.counts && <CountTiles counts={view.counts} report={view.report} />}

      {/* Expected ↔ Actual */}
      <section>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div>
            <div className="section-title mb-1">Expected ↔ Actual</div>
            <h2 className="text-[16px] font-semibold tracking-[-0.005em]">
              {view.expected.version
                ? `Lineage v${view.expected.version} vs the live database`
                : "Expected snapshot vs the live database"}
            </h2>
          </div>
          {compareHref && (
            <Link href={compareHref} className="btn btn-secondary btn-sm">
              <CompareIcon size={13} /> Open in Compare
            </Link>
          )}
        </div>

        {view.report ? (
          <div className="space-y-3">
            {/* A stored snapshot can predate a whole object category, and the
                matrix is the only place that says so out loud — which matters
                more here than on /compare, where both sides are live. */}
            <SummaryMatrix report={view.report} />
            <DiffReport report={view.report} />
          </div>
        ) : (
          <div className="panel p-5 flex items-start gap-3">
            <span style={{ color: "var(--text-3)", marginTop: 1, flex: "none" }}>
              <InfoIcon size={16} />
            </span>
            <div>
              <div className="text-[14px] font-medium">No diff to show</div>
              <div className="help mt-0.5">{view.summary}</div>
            </div>
          </div>
        )}
      </section>

      {/* Recent recorded checks for this schema */}
      {history.length > 0 && (
        <section>
          <div className="section-title mb-2">Recent checks for this schema</div>
          <div className="panel p-0 overflow-hidden">
            {history.map((ev, i) => {
              const pill = statusPill(ev.status);
              return (
                <div
                  key={ev.id}
                  className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]"
                  style={{ borderTop: i === 0 ? "none" : "1px solid var(--border)" }}
                >
                  <Pill tone={pill.tone}>{pill.label}</Pill>
                  <span className="flex-1 min-w-0 truncate" style={{ color: "var(--text-2)" }}>
                    {ev.summary ?? "—"}
                  </span>
                  {ev.acknowledgedAt && (
                    <span
                      className="inline-flex items-center gap-1 text-[11px]"
                      style={{ color: "var(--text-3)" }}
                    >
                      <CheckIcon size={11} /> ack&apos;d
                    </span>
                  )}
                  <span
                    className="mono text-[11px] whitespace-nowrap"
                    style={{ color: "var(--text-3)" }}
                  >
                    {fmtDate(ev.detectedAt)}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

// ── Status hero ──────────────────────────────────────────────────────────────

function DriftHero({
  view,
  compareHref,
  onResolved,
}: {
  view: DriftDetailView;
  compareHref: string | null;
  onResolved: () => void;
}) {
  const resolution = (
    <DriftResolutionBar
      trackedSchemaId={view.trackedSchemaId}
      state={view.state}
      compareHref={compareHref}
      onDone={onResolved}
    />
  );

  // Drifted — the loud amber hero.
  if (view.state === "drifted") {
    const t = view.report ? tallyDelta(view.report) : null;
    return (
      <div
        className="relative overflow-hidden p-5"
        style={{
          borderRadius: 14,
          border: "1px solid color-mix(in oklab, var(--drift) 40%, var(--border))",
          background:
            "linear-gradient(180deg, color-mix(in oklab, var(--drift) 10%, var(--surface)), color-mix(in oklab, var(--drift) 4%, var(--surface)))",
        }}
      >
        <div className="flex items-start gap-3">
          <span
            className="w-9 h-9 rounded-full grid place-items-center flex-none"
            style={{ background: "var(--drift)", color: "#fff" }}
          >
            <AlertTriangleIcon size={16} />
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-[15px] font-semibold tracking-[-0.005em]">
              The live schema has drifted from{" "}
              {view.expected.version ? (
                <span className="mono">v{view.expected.version}</span>
              ) : (
                "its expected snapshot"
              )}
              .
            </h3>
            <p className="text-[13px] mt-1" style={{ color: "var(--text-2)" }}>
              {t
                ? `${t.total} difference${t.total === 1 ? "" : "s"} across ${t.tablesTouched} table${t.tablesTouched === 1 ? "" : "s"} — review the diff below and choose how to resolve it.`
                : view.summary}
            </p>
            <div className="mt-3">{resolution}</div>
          </div>
        </div>
      </div>
    );
  }

  // In sync — calm green note.
  if (view.state === "in_sync") {
    return (
      <HeroBanner
        accent="var(--sync)"
        icon={<CheckIcon size={16} />}
        title={
          view.expected.version
            ? `Live schema matches v${view.expected.version}.`
            : "Live schema matches its expected snapshot."
        }
        body={view.summary}
      >
        {resolution}
      </HeroBanner>
    );
  }

  // Unreachable — red note (often a removed connection).
  if (view.state === "unreachable") {
    return (
      <HeroBanner
        accent="var(--break)"
        icon={<AlertCircleIcon size={16} />}
        title="This schema's database is unreachable."
        body={view.summary}
      >
        {resolution}
      </HeroBanner>
    );
  }

  // No baseline — neutral note.
  return (
    <HeroBanner
      accent="var(--text-3)"
      icon={<InfoIcon size={16} />}
      title="No baseline snapshot to compare against."
      body={view.summary}
    >
      {resolution}
    </HeroBanner>
  );
}

/** Compact banner for the calmer (non-drifted) hero states. */
function HeroBanner({
  accent,
  icon,
  title,
  body,
  children,
}: {
  accent: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="p-5"
      style={{
        borderRadius: 14,
        border: `1px solid color-mix(in oklab, ${accent} 30%, var(--border))`,
        background: `color-mix(in oklab, ${accent} 5%, var(--surface))`,
      }}
    >
      <div className="flex items-start gap-3">
        <span
          className="w-9 h-9 rounded-full grid place-items-center flex-none"
          style={{ background: accent, color: "#fff" }}
        >
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="text-[14.5px] font-semibold tracking-[-0.005em]">{title}</h3>
          <p className="text-[13px] mt-1" style={{ color: "var(--text-2)" }}>
            {body}
          </p>
          <div className="mt-3">{children}</div>
        </div>
      </div>
    </div>
  );
}

// ── Delta count tiles ────────────────────────────────────────────────────────

function CountTiles({
  counts,
  report,
}: {
  counts: DriftCounts;
  report: DriftDetailView["report"];
}) {
  const t = report ? tallyDelta(report) : null;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <CountTile label="Tables added" value={counts.tablesAdded} accent="var(--sync)" />
      <CountTile label="Tables removed" value={counts.tablesRemoved} accent="var(--break)" />
      <CountTile label="Tables changed" value={counts.tablesChanged} accent="var(--drift)" />
      <CountTile
        label="Constraints changed"
        value={counts.constraintsChanged}
        accent="var(--drift)"
        note={t ? `${t.total} total diffs` : undefined}
      />
    </div>
  );
}

function CountTile({
  label,
  value,
  accent,
  note,
}: {
  label: string;
  value: number;
  accent: string;
  note?: string;
}) {
  return (
    <Card className="p-4">
      <div className="text-[11px] uppercase tracking-wide" style={{ color: "var(--text-3)" }}>
        {label}
      </div>
      <div
        className="mono text-[26px] font-semibold mt-1"
        style={{ color: value > 0 ? accent : "var(--text-3)" }}
      >
        {value}
      </div>
      {note && (
        <div className="text-[11px] mt-0.5" style={{ color: "var(--text-3)" }}>
          {note}
        </div>
      )}
    </Card>
  );
}

// ── Audit tab ────────────────────────────────────────────────────────────────

function AuditTab() {
  const [events, setEvents] = useState<DriftEventFeedItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/lineage/audit");
        const data = res.ok ? await res.json() : null;
        if (!cancelled) setEvents(Array.isArray(data) ? data : []);
      } catch {
        // The route already answers with an empty feed rather than an error, so
        // reaching here means the network failed. An empty table reads the same
        // as "no checks recorded", which is the honest thing to show.
        if (!cancelled) setEvents([]);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (events === null) return <ContentSkeleton tab="audit" />;

  const total = events.length;
  const drifted = events.filter((e) => e.status === "drifted").length;
  const inSync = events.filter((e) => e.status === "in_sync").length;
  const acknowledged = events.filter((e) => e.acknowledgedAt !== null).length;

  const rows: AuditRow[] = events.map((e) => ({
    id: e.id,
    trackedSchemaId: e.trackedSchemaId,
    schemaName: e.schemaName,
    connectionName: e.connectionName,
    status: e.status,
    summary: e.summary,
    detectedAt: e.detectedAt,
    acknowledgedAt: e.acknowledgedAt,
  }));

  return (
    <div className="space-y-6">
      {/* Stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Recorded checks" value={total} />
        <StatTile label="Drifted" value={drifted} tone="drift" />
        <StatTile label="In sync" value={inSync} tone="sync" />
        <StatTile label="Acknowledged" value={acknowledged} />
      </div>

      <AuditLogTable rows={rows} />
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "drift" | "sync" | "break";
}) {
  const color =
    tone === "drift" && value > 0
      ? "var(--drift)"
      : tone === "sync" && value > 0
        ? "var(--sync)"
        : tone === "break" && value > 0
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
