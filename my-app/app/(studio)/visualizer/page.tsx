"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import Link from "next/link";
import { EmptyState } from "@/components/ui/EmptyState";
import { SchemaMapIcon, ConnectionsIcon } from "@/components/ui/icons";
import { VisualizerPane, type VizConnection } from "@/components/studio/visualizer/VisualizerPane";

// The Schema Visualizer. "Single" draws one schema; "Side by side" draws two
// independent panes (e.g. dev vs prod) with a draggable divider between them.
//
// Connections are fetched once here and shared with both panes; each pane owns
// its own schema selection + introspection. The LEFT pane sits at a stable spot
// in the tree across modes, so toggling Single↔Side-by-side keeps its diagram;
// the RIGHT pane mounts only in side-by-side.

type Mode = "single" | "split";

const MIN_PCT = 26;
const MAX_PCT = 74;

function PanelSingleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
    </svg>
  );
}
function PanelSplitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </svg>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="viz-mode" role="group" aria-label="View mode">
      <button
        type="button"
        className={`viz-mode__btn${mode === "single" ? " is-active" : ""}`}
        aria-pressed={mode === "single"}
        onClick={() => onChange("single")}
      >
        <PanelSingleIcon /> Single
      </button>
      <button
        type="button"
        className={`viz-mode__btn${mode === "split" ? " is-active" : ""}`}
        aria-pressed={mode === "split"}
        onClick={() => onChange("split")}
      >
        <PanelSplitIcon /> Side by side
      </button>
    </div>
  );
}

export default function VisualizerPage() {
  const [connections, setConnections] = useState<VizConnection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>("single");
  const [splitPct, setSplitPct] = useState(50);

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

  // ── Load connections once, shared by both panes ─────────────────────────--
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/connections", { cache: "no-store" });
        const data = await res.json();
        if (active && Array.isArray(data)) setConnections(data);
      } catch {
        /* the empty state below guides the user */
      } finally {
        if (active) setConnectionsLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // ── Divider drag (pointer-captured, so it tracks outside the handle) ─────--
  function onDividerDown(e: PointerEvent<HTMLDivElement>) {
    draggingRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable — drag still tracks while over the divider */
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

  return (
    <div className="viz-page">
      <div className="px-8 pt-8 pb-4 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="section-title mb-2">Visualizer</div>
          <h1 className="text-[28px] font-semibold tracking-[-0.018em]">See the schema.</h1>
          <p className="text-[13.5px] mt-1.5 max-w-[64ch]" style={{ color: "var(--text-2)" }}>
            A live entity-relationship map of any schema — tables, columns, keys, and the
            foreign-key paths between them. Switch to side by side to compare two schemas at once.
          </p>
        </div>
        {!noConnections && !narrow && <ModeToggle mode={mode} onChange={setMode} />}
      </div>

      {noConnections ? (
        <div className="viz-stage">
          <EmptyState
            icon={<SchemaMapIcon size={22} />}
            title="Add a connection first"
            description="The visualizer reads a live database, so it needs a saved PostgreSQL connection to draw from."
            actions={
              <Link href="/connections" className="btn btn-primary btn-sm">
                <ConnectionsIcon size={14} />
                Go to Connections
              </Link>
            }
          />
        </div>
      ) : (
        <div className={`viz-body${effectiveMode === "split" ? " viz-split" : ""}`} ref={splitRef}>
          {/* Left pane — stable position across modes, so its diagram survives a toggle. */}
          <div
            className="viz-split__pane"
            style={effectiveMode === "split" ? { flex: `0 0 ${splitPct}%` } : undefined}
          >
            <VisualizerPane connections={connections} connectionsLoaded={connectionsLoaded} />
          </div>

          {effectiveMode === "split" && (
            <>
              <div
                className="viz-divider"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize panes (double-click to reset)"
                onPointerDown={onDividerDown}
                onPointerMove={onDividerMove}
                onPointerUp={onDividerUp}
                onDoubleClick={resetSplit}
              >
                <span className="viz-divider__grip" />
              </div>
              <div className="viz-split__pane" style={{ flex: 1 }}>
                <VisualizerPane connections={connections} connectionsLoaded={connectionsLoaded} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
