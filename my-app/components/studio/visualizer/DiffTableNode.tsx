"use client";

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { srcHandle, tgtHandle } from "./graph";
import type { DiffNodeData, DiffStatus } from "./diff-graph";

// One table on the Compare page's map of changes. The Visualizer's table card
// (TableNode) with a sign on every row: + for what the script adds, ~ for what
// it changes, − for what it drops, · for what it leaves alone. Colour is never
// the only signal: every row has its sign and, for screen readers, its word.

type DiffFlowNode = Node<DiffNodeData, "diffTable">;

const SIGN: Record<DiffStatus, string> = { add: "+", chg: "~", rem: "−", same: "·" };
const WORD: Record<DiffStatus, string> = { add: "added", chg: "changed", rem: "dropped", same: "" };

function headTag(data: DiffNodeData): string {
  if (data.status === "add") return "new table";
  if (data.status === "rem") return "dropped";
  if (data.wasName) return "renamed";
  if (data.status === "chg") return "changed";
  return "";
}

export const DiffTableNode = memo(function DiffTableNode({ data }: NodeProps<DiffFlowNode>) {
  const tag = headTag(data);
  return (
    <div className={`cp-mapnode is-${data.status}`}>
      <div className="cp-mapnode__head">
        <span className="cp-mapnode__sign" aria-hidden="true">
          {data.status === "same" ? "" : SIGN[data.status]}
        </span>
        <span className="cp-mapnode__name mono" title={data.wasName ? `${data.label}, was ${data.wasName}` : data.label}>
          {data.label}
        </span>
        {tag && <span className="cp-mapnode__tag">{tag}</span>}
      </div>
      <div className="cp-mapnode__rows">
        {data.rows.map((row) => (
          <div
            key={row.key}
            className={`cp-mapnode__row is-${row.status}${row.kind === "object" ? " is-object" : ""}`}
            title={row.title}
          >
            {row.kind === "column" && (
              <Handle
                type="target"
                position={Position.Left}
                id={tgtHandle(row.key)}
                isConnectable={false}
                className="viz-handle"
              />
            )}
            <span className="cp-mapnode__rowsign" aria-hidden="true">{SIGN[row.status]}</span>
            <span className="cp-mapnode__col mono">
              {row.name}
            </span>
            <span className="cp-mapnode__type mono">{row.type}</span>
            {row.status !== "same" && <span className="sr-only">, {WORD[row.status]}</span>}
            {row.kind === "column" && (
              <Handle
                type="source"
                position={Position.Right}
                id={srcHandle(row.key)}
                isConnectable={false}
                className="viz-handle"
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
});
