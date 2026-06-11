"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
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

import type { SchemaSnapshot } from "@/lib/postgres";
import { SearchIcon } from "@/components/ui/icons";
import { buildGraph, type TableNodeData, type VizGraph } from "./graph";
import { TableNode } from "./TableNode";

// The ER canvas. Pure presentation: `snapshot` in, interactive diagram out.
// Remounted by the page (via key) whenever the connection/schema changes, so
// all internal state (positions, selection, search) resets cleanly per schema.

const nodeTypes = { table: TableNode };

type FlowNode = Node<TableNodeData>;

function toFlowNodes(graph: VizGraph): FlowNode[] {
  return graph.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    data: n.data,
    width: n.width,
    height: n.height,
  }));
}

function toFlowEdges(graph: VizGraph): Edge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    data: { fkName: e.label },
  }));
}

function FlowInner({ snapshot }: { snapshot: SchemaSnapshot }) {
  // Built exactly once per mount — the page remounts us per schema selection.
  const [graph] = useState<VizGraph>(() => buildGraph(snapshot));
  const [nodes, , onNodesChange] = useNodesState<FlowNode>(toFlowNodes(graph));
  const [edges, , onEdgesChange] = useEdgesState<Edge>(toFlowEdges(graph));

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const { fitView } = useReactFlow();

  // Tables connected to the selected one (plus itself) stay lit; rest dim.
  const related = useMemo(() => {
    if (!selectedId) return null;
    const keep = new Set<string>([selectedId]);
    for (const e of edges) {
      if (e.source === selectedId) keep.add(e.target);
      if (e.target === selectedId) keep.add(e.source);
    }
    return keep;
  }, [selectedId, edges]);

  const term = search.trim().toLowerCase();
  const matches = useMemo(
    () => (term ? nodes.filter((n) => n.id.toLowerCase().includes(term)).map((n) => n.id) : []),
    [term, nodes],
  );
  const matchSet = useMemo(() => new Set(matches), [matches]);

  // Derive display classes without touching the stateful arrays (drag-safe).
  const displayNodes = useMemo(
    () =>
      nodes.map((n) => {
        const dimSelect = related !== null && !related.has(n.id);
        const dimSearch = term.length > 0 && !matchSet.has(n.id);
        return { ...n, className: dimSelect || dimSearch ? "viz-dim" : undefined };
      }),
    [nodes, related, term, matchSet],
  );

  const displayEdges = useMemo(
    () =>
      edges.map((e) => {
        const hot = selectedId !== null && (e.source === selectedId || e.target === selectedId);
        const dim =
          (related !== null && !hot) ||
          (term.length > 0 && !matchSet.has(e.source) && !matchSet.has(e.target));
        return {
          ...e,
          animated: hot,
          className: hot ? "viz-hot" : dim ? "viz-dim" : undefined,
        };
      }),
    [edges, selectedId, related, term, matchSet],
  );

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && matches.length > 0) {
      void fitView({ nodes: [{ id: matches[0] }], duration: 500, maxZoom: 1.1 });
      setSelectedId(matches[0]);
    }
    if (event.key === "Escape") {
      setSearch("");
      setSelectedId(null);
      void fitView({ duration: 400, padding: 0.15 });
    }
  }

  return (
    <ReactFlow
      className="viz-canvas"
      nodes={displayNodes}
      edges={displayEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.05}
      maxZoom={2}
      nodesConnectable={false}
      deleteKeyCode={null}
      onlyRenderVisibleElements={nodes.length > 60}
      onNodeClick={(_, node) => setSelectedId((cur) => (cur === node.id ? null : node.id))}
      onPaneClick={() => setSelectedId(null)}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeClassName={(n) => `viz-mini-${(n.data as TableNodeData).accent}`} />

      <Panel position="top-left" className="viz-panel viz-panel--search">
        <SearchIcon size={13} className="viz-search-ico" />
        <input
          className="viz-search mono"
          placeholder="Find a table…  (Enter to zoom)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onSearchKeyDown}
          aria-label="Find a table"
        />
        {term && <span className="viz-search-count">{matches.length}</span>}
      </Panel>

      <Panel position="top-right" className="viz-panel viz-panel--stats">
        <span className="pill pill-neutral">{graph.stats.tables} tables</span>
        <span className="pill pill-neutral">{graph.stats.columns} columns</span>
        <span className="pill pill-neutral">{graph.stats.foreignKeys} FKs</span>
        {graph.stats.externalForeignKeys > 0 && (
          <span
            className="pill pill-drift"
            title="Foreign keys that reference tables outside this schema — marked ↗ on their columns, no edge drawn."
          >
            {graph.stats.externalForeignKeys} external ↗
          </span>
        )}
      </Panel>

      <Panel position="bottom-left" className="viz-panel viz-panel--hint">
        scroll to zoom · drag canvas to pan · drag tables to arrange · click a table to trace its relations
      </Panel>
    </ReactFlow>
  );
}

export default function SchemaFlow({ snapshot }: { snapshot: SchemaSnapshot }) {
  return (
    <ReactFlowProvider>
      <FlowInner snapshot={snapshot} />
    </ReactFlowProvider>
  );
}
