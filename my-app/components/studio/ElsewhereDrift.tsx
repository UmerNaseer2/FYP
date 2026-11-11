"use client";

import { useEffect, useState } from "react";
import { EnvironmentPill, Pill, type PillTone } from "@/components/ui";
import { DriftIcon, MonitorIcon } from "@/components/ui/icons";
import { HelpHint } from "@/components/ui/HelpHint";
import { useDesktopBridge } from "@/hooks/useDesktopBridge";
import { useUser } from "@/hooks/useUser";
import { apiFetch } from "@/lib/api-fetch";
import { getDesktopBridge, type DesktopWebsiteDrift } from "@/lib/desktop-bridge";
import { describeCadence } from "@/lib/drift-schedule";
import { toEnvironment } from "@/lib/environments";
import { utcStamp } from "@/lib/format-date";
import { timeAgo } from "@/lib/time-ago";
// Types only, so nothing from the server side comes into the page.
import type { Computer } from "@/lib/agent-rules";

/**
 * Drift results checked somewhere else (docs/two-way-sync-plan.md, step 2).
 *
 * Each schema is checked in one place only: the website checks its own
 * connections, and a desktop checks the ones that stay on that computer. Only
 * the results travel, so this list shows each schema's latest result and leaves
 * the full diff to the place that ran it.
 *
 *  - In the desktop app: what the linked website checks ("Checked by the website").
 *  - In a browser: what this person's own linked computers check ("On your computers").
 *
 * Draws nothing when there is nothing to show, and nothing on a failure: the
 * rest of the page is about this side's own schemas and stands without it.
 */

/** How often the desktop asks again while the page is open. The app keeps its own copy fresh in between. */
const ASK_EVERY_MS = 60_000;

type Row = {
  key: string;
  connectionName: string;
  environment: string;
  schema: string;
  label: string | null;
  intervalMinutes: number;
  lastCheckedAt: string | null;
  /** The newest check, or null when none has been recorded yet. */
  latest: { status: string; summary: string } | null;
};

type Place = { key: string; name: string; online: boolean; lastSeenAt: string | null; rows: Row[] };

function pillFor(status: string): { tone: PillTone; label: string } {
  if (status === "drifted") return { tone: "drift", label: "Drifted" };
  if (status === "in_sync") return { tone: "sync", label: "In sync" };
  return { tone: "break", label: "Unreachable" };
}

export function ElsewhereDrift() {
  const bridge = useDesktopBridge();
  return bridge ? <CheckedByWebsite /> : <OnYourComputers />;
}

// ── In the desktop app ───────────────────────────────────────────────────────

