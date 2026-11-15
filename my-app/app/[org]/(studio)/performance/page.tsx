"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, Skeleton } from "@/components/ui";
import { PerfTargetPicker, type PerfTarget } from "@/components/studio/PerfTargetPicker";
import { PerfAdviceList } from "@/components/studio/PerfAdviceList";
import { QueryAnalyzer } from "@/components/studio/QueryAnalyzer";
import { SchemaTrends } from "@/components/studio/SchemaTrends";
import { QueryHistoryPanel } from "@/components/studio/QueryHistoryPanel";
import { LiveActivity } from "@/components/studio/LiveActivity";
import { AlertThresholds } from "@/components/studio/AlertThresholds";
import { PageHeader } from "@/components/studio/PageHeader";
import { PageTabs } from "@/components/studio/PillTabs";
import { useOrgHref } from "@/hooks/useOrg";
import "@/app/styles/atelier-performance.css";

/**
 * Performance: spec features 08, 09 and 10.
 *
 * Six tabs over one target. The picker sits above them, not inside any of
 * them, because all six ask the same two questions and moving between them
 * should not mean choosing a database again.
 *
 * The split is by question, not by feature number. "What is wrong with this
 * schema?" is answered from the schema itself and needs no input beyond the
 * target; "why is this query slow?" needs the query; "what has this schema
 * been doing?" needs a history nobody can produce on demand. Putting them on
 * one page would mean an empty SQL box sitting above advice that has nothing
 * to do with it.
 *
 * The tabs divide by where their answer comes from, and that is the thing to
 * keep straight when reading this file:
 *
 *   - Suggestions, Analyse and Activity are read live and store nothing about
 *     the schema. Advice about a schema that has been changed since is worse
 *     than no advice, because it reads as current.
 *   - History and Trends can only show what was collected earlier: an
 *     analysis writes its own row, and the drift check writes the schema
 *     readings. Neither can be produced on demand, which is why both say so
 *     when they are empty instead of drawing a chart of nothing.
 *   - Alerts writes rather than reads: it is the only tab that changes what
 *     the others will say.
 */

type PerfTab = "suggestions" | "analyse" | "history" | "activity" | "trends" | "alerts";

// The six tabs, in the order they are drawn. The page title is always the
// menu name ("Performance"); the tab strip says which part is open.
const TABS: { key: PerfTab; label: string }[] = [
  { key: "suggestions", label: "Suggestions" },
  { key: "analyse", label: "Analyse a query" },
  { key: "history", label: "History" },
  { key: "activity", label: "Live activity" },
  { key: "trends", label: "Trends" },
  { key: "alerts", label: "Alerts" },
];

// One short line per tab for the page header. The longer explanation of each
// tab lives in the help file (lib/help/performance.ts), under its sections.
const TAB_BLURBS: Record<PerfTab, string> = {
  suggestions: "What this schema is likely to be slow at, and what to do about it.",
  analyse: "Paste a query and see what the server would do with it, step by step.",
  history: "Every query analysed against this schema, and whether it has got slower.",
  activity: "What this server is doing at this moment. One reading, taken when you ask.",
  trends: "How this schema's structure, size and drift have changed over time.",
  alerts: "What should count as a problem here. Every rule starts switched off.",
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
  const tab = readTab(params.get("tab"));
  const orgPath = useOrgHref();

  // The target lives here, above the tab body, so switching tabs keeps it.
  const [target, setTarget] = useState<PerfTarget | null>(null);

  return (
    <div className="pf-page max-w-[1100px] mx-auto px-4 sm:px-8 py-8 sm:py-10">
      {/* The tabs are links, not buttons, so each one has its own address and
          the browser's Back button moves between them. Six tabs do not fit a
          phone, so the strip scrolls sideways inside itself. */}
      <PageHeader page="/performance" blurb={TAB_BLURBS[tab]}>
        <div data-tour="performance-tabs">
          <PageTabs
            label="Performance sections"
            tabs={TABS.map((item) => ({
              key: item.key,
              label: item.label,
              href: orgPath(`/performance?tab=${item.key}`),
            }))}
            value={tab}
          />
        </div>
      </PageHeader>

      {/* setTarget is a useState setter, so it is stable, which is what the
          picker's report effect needs. The two seeds come from links made on
          other screens, so a "see every run of this query" link lands on the
          database the query was run against and not on whichever connection
          happens to be first. */}
      <PerfTargetPicker
        onChange={setTarget}
        initialConnectionId={params.get("connectionId")}
        initialSchema={params.get("schema")}
      />

      <div className="pf-body">
        {/* ?table=schema.table comes from a Suggestions finding ("almost every
            read of this table is a sequential scan"); the analyser starts from
            a commented note about that table instead of an empty box. */}
        {tab === "analyse" && (
          <QueryAnalyzer target={target} initialTable={params.get("table")} />
        )}
        {/* ?fingerprint= comes from the analyser's "see every run of this query"
            link, and narrows the list to that one query. */}
        {tab === "history" && (
          <QueryHistoryPanel target={target} fingerprint={params.get("fingerprint")} />
        )}
        {tab === "activity" && <LiveActivity target={target} />}
        {tab === "trends" && <SchemaTrends target={target} />}
        {tab === "alerts" && <AlertThresholds target={target} />}
        {tab === "suggestions" && <PerfAdviceList target={target} />}
      </div>
    </div>
  );
}

/** The tab named in the query string, or the default for anything else. */
function readTab(raw: string | null): PerfTab {
  if (
    raw === "analyse" ||
    raw === "history" ||
    raw === "activity" ||
    raw === "trends" ||
    raw === "alerts"
  ) {
    return raw;
  }
  return "suggestions";
}

/**
 * Shown for the instant before the query string is readable. It draws the
 * header for the default tab rather than a blank page, so the screen does not
 * appear to load twice.
 */
function PerformanceFallback() {
  return (
    <div className="pf-page max-w-[1100px] mx-auto px-4 sm:px-8 py-8 sm:py-10">
      <PageHeader page="/performance" blurb={TAB_BLURBS.suggestions} />
      <Card className="p-4">
        <Skeleton width={320} height={18} />
      </Card>
    </div>
  );
}
