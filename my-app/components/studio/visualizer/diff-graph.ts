// Pure graph-building for the Compare page's map of changes: turn a
// CompareReport into positioned React Flow nodes and edges. No React, no fetch,
// unit-testable, like graph.ts next to it, whose sizes and layout it shares so
// the map and the Visualizer look like one tool.
//
// Direction: /compare's left is the source (the schema you want) and its right
// is the target (the schema the script rewrites). So a table only on the left
// is one the script adds, one only on the right is one it drops, and a change
// reads right → left: the value now, then the value after the script.
//
// The statuses here follow the report's own tally (DiffReport's matchTally):
// a row is "add", "chg" or "rem" exactly when the card below lists it under
// that sign, so pressing a tile dims the same tables on the map that it hides
// in the list.

import type {
  ColumnMatch,
  CompareReport,
  ConstraintDiff,
  ObjectDiff,
  TableMatch,
} from "@/lib/compare/diff";
import type { TableSnapshot } from "@/lib/postgres";
import {
  NODE_HEADER_H,
  NODE_PAD_BOTTOM,
  NODE_ROW_H,
  layoutWithDagre,
  srcHandle,
  tgtHandle,
  widthFor,
} from "./graph";

export type DiffStatus = "add" | "chg" | "rem" | "same";

export type DiffRow = {
  /** Unique within its table. Also the handle id for column rows. */
  key: string;
  name: string;
  type: string;
  status: DiffStatus;
  /** Columns carry FK handles; constraints, indexes and the like do not. */
  kind: "column" | "object";
  isPrimaryKey: boolean;
  /** What changed, in words, for a hover and for screen readers. */
  title?: string;
};

export type DiffNodeData = {
  label: string;
  status: DiffStatus;
  /** The table's name in the target when the source renamed it. */
  wasName: string | null;
  rows: DiffRow[];
  hasAdd: boolean;
  hasChg: boolean;
  hasRem: boolean;
  [key: string]: unknown; // satisfy React Flow's Record constraint
};

export type DiffNode = {
  id: string;
  type: "diffTable";
  position: { x: number; y: number };
  width: number;
  height: number;
  data: DiffNodeData;
};

export type DiffEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  /** add: only the source has this link, rem: only the target has it. */
  status: "add" | "rem" | "same";
  label: string;
};

export type DiffGraph = {
  nodes: DiffNode[];
  edges: DiffEdge[];
  /** Tables by status, before onlyChanged takes the unchanged ones out. */
  counts: Record<DiffStatus, number>;
};

/** The id a table's card carries on the page, and its node's id here. */
export function diffNodeId(status: DiffStatus, name: string): string {
  return `${status}:${name}`;
}

export function matchNodeId(match: TableMatch): string {
  return diffNodeId(match.hasChanges ? "chg" : "same", match.left.name);
}

const CONSTRAINT_LABEL: Record<ConstraintDiff["kind"], string> = {
  "PRIMARY KEY": "primary key",
  UNIQUE: "unique",
  "FOREIGN KEY": "foreign key",
  CHECK: "check",
  EXCLUDE: "exclude",
};

function objectLabel(kind: ObjectDiff["kind"]): string {
  return kind === "PRIVILEGES" ? "grants" : kind.toLowerCase();
}

function statusOf(status: "onlyA" | "onlyB" | "changedDefinition"): DiffStatus {
  return status === "onlyA" ? "add" : status === "onlyB" ? "rem" : "chg";
}

/** A key no other row of the table has yet. */
function freshKey(taken: Set<string>, wanted: string): string {
  let key = wanted;
  for (let n = 2; taken.has(key); n += 1) key = `${wanted}~${n}`;
  taken.add(key);
  return key;
}

function columnRows(table: TableSnapshot, status: DiffStatus, taken: Set<string>): DiffRow[] {
  return table.columns.map((col) => ({
    key: freshKey(taken, col.name),
    name: col.name,
    type: col.typeDisplay,
    status,
    kind: "column",
    isPrimaryKey: col.isPrimaryKey,
  }));
}

function constraintRow(diff: ConstraintDiff, taken: Set<string>): DiffRow {
  const name = diff.leftName ?? diff.rightName ?? CONSTRAINT_LABEL[diff.kind];
  return {
    key: freshKey(taken, `constraint:${diff.kind}:${name}`),
    name,
    type: CONSTRAINT_LABEL[diff.kind],
    status: statusOf(diff.status),
    kind: "object",
    isPrimaryKey: false,
    title: diff.summary,
  };
}

