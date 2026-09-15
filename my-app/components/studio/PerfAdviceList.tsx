"use client";

import { useEffect, useState } from "react";
import { Card, EmptyState, Skeleton } from "@/components/ui";
import { AlertCircleIcon, CheckIcon, RefreshIcon } from "@/components/ui/icons";
import {
  FindingCard,
  OriginBadge,
  SeverityFilter,
  activeFilter,
  type FilterKey,
} from "./FindingCard";
import type { PerfTarget } from "./PerfTargetPicker";
import { FixScriptBuilder } from "./FixScriptBuilder";
// A type-only import: erased at build time, so nothing from the server side of
// lib/perf-advice.ts reaches the browser. One definition, shared with the route
// that produces the response, means the two can never silently disagree.
import type { AdviceItem, AdviceView } from "@/lib/perf-advice";

/**
 * Spec feature 09 — performance suggestions, as a screen.
 *
 * Reads GET /api/performance/advice and lays the findings out worst-first. Two
 * things about the presentation are deliberate rather than decorative:
 *
 *  • Every finding says where it came from. "This foreign key has no index" is
 *    simply true of the schema; "this index has not been used" is true only of
 *    what one server's counters saw since they last started, which a reset or
 *    a crash moves forward. A reader who cannot tell those apart will
 *    eventually drop an index that a quarterly report needs.
 *  • Every finding says what kind of fix it carries, above the fix itself: a
 *    schema change (SQL to save as a migration, with the statement that undoes
 *    it), maintenance to run by hand, or a decision set out as comments. A
 *    reader who cannot tell a DROP INDEX from an ANALYZE before copying it
 *    will one day paste the wrong one into a live server.
 */

const ORIGIN_META: Record<AdviceItem["origin"], { label: string; help: string }> = {
  structure: {
    label: "From the schema",
    help: "True of the schema as it is defined right now — no counters involved.",
  },
  statistics: {
    label: "From live counters",
    help:
      "Read from this server's own usage counters. They reach back only to their " +
      "last reset or crash, and they do not include read replicas.",
  },
};

/** One completed request, tagged with the request it answers. */
type Loaded = { key: string; view: AdviceView | null; error: string | null };

