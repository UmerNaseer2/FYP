"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pill, type PillTone } from "@/components/ui";
import { CheckIcon, SearchIcon } from "@/components/ui/icons";
import { timeAgo } from "@/lib/time-ago";
import { driftSourceLabel, type DriftSource } from "@/lib/drift-source";

type DriftStatus = "in_sync" | "drifted" | "unreachable";

/** One audit row (a serialisable mirror of DriftEventFeedItem). */
export type AuditRow = {
  id: number;
  trackedSchemaId: number;
  schemaName: string;
  connectionName: string | null;
  status: DriftStatus;
  summary: string | null;
  detectedAt: string;
  acknowledgedAt: string | null;
  /**
   * What ran this check. The whole point of a scheduler is that checks happen
   * without anybody pressing anything, and a log that cannot tell an automatic
   * check from a button press cannot show that it is working.
   */
  source: DriftSource;
};

type FilterKey = "all" | "drifted" | "in_sync" | "unreachable" | "acknowledged";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "drifted", label: "Drifted" },
  { key: "in_sync", label: "In sync" },
  { key: "unreachable", label: "Unreachable" },
  { key: "acknowledged", label: "Acknowledged" },
];

function statusMeta(status: DriftStatus): { tone: PillTone; label: string } {
  switch (status) {
    case "drifted":
      return { tone: "drift", label: "Drifted" };
    case "in_sync":
      return { tone: "sync", label: "In sync" };
    case "unreachable":
      return { tone: "break", label: "Unreachable" };
  }
}

/**
 * The dense, filterable audit log (Pass-7 "S7"). Every recorded drift check —
 * automatic or via an explicit action — lands here newest-first. Filters narrow
 * by status (plus an "Acknowledged" view that crosses status), and the search
 * box matches schema, connection or summary text. Each row links back to that
 * schema's drift detail. Pure client filtering over data the server already
 * read; no fetching of its own.
 */
