"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, EmptyState, Pill, Skeleton } from "@/components/ui";
import { AlertCircleIcon, PlayIcon, TrendIcon } from "@/components/ui/icons";
import { bandFor } from "@/lib/query-score";
import type { QueryComparison, QueryHistoryRow } from "@/lib/query-history";
import { ScoreBadge } from "./ScoreBadge";
import type { PerfTarget } from "./PerfTargetPicker";

/**
 * Spec feature 8 — "store query history for comparison" — and feature 10's
 * "Historical Query Monitoring (query, exec_time, rows_returned, capture_time)"
 * and "compare historical performance with current performance", as a screen.
 *
 * One list, two modes. Without a fingerprint it is everything analysed against
 * this schema; click a row and it becomes every run of that one query, with the
 * newest two compared. The second mode is the point — a single measurement is
 * a fact about one afternoon, and the useful question is always "is this worse
 * than it was".
 *
 * Nothing on this screen is collected in the background. A row appears when
 * somebody analyses a query, which is why an empty list says "nobody has
 * analysed anything here" and offers the analyser, rather than drawing an empty
 * chart that would read as "nothing has been slow".
 */

/** Mirrors QueryDayPoint in lib/query-history-db.ts. */
type QueryDayPoint = {
  day: string;
  runs: number;
  measuredRuns: number;
  medianExecMs: number | null;
  maxExecMs: number | null;
  medianScore: number | null;
};

/** Mirrors HistoryView in app/api/performance/history/route.ts. */
type HistoryView = {
  connectionName: string;
  schema: string;
  fingerprint: string | null;
  rows: QueryHistoryRow[];
  days: number;
  trend: QueryDayPoint[];
  comparison: QueryComparison | null;
  baselineId: number | null;
  baselineNote: string | null;
  retentionDays: number;
  maxRows: number;
  pageSize: number;
};

const WINDOWS: { days: number; label: string }[] = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

type Loaded = { key: string; view: HistoryView | null; error: string | null };

