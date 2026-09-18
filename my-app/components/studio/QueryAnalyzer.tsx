"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, EmptyState, Pill } from "@/components/ui";
import { useUser } from "@/hooks/useUser";
import { roleAtLeast } from "@/lib/auth-mode";
import { AlertCircleIcon, CheckIcon, PlayIcon } from "@/components/ui/icons";
import {
  FindingCard,
  SeverityFilter,
  activeFilter,
  type FilterKey,
} from "./FindingCard";
import type { PerfTarget } from "./PerfTargetPicker";
// Dependency-free helpers shared with the suggestions: the quoting, so the
// table named in the editor is quoted exactly as the suggestion that linked
// here quotes it, and the heading over a change to another schema, worded as
// the fix script below words it.
import { otherSchemaHeading, qualifiedName, quoteIdent } from "@/lib/perf-sql";
import { PlanTree, ShareMeter } from "./PlanTree";
import { FixScriptBuilder } from "./FixScriptBuilder";
import { ScorePanel } from "./ScoreBadge";
import { ThresholdBanner } from "./ThresholdBanner";
// Type-only: erased at build time. The response shape has one definition, in
// lib/query-analysis.ts, shared with the route that produces it, so the screen
// and the route can never silently disagree about it.
import type {
  AnalyzeView,
  PlanStep,
  PlanSummary,
  QueryFinding,
} from "@/lib/query-analysis";
// Values from the same module, which opens no connections, so it is safe to
// load in the browser. QUERY_TIMEOUT_SECONDS is how long a measured query may
// run; the route's timeout is set from the same constant, so the sentence
// under the tick-box always matches what the server does. The rest word the
// plan exactly as the plan tree does, so the two views never disagree.
import {
  QUERY_TIMEOUT_SECONDS,
  explainInWords,
  heaviestStepLabel,
  shareBand,
  shareLegend,
  stepFigures,
  subqueryCaption,
} from "@/lib/query-analysis";

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

const PLACEHOLDER =
  "SELECT o.id, o.total\n" +
  "  FROM orders o\n" +
  "  JOIN customers c ON c.id = o.customer_id\n" +
  " WHERE o.state = 'paid'\n" +
  " ORDER BY o.created_at DESC\n" +
  " LIMIT 20;";

/**
 * What the editor starts with when a suggestion sent the reader here for one
 * table ("schema.table", from the link's ?table=): two comment lines naming
 * it, so the reader knows what to paste and nothing runs until they do. Empty
 * when no table was named.
 */
function starterQuery(table: string | null): string {
  if (!table) return "";
  const dot = table.indexOf(".");
  const name =
    dot === -1 ? quoteIdent(table) : qualifiedName(table.slice(0, dot), table.slice(dot + 1));
  return (
    `-- Replace these lines with a query that reads ${name}, written the way\n` +
    `-- the application sends it. The plan shows which filter no index could serve.\n`
  );
}

