"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Card, Skeleton } from "@/components/ui";
import { GaugeIcon } from "@/components/ui/icons";
import { PerfTargetPicker, type PerfTarget } from "@/components/studio/PerfTargetPicker";
import { PerfAdviceList } from "@/components/studio/PerfAdviceList";
import { QueryAnalyzer } from "@/components/studio/QueryAnalyzer";

/**
 * Performance — spec features 08 and 09.
 *
 * Two tabs over one target. The picker sits above them, not inside either,
 * because both tabs ask the same two questions and moving between them should
 * not mean choosing a database again.
 *
 * The split is by question, not by feature number. "What is wrong with this
 * schema?" is answered from the schema itself and needs no input beyond the
 * target; "why is this query slow?" needs the query. Putting them on one page
 * would mean an empty SQL box sitting above advice that has nothing to do
 * with it.
 *
 * Everything here is read live. There is no stored performance report: advice
 * about a schema that has been changed since is worse than no advice, because
 * it reads as current.
 */

type PerfTab = "suggestions" | "analyse";

const TAB_TITLES: Record<PerfTab, string> = {
  suggestions: "Performance suggestions",
  analyse: "Query analysis",
};

const TAB_BLURBS: Record<PerfTab, string> = {
  suggestions:
    "What this schema is likely to be slow at, and what to do about it — worked " +
    "out from its structure, and from the server's own record of how these " +
    "tables are being read. Every suggestion comes with the SQL.",
  analyse:
    "Paste a query and see what the server would actually do with it, step by " +
    "step and in plain English — plus anything in the plan or the SQL itself " +
    "that usually costs more than it looks.",
};

export default function PerformancePage() {
  // useSearchParams needs a Suspense boundary above it, or the whole route is
  // forced out of static rendering at build time.
  return (
    <Suspense fallback={<PerformanceFallback />}>
      <PerformanceScreen />
    </Suspense>
  );
}

function PerformanceScreen() {
  const params = useSearchParams();
  const tab: PerfTab = params.get("tab") === "analyse" ? "analyse" : "suggestions";

  // The target lives here, above the tab body, so switching tabs keeps it.
  const [target, setTarget] = useState<PerfTarget | null>(null);

  return (
    <div className="max-w-[1100px] mx-auto px-4 sm:px-8 py-8 sm:py-10 space-y-7">
      <Header tab={tab} />

      <div className="flex items-center gap-1" style={{ borderBottom: "1px solid var(--border)" }}>
        <Tab href="/performance?tab=suggestions" active={tab === "suggestions"}>
          Suggestions
        </Tab>
        <Tab href="/performance?tab=analyse" active={tab === "analyse"}>
          Analyse a query
        </Tab>
      </div>

      {/* setTarget is a useState setter, so it is stable — which is what the
          picker's report effect needs. */}
      <PerfTargetPicker onChange={setTarget} />

      {tab === "analyse" ? (
        <QueryAnalyzer target={target} />
      ) : (
        <PerfAdviceList target={target} />
      )}
    </div>
  );
}

function Header({ tab }: { tab: PerfTab }) {
  return (
    <header>
      <div className="flex items-center gap-2">
        <span style={{ color: "var(--text-3)" }}>
          <GaugeIcon size={16} />
        </span>
        <div className="section-title">Performance</div>
      </div>
      <h1 className="text-[28px] font-semibold tracking-[-0.02em] mt-1">
        {TAB_TITLES[tab]}
      </h1>
      <p className="text-[13.5px] mt-1.5 max-w-[64ch]" style={{ color: "var(--text-2)" }}>
        {TAB_BLURBS[tab]}
      </p>
    </header>
  );
}

function Tab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    // active was styling only — a screen reader heard two identical links and
    // no clue which tab was open, so aria-current and a weight change carry it.
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`text-[13.5px] px-3.5 py-2.5 -mb-px transition-colors ${
        active ? "font-semibold" : "font-medium"
      }`}
      style={{
        borderBottom: active ? "2px solid var(--brand)" : "2px solid transparent",
        color: active ? "var(--text)" : "var(--text-3)",
      }}
    >
      {children}
    </Link>
  );
}

/**
 * Shown for the instant before the query string is readable. It draws the
 * header for the default tab rather than a blank page, so the screen does not
 * appear to load twice.
 */
function PerformanceFallback() {
  return (
    <div className="max-w-[1100px] mx-auto px-4 sm:px-8 py-8 sm:py-10 space-y-7">
      <Header tab="suggestions" />
      <Card className="p-4">
        <Skeleton width={320} height={18} />
      </Card>
    </div>
  );
}
