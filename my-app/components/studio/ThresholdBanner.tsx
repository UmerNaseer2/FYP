"use client";

import Link from "next/link";
import { AlertCircleIcon } from "@/components/ui/icons";
import type { ThresholdBreach } from "@/lib/perf-thresholds";

/**
 * The banner shown when a reading broke an alert rule somebody set.
 *
 * Shared by the analyser and the live-activity screen, because a breach should
 * read identically wherever it fires — the same wording, the same colour, and
 * the same link to the rule that fired, so the reader can go and change it if
 * the rule is what is wrong.
 *
 * `warn-inline` rather than `banner`: banner is the red one, and it means the
 * app could not do what was asked. A breach is not a failure — the app did
 * exactly what was asked and is reporting the answer.
 *
 * Nothing renders when the list is empty, which is the normal case: every
 * threshold ships switched off (see lib/perf-thresholds.ts), so this is silent
 * until somebody asks for it.
 */
export function ThresholdBanner({
  breaches,
  connectionId,
  schema,
}: {
  breaches: ThresholdBreach[];
  /** For the link to the rules. Omitted when the screen has no target. */
  connectionId?: string | number;
  schema?: string;
}) {
  if (breaches.length === 0) return null;

  const rulesHref =
    connectionId && schema
      ? `/performance?tab=alerts&connectionId=${encodeURIComponent(String(connectionId))}` +
        `&schema=${encodeURIComponent(schema)}`
      : "/performance?tab=alerts";

  return (
    // A breach is a status change the reader did not ask for, so it is
    // announced to a screen reader rather than only drawn.
    <div className="warn-inline" role="status">
      <AlertCircleIcon size={15} className="ico" />
      <div className="space-y-1">
        <div className="font-semibold text-[12.5px]">
          {breaches.length === 1
            ? "This broke an alert threshold"
            : `This broke ${breaches.length} alert thresholds`}
        </div>

        <ul className="space-y-0.5">
          {breaches.map((breach) => (
            <li key={`${breach.key}-${breach.subject}`} style={{ color: "var(--text-2)" }}>
              {breach.message}
            </li>
          ))}
        </ul>

        <div className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
          These are limits somebody set for this schema, not limits this app
          decided on.{" "}
          <Link href={rulesHref} className="underline">
            Change them
          </Link>
          .
        </div>
      </div>
    </div>
  );
}