export function QueryAnalyzer({
  target,
  initialTable = null,
}: {
  target: PerfTarget | null;
  /** The table a suggestion's "Analyse a query on this table" link named. */
  initialTable?: string | null;
}) {
  const { role, loading: roleLoading } = useUser();
  const [sql, setSql] = useState(() => starterQuery(initialTable));
  // A link to a different table while this tab is already open (Back, say)
  // gives the editor that table's starter lines, but only if the reader has
  // not typed anything of their own. Adjusted while rendering, the way React
  // recommends for state that follows a prop, rather than in an effect.
  const [seenTable, setSeenTable] = useState(initialTable);
  if (initialTable !== seenTable) {
    setSeenTable(initialTable);
    if (sql === starterQuery(seenTable)) setSql(starterQuery(initialTable));
  }
  const [wantsMeasure, setWantsMeasure] = useState(false);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<AnalyzeView | null>(null);
  // The connection the answer on screen was asked about, noted when the request
  // went out. The picker can move on while that answer stays on screen, and a
  // migration saved from it must name the connection it describes.
  const [viewConnectionId, setViewConnectionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");

  const ready = Boolean(target && sql.trim() && !running);

  // Measuring runs the query, so the route asks for the editor role. Deciding
  // that here as well is not a second gate — the server's is the gate — it is
  // so a viewer is told before they press the button instead of after, and so a
  // request can never be sent that we already know will come back a 403.
  const canMeasure = roleAtLeast(role, "editor");
  const measure = wantsMeasure && canMeasure;

  async function analyse() {
    if (!target || !sql.trim()) return;
    const asked = target.connectionId;
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
        setViewConnectionId(asked);
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
            One query that reads data. Unqualified names resolve in{" "}
            <span className="mono">{target.schema}</span>
            {/* The search path is the schema, then public; saying "public,
                then public" for the public schema would read as a typo. */}
            {target.schema === "public" ? (
              "."
            ) : (
              <>
                , then <span className="mono">public</span>.
              </>
            )}
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
          <label
            className={`flex items-start gap-2 text-[12.5px] max-w-[52ch] ${
              canMeasure ? "cursor-pointer" : "cursor-not-allowed"
            }`}
          >
            <input
              type="checkbox"
              checked={measure}
              disabled={roleLoading || !canMeasure}
              onChange={(e) => setWantsMeasure(e.target.checked)}
              className="mt-0.5"
            />
            <span style={{ color: canMeasure ? "var(--text-2)" : "var(--text-3)" }}>
              Run it and measure
              <span className="block text-[11.5px]" style={{ color: "var(--text-3)" }}>
                {canMeasure ? (
                  <>
                    Without this, the server only says what it would do. With it,
                    the query really runs on{" "}
                    <span className="mono">{target.connectionName}</span> and puts
                    real load on that server until it finishes, or until it is
                    stopped after {QUERY_TIMEOUT_SECONDS} seconds. It runs read-only
                    and is rolled back, and known server-changing calls such as
                    pg_terminate_backend are refused. A function can still do
                    whatever the database user of this connection is allowed to
                    do, so the permissions of that user are the real limit.
                  </>
                ) : (
                  <>
                    Running the query needs the editor role, and yours is viewer.
                    You can still analyse it — the server will say what it would
                    do, using its own estimates, without touching any rows.
                  </>
                )}
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

      {view && (
        <Result view={view} connectionId={viewConnectionId} filter={filter} onFilter={setFilter} />
      )}
    </div>
  );
}

function Result({
  view,
  connectionId,
  filter,
  onFilter,
}: {
  view: AnalyzeView;
  /** The saved connection this answer came from, for "Save as a migration". */
  connectionId: string;
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
            : "The query was not run. The row counts below, and each step's share " +
              "of the cost, are the planner's own guesses, which is what it chose " +
              "this plan from."}
          {view.plan.planningMs !== null &&
            ` Planning took ${round(view.plan.planningMs)} ms.`}
        </div>
      </Card>

      <ThresholdBanner
        breaches={view.breaches}
        connectionId={connectionId}
        schema={view.schema}
      />

      <Card className="p-4 space-y-2.5">
        <div className="section-title">How this query scored</div>
        <ScorePanel score={view.score} />
        {/* Only offered when the analysis was really filed. A link built from a
            null id would 404, and filing is best-effort by design. */}
        {view.historyId !== null && (
          <div className="text-[11.5px] pt-0.5" style={{ color: "var(--text-3)" }}>
            <Link
              href={`/performance?tab=history&connectionId=${encodeURIComponent(
                connectionId
              )}&schema=${encodeURIComponent(view.schema)}&fingerprint=${view.fingerprint}`}
              className="underline"
            >
              See every run of this query
            </Link>{" "}
            — this one was recorded, so the next time you analyse it the two can
            be compared.
          </div>
        )}
      </Card>

      <PlanWords plan={view.plan} />

      <PlanSection plan={view.plan} findings={view.findings} />

      <div className="space-y-2.5">
        <div className="section-title">What to do about it</div>
        {view.counts.total === 0 ? (
          <Card className="p-0 overflow-hidden">
            <div style={{ height: 220 }}>
              <EmptyState
                icon={<CheckIcon size={22} />}
                title="Nothing to flag"
                description={
                  // Only a run reports how a sort went, how far off an
                  // estimate was, or how often a step was repeated, so an
                  // estimate cannot vouch for any of those.
                  view.mode === "measured"
                    ? "Neither the plan nor the query text tripped any of the checks — " +
                      "no whole-table reads on large tables, no sort spilling to disk, " +
                      "no estimate wildly out, and nothing in the SQL that usually " +
                      "costs more than it looks."
                    : "Neither the plan nor the query text tripped any of the checks " +
                      "that work without running the query — no whole-table reads on " +
                      "large tables, no big table read in full to join a few rows, and " +
                      "nothing in the SQL that usually costs more than it looks. A sort " +
                      "spilling to disk, an estimate far off or a table read again for " +
                      "every row shows only when the query is run and measured."
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
                fixKind={f.fixKind}
                // A change to another schema's table is not saved as a
                // migration made for view.schema, so its card must not say so.
                fixHeading={otherSchemaHeading(f, view.schema)}
                undo={f.undo}
                step={f.stepId}
              />
            ))}
            {/* Every finding, whatever the filter shows: the ticks say what goes in. */}
            <FixScriptBuilder
              items={view.findings}
              target={{
                connectionId,
                connectionName: view.connectionName,
                database: view.database,
                schema: view.schema,
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The plan in words, in the order the server runs it (explainInWords). It
 * comes first because it needs no knowledge of query plans at all; the tree
 * and the step list below are the same plan, drawn for looking a detail up.
 */
function PlanWords({ plan }: { plan: PlanSummary }) {
  const lines = explainInWords(plan);
  if (lines.length === 0) return null;
  return (
    <div className="space-y-2.5">
      <div className="section-title">In plain words</div>
      <Card className="p-4">
        <ol
          className="list-decimal pl-5 space-y-1.5 text-[13px] leading-[1.6]"
          style={{ color: "var(--text-2)" }}
        >
          {/* Two steps can read the same (two identical lookups), so the
              position is part of the key. */}
          {lines.map((line, i) => (
            <li key={`${i}:${line}`}>{line}</li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

/** Which drawing of the plan is showing. */
type PlanView = "tree" | "table";

/**
 * The plan, drawn one of two ways: as a tree of boxes (PlanTree), which shows
 * its shape, or as the step list, one row per step with every detail the plan
 * gave. Both tint a step by its share of the query, mark the heaviest one,
 * and number the steps the way the finding cards below do.
 */
function PlanSection({ plan, findings }: { plan: PlanSummary; findings: QueryFinding[] }) {
  const [shown, setShown] = useState<PlanView>("tree");

  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="section-title">
          {plan.measured ? "How the server ran this" : "How the server would run this"}
        </div>
        <ViewToggle value={shown} onChange={setShown} />
      </div>

      <div className="text-[11.5px] space-y-1" style={{ color: "var(--text-3)" }}>
        <div>
          {shown === "tree"
            ? "Data flows upward: each box feeds the one above it."
            : "Read bottom-up: each step feeds the one above it."}
        </div>
        <ShareLegend basis={plan.basis} />
      </div>

      {shown === "tree" ? (
        <Card className="p-0 overflow-hidden">
          <PlanTree plan={plan} findings={findings} />
        </Card>
      ) : (
        <PlanTable plan={plan} />
      )}
    </div>
  );
}

/** Tree / Step details, styled like the severity filter's chips. */
function ViewToggle({
  value,
  onChange,
}: {
  value: PlanView;
  onChange: (next: PlanView) => void;
}) {
  const options: { key: PlanView; label: string }[] = [
    { key: "tree", label: "Tree" },
    { key: "table", label: "Step details" },
  ];
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="How to show the plan">
      {options.map((o) => {
        const active = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.key)}
            className="text-[12.5px] px-2.5 py-1 rounded-md transition-colors"
            style={{
              border: "1px solid var(--border)",
              background: active ? "var(--text)" : "var(--surface)",
              color: active ? "var(--surface)" : "var(--text-2)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * What the percentages are a share of, and what the two tints mean. The words
 * come from shareLegend, so an estimate is never presented as a timing.
 */
function ShareLegend({ basis }: { basis: PlanSummary["basis"] }) {
  return (
    <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
      <span>{shareLegend(basis)}.</span>
      <span className="inline-flex items-center gap-1.5">
        <span className="plan-legend-swatch plan-tint-hot" aria-hidden="true" />
        Half of it or more
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="plan-legend-swatch plan-tint-warm" aria-hidden="true" />
        A fifth or more
      </span>
    </div>
  );
}

/**
 * The plan as a list, one row per step, indented the way the tree is nested,
 * with every detail the plan gave. The bar on the right is the step's share
 * of the query rather than a bare number: a plan where one step owns eighty
 * per cent of the run is the thing worth seeing, and "412 ms" next to "38 ms"
 * does not show it nearly as fast as two bars do.
 */
function PlanTable({ plan }: { plan: PlanSummary }) {
  return (
    <Card className="p-0 overflow-hidden">
      {plan.steps.map((step) => (
        <PlanRow key={step.id} step={step} plan={plan} />
      ))}
    </Card>
  );
}

function PlanRow({ step, plan }: { step: PlanStep; plan: PlanSummary }) {
  // Worded by stepFigures, like the step's box in the tree, so the two views
  // can never count a step's rows differently.
  const figures = stepFigures(step, plan.measured);
  const caption = subqueryCaption(step);

  return (
    <div
      className={`px-4 py-3 flex gap-3 plan-tint-${shareBand(step.share)}`}
      style={{ borderTop: step.id === 0 ? undefined : "1px solid var(--border)" }}
    >
      {/* The depth is drawn rather than described, so a deep plan still reads
          as a shape and not as a wall of identical rows. */}
      <div style={{ width: step.depth * 14, flex: "none" }} />

      <div className="min-w-0 flex-1 space-y-1">
        {caption !== null && <div className="plan-node-caption">{caption}</div>}
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="mono text-[10.5px]" style={{ color: "var(--text-3)" }}>
            {step.id + 1}
          </span>
          <span className="mono text-[12.5px]" style={{ color: "var(--text)" }}>
            {step.label}
          </span>
          {plan.heaviestStepId === step.id && (
            <Pill tone="brand">{heaviestStepLabel(plan.basis)}</Pill>
          )}
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

      <div className="text-right flex-none space-y-0.5" style={{ width: 150 }}>
        <div className="mono text-[11.5px]" style={{ color: "var(--text-2)" }}>
          {figures.rows}
        </div>
        {figures.runs !== null && (
          <div className="mono text-[11px]" style={{ color: "var(--text-3)" }}>
            {figures.runs}
          </div>
        )}
        {plan.measured && step.selfMs !== null && (
          <div
            className="mono text-[11px]"
            style={{ color: "var(--text-3)" }}
            title="Time spent in this step itself, not counting the steps below it"
          >
            {round(step.selfMs)} ms on its own
          </div>
        )}
        <div className="flex justify-end pt-0.5">
          <ShareMeter share={step.share} basis={plan.basis} />
        </div>
      </div>
    </div>
  );
}

/** At most two decimals, without printing "12.00". */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
