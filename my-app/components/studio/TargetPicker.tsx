"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { StatusChip } from "@/components/ui/StatusChip";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "@/components/ui/icons";
import { apiFetch } from "@/lib/api-fetch";
import "@/app/styles/atelier-picker.css";

// ---------------------------------------------------------------------------
// TargetPicker: choose a connection, then a schema. One picker for every page
// that asks "which schema?" (Compare, Deploy, Visualizer, Version Sync,
// Performance).
//
// It is controlled and knows nothing about where the data comes from. The page
// keeps the choice and hands the picker everything it draws:
//
//   label         "Source", "Target". Shown above the field and read aloud.
//   hint          optional short words after the label ("the schema you want").
//   connections   [{ id, name, detail? }]. `detail` is usually the database name.
//   connectionId  the chosen connection's id, or null / "" when none is chosen.
//   schema        the chosen schema's name, or null / "" when none is chosen.
//   schemas       the schema names on the chosen connection.
//   loading       true while that list is on its way.
//   error         a message the API sent back when the list could not be read.
//                 It is shown with ErrorNotice, so it says what to press.
//   onRetry       shows Try again on a "can't connect" error.
//   statuses      optional { schemaName: "in_sync" | "drifted" | "unreachable" | null }.
//                 A schema named here gets its status chip in the list.
//                 Leave a schema out when the page does not know its status.
//   disabled      the choice cannot be changed right now.
//   onChange      called with { connectionId, schema }. When someone picks
//                 another connection, schema is "": the page then loads that
//                 connection's schemas and decides which one to select.
//
// What it shows:
//   nothing chosen      "Choose a connection and schema"
//   loading             "Loading schemas from <connection>…"
//   chosen              the connection, the schema, and a Change button
//   no schemas          an ErrorNotice saying so, with Open Connections
//   can't connect       an ErrorNotice with Try again
//
// Change opens a panel with a search box, the connections, and the schemas on
// the chosen connection. Escape closes it and focus goes back to Change.
//
// Usage, with the useSchemaList hook below doing the loading:
//
//   const [target, setTarget] = useState({ connectionId: "", schema: "" });
//   const list = useSchemaList(target.connectionId, {
//     // Pick a schema as soon as the new connection's list arrives.
//     onLoaded: (schemas) =>
//       setTarget((now) => ({ ...now, schema: now.schema || schemas[0] || "" })),
//   });
//
//   <TargetPicker
//     label="Target"
//     connections={connections.map((c) => ({ id: c.id, name: c.name, detail: c.database_name }))}
//     connectionId={target.connectionId}
//     schema={target.schema}
//     schemas={list.schemas}
//     loading={list.loading}
//     error={list.error}
//     onRetry={list.retry}
//     statuses={{ students_dev: "in_sync", students_prod: "drifted" }}
//     onChange={setTarget}
//   />
//
// Two pickers side by side go inside <TargetPickerPair>, which draws the one
// error line they share. See the end of this file.
// ---------------------------------------------------------------------------

/** One connection in the picker's list. */
export type PickerConnection = {
  id: string | number;
  name: string;
  /** A second, quieter word for it. Usually the database name. */
  detail?: string | null;
};

/** What onChange hands back. Ids are always strings; "" means not chosen. */
export type TargetChoice = { connectionId: string; schema: string };

