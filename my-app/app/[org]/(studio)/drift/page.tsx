"use client";

import { Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Card, EmptyState, Skeleton } from "@/components/ui";
import { displayVersion } from "@/lib/version-timeline";
import {
  AlertTriangleIcon,
  AlertCircleIcon,
  CheckIcon,
  InfoIcon,
  CompareIcon,
  DashboardIcon,
} from "@/components/ui/icons";
import { DiffReport, tallyDelta } from "@/components/studio/DiffReport";
import { SummaryMatrix } from "@/components/studio/SummaryMatrix";
import { DriftResolutionBar } from "@/components/studio/DriftResolutionBar";
import { DriftExplainPanel } from "@/components/studio/DriftExplainPanel";
import { driftExplainKey } from "@/lib/ai/features/drift-explain-view";
import { AuditLogTable, type AuditRow } from "@/components/studio/AuditLogTable";
import { ScheduleTable } from "@/components/studio/ScheduleTable";
import { ElsewhereDrift } from "@/components/studio/ElsewhereDrift";
import { PageHeader } from "@/components/studio/PageHeader";
import { describeCadence } from "@/lib/drift-schedule";
import { utcStamp } from "@/lib/format-date";
import { useOrgHref } from "@/hooks/useOrg";
// Types only. `import type` is erased at compile time, so importing the shape
// of a row does not pull the database module into the client bundle.
import type {
  DriftStatus,
  DriftDetailView,
  DriftCounts,
  DriftEventFeedItem,
  TrackedSchemaListItem,
} from "@/lib/lineage-db";
// The detail read adds a fingerprint of the differences it found.
import type { DriftDetailAnswer } from "@/app/api/lineage/drift/route";
import { apiFetch } from "@/lib/api-fetch";
import "@/app/styles/atelier-drift.css";

/**
 * Phase 9, Drift & Audit.
 *
 * The drift loop closed in two tabs:
 *   • Detail (S6): pick a tracked schema, see its live Expected-vs-Actual diff
 *     recomputed now (never stale), with the same <DiffReport> /compare uses, and
 *     resolution actions (author a migration, re-baseline, acknowledge, re-check).
 *   • Audit (S7): the dense, filterable history of every recorded drift check.
 *
 * Client component: everything comes through the API layer ,
 * GET /api/lineage for the tracked list, GET /api/lineage/drift for the live
 * recompute, GET /api/lineage/audit for the recorded history. The screen holds
 * its own data, so the resolution bar reloads it directly after a write rather
 * than asking the server to re-render. No mock data.
 */

// ── Small pure formatters (server-safe, no Date.now, so no hydration risk) ─────

/** Stable absolute timestamp, e.g. "2026-06-09 14:21 UTC" (utcStamp). */
function fmtDate(iso: string | null): string {
  return utcStamp(iso) || "No time recorded";
}

/** The three questions this screen answers, in the order they get asked. */
type DriftTab = "detail" | "audit" | "schedule";

const TAB_TITLES: Record<DriftTab, string> = {
  detail: "Changes nobody shipped",
  audit: "Audit log",
  schedule: "Schedule",
};

// One short line per tab for the page header. The longer explanation of each
// tab lives in the help file (lib/help/drift.ts), under its sections.
const TAB_BLURBS: Record<DriftTab, string> = {
  detail: "Pick a tracked schema, see what changed outside a deploy, then decide what to do.",
  audit: "Every recorded drift check, newest first.",
  schedule: "How often each tracked schema is checked on its own.",
};

/** Drifted first, then unreachable, then never-checked, then in-sync. */
function sortPriority(status: DriftStatus | null): number {
  switch (status) {
    case "drifted":
      return 0;
    case "unreachable":
      return 1;
    case "in_sync":
      return 3;
    default:
      return 2; // null , tracked but never drift-checked
  }
}

/** How each recorded drift status reads in a list: a word and a colour class. */
function statusWord(status: DriftStatus | null): { tone: string; label: string } {
  switch (status) {
    case "drifted":
      return { tone: "drift", label: "Drifted" };
    case "in_sync":
      return { tone: "sync", label: "In sync" };
    case "unreachable":
      return { tone: "down", label: "Unreachable" };
    default:
      return { tone: "none", label: "Not checked yet" };
  }
}

