"use client";

import "@/app/styles/atelier-history.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AskAdmin } from "@/components/studio/AskAdmin";
import { downloadText } from "@/components/studio/ExportBar";
import { PageHeader } from "@/components/studio/PageHeader";
import { AlertCircleIcon, AlertTriangleIcon, CheckIcon, InfoIcon } from "@/components/ui/icons";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { useNow } from "@/hooks/useNow";
import { useOrgHref } from "@/hooks/useOrg";
import { useUser } from "@/hooks/useUser";
import {
  ACTIVITY_KINDS,
  ACTIVITY_LIMIT,
  NO_FILTERS,
  RIBBON_DAYS,
  RIBBON_MARKS,
  activityCsv,
  countLines,
  dayKey,
  isKind,
  lastDays,
  matchesFilters,
  statusLabel,
  type ActivityFilters,
} from "@/lib/activity";
import { apiFetch } from "@/lib/api-fetch";
import { DRIFT_SOURCES, driftSourceLabel } from "@/lib/drift-source";
import { historyHelp } from "@/lib/help/history";
import type { DriftEventFeedItem, DriftStatus } from "@/lib/lineage-db";
import { refusalMessage } from "@/lib/permissions";

/**
 * Your activity: every drift check recorded for the organization, newest
 * first. The data is GET /api/lineage/audit, the same list the Drift page's
 * Audit log tab reads, and it is read only.
 *
 * Reading it needs Drift tracking: Read. A role without that sees a plain
 * refusal and the page never asks the server for the list.
 */