export function PerfAdviceList({ target }: { target: PerfTarget | null }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  // Bumped by "Run again". Part of the request key below, so asking again is
  // asking about a different key and the screen goes back to its skeleton.
  const [reload, setReload] = useState(0);

  const connectionId = target?.connectionId ?? "";
  const schema = target?.schema ?? "";
  const key = `${connectionId}\u0000${schema}\u0000${reload}`;

  useEffect(() => {
    if (!connectionId || !schema) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/performance/advice?connectionId=${encodeURIComponent(connectionId)}` +
            `&schema=${encodeURIComponent(schema)}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (cancelled) return;
        setLoaded(
          res.ok
            ? { key, view: data as AdviceView, error: null }
            : { key, view: null, error: data?.error ?? "Could not analyse this schema." }
        );
      } catch {
        if (cancelled) return;
        setLoaded({
          key,
          view: null,
          error: "Could not reach the server to analyse this schema.",
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [connectionId, schema, key]);

  // Which request the answer on screen belongs to is derived, not stored: the
  // moment the target changes, `key` changes and last time's answer stops
  // matching, so the skeleton comes back without a setState inside an effect.
  const current = loaded && loaded.key === key ? loaded : null;

  if (!connectionId || !schema) {
    return (
      <Card className="p-6 text-[13px]" style={{ color: "var(--text-3)" }}>
        Choose a PostgreSQL connection and a schema above to analyse it.
      </Card>
    );
  }

  if (current === null) return <AdviceSkeleton />;

  const view = current.view;
  if (!view) {
    return (
      <div className="warn-inline">
        <AlertCircleIcon size={15} className="ico" />
        <div>
          <div className="title">Could not analyse this schema</div>
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

  const active = activeFilter(filter, view.counts);
  const shown =
    active === "all" ? view.advice : view.advice.filter((a) => a.severity === active);

  return (
    <div className="space-y-4">
      <SummaryBar view={view} onRerun={() => setReload((n) => n + 1)} />

      {view.statsUnavailable && (
        <div className="warn-inline">
          <AlertCircleIcon size={15} className="ico" />
          <div>
            <div className="title">Live counters could not be read</div>
            <div className="body">
              {view.statsUnavailable}{" "}
              {"Only the checks on the schema itself could run. The ones that need " +
                "live counters look for unused and invalid indexes, unfinished indexes " +
                "on partitioned tables, tables mostly read by sequential scans, dead " +
                "rows waiting for cleanup, tables with no planner statistics, and " +
                "reads that miss the buffer cache."}
            </div>
          </div>
        </div>
      )}

      {view.counts.total === 0 ? (
        <Card className="p-0 overflow-hidden">
          <div style={{ height: 280 }}>
            <EmptyState
              icon={<CheckIcon size={22} />}
              title="Nothing to flag"
              description={
                // Without the counters, only the schema's own checks ran, so
                // "nothing to flag" must not speak for the ones that did not.
                view.statsUnavailable
                  ? `None of the checks on the schema itself found anything in ` +
                    `${view.schema}. That covers missing keys and indexes, ` +
                    `duplicated indexes, and column types that cost more than they ` +
                    `need to. The checks that need live counters could not run ` +
                    `(see above), so this says nothing about unused or invalid ` +
                    `indexes or how these tables are being read.`
                  : `None of the checks found anything in ${view.schema}. That covers ` +
                    `missing keys and indexes, duplicated, unused and invalid indexes, ` +
                    `column types that cost more than they need to, and how the ` +
                    `server says these tables are actually being read.`
              }
            />
          </div>
        </Card>
      ) : (
        <>
          <SeverityFilter counts={view.counts} value={active} onChange={setFilter} />
          <div className="space-y-2.5">
            {shown.map((item, i) => (
              <FindingCard
                key={`${item.id}-${item.object}-${i}`}
                severity={item.severity}
                title={item.title}
                object={item.object}
                detail={item.detail}
                fix={item.fix}
                fixKind={item.fixKind}
                undo={item.undo}
                action={item.action}
                badge={<OriginBadge {...ORIGIN_META[item.origin]} />}
              />
            ))}
          </div>
          <p className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
            Showing {shown.length} of {view.counts.total} suggestion
            {view.counts.total === 1 ? "" : "s"} · most serious first.
          </p>
          {/* Every suggestion, whatever the filter shows: the ticks say what goes in. */}
          <FixScriptBuilder
            items={view.advice}
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
  );
}

/** "12 suggestions across 9 tables in shop_dev" plus the re-run button. */
function SummaryBar({ view, onRerun }: { view: AdviceView; onRerun: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div className="text-[13px]" style={{ color: "var(--text-2)" }}>
        <span className="mono" style={{ color: "var(--text)" }}>
          {view.schema}
        </span>{" "}
        on {view.connectionName} · {view.tablesAnalyzed} table
        {view.tablesAnalyzed === 1 ? "" : "s"} analysed ·{" "}
        {view.counts.total === 0
          ? "no suggestions"
          : `${view.counts.total} suggestion${view.counts.total === 1 ? "" : "s"}`}
      </div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onRerun}>
        <RefreshIcon size={12} /> Run again
      </button>
    </div>
  );
}

function AdviceSkeleton() {
  return (
    <div className="space-y-2.5">
      <Skeleton width={280} height={18} />
      {[0, 1, 2].map((i) => (
        <Card key={i} className="p-4 space-y-2.5">
          <Skeleton width={220} height={16} />
          <Skeleton width="70%" height={14} />
          <Skeleton width="100%" height={56} radius={8} />
        </Card>
      ))}
    </div>
  );
}