/** The small line under a schema's name in the watch list. */
function watchLine(item: TrackedSchemaListItem): string {
  switch (item.driftStatus) {
    case "drifted":
      return item.driftSummary ?? "Changed outside a deploy";
    case "unreachable":
      return "Can't be reached";
    case "in_sync":
      return "Matches its baseline";
    default:
      return "Not checked yet";
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DriftPage() {
  // useSearchParams has to sit under a Suspense boundary: while the page is
  // pre-rendered there is no URL to read, so React puts this fallback in the
  // static HTML and the real screen takes over as soon as it reaches a browser.
  return (
    <Suspense
      fallback={
        <Shell tab="detail" schema={undefined}>
          <ContentSkeleton tab="detail" />
        </Shell>
      }
    >
      <DriftScreen />
    </Suspense>
  );
}

function DriftScreen() {
  const sp = useSearchParams();
  const raw_tab = sp.get("tab");
  const tab: DriftTab =
    raw_tab === "audit" ? "audit" : raw_tab === "schedule" ? "schedule" : "detail";
  const raw = sp.get("schema");
  const schema = raw && raw.trim() ? raw.trim() : undefined;

  // The shell (header + tab bar) renders the instant a tab is clicked; only the
  // tab content waits on the API, and it shows the skeleton while it does.
  return (
    <Shell tab={tab} schema={schema}>
      {tab === "detail" ? (
        <>
          <DetailContent schema={schema} />
          {/* Schemas checked on the other side of the sync: the website's own, in
              the desktop app, or the person's computers', in a browser. */}
          <ElsewhereDrift />
        </>
      ) : tab === "schedule" ? (
        <ScheduleTable />
      ) : (
        <AuditContent />
      )}
    </Shell>
  );
}

// ── Shared shell: header + tab bar (synchronous) ─────────────────────────────

function Shell({
  tab,
  schema,
  children,
}: {
  tab: DriftTab;
  schema: string | undefined;
  children: React.ReactNode;
}) {
  const orgPath = useOrgHref();
  // Carry the selected schema across tab switches so toggling detail and audit
  // doesn't lose the schema you were looking at.
  const q = schema ? `&schema=${encodeURIComponent(schema)}` : "";
  return (
    <div className="dr-page">
      <PageHeader page="/drift" title={TAB_TITLES[tab]} blurb={TAB_BLURBS[tab]} />

      <nav className="dr-tabs" aria-label="Drift views">
        <Tab href={orgPath(`/drift?tab=detail${q}`)} active={tab === "detail"}>
          Drift detail
        </Tab>
        <Tab href={orgPath(`/drift?tab=audit${q}`)} active={tab === "audit"}>
          Audit log
        </Tab>
        <Tab href={orgPath(`/drift?tab=schedule${q}`)} active={tab === "schedule"}>
          Schedule
        </Tab>
      </nav>

      {children}
    </div>
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
    // Colour alone would leave a screen reader with three identical links, so
    // aria-current says which tab is open.
    <Link href={href} aria-current={active ? "page" : undefined} className="dr-tab">
      {children}
    </Link>
  );
}

// ── Tab content (only this hits the backend) ─────────────────────────────────

/**
 * The tracked list, which both tabs need before they can show anything: the
 * detail tab picks a schema out of it, the audit tab only uses it to tell
 * "nothing tracked yet" apart from "nothing has drifted yet".
 *
 * Returns null while it is still loading so a caller can show its skeleton.
 */
function useTrackedSchemas(): {
  tracked: TrackedSchemaListItem[] | null;
  failed: boolean;
  /** Read the list again, keeping the one on screen until the new one lands. */
  reload: () => void;
} {
  const [tracked, setTracked] = useState<TrackedSchemaListItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Counts the reads asked for. The list carries each schema's drift status,
  // which a fix on the detail tab changes, so the tab asks for a new read.
  const [reads, setReads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      let data: unknown = null;
      try {
        const res = await apiFetch("/api/lineage");
        data = res.ok ? await res.json() : null;
      } catch {
        data = null;
      }
      if (cancelled) return;
      if (Array.isArray(data)) {
        setTracked(data);
        setFailed(false);
      } else if (reads === 0) {
        setTracked([]);
        setFailed(true);
      }
      // A failed re-read keeps the list already on screen: the fix itself
      // went through, and only the statuses in the watch list are out of date.
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [reads]);

  const reload = useCallback(() => setReads((count) => count + 1), []);
  return { tracked, failed, reload };
}

function DetailContent({ schema }: { schema: string | undefined }) {
  const { tracked, failed, reload } = useTrackedSchemas();
  // The schema on screen when the list was last read again. With no schema in
  // the URL the page shows the one with the worst drift, and right after that
  // one is fixed it no longer is, so the page would jump to another schema.
  const [kept, setKept] = useState<number | null>(null);

  if (tracked === null) return <ContentSkeleton tab="detail" />;
  if (failed) return <ListUnreadable />;
  if (tracked.length === 0) return <NothingTracked />;

  // Worst-drift-first, so the default selection is the schema that needs eyes.
  const byPriority = [...tracked].sort(
    (a, b) => sortPriority(a.driftStatus) - sortPriority(b.driftStatus)
  );
  const requested = schema ? Number(schema) : kept;
  const selected = tracked.find((t) => t.id === requested) ?? byPriority[0];

  // After a fix the watch list's statuses are out of date: read it again.
  const listChanged = () => {
    setKept(selected.id);
    reload();
  };

  return (
    <div className="dr-grid">
      <WatchList tracked={byPriority} selectedId={selected.id} />
      {/* The key remounts the case when another schema is picked, so the
          skeleton shows instead of the last schema's numbers looking live. */}
      <DetailTab
        key={selected.id}
        selectedId={selected.id}
        onWebsite={selected.connectionOnWebsite === true}
        onListChanged={listChanged}
      />
    </div>
  );
}

function AuditContent() {
  const { tracked, failed } = useTrackedSchemas();

  if (tracked === null) return <ContentSkeleton tab="audit" />;
  if (failed) return <ListUnreadable />;
  if (tracked.length === 0) return <NothingTracked />;
  return <AuditTab />;
}

/** The tracked list itself could not be read. Say so instead of "nothing". */
function ListUnreadable() {
  return (
    <Card className="dr-empty">
      <EmptyState
        tone="break"
        icon={<AlertCircleIcon size={22} />}
        title="Could not load your tracked schemas"
        description="The list could not be read just now. Reload the page to try again."
      />
    </Card>
  );
}

/** The drift history itself could not be read. Say so instead of "none". */
function HistoryUnreadable() {
  return (
    <Card className="dr-empty">
      <EmptyState
        tone="break"
        icon={<AlertCircleIcon size={22} />}
        title="Could not load the drift history"
        description="The recorded checks could not be read just now. Reload the page to try again."
      />
    </Card>
  );
}

function NothingTracked() {
  const orgPath = useOrgHref();
  return (
    <Card className="dr-empty dr-untracked">
      <EmptyState
        icon={<DashboardIcon size={22} />}
        title="Nothing tracked yet"
        description="Drift compares a live schema against its lineage baseline. Track a schema on the dashboard to start watching it for drift."
        actions={
          <Link href={orgPath("/studio")} className="btn btn-primary btn-sm">
            <DashboardIcon size={14} /> Go to dashboard
          </Link>
        }
      />
    </Card>
  );
}

// ── Content skeleton (shown while a tab's data loads) ────────────────────────

function ContentSkeleton({ tab }: { tab: DriftTab }) {
  if (tab === "audit") {
    return (
      <div className="dr-stack" aria-busy="true">
        <div className="dr-stats">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="dr-stat">
              <Skeleton width="60%" height={11} />
              <Skeleton width={40} height={26} />
            </div>
          ))}
        </div>
        <CaseSkeleton />
      </div>
    );
  }
  return (
    <div className="dr-grid" aria-busy="true">
      <div className="card dr-watch">
        <div className="dr-watch__head">
          <Skeleton width={130} height={14} />
        </div>
        {[0, 1, 2].map((i) => (
          <div key={i} className="dr-row dr-row--ghost">
            <Skeleton width={10} height={10} radius={999} />
            <div className="dr-row__text">
              <Skeleton width={`${50 + i * 10}%`} height={14} />
              <Skeleton width="70%" height={11} />
            </div>
          </div>
        ))}
      </div>
      <CaseSkeleton />
    </div>
  );
}

