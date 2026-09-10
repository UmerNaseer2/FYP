"use client";

import { useEffect, useState } from "react";
import { Select } from "@/components/ui/Select";
import { EnvironmentPill } from "@/components/ui";
import { AlertCircleIcon } from "@/components/ui/icons";
import { toEnvironment } from "@/lib/environments";

/**
 * "Which database, which schema" — the two questions every Performance tab has
 * to ask before it can say anything at all.
 *
 * Kept out of the page because all of the performance work asks them: the
 * advice list reads one schema's structure, and the query analyser needs a
 * connection to send an EXPLAIN to. One component means the answer looks the
 * same on every tab and survives a switch between them.
 *
 * The picker owns the selection and reports it upward, rather than being driven
 * from above. That is deliberate: the two lists it fetches are the only thing
 * that knows which pairs are even valid, so letting it choose the first sensible
 * pair — the first PostgreSQL connection and its `public` schema — is what stops
 * the screen opening as two empty dropdowns and nothing else.
 */

export type PerfTarget = {
  /** Connection id as a string, because that is what a <Select> value is. */
  connectionId: string;
  connectionName: string;
  schema: string;
};

type ConnectionRow = {
  id: number;
  name: string;
  database_name: string;
  type: string;
  environment?: string | null;
};

/** Where one of the two fetches has got to. */
type Phase = "loading" | "ready" | "error";

