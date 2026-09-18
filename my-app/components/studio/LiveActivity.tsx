"use client";

import { useEffect, useState } from "react";
import { Card, EmptyState, Pill, Skeleton, type PillTone } from "@/components/ui";
import { AlertCircleIcon, GaugeIcon, RefreshIcon } from "@/components/ui/icons";
import {
  ACTIVITY_KIND_LABEL,
  type ActivityKind,
  type ActivitySession,
} from "@/lib/db-activity";
import type { ThresholdBreach } from "@/lib/perf-thresholds";
import { ThresholdBanner } from "./ThresholdBanner";
import type { PerfTarget } from "./PerfTargetPicker";

/**
 * Spec feature 10 — "Long-Running Query Detection", as a screen.
 *
 * Everything on this screen is true for the instant it was read and for no
 * longer. That is the one thing the design has to carry, and it does it in
 * three ways: the reading is stamped with the moment it was taken, refreshing
 * is a button the reader presses rather than a timer that quietly redraws under
 * them, and nothing is stored — there is no history here, because a list of
 * sessions that were running four hours ago is not something anyone can act on.
 *
 * There is deliberately no "kill this session" button. Terminating somebody
 * else's backend is destructive, irreversible from here, and impossible to
 * undo the consequences of; this screen tells you the pid so you can go and
 * decide about it with the tools and the authority to do it.
 */

/** Mirrors ActivityView in app/api/performance/activity/route.ts. */
type ActivityView = {
  connectionName: string;
  database: string;
  takenAt: string;
  longRunningSeconds: number;
  thresholdConfigured: boolean;
  sessions: ActivitySession[];
  summary: {
    total: number;
    blocked: number;
    idleInTransaction: number;
    longRunning: number;
    anyHidden: boolean;
  };
  emptyMessage: string;
  hiddenNote: string | null;
  breaches: ThresholdBreach[];
};

/** Worst kinds get the loud colour; an ordinary running query gets none. */
const KIND_TONE: Record<ActivityKind, PillTone> = {
  blocked: "break",
  "idle-in-transaction": "break",
  "long-running": "drift",
  running: "neutral",
};

type Loaded = { key: string; view: ActivityView | null; error: string | null };

