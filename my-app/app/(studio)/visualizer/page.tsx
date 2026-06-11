"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Select } from "@/components/ui/Select";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui";
import {
  SchemaMapIcon,
  ConnectionsIcon,
  AlertTriangleIcon,
  RefreshIcon,
} from "@/components/ui/icons";
import type { SchemaSnapshot } from "@/lib/postgres";

// The Schema Visualizer: pick a connection + schema, get a live ER diagram of
// it (tables, columns, keys, FK edges). Introspection happens on demand via
// GET /api/schema/snapshot; the canvas itself is client-only (React Flow), so
// it's code-split and skipped during prerender.

const SchemaFlow = dynamic(() => import("@/components/studio/visualizer/SchemaFlow"), {
  ssr: false,
  loading: () => <CanvasLoading label="Preparing the canvas…" />,
});

type Connection = {
  id: number;
  name: string;
  host: string;
  database_name: string;
};

function CanvasLoading({ label }: { label: string }) {
  return (
    <div className="viz-stage-fill grid place-items-center">
      <div className="text-center space-y-3" style={{ width: 320 }}>
        <Skeleton width="100%" height={10} radius={999} />
        <Skeleton width="72%" height={10} radius={999} className="mx-auto" />
        <p className="help" style={{ color: "var(--text-3)" }}>{label}</p>
      </div>
    </div>
  );
}

export default function VisualizerPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [connectionId, setConnectionId] = useState("");

  const [schemas, setSchemas] = useState<string[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [schemasError, setSchemasError] = useState("");
  const [schema, setSchema] = useState("");

  const [snapshot, setSnapshot] = useState<SchemaSnapshot | null>(null);
  const [snapPhase, setSnapPhase] = useState<"idle" | "loading" | "error" | "ready">("idle");
  const [snapError, setSnapError] = useState("");
  const [retry, setRetry] = useState(0);

  // ── Load connections once ──────────────────────────────────────────────--
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/connections", { cache: "no-store" });
        const data = await res.json();
        if (active && Array.isArray(data)) setConnections(data);
      } catch {
        /* empty state below guides the user */
      } finally {
        if (active) setConnectionsLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // ── Schemas for the chosen connection ──────────────────────────────────--
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

  // ── Snapshot for the chosen schema ─────────────────────────────────────--
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
    <div className="viz-page">
      <div className="px-8 pt-8 pb-4">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="section-title mb-2">Visualizer</div>
            <h1 className="text-[28px] font-semibold tracking-[-0.018em]">See the schema.</h1>
            <p className="text-[13.5px] mt-1.5 max-w-[64ch]" style={{ color: "var(--text-2)" }}>
              A live entity-relationship map of any schema — tables, columns, keys, and the
              foreign-key paths between them, laid out automatically.
            </p>
          </div>

          {!connectionsLoaded ? (
            <div className="flex items-end gap-3 flex-wrap">
              <div>
                <label className="label">Connection</label>
                <Skeleton className="mt-1" width={260} height={38} radius={8} />
              </div>
              <div>
                <label className="label">Schema</label>
                <Skeleton className="mt-1" width={180} height={38} radius={8} />
              </div>
            </div>
          ) : connections.length > 0 ? (
            <div className="flex items-end gap-3 flex-wrap">
              <div>
                <label className="label" htmlFor="viz-conn">Connection</label>
                <Select
                  variant="input"
                  id="viz-conn"
                  className="mt-1"
                  ariaLabel="Connection"
                  style={{ minWidth: 260 }}
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
              </div>
              <div>
                <label className="label" htmlFor="viz-schema">Schema</label>
                <Select
                  variant="input"
                  id="viz-schema"
                  className="mt-1"
                  mono
                  ariaLabel="Schema"
                  style={{ minWidth: 180 }}
                  value={schema}
                  disabled={schemasLoading || !connectionId}
                  placeholder={
                    !connectionId
                      ? "Select a connection first"
                      : schemasLoading
                        ? "Loading schemas…"
                        : "Select a schema…"
                  }
                  options={schemas.map((s) => ({ value: s, label: s }))}
                  onChange={(value) => setSchema(value)}
                />
                {schemasError && (
                  <p className="help mt-1" style={{ color: "var(--break)" }}>{schemasError}</p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Stage ─────────────────────────────────────────────────────────── */}
      <div className="viz-stage">
        {connectionsLoaded && connections.length === 0 ? (
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
        ) : snapPhase === "idle" ? (
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