export function AuditLogTable({ rows }: { rows: AuditRow[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      const passesFilter =
        filter === "all"
          ? true
          : filter === "acknowledged"
            ? r.acknowledgedAt !== null
            : r.status === filter;
      if (!passesFilter) return false;
      if (!q) return true;
      const haystack = (
        `${r.schemaName} ${r.connectionName ?? ""} ` +
        `${r.summary ?? ""} ${driftSourceLabel(r.source)}`
      ).toLowerCase();
      return haystack.includes(q);
    });
  }, [rows, filter, query]);

  // Per-filter counts so the chips double as a glanceable breakdown.
  const counts = useMemo(
    () => ({
      all: rows.length,
      drifted: rows.filter((r) => r.status === "drifted").length,
      in_sync: rows.filter((r) => r.status === "in_sync").length,
      unreachable: rows.filter((r) => r.status === "unreachable").length,
      acknowledged: rows.filter((r) => r.acknowledgedAt !== null).length,
    }),
    [rows]
  );

  // Five filter chips all reading 0 and a search box over an empty log are
  // controls for work that has not happened yet — the same first-run rule the
  // Connections table follows. They return with the first recorded check.
  const isFirstRun = rows.length === 0;

  return (
    <div className="space-y-4">
      {/* Controls: filter chips + search */}
      <div
        className="flex items-center justify-between gap-3 flex-wrap"
        hidden={isFirstRun}
      >
        <div className="flex items-center gap-1.5 flex-wrap">
          {FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className="text-[12.5px] px-2.5 py-1 rounded-md transition-colors"
                style={{
                  border: "1px solid var(--border)",
                  background: active ? "var(--text)" : "var(--surface)",
                  color: active ? "var(--surface)" : "var(--text-2)",
                }}
              >
                {f.label}
                <span className="mono ml-1.5 opacity-60">{counts[f.key]}</span>
              </button>
            );
          })}
        </div>

        <div className="relative">
          <span
            className="absolute left-2.5 top-1/2 -translate-y-1/2"
            style={{ color: "var(--text-3)" }}
          >
            <SearchIcon size={14} />
          </span>
          <input
            className="input text-[13px]"
            style={{ paddingLeft: 30, minWidth: 220 }}
            placeholder="Search schema, connection, summary…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search the audit log"
          />
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div
          className="panel p-6 text-center text-[13px]"
          style={{ color: "var(--text-3)" }}
        >
          {rows.length === 0
            ? "No drift checks have been recorded yet. Run a check from the Drift detail tab or the dashboard."
            : "No audit rows match this filter."}
        </div>
      ) : (
        <div className="panel p-0 overflow-hidden">
          <table className="responsive-table w-full text-[12.5px]" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr
                className="text-left"
                style={{ color: "var(--text-3)", borderBottom: "1px solid var(--border)" }}
              >
                <Th>When</Th>
                <Th>By</Th>
                <Th>Status</Th>
                <Th>Summary</Th>
                <Th>Schema</Th>
                <Th>Connection</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const meta = statusMeta(r.status);
                const href = `/drift?tab=detail&schema=${r.trackedSchemaId}`;
                return (
                  <tr
                    key={r.id}
                    // The row click is a convenience for the mouse. The thing
                    // that actually navigates is the link in the Schema cell,
                    // because a <tr> cannot be focused, activated with Enter,
                    // opened in a new tab, or announced as a link — and a row
                    // that only responds to a mouse is a row a keyboard user
                    // cannot open at all.
                    onClick={() => router.push(href)}
                    className="cursor-pointer audit-row"
                    style={{ borderBottom: "1px solid var(--border)" }}
                  >
                    <Td label="When">
                      <span className="mono whitespace-nowrap" style={{ color: "var(--text-2)" }}>
                        {timeAgo(r.detectedAt)}
                      </span>
                    </Td>
                    <Td label="By">
                      <span
                        className="text-[11.5px] whitespace-nowrap"
                        style={{ color: "var(--text-3)" }}
                      >
                        {driftSourceLabel(r.source)}
                      </span>
                    </Td>
                    <Td label="Status">
                      <span className="inline-flex items-center gap-1.5">
                        <Pill tone={meta.tone}>{meta.label}</Pill>
                        {r.acknowledgedAt && (
                          <span
                            className="inline-flex items-center gap-1 text-[11px]"
                            style={{ color: "var(--text-3)" }}
                            title={`Acknowledged ${timeAgo(r.acknowledgedAt)}`}
                          >
                            <CheckIcon size={11} /> ack&apos;d
                          </span>
                        )}
                      </span>
                    </Td>
                    <Td label="Summary">
                      <span style={{ color: "var(--text-2)" }}>{r.summary ?? "—"}</span>
                    </Td>
                    <Td label="Schema">
                      <Link
                        href={href}
                        className="mono audit-row__link"
                        style={{ color: "var(--text)" }}
                        // The row already navigates; letting the click through
                        // would ask the router for the same page twice.
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.schemaName}
                        <span className="sr-only">
                          {` — open the drift detail for this check, ${meta.label.toLowerCase()} ${timeAgo(
                            r.detectedAt
                          )}`}
                        </span>
                      </Link>
                    </Td>
                    <Td label="Connection">
                      <span className="mono" style={{ color: "var(--text-3)" }}>
                        {r.connectionName ?? "removed"}
                      </span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* "Showing 0 of 0 recorded checks" under "nothing recorded yet" is the
          empty state said twice, the second time in the language of a filter
          that is not on screen. */}
      <p className="text-[11.5px]" style={{ color: "var(--text-3)" }} hidden={isFirstRun}>
        Showing {filtered.length} of {rows.length} recorded check
        {rows.length === 1 ? "" : "s"} · newest first.
      </p>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="font-medium px-4 py-2.5 uppercase tracking-wide text-[10.5px]">{children}</th>
  );
}

function Td({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <td className="px-4 py-2.5 align-middle" data-label={label}>
      {children}
    </td>
  );
}