export function LiveActivity({ target }: { target: PerfTarget | null }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reload, setReload] = useState(0);

  const connectionId = target?.connectionId ?? "";
  const schema = target?.schema ?? "";
  const key = `${connectionId} ${schema} ${reload}`;

  useEffect(() => {
    if (!connectionId || !schema) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/performance/activity?connectionId=${encodeURIComponent(connectionId)}` +
            `&schema=${encodeURIComponent(schema)}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (cancelled) return;
        setLoaded(
          res.ok
            ? { key, view: data as ActivityView, error: null }
            : {
                key,
                view: null,
                error: data?.error ?? "Could not read what this server is doing.",
              }
        );
      } catch {
        if (cancelled) return;
        setLoaded({
          key,
          view: null,
          error: "Could not reach the server to read its activity.",
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [connectionId, schema, key]);

  const current = loaded && loaded.key === key ? loaded : null;

  if (!connectionId || !schema) {
    return (
      <Card className="p-6 text-[13px]" style={{ color: "var(--text-3)" }}>
        Choose a PostgreSQL connection and a schema above to see what that server
        is doing right now.
      </Card>
    );
  }

  if (current === null) {
    return (
      <Card className="p-4 space-y-3">
        <Skeleton width={260} height={16} />
        <Skeleton width="100%" height={54} />
        <Skeleton width="100%" height={54} />
      </Card>
    );
  }

  const view = current.view;
  if (!view) {
    return (
      <div className="warn-inline">
        <AlertCircleIcon size={15} className="ico" />
        <div>
          <div className="title">Could not read this server&apos;s activity</div>
          <div className="body">
            {current.error}{" "}
            <button type="button" className="underline" onClick={() => setReload((n) => n + 1)}>
              Try again
            </button>
            .
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ThresholdBanner
        breaches={view.breaches}
        connectionId={connectionId}
        schema={schema}
      />

      <Card className="p-4 space-y-2.5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Pill tone={view.summary.total === 0 ? "sync" : "neutral"}>
              {view.summary.total} active
            </Pill>
            {view.summary.blocked > 0 && (
              <Pill tone="break">{view.summary.blocked} waiting for a lock</Pill>
            )}
            {view.summary.idleInTransaction > 0 && (
              <Pill tone="break">{view.summary.idleInTransaction} idle in a transaction</Pill>
            )}
            {view.summary.longRunning > 0 && (
              <Pill tone="drift">{view.summary.longRunning} long-running</Pill>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setReload((n) => n + 1)}
          >
            <RefreshIcon size={13} /> Read again
          </button>
        </div>

        <div className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
          As of {new Date(view.takenAt).toLocaleTimeString()} on{" "}
          <span className="mono">{view.database}</span>. Nothing here refreshes on
          its own — this is one reading, and it is already out of date. Anything
          on the same statement for more than {view.longRunningSeconds}s counts as
          long-running
          {view.thresholdConfigured
            ? ", which is the limit set for this schema."
            : ", which is this app's own default because no limit has been set."}
        </div>

        {view.hiddenNote && (
          <div className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
            {view.hiddenNote}
          </div>
        )}
      </Card>

      {view.sessions.length === 0 ? (
        <Card className="p-0 overflow-hidden">
          <div style={{ height: 260 }}>
            <EmptyState
              icon={<GaugeIcon size={22} />}
              title="Nothing is running"
              description={view.emptyMessage}
            />
          </div>
        </Card>
      ) : (
        <div className="space-y-2.5">
          {view.sessions.map((session) => (
            <SessionCard key={session.pid} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionCard({ session }: { session: ActivitySession }) {
  return (
    <Card className="p-3.5 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Pill tone={KIND_TONE[session.kind]}>{ACTIVITY_KIND_LABEL[session.kind]}</Pill>
        <span className="text-[12.5px] font-medium tabular-nums" style={{ color: "var(--text)" }}>
          {formatDuration(session.querySeconds)}
        </span>
        <span className="text-[11.5px] mono" style={{ color: "var(--text-3)" }}>
          pid {session.pid}
        </span>
      </div>

      <div className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
        {session.username ?? "unknown user"}
        {session.applicationName ? ` · ${session.applicationName}` : ""}
        {session.clientAddr ? ` · ${session.clientAddr}` : " · local socket"}
        {" · state "}
        <span className="mono">{session.state}</span>
        {session.waitingOn ? ` · waiting on ${session.waitingOn}` : ""}
        {session.xactSeconds !== null &&
          ` · transaction open ${formatDuration(session.xactSeconds)}`}
      </div>

      {session.queryHidden ? (
        <div className="text-[12px]" style={{ color: "var(--text-2)" }}>
          PostgreSQL did not show this session&apos;s SQL to the login this app is
          using. Everything else about it is above.
        </div>
      ) : session.query ? (
        <pre
          className="text-[11.5px] mono p-2.5 rounded-md overflow-auto"
          style={{
            background: "var(--surface-2, var(--surface))",
            border: "1px solid var(--border)",
            color: "var(--text-2)",
            maxHeight: 140,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {session.query}
        </pre>
      ) : (
        <div className="text-[12px]" style={{ color: "var(--text-2)" }}>
          This session is not running a statement.
        </div>
      )}
    </Card>
  );
}

/**
 * Seconds as something readable.
 *
 * Sub-second durations keep a decimal: the difference between 0.2s and 0.9s is
 * the difference between fine and worth a look, and both round to "0s".
 */
function formatDuration(seconds: number | null): string {
  if (seconds === null) return "unknown";
  if (seconds < 1) return `${seconds.toFixed(2)}s`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
