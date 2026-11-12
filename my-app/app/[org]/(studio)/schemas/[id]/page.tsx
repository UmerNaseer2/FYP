"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Pill,
  Card,
  EmptyState,
  EnvironmentPill,
  Skeleton,
  Timeline,
  TimelineNode,
} from "@/components/ui";
import { isProduction } from "@/lib/environments";
import { countOf } from "@/lib/plural";
import { displayVersion } from "@/lib/version-timeline";
import {
  ChevronLeftIcon,
  AlertTriangleIcon,
  AlertCircleIcon,
  CompareIcon,
  InfoIcon,
} from "@/components/ui/icons";
import { HelpHint } from "@/components/ui/HelpHint";
import { PageHeader } from "@/components/studio/PageHeader";
import { RecheckDriftButton } from "@/components/studio/RecheckDriftButton";
import { SchemaEnvironmentPicker } from "@/components/studio/SchemaEnvironmentPicker";
import { ChangeLevelPill } from "@/components/studio/ChangeLevelPill";
import { utcStamp } from "@/lib/format-date";
import { useOrgHref } from "@/hooks/useOrg";
// Types only. `import type` is erased at compile time, so importing the shape
// of a row does not pull the database module into the client bundle.
import type {
  LineageDetail,
  LineageNode,
  DriftStatus,
} from "@/lib/lineage-db";
import { apiFetch } from "@/lib/api-fetch";
import "@/app/styles/atelier-schema.css";

/**
 * Phase 8, Schema detail / Lineage timeline.
 *
 * Opened from a dashboard card. Shows one tracked schema's lineage as a vertical
 * timeline (newest at top), each node with the snapshot it produced and an
 * honest treatment of its SQL (a script reference when we have one, otherwise a
 * plain note: we store snapshots and references, never fabricated SQL text).
 * A drift banner reflects the latest check; the HEAD node is marked.
 *
 * Client component: it reads everything through GET /api/lineage/<id> instead
 * of querying the metadata store while rendering. Keeping the database behind
 * the API layer means one place reads a tracked schema and one place checks
 * the permission to read it, and the screen can reload itself after a drift
 * check or a relabel rather than asking the server to re-render.
 */

// ── Small pure formatters (server-safe, no Date.now, so no hydration risk) ─────

/** Four-digit migration sequence, e.g. 1 becomes "0001". */
function fmtSeq(seq: number): string {
  return String(seq).padStart(4, "0");
}

/** Stable absolute timestamp, e.g. "2026-06-08 14:21 UTC" (utcStamp). */
function fmtDate(iso: string | null): string {
  return utcStamp(iso) || "No time recorded";
}

