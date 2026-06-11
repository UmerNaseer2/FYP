"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Pill, type PillTone } from "@/components/ui";
import { CheckIcon, SearchIcon } from "@/components/ui/icons";

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
};

type FilterKey = "all" | "drifted" | "in_sync" | "unreachable" | "acknowledged";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "drifted", label: "Drifted" },
  { key: "in_sync", label: "In sync" },
  { key: "unreachable", label: "Unreachable" },
  { key: "acknowledged", label: "Acknowledged" },
];

/** Compact "3m ago" style relative time. Client-only, so no SSR mismatch. */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

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
      const haystack = `${r.schemaName} ${r.connectionName ?? ""} ${r.summary ?? ""}`.toLowerCase();
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

  return (
    <div className="space-y-4">
      {/* Controls: filter chips + search */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
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
                <Th>Status</Th>
                <Th>Summary</Th>
                <Th>Schema</Th>
                <Th>Connection</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const meta = statusMeta(r.status);
                return (
                  <tr
                    key={r.id}
                    onClick={() => router.push(`/drift?tab=detail&schema=${r.trackedSchemaId}`)}
                    className="cursor-pointer audit-row"
                    style={{ borderBottom: "1px solid var(--border)" }}
                  >
                    <Td label="When">
                      <span className="mono whitespace-nowrap" style={{ color: "var(--text-2)" }}>
                        {timeAgo(r.detectedAt)}
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
                      <span className="mono" style={{ color: "var(--text)" }}>
                        {r.schemaName}
                      </span>
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

      <p className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
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
