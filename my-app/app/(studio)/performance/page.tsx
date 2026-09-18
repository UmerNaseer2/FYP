"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Card, Skeleton } from "@/components/ui";
import { GaugeIcon } from "@/components/ui/icons";
import { PerfTargetPicker, type PerfTarget } from "@/components/studio/PerfTargetPicker";
import { PerfAdviceList } from "@/components/studio/PerfAdviceList";
import { QueryAnalyzer } from "@/components/studio/QueryAnalyzer";
import { SchemaTrends } from "@/components/studio/SchemaTrends";
import { QueryHistoryPanel } from "@/components/studio/QueryHistoryPanel";
import { LiveActivity } from "@/components/studio/LiveActivity";
import { AlertThresholds } from "@/components/studio/AlertThresholds";

/**
 * Performance — spec features 08, 09 and 10.
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
 *   • Suggestions, Analyse and Activity are read live and store nothing about
 *     the schema. Advice about a schema that has been changed since is worse
 *     than no advice, because it reads as current.
 *   • History and Trends can only show what was collected earlier — an
 *     analysis writes its own row, and the drift check writes the schema
 *     readings. Neither can be produced on demand, which is why both say so
 *     when they are empty instead of drawing a chart of nothing.
 *   • Alerts writes rather than reads: it is the only tab that changes what
 *     the others will say.
 */

type PerfTab = "suggestions" | "analyse" | "history" | "activity" | "trends" | "alerts";

const TAB_TITLES: Record<PerfTab, string> = {
  suggestions: "Performance suggestions",
  analyse: "Query analysis",
  history: "Query history",
  activity: "Live activity",
  trends: "Schema trends",
  alerts: "Alert thresholds",
};

const TAB_BLURBS: Record<PerfTab, string> = {
  suggestions:
    "What this schema is likely to be slow at, and what to do about it — worked " +
    "out from its structure, and from the server's own record of how these " +
    "tables are being read. Schema changes come as SQL you can save as a " +
    "migration; the rest say what to run or decide.",
  analyse:
    "Paste a query and see what the server would actually do with it, step by " +
    "step and in plain English — plus anything in the plan or the SQL itself " +
    "that usually costs more than it looks.",
  history:
    "Every query analysed against this schema, with what it scored and what it " +
    "cost. Pick one and you get each of its runs set against the last, which " +
    "is the only way to tell whether a query has actually got slower.",
  activity:
    "What this server is doing at this moment — what is running, what has been " +
    "running too long, and what is sitting in an open transaction holding locks " +
    "that nobody is using. One reading, taken when you ask.",
  trends:
    "How this schema has changed over time — its structure, its size on disk " +
    "and how often it drifted from its baseline. One reading is taken every " +
    "time a drift check runs, so the history starts when the watching does.",
  alerts:
    "What should count as a problem here. Every rule starts switched off with a " +
    "suggested number in the box, because a number this app invented is not a " +
    "fact about your database.",
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

  // The target lives here, above the tab body, so switching tabs keeps it.
  const [target, setTarget] = useState<PerfTarget | null>(null);

  return (
    <div className="max-w-[1100px] mx-auto px-4 sm:px-8 py-8 sm:py-10 space-y-7">
      <Header tab={tab} />

      {/* Six tabs no longer fit a phone, so the strip scrolls sideways rather
          than wrapping onto a second line that would leave the underline of the
          active tab sitting in the middle of the page. */}
      <div
        className="flex items-center gap-1 overflow-x-auto"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <Tab href="/performance?tab=suggestions" active={tab === "suggestions"}>
          Suggestions
        </Tab>
        <Tab href="/performance?tab=analyse" active={tab === "analyse"}>
          Analyse a query
        </Tab>
        <Tab href="/performance?tab=history" active={tab === "history"}>
          History
        </Tab>
        <Tab href="/performance?tab=activity" active={tab === "activity"}>
          Live activity
        </Tab>
        <Tab href="/performance?tab=trends" active={tab === "trends"}>
          Trends
        </Tab>
        <Tab href="/performance?tab=alerts" active={tab === "alerts"}>
          Alerts
        </Tab>
      </div>

      {/* setTarget is a useState setter, so it is stable — which is what the
          picker's report effect needs. The two seeds come from links made on
          other screens, so a "see every run of this query" link lands on the
          database the query was run against and not on whichever connection
          happens to be first. */}
      <PerfTargetPicker
        onChange={setTarget}
        initialConnectionId={params.get("connectionId")}
        initialSchema={params.get("schema")}
      />

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
      className={`text-[13.5px] px-3.5 py-2.5 -mb-px whitespace-nowrap shrink-0 transition-colors ${
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