/** How each drift status reads: a word and a colour class for its dot. */
function driftMeta(status: DriftStatus | null): { tone: string; label: string } {
  switch (status) {
    case "drifted":
      return { tone: "drift", label: "Drifted" };
    case "in_sync":
      return { tone: "sync", label: "In sync" };
    case "unreachable":
      return { tone: "down", label: "Unreachable" };
    default:
      return { tone: "none", label: "Not checked" };
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SchemaDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const trackedSchemaId = Number(id);
  const orgPath = useOrgHref();

  const [detail, setDetail] = useState<LineageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // One read for the whole screen. It is a useCallback because the drift button
  // and the environment picker call it again after they write something. This
  // screen holds its own data, so refreshing the router would show nothing.
  const load = useCallback(async () => {
    if (!Number.isInteger(trackedSchemaId) || trackedSchemaId <= 0) {
      // An invalid id gets a clean in-shell "not found", never a crash.
      setDetail(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch("/api/lineage/" + trackedSchemaId);
      const data = await res.json().catch(() => null);
      if (res.ok && data) {
        setDetail(data as LineageDetail);
        setError(null);
      } else {
        setDetail(null);
        // A 404 means "not tracked", which the empty state already explains in
        // full. Anything else is a real failure and its reason belongs on the
        // screen rather than only in the console.
        setError(
          res.status === 404 ? null : data?.error ?? "Could not load this schema."
        );
      }
    } catch {
      setDetail(null);
      setError("Network error while loading this schema.");
    } finally {
      setLoading(false);
    }
  }, [trackedSchemaId]);

  useEffect(() => {
    void load();
  }, [load]);

  // First paint: the shape of the page, so nothing jumps when the data lands.
  if (loading) {
    return (
      <div className="sc-page" aria-busy="true">
        <Skeleton width={130} height={13} />
        <Skeleton width={320} height={34} />
        <div className="sc-top">
          <Skeleton height={210} radius={22} />
          <Skeleton height={210} radius={22} />
        </div>
        <Skeleton height={96} radius={22} />
        <Skeleton height={240} radius={22} />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="sc-page">
        <Card className="sc-empty">
          <EmptyState
            tone="break"
            icon={<AlertCircleIcon size={22} />}
            title={error ? "Could not load this schema" : "Schema not found"}
            description={
              error ??
              "This tracked schema doesn't exist. It may have been removed. Head back to the dashboard to see what's tracked."
            }
            actions={
              <div className="sc-empty__actions">
                <Link href={orgPath("/studio")} className="btn btn-secondary btn-sm">
                  <ChevronLeftIcon size={14} /> Back to dashboard
                </Link>
                {error && (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void load()}
                  >
                    Try again
                  </button>
                )}
              </div>
            }
          />
        </Card>
      </div>
    );
  }

  const drift = driftMeta(detail.drift?.status ?? null);
  const connectionGone = detail.connection === null;
  // The name this schema goes by. With the connection gone and no label there
  // is nothing to show here: the "Connection removed" pill already says it.
  const source =
    detail.label ??
    (detail.connection
      ? `${detail.connection.name} · ${detail.connection.database || "?"}`
      : null);
  const headNode = detail.migrations[0] ?? null;
  const headSummary = headNode?.snapshot ?? null;

  // The compare deep-link only makes sense while the connection still exists.
  // It fills in this schema as the target and leaves the source to the reader,
  // so it does not run a comparison against a source nobody chose.
  const compareHref = detail.connection
    ? orgPath(
        `/compare?targetConnection=${detail.connection.id}&targetSchema=${encodeURIComponent(detail.schemaName)}`
      )
    : null;

  return (
    <div className="sc-page">
      <Link href={orgPath("/studio")} className="sc-up">
        <ChevronLeftIcon size={14} /> Tracked schemas
      </Link>

      {/* Header. The title is the schema's own name; the line under it comes
          from lib/help/schema-details.ts. */}
      <PageHeader page="/schemas" title={detail.schemaName}>
        <div className="sc-sub">
          <span className={`sc-stt sc-stt--${drift.tone}`}>
            <i aria-hidden="true" />
            <b>{drift.label}</b>
          </span>
          <EnvironmentPill environment={detail.environment} />
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
        <div className="sc-src">
          {source && <span>{source}</span>}
          {detail.connection && (
            <code>
              {detail.connection.host}:{detail.connection.port}/{detail.connection.database}
            </code>
          )}
          {/*
            These two counts come from the newest LINEAGE SNAPSHOT, not from
            the live database: headSummary is migrations[0].snapshot. On a
            drifted schema they are the numbers as they were captured, which
            is exactly when a reader is most likely to take them for the
            current shape. Say which one they are.
          */}
          {headSummary && (
            <span title="Counted from the newest lineage snapshot, not read live. After a drift the live schema can differ.">
              {countOf(headSummary.tableCount, "table")} ·{" "}
              {countOf(headSummary.columnCount, "column")} at HEAD
            </span>
          )}
        </div>
      </PageHeader>

      {/* Top row: the drift card beside the numbers. */}
      <div className="sc-top">
        <DriftCard
          status={detail.drift?.status ?? null}
          summary={detail.drift?.summary ?? null}
          detectedAt={detail.drift?.detectedAt ?? null}
          headVersion={detail.headVersion}
          connectionName={detail.connection?.name ?? null}
          trackedSchemaId={detail.trackedSchemaId}
          compareHref={compareHref}
          driftHref={orgPath(`/drift?tab=detail&schema=${detail.trackedSchemaId}`)}
          onRechecked={() => void load()}
        />

        <div className="sc-nums">
          {/* Lineage card. Named "Lineage", not "Current": this is Schema
              Studio's own counter for the tracked schema, and it must not be
              read as the script version in GitHub or in script_patch. */}
          <Card className="sc-num">
            <small>
              Lineage
              <HelpHint label="Lineage">
                Schema Studio&apos;s own counter for this tracked schema. It counts structure
                changes. It is not a script version from GitHub or from Deploy.
              </HelpHint>
            </small>
            <b className="sc-num__ver">
              {detail.headVersion ? displayVersion(detail.headVersion, true) : "None yet"}
            </b>
            {detail.headSeq !== null && <span>Entry {fmtSeq(detail.headSeq)}</span>}
          </Card>
          {/* The same snapshot numbers as the line above, so the same caveat. */}
          {headSummary && (
            <>
              <NumberCard label="Tables" value={headSummary.tableCount} />
              <NumberCard label="Columns" value={headSummary.columnCount} />
              <NumberCard label="Constraints" value={headSummary.constraintCount} />
            </>
          )}
        </div>
      </div>

      {/* Environment. Editable here because tracking only seeds it from the
          connection, and a label nobody can correct is a label nobody trusts. */}
      <Card className="sc-env">
        <SchemaEnvironmentPicker
          trackedSchemaId={detail.trackedSchemaId}
          environment={detail.environment}
          onDone={() => void load()}
        />
        {/* Only the production warning. What the environment is for is in
            the page's help (lib/help/schema-details.ts). */}
        {isProduction(detail.environment) && (
          <div className="warn-inline">
            <span className="ico sc-env__ico">
              <AlertTriangleIcon size={14} />
            </span>
            <div>
              <b>Production schema.</b> Re-baselining it on the Drift page accepts
              whatever changed outside this app as correct, so look at what changed
              before you do.
            </div>
          </div>
        )}
      </Card>

      {/* Lineage timeline */}
      <Card className="sc-snc">
        <section>
          <div className="sc-hd">
            <div>
              <small>Lineage</small>
              <h2>
                {detail.migrations.length === 1
                  ? "1 migration · the baseline"
                  : `${detail.migrations.length} migrations · newest at top`}
              </h2>
            </div>
            {compareHref && (
              <Link href={compareHref} className="btn btn-secondary btn-sm">
                <CompareIcon size={13} /> Compare with another database
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
      </Card>
    </div>
  );
}

/** One big number from the newest lineage snapshot. */
function NumberCard({ label, value }: { label: string; value: number }) {
  return (
    <Card
      className="sc-num"
      title="Counted from the newest lineage snapshot, not read live."
    >
      <small>{label}</small>
      <b>{value}</b>
      <span>in the newest snapshot</span>
    </Card>
  );
}

// ── Drift card ───────────────────────────────────────────────────────────────

/** The drift card: one honest state at a time, with what to do about it. */
function DriftCard({
  status,
  summary,
  detectedAt,
  headVersion,
  connectionName,
  trackedSchemaId,
  compareHref,
  driftHref,
  onRechecked,
}: {
  status: DriftStatus | null;
  summary: string | null;
  detectedAt: string | null;
  headVersion: string | null;
  connectionName: string | null;
  trackedSchemaId: number;
  compareHref: string | null;
  /** The drift screen's detail tab for this schema, where it is resolved. */
  driftHref: string;
  onRechecked: () => void;
}) {
  const tone = driftMeta(status).tone;
  const version = headVersion ? displayVersion(headVersion, true) : null;

  // Drifted: the loud state, with the way to the drift screen.
  if (status === "drifted") {
    return (
      <Card className="sc-dr sc-dr--drift">
        <small>Drift</small>
        <h2>
          The live schema has drifted from{" "}
          {version ? (
            <>
              lineage <span className="mono">{version}</span>
            </>
          ) : (
            "its baseline"
          )}
          .
        </h2>
        <p>
          {summary ??
            "The live schema differs from its baseline. Changes may have been made outside this app."}
        </p>
        <div className="sc-drf">
          {/* The expected and actual schemas side by side, and the ways
              to resolve the drift, live on the drift screen. */}
          <Link
            href={driftHref}
            className="btn btn-primary btn-sm"
            title="Opens the drift screen for this schema: what changed since the baseline, and the ways to resolve it."
          >
            <AlertTriangleIcon size={13} /> Review drift
          </Link>
          {/* Compare only ever runs on two live databases, so this link
              cannot show the baseline snapshot. That view lives on /drift. */}
          {compareHref && (
            <Link
              href={compareHref}
              className="btn btn-secondary btn-sm"
              title="Opens Compare with this database as the target. Compare works on two live databases, and the expected snapshot is not one of them."
            >
              <CompareIcon size={13} /> Compare with another database
            </Link>
          )}
          <RecheckDriftButton
            trackedSchemaId={trackedSchemaId}
            label="Re-check drift"
            onDone={onRechecked}
          />
          {detectedAt && <span className="sc-when">detected · {fmtDate(detectedAt)}</span>}
        </div>
      </Card>
    );
  }

  // The calmer states share one layout and differ only in their words.
  let title = "No drift check has run yet.";
  let body = "Run a check to compare the live schema against its baseline.";
  if (status === "unreachable") {
    // Couldn't read the live schema (often a removed connection).
    title = "This schema's database is unreachable.";
    body =
      summary ??
      (connectionName
        ? `Could not read the live schema on "${connectionName}".`
        : "The connection for this tracked schema has been removed.");
  } else if (status === "in_sync") {
    title = version
      ? `Live schema matches lineage ${version}.`
      : "Live schema matches its baseline.";
    body = summary ?? "No structural drift was found at the last check.";
  }

  return (
    <Card className={`sc-dr sc-dr--${tone}`}>
      <small>Drift</small>
      <h2>{title}</h2>
      <p>{body}</p>
      <div className="sc-drf">
        <RecheckDriftButton
          trackedSchemaId={trackedSchemaId}
          label="Check drift now"
          onDone={onRechecked}
        />
        {status !== null && detectedAt && (
          <span className="sc-when">last check · {fmtDate(detectedAt)}</span>
        )}
      </div>
    </Card>
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
  const snap = node.snapshot;
  const previewNames = snap ? snap.tableNames.slice(0, 8) : [];
  const moreCount = snap ? Math.max(0, snap.tableNames.length - previewNames.length) : 0;

  // Split the optional categories two ways: a count worth a tile, and a name
  // for the "nobody looked" line. null means the snapshot has no record of the
  // category, which the summary keeps separate from a recorded zero.
  const objectStats: { label: string; value: number }[] = [];
  const unrecorded: string[] = [];
  for (const [label, count] of [
    ["INDEXES", snap?.indexCount],
    ["TRIGGERS", snap?.triggerCount],
    ["VIEWS", snap?.viewCount],
    ["SEQUENCES", snap?.sequenceCount],
    ["TYPES", snap?.typeCount],
    ["FUNCTIONS", snap?.routineCount],
  ] as const) {
    if (count === undefined) continue;
    if (count === null) unrecorded.push(label);
    else if (count > 0) objectStats.push({ label, value: count });
  }

  return (
    <TimelineNode state="applied" head={isHead} drift={drifted}>
      <div className="sc-node">
        {isHead && (
          <div className="sc-node__head">
            <Pill tone={drifted ? "drift" : "brand"} dot={false}>
              HEAD{drifted ? " · drift here" : ""}
            </Pill>
          </div>
        )}

        {/* Title row */}
        <div className="sc-node__title">
          <span className="sc-node__seq">{fmtSeq(node.seq)}</span>
          <b>{node.name}</b>
          {node.isBaseline ? (
            <Pill tone="brand">baseline</Pill>
          ) : (
            // The pill every screen draws for a change level; a baseline
            // keeps its own brand pill above.
            <ChangeLevelPill level={node.changeLevel} />
          )}
        </div>

        {/* Meta row */}
        <div className="sc-node__meta">
          <span className="mono">lineage v{node.version}</span>
          <span aria-hidden="true">·</span>
          <span>{fmtDate(node.createdAt)}</span>
        </div>

        {/* Snapshot summary */}
        {snap ? (
          <div className="sc-snap">
            <div className="sc-snap__hd">
              <small>Snapshot</small>
              {snap.label && <span className="mono">{snap.label}</span>}
            </div>
            <div className="sc-stats">
              <SummaryStat value={snap.tableCount} label="TABLES" />
              <SummaryStat value={snap.columnCount} label="COLUMNS" />
              <SummaryStat value={snap.constraintCount} label="CONSTRAINTS" />
              {/* The other things the comparison engine reads. Only the ones
                  this snapshot actually holds get a tile, and only when there
                  is at least one: a schema with no triggers needs no 0. */}
              {objectStats.map((stat) => (
                <SummaryStat key={stat.label} value={stat.value} label={stat.label} />
              ))}
            </div>
            {unrecorded.length > 0 && (
              <p className="sc-snap__note">
                Not recorded in this snapshot: {unrecorded.join(", ").toLowerCase()}.{" "}
                <HelpHint label="Not recorded in this snapshot">
                  This snapshot was captured before this app read them. A comparison against it
                  stays quiet about those and does not report them as missing.
                </HelpHint>
              </p>
            )}
            {previewNames.length > 0 && (
              <div className="sc-chips">
                {previewNames.map((name) => (
                  <code key={name}>{name}</code>
                ))}
                {moreCount > 0 && <span>+{moreCount} more</span>}
              </div>
            )}
          </div>
        ) : (
          <p className="sc-snap__note">No snapshot is stored for this migration.</p>
        )}

        {/* SQL / script. Honest: a reference if we have one, else a plain note. */}
        <div className="sc-script">
          <InfoIcon size={13} />
          <span>
            {node.sqlRef ? (
              <>
                Migration script: <code>{node.sqlRef}</code>
              </>
            ) : node.isBaseline ? (
              "Captured directly from the live database. This baseline has no migration script of its own."
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
    <div className="sc-stat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}
