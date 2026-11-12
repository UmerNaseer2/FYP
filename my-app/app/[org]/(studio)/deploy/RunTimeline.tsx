"use client";

// The timeline at the top of Deploy: everything that was run against this
// schema from here, laid out by date. It is built only from the attempt rows
// the page already loads (/api/scripts/attempts), so a run that failed or was
// refused shows up too, with the reason the server gave.

import { useState } from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  EyeIcon,
  RefreshIcon,
  XIcon,
} from "@/components/ui/icons";
import { HelpHint } from "@/components/ui/HelpHint";
import { describeAttempt, type DeployAttemptRow } from "@/lib/deploy-attempts";
import { shortUtcDate } from "@/lib/format-date";
import { vLabel } from "@/lib/rollback-plan";

type Kind = "ship" | "back" | "stop" | "dry" | "unknown";

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGES = [7, 30, 90];
// Markers closer than this (in percent of the track) fold into one numbered
// marker, so two runs a minute apart do not sit on top of each other.
const FOLD_PERCENT = 5;

const KIND_WORD: Record<Kind, string> = {
  ship: "Shipped",
  back: "Rolled back",
  stop: "Stopped",
  dry: "Rehearsed",
  unknown: "Outcome unknown",
};

// What kind of marker a row gets. Every answer comes from the row itself.
function kindOf(row: DeployAttemptRow): Kind {
  if (row.outcome === "unknown") return "unknown";
  if (row.outcome !== "applied") return "stop";
  if (row.dry_run) return "dry";
  // A rollback is stored in the same table, its detail starting "Rollback".
  if (row.detail?.startsWith("Rollback")) return "back";
  return "ship";
}

function KindIcon({ kind }: { kind: Kind }) {
  if (kind === "ship") return <CheckIcon size={14} />;
  if (kind === "back") return <RefreshIcon size={14} />;
  if (kind === "stop") return <XIcon size={14} />;
  if (kind === "dry") return <EyeIcon size={14} />;
  return <AlertTriangleIcon size={14} />;
}

// "orders v1.0.2", or "3 migrations, through v1.0.4" for a longer run.
function nameOf(row: DeployAttemptRow): string {
  if (row.scripts.length === 0) return "No scripts named";
  const last = row.scripts[row.scripts.length - 1];
  if (row.scripts.length === 1) return `${last.script_name} ${vLabel(last.version)}`;
  return `${row.scripts.length} migrations, through ${vLabel(last.version)}`;
}

function whenOf(row: DeployAttemptRow): string {
  return `${describeAttempt(row.outcome, row.dry_run)} · ${shortUtcDate(row.created_at)}${
    row.actor ? ` by ${row.actor}` : ""
  }`;
}

function axisDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

// One row of history: used in the panel under the track and in the full list.
function AttemptLine({ row }: { row: DeployAttemptRow }) {
  return (
    <>
      <div className="dp-hist-top">
        <span className="dp-hist-name">{nameOf(row)}</span>
        <span className={`dp-hist-meta${row.outcome === "applied" ? "" : " dp-strong"}`}>
          {whenOf(row)}
        </span>
      </div>
      {/* The reason, for the outcomes that have one. A refusal somebody has
          since closed the tab on can be read nowhere else. */}
      {row.detail && <div className="dp-hist-meta">{row.detail}</div>}
    </>
  );
}

type Group = { key: string; left: number; rows: DeployAttemptRow[] };

