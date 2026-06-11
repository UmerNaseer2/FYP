import { Suspense } from "react";
import Link from "next/link";
import {
  Pill,
  Card,
  EmptyState,
  Skeleton,
  type PillTone,
} from "@/components/ui";
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
import { DriftResolutionBar } from "@/components/studio/DriftResolutionBar";
import { DriftSchemaPicker } from "@/components/studio/DriftSchemaPicker";
import { AuditLogTable, type AuditRow } from "@/components/studio/AuditLogTable";
import {
  listTrackedSchemas,
  getDriftDetail,
  listDriftEvents,
  type DriftStatus,
  type DriftDetailView,
  type DriftCounts,
  type TrackedSchemaListItem,
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
 * Server component (force-dynamic): it reads straight from the crisp lineage
 * backend — getDriftDetail recomputes the live drift, listDriftEvents reads the
 * recorded history. Only the picker, the resolution bar and the audit filters
 * are client islands. No mock data.
 */
export const dynamic = "force-dynamic";

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

export default async function DriftPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; schema?: string }>;
}) {
  const sp = await searchParams;
  const tab: "detail" | "audit" = sp.tab === "audit" ? "audit" : "detail";
  const schema =
    typeof sp.schema === "string" && sp.schema.trim() ? sp.schema.trim() : undefined;

  // The shell (header + tab bar) is SYNCHRONOUS — it renders the instant a tab is
  // clicked. Only the tab content touches the lineage backend (and, for detail, a
  // live drift recompute), behind a Suspense boundary, so switching tabs shows an
  // immediate skeleton instead of freezing on the DB round-trip. The key
  // re-suspends the boundary on every tab/schema change so the skeleton always shows.
  return (
    <Shell tab={tab} schema={schema}>
      <Suspense key={`${tab}:${schema ?? ""}`} fallback={<ContentSkeleton tab={tab} />}>
        {tab === "detail" ? <DetailContent schema={schema} /> : <AuditContent />}
      </Suspense>
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

async function DetailContent({ schema }: { schema: string | undefined }) {
  const tracked = await listTrackedSchemas();
  if (tracked.length === 0) return <NothingTracked />;

  // Worst-drift-first, so the default selection is the schema that needs eyes.
  const byPriority = [...tracked].sort(
    (a, b) => sortPriority(a.driftStatus) - sortPriority(b.driftStatus)
  );
  const requested = schema ? Number(schema) : NaN;
  const selected = tracked.find((t) => t.id === requested) ?? byPriority[0];
  return <DetailTab tracked={byPriority} selectedId={selected.id} />;
}

async function AuditContent() {
  const tracked = await listTrackedSchemas();
  if (tracked.length === 0) return <NothingTracked />;
  return <AuditTab />;
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

async function DetailTab({
  tracked,
  selectedId,
}: {
  tracked: TrackedSchemaListItem[];
  selectedId: number;
}) {
  // Live recompute for the selected schema + its recent recorded history.
  const view = await getDriftDetail(selectedId);
  const history = await listDriftEvents(selectedId, 6);

  if (!view) {
    return (
      <Card className="p-0 overflow-hidden">
        <div style={{ height: 280 }}>
          <EmptyState
            icon={<AlertCircleIcon size={22} />}
            title="Tracked schema not found"
            description="It may have been removed. Pick another schema or head back to the dashboard."
          />
        </div>
      </Card>
    );
  }

  const pickerItems = tracked.map((t) => ({
    id: t.id,
    schemaName: t.schemaName,
    label: t.label,
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
          <DriftSchemaPicker items={pickerItems} selectedId={selectedId} />
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

      {/* Status hero (state-aware) */}
      <DriftHero view={view} compareHref={compareHref} />

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
          <DiffReport report={view.report} />
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
}: {
  view: DriftDetailView;
  compareHref: string | null;
}) {
  const resolution = (
    <DriftResolutionBar
      trackedSchemaId={view.trackedSchemaId}
      state={view.state}
      compareHref={compareHref}
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

async function AuditTab() {
  const events = await listDriftEvents();

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
