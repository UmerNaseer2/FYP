"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TargetPicker } from "@/components/studio/TargetPicker";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { AlertCircleIcon } from "@/components/ui/icons";
import { apiFetch } from "@/lib/ui/api-fetch";
import { useOrgHref } from "@/hooks/useOrg";

/**
 * "Which database, which schema": the two questions every Performance tab has
 * to ask before it can say anything at all.
 *
 * What is drawn is the shared TargetPicker, the same picker as on Compare and
 * Deploy. This file only does the loading around it: the saved PostgreSQL
 * connections, the schemas on the chosen one, and a sensible first choice.
 *
 * It owns the selection and reports it upward, because the two lists it
 * fetches are the only thing that knows which pairs are valid. It starts on
 * the first PostgreSQL connection and its `public` schema, so the page never
 * opens on an empty picker.
 */

export type PerfTarget = {
  /** Connection id as a string, because that is what the picker hands back. */
  connectionId: string;
  connectionName: string;
  schema: string;
};

type ConnectionRow = {
  id: number;
  name: string;
  database_name: string;
  type: string;
};

/** Where one of the two fetches has got to. */
type Phase = "loading" | "ready" | "error";

export function PerfTargetPicker({
  onChange,
  initialConnectionId,
  initialSchema,
}: {
  /**
   * Called with the chosen pair, and with null while there isn't a whole one.
   * Must be stable across renders (a plain `useState` setter, or wrapped in
   * `useCallback`) because it is what the report effect below watches.
   */
  onChange: (next: PerfTarget | null) => void;
  /**
   * A target carried in from another screen: a Suggestions finding, or the
   * analyser's link to one query's history. Without these a deep link lands on
   * the right tab looking at the wrong database, which is worse than landing
   * nowhere: the reader has no reason to doubt what they are shown.
   *
   * They are a starting point, not a lock. Both are only used while the
   * corresponding list is still empty, so choosing something else immediately
   * afterwards works normally and is not snapped back.
   */
  initialConnectionId?: string | null;
  initialSchema?: string | null;
}) {
  const orgPath = useOrgHref();
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [connPhase, setConnPhase] = useState<Phase>("loading");
  const [connectionId, setConnectionId] = useState(initialConnectionId ?? "");
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
        const res = await apiFetch("/api/connections", { cache: "no-store" });
        const data = res.ok ? await res.json() : null;
        if (cancelled) return;
        if (!Array.isArray(data)) {
          setConnections([]);
          setConnPhase("error");
          setSchemaPhase("ready");
          return;
        }
        // Only PostgreSQL: every rule in lib/performance/advice is a PostgreSQL rule,
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

  // Whenever the connection changes, the schema list has to be fetched again,
  // and the schema that was chosen on the old server means nothing on this one.
  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await apiFetch(
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
        // A schema carried in from another screen wins, but only if this server
        // really has it. A name from a link to a different database must not
        // be shown as selected when nothing here answers to it.
        // `public` otherwise, because it almost always is the one being asked
        // about.
        const wanted = initialSchema && list.includes(initialSchema) ? initialSchema : null;
        setSchema(wanted ?? (list.includes("public") ? "public" : (list[0] ?? "")));
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
    // initialSchema is deliberately not a dependency: it is a seed read once
    // per schema list, and listing it would re-run this fetch every time the
    // query string changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, schemasReload]);

  const picked = connections.find((c) => String(c.id) === connectionId);
  const connectionName = picked ? picked.name : "";

  // Tell the page what is selected, but only once both halves are real, so a
  // tab never fires a request at half a target while the lists are still moving.
  useEffect(() => {
    onChange(connectionId && schema ? { connectionId, connectionName, schema } : null);
  }, [connectionId, schema, connectionName, onChange]);

  if (connPhase === "error") {
    return (
      <div data-tour="performance-target">
        <ErrorNotice
          error="Could not load your saved connections."
          onRetry={() => {
            setConnPhase("loading");
            setConnectionsReload((n) => n + 1);
          }}
        />
      </div>
    );
  }

  if (connPhase === "ready" && connections.length === 0) {
    return (
      <div className="pf-note pf-note--warn" data-tour="performance-target">
        <AlertCircleIcon size={15} className="ico" />
        <div>
          <div className="title">No PostgreSQL connections saved</div>
          <div className="body">
            Performance reads a live PostgreSQL server, so there is nothing to
            read yet.{" "}
            <Link href={orgPath("/connections")} className="underline">
              Open Connections
            </Link>{" "}
            and add one. This page will find it.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pf-pick" data-tour="performance-target">
      {/* The shared picker draws the field, the list of schemas and its own
          notice when the schemas cannot be read. */}
      <TargetPicker
        label="Looking at"
        hint="read live from the server"
        connections={connections.map((c) => ({ id: c.id, name: c.name, detail: c.database_name }))}
        connectionId={connectionId}
        schema={schema}
        schemas={schemas}
        loading={connPhase === "loading" || (connectionId !== "" && schemaPhase === "loading")}
        error={schemaPhase === "error" ? schemaError : null}
        onRetry={() => {
          setSchemaPhase("loading");
          setSchemasReload((n) => n + 1);
        }}
        disabled={connPhase === "loading"}
        onChange={(next) => {
          if (next.connectionId !== connectionId) {
            // Another connection: its schemas load next, and the old schema
            // means nothing there.
            setSchema("");
            setSchemaError(null);
            setSchemaPhase("loading");
            setConnectionId(next.connectionId);
            return;
          }
          setSchema(next.schema);
        }}
      />
    </div>
  );
}
