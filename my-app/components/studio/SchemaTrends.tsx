"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, EmptyState, Skeleton } from "@/components/ui";
import { AlertCircleIcon, DriftIcon, RefreshIcon, TrendIcon } from "@/components/ui/icons";
import { describeCadence } from "@/lib/drift-schedule";
import {
  METRICS,
  buildSeries,
  describeChange,
  driftShare,
  type MetricKey,
  type MetricSample,
  type Series,
  type SeriesBox,
} from "@/lib/metrics-series";
import type { PerfTarget } from "./PerfTargetPicker";

/**
 * Spec feature 10 — monitoring, as a screen.
 *
 * The other two Performance tabs answer their question from the live database
 * the moment you ask. This one cannot: a trend has to have been collected in
 * advance, and it is collected by the drift check. That constraint shapes
 * everything here.
 *
 *  • A schema nobody is watching gets an explanation and the link that starts
 *    the watching — not an empty chart. An empty chart claims "nothing
 *    happened"; the truth is "nobody was looking", and those are different.
 *  • A reading that could not be taken is a gap, never a zero. The size
 *    metrics need a privilege the counts do not, so a chart says how many of
 *    its readings it had to leave out rather than drawing them on the floor.
 *  • One reading is a dot with a caption saying there is nothing to compare it
 *    to yet, not a flat line through a single number.
 *
 * The charts are drawn by hand. Every number on screen — every coordinate,
 * every rule, every caption — comes out of lib/metrics-series, which is pure
 * and unit-tested; this file only turns that geometry into elements.
 */

/** Mirrors MetricsTracking in app/api/performance/metrics/route.ts. */
type MetricsTracking = {
  trackedSchemaId: number;
  label: string | null;
  intervalMinutes: number;
  lastCheckedAt: string | null;
};

/** Mirrors MetricsView on the server. */
type MetricsView = {
  connectionName: string;
  schema: string;
  tracking: MetricsTracking | null;
  days: number;
  retentionDays: number;
  samples: MetricSample[];
};

/**
 * The plot geometry.
 *
 * Width 100 on purpose: with the SVG stretched by `preserveAspectRatio="none"`,
 * an x of 42 is 42% of whatever width the card ended up with, so the same
 * numbers position the HTML labels laid over the top. Height is real pixels,
 * which is why the plot is not allowed to scale vertically — a y of 90 is 90px
 * down in both the drawing and the overlay.
 */
const PLOT: SeriesBox = { width: 100, height: 128, pad: 2 };

/** Windows the server will honour. Anything else is snapped up to one of these. */
const WINDOWS: { days: number; label: string }[] = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

/** The four structural metrics, then the three about size. */
const STRUCTURE_KEYS: MetricKey[] = ["tables", "columns", "indexes", "foreignKeys"];
const SIZE_KEYS: MetricKey[] = ["totalBytes", "indexBytes", "estimatedRows"];

/** One completed request, tagged with the request it answers. */
type Loaded = { key: string; view: MetricsView | null; error: string | null };