export type TargetPickerProps = {
  label?: string;
  hint?: string;
  connections: PickerConnection[];
  connectionId: string | number | null | undefined;
  schema: string | null | undefined;
  schemas: string[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  statuses?: Record<string, string | null | undefined>;
  disabled?: boolean;
  onChange: (next: TargetChoice) => void;
  className?: string;
};

export function TargetPicker({
  label = "Connection and schema",
  hint,
  connections,
  connectionId,
  schema,
  schemas,
  loading = false,
  error = null,
  onRetry,
  statuses,
  disabled = false,
  onChange,
  className,
}: TargetPickerProps) {
  const chosenId = connectionId == null ? "" : String(connectionId);
  const chosenSchema = schema ?? "";
  const connection = connections.find((item) => String(item.id) === chosenId) ?? null;
  const connectionName = connection?.name ?? null;

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const panelId = useId();

  /** Close the panel. `refocus` puts the keyboard back on the Change button. */
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setSearch("");
    if (refocus) changeRef.current?.focus();
  }, []);

  // While the panel is open: start in the search box, and close on a press
  // anywhere outside the picker.
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    function onPress(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    }
    document.addEventListener("mousedown", onPress);
    return () => document.removeEventListener("mousedown", onPress);
  }, [open, close]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }

  function pickConnection(id: string) {
    // The panel stays open: the schemas for this connection come next.
    if (id !== chosenId) onChange({ connectionId: id, schema: "" });
  }

  function pickSchema(name: string) {
    if (name !== chosenSchema) onChange({ connectionId: chosenId, schema: name });
    close(true);
  }

  // The chosen schema always has a row, even when the list could not be read
  // or does not contain it, so the panel never hides what is selected.
  const rows = chosenSchema && !schemas.includes(chosenSchema) ? [chosenSchema, ...schemas] : schemas;
  const query = search.trim().toLowerCase();
  const shownConnections = connections.filter(
    (item) =>
      query === "" ||
      item.name.toLowerCase().includes(query) ||
      (item.detail ?? "").toLowerCase().includes(query),
  );
  const shownSchemas = loading ? [] : rows.filter((name) => query === "" || name.toLowerCase().includes(query));

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    // Never let Enter submit a form the picker happens to sit in. With one
    // schema left in the list, Enter chooses it.
    event.preventDefault();
    if (query !== "" && shownSchemas.length === 1) pickSchema(shownSchemas[0]);
  }

  const nothingChosen = chosenId === "";
  const noSchemas = !nothingChosen && !loading && !error && schemas.length === 0 && chosenSchema === "";
  const lowerLabel = label.toLowerCase();
  const loadingText = `Loading schemas from ${connectionName ?? "this connection"}…`;

  return (
    <div
      ref={rootRef}
      className={["tp", open ? "tp--open" : "", className ?? ""].filter(Boolean).join(" ")}
      onKeyDown={onKeyDown}
    >
      <div className="tp__label" id={labelId}>
        {label}
        {hint && <span className="tp__hint"> · {hint}</span>}
      </div>

      {/* The panel hangs from this wrapper, so it opens right under the field
          even when a notice sits below it. */}
      <div className="tp__anchor">
      {nothingChosen ? (
        // Nothing chosen yet: the whole field is the button.
        <button
          type="button"
          ref={changeRef}
          className="tp__field tp__field--empty"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-describedby={labelId}
          disabled={disabled}
          onClick={() => setOpen((now) => !now)}
        >
          <span>Choose a connection and schema</span>
          <ChevronDownIcon size={16} />
        </button>
      ) : (
        <div className="tp__field" role="group" aria-labelledby={labelId}>
          {loading ? (
            <span className="tp__loading" role="status">
              <i aria-hidden="true" />
              <span className="tp__clip">{loadingText}</span>
            </span>
          ) : (
            <span className="tp__chosen">
              <b className="tp__clip" title={connectionName ?? undefined}>
                {connectionName ?? "Unknown connection"}
              </b>
              {chosenSchema ? (
                <span className="tp__schema tp__clip" title={chosenSchema}>
                  {chosenSchema}
                </span>
              ) : (
                <span className="tp__quiet">No schema chosen</span>
              )}
            </span>
          )}
          <button
            type="button"
            ref={changeRef}
            className="tp__change"
            aria-label={`Change ${lowerLabel} connection and schema`}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            disabled={disabled}
            onClick={() => setOpen((now) => !now)}
          >
            Change
          </button>
        </div>
      )}

      {open && (
        <div
          className="tp__panel"
          id={panelId}
          role="dialog"
          aria-label={`Choose ${lowerLabel} connection and schema`}
        >
          <label className="tp__search">
            <SearchIcon size={16} />
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search connections and schemas"
              aria-label="Search connections and schemas"
              autoComplete="off"
            />
          </label>

          <div className="tp__scroll">
            <div role="group" aria-label="Connections">
              <p className="tp__group">Connections</p>
              {connections.length === 0 ? (
                <p className="tp__say">No connections yet. Add one on Connections.</p>
              ) : shownConnections.length === 0 ? (
                <p className="tp__say">No connection matches.</p>
              ) : (
                shownConnections.map((item) => {
                  const selected = String(item.id) === chosenId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className="tp__row"
                      aria-pressed={selected}
                      onClick={() => pickConnection(String(item.id))}
                    >
                      <span className="tp__tick" aria-hidden="true">
                        {selected && <CheckIcon size={14} />}
                      </span>
                      <span className="tp__name tp__clip">{item.name}</span>
                      {item.detail && <span className="tp__detail tp__clip">{item.detail}</span>}
                    </button>
                  );
                })
              )}
            </div>

            {!nothingChosen && (
              <div role="group" aria-label="Schemas">
                <p className="tp__group">
                  Schemas on <span className="tp__clip">{connectionName ?? "this connection"}</span>
                </p>
                {loading ? (
                  <p className="tp__say" role="status">
                    {loadingText}
                  </p>
                ) : rows.length === 0 ? (
                  <p className="tp__say">
                    {error ? "The schemas could not be listed." : "No schemas to show."}
                  </p>
                ) : shownSchemas.length === 0 ? (
                  <p className="tp__say">No schema matches.</p>
                ) : (
                  shownSchemas.map((name) => {
                    const selected = name === chosenSchema;
                    const known = statuses !== undefined && name in statuses;
                    return (
                      <button
                        key={name}
                        type="button"
                        className="tp__row"
                        aria-pressed={selected}
                        onClick={() => pickSchema(name)}
                      >
                        <span className="tp__tick" aria-hidden="true">
                          {selected && <CheckIcon size={14} />}
                        </span>
                        <span className="tp__name tp__name--schema tp__clip">{name}</span>
                        {known && <StatusChip status={statuses[name]} size="sm" />}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          <p className="tp__foot">Only schemas your role can read are listed.</p>
        </div>
      )}
      </div>

      {/* One notice under the field, never both. */}
      {error ? (
        <ErrorNotice
          variant="inline"
          error={error}
          connectionName={connectionName}
          connectionId={chosenId || null}
          onRetry={onRetry}
        />
      ) : noSchemas ? (
        <ErrorNotice variant="inline" error="No schemas on this connection" connectionName={connectionName} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// useSchemaList: the loader most pages want. It reads the schema names on a
// connection from /api/lineage/schemas and hands back what TargetPicker needs.
// ---------------------------------------------------------------------------

type SchemaAnswer = { id: string; schemas: string[]; error: string | null };

export function useSchemaList(
  connectionId: string | number | null | undefined,
  options: {
    /** Called with the names when a connection's list arrives. */
    onLoaded?: (schemas: string[]) => void;
  } = {},
): { schemas: string[]; loading: boolean; error: string | null; retry: () => void } {
  const id = connectionId == null ? "" : String(connectionId);
  // The last answer and which connection it is about. An answer for another
  // connection counts as "still loading", so an old list is never shown.
  const [answer, setAnswer] = useState<SchemaAnswer | null>(null);
  const [attempt, setAttempt] = useState(0);
  const onLoaded = useRef(options.onLoaded);
  useEffect(() => {
    onLoaded.current = options.onLoaded;
  });

  useEffect(() => {
    if (id === "") return;
    // Picking A and then B quickly sends two requests, and A's answer can land
    // second. Only the request this effect started may answer.
    let current = true;
    async function load() {
      let next: SchemaAnswer;
      try {
        const response = await apiFetch(`/api/lineage/schemas?connectionId=${encodeURIComponent(id)}`, {
          cache: "no-store",
        });
        const data = await response.json().catch(() => null);
        next =
          response.ok && Array.isArray(data?.schemas)
            ? { id, schemas: data.schemas as string[], error: null }
            : { id, schemas: [], error: data?.error ?? "Could not list the schemas on that connection." };
      } catch {
        next = { id, schemas: [], error: "Network error while listing the schemas on that connection." };
      }
      if (!current) return;
      setAnswer(next);
      if (next.error === null) onLoaded.current?.(next.schemas);
    }
    void load();
    return () => {
      current = false;
    };
  }, [id, attempt]);

  const mine = answer !== null && answer.id === id ? answer : null;
  const retry = useCallback(() => {
    setAnswer(null);
    setAttempt((count) => count + 1);
  }, []);

  return {
    schemas: mine?.schemas ?? [],
    loading: id !== "" && mine === null,
    error: mine?.error ?? null,
    retry,
  };
}

// ---------------------------------------------------------------------------
// TargetPickerPair: two pickers side by side that share one error line.
//
//   <TargetPickerPair
//     source={<TargetPicker label="Source" ... />}
//     target={<TargetPicker label="Target" ... />}
//     between={<SwapButton />}            // optional, sits between the two
//     error={same ? "Source and target are the same schema. Pick a different target." : null}
//   />
//
// On a phone the two stack, and the error line stays under both.
// ---------------------------------------------------------------------------

export function TargetPickerPair({
  source,
  target,
  between,
  error,
  className,
}: {
  source: ReactNode;
  /** One picker, or several stacked (Compare can have more than one target). */
  target: ReactNode;
  between?: ReactNode;
  /** The one line under the pair. Nothing is drawn when it is empty. */
  error?: string | null;
  className?: string;
}) {
  return (
    <div className={["tp-pair", className ?? ""].filter(Boolean).join(" ")}>
      <div className="tp-pair__row">
        <div className="tp-pair__side">{source}</div>
        <div className="tp-pair__between">{between}</div>
        <div className="tp-pair__side">{target}</div>
      </div>
      {error && (
        <p className="tp-pair__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
