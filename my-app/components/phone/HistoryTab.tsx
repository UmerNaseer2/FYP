"use client";

import { Card, EmptyState } from "@/components/ui";
import { DriftIcon } from "@/components/ui/icons";
import type { DriftEventFeedItem } from "@/lib/lineage-db";
import { DriftEventRow } from "./DriftTab";
import { ErrorNote, RefreshRow, RowsLoading, useJson } from "./parts";

/** Every recorded check across this organization, newest first. */
export default function HistoryTab() {
  const feed = useJson<DriftEventFeedItem[]>(
    "/api/lineage/audit?limit=50",
    "Could not read the history."
  );

  if (feed.loading) return <RowsLoading />;

  const events = feed.data ?? [];
  return (
    <div className="flex flex-col gap-2">
      <RefreshRow onRefresh={feed.reload} />
      {feed.error && <ErrorNote>{feed.error}</ErrorNote>}
      {!feed.error && events.length === 0 && (
        <EmptyState
          icon={<DriftIcon className="ico" />}
          title="No checks recorded yet"
          description="Each drift check is listed here once it has run."
        />
      )}
      {events.length > 0 && (
        <Card className="px-4 pb-1">
          {events.map((event, at) => (
            <div key={event.id} className={at === 0 ? "pt-3" : "pt-1"}>
              <div className="text-[13.5px] font-semibold">{event.schemaName}</div>
              {event.connectionName && (
                <div className="text-[12px]" style={{ color: "var(--text-3)" }}>
                  {event.connectionName}
                </div>
              )}
              <DriftEventRow event={event} />
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
