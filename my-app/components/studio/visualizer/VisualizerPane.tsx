"use client";

import { useEffect, useId, useState } from "react";
import dynamic from "next/dynamic";
import { Select } from "@/components/ui/Select";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui";
import { SchemaMapIcon, AlertTriangleIcon, RefreshIcon } from "@/components/ui/icons";
import type { SchemaSnapshot } from "@/lib/postgres";

// One self-contained visualizer pane: its own connection + schema pickers, its
// own on-demand introspection, and its own React Flow canvas. The page renders
// one of these (Single) or two side by side (Side-by-side), and each pane is
// fully independent — different databases, different schemas, even the same
// schema twice. The canvas is client-only, so it's code-split and SSR-skipped.

const SchemaFlow = dynamic(() => import("./SchemaFlow"), {
  ssr: false,
  loading: () => <CanvasLoading label="Preparing the canvas…" />,
});

export type VizConnection = {
  id: number;
  name: string;
  host: string;
  database_name: string;
};

function CanvasLoading({ label }: { label: string }) {
  return (
    <div className="viz-stage-fill grid place-items-center">
      <div className="text-center space-y-3" style={{ width: 320, maxWidth: "80%" }}>
        <Skeleton width="100%" height={10} radius={999} />
        <Skeleton width="72%" height={10} radius={999} className="mx-auto" />
        <p className="help" style={{ color: "var(--text-3)" }}>{label}</p>
      </div>
    </div>
  );
}

export function VisualizerPane({
  connections,
  connectionsLoaded,
}: {
  connections: VizConnection[];
  connectionsLoaded: boolean;
}) {
  // Unique ids so two panes' labels never collide (htmlFor / aria).
  const uid = useId();
  const connId = `${uid}-conn`;
  const schemaId = `${uid}-schema`;

  const [connectionId, setConnectionId] = useState("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [schemasError, setSchemasError] = useState("");
  const [schema, setSchema] = useState("");

  const [snapshot, setSnapshot] = useState<SchemaSnapshot | null>(null);
  const [snapPhase, setSnapPhase] = useState<"idle" | "loading" | "error" | "ready">("idle");
  const [snapError, setSnapError] = useState("");
  const [retry, setRetry] = useState(0);

  // ── Schemas for the chosen connection ──────────────────────────────────---
  useEffect(() => {
    setSchemas([]); // never leave the previous connection's list selectable
    if (!connectionId) return;
    let active = true;
    setSchemasLoading(true);
    setSchemasError("");
    (async () => {
      try {
        const res = await fetch(`/api/scripts/schemas?connectionId=${connectionId}`, { cache: "no-store" });
        const data = await res.json();
        if (!active) return;
        if (Array.isArray(data?.schemas)) setSchemas(data.schemas);
        else setSchemasError(data?.error ?? "Could not load schemas.");
      } catch {
        if (active) setSchemasError("Could not load schemas. Is the database reachable?");
      } finally {
        if (active) setSchemasLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [connectionId]);

  // ── Snapshot for the chosen schema ─────────────────────────────────────---
  useEffect(() => {
    setSnapshot(null);
    setSnapError("");
    if (!connectionId || !schema) {
      setSnapPhase("idle");
      return;
    }
    let active = true;
    setSnapPhase("loading");
    (async () => {
      try {
        const res = await fetch(
          `/api/schema/snapshot?connectionId=${encodeURIComponent(connectionId)}&schema=${encodeURIComponent(schema)}`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (!active) return;
        if (res.ok && data?.snapshot) {
          setSnapshot(data.snapshot as SchemaSnapshot);
          setSnapPhase("ready");
        } else {
          setSnapError(data?.error ?? "Could not read the schema.");
          setSnapPhase("error");
        }
      } catch {
        if (active) {
          setSnapError("Could not reach the server. Try again.");
          setSnapPhase("error");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [connectionId, schema, retry]);

  return (
    <div className="viz-pane">
      {/* Picker bar */}
      <div className="viz-pane__bar">
        <div className="viz-pane__field viz-pane__field--conn">
          <label className="label" htmlFor={connId}>Connection</label>
          {!connectionsLoaded ? (
            <Skeleton className="mt-1" width="100%" height={36} radius={8} />
          ) : (
            <Select
              variant="input"
              id={connId}
              className="mt-1"
              ariaLabel="Connection"
              value={connectionId}
              placeholder="Select a connection…"
              options={connections.map((c) => ({
                value: String(c.id),
                label: `${c.name} — ${c.host}/${c.database_name}`,
              }))}
              onChange={(value) => {
                setConnectionId(value);
                setSchema("");
              }}
            />
          )}
        </div>
        <div className="viz-pane__field viz-pane__field--schema">
          <label className="label" htmlFor={schemaId}>Schema</label>
          {!connectionsLoaded ? (
            <Skeleton className="mt-1" width="100%" height={36} radius={8} />
          ) : (
            <Select
              variant="input"
              id={schemaId}
              className="mt-1"
              mono
              ariaLabel="Schema"
              value={schema}
              disabled={schemasLoading || !connectionId}
              placeholder={
                !connectionId
                  ? "Pick a connection first"
                  : schemasLoading
                    ? "Loading schemas…"
                    : "Select a schema…"
              }
              options={schemas.map((s) => ({ value: s, label: s }))}
              onChange={(value) => setSchema(value)}
            />
          )}
          {schemasError && (
            <p className="help mt-1" style={{ color: "var(--break)" }}>{schemasError}</p>
          )}
        </div>
      </div>

      {/* Stage */}
      <div className="viz-pane__stage">
        {snapPhase === "idle" ? (
          <EmptyState
            icon={<SchemaMapIcon size={22} />}
            title="Pick a connection and a schema"
            description="Choose what to map above — the diagram is drawn live from the database, nothing is stored."
          />
        ) : snapPhase === "loading" ? (
          <CanvasLoading label={`Reading ${schema} and laying out the diagram…`} />
        ) : snapPhase === "error" ? (
          <EmptyState
            icon={<AlertTriangleIcon size={22} />}
            title="Couldn't read the schema"
            description={snapError}
            actions={
              <button className="btn btn-secondary btn-sm" onClick={() => setRetry((n) => n + 1)}>
                <RefreshIcon size={14} />
                Try again
              </button>
            }
          />
        ) : snapshot && snapshot.tables.length === 0 ? (
          <EmptyState
            icon={<SchemaMapIcon size={22} />}
            title="Nothing to draw"
            description={`Schema "${schema}" has no tables yet.`}
          />
        ) : snapshot ? (
          <SchemaFlow key={`${connectionId}:${schema}:${retry}`} snapshot={snapshot} />
        ) : null}
      </div>
    </div>
  );
}
