"use client";

import { useState } from "react";
import { GaugeIcon } from "@/components/ui/icons";
import { PerfTargetPicker, type PerfTarget } from "@/components/studio/PerfTargetPicker";
import { PerfAdviceList } from "@/components/studio/PerfAdviceList";

/**
 * Performance — spec feature 09.
 *
 * The picker sits above the results rather than inside them because the rest of
 * this section (query analysis, trends) asks the same two questions, and moving
 * between those views should not mean choosing a database again.
 *
 * Everything here is read live. There is no stored performance report: advice
 * about a schema that has been changed since is worse than no advice, because
 * it reads as current.
 */
export default function PerformancePage() {
  const [target, setTarget] = useState<PerfTarget | null>(null);

  return (
    <div className="max-w-[1100px] mx-auto px-4 sm:px-8 py-8 sm:py-10 space-y-7">
      <header>
        <div className="flex items-center gap-2">
          <span style={{ color: "var(--text-3)" }}>
            <GaugeIcon size={16} />
          </span>
          <div className="section-title">Performance</div>
        </div>
        <h1 className="text-[28px] font-semibold tracking-[-0.02em] mt-1">
          Performance suggestions
        </h1>
        <p className="text-[13.5px] mt-1.5 max-w-[64ch]" style={{ color: "var(--text-2)" }}>
          What this schema is likely to be slow at, and what to do about it —
          worked out from its structure, and from the server&apos;s own record of
          how these tables are being read. Every suggestion comes with the SQL.
        </p>
      </header>

      {/* setTarget is a useState setter, so it is stable — which is what the
          picker's report effect needs. */}
      <PerfTargetPicker onChange={setTarget} />

      <PerfAdviceList target={target} />
    </div>
  );
}