export function RunTimeline({
  attempts,
  schema,
  nextLabel,
}: {
  attempts: DeployAttemptRow[];
  schema: string;
  /** The run picked on this page and not started yet, or null when none is. */
  nextLabel: string | null;
}) {
  const [days, setDays] = useState(30);
  const [picked, setPicked] = useState<string | null>(null);
  // Read once, so the markers do not shift on every render.
  const [now] = useState(() => Date.now());

  const start = now - days * DAY_MS;
  // With a run waiting, the last tenth of the track is kept for its marker.
  const width = nextLabel ? 90 : 100;

  const inRange = attempts
    .filter((row) => {
      const at = Date.parse(row.created_at);
      return Number.isFinite(at) && at >= start;
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  const groups: Group[] = [];
  for (const row of inRange) {
    const at = Math.min(Date.parse(row.created_at), now);
    const left = ((at - start) / (now - start)) * width;
    const last = groups[groups.length - 1];
    if (last && left - last.left < FOLD_PERCENT) {
      last.rows.push(row);
    } else {
      groups.push({ key: String(row.id), left, rows: [row] });
    }
  }

  const pickedGroup = groups.find((group) => group.key === picked) ?? null;
  const nextPicked = picked === "next" && nextLabel !== null;

  return (
    <div className="card dp-card">
      <div className="dp-card-top">
        <h2 className="dp-h">
          What has run on <span className="mono">{schema}</span>
          <HelpHint label="What has run">
            Everything run against this schema from here, whether or not it
            landed. Failed and refused runs are listed too, with the reason.
          </HelpHint>
        </h2>
        <div className="dp-rng" role="group" aria-label="Time range">
          {RANGES.map((range) => (
            <button
              key={range}
              type="button"
              aria-pressed={days === range}
              onClick={() => {
                setDays(range);
                setPicked(null);
              }}
            >
              {`${range} days`}
            </button>
          ))}
        </div>
      </div>

      <div className="dp-track">
        <div className="dp-band" />
        <span className="dp-ax" style={{ left: "0%" }}>{axisDate(start)}</span>
        <span className="dp-ax" style={{ left: `${width / 2}%` }}>
          {axisDate(start + (now - start) / 2)}
        </span>
        <span className={`dp-ax${nextLabel ? "" : " dp-ax-end"}`} style={{ left: `${width}%` }}>
          today
        </span>
        {groups.map((group) => {
          const only = group.rows.length === 1 ? group.rows[0] : null;
          const kind = only ? kindOf(only) : null;
          const lastScript = only && only.scripts.length > 0 ? only.scripts[only.scripts.length - 1] : null;
          return (
            <button
              key={group.key}
              type="button"
              className={`dp-mk ${kind ? `dp-k-${kind}` : "dp-k-many"}`}
              style={{ left: `${group.left}%` }}
              aria-pressed={picked === group.key}
              aria-label={
                only && kind
                  ? `${KIND_WORD[kind]}: ${nameOf(only)}, ${shortUtcDate(only.created_at)}`
                  : `${group.rows.length} runs close together, from ${shortUtcDate(group.rows[0].created_at)}`
              }
              onClick={() => setPicked(picked === group.key ? null : group.key)}
            >
              {kind ? <KindIcon kind={kind} /> : group.rows.length}
              {lastScript && <span className="dp-tag">{vLabel(lastScript.version)}</span>}
            </button>
          );
        })}
        {nextLabel && (
          <button
            type="button"
            className="dp-mk dp-k-next"
            style={{ left: "100%" }}
            aria-pressed={nextPicked}
            aria-label={`This run, not started yet: ${nextLabel}`}
            onClick={() => setPicked(nextPicked ? null : "next")}
          >
            <span className="dp-tag">next</span>
          </button>
        )}
      </div>

      <div className="dp-tl-d" aria-live="polite">
        {nextPicked ? (
          <>
            <b>This run: {nextLabel}.</b> Not started yet. Rehearse it or ship it below.
          </>
        ) : pickedGroup ? (
          <ul>
            {pickedGroup.rows.map((row) => (
              <li key={row.id}>
                <b>{KIND_WORD[kindOf(row)]}.</b> <AttemptLine row={row} />
              </li>
            ))}
          </ul>
        ) : groups.length === 0 ? (
          attempts.length === 0 ? (
            "Nothing has been run on this schema from here yet."
          ) : (
            `Nothing was run on this schema in the last ${days} days. Try a longer range.`
          )
        ) : (
          "Pick a marker to see what ran, who ran it and how it ended."
        )}
      </div>

      <div className="dp-key">
        <span><i className="dp-k-ship" />Shipped</span>
        <span><i className="dp-k-dry" />Rehearsed</span>
        <span><i className="dp-k-back" />Rolled back</span>
        <span><i className="dp-k-stop" />Stopped</span>
        <span><i className="dp-k-unknown" />Outcome unknown</span>
        {nextLabel && <span><i className="dp-k-next" />This run</span>}
      </div>

      {attempts.length > 0 && (
        <details className="dp-tl-list">
          <summary>
            <ChevronDownIcon size={12} />
            {`Every attempt as a list (${attempts.length})`}
          </summary>
          {attempts.slice(0, 10).map((row) => (
            <div key={row.id} className="dp-hist">
              <AttemptLine row={row} />
            </div>
          ))}
          {attempts.length > 10 && (
            <div className="help mt-1">{`…and ${attempts.length - 10} more.`}</div>
          )}
        </details>
      )}
    </div>
  );
}