export default function HistoryPage() {
  const orgPath = useOrgHref();
  const { roleLabel, loading: sessionLoading, can } = useUser();
  const now = useNow(60_000);
  const allowed = can("drift:read");

  // null means "still loading". `error` holds a sentence to show instead.
  const [events, setEvents] = useState<DriftEventFeedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The server said no (403), even though the page thought the role could read.
  const [refused, setRefused] = useState(false);
  // Bumped by Retry so the effect below runs again.
  const [attempt, setAttempt] = useState(0);

  const [filters, setFilters] = useState<ActivityFilters>(NO_FILTERS);
  const [pickedId, setPickedId] = useState<number | null>(null);
  // The row whose card is open under it. Only narrow screens show that card
  // (atelier-history.css); wide ones keep the card beside the list instead.
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    if (sessionLoading || !allowed) return;
    let cancelled = false;

    async function load() {
      try {
        const res = await apiFetch(`/api/lineage/audit?limit=${ACTIVITY_LIMIT}`, {
          cache: "no-store",
        });
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.status === 403) {
          setRefused(true);
        } else if (res.ok && Array.isArray(body)) {
          setEvents(body as DriftEventFeedItem[]);
          setError(null);
        } else {
          setError(body?.error ?? "Could not load your organization's activity.");
        }
      } catch {
        if (!cancelled) setError("Could not reach the server to read the activity.");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [sessionLoading, allowed, attempt]);

  function retry() {
    setError(null);
    setEvents(null);
    setAttempt((n) => n + 1);
  }

  // A tap picks the row. Tapping the open row again closes its card on a
  // narrow screen; on a wide one the card beside the list simply stays.
  function pick(id: number) {
    setPickedId(id);
    setOpenId((current) => (current === id ? null : id));
  }

  function changeFilters(change: Partial<ActivityFilters>) {
    setFilters((current) => ({ ...current, ...change }));
  }

  // Newest first, whatever order the server used.
  const all = [...(events ?? [])].sort(
    (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime()
  );
  const visible = all.filter((event) => matchesFilters(event, filters));
  const picked = visible.find((event) => event.id === pickedId) ?? visible[0] ?? null;
  const filtered =
    filters.kind !== "all" ||
    filters.schema !== "" ||
    filters.source !== "" ||
    filters.search.trim() !== "" ||
    filters.day !== null;

  function exportCsv() {
    // The file is named after today, for example activity-2026-11-12.csv.
    const stem = now !== null ? `activity-${dayKey(now)}` : "activity";
    downloadText(`${stem}.csv`, activityCsv(visible), "text/csv");
  }

  const actions = (
    <div className="hi-acts no-print">
      <button
        type="button"
        className="hi-btn"
        onClick={() => window.print()}
        disabled={visible.length === 0}
      >
        Print report
      </button>
      <button type="button" className="hi-btn" onClick={exportCsv} disabled={visible.length === 0}>
        Export as CSV
      </button>
    </div>
  );

  const cannotRead = refused || (!sessionLoading && !allowed);

  // The picked check's card. It is drawn beside the list, and again under the
  // open row for narrow screens; CSS shows only one of the two.
  const detail = picked ? (
    <Detail key={picked.id} event={picked} href={orgPath(driftHref(picked))} />
  ) : null;

  return (
    <div className="hi-page">
      <PageHeader
        page="/history"
        title={historyHelp.title}
        blurb={historyHelp.blurb}
        actions={cannotRead ? null : actions}
      />

      {cannotRead ? (
        <div className="role-note">
          <InfoIcon size={15} className="ico" />
          <div>
            <div className="title">You can&apos;t see the activity</div>
            <div className="body">
              {refusalMessage(roleLabel, "drift:read")}
              <AskAdmin permission="drift:read" />
            </div>
          </div>
        </div>
      ) : error ? (
        <div className="hi-none" role="alert">
          <h2>Couldn&apos;t load the activity</h2>
          <p>{error}</p>
          <button type="button" className="btn btn-secondary" onClick={retry}>
            Retry
          </button>
        </div>
      ) : events === null ? (
        <div className="hi-skel" role="status" aria-label="Loading the activity">
          <Skeleton height={170} radius={18} />
          <Skeleton height={58} radius={18} />
          <Skeleton height={58} radius={18} />
          <Skeleton height={58} radius={18} />
        </div>
      ) : all.length === 0 ? (
        <div className="hi-none">
          <h2>No checks recorded yet</h2>
          <p>Track a schema on the Dashboard and check it for drift. Every check will be listed here.</p>
          <Link href={orgPath("/studio")} className="btn btn-primary">
            Go to the Dashboard
          </Link>
        </div>
      ) : (
        <>
          {now !== null && (
            <Ribbon
              all={all}
              now={now}
              filters={filters}
              onDay={(day) => changeFilters({ day })}
            />
          )}

          <div className="hi-f" role="group" aria-label="Filter by result">
            {ACTIVITY_KINDS.map((kind) => (
              <button
                key={kind.key}
                type="button"
                className="hi-kind"
                aria-pressed={filters.kind === kind.key}
                onClick={() => changeFilters({ kind: kind.key })}
              >
                {kind.label}
                <em>{all.filter((event) => isKind(event, kind.key)).length}</em>
              </button>
            ))}
          </div>

          <div className="hi-f2">
            <Select
              key={`schema-${filters.schema}`}
              ariaLabel="Schema"
              variant="input"
              value={filters.schema}
              options={schemaOptions(all)}
              onChange={(schema) => changeFilters({ schema })}
            />
            <Select
              key={`source-${filters.source}`}
              ariaLabel="Started by"
              variant="input"
              value={filters.source}
              options={[
                { value: "", label: "Started by anything" },
                ...DRIFT_SOURCES.map((source) => ({ value: source.key, label: source.label })),
              ]}
              onChange={(source) => changeFilters({ source })}
            />
            <input
              type="search"
              className="hi-search"
              aria-label="Search the activity"
              placeholder="Search, for example a schema name"
              value={filters.search}
              onChange={(e) => changeFilters({ search: e.target.value })}
            />
          </div>

          <div className="hi-print-head">
            <h2>Activity report</h2>
            <p>
              {visible.length} of {all.length} recorded drift checks.
              {now !== null && ` Printed ${fullDate(now)}.`}
            </p>
          </div>

          <div className="hi-grid">
            <div aria-live="polite">
              {visible.length === 0 ? (
                <div className="hi-none">
                  <h2>Nothing matches</h2>
                  <p>No recorded check fits these filters.</p>
                  <button type="button" className="hi-link" onClick={() => setFilters(NO_FILTERS)}>
                    Clear every filter
                  </button>
                </div>
              ) : (
                <Feed
                  events={visible}
                  now={now}
                  pickedId={picked?.id ?? null}
                  openId={openId}
                  detail={detail}
                  onPick={pick}
                />
              )}
              {all.length >= ACTIVITY_LIMIT && (
                <p className="hi-cap">
                  This page lists the newest {ACTIVITY_LIMIT} checks. Older ones are on each
                  schema&apos;s drift page.
                </p>
              )}
              {filtered && visible.length > 0 && (
                <p className="hi-cap no-print">
                  Showing {visible.length} of {all.length}.{" "}
                  <button type="button" className="hi-link" onClick={() => setFilters(NO_FILTERS)}>
                    Clear every filter
                  </button>
                </p>
              )}
            </div>

            {detail}
          </div>
        </>
      )}
    </div>
  );
}

// ── Small helpers ──────────────────────────────────────────────────────────

/** The Drift page, opened on this check's schema. */
function driftHref(event: DriftEventFeedItem): string {
  return `/drift?tab=detail&schema=${event.trackedSchemaId}`;
}

/** "12 Nov 2026, 14:21" in the reader's own language and time zone. */
function fullDate(when: string | number): string {
  return new Date(when).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "14:21" */
function clock(when: string): string {
  return new Date(when).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "12 Nov" */
function shortDay(key: string): string {
  return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

/** "Today", "Yesterday", or "Tue, 10 Nov 2026". */
function dayTitle(key: string, now: number | null): string {
  if (now !== null) {
    if (key === dayKey(now)) return "Today";
    if (key === dayKey(now - 24 * 60 * 60 * 1000)) return "Yesterday";
  }
  return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "1 check" or "3 checks". */
function checks(count: number): string {
  return count === 1 ? "1 check" : `${count} checks`;
}

/** The end of the sentence "<schema> ...". */
function statusPhrase(status: DriftStatus): string {
  if (status === "drifted") return "has drifted";
  if (status === "in_sync") return "is in sync";
  return "could not be reached";
}

function statusTone(status: DriftStatus): PillTone {
  if (status === "drifted") return "drift";
  if (status === "in_sync") return "sync";
  return "break";
}

function StatusIcon({ status }: { status: DriftStatus }) {
  if (status === "drifted") return <AlertTriangleIcon size={16} />;
  if (status === "in_sync") return <CheckIcon size={16} />;
  return <AlertCircleIcon size={16} />;
}

/** One option per schema that appears in the list, plus "All schemas". */
function schemaOptions(all: DriftEventFeedItem[]) {
  const options = [{ value: "", label: "All schemas" }];
  const seen = new Set<number>();
  for (const event of all) {
    if (seen.has(event.trackedSchemaId)) continue;
    seen.add(event.trackedSchemaId);
    options.push({
      value: String(event.trackedSchemaId),
      label: event.connectionName
        ? `${event.schemaName} on ${event.connectionName}`
        : event.schemaName,
    });
  }
  return options;
}

// ── The Last 30 days strip ─────────────────────────────────────────────────

function Ribbon({
  all,
  now,
  filters,
  onDay,
}: {
  all: DriftEventFeedItem[];
  now: number;
  filters: ActivityFilters;
  onDay: (day: string | null) => void;
}) {
  const days = lastDays(now, RIBBON_DAYS);
  const today = dayKey(now);
  // Squares dim when the other filters hide their check. The day filter is
  // left out, or picking a day would dim every other day.
  const others: ActivityFilters = { ...filters, day: null };

  const byDay = new Map<string, DriftEventFeedItem[]>();
  for (const event of all) {
    const key = dayKey(event.detectedAt);
    byDay.set(key, [...(byDay.get(key) ?? []), event]);
  }
  const inRange = days.reduce((sum, key) => sum + (byDay.get(key)?.length ?? 0), 0);
  const busyDays = days.filter((key) => byDay.has(key)).length;

  // On a phone the strip scrolls sideways inside its card. Start it at today.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (strip.current) strip.current.scrollLeft = strip.current.scrollWidth;
  }, []);

  return (
    <section className="hi-rib no-print" aria-label="Checks per day, last 30 days">
      <div className="hi-rh">
        <h2>Last {RIBBON_DAYS} days</h2>
        <small>
          {checks(inRange)} on {busyDays === 1 ? "1 day" : `${busyDays} days`}
        </small>
        {filters.day !== null && (
          <button type="button" className="hi-link" onClick={() => onDay(null)}>
            Show all {RIBBON_DAYS} days
          </button>
        )}
      </div>

      <div className="hi-days" ref={strip}>
        {days.map((key) => {
          const dayEvents = byDay.get(key) ?? [];
          const dayNumber = Number(key.slice(8));
          const className = key === today ? "hi-day hi-now" : "hi-day";

          if (dayEvents.length === 0) {
            return (
              <div key={key} className={className} role="img" aria-label={`${shortDay(key)}: no checks`}>
                <b aria-hidden="true">{dayNumber}</b>
              </div>
            );
          }

          // Checks the filters keep come first, so the squares on show are
          // the ones the list below is showing.
          const kept = dayEvents.filter((event) => matchesFilters(event, others));
          const hidden = dayEvents.filter((event) => !matchesFilters(event, others));
          const marks = [...kept, ...hidden].slice(0, RIBBON_MARKS);
          const extra = dayEvents.length - marks.length;
          const drifted = dayEvents.filter((event) => event.status === "drifted").length;
          const unreachable = dayEvents.filter((event) => event.status === "unreachable").length;
          const label =
            `${shortDay(key)}: ${checks(dayEvents.length)}` +
            (drifted > 0 ? `, ${drifted} drifted` : "") +
            (unreachable > 0 ? `, ${unreachable} unreachable` : "");

          return (
            <button
              key={key}
              type="button"
              className={className}
              aria-pressed={filters.day === key}
              aria-label={label}
              title={label}
              onClick={() => onDay(filters.day === key ? null : key)}
            >
              <b aria-hidden="true">{dayNumber}</b>
              {marks.map((event) => (
                <span
                  key={event.id}
                  className="hi-mark"
                  data-status={event.status}
                  data-off={kept.includes(event) ? undefined : "true"}
                />
              ))}
              {extra > 0 && <span className="hi-more">+{extra}</span>}
            </button>
          );
        })}
      </div>

      <div className="hi-key">
        <span>
          <span className="hi-mark" data-status="in_sync" />
          In sync
        </span>
        <span>
          <span className="hi-mark" data-status="drifted" />
          Drifted
        </span>
        <span>
          <span className="hi-mark" data-status="unreachable" />
          Unreachable
        </span>
        <span>
          One square is one check, up to {RIBBON_MARKS} a day. Pick a day to see only that day.
        </span>
      </div>
    </section>
  );
}

// ── The list, grouped by day ───────────────────────────────────────────────

function Feed({
  events,
  now,
  pickedId,
  openId,
  detail,
  onPick,
}: {
  events: DriftEventFeedItem[];
  now: number | null;
  pickedId: number | null;
  openId: number | null;
  detail: ReactNode;
  onPick: (id: number) => void;
}) {
  // The events arrive newest first, so each day's checks sit together.
  const groups: { key: string; events: DriftEventFeedItem[] }[] = [];
  for (const event of events) {
    const key = dayKey(event.detectedAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.events.push(event);
    else groups.push({ key, events: [event] });
  }

  return (
    <>
      {groups.map((group) => (
        <section key={group.key} aria-label={dayTitle(group.key, now)}>
          <h2 className="hi-dh">
            {dayTitle(group.key, now)}
            <small>{checks(group.events.length)}</small>
          </h2>
          <ul className="hi-list">
            {group.events.map((event) => (
              <li key={event.id}>
                <button
                  type="button"
                  className="hi-row"
                  data-status={event.status}
                  aria-current={event.id === pickedId ? "true" : undefined}
                  onClick={() => onPick(event.id)}
                >
                  <time dateTime={event.detectedAt}>{clock(event.detectedAt)}</time>
                  <span className="hi-ic" aria-hidden="true">
                    <StatusIcon status={event.status} />
                  </span>
                  <span className="hi-tx">
                    <span className="hi-tx-main">
                      <b>{event.schemaName}</b> {statusPhrase(event.status)}
                    </span>
                    <small>
                      {event.connectionName ? `${event.connectionName}, ` : ""}
                      {driftSourceLabel(event.source)}
                      {event.acknowledgedAt ? ", acknowledged" : ""}
                    </small>
                  </span>
                  <Pill tone={statusTone(event.status)}>{statusLabel(event.status)}</Pill>
                </button>
                {event.id === openId && event.id === pickedId && (
                  <div className="hi-inline">{detail}</div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

// ── The card beside the list ───────────────────────────────────────────────

function Detail({ event, href }: { event: DriftEventFeedItem; href: string }) {
  const counts = countLines(event.detail);

  return (
    <aside className="hi-det" aria-label="Check detail">
      <div className="hi-dk">
        Drift check
        <Pill tone={statusTone(event.status)}>{statusLabel(event.status)}</Pill>
      </div>
      <h2>
        {event.schemaName} {statusPhrase(event.status)}
      </h2>

      <dl>
        <dt>When</dt>
        <dd>{fullDate(event.detectedAt)}</dd>
        <dt>Started by</dt>
        <dd>{driftSourceLabel(event.source)}</dd>
        <dt>Where</dt>
        <dd>{event.connectionName ?? "Not recorded"}</dd>
        {event.acknowledgedAt && (
          <>
            <dt>Acknowledged</dt>
            <dd>{fullDate(event.acknowledgedAt)}</dd>
          </>
        )}
      </dl>

      {counts.length > 0 && (
        <>
          <h3>What the check found</h3>
          <ul className="hi-counts">
            {counts.map((line) => (
              <li key={line.label}>
                {line.label}
                <span>{line.count}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {event.summary && <p className="hi-note">{event.summary}</p>}

      <Link href={href} className="btn btn-primary hi-go">
        Open in Drift
      </Link>
      <p className="hi-lock">Entries are read only on this page.</p>
    </aside>
  );
}
