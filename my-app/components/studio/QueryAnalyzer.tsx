"use client";

import { useState } from "react";
import { Card, EmptyState, Pill } from "@/components/ui";
import { AlertCircleIcon, CheckIcon, PlayIcon } from "@/components/ui/icons";
import {
  FindingCard,
  SeverityFilter,
  activeFilter,
  type FilterKey,
  type FindingCounts,
  type FindingSeverity,
} from "./FindingCard";
import type { PerfTarget } from "./PerfTargetPicker";

/**
 * Spec feature 08 — query execution analysis, as a screen.
 *
 * Paste a query, get back what the server would actually do with it, in
 * English. The screen is built around one belief: a query plan is not hard
 * because it is complicated, it is hard because nothing on it is written for a
 * reader. So every step carries a sentence saying what it does, the timings are
 * shown as a share of the whole rather than as bare milliseconds, and anything
 * worth acting on is lifted out into the same finding cards the suggestions tab
 * uses.
 *
 * There is no effect in this file. The request happens when a button is
 * pressed, which is where it belongs — nothing here should fire at a database
 * because a prop changed.
 */

type PlanStep = {
  id: number;
  depth: number;
  nodeType: string;
  label: string;
  meaning: string;
  details: string[];
  estimatedRows: number;
  estimatedCost: number;
  actualRows: number | null;
  selfMs: number | null;
  loops: number | null;
};

type Finding = {
  id: string;
  severity: FindingSeverity;
  title: string;
  object: string;
  detail: string;
  fix: string;
};

/** Mirrors AnalyzeView in app/api/performance/analyze/route.ts. */
type AnalyzeView = {
  connectionName: string;
  database: string;
  schema: string;
  mode: "estimate" | "measured";
  headline: string;
  plan: {
    steps: PlanStep[];
    totalCost: number;
    estimatedRows: number;
    planningMs: number | null;
    executionMs: number | null;
    measured: boolean;
    slowestStepId: number | null;
  };
  findings: Finding[];
  counts: FindingCounts;
};

const PLACEHOLDER =
  "SELECT o.id, o.total\n" +
  "  FROM orders o\n" +
  "  JOIN customers c ON c.id = o.customer_id\n" +
  " WHERE o.state = 'paid'\n" +
  " ORDER BY o.created_at DESC\n" +
  " LIMIT 20;";

export function QueryAnalyzer({ target }: { target: PerfTarget | null }) {
  const [sql, setSql] = useState("");
  const [measure, setMeasure] = useState(false);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<AnalyzeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");

  const ready = Boolean(target && sql.trim() && !running);

  async function analyse() {
    if (!target || !sql.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/performance/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(target.connectionId),
          schema: target.schema,
          sql,
          measure,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setView(data as AnalyzeView);
      } else {
        // The old plan is cleared deliberately: leaving it on screen under a
        // new error makes it look like the answer to the query now in the box.
        setView(null);
        setError(data?.error ?? "Could not analyse this query.");
      }
    } catch {
      setView(null);
      setError("Could not reach the server to analyse this query.");
    } finally {
      setRunning(false);
    }
  }

  if (!target) {
    return (
      <Card className="p-6 text-[13px]" style={{ color: "var(--text-3)" }}>
        Choose a PostgreSQL connection and a schema above, then paste a query.
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <label
            htmlFor="analyze-sql"
            className="text-[10px] font-semibold uppercase tracking-[0.06em]"
            style={{ color: "var(--text-3)" }}
          >
            Query
          </label>
          <span className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
            One statement. Unqualified names resolve in{" "}
            <span className="mono">{target.schema}</span>.
          </span>
        </div>

        <textarea
          id="analyze-sql"
          className="sql-textarea mono text-[13px]"
          spellCheck={false}
          value={sql}
          placeholder={PLACEHOLDER}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter runs it — the shortcut every SQL box has, and the
            // one people try before they look for the button.
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && ready) void analyse();
          }}
        />

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <label className="flex items-start gap-2 text-[12.5px] cursor-pointer max-w-[52ch]">
            <input
              type="checkbox"
              checked={measure}
              onChange={(e) => setMeasure(e.target.checked)}
              className="mt-0.5"
            />
            <span style={{ color: "var(--text-2)" }}>
              Run it and measure
              <span className="block text-[11.5px]" style={{ color: "var(--text-3)" }}>
                Without this, the server only says what it would do. With it, the
                query really runs — inside a read-only transaction that is rolled
                back afterwards, so anything that writes is refused rather than
                applied.
              </span>
            </span>
          </label>

          <button
            type="button"
            className="btn btn-primary"
            disabled={!ready}
            onClick={() => void analyse()}
          >
            <PlayIcon size={13} />
            {running ? "Analysing…" : measure ? "Run and measure" : "Analyse"}
          </button>
        </div>
      </Card>

      {error && (
        <div className="warn-inline">
          <AlertCircleIcon size={15} className="ico" />
          <div>
            <div className="title">Could not analyse this query</div>
            <div className="body">{error}</div>
          </div>
        </div>
      )}

      {view && <Result view={view} filter={filter} onFilter={setFilter} />}
    </div>
  );
}

