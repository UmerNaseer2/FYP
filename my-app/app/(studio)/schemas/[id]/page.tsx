import Link from "next/link";
import {
  Pill,
  Card,
  EmptyState,
  Timeline,
  TimelineNode,
  type PillTone,
} from "@/components/ui";
import {
  ChevronLeftIcon,
  CheckIcon,
  AlertTriangleIcon,
  AlertCircleIcon,
  CompareIcon,
  InfoIcon,
} from "@/components/ui/icons";
import { RecheckDriftButton } from "@/components/studio/RecheckDriftButton";
import {
  getLineageDetail,
  type LineageNode,
  type DriftStatus,
} from "@/lib/lineage-db";
import type { ChangeLevel } from "@/lib/version-detection";

// Reads live lineage/drift from the metadata DB on every request — never
// pre-render or cache it at build time (and don't try to reach the DB then).
export const dynamic = "force-dynamic";

/**
 * Phase 8 — Schema detail / Lineage timeline.
 *
 * Opened from a dashboard card. Shows one tracked schema's lineage as a vertical
 * timeline (newest at top), each node with the snapshot it produced and an
 * honest treatment of its SQL (a script reference when we have one, otherwise a
 * plain note — we store snapshots and references, never fabricated SQL text).
 * A drift banner reflects the latest check; the HEAD node is marked.
 *
 * Server component: it reads straight from the lineage store via
 * `getLineageDetail` (mirrors how Compare calls `findTrackedSchema` directly).
 * The only client island is the "Check drift now" button.
 */

// ── Small pure formatters (server-safe, no Date.now → no hydration risk) ─────

/** Four-digit migration sequence, e.g. 1 → "0001". */
function fmtSeq(seq: number): string {
  return String(seq).padStart(4, "0");
}

/** Stable absolute timestamp, e.g. "2026-06-08 14:21 UTC". */
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** How each drift status reads: pill tone + label. */
function driftMeta(status: DriftStatus | null): { tone: PillTone; label: string } {
  switch (status) {
    case "drifted":
      return { tone: "drift", label: "Drifted" };
    case "in_sync":
      return { tone: "sync", label: "In sync" };
    case "unreachable":
      return { tone: "break", label: "Unreachable" };
    default:
      return { tone: "neutral", label: "Not checked" };
  }
}

