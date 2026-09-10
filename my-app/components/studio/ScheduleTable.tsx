"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircleIcon,
  Card,
  EmptyState,
  Pill,
  RefreshIcon,
  Skeleton,
} from "@/components/ui";
import { Select } from "@/components/ui/Select";
import { useNow } from "@/hooks/useNow";
import { DRIFT_INTERVAL_CHOICES } from "@/lib/drift-schedule";

/** One row of the cadence table (mirrors ScheduleRow on the server). */
export type ScheduleRow = {
  trackedSchemaId: number;
  label: string | null;
  schemaName: string;
  connectionName: string;
  intervalMinutes: number;
  cadence: string;
  lastCheckedAt: string | null;
  nextDueAt: string | null;
  due: boolean;
};

type SchedulerStatus = {
  running: boolean;
  stoppedReason: string | null;
  ticks: number;
  checksRun: number;
  lastTickAt: string | null;
  lastTickSummary: string | null;
  tickSeconds: number;
};

type ScheduleView = {
  scheduler: SchedulerStatus;
  choices: ReadonlyArray<{ minutes: number; label: string }>;
  rows: ScheduleRow[];
};

/** "3m ago" for a past instant, against a clock the caller controls. */
function ago(iso: string | null, now: number | null): string {
  if (!iso || now === null) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const mins = Math.floor(Math.max(0, now - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** "in 8m" for a future instant, "now" once it has passed. */
function until(iso: string | null, now: number | null): string {
  if (!iso || now === null) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const mins = Math.round((then - now) / 60_000);
  if (mins <= 0) return "now";
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  return `in ${Math.round(hrs / 24)}d`;
}

/**
 * The automatic-checking screen: what the background loop is doing, and how
 * often each tracked schema is checked.
 *
 * Two things a user has to be able to answer here and could not before. "Is
 * anything actually watching this?" — the banner says whether the loop is
 * running and what its last pass did. "When will it next look?" — every row
 * carries its own countdown. The ages tick on their own (useNow) and the whole
 * view refetches once a minute, so a screen left open stays honest rather than
 * freezing at whatever it said when it loaded.
 */
export function ScheduleTable() {
  const [view, setView] = useState<ScheduleView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const now = useNow(15_000);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/lineage/schedule");
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not read the checking schedule.");
        return;
      }
      setError(null);
      setView(data as ScheduleView);
    } catch {
      setError("Could not reach the server to read the checking schedule.");
    }
  }, []);

  useEffect(() => {
    void load();
    // A minute matches the loop's own tick: any faster and the screen asks
    // questions the scheduler has not had a chance to answer differently.
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  async function setCadence(row: ScheduleRow, minutes: number) {
    setSaving(row.trackedSchemaId);
    setSaveError(null);
    try {
      const res = await fetch("/api/lineage/schedule", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackedSchemaId: row.trackedSchemaId, intervalMinutes: minutes }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveError(data?.error ?? "Could not save that cadence.");
        return;
      }
      await load();
    } catch {
      setSaveError("Could not reach the server to save that cadence.");
    } finally {
      setSaving(null);
    }
  }

  if (error && !view) {
    return (
      <Card className="p-0 overflow-hidden">
        <div style={{ height: 240 }}>
          <EmptyState
            icon={<AlertCircleIcon size={22} />}
            title="Could not read the checking schedule"
            description={error}
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

  if (!view) {
    return (
      <div className="space-y-3">
        <Skeleton height={72} />
        <Skeleton height={220} />
      </div>
    );
  }

  const { scheduler, rows } = view;
  const automatic = rows.filter((r) => r.intervalMinutes > 0).length;
  const options = DRIFT_INTERVAL_CHOICES.map((c) => ({
    value: String(c.minutes),
    label: c.label,
  }));

  return (
    <div className="space-y-5">
      {/* Is anything watching? */}
      <Card className="p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Pill tone={scheduler.running ? "sync" : "neutral"} dot={scheduler.running}>
                {scheduler.running ? "Running" : "Not running"}
              </Pill>
              <span className="text-[13px] font-medium">Automatic drift checking</span>
            </div>
            <p className="text-[12.5px] mt-1.5 max-w-[70ch]" style={{ color: "var(--text-2)" }}>
              {scheduler.running
                ? `This server wakes every ${scheduler.tickSeconds}s and checks whichever tracked ` +
                  `schemas are due. ${automatic} of ${rows.length} ` +
                  `${rows.length === 1 ? "schema is" : "schemas are"} on a cadence.`
                : scheduler.stoppedReason ??
                  "Nothing is checking these schemas on its own. Checks only run when you press Check drift now."}
            </p>
            {scheduler.running && scheduler.lastTickSummary && (
              <p className="text-[12px] mt-1" style={{ color: "var(--text-3)" }}>
                Last pass {ago(scheduler.lastTickAt, now)} · {scheduler.lastTickSummary}
              </p>
            )}
          </div>
          <div className="text-right text-[12px] shrink-0" style={{ color: "var(--text-3)" }}>
            <div className="mono">{scheduler.checksRun} checks this run</div>
            <button
              type="button"
              className="btn btn-secondary btn-sm mt-2"
              onClick={() => void load()}
            >
              <RefreshIcon size={13} /> Refresh
            </button>
          </div>
        </div>
      </Card>

      {saveError && (
        <div className="warn-inline">
          <span className="ico" style={{ color: "var(--break)" }}>
            <AlertCircleIcon size={14} />
          </span>
          <div className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
            {saveError}
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <Card className="p-0 overflow-hidden">
          <div style={{ height: 240 }}>
            <EmptyState
              icon={<AlertCircleIcon size={22} />}
              title="No schemas are being tracked"
              description="The cadence is set per schema, so there is nothing to schedule until one is tracked. Tracking starts on the Dashboard: pick a connection and a schema, and the first snapshot becomes its baseline."
              actions={
                <Link href="/studio" className="btn btn-primary btn-sm">
                  Go to the Dashboard
                </Link>
              }
            />
          </div>
        </Card>
      ) : (
        <div className="panel p-0 overflow-hidden">
          <table
            className="responsive-table w-full text-[12.5px]"
            style={{ borderCollapse: "collapse" }}
          >
            <thead>
              <tr
                className="text-left"
                style={{ color: "var(--text-3)", borderBottom: "1px solid var(--border)" }}
              >
                <th className="px-3 py-2.5 font-medium">Schema</th>
                <th className="px-3 py-2.5 font-medium">How often</th>
                <th className="px-3 py-2.5 font-medium">Last checked</th>
                <th className="px-3 py-2.5 font-medium">Next check</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.trackedSchemaId} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="px-3 py-2.5" data-label="Schema">
                    <Link
                      href={`/drift?tab=detail&schema=${r.trackedSchemaId}`}
                      className="mono"
                      style={{ color: "var(--text)" }}
                    >
                      {r.label ?? r.schemaName}
                    </Link>
                    <div className="text-[11px]" style={{ color: "var(--text-3)" }}>
                      {r.connectionName}
                    </div>
                  </td>
                  <td className="px-3 py-2.5" data-label="How often" style={{ minWidth: 180 }}>
                    <Select
                      value={String(r.intervalMinutes)}
                      options={options}
                      variant="input"
                      disabled={saving === r.trackedSchemaId}
                      ariaLabel={`How often to check ${r.schemaName}`}
                      onChange={(v) => void setCadence(r, Number(v))}
                    />
                  </td>
                  <td className="px-3 py-2.5" data-label="Last checked">
                    <span className="mono whitespace-nowrap" style={{ color: "var(--text-2)" }}>
                      {r.lastCheckedAt ? ago(r.lastCheckedAt, now) : "never"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5" data-label="Next check">
                    {r.intervalMinutes === 0 ? (
                      <span style={{ color: "var(--text-3)" }}>manual only</span>
                    ) : (
                      <span
                        className="mono whitespace-nowrap"
                        style={{ color: r.due ? "var(--pending)" : "var(--text-2)" }}
                      >
                        {r.lastCheckedAt ? until(r.nextDueAt, now) : "now — never checked"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
        An automatic check records an audit row only when the result changes, so a schema that
        stays in sync does not fill the log. The <b>Last checked</b> column is stamped every
        time, whatever the result.
      </p>
    </div>
  );
}
