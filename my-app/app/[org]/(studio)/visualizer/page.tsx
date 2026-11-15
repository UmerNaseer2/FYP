"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import Link from "next/link";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/studio/PageHeader";
import { PageTabs } from "@/components/studio/PillTabs";
import { SchemaMapIcon, ConnectionsIcon, CompareIcon } from "@/components/ui/icons";
import {
  VisualizerPane,
  type VizConnection,
  type VizPick,
} from "@/components/studio/visualizer/VisualizerPane";
import { apiFetch } from "@/lib/api-fetch";
import { useOrgHref } from "@/hooks/useOrg";
import "@/app/styles/atelier-visualizer.css";

// The Schema Visualizer. "Single" draws one schema; "Side by side" draws two
// independent panes with a draggable divider between them.
//
// Connections are fetched once here and shared with both panes; each pane owns
// its own schema selection and introspection. The LEFT pane sits at a stable spot
// in the tree across modes, so toggling Single and Side by side keeps its diagram;
// the RIGHT pane mounts only in side-by-side.

type Mode = "single" | "split";

const MIN_PCT = 26;
const MAX_PCT = 74;

const NO_PICK: VizPick = { connectionId: "", schema: "" };

// The two views, drawn with the shared PageTabs like every other page's tabs.
const MODE_TABS: { key: Mode; label: string }[] = [
  { key: "single", label: "Single" },
  { key: "split", label: "Side by side" },
];