function objectRow(diff: ObjectDiff, tableName: string, taken: Set<string>): DiffRow {
  const label = objectLabel(diff.kind);
  // Row security and partitioning are named after their table; the row says
  // what it is instead of repeating the header.
  const ownName = diff.name !== tableName && diff.name !== "";
  return {
    key: freshKey(taken, `object:${diff.kind}:${diff.name}`),
    name: ownName ? diff.name : label,
    type: ownName ? label : "",
    status: statusOf(diff.status),
    kind: "object",
    isPrimaryKey: false,
    title: diff.summary,
  };
}

function changedColumnTitle(match: ColumnMatch): string {
  const lines = match.changes.map((change) =>
    change.label && change.leftValue !== undefined && change.rightValue !== undefined
      ? `${change.label}: ${change.rightValue} → ${change.leftValue}`
      : change.message,
  );
  if (match.left.name !== match.right.name) lines.unshift(`renamed from ${match.right.name}`);
  return lines.join("\n");
}

function matchRows(match: TableMatch): DiffRow[] {
  const taken = new Set<string>();
  const byLeft = new Map(match.columnMatches.map((cm) => [cm.left.name, cm]));
  const added = new Set(match.columnsOnlyInA.map((col) => col.name));
  const rows: DiffRow[] = [];

  // Source order first: it is the order the table has after the script runs.
  for (const col of match.left.columns) {
    const cm = byLeft.get(col.name);
    const changed = cm !== undefined && (cm.changes.length > 0 || !cm.exact);
    const status: DiffStatus = added.has(col.name) ? "add" : changed ? "chg" : "same";
    const typeMoved = cm !== undefined && cm.right.typeDisplay !== col.typeDisplay;
    rows.push({
      key: freshKey(taken, col.name),
      name: col.name,
      type: status === "chg" && typeMoved ? `${cm.right.typeDisplay} → ${col.typeDisplay}` : col.typeDisplay,
      status,
      kind: "column",
      isPrimaryKey: col.isPrimaryKey,
      title: status === "chg" && cm ? changedColumnTitle(cm) : undefined,
    });
  }
  // Then what the script takes away, which the source no longer has.
  for (const col of match.columnsOnlyInB) {
    rows.push({
      key: freshKey(taken, col.name),
      name: col.name,
      type: col.typeDisplay,
      status: "rem",
      kind: "column",
      isPrimaryKey: col.isPrimaryKey,
    });
  }
  for (const diff of match.constraintDiffs) rows.push(constraintRow(diff, taken));
  for (const diff of match.objectDiffs) rows.push(objectRow(diff, match.left.name, taken));
  return rows;
}

function makeNode(
  id: string,
  status: DiffStatus,
  label: string,
  wasName: string | null,
  rows: DiffRow[],
  renamed: boolean,
): DiffNode {
  const tag = status === "add" ? "new table" : status === "rem" ? "dropped" : status === "chg" ? "changed" : "";
  const headerChars = label.length + tag.length + 6;
  return {
    id,
    type: "diffTable",
    position: { x: 0, y: 0 },
    width: widthFor(headerChars, rows),
    height: NODE_HEADER_H + rows.length * NODE_ROW_H + NODE_PAD_BOTTOM,
    data: {
      label,
      status,
      wasName,
      rows,
      hasAdd: rows.some((row) => row.status === "add"),
      hasChg: renamed || rows.some((row) => row.status === "chg"),
      hasRem: rows.some((row) => row.status === "rem"),
    },
  };
}

type Link = { source: string; sourceKey: string; target: string; targetKey: string; label: string };

/**
 * The FK links of one side, in node ids and row keys, so the two sides can be
 * set against each other. A link to a table outside the schema has no node to
 * land on and is left out, as the Visualizer leaves it out.
 */
function sideLinks(
  tables: TableSnapshot[],
  schema: string,
  nodeOf: (table: string) => string | undefined,
  keyOf: (table: string, column: string) => string | undefined,
): Link[] {
  const links: Link[] = [];
  for (const table of tables) {
    const source = nodeOf(table.name);
    if (!source) continue;
    for (const fk of table.foreignKeys) {
      const sameSchema = fk.referencedSchema === null || fk.referencedSchema === schema;
      const target = fk.referencedTable && sameSchema ? nodeOf(fk.referencedTable) : undefined;
      if (!target || !fk.referencedTable) continue;
      fk.columns.forEach((column, i) => {
        const refColumn = fk.referencedColumns[i] ?? fk.referencedColumns[0];
        const sourceKey = keyOf(table.name, column);
        const targetKey = refColumn ? keyOf(fk.referencedTable!, refColumn) : undefined;
        if (sourceKey && targetKey) links.push({ source, sourceKey, target, targetKey, label: fk.name });
      });
    }
  }
  return links;
}

