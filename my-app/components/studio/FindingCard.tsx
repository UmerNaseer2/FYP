"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Pill, type PillTone } from "@/components/ui";
import { CheckIcon, ClipboardIcon } from "@/components/ui/icons";
// Type-only: erased at build time, so nothing from lib/ reaches the browser.
import type { FixKind } from "@/lib/perf-sql";

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
  fixKind,
  fixHeading,
  undo,
  action,
  badge,
  step,
}: {
  severity: FindingSeverity;
  title: string;
  object: string;
  detail: string;
  fix: string;
  /** What kind of fix `fix` is; decides the heading above it. */
  fixKind: FixKind;
  /**
   * A heading to show instead of the usual one for `fixKind`, when those words
   * do not fit this fix: a change to another schema's table on the Analyse
   * tab, which is not saved as a migration (see otherSchemaHeading).
   */
  fixHeading?: string;
  /** The statement that takes the fix back out, shown under it when present. */
  undo?: string;
  /**
   * A link to the place in the app where the next step is taken, shown under
   * the explanation: "Analyse a query on this table", for example.
   */
  action?: { label: string; href: string };
  /** Optional extra chip beside the severity pill — e.g. where this came from. */
  badge?: React.ReactNode;
  /**
   * The plan step this finding is about, as its id (0-based), or null/absent
   * when it is not about one step. Shown as "Step 3" — the same number the
   * plan tree and the step list print — so the reader can find it there.
   */
  step?: number | null;
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
            {step !== undefined && step !== null && (
              <span
                className="mono text-[11px] px-1.5 py-0.5 rounded"
                style={{ border: "1px solid var(--border)", color: "var(--text-2)" }}
                title="The step in the plan above that this is about"
              >
                Step {step + 1}
              </span>
            )}
            <span className="mono text-[12px]" style={{ color: "var(--text-3)" }}>
              {object}
            </span>
          </div>

          <div className="text-[14px] font-semibold tracking-[-0.01em]">{title}</div>

          <p className="text-[13px] leading-[1.6]" style={{ color: "var(--text-2)" }}>
            {detail}
          </p>

          {action && (
            <div>
              <Link href={action.href} className="btn btn-secondary btn-sm">
                {action.label}
              </Link>
            </div>
          )}

          <FixBlock fix={fix} fixKind={fixKind} heading={fixHeading} undo={undo} />
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
 * What the heading above each kind of fix says, so the reader knows what
 * running it would do before copying anything. The kinds themselves are
 * defined, with what each one means, in lib/perf-sql.ts.
 */
export const FIX_KIND_HEADING: Record<FixKind, string> = {
  change: "Schema change: save it as a migration",
  maintenance: "Maintenance: run it by hand",
  query: "Change the query: nothing runs on the server",
  decision: "Needs your decision",
};

/**
 * The heading above the undo: "To put it back" when the fix removes
 * something (its first statement is a DROP), "To undo" otherwise.
 *
 * Under a DROP INDEX the undo is the CREATE INDEX that rebuilds it, and
 * "To undo" above that would read as if the CREATE were the thing to avoid.
 */
export function undoHeading(fix: string): string {
  const firstStatement = fix
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("--"));
  return firstStatement !== undefined && /^DROP\b/i.test(firstStatement)
    ? "To put it back"
    : "To undo";
}

/**
 * The fix under a heading naming its kind, and under that the statement that
 * undoes it, when there is one. Both can be copied.
 *
 * Renders nothing at all when the fix is empty: an empty code box would read
 * as a fix that failed to load. Every rule on both tabs sets one, and
 * tests/helpers/fix-invariants.ts holds each of them to it, so this is a guard
 * rather than a case the screens rely on.
 */
export function FixBlock({
  fix,
  fixKind,
  heading,
  undo,
}: {
  fix: string;
  fixKind: FixKind;
  /** Shown instead of the usual heading for `fixKind` (see FindingCard). */
  heading?: string;
  undo?: string;
}) {
  if (!fix.trim()) return null;
  return (
    <div className="space-y-2">
      <CodeBox heading={heading ?? FIX_KIND_HEADING[fixKind]} text={fix} />
      {undo !== undefined && undo.trim() !== "" && (
        <CodeBox heading={undoHeading(fix)} text={undo} />
      )}
    </div>
  );
}

/** One block of SQL under a small heading, with its own Copy button. */
function CodeBox({ heading, text }: { heading: string; text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
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
        <span className="text-[11.5px] font-semibold" style={{ color: "var(--text-2)" }}>
          {heading}
        </span>
        <button type="button" className="btn btn-ghost btn-xs" onClick={copy}>
          {copied ? <CheckIcon size={11} /> : <ClipboardIcon size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="sql px-3 py-2.5 overflow-x-auto whitespace-pre-wrap">{text}</pre>
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
            // Which chip is on is otherwise carried by its colour alone, and a
            // screen reader hears four identical buttons. components/ui's own
            // FilterPill has said this for its bars from the start.
            aria-pressed={active}
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
