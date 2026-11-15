"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { TargetPicker } from "@/components/studio/TargetPicker";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { Skeleton } from "@/components/ui";
import { SchemaMapIcon } from "@/components/ui/icons";
import type { SchemaSnapshot } from "@/lib/postgres";
import { apiFetch } from "@/lib/api-fetch";

// One self-contained visualizer pane: its own connection and schema picker, its
// own on-demand introspection, and its own React Flow canvas. The page renders
// one of these (Single) or two side by side (Side by side), and each pane is
// fully independent: different databases, different schemas, even the same
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

/** What a pane draws: a connection id and a schema, each empty until picked. */
export type VizPick = { connectionId: string; schema: string };

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
  label = "Connection and schema",
  onPick,
}: {
  connections: VizConnection[];
  connectionsLoaded: boolean;
  /** The words above the picker. Side by side names its two panes. */
  label?: string;
  /** Told what the pane draws, each time the pick changes. */
  onPick?: (pick: VizPick) => void;
}) {
  const [connectionId, setConnectionId] = useState("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [schemasError, setSchemasError] = useState("");
  // Counts presses of Try again on the schema list, so the list loads again.
  const [schemasRetry, setSchemasRetry] = useState(0);
  const [schema, setSchema] = useState("");

  const [snapshot, setSnapshot] = useState<SchemaSnapshot | null>(null);
  const [snapPhase, setSnapPhase] = useState<"idle" | "loading" | "error" | "ready">("idle");
  const [snapError, setSnapError] = useState("");
  const [retry, setRetry] = useState(0);

  // ---- Schemas for the chosen connection ----
  useEffect(() => {
    setSchemas([]); // never leave the previous connection's list selectable
    if (!connectionId) return;
    let active = true;
    setSchemasLoading(true);
    setSchemasError("");
    (async () => {
      try {
        const res = await apiFetch(`/api/scripts/schemas?connectionId=${connectionId}`, { cache: "no-store" });
        const data = await res.json();
        if (!active) return;
        if (Array.isArray(data?.schemas)) {
          const list: string[] = data.schemas;
          setSchemas(list);
          // One schema leaves nothing to choose, so it is drawn straight away.
          if (list.length === 1) setSchema((current) => (current === "" ? list[0] : current));
        } else {
          setSchemasError(data?.error ?? "Could not load schemas.");
        }
      } catch {
        if (active) setSchemasError("Could not load schemas. Is the database reachable?");
      } finally {
        if (active) setSchemasLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [connectionId, schemasRetry]);

  // The page builds its "Open in Compare" link from what each pane draws, so
  // the schemas somebody was looking at arrive in Compare already picked
  // instead of on whatever Compare would default to.
  useEffect(() => {
    onPick?.({ connectionId, schema });
  }, [connectionId, schema, onPick]);

  // ---- Snapshot for the chosen schema ----
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
        const res = await apiFetch(
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

  const picked = connections.find((c) => String(c.id) === connectionId);

  return (
    <div className="viz-pane">
      {/* Picker bar: the same picker as on Compare and Deploy. */}
      <div className="viz-pane__bar" data-tour="visualizer-target">
        {!connectionsLoaded ? (
          <Skeleton width="100%" height={56} radius={12} />
        ) : (
          <TargetPicker
            className="viz-pane__picker"
            label={label}
            connections={connections.map((c) => ({ id: c.id, name: c.name, detail: c.database_name }))}
            connectionId={connectionId}
            schema={schema}
            schemas={schemas}
            loading={schemasLoading}
            error={schemasError || null}
            onRetry={() => setSchemasRetry((n) => n + 1)}
            onChange={(next) => {
              setConnectionId(next.connectionId);
              setSchema(next.schema);
            }}
          />
        )}
      </div>

      {/* Stage */}
      <div className="viz-pane__stage">
        {snapPhase === "idle" ? (
          <EmptyState
            icon={<SchemaMapIcon size={22} />}
            title="Pick a connection and a schema"
            description="Choose what to map above. The diagram is drawn live from the database and nothing is stored."
          />
        ) : snapPhase === "loading" ? (
          <CanvasLoading label={`Reading ${schema} and laying out the diagram…`} />
        ) : snapPhase === "error" ? (
          // ErrorNotice says what to press: enter the password again, or try again.
          <div className="viz-pane__error">
            <ErrorNotice
              error={snapError}
              connectionName={picked?.name}
              connectionId={connectionId}
              onRetry={() => setRetry((n) => n + 1)}
            />
          </div>
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