export function buildDiffGraph(
  report: CompareReport,
  options: { onlyChanged?: boolean } = {},
): DiffGraph {
  const nodes: DiffNode[] = [];
  const leftNode = new Map<string, string>();
  const rightNode = new Map<string, string>();
  // Row key of each column, per side, for wiring the links to the right rows.
  const leftKey = new Map<string, Map<string, string>>();
  const rightKey = new Map<string, Map<string, string>>();

  // Indexes, triggers and the like on a table only one side has. The engine
  // reports them at schema level (there is no match to hang them on). The
  // owner and grants of a new table are left out: the tiles do not count them
  // either, they come with the table.
  const scopedTo = (name: string, status: ObjectDiff["status"]) =>
    report.objectDiffs.filter(
      (diff) => diff.table === name && diff.status === status && diff.kind !== "PRIVILEGES",
    );

  for (const table of report.tablesOnlyInA) {
    const taken = new Set<string>();
    const rows = columnRows(table, "add", taken);
    for (const diff of scopedTo(table.name, "onlyA")) rows.push(objectRow(diff, table.name, taken));
    const id = diffNodeId("add", table.name);
    nodes.push(makeNode(id, "add", table.name, null, rows, false));
    leftNode.set(table.name, id);
    leftKey.set(table.name, new Map(rows.filter((r) => r.kind === "column").map((r) => [r.name, r.key])));
  }

  for (const match of report.matchedTables) {
    const rows = matchRows(match);
    const id = matchNodeId(match);
    const renamed = !match.exact && match.left.name !== match.right.name;
    nodes.push(
      makeNode(id, match.hasChanges ? "chg" : "same", match.left.name, renamed ? match.right.name : null, rows, !match.exact),
    );
    leftNode.set(match.left.name, id);
    rightNode.set(match.right.name, id);

    const columnKeys = rows.filter((r) => r.kind === "column");
    const leftNames = new Set(match.left.columns.map((col) => col.name));
    // Source columns took their keys first, in source order, so the first
    // len(source columns) column rows are theirs and the rest are the drops.
    const forLeft = new Map<string, string>();
    const forRight = new Map<string, string>();
    columnKeys.forEach((row, i) => {
      if (i < match.left.columns.length && leftNames.has(row.name)) forLeft.set(row.name, row.key);
      else forRight.set(row.name, row.key);
    });
    for (const cm of match.columnMatches) {
      const key = forLeft.get(cm.left.name);
      if (key) forRight.set(cm.right.name, key);
    }
    leftKey.set(match.left.name, forLeft);
    rightKey.set(match.right.name, forRight);
  }

  for (const table of report.tablesOnlyInB) {
    const taken = new Set<string>();
    const rows = columnRows(table, "rem", taken);
    for (const diff of scopedTo(table.name, "onlyB")) rows.push(objectRow(diff, table.name, taken));
    const id = diffNodeId("rem", table.name);
    nodes.push(makeNode(id, "rem", table.name, null, rows, false));
    rightNode.set(table.name, id);
    rightKey.set(table.name, new Map(rows.filter((r) => r.kind === "column").map((r) => [r.name, r.key])));
  }

  const left = sideLinks(
    report.left.tables,
    report.left.schema,
    (name) => leftNode.get(name),
    (table, column) => leftKey.get(table)?.get(column),
  );
  const right = sideLinks(
    report.right.tables,
    report.right.schema,
    (name) => rightNode.get(name),
    (table, column) => rightKey.get(table)?.get(column),
  );

  const linkId = (link: Link) => `${link.source}.${link.sourceKey}>${link.target}.${link.targetKey}`;
  const rightIds = new Set(right.map(linkId));
  const leftIds = new Set(left.map(linkId));
  const edges: DiffEdge[] = [];
  const seen = new Set<string>();
  const push = (link: Link, status: DiffEdge["status"]) => {
    const id = linkId(link);
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({
      id: `${status}|${id}`,
      source: link.source,
      target: link.target,
      sourceHandle: srcHandle(link.sourceKey),
      targetHandle: tgtHandle(link.targetKey),
      status,
      label: link.label,
    });
  };
  for (const link of left) push(link, rightIds.has(linkId(link)) ? "same" : "add");
  for (const link of right) if (!leftIds.has(linkId(link))) push(link, "rem");

  const counts: Record<DiffStatus, number> = { add: 0, chg: 0, rem: 0, same: 0 };
  for (const node of nodes) counts[node.data.status] += 1;

  const keptNodes = options.onlyChanged ? nodes.filter((node) => node.data.status !== "same") : nodes;
  const kept = new Set(keptNodes.map((node) => node.id));
  const keptEdges = edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target));

  layoutWithDagre(keptNodes, keptEdges);
  return { nodes: keptNodes, edges: keptEdges, counts };
}
