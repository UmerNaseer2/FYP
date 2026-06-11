// Pure graph-building for the Schema Visualizer: turn a SchemaSnapshot into
// positioned React Flow nodes + edges. No React, no fetch — unit-testable.
//
// Inspired by sqlhabit/sql_schema_visualizer (MIT), which hand-authors its
// tables/edges/positions as JSON config. We have live introspection
// (fetchSchemaSnapshot), so the same three artifacts are derived instead:
//   tables  -> one node per table (columns, PK/FK markers, accent color)
//   edges   -> one edge per FK column pair, wired column-to-column
//   layout  -> dagre auto-layout over the FK graph (replaces tablePositions.json)

import dagre from "@dagrejs/dagre";
import type { SchemaSnapshot, TableSnapshot } from "@/lib/postgres";

// ── Node data ────────────────────────────────────────────────────────────────

export type ColumnRow = {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  /** Column participates in an outgoing FK (links to another table). */
  isForeignKey: boolean;
  /** FK points at a table outside this schema/snapshot — drawn as a badge, no edge. */
  externalRef: string | null;
};

export type TableNodeData = {
  label: string;
  columns: ColumnRow[];
  /** Index into the accent palette — deterministic per table name. */
  accent: number;
  [key: string]: unknown; // satisfy React Flow's Record constraint
};

export type VizNode = {
  id: string;
  type: "table";
  position: { x: number; y: number };
  data: TableNodeData;
  width: number;
  height: number;
};

export type VizEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  /** FK constraint name — shown on hover/selection. */
  label?: string;
};

export type VizGraph = {
  nodes: VizNode[];
  edges: VizEdge[];
  stats: {
    tables: number;
    columns: number;
    foreignKeys: number;
    /** FKs that reference a table outside the snapshot (no edge drawn). */
    externalForeignKeys: number;
  };
};

// ── Geometry (must match the .viz-table CSS) ────────────────────────────────

export const NODE_HEADER_H = 42;
export const NODE_ROW_H = 25;
export const NODE_PAD_BOTTOM = 8;
const CHAR_W = 6.7; // ~13px mono/sans mix average
const NODE_MIN_W = 232;
const NODE_MAX_W = 384;

export function nodeWidth(table: TableSnapshot): number {
  let longest = table.name.length + 6; // header text + count badge
  for (const col of table.columns) {
    // name + gap + type + leading icon area
    longest = Math.max(longest, col.name.length + col.typeDisplay.length + 7);
  }
  return Math.round(Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, longest * CHAR_W + 46)));
}

export function nodeHeight(table: TableSnapshot): number {
  return NODE_HEADER_H + table.columns.length * NODE_ROW_H + NODE_PAD_BOTTOM;
}

// ── Accents (palette lives in CSS as --viz-accent-0..7) ─────────────────────

export const ACCENT_COUNT = 8;

/** Stable tiny hash so a table keeps its accent across reloads. */
export function accentFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % ACCENT_COUNT;
}

// ── Handles ──────────────────────────────────────────────────────────────────

export const srcHandle = (column: string) => `${column}.out`;
export const tgtHandle = (column: string) => `${column}.in`;

// ── Build ────────────────────────────────────────────────────────────────────

export function buildGraph(snapshot: SchemaSnapshot): VizGraph {
  const tables = snapshot.tables;
  const tableNames = new Set(tables.map((t) => t.name));

  let fkCount = 0;
  let externalCount = 0;

  // Which of each table's columns carry an FK, and where it points.
  const edges: VizEdge[] = [];
  const fkColumnInfo = new Map<string, Map<string, { external: string | null }>>();

  for (const table of tables) {
    const colInfo = new Map<string, { external: string | null }>();
    fkColumnInfo.set(table.name, colInfo);

    for (const fk of table.foreignKeys) {
      fkCount += 1;
      const refTable = fk.referencedTable;
      // "In this diagram" = same schema AND present in the snapshot. A null
      // referencedSchema is treated as local (older snapshots).
      const sameSchema = fk.referencedSchema === null || fk.referencedSchema === snapshot.schema;
      const internal = refTable !== null && sameSchema && tableNames.has(refTable);

      const externalLabel = internal
        ? null
        : `${fk.referencedSchema ? `${fk.referencedSchema}.` : ""}${refTable ?? "?"}`;
      if (!internal) externalCount += 1;

      fk.columns.forEach((column, i) => {
        const prior = colInfo.get(column);
        // External badge only if no internal FK already claims the column.
        if (!prior || (prior.external !== null && externalLabel === null)) {
          colInfo.set(column, { external: externalLabel });
        }

        if (internal && refTable) {
          const refColumn = fk.referencedColumns[i] ?? fk.referencedColumns[0];
          if (!refColumn) return;
          edges.push({
            id: `${table.name}:${fk.name}:${i}`,
            source: table.name,
            target: refTable,
            sourceHandle: srcHandle(column),
            targetHandle: tgtHandle(refColumn),
            label: fk.name,
          });
        }
      });
    }
  }

  // Nodes with measured sizes.
  const nodes: VizNode[] = tables.map((table) => {
    const colInfo = fkColumnInfo.get(table.name);
    return {
      id: table.name,
      type: "table" as const,
      position: { x: 0, y: 0 },
      width: nodeWidth(table),
      height: nodeHeight(table),
      data: {
        label: table.name,
        accent: accentFor(table.name),
        columns: table.columns.map((col) => {
          const info = colInfo?.get(col.name);
          return {
            name: col.name,
            type: col.typeDisplay,
            nullable: col.nullable,
            isPrimaryKey: col.isPrimaryKey,
            isForeignKey: info !== undefined,
            externalRef: info?.external ?? null,
          };
        }),
      },
    };
  });

  layoutWithDagre(nodes, edges);

  return {
    nodes,
    edges,
    stats: {
      tables: tables.length,
      columns: tables.reduce((sum, t) => sum + t.columns.length, 0),
      foreignKeys: fkCount,
      externalForeignKeys: externalCount,
    },
  };
}

/** Position nodes in-place via dagre (left→right rank flow, like an ER chart). */
function layoutWithDagre(nodes: VizNode[], edges: VizEdge[]): void {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 48, ranksep: 110, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    g.setNode(node.id, { width: node.width, height: node.height });
  }
  for (const edge of edges) {
    // Self-references don't constrain layout; skipping avoids degenerate ranks.
    if (edge.source !== edge.target) g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  for (const node of nodes) {
    const pos = g.node(node.id);
    if (!pos) continue; // defensive — every node was registered above
    // dagre positions are centers; React Flow wants top-left corners.
    node.position = {
      x: Math.round(pos.x - node.width / 2),
      y: Math.round(pos.y - node.height / 2),
    };
  }
}
