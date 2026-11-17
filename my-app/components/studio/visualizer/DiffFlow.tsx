"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { CompareReport } from "@/lib/compare";
import { buildDiffGraph, type DiffGraph, type DiffNodeData, type DiffStatus } from "./diff-graph";
import { DiffTableNode } from "./DiffTableNode";

// The Compare page's map of changes: the Visualizer's canvas drawing the
// difference between two schemas instead of one schema. Loaded with
// next/dynamic (ssr: false) like SchemaFlow, because React Flow measures the
// DOM. The page remounts it (key) when "Only tables with changes" flips, so the
// layout is worked out once per set of tables.

const nodeTypes = { diffTable: DiffTableNode };

type FlowNode = Node<DiffNodeData>;

export type DiffFlowProps = {
  report: CompareReport;
  /** The tile pressed above, if any. Tables without that kind of change dim. */
  filter: DiffStatus | null;
  onlyChanged: boolean;
  /** Full screen: wheel zoom and drag on. Inline: the page scrolls past it. */
  full: boolean;
  /** Phone width, inline: a still picture, so a swipe scrolls the page. */
  compact: boolean;
  /** A table was pressed: show its card in the list below. */
  onJump: (nodeId: string) => void;
};

/** Phone, inline: the tables are drawn at this size in a strip that scrolls sideways. */
const STRIP_SCALE = 0.58;
/** ...unless that makes the strip taller than this, then smaller. */
const STRIP_MAX_HEIGHT = 380;

/** How far the drawing reaches, margins included (dagre starts it 24px in). */
function extent(graph: DiffGraph): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const n of graph.nodes) {
    width = Math.max(width, n.position.x + n.width);
    height = Math.max(height, n.position.y + n.height);
  }
  return { width: width + 24, height: height + 24 };
}

function toFlowNodes(graph: DiffGraph): FlowNode[] {
  return graph.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    data: n.data,
    width: n.width,
    height: n.height,
    ariaLabel: describeNode(n.data),
  }));
}

function toFlowEdges(graph: DiffGraph): Edge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    className: `cp-mapedge is-${e.status}`,
    data: { status: e.status },
    focusable: false,
  }));
}

function describeNode(data: DiffNodeData): string {
  const what =
    data.status === "add"
      ? "new table"
      : data.status === "rem"
        ? "dropped table"
        : data.status === "chg"
          ? "changed table"
          : "unchanged table";
  return `${data.label}, ${what}. Press Enter to show its card.`;
}

function lit(data: DiffNodeData, filter: DiffStatus | null): boolean {
  if (filter === null) return true;
  if (filter === "add") return data.hasAdd;
  if (filter === "chg") return data.hasChg;
  if (filter === "rem") return data.hasRem;
  return data.status === "same";
}

function FlowInner({ report, filter, onlyChanged, full, compact, onJump }: DiffFlowProps) {
  const [graph] = useState<DiffGraph>(() => buildDiffGraph(report, { onlyChanged }));
  const [nodes, , onNodesChange] = useNodesState<FlowNode>(toFlowNodes(graph));
  const [edges, , onEdgesChange] = useEdgesState<Edge>(toFlowEdges(graph));
  const { fitView } = useReactFlow();

  const dimmed = useMemo(() => {
    const out = new Set<string>();
    for (const n of nodes) if (!lit(n.data, filter)) out.add(n.id);
    return out;
  }, [nodes, filter]);

  const displayNodes = useMemo(
    () => nodes.map((n) => ({ ...n, className: dimmed.has(n.id) ? "viz-dim" : undefined })),
    [nodes, dimmed],
  );
  const displayEdges = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        className: `${e.className ?? ""}${dimmed.has(e.source) || dimmed.has(e.target) ? " viz-dim" : ""}`,
      })),
    [edges, dimmed],
  );

  const still = compact && !full;

  // Fit the tables to the box whenever its width changes: going full screen
  // and back, a window resize, the sidebar folding. A change of height alone
  // (the page growing below it) leaves the reader's view where it is.
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let frame = 0;
    let lastWidth = -1;
    const fit = () => {
      const width = Math.round(box.getBoundingClientRect().width);
      if (width === lastWidth || width === 0) return;
      lastWidth = width;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void fitView({ padding: 0.12, maxZoom: 1 }));
    };
    const watcher = new ResizeObserver(fit);
    watcher.observe(box);
    return () => {
      watcher.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [full, still, fitView]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const node = (event.target as HTMLElement).closest?.(".react-flow__node");
    const id = node?.getAttribute("data-id");
    if (id) {
      event.preventDefault();
      onJump(id);
    }
  }

  if (still) {
    // A phone screen is too narrow to fit every table at a size anyone can
    // read, so the map keeps a fixed size and the strip scrolls sideways. The
    // canvas itself does not move: a swipe is the browser's own scroll, up and
    // down the page or along the strip, and a tap jumps to the card.
    const size = extent(graph);
    const scale = Math.min(STRIP_SCALE, STRIP_MAX_HEIGHT / size.height);
    return (
      <div className="cp-map__stripwrap" onKeyDown={onKeyDown}>
        <div className="cp-map__strip">
          <div
            className="cp-map__stripcanvas"
            style={{ width: Math.ceil(size.width * scale), height: Math.ceil(size.height * scale) }}
          >
            <ReactFlow
              className="viz-canvas"
              nodes={displayNodes}
              edges={displayEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              defaultViewport={{ x: 0, y: 0, zoom: scale }}
              minZoom={0.05}
              maxZoom={2}
              nodesConnectable={false}
              nodesDraggable={false}
              elementsSelectable={false}
              deleteKeyCode={null}
              panOnDrag={false}
              panOnScroll={false}
              zoomOnScroll={false}
              zoomOnPinch={false}
              zoomOnDoubleClick={false}
              preventScrolling={false}
              onNodeClick={(_, node) => onJump(node.id)}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} />
            </ReactFlow>
          </div>
        </div>
        <p className="cp-map__striphint">
          Swipe the map sideways to see every table. Tap one to jump to its card, or open Full screen to zoom.
        </p>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="cp-map__flow" onKeyDown={onKeyDown}>
      <ReactFlow
        className="viz-canvas"
        nodes={displayNodes}
        edges={displayEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        minZoom={0.05}
        maxZoom={2}
        nodesConnectable={false}
        nodesDraggable
        elementsSelectable={false}
        deleteKeyCode={null}
        // Inline, the wheel scrolls the page, not the map: the map sits in the
        // middle of a long page and must not trap the reader's scrolling.
        zoomOnScroll={full}
        preventScrolling={full}
        panOnDrag
        zoomOnPinch
        zoomOnDoubleClick
        onlyRenderVisibleElements={nodes.length > 60}
        onNodeClick={(_, node) => onJump(node.id)}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} />
        <Controls showInteractive={false} position="bottom-left" />
        <Panel position="bottom-right" className="viz-panel viz-panel--hint cp-map__hint">
          {full
            ? "Press a table to jump to its card. Scroll to zoom, drag to move around."
            : "Press a table to jump to its card below. Drag to move around."}
        </Panel>
      </ReactFlow>
    </div>
  );
}

export default function DiffFlow(props: DiffFlowProps) {
  return (
    <ReactFlowProvider>
      <FlowInner {...props} />
    </ReactFlowProvider>
  );
}