/** The right-hand card, before its schema's drift has been read. */
function CaseSkeleton() {
  return (
    <div className="card dr-case" aria-busy="true">
      <div className="dr-case__head">
        <Skeleton width={36} height={36} radius={999} />
        <div className="dr-case__headtext">
          <Skeleton width="55%" height={20} />
          <Skeleton width="80%" height={12} />
        </div>
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="dr-skel-line">
          <Skeleton width={`${40 + i * 8}%`} height={14} />
          <Skeleton width={60} height={18} radius={999} />
        </div>
      ))}
    </div>
  );
}

// ── Watch list: every tracked schema, the one on screen marked ───────────────

function WatchList({
  tracked,
  selectedId,
}: {
  tracked: TrackedSchemaListItem[];
  selectedId: number;
}) {
  const orgPath = useOrgHref();
  const drifted = tracked.filter((t) => t.driftStatus === "drifted").length;

  return (
    <nav className="card dr-watch" aria-label="Tracked schemas">
      <div className="dr-watch__head">
        <h2 className="dr-h2">Tracked schemas</h2>
        <span className="dr-watch__count">
          {drifted === 0 ? "None drifted" : `${drifted} of ${tracked.length} drifted`}
        </span>
      </div>
      <ul className="dr-rows">
        {tracked.map((item, i) => {
          const status = statusWord(item.driftStatus);
          const source = item.label ?? item.connectionName ?? "no connection";
          return (
            <li key={item.id} className="rise" style={{ "--d": `${i * 40}ms` } as CSSProperties}>
              {/* A plain link, so the choice lives in the URL: it survives a
                  reload and can be shared. */}
              <Link
                href={orgPath(`/drift?tab=detail&schema=${item.id}`)}
                className="dr-row"
                aria-current={item.id === selectedId ? "true" : undefined}
              >
                <span className={`dr-dot dr-dot--${status.tone}`} aria-hidden="true" />
                <span className="dr-row__text">
                  <span className="dr-row__name">
                    <span className="dr-row__schema">{item.schemaName}</span>
                  </span>
                  <span className="dr-row__source">{source}</span>
                  <span className={`dr-row__status dr-row__status--${status.tone}`}>
                    {watchLine(item)}
                  </span>
                  {item.driftCheckedAt && (
                    <span className="dr-row__when">Recorded {fmtDate(item.driftCheckedAt)}</span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="dr-watch__hint">
        The dot is the last saved check. The case beside it is read live.
      </p>
    </nav>
  );
}

// ── The case: one schema, read live ──────────────────────────────────────────

function DetailTab({
  selectedId,
  onWebsite,
  onListChanged,
}: {
  selectedId: number;
  /** A desktop's copy of one of the website's connections: the website checks it now. */
  onWebsite: boolean;
  /** A fix changed this schema's drift status, which the watch list shows too. */
  onListChanged: () => void;
}) {
  const orgPath = useOrgHref();
  const [view, setView] = useState<DriftDetailAnswer | null>(null);
  const [history, setHistory] = useState<DriftEventFeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The live recompute for the selected schema, plus its recent recorded
  // history. The resolution bar calls this again after every write, because
  // this screen holds its own data, so refreshing the router would show nothing.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [detailRes, historyRes] = await Promise.all([
        apiFetch("/api/lineage/drift?trackedSchemaId=" + selectedId),
        apiFetch("/api/lineage/audit?trackedSchemaId=" + selectedId + "&limit=6"),
      ]);
      const detail = await detailRes.json().catch(() => null);
      const events = await historyRes.json().catch(() => null);

      if (detailRes.ok && detail) {
        setView(detail as DriftDetailAnswer);
        setError(null);
      } else {
        setView(null);
        // A 404 is "not tracked any more", which the empty state below already
        // explains. Anything else is a real failure worth naming.
        setError(
          detailRes.status === 404
            ? null
            : detail?.error ?? "Could not read this schema's drift."
        );
      }
      setHistory(Array.isArray(events) ? events : []);
    } catch {
      setView(null);
      setError("Network error while reading this schema's drift.");
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  // What the AI panel's answer is about. It changes with the drift itself, not
  // just its counts, so a re-check that finds other changes clears the answer.
  const explainKey = useMemo(
    () => (view ? driftExplainKey(view.trackedSchemaId, view.report, view.expected.snapshotId) : ""),
    [view]
  );

  // Only the first load blanks the card. A re-check keeps the current diff on
  // screen until the new one lands, so the page doesn't flash back to skeleton
  // every time someone presses a button.
  if (loading && !view) return <CaseSkeleton />;

  if (!view) {
    return (
      <Card className="dr-empty">
        <EmptyState
          tone="break"
          icon={<AlertCircleIcon size={22} />}
          title={error ? "Could not read this schema's drift" : "Tracked schema not found"}
          description={
            error ?? "It may have been removed. Pick another schema or head back to the dashboard."
          }
          actions={
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
              Try again
            </button>
          }
        />
      </Card>
    );
  }

  // Fills in this live schema as Compare's target and leaves the source for
  // the reader to choose. It does not run: a source picked by default would
  // put a migration for a pair nobody chose on the screen.
  const compareHref = view.connection
    ? orgPath(
        `/compare?targetConnection=${view.connection.id}&targetSchema=${encodeURIComponent(view.schemaName)}`
      )
    : null;

  const head = caseHead(view);

  return (
    <div className={`card dr-case dr-case--${head.tone}`} aria-busy={loading}>
      {/* A thin moving bar while a re-check is on its way. */}
      {loading && <div className="dr-bar" aria-hidden="true" />}

      <header className="dr-case__head">
        <span className={`dr-case__icon dr-case__icon--${head.tone}`} aria-hidden="true">
          {head.icon}
        </span>
        <div className="dr-case__headtext">
          <h2 className="dr-case__title">{head.title}</h2>
          <div className="dr-case__where">
            <span className="dr-case__schema">{view.schemaName}</span>
            {view.connection ? (
              <span className="dr-case__host">
                {view.connection.host}:{view.connection.port}/{view.connection.database}
              </span>
            ) : (
              <span>Connection removed</span>
            )}
          </div>
        </div>
      </header>

      {/*
        The dot in the watch list is the last RECORDED status, while everything
        in this card was recomputed live on this render. With no record yet
        that reads as a contradiction: "Not checked yet" beside a full drift
        report. Saying where the report came from resolves it: the diff is
        live, the dot is the saved result, and Check drift now is what saves one.
      */}
      <ul className="dr-facts">
        <li>Read live on this page load</li>
        <li>
          {view.lastRecorded
            ? `Last recorded check · ${fmtDate(view.lastRecorded.detectedAt)}`
            : "Nothing recorded yet. Check drift now saves it."}
        </li>
        {/* Without this line the page reads as though nothing happens between
            button presses. It also tells "not watched" apart from "watched
            and unchanged". */}
        <li>
          {view.driftIntervalMinutes > 0 ? (
            <>
              Checked automatically {describeCadence(view.driftIntervalMinutes)} ·{" "}
              <Link href={orgPath("/drift?tab=schedule")} className="dr-link">
                change
              </Link>
            </>
          ) : (
            <>
              Automatic checking off ·{" "}
              <Link href={orgPath("/drift?tab=schedule")} className="dr-link">
                turn on
              </Link>
            </>
          )}
        </li>
      </ul>

      {/* Only on a desktop. The scheduler here leaves this schema alone (lib/drift-scheduler.ts). */}
      {onWebsite && (
        <div className="warn-inline">
          <span className="ico dr-ico--wait">
            <InfoIcon size={14} />
          </span>
          <div className="dr-note">
            <b>This connection belongs to the website.</b> The website checks it on a timer, not this
            computer. Results show under Checked by the website below.
          </div>
        </div>
      )}

      <p className="dr-lead">{head.lead}</p>

      {/* What can be done about it. Every write re-reads this card and the list. */}
      <div className="dr-actions">
        <DriftResolutionBar
          trackedSchemaId={view.trackedSchemaId}
          state={view.state}
          compareHref={compareHref}
          // What this page is showing, so a re-baseline accepts these differences
          // and not whatever the live database holds by the time of the click.
          shownFingerprint={view.fingerprint ?? null}
          onDone={() => {
            void load();
            onListChanged();
          }}
        />
      </div>

      {/* Delta counts, only when a comparison was actually computed. */}
      {view.counts && <CountTiles counts={view.counts} report={view.report} />}

      {/* The AI's read of the drift, with the revert and adopt scripts the app
          writes. Draws nothing without "Use AI assistance" or with AI off. */}
      {view.state === "drifted" && view.connection && view.report && (
        <DriftExplainPanel
          trackedSchemaId={view.trackedSchemaId}
          connectionId={view.connection.id}
          schemaName={view.schemaName}
          resetKey={explainKey}
        />
      )}

      <section className="dr-section">
        <div className="dr-section__head">
          <div>
            <div className="dr-kicker">Agreed and live</div>
            <h3 className="dr-h3">
              {view.expected.version
                ? `Lineage ${displayVersion(view.expected.version, true)} vs the live database`
                : "Expected snapshot vs the live database"}
            </h3>
          </div>
          {compareHref && (
            <Link href={compareHref} className="btn btn-secondary btn-sm">
              <CompareIcon size={13} /> Compare with another database
            </Link>
          )}
        </div>

        {view.report ? (
          <div className="dr-diff">
            {/* A baseline captured by an older build never recorded some of the
                categories this one reads, and the comparator silently skips
                those. Correct, but silence reads as "checked, and clean". */}
            {view.expected.format.note && (
              <div className="warn-inline">
                <span className="ico dr-ico--wait">
                  <InfoIcon size={14} />
                </span>
                <div className="dr-note">
                  <b>Not everything was compared.</b> {view.expected.format.note}
                </div>
              </div>
            )}
            {/* A stored snapshot can predate a whole object category, and the
                matrix is the only place that says so out loud. */}
            <SummaryMatrix report={view.report} sides="expected-live" />
            {/* "expected-live" because this page's two sides are the tracked
                baseline and the live database, not a source and a target. It
                flips every before/after pair so a changed value reads what it
                was, then what it is. */}
            <DiffReport report={view.report} sides="expected-live" />
          </div>
        ) : (
          <div className="dr-nodiff">
            <span className="dr-nodiff__icon" aria-hidden="true">
              <InfoIcon size={16} />
            </span>
            <div>
              <div className="dr-nodiff__title">No diff to show</div>
              <div className="help">{view.summary}</div>
            </div>
          </div>
        )}
      </section>

      {/* Recent recorded checks for this schema, newest first. */}
      {history.length > 0 && (
        <section className="dr-section">
          <h3 className="dr-h3">Earlier on {view.schemaName}</h3>
          <ol className="dr-hist">
            {history.map((ev) => {
              const status = statusWord(ev.status);
              return (
                <li key={ev.id} className="dr-hist__item">
                  <span className={`dr-dot dr-dot--${status.tone}`} aria-hidden="true" />
                  <div className="dr-hist__text">
                    <div className="dr-hist__title">
                      {status.label}
                      {ev.acknowledgedAt && (
                        <span className="dr-hist__ack">
                          <CheckIcon size={11} /> Acknowledged
                        </span>
                      )}
                    </div>
                    <div className="dr-hist__summary">{ev.summary ?? "No summary recorded"}</div>
                  </div>
                  <span className="dr-hist__when">{fmtDate(ev.detectedAt)}</span>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}

/** The case card's icon, title and lead sentence for each state. */
function caseHead(view: DriftDetailAnswer): {
  tone: "drift" | "sync" | "down" | "none";
  icon: React.ReactNode;
  title: React.ReactNode;
  lead: string;
} {
  const version = view.expected.version ? displayVersion(view.expected.version, true) : null;

  if (view.state === "drifted") {
    const t = view.report ? tallyDelta(view.report) : null;
    return {
      tone: "drift",
      icon: <AlertTriangleIcon size={16} />,
      title: `The live schema has drifted from ${version ?? "its expected snapshot"}.`,
      lead: t
        ? `${t.total} difference${t.total === 1 ? "" : "s"} across ${t.tablesTouched} table${t.tablesTouched === 1 ? "" : "s"}. Review the diff below and choose how to resolve it.`
        : view.summary,
    };
  }
  if (view.state === "in_sync") {
    return {
      tone: "sync",
      icon: <CheckIcon size={16} />,
      title: version
        ? `Live schema matches ${version}.`
        : "Live schema matches its expected snapshot.",
      lead: view.summary,
    };
  }
  if (view.state === "unreachable") {
    return {
      tone: "down",
      icon: <AlertCircleIcon size={16} />,
      title: "This schema's database is unreachable.",
      lead: view.summary,
    };
  }
  return {
    tone: "none",
    icon: <InfoIcon size={16} />,
    title: "No baseline snapshot to compare against.",
    lead: view.summary,
  };
}

// ── Delta counts ─────────────────────────────────────────────────────────────

function CountTiles({
  counts,
  report,
}: {
  counts: DriftCounts;
  report: DriftDetailView["report"];
}) {
  const t = report ? tallyDelta(report) : null;
  return (
    <div className="dr-counts">
      <CountTile label="Tables added" value={counts.tablesAdded} tone="add" />
      <CountTile label="Tables removed" value={counts.tablesRemoved} tone="rem" />
      <CountTile label="Tables changed" value={counts.tablesChanged} tone="chg" />
      <CountTile label="Constraints changed" value={counts.constraintsChanged} tone="chg" />
      {/* Views, functions and grants are drift too. Without this tile the four
          zeros above sat directly over a diff card listing a dropped view. The
          `?? 0` is for drift events stored before the field existed. */}
      <CountTile
        label="Objects changed"
        value={counts.objectsChanged ?? 0}
        tone="chg"
        note={t ? `${t.total} total diffs` : undefined}
      />
    </div>
  );
}

function CountTile({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: number;
  tone: "add" | "rem" | "chg";
  note?: string;
}) {
  // A zero stays quiet: the colour is for a number worth looking at.
  const toneClass = value > 0 ? ` dr-stat--${tone}` : " dr-stat--zero";
  return (
    <div className={`dr-stat${toneClass}`}>
      <div className="dr-stat__label">{label}</div>
      <div className="dr-stat__value">{value}</div>
      {note && <div className="dr-stat__note">{note}</div>}
    </div>
  );
}

// ── Audit tab ────────────────────────────────────────────────────────────────

function AuditTab() {
  const [events, setEvents] = useState<DriftEventFeedItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await apiFetch("/api/lineage/audit");
        const data = res.ok ? await res.json() : null;
        if (cancelled) return;
        setEvents(Array.isArray(data) ? data : []);
        setFailed(!Array.isArray(data));
      } catch {
        // An empty table reads as "no checks recorded", which is a very
        // different claim from "we could not ask". Say which one this is.
        if (cancelled) return;
        setEvents([]);
        setFailed(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (events === null) return <ContentSkeleton tab="audit" />;
  if (failed) return <HistoryUnreadable />;

  const total = events.length;
  const drifted = events.filter((e) => e.status === "drifted").length;
  const inSync = events.filter((e) => e.status === "in_sync").length;
  const acknowledged = events.filter((e) => e.acknowledgedAt !== null).length;

  const rows: AuditRow[] = events.map((e) => ({
    id: e.id,
    trackedSchemaId: e.trackedSchemaId,
    schemaName: e.schemaName,
    connectionName: e.connectionName,
    status: e.status,
    summary: e.summary,
    detectedAt: e.detectedAt,
    acknowledgedAt: e.acknowledgedAt,
    source: e.source,
  }));

  return (
    <div className="dr-stack">
      {/*
        Four tiles reading 0, 0, 0, 0 over "no checks recorded yet" summarise
        nothing. They only make the empty log look like a dashboard that has
        lost its data. The strip comes back with the first recorded check, which
        is also the first moment it has anything to say.
      */}
      {total > 0 && (
        <div className="dr-stats">
          <StatTile label="Recorded checks" value={total} />
          <StatTile label="Drifted" value={drifted} tone="drift" />
          <StatTile label="In sync" value={inSync} tone="sync" />
          <StatTile label="Acknowledged" value={acknowledged} />
        </div>
      )}

      <AuditLogTable rows={rows} />
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "drift" | "sync";
}) {
  // A zero stays quiet: the colour is for a number worth looking at.
  const toneClass = tone && value > 0 ? ` dr-stat--${tone}` : "";
  return (
    <div className={`dr-stat${toneClass}`}>
      <div className="dr-stat__label">{label}</div>
      <div className="dr-stat__value">{value}</div>
    </div>
  );
}