export function QueryHistoryPanel({
  target,
  fingerprint,
}: {
  target: PerfTarget | null;
  /** From ?fingerprint= — the single query to show, or null for the schema. */
  fingerprint: string | null;
}) {
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [days, setDays] = useState(30);
  // Which run the newest one is measured against. The fingerprint is stored
  // beside the id rather than reset in an effect: a run id belongs to one
  // query, so carrying it to a different query would ask the server to compare
  // against a run that is not in that query's history at all.
  const [baseline, setBaseline] = useState<{ fingerprint: string; id: number } | null>(null);

  const connectionId = target?.connectionId ?? "";
  const schema = target?.schema ?? "";
  const baselineId =
    fingerprint && baseline && baseline.fingerprint === fingerprint ? baseline.id : null;
  const key = `${connectionId} ${schema} ${days} ${fingerprint ?? ""} ${baselineId ?? ""}`;

  useEffect(() => {
    if (!connectionId || !schema) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/performance/history?connectionId=${encodeURIComponent(connectionId)}` +
            `&schema=${encodeURIComponent(schema)}&days=${days}` +
            (fingerprint ? `&fingerprint=${encodeURIComponent(fingerprint)}` : "") +
            (baselineId ? `&baseline=${baselineId}` : ""),
          { cache: "no-store" }
        );
        const data = await res.json();
        if (cancelled) return;
        setLoaded(
          res.ok
            ? { key, view: data as HistoryView, error: null }
            : { key, view: null, error: data?.error ?? "Could not read the query history." }
        );
      } catch {
        if (cancelled) return;
        setLoaded({ key, view: null, error: "Could not reach the server to read the history." });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [connectionId, schema, days, fingerprint, baselineId, key]);

  const current = loaded && loaded.key === key ? loaded : null;

  /** Move between "the whole schema" and "this one query" through the URL. */
  function show(next: string | null) {
    const params = new URLSearchParams({ tab: "history", connectionId, schema });
    if (next) params.set("fingerprint", next);
    router.push(`/performance?${params.toString()}`);
  }

  if (!connectionId || !schema) {
    return (
      <Card className="p-6 text-[13px]" style={{ color: "var(--text-3)" }}>
        Choose a PostgreSQL connection and a schema above to see what has been
        analysed against it.
      </Card>
    );
  }

  if (current === null) {
    return (
      <Card className="p-4 space-y-3">
        <Skeleton width={240} height={16} />
        <Skeleton width="100%" height={120} />
        <Skeleton width="100%" height={44} />
      </Card>
    );
  }

  const view = current.view;
  if (!view) {
    return (
      <div className="warn-inline">
        <AlertCircleIcon size={15} className="ico" />
        <div>
          <div className="title">Could not read the query history</div>
          <div className="body">{current.error}</div>
        </div>
      </div>
    );
  }

  if (view.rows.length === 0) {
    return (
      <Card className="p-0 overflow-hidden">
        <div style={{ height: 300 }}>
          <EmptyState
            icon={<TrendIcon size={22} />}
            title={
              fingerprint
                ? "No runs of that query"
                : "Nothing has been analysed against this schema yet"
            }
            description={
              fingerprint
                ? "Either it has never been analysed here, or its runs have aged out " +
                  `of the ${view.retentionDays}-day window.`
                : "A row appears here every time a query is analysed. Nothing is " +
                  "collected in the background, so this stays empty until somebody " +
                  "asks a question of this schema."
            }
            actions={
              <Link href="/performance?tab=analyse" className="btn btn-primary btn-sm">
                <PlayIcon size={13} /> Analyse a query
              </Link>
            }
          />
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {fingerprint && (
        <Card className="p-3.5 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Pill tone="brand">One query</Pill>
            <span className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
              {view.rows.length === 1
                ? "This query has been analysed once."
                : `${view.rows.length} runs of this query, newest first.`}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => show(null)}>
              Show the whole schema
            </button>
          </div>
          {view.comparison ? (
            <>
              <ComparisonLine
                comparison={view.comparison}
                newest={view.rows[0]}
                baseline={view.rows.find((r) => r.id === view.baselineId) ?? null}
              />
              <BaselinePicker
                rows={view.rows}
                chosen={view.baselineId}
                onChoose={(id) =>
                  setBaseline(id === null || !fingerprint ? null : { fingerprint, id })
                }
              />
              {view.baselineNote && (
                <div className="text-[11.5px]" style={{ color: "var(--drift)" }}>
                  {view.baselineNote}
                </div>
              )}
            </>
          ) : (
            <div className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
              There is nothing to compare it to yet. Analyse it again and the two
              runs will be set against each other here.
            </div>
          )}
        </Card>
      )}

      <TrendChart trend={view.trend} days={days} onDays={setDays} />

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="section-title">
            {fingerprint ? "Every run" : "Recently analysed"}
          </div>
          <div className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
            Kept for {view.retentionDays} days, up to {view.maxRows.toLocaleString("en-US")} rows
            per schema.
          </div>
        </div>

        {view.rows.map((row, index) => (
          <HistoryRow
            key={row.id}
            row={row}
            // Only in single-query mode, where there is a comparison at all.
            // The newest run is index 0 because the server orders by
            // captured_at DESC — see the route.
            role={
              !view.comparison ? null : index === 0 ? "newest" : row.id === view.baselineId ? "baseline" : null
            }
            // In single-query mode every row is already the same query, so the
            // button would only ever reload the same page.
            onOpen={fingerprint ? null : () => show(row.fingerprint)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Which earlier run to measure the newest one against.
 *
 * The default — the run immediately before — answers "did the change I just
 * made help?". It cannot answer the other question people bring to this screen:
 * a query that has degraded over months does so a few percent at a time, and
 * every consecutive pair looks fine. Picking the run from before the slide is
 * the only way to see it.
 *
 * rows[0] is left out of the list because it is the run being measured, and
 * comparing it with itself would print "about the same" — which reads as a
 * finding and is not one.
 */
function BaselinePicker({
  rows,
  chosen,
  onChoose,
}: {
  rows: QueryHistoryRow[];
  chosen: number | null;
  onChoose: (id: number | null) => void;
}) {
  const older = rows.slice(1);
  if (older.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <label className="text-[11.5px]" style={{ color: "var(--text-3)" }} htmlFor="history-baseline">
        Compare against
      </label>
      <select
        id="history-baseline"
        className="input"
        style={{ width: "auto", maxWidth: "100%", fontSize: 12 }}
        // The empty string is "whatever the previous run happens to be", which
        // stays right as new runs arrive; an id would pin this to one run.
        value={chosen !== null && chosen !== older[0].id ? String(chosen) : ""}
        onChange={(e) => onChoose(e.target.value === "" ? null : Number(e.target.value))}
      >
        <option value="">The previous run</option>
        {older.map((row) => (
          <option key={row.id} value={row.id}>
            {new Date(row.captured_at).toLocaleString()}
            {row.exec_time_ms !== null ? ` — ${round(row.exec_time_ms)} ms` : " — estimated"}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The newest run set against the chosen baseline, in one line.
 *
 * It names both runs by when they were captured. Before the baseline was
 * selectable this line only ever meant "against the previous run" and did not
 * have to say so; now that it can mean any earlier run, a verdict with no
 * mention of what it was measured against would be unreadable.
 */
function ComparisonLine({
  comparison,
  newest,
  baseline,
}: {
  comparison: QueryComparison;
  newest: QueryHistoryRow;
  /** Null only if the row list and the chosen id ever disagree — see below. */
  baseline: QueryHistoryRow | null;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[12.5px]" style={{ color: "var(--text)" }}>
        {comparison.verdict}
      </div>
      <div className="text-[11.5px]" style={{ color: "var(--text-2)" }}>
        {new Date(newest.captured_at).toLocaleString()}
        {" against "}
        {/* The server picks the baseline and sends back its id, so this only
            fails to match if the two ever disagree — in which case saying so
            is better than naming a run that was not the one compared. */}
        {baseline ? new Date(baseline.captured_at).toLocaleString() : "an earlier run"}
      </div>
      <div className="text-[11.5px] tabular-nums" style={{ color: "var(--text-3)" }}>
        {comparison.execTimeDeltaMs !== null
          ? `${comparison.execTimeDeltaMs >= 0 ? "+" : ""}${round(
              comparison.execTimeDeltaMs
            )} ms`
          : "No timing to compare — one of the two runs was an estimate"}
        {" · score "}
        {comparison.scoreDelta >= 0 ? "+" : ""}
        {comparison.scoreDelta}
        {comparison.rowsDelta !== null &&
          ` · ${comparison.rowsDelta >= 0 ? "+" : ""}${comparison.rowsDelta.toLocaleString(
            "en-US"
          )} rows`}
      </div>
    </div>
  );
}

/** One stored analysis. */
function HistoryRow({
  row,
  role,
  onOpen,
}: {
  row: QueryHistoryRow;
  /**
   * Its part in the comparison above, so the two runs the verdict is about can
   * be found in a list of forty. Null for every other row, and for every row
   * when there is no comparison.
   */
  role: "newest" | "baseline" | null;
  /** Null in single-query mode — see the call site. */
  onOpen: (() => void) | null;
}) {
  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <ScoreBadge score={row.score} band={bandFor(row.score)} />
        <Pill tone={row.measured ? "sync" : "neutral"}>
          {row.measured ? "Measured" : "Estimated"}
        </Pill>
        {role && <Pill tone="brand">{role === "newest" ? "Newest" : "Baseline"}</Pill>}
        <span className="text-[12px] tabular-nums" style={{ color: "var(--text)" }}>
          {/* exec_time_ms and rows_returned are null for an estimate by design,
              and are shown as an em dash rather than a 0 — a zero would be a
              claim that the query took no time and returned nothing. */}
          {row.exec_time_ms !== null ? `${round(row.exec_time_ms)} ms` : "—"}
          {" · "}
          {row.rows_returned !== null ? `${row.rows_returned.toLocaleString("en-US")} rows` : "—"}
        </span>
        <span className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
          {new Date(row.captured_at).toLocaleString()} · {row.captured_by}
        </span>
        {onOpen && (
          <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={onOpen}>
            Every run
          </button>
        )}
      </div>

      <pre
        className="text-[11.5px] mono p-2.5 rounded-md overflow-auto"
        style={{
          background: "var(--surface-2, var(--surface))",
          border: "1px solid var(--border)",
          color: "var(--text-2)",
          maxHeight: 96,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {row.query_text}
      </pre>

      {(row.high_count > 0 || row.medium_count > 0 || row.low_count > 0) && (
        <div className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
          {row.high_count} high · {row.medium_count} medium · {row.low_count} low
        </div>
      )}
    </Card>
  );
}

/**
 * The day-by-day chart.
 *
 * Drawn by hand, like the schema trends next door. Two things it will not do:
 * it does not join across a day with no analyses (a gap is a gap, not a
 * straight line through nothing), and it plots the median rather than the mean,
 * because somebody tuning a query produces thirty runs in ten minutes and the
 * first of those is always the worst.
 */
function TrendChart({
  trend,
  days,
  onDays,
}: {
  trend: QueryDayPoint[];
  days: number;
  onDays: (next: number) => void;
}) {
  const timed = trend.filter((p) => p.medianExecMs !== null);
  const peak = timed.reduce((max, p) => Math.max(max, p.medianExecMs ?? 0), 0);

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="section-title">Median time per day</div>
        <div className="flex items-center gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              className={`btn btn-sm ${days === w.days ? "btn-secondary" : "btn-ghost"}`}
              onClick={() => onDays(w.days)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {timed.length === 0 ? (
        <div className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
          Nothing in this window was timed. Tick &ldquo;really run it&rdquo; when
          analysing a query and its time is recorded here — an estimate has no
          time to plot.
        </div>
      ) : (
        <>
          <div className="flex items-end gap-1" style={{ height: 96 }}>
            {timed.map((point) => {
              const ms = point.medianExecMs ?? 0;
              // A floor of 2% so a genuinely fast day is still a visible mark
              // rather than nothing at all.
              const height = peak > 0 ? Math.max((ms / peak) * 100, 2) : 2;
              return (
                <div
                  key={point.day}
                  className="flex-1 rounded-t"
                  style={{
                    height: `${height}%`,
                    minWidth: 4,
                    background: "var(--brand)",
                    opacity: 0.75,
                  }}
                  title={`${point.day} — median ${round(ms)} ms over ${
                    point.measuredRuns
                  } timed ${point.measuredRuns === 1 ? "run" : "runs"}`}
                />
              );
            })}
          </div>
          <div
            className="flex items-center justify-between text-[11px] tabular-nums"
            style={{ color: "var(--text-3)" }}
          >
            <span>{timed[0].day}</span>
            <span>peak median {round(peak)} ms</span>
            <span>{timed[timed.length - 1].day}</span>
          </div>
        </>
      )}
    </Card>
  );
}

/** Two decimals under 10 ms, none above — the same rule the analyser uses. */
function round(n: number): number {
  return Math.abs(n) < 10 ? Math.round(n * 100) / 100 : Math.round(n);
}
