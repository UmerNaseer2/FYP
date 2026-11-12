"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Card, EmptyState } from "@/components/ui";
import { DriftIcon } from "@/components/ui/icons";
import { useOrgHref } from "@/hooks/useOrg";
import { useUser } from "@/hooks/useUser";
import { driftSourceLabel } from "@/lib/drift-source";
import type {
  DriftCounts,
  DriftDetailView,
  DriftEventFeedItem,
  DriftStatus,
  TrackedSchemaListItem,
} from "@/lib/lineage-db";
import { timeAgo } from "@/lib/time-ago";
import {
  DriftStatusPill,
  ErrorNote,
  Meta,
  RowsLoading,
  SectionHeading,
  UNREACHABLE_TEXT,
  sendJson,
  RefreshRow,
  useJson,
} from "./parts";

/** The ones that need someone first, the same order as the full site's Drift page. */
function sortPriority(status: DriftStatus | null): number {
  if (status === "drifted") return 0;
  if (status === "unreachable") return 1;
  if (status === "in_sync") return 3;
  return 2;
}

function countLines(counts: DriftCounts): string[] {
  const lines: [number, string, string][] = [
    [counts.tablesAdded, "table added", "tables added"],
    [counts.tablesRemoved, "table removed", "tables removed"],
    [counts.tablesChanged, "table changed", "tables changed"],
    [counts.constraintsChanged, "constraint changed", "constraints changed"],
    [counts.objectsChanged ?? 0, "other object changed", "other objects changed"],
  ];
  return lines
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
}

/** One recorded check. The History tab and a schema's own panel both list these. */
export function DriftEventRow({ event }: { event: DriftEventFeedItem }) {
  return (
    <div className="py-2.5" style={{ borderTop: "1px solid var(--border)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <DriftStatusPill status={event.status} acknowledged={event.acknowledgedAt !== null} />
        <span className="text-[12px]" style={{ color: "var(--text-3)" }}>
          {timeAgo(event.detectedAt)}
        </span>
      </div>
      <div className="text-[13px] mt-1" style={{ color: "var(--text-2)" }}>
        {event.status === "unreachable" ? UNREACHABLE_TEXT : event.summary}
      </div>
      <Meta>{driftSourceLabel(event.source)}</Meta>
    </div>
  );
}

function SchemaPanel({ id, onChanged }: { id: number; onChanged: () => void }) {
  const { can } = useUser();
  const orgPath = useOrgHref();
  const detail = useJson<DriftDetailView>(
    `/api/lineage/drift?trackedSchemaId=${id}`,
    "Could not read this schema's drift."
  );
  const history = useJson<DriftEventFeedItem[]>(
    `/api/lineage/audit?trackedSchemaId=${id}&limit=6`,
    "Could not read this schema's history."
  );
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(path: string, fallback: string) {
    setBusy(true);
    setError(null);
    const done = await sendJson(path, "POST", { trackedSchemaId: id }, fallback, setError);
    if (done) {
      await Promise.all([detail.reload(), history.reload()]);
      onChanged();
    }
    setConfirming(false);
    setBusy(false);
  }

  const view = detail.data;
  const acknowledged = view?.lastRecorded?.acknowledgedAt != null;
  const lines = view?.counts ? countLines(view.counts) : [];

  return (
    <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
      {detail.error && <ErrorNote>{detail.error}</ErrorNote>}
      {detail.loading && <div className="text-[13px]">Checking the database now…</div>}
      {view && (
        <>
          <div className="text-[13.5px]">
            {view.state === "unreachable" && UNREACHABLE_TEXT}
            {view.state === "no_baseline" && "This schema has no baseline to compare with yet."}
            {(view.state === "drifted" || view.state === "in_sync") && view.summary}
          </div>
          {lines.length > 0 && (
            <ul className="text-[13px] mt-1.5" style={{ color: "var(--text-2)" }}>
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <Meta>
            {view.expected.version ? `Compared with v${view.expected.version}. ` : ""}
            {view.driftIntervalMinutes > 0
              ? `Checked every ${view.driftIntervalMinutes} minutes.`
              : "Checked only by hand."}
          </Meta>
        </>
      )}

      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-3">
        {can("drift:run", "deploy:run") && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => run("/api/lineage/drift", "Could not run that check.")}
          >
            {busy && !confirming ? "Checking…" : "Check now"}
          </Button>
        )}
        {can("drift:update") && view?.state === "drifted" && !acknowledged && !confirming && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
            Acknowledge
          </Button>
        )}
        {confirming && (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => run("/api/lineage/acknowledge", "Could not acknowledge this drift.")}
            >
              Acknowledge this drift
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        )}
        <Link href={orgPath(`/drift?schema=${id}`)} className="btn btn-ghost btn-sm">
          See the changes
        </Link>
      </div>

      {history.data && history.data.length > 0 && (
        <>
          <SectionHeading>Recent checks</SectionHeading>
          {history.data.map((event) => (
            <DriftEventRow key={event.id} event={event} />
          ))}
        </>
      )}
    </div>
  );
}

export default function DriftTab() {
  const list = useJson<TrackedSchemaListItem[]>(
    "/api/lineage",
    "Could not read the tracked schemas."
  );
  const [openId, setOpenId] = useState<number | null>(null);

  if (list.loading) return <RowsLoading />;

  const rows = [...(list.data ?? [])].sort(
    (a, b) => sortPriority(a.driftStatus) - sortPriority(b.driftStatus)
  );

  return (
    <div className="flex flex-col gap-2">
      <RefreshRow onRefresh={list.reload} />
      {list.error && <ErrorNote>{list.error}</ErrorNote>}
      {!list.error && rows.length === 0 && (
        <EmptyState
          icon={<DriftIcon className="ico" />}
          title="No schemas tracked yet"
          description="Schemas you track on the full site show up here, with an alert when one drifts."
        />
      )}
      {rows.map((row) => {
        const open = openId === row.id;
        return (
          <Card key={row.id} className="p-4">
            <button
              type="button"
              className="w-full text-left"
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : row.id)}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-semibold">{row.label ?? row.schemaName}</span>
              </div>
              <div className="text-[13px] mt-0.5" style={{ color: "var(--text-2)" }}>
                {row.connectionName}
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <DriftStatusPill
                  status={row.driftStatus}
                  acknowledged={row.driftAcknowledgedAt !== null}
                />
                {row.driftCheckedAt && (
                  <span className="text-[12px]" style={{ color: "var(--text-3)" }}>
                    {timeAgo(row.driftCheckedAt)}
                  </span>
                )}
              </div>
              {/* Open, the panel says this from a fresh read, so it would only repeat. */}
              {!open && row.driftStatus === "drifted" && row.driftSummary && (
                <div className="text-[13px] mt-1.5" style={{ color: "var(--text-2)" }}>
                  {row.driftSummary}
                </div>
              )}
              {!open && row.driftStatus === "unreachable" && (
                <div className="text-[13px] mt-1.5" style={{ color: "var(--text-2)" }}>
                  {UNREACHABLE_TEXT}
                </div>
              )}
            </button>
            {open && <SchemaPanel id={row.id} onChanged={() => void list.reload()} />}
          </Card>
        );
      })}
    </div>
  );
}