export default function VisualizerPage() {
  const orgPath = useOrgHref();
  const [connections, setConnections] = useState<VizConnection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [connectionsFailed, setConnectionsFailed] = useState(false);
  const [mode, setMode] = useState<Mode>("single");
  const [splitPct, setSplitPct] = useState(50);
  // What each pane draws, reported by the pane, for the "Open in Compare" link.
  const [leftPick, setLeftPick] = useState<VizPick>(NO_PICK);
  const [rightPick, setRightPick] = useState<VizPick>(NO_PICK);

  // A draggable side-by-side split is unusable on a phone, so force single-pane
  // (and hide the mode toggle) under the tablet breakpoint.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const effectiveMode: Mode = narrow ? "single" : mode;

  const splitRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // Load connections once, shared by both panes.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await apiFetch("/api/connections", { cache: "no-store" });
        // A failed read must not become "you have no connections": that empty
        // state points at a page that cannot save one either.
        const data = res.ok ? await res.json() : null;
        if (!active) return;
        if (Array.isArray(data)) setConnections(data);
        else setConnectionsFailed(true);
      } catch {
        if (active) setConnectionsFailed(true);
      } finally {
        if (active) setConnectionsLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Divider drag (pointer-captured, so it tracks outside the handle).
  function onDividerDown(e: PointerEvent<HTMLDivElement>) {
    draggingRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable: drag still tracks while over the divider */
    }
  }
  function onDividerMove(e: PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current || !splitRef.current) return;
    const rect = splitRef.current.getBoundingClientRect();
    if (rect.width === 0) return;
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setSplitPct(Math.min(MAX_PCT, Math.max(MIN_PCT, pct)));
  }
  function onDividerUp(e: PointerEvent<HTMLDivElement>) {
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }
  function resetSplit() {
    setSplitPct(50);
  }

  const noConnections = connectionsLoaded && connections.length === 0;

  // "Open in Compare" takes along what the panes show. The first pane with a
  // connection picked becomes the source and a second one the target, which
  // keeps left and right in the order Compare lays them out. Only the pickers
  // are filled, with no run=1: left and right never said which schema should
  // change to match the other, so the reader checks the order and presses
  // Compare themselves. Nothing picked leaves the link bare, and Compare uses
  // its own defaults. An empty value is never sent either, because Compare
  // reads an empty sourceConnection as "no source", not as "pick one for me".
  const picked = [leftPick, ...(effectiveMode === "split" ? [rightPick] : [])].filter(
    (pick) => pick.connectionId !== ""
  );
  const compareQuery = new URLSearchParams();
  picked.forEach((pick, index) => {
    const side = index === 0 ? "source" : "target";
    compareQuery.set(`${side}Connection`, pick.connectionId);
    if (pick.schema !== "") compareQuery.set(`${side}Schema`, pick.schema);
  });
  const query = compareQuery.toString();
  const compareHref = orgPath(query ? `/compare?${query}` : "/compare");

  return (
    <div className="viz-page vz-page">
      {/* The one line under the title comes from lib/help/visualizer.ts. */}
      <div className="vz-head">
        <PageHeader page="/visualizer">
          {!noConnections && (
            <div className="vz-bar">
              {!narrow && (
                <div className="vz-bar__tabs" data-tour="visualizer-mode">
                  <PageTabs
                    label="View mode"
                    tabs={MODE_TABS}
                    value={mode}
                    onChange={(key) => setMode(key === "split" ? "split" : "single")}
                  />
                </div>
              )}
              <span className="vz-bar__gap" />
              {/* The way onward. Side by side is somebody looking for a
                  difference by eye: the diagram can show them one, but only
                  Compare can write the script that fixes it.

                  It sits outside the narrow check, unlike the toggle. Side by
                  side is what does not fit on a small screen, but wanting the
                  comparison is not.

                  Ghost and not a primary button, because reading the diagram
                  is a fair reason to be here and most visits end here on
                  purpose. */}
              <Link href={compareHref} className="btn btn-ghost btn-sm">
                <CompareIcon size={14} />
                Open in Compare
              </Link>
            </div>
          )}
        </PageHeader>
      </div>

      {noConnections ? (
        <div className="viz-stage vz-stage">
          {connectionsFailed ? (
            <EmptyState
              icon={<SchemaMapIcon size={22} />}
              title="Could not load your connections"
              description="The saved connections could not be read just now. Reload the page to try again."
            />
          ) : (
            <EmptyState
              icon={<SchemaMapIcon size={22} />}
              title="Add a connection first"
              description="The visualizer reads a live database, so it needs a saved PostgreSQL connection to draw from."
              actions={
                <Link href={orgPath("/connections")} className="btn btn-primary btn-sm">
                  <ConnectionsIcon size={14} />
                  Go to Connections
                </Link>
              }
            />
          )}
        </div>
      ) : (
        <div
          className={`viz-body vz-stage${effectiveMode === "split" ? " viz-split" : ""}`}
          data-tour="visualizer-diagram"
          ref={splitRef}
        >
          {/* Left pane: stable position across modes, so its diagram survives a toggle. */}
          <div
            className="viz-split__pane"
            style={effectiveMode === "split" ? { flex: `0 0 ${splitPct}%` } : undefined}
          >
            <VisualizerPane
              connections={connections}
              connectionsLoaded={connectionsLoaded}
              label={effectiveMode === "split" ? "Left pane" : "Connection and schema"}
              onPick={setLeftPick}
            />
          </div>

          {effectiveMode === "split" && (
            <>
              {/* A separator with pointer handlers and no tabIndex reads as
                  decoration, and the only control over the split was mouse-only. */}
              <div
                className="viz-divider vz-div"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize panes"
                title="Drag to resize · double-click to reset"
                tabIndex={0}
                aria-valuenow={Math.round(splitPct)}
                aria-valuemin={MIN_PCT}
                aria-valuemax={MAX_PCT}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") setSplitPct((p) => Math.max(MIN_PCT, p - 2));
                  else if (e.key === "ArrowRight") setSplitPct((p) => Math.min(MAX_PCT, p + 2));
                  else if (e.key === "Home") setSplitPct(MIN_PCT);
                  else if (e.key === "End") setSplitPct(MAX_PCT);
                  else if (e.key === "Enter") resetSplit();
                  else return;
                  e.preventDefault();
                }}
                onPointerDown={onDividerDown}
                onPointerMove={onDividerMove}
                onPointerUp={onDividerUp}
                onDoubleClick={resetSplit}
              >
                <span className="viz-divider__grip" />
              </div>
              <div className="viz-split__pane" style={{ flex: 1 }}>
                <VisualizerPane
                  connections={connections}
                  connectionsLoaded={connectionsLoaded}
                  label="Right pane"
                  onPick={setRightPick}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