function Result({
  view,
  filter,
  onFilter,
}: {
  view: AnalyzeView;
  filter: FilterKey;
  onFilter: (next: FilterKey) => void;
}) {
  const active = activeFilter(filter, view.counts);
  const shown =
    active === "all" ? view.findings : view.findings.filter((f) => f.severity === active);

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Pill tone={view.mode === "measured" ? "sync" : "neutral"}>
            {view.mode === "measured" ? "Measured" : "Estimated"}
          </Pill>
          <span className="text-[13px]" style={{ color: "var(--text)" }}>
            {view.headline}
          </span>
        </div>
        <div className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
          {view.mode === "measured"
            ? "The query was run inside a transaction that was rolled back. " +
              "The times below are real, and are what this server did once, now."
            : "The query was not run. Row counts and costs below are the planner's " +
              "own guesses, which is what it chose this plan from."}
          {view.plan.planningMs !== null &&
            ` Planning took ${round(view.plan.planningMs)} ms.`}
        </div>
      </Card>

      <PlanTable plan={view.plan} />

      <div className="space-y-2.5">
        <div className="section-title">What to do about it</div>
        {view.counts.total === 0 ? (
          <Card className="p-0 overflow-hidden">
            <div style={{ height: 220 }}>
              <EmptyState
                icon={<CheckIcon size={22} />}
                title="Nothing to flag"
                description={
                  "Neither the plan nor the query text tripped any of the checks — " +
                  "no whole-table reads on large tables, no sort spilling to disk, " +
                  "no estimate wildly out, and nothing in the SQL that usually " +
                  "costs more than it looks."
                }
              />
            </div>
          </Card>
        ) : (
          <>
            <SeverityFilter counts={view.counts} value={active} onChange={onFilter} />
            {shown.map((f, i) => (
              <FindingCard
                key={`${f.id}-${i}`}
                severity={f.severity}
                title={f.title}
                object={f.object}
                detail={f.detail}
                fix={f.fix}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The plan, one row per step, indented the way the tree is nested.
 *
 * The bar on the right is each step's share of the total time — not its
 * absolute duration. A plan where one step owns eighty per cent of the run is
 * the thing worth seeing at a glance, and "412 ms" next to "38 ms" does not
 * show it nearly as fast as two bars do.
 */
function PlanTable({ plan }: { plan: AnalyzeView["plan"] }) {
  const totalSelf = plan.steps.reduce((sum, s) => sum + (s.selfMs ?? 0), 0);

  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="section-title">How the server would run this</div>
        <div className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
          Read bottom-up: each step feeds the one above it.
        </div>
      </div>

      <Card className="p-0 overflow-hidden">
        {plan.steps.map((step) => (
          <PlanRow
            key={step.id}
            step={step}
            measured={plan.measured}
            totalSelf={totalSelf}
            slowest={plan.slowestStepId === step.id && totalSelf > 0}
            first={step.id === 0}
          />
        ))}
      </Card>
    </div>
  );
}

function PlanRow({
  step,
  measured,
  totalSelf,
  slowest,
  first,
}: {
  step: PlanStep;
  measured: boolean;
  totalSelf: number;
  slowest: boolean;
  first: boolean;
}) {
  const share = totalSelf > 0 && step.selfMs !== null ? step.selfMs / totalSelf : 0;
  const rows = measured && step.actualRows !== null ? step.actualRows : step.estimatedRows;

  return (
    <div
      className="px-4 py-3 flex gap-3"
      style={{
        borderTop: first ? undefined : "1px solid var(--border)",
        background: slowest ? "var(--brand-soft)" : undefined,
      }}
    >
      {/* The depth is drawn rather than described, so a deep plan still reads
          as a shape and not as a wall of identical rows. */}
      <div style={{ width: step.depth * 14, flex: "none" }} />

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="mono text-[10.5px]" style={{ color: "var(--text-3)" }}>
            {step.id + 1}
          </span>
          <span className="mono text-[12.5px]" style={{ color: "var(--text)" }}>
            {step.label}
          </span>
          {slowest && <Pill tone="brand">Slowest step</Pill>}
        </div>

        {step.meaning && (
          <div className="text-[12.5px] leading-[1.55]" style={{ color: "var(--text-2)" }}>
            {step.meaning}
          </div>
        )}

        {step.details.map((line) => (
          <div key={line} className="mono text-[11.5px]" style={{ color: "var(--text-3)" }}>
            {line}
          </div>
        ))}
      </div>

      <div className="text-right flex-none" style={{ width: 132 }}>
        <div className="mono text-[11.5px]" style={{ color: "var(--text-2)" }}>
          {fmt(rows)} row{rows === 1 ? "" : "s"}
          {measured && (step.loops ?? 1) > 1 && (
            <span style={{ color: "var(--text-3)" }}> ×{fmt(step.loops ?? 1)}</span>
          )}
        </div>
        {measured && step.selfMs !== null ? (
          <>
            <div className="mono text-[11.5px]" style={{ color: "var(--text-3)" }}>
              {round(step.selfMs)} ms
            </div>
            <div
              className="mt-1 rounded-full overflow-hidden"
              style={{ height: 4, background: "var(--surface-3)" }}
              // The bar duplicates the number beside it, so it is decoration as
              // far as a screen reader is concerned.
              aria-hidden="true"
            >
              <div
                style={{
                  width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%`,
                  height: "100%",
                  background: slowest ? "var(--brand)" : "var(--text-3)",
                }}
              />
            </div>
          </>
        ) : (
          <div className="mono text-[11.5px]" style={{ color: "var(--text-3)" }}>
            cost {round(step.estimatedCost)}
          </div>
        )}
      </div>
    </div>
  );
}

/** Thousands separators — plan row counts get long fast. */
function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** At most two decimals, without printing "12.00". */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