/** Change-level → pill tone + label (baseline is shown as its own brand pill). */
function levelMeta(level: ChangeLevel): { tone: PillTone; label: string } {
  switch (level) {
    case "breaking":
      return { tone: "break", label: "breaking" };
    case "additive":
      return { tone: "pending", label: "additive" };
    case "patch":
      return { tone: "sync", label: "patch" };
    default:
      return { tone: "neutral", label: "unknown" };
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function SchemaDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const trackedSchemaId = Number(id);

  // Invalid id or not tracked → a clean in-shell "not found", never a crash.
  const detail = Number.isFinite(trackedSchemaId)
    ? await getLineageDetail(trackedSchemaId)
    : null;

  if (!detail) {
    return (
      <div className="max-w-[1100px] mx-auto px-8 py-10">
        <Card className="p-0 overflow-hidden">
          <div style={{ height: 320 }}>
            <EmptyState
              icon={<AlertCircleIcon size={22} />}
              title="Schema not found"
              description="This tracked schema doesn't exist — it may have been removed. Head back to the dashboard to see what's tracked."
              actions={
                <Link href="/studio" className="btn btn-secondary btn-sm">
                  <ChevronLeftIcon size={14} /> Back to dashboard
                </Link>
              }
            />
          </div>
        </Card>
      </div>
    );
  }

  const drift = driftMeta(detail.drift?.status ?? null);
  const connectionGone = detail.connection === null;
  const source =
    detail.label ??
    (detail.connection
      ? `${detail.connection.name} — ${detail.connection.database || "?"}`
      : "Connection removed");
  const headNode = detail.migrations[0] ?? null;
  const headSummary = headNode?.snapshot ?? null;

  // The compare deep-link only makes sense while the connection still exists.
  const compareHref = detail.connection
    ? `/compare?rightConnection=${detail.connection.id}&rightSchema=${encodeURIComponent(detail.schemaName)}`
    : null;

  return (
    <div className="max-w-[1100px] mx-auto px-8 py-10 space-y-8">
      {/* Back link */}
      <Link
        href="/studio"
        className="inline-flex items-center gap-1.5 text-[12.5px]"
        style={{ color: "var(--text-3)" }}
      >
        <ChevronLeftIcon size={14} /> Tracked schemas
      </Link>

      {/* Header */}
      <header className="flex items-start justify-between gap-6 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <Pill tone={drift.tone}>{drift.label}</Pill>
            {connectionGone ? (
              <Pill tone="neutral">Connection removed</Pill>
            ) : (
              <Pill tone="brand" dot={false}>
                {detail.connection?.type ?? "PostgreSQL"}
              </Pill>
            )}
            <Pill tone="neutral" dot={false}>
              {detail.migrations.length} in lineage
            </Pill>
          </div>
          <h1 className="mono text-[30px] font-semibold tracking-[-0.02em] leading-tight">
            {detail.schemaName}
          </h1>
          <div className="mono text-[13px] mt-1.5" style={{ color: "var(--text-3)" }}>
            {source}
            {detail.connection && (
              <>
                {" · "}
                <span style={{ color: "var(--text-2)" }}>
                  {detail.connection.host}:{detail.connection.port}/{detail.connection.database}
                </span>
              </>
            )}
            {headSummary && (
              <>
                {" · "}
                {headSummary.tableCount} tables · {headSummary.columnCount} columns
              </>
            )}
          </div>
        </div>

        {/* Current / HEAD card */}
        <Card className="px-5 py-4 min-w-[260px]">
          <div className="flex items-center justify-between mb-1">
            <span className="section-title">Current</span>
            <span className="text-[11px]" style={{ color: "var(--text-3)" }}>
              lineage HEAD
            </span>
          </div>
          <div className="flex items-baseline gap-2.5 mt-1">
            <span className="mono text-[26px] font-semibold tracking-[-0.01em]">
              {detail.headVersion ? `v${detail.headVersion}` : "—"}
            </span>
            {detail.headSeq !== null && (
              <span className="mono text-[13px]" style={{ color: "var(--text-3)" }}>
                · {fmtSeq(detail.headSeq)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-3">
            <Pill tone={drift.tone}>{drift.label}</Pill>
            {detail.drift && (
              <span className="mono text-[11px] ml-auto" style={{ color: "var(--text-3)" }}>
                {fmtDate(detail.drift.detectedAt)}
              </span>
            )}
          </div>
        </Card>
      </header>

      {/* Drift banner — one honest state at a time */}
      <DriftBanner
        status={detail.drift?.status ?? null}
        summary={detail.drift?.summary ?? null}
        detectedAt={detail.drift?.detectedAt ?? null}
        headVersion={detail.headVersion}
        connectionName={detail.connection?.name ?? null}
        trackedSchemaId={detail.trackedSchemaId}
        compareHref={compareHref}
      />

      {/* Lineage timeline */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="section-title mb-1">Lineage</div>
            <h2 className="text-[18px] font-semibold tracking-[-0.005em]">
              {detail.migrations.length === 1
                ? "1 migration · the baseline"
                : `${detail.migrations.length} migrations · newest at top`}
            </h2>
          </div>
          {compareHref && (
            <Link href={compareHref} className="btn btn-secondary btn-sm">
              <CompareIcon size={13} /> Open in Compare
            </Link>
          )}
        </div>

        <Timeline>
          {detail.migrations.map((node) => (
            <LineageNodeCard
              key={node.id}
              node={node}
              isHead={headNode?.id === node.id}
              drifted={headNode?.id === node.id && detail.drift?.status === "drifted"}
            />
          ))}
        </Timeline>
      </section>
    </div>
  );
}

// ── Drift banner ─────────────────────────────────────────────────────────────

function DriftBanner({
  status,
  summary,
  detectedAt,
  headVersion,
  connectionName,
  trackedSchemaId,
  compareHref,
}: {
  status: DriftStatus | null;
  summary: string | null;
  detectedAt: string | null;
  headVersion: string | null;
  connectionName: string | null;
  trackedSchemaId: number;
  compareHref: string | null;
}) {
  // Drifted — the loud amber hero state.
  if (status === "drifted") {
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
              This database has drifted from{" "}
              {headVersion ? <span className="mono">v{headVersion}</span> : "its lineage"}.
            </h3>
            <p className="text-[13px] mt-1" style={{ color: "var(--text-2)" }}>
              {summary ??
                "The live schema differs from its expected snapshot — changes may have been applied out-of-band."}
            </p>
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              {compareHref && (
                <Link href={compareHref} className="btn btn-secondary btn-sm">
                  <CompareIcon size={13} /> Open expected ↔ actual
                </Link>
              )}
              <RecheckDriftButton trackedSchemaId={trackedSchemaId} label="Re-check drift" />
              {detectedAt && (
                <span
                  className="mono text-[11.5px] ml-auto"
                  style={{ color: "var(--text-3)" }}
                >
                  detected · {fmtDate(detectedAt)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Unreachable — couldn't read the live schema (often a removed connection).
  if (status === "unreachable") {
    return (
      <Banner
        tone="break"
        icon={<AlertCircleIcon size={16} />}
        title="This schema's database is unreachable."
        body={
          summary ??
          (connectionName
            ? `Could not read the live schema on "${connectionName}".`
            : "The connection for this tracked schema has been removed.")
        }
        detectedAt={detectedAt}
        trackedSchemaId={trackedSchemaId}
      />
    );
  }

  // In sync — a calm, reassuring note.
  if (status === "in_sync") {
    return (
      <Banner
        tone="sync"
        icon={<CheckIcon size={16} />}
        title={
          headVersion
            ? `Live schema matches v${headVersion}.`
            : "Live schema matches its lineage."
        }
        body={summary ?? "No structural drift was found at the last check."}
        detectedAt={detectedAt}
        trackedSchemaId={trackedSchemaId}
      />
    );
  }

  // Never checked — prompt the first drift check.
  return (
    <Banner
      tone="neutral"
      icon={<InfoIcon size={16} />}
      title="No drift check has run yet."
      body="Run a check to compare the live schema against its lineage baseline."
      detectedAt={null}
      trackedSchemaId={trackedSchemaId}
    />
  );
}

/** Shared compact banner for the calmer (non-drifted) states. */
function Banner({
  tone,
  icon,
  title,
  body,
  detectedAt,
  trackedSchemaId,
}: {
  tone: "sync" | "break" | "neutral";
  icon: React.ReactNode;
  title: string;
  body: string;
  detectedAt: string | null;
  trackedSchemaId: number;
}) {
  const accent =
    tone === "sync" ? "var(--sync)" : tone === "break" ? "var(--break)" : "var(--text-3)";
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
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <RecheckDriftButton trackedSchemaId={trackedSchemaId} label="Check drift now" />
            {detectedAt && (
              <span className="mono text-[11.5px] ml-auto" style={{ color: "var(--text-3)" }}>
                last check · {fmtDate(detectedAt)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── One lineage node ─────────────────────────────────────────────────────────

function LineageNodeCard({
  node,
  isHead,
  drifted,
}: {
  node: LineageNode;
  isHead: boolean;
  drifted: boolean;
}) {
  const level = levelMeta(node.changeLevel);
  const snap = node.snapshot;
  const previewNames = snap ? snap.tableNames.slice(0, 8) : [];
  const moreCount = snap ? Math.max(0, snap.tableNames.length - previewNames.length) : 0;

  return (
    <TimelineNode state="applied" head={isHead} drift={drifted}>
      <div className="pb-5">
        {isHead && (
          <div className="mb-1.5">
            <Pill tone={drifted ? "drift" : "brand"} dot={false}>
              HEAD{drifted ? " · drift here" : ""}
            </Pill>
          </div>
        )}

        {/* Title row */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="mono text-[12px]" style={{ color: "var(--text-3)" }}>
            {fmtSeq(node.seq)}
          </span>
          <span className="mono text-[14px] font-medium">{node.name}</span>
          {node.isBaseline ? (
            <Pill tone="brand">baseline</Pill>
          ) : (
            <Pill tone={level.tone}>{level.label}</Pill>
          )}
        </div>

        {/* Meta row */}
        <div
          className="flex items-center gap-2 text-[11.5px] mt-1.5"
          style={{ color: "var(--text-3)" }}
        >
          <span className="mono" style={{ color: "var(--text-2)" }}>
            v{node.version}
          </span>
          <span>·</span>
          <span>{fmtDate(node.createdAt)}</span>
        </div>

        {/* Snapshot summary */}
        {snap ? (
          <div className="panel mt-3 p-3.5">
            <div className="flex items-center justify-between mb-2">
              <span className="section-title">Snapshot</span>
              {snap.label && (
                <span className="mono text-[11px]" style={{ color: "var(--text-3)" }}>
                  {snap.label}
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <SummaryStat value={snap.tableCount} label="TABLES" />
              <SummaryStat value={snap.columnCount} label="COLUMNS" />
              <SummaryStat value={snap.constraintCount} label="CONSTRAINTS" />
            </div>
            {previewNames.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {previewNames.map((name) => (
                  <span
                    key={name}
                    className="mono text-[11.5px] px-2 py-0.5 rounded-md"
                    style={{
                      background: "var(--surface-2)",
                      border: "1px solid var(--border)",
                      color: "var(--text-2)",
                    }}
                  >
                    {name}
                  </span>
                ))}
                {moreCount > 0 && (
                  <span
                    className="mono text-[11.5px] px-2 py-0.5"
                    style={{ color: "var(--text-3)" }}
                  >
                    +{moreCount} more
                  </span>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="text-[12px] mt-3" style={{ color: "var(--text-3)" }}>
            No snapshot is stored for this migration.
          </p>
        )}

        {/* SQL / script — honest: a reference if we have one, else a plain note */}
        <div
          className="flex items-start gap-2 mt-3 p-2.5 rounded-lg"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
        >
          <InfoIcon size={13} style={{ color: "var(--text-3)", marginTop: 1, flex: "none" }} />
          <span className="text-[12px]" style={{ color: "var(--text-2)" }}>
            {node.sqlRef ? (
              <>
                Migration script:{" "}
                <span className="mono" style={{ color: "var(--text)" }}>
                  {node.sqlRef}
                </span>
              </>
            ) : node.isBaseline ? (
              "Captured directly from the live database — this baseline has no migration script of its own."
            ) : (
              "No migration script is stored for this entry."
            )}
          </span>
        </div>
      </div>
    </TimelineNode>
  );
}

function SummaryStat({ value, label }: { value: number; label: string }) {
  return (
    <div className="panel py-2.5" style={{ background: "var(--surface)" }}>
      <div className="mono text-[18px] font-semibold">{value}</div>
      <div className="text-[10px]" style={{ color: "var(--text-3)" }}>
        {label}
      </div>
    </div>
  );
}