export function PerfTargetPicker({
  onChange,
}: {
  /**
   * Called with the chosen pair, and with null while there isn't a whole one.
   * Must be stable across renders — a plain `useState` setter, or wrapped in
   * `useCallback` — because it is what the report effect below watches.
   */
  onChange: (next: PerfTarget | null) => void;
}) {
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [connPhase, setConnPhase] = useState<Phase>("loading");
  const [connectionId, setConnectionId] = useState("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schemaPhase, setSchemaPhase] = useState<Phase>("loading");
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schema, setSchema] = useState("");

  // A counter, not a callback: the fetch lives inside the effect (the same
  // shape the Drift screen uses) so that every setState in it happens after an
  // await. A setState that runs synchronously inside an effect is a cascading
  // render, and React's lint rightly refuses one. Retrying is therefore "ask
  // for another run", not "call the loader again".
  const [connectionsReload, setConnectionsReload] = useState(0);
  /** The same trick for the schema list, which fails on its own terms. */
  const [schemasReload, setSchemasReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/connections", { cache: "no-store" });
        const data = res.ok ? await res.json() : null;
        if (cancelled) return;
        if (!Array.isArray(data)) {
          setConnections([]);
          setConnPhase("error");
          setSchemaPhase("ready");
          return;
        }
        // Only PostgreSQL: every rule in lib/perf-advice is a PostgreSQL rule,
        // and pg_stat_user_tables is not a view any other engine has.
        const usable = data.filter((c: ConnectionRow) => c.type === "PostgreSQL");
        setConnections(usable);
        setConnPhase("ready");
        if (usable.length > 0) {
          setConnectionId((current) => current || String(usable[0].id));
        } else {
          // Nothing to load schemas for, so stop the schema row claiming to be
          // still fetching a list that will never arrive.
          setSchemaPhase("ready");
        }
      } catch {
        if (cancelled) return;
        setConnections([]);
        setConnPhase("error");
        setSchemaPhase("ready");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [connectionsReload]);

  // Whenever the connection changes, the schema list has to be fetched again —
  // and the schema that was chosen on the old server means nothing on this one.
  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/lineage/schemas?connectionId=${encodeURIComponent(connectionId)}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setSchemas([]);
          setSchema("");
          setSchemaError(data.error ?? "Could not list the schemas on this server.");
          setSchemaPhase("error");
          return;
        }
        const list: string[] = Array.isArray(data.schemas) ? data.schemas : [];
        setSchemas(list);
        // `public` first because it almost always is the one being asked about.
        setSchema(list.includes("public") ? "public" : (list[0] ?? ""));
        setSchemaPhase("ready");
      } catch {
        if (cancelled) return;
        setSchemas([]);
        setSchema("");
        setSchemaError("Network error while listing schemas.");
        setSchemaPhase("error");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [connectionId, schemasReload]);

  const picked = connections.find((c) => String(c.id) === connectionId);
  const connectionName = picked ? picked.name : "";

  // Tell the page what is selected — but only once both halves are real, so a
  // tab never fires a request at half a target while the lists are still moving.
  useEffect(() => {
    onChange(connectionId && schema ? { connectionId, connectionName, schema } : null);
  }, [connectionId, schema, connectionName, onChange]);

  if (connPhase === "error") {
    return (
      <div className="warn-inline">
        <AlertCircleIcon size={15} className="ico" />
        <div>
          <div className="title">Could not load your saved connections</div>
          <div className="body">
            The list could not be read just now.{" "}
            <button
              type="button"
              className="underline"
              onClick={() => {
                setConnPhase("loading");
                setConnectionsReload((n) => n + 1);
              }}
            >
              Try again
            </button>
            .
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="source-bar">
      <div className="source-bar__group">
        <span className="source-bar__label">Analyse</span>
        {/* One picker, not the Compare screen's grid of them — so the
            connection name gets the width it needs instead of being truncated
            into a 300px track with nothing beside it. */}
        <div className="picker" style={{ maxWidth: 560 }}>
          {/* The pill is two letters of jargon, so the name goes on the
              element itself and not only in a title a touch device
              never shows. */}
          <span
            className="kind live"
            title="Read live from the server, not from a saved snapshot"
            aria-label="Read live from the server, not from a saved snapshot"
          >
            live
          </span>
          <div className="body">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px]" style={{ color: "var(--text-3)" }}>
                Connection
              </span>
              <EnvironmentPill environment={toEnvironment(picked?.environment)} />
            </div>
            <Select
              value={connectionId}
              ariaLabel="Connection to analyse"
              placeholder={
                connPhase === "loading" ? "Loading connections…" : "Select a connection"
              }
              disabled={connPhase === "loading" || connections.length === 0}
              options={connections.map((c) => ({
                value: String(c.id),
                label: `${c.name} (${c.database_name})`,
              }))}
              onChange={(next) => {
                setSchema("");
                setSchemaError(null);
                setSchemaPhase("loading");
                setConnectionId(next);
              }}
            />
            <Select
              value={schema}
              ariaLabel="Schema to analyse"
              variant="sub"
              mono
              placeholder={schemaPhase === "loading" ? "Loading schemas…" : "Select a schema"}
              disabled={schemaPhase !== "ready" || schemas.length === 0}
              options={schemas.map((s) => ({ value: s, label: s }))}
              onChange={setSchema}
            />
          </div>
        </div>
      </div>

      {connPhase === "ready" && connections.length === 0 && (
        <div className="warn-inline">
          <AlertCircleIcon size={15} className="ico" />
          <div>
            <div className="title">No PostgreSQL connections saved</div>
            <div className="body">
              Performance advice is read from a live server. Save a PostgreSQL
              connection first, then come back.
            </div>
          </div>
        </div>
      )}

      {schemaPhase === "error" && (
        <div className="warn-inline">
          <AlertCircleIcon size={15} className="ico" />
          <div>
            <div className="title">Could not list schemas</div>
            <div className="body">
              {schemaError}{" "}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setSchemaPhase("loading");
                  setSchemasReload((n) => n + 1);
                }}
              >
                Try again
              </button>
              .
            </div>
          </div>
        </div>
      )}

      {schemaPhase === "ready" && connectionId !== "" && schemas.length === 0 && (
        <div className="warn-inline">
          <AlertCircleIcon size={15} className="ico" />
          <div>
            <div className="title">This server has no readable schemas</div>
            <div className="body">
              The connection worked, but this user cannot see any schema on it.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
