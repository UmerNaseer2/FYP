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

  // dagre puts every table of one rank at the same centre x. Kept for the wrap below.
  const rankX = new Map<string, number>();

  for (const node of nodes) {
    const pos = g.node(node.id);
    if (!pos) continue; // defensive — every node was registered above
    rankX.set(node.id, pos.x);
    // dagre positions are centers; React Flow wants top-left corners.
    node.position = {
      x: Math.round(pos.x - node.width / 2),
      y: Math.round(pos.y - node.height / 2),
    };
  }

  wrapBigLayout(nodes, rankX);
}

// A picture bigger than this cannot be read once Fit View has shrunk it to the
// screen, so it is reflowed. Smaller pictures stay exactly as dagre drew them.
const READABLE_W = 3600;
const READABLE_H = 2400;
/** Width divided by height of the block a big picture is reflowed into. */
const SCREEN_SHAPE = 1.6;
const COLUMN_GAP = 110; // same as dagre's ranksep
const ROW_GAP = 48; // same as dagre's nodesep
const BAND_GAP = 140; // between one row of columns and the next

/** One column of tables, top to bottom. */
type LayoutColumn = { nodes: VizNode[]; width: number; height: number };

function makeColumn(nodes: VizNode[]): LayoutColumn {
  const width = Math.max(...nodes.map((n) => n.width));
  const height = nodes.reduce((sum, n) => sum + n.height, 0) + ROW_GAP * (nodes.length - 1);
  return { nodes, width, height };
}

/**
 * Reflow a layout that is far too wide or far too tall.
 *
 * dagre gives every rank of the foreign key graph its own column and never
 * wraps. A chain of 60 tables came out as one line about 20,000 px wide, and
 * 60 tables that point at one table (or have no foreign keys at all) as one
 * column about 13,000 px tall. Here the columns are kept in dagre's order, a
 * column that is too tall is cut into several, and the columns are then laid
 * out like words on a page: left to right, starting a new band underneath when
 * a band is full. A line between tables in different bands is longer, but the
 * table names can be read.
 */
function wrapBigLayout(nodes: VizNode[], rankX: Map<string, number>): void {
  if (nodes.length === 0) return;

  const left = Math.min(...nodes.map((n) => n.position.x));
  const top = Math.min(...nodes.map((n) => n.position.y));
  const right = Math.max(...nodes.map((n) => n.position.x + n.width));
  const bottom = Math.max(...nodes.map((n) => n.position.y + n.height));
  if (right - left <= READABLE_W && bottom - top <= READABLE_H) return;

  // 1. dagre's columns, left to right, each one top to bottom.
  const byRank = new Map<number, VizNode[]>();
  for (const node of nodes) {
    const x = rankX.get(node.id) ?? node.position.x;
    byRank.set(x, [...(byRank.get(x) ?? []), node]);
  }
  const ranks = [...byRank.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, rankNodes]) => rankNodes.sort((a, b) => a.position.y - b.position.y));

  // 2. Cut a column that is too tall into several columns side by side.
  const area = nodes.reduce((sum, n) => sum + (n.width + COLUMN_GAP) * (n.height + ROW_GAP), 0);
  const columnLimit = Math.max(READABLE_H, Math.sqrt(area / SCREEN_SHAPE));
  const columns: LayoutColumn[] = [];
  for (const rankNodes of ranks) {
    let current: VizNode[] = [];
    let height = 0;
    for (const node of rankNodes) {
      if (current.length > 0 && height + node.height > columnLimit) {
        columns.push(makeColumn(current));
        current = [];
        height = 0;
      }
      current.push(node);
      height += node.height + ROW_GAP;
    }
    columns.push(makeColumn(current));
  }

  // 3. How many bands give a block close to the shape of a screen.
  const totalWidth = columns.reduce((sum, c) => sum + c.width + COLUMN_GAP, 0);
  const tallest = Math.max(...columns.map((c) => c.height));
  const bands = Math.max(1, Math.round(Math.sqrt(totalWidth / (SCREEN_SHAPE * (tallest + BAND_GAP)))));
  const bandWidth = totalWidth / bands;

  // 4. Place the columns, starting a new band when the next one does not fit.
  let x = 0;
  let bandTop = 0;
  let bandHeight = 0;
  for (const column of columns) {
    if (x > 0 && x + column.width > bandWidth) {
      x = 0;
      bandTop += bandHeight + BAND_GAP;
      bandHeight = 0;
    }
    let y = bandTop;
    for (const node of column.nodes) {
      // Each table is centred on its column, as dagre does.
      node.position = { x: Math.round(x + (column.width - node.width) / 2), y: Math.round(y) };
      y += node.height + ROW_GAP;
    }
    x += column.width + COLUMN_GAP;
    bandHeight = Math.max(bandHeight, column.height);
  }
}