export function SchemaTrends({ target }: { target: PerfTarget | null }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [days, setDays] = useState(7);
  // Bumped by "Refresh". Part of the request key, so asking again is asking a
  // different question and the screen goes back to its skeleton.
  const [reload, setReload] = useState(0);

  const connectionId = target?.connectionId ?? "";
  const schema = target?.schema ?? "";
  const key = `${connectionId} ${schema} ${days} ${reload}`;

  useEffect(() => {
    if (!connectionId || !schema) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/performance/metrics?connectionId=${encodeURIComponent(connectionId)}` +
            `&schema=${encodeURIComponent(schema)}&days=${days}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (cancelled) return;
        setLoaded(
          res.ok
            ? { key, view: data as MetricsView, error: null }
            : {
                key,
                view: null,
                error: data?.error ?? "Could not read this schema's history.",
              }
        );
      } catch {
        if (cancelled) return;
        setLoaded({
          key,
          view: null,
          error: "Could not reach the server to read this schema's history.",
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [connectionId, schema, days, key]);

  // Which request the answer belongs to is derived rather than stored, so the
  // skeleton comes back on a change of target without a setState in an effect.
  const current = loaded && loaded.key === key ? loaded : null;

  if (!connectionId || !schema) {
    return (
      <Card className="p-6 text-[13px]" style={{ color: "var(--text-3)" }}>
        Choose a PostgreSQL connection and a schema above to see how it has been
        changing.
      </Card>
    );
  }

  if (current === null) return <TrendsSkeleton />;

  const view = current.view;
  if (!view) {
    return (
      <div className="warn-inline">
        <AlertCircleIcon size={15} className="ico" />
        <div>
          <div className="title">Could not read this schema&apos;s history</div>
          <div className="body">
            {current.error}{" "}
            <button
              type="button"
              className="underline"
              onClick={() => setReload((n) => n + 1)}
            >
              Try again
            </button>
            .
          </div>
        </div>
      </div>
    );
  }

  // Not tracked is a complete answer, not a failure — and the only useful thing
  // to show is the reason and the way to fix it.
  if (!view.tracking) {
    return (
      <Card className="p-0 overflow-hidden">
        <div style={{ height: 320 }}>
          <EmptyState
            icon={<TrendIcon size={22} />}
            title="Nothing is watching this schema yet"
            description={
              <>
                Readings are taken by the drift check, so a schema has a history
                exactly when the app has been watching it. Track{" "}
                <span className="mono">{view.schema}</span> on Drift and the first
                reading is taken straight away.
              </>
            }
            actions={
              <Link href="/drift" className="btn btn-primary btn-sm">
                <DriftIcon size={13} /> Go to Drift
              </Link>
            }
          />
        </div>
      </Card>
    );
  }

  const { samples } = view;
  const share = driftShare(samples);

  return (
    <div className="space-y-4">
      <SummaryBar
        view={view}
        days={days}
        onDays={setDays}
        onRefresh={() => setReload((n) => n + 1)}
      />

      {samples.length === 0 ? (
        <Card className="p-0 overflow-hidden">
          <div style={{ height: 320 }}>
            <EmptyState
              icon={<TrendIcon size={22} />}
              title="No readings in this window"
              description={
                view.tracking.lastCheckedAt === null
                  ? "This schema is tracked, but no drift check has finished yet. " +
                    "The first one takes a reading as soon as it runs."
                  : `This schema is tracked and checked ${describeCadence(
                      view.tracking.intervalMinutes
                    )}, but nothing was recorded in the last ${view.days} ` +
                    `day${view.days === 1 ? "" : "s"}. Try a longer window.`
              }
            />
          </div>
        </Card>
      ) : (
        <>
          <div
            className="flex items-start gap-2 text-[12.5px]"
            style={{ color: "var(--text-2)" }}
          >
            <span style={{ color: share.drifted > 0 ? "var(--drift)" : "var(--sync)" }}>
              <DriftIcon size={14} />
            </span>
            <span>{share.sentence}</span>
          </div>

          <Section title="Structure" columns="sm:grid-cols-2">
            {STRUCTURE_KEYS.map((metric) => (
              <TrendCard key={metric} metric={metric} samples={samples} />
            ))}
          </Section>

          <Section title="Size and rows" columns="sm:grid-cols-2 lg:grid-cols-3">
            {SIZE_KEYS.map((metric) => (
              <TrendCard key={metric} metric={metric} samples={samples} />
            ))}
          </Section>

          <p className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
            {samples.length} reading{samples.length === 1 ? "" : "s"} in this window
            · one is taken every time a drift check runs · readings older than{" "}
            {view.retentionDays} days are removed.
          </p>
        </>
      )}
    </div>
  );
}

/** A titled band of charts. */
function Section({
  title,
  columns,
  children,
}: {
  title: string;
  columns: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="section-title">{title}</div>
      <div className={`grid gap-3 ${columns}`}>{children}</div>
    </div>
  );
}

/** One metric: its name, what it did, and the line. */
function TrendCard({ metric, samples }: { metric: MetricKey; samples: MetricSample[] }) {
  const series = buildSeries(samples, metric, PLOT);
  const meta = METRICS.find((m) => m.key === metric) ?? METRICS[0];
  const change = describeChange(series);

  return (
    <Card className="p-4 space-y-3">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-[13.5px] font-semibold" title={meta.help}>
            {meta.label}
          </h3>
          <span
            className="text-[11.5px] mono"
            style={{
              // Deliberately not red-for-up, green-for-down. There is no
              // direction that is bad for all four metrics: more tables is
              // usually growth, fewer indexes is usually a loss, and bytes going
              // up is a cost rather than a fault. Colouring by direction would
              // have the chart pass a judgement it has no way to make. The sign
              // on the number says which way it went; a moved value is darker
              // than one that did not move, and that is all the colour claims.
              color:
                change.direction === "up" || change.direction === "down"
                  ? "var(--text-2)"
                  : "var(--text-3)",
            }}
          >
            {change.delta}
          </span>
        </div>
        <p className="text-[12px] mt-1" style={{ color: "var(--text-2)" }}>
          {change.sentence}
        </p>
      </div>

      <Plot series={series} />

      {series.missing > 0 && (
        <p className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
          {series.missing} reading{series.missing === 1 ? "" : "s"} in this window
          could not be measured, and {series.missing === 1 ? "is" : "are"} left out
          of the line rather than drawn as zero.
        </p>
      )}
    </Card>
  );
}

/**
 * The drawing.
 *
 * The SVG holds only shapes, and every stroke in it is marked non-scaling so
 * that stretching the box sideways does not thicken the line. Everything made
 * of text — the value rules, the dot on the latest reading — is HTML laid over
 * the top, positioned with the same coordinates, so it stays a readable size
 * whatever width the card ended up with.
 */
function Plot({ series }: { series: Series }) {
  if (series.points.length === 0) {
    return (
      <div
        className="grid place-items-center text-[12px] rounded-md"
        style={{
          height: PLOT.height,
          background: "var(--surface-3)",
          color: "var(--text-3)",
        }}
      >
        Nothing measurable in this window.
      </div>
    );
  }

  const last = series.points[series.points.length - 1];

  return (
    <div>
      <div className="flex gap-2">
        <div className="relative shrink-0" style={{ width: 62, height: PLOT.height }}>
          {series.ticks.map((tick) => (
            <div
              key={tick.value}
              className="absolute right-0 text-[10.5px] mono whitespace-nowrap"
              style={{ top: tick.y, transform: "translateY(-50%)", color: "var(--text-3)" }}
            >
              {tick.label}
            </div>
          ))}
        </div>

        <div className="relative flex-1" style={{ height: PLOT.height }}>
          <svg
            viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
            preserveAspectRatio="none"
            className="w-full block"
            style={{ height: PLOT.height }}
            aria-hidden="true"
          >
            {series.ticks.map((tick) => (
              <line
                key={tick.value}
                x1={0}
                y1={tick.y}
                x2={PLOT.width}
                y2={tick.y}
                stroke="var(--border)"
                strokeWidth={1}
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {series.area !== "" && (
              <path d={series.area} fill="var(--brand-soft)" stroke="none" />
            )}
            {series.path !== "" && (
              <path
                d={series.path}
                fill="none"
                stroke="var(--brand)"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {/* The latest reading, as a real circle rather than the ellipse the
              stretched SVG would have made of it. */}
          <span
            className="absolute rounded-full"
            style={{
              left: `${last.x}%`,
              top: last.y,
              width: 7,
              height: 7,
              transform: "translate(-50%, -50%)",
              background: "var(--brand)",
              border: "2px solid var(--surface)",
            }}
          />
        </div>
      </div>

      <div className="flex gap-2 mt-1.5">
        <div className="shrink-0" style={{ width: 62 }} />
        <div
          className="relative flex-1"
          style={{ height: 8 }}
          title="Checks that found the schema drifted"
        >
          {series.driftMarks.map((mark, i) => (
            <span
              // Two checks can land in the same millisecond, so the timestamp
              // alone is not a key.
              key={`${mark.at}-${i}`}
              className="absolute rounded-sm"
              style={{
                left: `${mark.x}%`,
                top: 0,
                width: 2,
                height: 8,
                transform: "translateX(-50%)",
                background: "var(--drift)",
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Which schema, how often it is checked, over what window. */
function SummaryBar({
  view,
  days,
  onDays,
  onRefresh,
}: {
  view: MetricsView;
  days: number;
  onDays: (next: number) => void;
  onRefresh: () => void;
}) {
  const tracking = view.tracking;
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[13px]" style={{ color: "var(--text-2)" }}>
          <span className="mono" style={{ color: "var(--text)" }}>
            {view.schema}
          </span>{" "}
          on {view.connectionName} · checked{" "}
          {tracking ? describeCadence(tracking.intervalMinutes) : "manually"}
          {tracking?.lastCheckedAt
            ? ` · last check ${new Date(tracking.lastCheckedAt).toLocaleString()}`
            : " · no check has finished yet"}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh}>
          <RefreshIcon size={12} /> Refresh
        </button>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {WINDOWS.map((w) => {
          const active = days === w.days;
          return (
            <button
              key={w.days}
              type="button"
              aria-pressed={active}
              onClick={() => onDays(w.days)}
              className="text-[12.5px] px-2.5 py-1 rounded-md transition-colors"
              style={{
                border: "1px solid var(--border)",
                background: active ? "var(--text)" : "var(--surface)",
                color: active ? "var(--surface)" : "var(--text-2)",
              }}
            >
              {w.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TrendsSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton width={320} height={18} />
      <div className="grid gap-3 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="p-4 space-y-3">
            <Skeleton width={140} height={16} />
            <Skeleton width="80%" height={13} />
            <Skeleton width="100%" height={PLOT.height} radius={8} />
          </Card>
        ))}
      </div>
    </div>
  );
}