function CheckedByWebsite() {
  const [drift, setDrift] = useState<DesktopWebsiteDrift | null>(null);

  useEffect(() => {
    const desktop = getDesktopBridge();
    if (!desktop) return;
    let live = true;
    const ask = () => {
      desktop.syncDrift().then(
        (answer) => {
          if (live) setDrift(answer);
        },
        () => {
          // The last answer stands until the next one.
        }
      );
    };
    ask();
    const timer = window.setInterval(ask, ASK_EVERY_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  if (drift === null || !drift.linked) return null;
  // Before the website's first answer `allowed` is not known yet, so only being offline is worth a word.
  if (drift.schemas === null) {
    if (drift.online) return null;
    return (
      <Section icon={<DriftIcon size={14} />} title="Checked by the website">
        <p className="help">
          {drift.orgName} checks drift on its own connections, but the website cannot be reached right now, so
          those results are not here yet.
        </p>
      </Section>
    );
  }
  if (!drift.allowed || drift.schemas.length === 0) return null;

  const rows: Row[] = drift.schemas.map((s) => ({
    key: `${s.connectionId}:${s.schema}`,
    connectionName: s.connectionName,
    environment: s.environment,
    schema: s.schema,
    label: s.label,
    intervalMinutes: s.intervalMinutes,
    lastCheckedAt: s.lastCheckedAt,
    latest: s.checks[0] ?? null,
  }));
  const asOf = drift.syncedAt === null ? "" : utcStamp(new Date(drift.syncedAt).toISOString());
  const href = drift.orgSlug === null ? null : `${drift.origin}/${drift.orgSlug}/drift`;

  return (
    <Section
      icon={<DriftIcon size={14} />}
      title="Checked by the website"
      hint={
        <>
          {drift.orgName} checks these schemas on its own connections. This computer shows their latest
          results. The full diff is on the website.
        </>
      }
      action={
        href && (
          <a href={href} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm">
            Open on the website
          </a>
        )
      }
    >
      {(asOf || !drift.online) && (
        <p className="help max-w-[70ch] mb-3">
          {asOf && `As of ${asOf}.`}
          {!drift.online && " The website cannot be reached right now, so these may be out of date."}
        </p>
      )}
      <RowList rows={rows} label={`Drift checked by ${drift.orgName}`} />
    </Section>
  );
}

// ── In a browser ─────────────────────────────────────────────────────────────

function readPlaces(body: unknown): Place[] {
  const computers = (body as { computers?: unknown } | null)?.computers;
  if (!Array.isArray(computers)) return [];
  const places: Place[] = [];
  for (const computer of computers as Computer[]) {
    const rows: Row[] = [];
    for (const connection of Array.isArray(computer?.connections) ? computer.connections : []) {
      for (const s of Array.isArray(connection?.drift) ? connection.drift : []) {
        rows.push({
          key: `${connection.id}:${s.schema}`,
          connectionName: connection.name,
          environment: connection.environment,
          schema: s.schema,
          label: s.label,
          intervalMinutes: s.intervalMinutes,
          lastCheckedAt: s.lastCheckedAt,
          latest: s.checks[0] ?? null,
        });
      }
    }
    if (rows.length > 0) {
      places.push({ key: String(computer.id), name: computer.name, online: computer.online, lastSeenAt: computer.lastSeenAt, rows });
    }
  }
  return places;
}

function OnYourComputers() {
  const { loading, can } = useUser();
  const mayAsk = !loading && can("compare:read");
  const [places, setPlaces] = useState<Place[]>([]);

  useEffect(() => {
    if (getDesktopBridge() || !mayAsk) return;
    let live = true;
    apiFetch("/api/computers?connections=all")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        if (live) setPlaces(readPlaces(body));
      })
      .catch(() => {
        // Nothing to add: the rest of the page is about the website's own schemas.
      });
    return () => {
      live = false;
    };
  }, [mayAsk]);

  if (places.length === 0) return null;
  return (
    <Section
      icon={<MonitorIcon size={14} />}
      title="On your computers"
      hint="Schemas the desktop app checks on your own computers, on connections that stay there. Only you see this list. The full diff is in the desktop app on that computer."
    >
      <div className="space-y-4">
        {places.map((place) => (
          <div key={place.key}>
            <div className="flex items-center gap-2 flex-wrap text-[13px] mb-1.5">
              <span className="font-medium">{place.name}</span>
              {place.online ? (
                <span className="pill pill-sync">
                  <span className="dot" />
                  Online
                </span>
              ) : (
                <span className="pill pill-neutral">
                  <span className="dot" style={{ background: "var(--text-3)" }} />
                  Offline
                </span>
              )}
              {!place.online && place.lastSeenAt && (
                <span className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
                  last seen {timeAgo(place.lastSeenAt)}
                </span>
              )}
            </div>
            <RowList rows={place.rows} label={`Drift checked on ${place.name}`} />
          </div>
        ))}
      </div>
    </Section>
  );
}

// ── Shared pieces ────────────────────────────────────────────────────────────

function Section({
  icon,
  title,
  hint,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  /** The short explanation behind the "?" beside the title. */
  hint?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
        <div className="flex items-center gap-2">
          <span style={{ color: "var(--text-3)" }}>{icon}</span>
          <h2 className="text-[14px] font-semibold">{title}</h2>
          {hint && <HelpHint label={title}>{hint}</HelpHint>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function RowList({ rows, label }: { rows: Row[]; label: string }) {
  return (
    <ul className="panel p-0 overflow-hidden" aria-label={label}>
      {rows.map((row, i) => {
        const pill = row.latest ? pillFor(row.latest.status) : null;
        return (
          <li
            key={row.key}
            className="flex items-center gap-3 px-4 py-2.5 text-[12.5px] flex-wrap"
            style={{ borderTop: i === 0 ? "none" : "1px solid var(--border)" }}
          >
            {pill ? <Pill tone={pill.tone}>{pill.label}</Pill> : <Pill tone="neutral">Not checked</Pill>}
            <span className="min-w-0">
              <span className="font-medium">{row.label ?? row.schema}</span>
              <span style={{ color: "var(--text-3)" }}>
                {" "}
                on {row.connectionName}
                {row.label ? ` (${row.schema})` : ""}
              </span>
            </span>
            <EnvironmentPill environment={toEnvironment(row.environment)} />
            <span className="flex-1 min-w-0 truncate" style={{ color: "var(--text-2)" }}>
              {row.latest?.summary || ""}
            </span>
            <span className="text-[11px] whitespace-nowrap" style={{ color: "var(--text-3)" }}>
              {row.intervalMinutes > 0 ? `Checked ${describeCadence(row.intervalMinutes)}` : "Checked by hand"}
              {row.lastCheckedAt ? `, last ${utcStamp(row.lastCheckedAt)}` : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
