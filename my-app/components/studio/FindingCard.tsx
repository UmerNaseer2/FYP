"use client";

import { useState } from "react";
import { Card, Pill, type PillTone } from "@/components/ui";
import { CheckIcon, ClipboardIcon } from "@/components/ui/icons";

/**
 * One piece of performance advice, however it was arrived at.
 *
 * Shared by both halves of the Performance section — the schema suggestions of
 * feature 09 and the query analysis of feature 08 — because they are the same
 * kind of statement and should not look like two different products. A finding
 * says how serious it is, what it is about, why, and what to do; the only thing
 * that varies is an optional badge saying where it came from, which the
 * suggestions screen uses and the analyser does not need.
 */

export type FindingSeverity = "high" | "medium" | "low";

export type FindingCounts = {
  high: number;
  medium: number;
  low: number;
  total: number;
};

/**
 * Severity as a colour and a word.
 *
 * "break" and "drift" are the existing status tones, borrowed rather than
 * invented: the app already teaches that red is broken and amber is worth a
 * look, and a third vocabulary for the same idea would only have to be learned.
 */
export const SEVERITY_META: Record<
  FindingSeverity,
  { tone: PillTone; label: string; color: string }
> = {
  high: { tone: "break", label: "High", color: "var(--break)" },
  medium: { tone: "drift", label: "Medium", color: "var(--drift)" },
  low: { tone: "neutral", label: "Low", color: "var(--text-3)" },
};

export type FilterKey = "all" | FindingSeverity;

export function FindingCard({
  severity,
  title,
  object,
  detail,
  fix,
  badge,
}: {
  severity: FindingSeverity;
  title: string;
  object: string;
  detail: string;
  fix: string;
  /** Optional extra chip beside the severity pill — e.g. where this came from. */
  badge?: React.ReactNode;
}) {
  const meta = SEVERITY_META[severity];
  return (
    <Card className="p-0 overflow-hidden">
      {/* The stripe repeats the severity pill in a form you can scan a column
          of without reading any of them. */}
      <div className="flex" style={{ borderLeft: `3px solid ${meta.color}` }}>
        <div className="p-4 space-y-2.5 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Pill tone={meta.tone}>{meta.label}</Pill>
            {badge}
            <span className="mono text-[12px]" style={{ color: "var(--text-3)" }}>
              {object}
            </span>
          </div>

          <div className="text-[14px] font-semibold tracking-[-0.01em]">{title}</div>

          <p className="text-[13px] leading-[1.6]" style={{ color: "var(--text-2)" }}>
            {detail}
          </p>

          <FixBlock fix={fix} />
        </div>
      </div>
    </Card>
  );
}

/** A small outlined chip, for saying where a finding came from. */
export function OriginBadge({ label, help }: { label: string; help: string }) {
  return (
    <span
      className="text-[11px] px-1.5 py-0.5 rounded"
      style={{ border: "1px solid var(--border)", color: "var(--text-3)" }}
      title={help}
    >
      {label}
    </span>
  );
}

/**
 * The suggested fix, copyable — usually SQL, sometimes SQL under a sentence.
 *
 * Renders nothing at all when there is no fix. Some findings genuinely have no
 * SQL to hand over ("no index is used anywhere in this plan" is a fact about
 * the whole query, not a missing statement), and an empty code box under those
 * would read as a fix that failed to load.
 */
export function FixBlock({ fix }: { fix: string }) {
  const [copied, setCopied] = useState(false);

  if (!fix.trim()) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(fix);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (e.g. an insecure context) — leave the button as-is.
    }
  }

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ border: "1px solid var(--border)", background: "var(--surface-2)" }}
    >
      <div
        className="flex items-center justify-between gap-2 px-3 py-1.5"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <span
          className="text-[10px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: "var(--text-3)" }}
        >
          Suggested fix
        </span>
        <button type="button" className="btn btn-ghost btn-xs" onClick={copy}>
          {copied ? <CheckIcon size={11} /> : <ClipboardIcon size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="sql px-3 py-2.5 overflow-x-auto whitespace-pre-wrap">{fix}</pre>
    </div>
  );
}

/** All / High / Medium / Low chips, each carrying its own count. */
export function SeverityFilter({
  counts,
  value,
  onChange,
}: {
  counts: FindingCounts;
  value: FilterKey;
  onChange: (next: FilterKey) => void;
}) {
  const options: { key: FilterKey; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.total },
    { key: "high", label: "High", count: counts.high },
    { key: "medium", label: "Medium", count: counts.medium },
    { key: "low", label: "Low", count: counts.low },
  ];
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {options.map((o) => {
        const active = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            // A severity with nothing in it is a filter onto an empty list.
            disabled={o.count === 0}
            onClick={() => onChange(o.key)}
            className="text-[12.5px] px-2.5 py-1 rounded-md transition-colors disabled:opacity-45"
            style={{
              border: "1px solid var(--border)",
              background: active ? "var(--text)" : "var(--surface)",
              color: active ? "var(--surface)" : "var(--text-2)",
            }}
          >
            {o.label}
            <span className="mono ml-1.5 opacity-60">{o.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Keep a severity filter from selecting an empty list.
 *
 * A filter left on "High" from the previous run, where this run has no high
 * findings, would show an empty list underneath a full set of counts — which
 * reads as "the results failed to load", not as "you have a filter on".
 */
export function activeFilter(filter: FilterKey, counts: FindingCounts): FilterKey {
  return filter !== "all" && counts[filter] === 0 ? "all" : filter;
}
