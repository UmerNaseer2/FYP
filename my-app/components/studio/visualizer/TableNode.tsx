"use client";

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { srcHandle, tgtHandle, type TableNodeData } from "./graph";

// One table card on the canvas: accent header strip, then one row per column
// with PK/FK markers, the type right-aligned, and an invisible pair of
// column-level handles so FK edges attach to the exact column they join on
// (the detail that makes sqlhabit's visualizer read so well).

type TableFlowNode = Node<TableNodeData, "table">;

function KeyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m11 12 9-9M16 5l3 3" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  );
}

export const TableNode = memo(function TableNode({ data, selected }: NodeProps<TableFlowNode>) {
  return (
    <div className={`viz-table viz-accent-${data.accent}${selected ? " is-selected" : ""}`}>
      <div className="viz-table__header">
        <span className="viz-table__name mono" title={data.label}>{data.label}</span>
        <span className="viz-table__count">{data.columns.length}</span>
      </div>

      <div className="viz-table__cols">
        {data.columns.map((col) => (
          <div key={col.name} className="viz-table__row">
            {/* Column-level edge anchors. Both sides always exist so an edge can
                land on any column; they're display-only (no manual connecting). */}
            <Handle
              type="target"
              position={Position.Left}
              id={tgtHandle(col.name)}
              isConnectable={false}
              className="viz-handle"
            />
            <span
              className={`viz-table__ico${col.isPrimaryKey ? " is-pk" : col.isForeignKey ? " is-fk" : ""}`}
              title={
                col.isPrimaryKey
                  ? "Primary key"
                  : col.externalRef
                    ? `References ${col.externalRef} (outside this schema)`
                    : col.isForeignKey
                      ? "Foreign key"
                      : undefined
              }
            >
              {col.isPrimaryKey ? <KeyIcon /> : col.isForeignKey ? <LinkIcon /> : null}
            </span>
            <span className={`viz-table__col mono${col.nullable ? "" : " is-required"}`} title={col.name}>
              {col.name}
              {col.externalRef ? <span className="viz-table__ext" aria-hidden="true">↗</span> : null}
            </span>
            <span className="viz-table__type mono" title={col.type}>{col.type}</span>
            <Handle
              type="source"
              position={Position.Right}
              id={srcHandle(col.name)}
              isConnectable={false}
              className="viz-handle"
            />
          </div>
        ))}
      </div>
    </div>
  );
});
