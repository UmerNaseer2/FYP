"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { StatusChip } from "@/components/ui/StatusChip";
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, SearchIcon } from "@/components/ui/icons";
import { apiFetch } from "@/lib/ui/api-fetch";
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
// Change opens a panel that shows one step at a time. Step one lists the
// connections. Picking one slides to step two, that connection's schemas,
// with a Connections button to step back out. With a connection already
// chosen the panel opens on its schemas, so changing the schema is one press.
// Each step has its own search box; the arrow keys walk the rows, Backspace in
// an empty search box steps back, and Escape closes the panel and puts focus
// back on Change.
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

type Step = "connections" | "schemas";

/** How the next step slides in: deeper (forward), back out, or not at all. */
type Motion = "forward" | "back" | "none";

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
  const [step, setStep] = useState<Step>("connections");
  const [motion, setMotion] = useState<Motion>("none");
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const panelId = useId();

  const nothingChosen = chosenId === "";
  // The schemas step needs a connection. Until the page has taken one, the
  // panel stays on the connections.
  const view: Step = step === "schemas" && !nothingChosen ? "schemas" : "connections";

  /** Close the panel. `refocus` puts the keyboard back on the Change button. */
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setSearch("");
    if (refocus) changeRef.current?.focus();
  }, []);

  /**
   * Open on the step that needs a decision. With a connection already chosen
   * that is its schemas, one press from done; with none it is the connections.
   */
  function toggle() {
    if (open) {
      close(false);
      return;
    }
    setStep(nothingChosen ? "connections" : "schemas");
    setMotion("none");
    setSearch("");
    setOpen(true);
  }

  // While the panel is open: close on a press anywhere outside the picker.
  useEffect(() => {
    if (!open) return;
    function onPress(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    }
    document.addEventListener("mousedown", onPress);
    return () => document.removeEventListener("mousedown", onPress);
  }, [open, close]);

  // Each step starts in its own search box, with the chosen row in view.
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const chosen = stepRef.current?.querySelector<HTMLElement>('.tp__row[aria-pressed="true"]');
    chosen?.scrollIntoView?.({ block: "nearest" });
  }, [open, view]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }

  /** Into a connection's schemas. A new connection is handed up at once. */
  function openConnection(id: string) {
    if (id !== chosenId) onChange({ connectionId: id, schema: "" });
    setMotion("forward");
    setStep("schemas");
    setSearch("");
  }

  function backToConnections() {
    setMotion("back");
    setStep("connections");
    setSearch("");
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
    if (event.key === "Backspace" && search === "" && view === "schemas") {
      // An empty search box has nothing left to delete, so Backspace steps
      // back out to the connections, the way a breadcrumb would.
      event.preventDefault();
      backToConnections();
      return;
    }
    if (event.key !== "Enter") return;
    // Never let Enter submit a form the picker happens to sit in. With one row
    // left in the list, Enter takes it.
    event.preventDefault();
    if (query === "") return;
    if (view === "connections" && shownConnections.length === 1) openConnection(String(shownConnections[0].id));
    if (view === "schemas" && shownSchemas.length === 1) pickSchema(shownSchemas[0]);
  }

  /** Up and down walk the rows; up from the first row lands back in the search box. */
  function onStepKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const list = Array.from(stepRef.current?.querySelectorAll<HTMLButtonElement>("button.tp__row") ?? []);
    if (list.length === 0) return;
    event.preventDefault();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      list[Math.min(at + 1, list.length - 1)].focus();
    } else if (at <= 0) {
      searchRef.current?.focus();
    } else {
      list[at - 1].focus();
    }
  }

  const noSchemas = !nothingChosen && !loading && !error && schemas.length === 0 && chosenSchema === "";
  const lowerLabel = label.toLowerCase();
  const loadingText = `Loading schemas from ${connectionName ?? "this connection"}…`;
  const here = connectionName ?? "this connection";

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
          onClick={toggle}
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
            onClick={toggle}
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
          {/* One step at a time: the connections, then the schemas on the one
              picked. The key restarts the slide each time the step changes. */}
          <div
            key={view}
            ref={stepRef}
            className={`tp__step tp__step--${motion}`}
            onKeyDown={onStepKeyDown}
          >
            {view === "schemas" && (
              <div className="tp__crumb">
                <button type="button" className="tp__back" aria-label="Back to connections" onClick={backToConnections}>
                  <ChevronLeftIcon size={16} />
                  <span>Connections</span>
                </button>
                <span className="tp__crumb-here">
                  <b className="tp__clip" title={here}>{here}</b>
                  {connection?.detail && <span className="tp__detail tp__clip">{connection.detail}</span>}
                </span>
              </div>
            )}

            <label className="tp__search">
              <SearchIcon size={16} />
              <input
                ref={searchRef}
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={view === "schemas" ? `Search schemas on ${here}` : "Search connections"}
                aria-label={view === "schemas" ? "Search schemas" : "Search connections"}
                autoComplete="off"
              />
            </label>

            <div className="tp__scroll">
              {view === "connections" ? (
                <div role="group" aria-label="Connections">
                  <p className="tp__group">
                    Connections
                    {connections.length > 0 && <span className="tp__count">{connections.length}</span>}
                  </p>
                  {connections.length === 0 ? (
                    <p className="tp__say">No connections yet. Add one on Connections.</p>
                  ) : shownConnections.length === 0 ? (
                    <p className="tp__say">No connection matches.</p>
                  ) : (
                    shownConnections.map((item, index) => {
                      const selected = String(item.id) === chosenId;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className="tp__row"
                          style={{ "--i": Math.min(index, 8) } as CSSProperties}
                          aria-pressed={selected}
                          onClick={() => openConnection(String(item.id))}
                        >
                          <span className="tp__tick" aria-hidden="true">
                            {selected && <CheckIcon size={14} />}
                          </span>
                          <span className="tp__name tp__clip">{item.name}</span>
                          {item.detail && <span className="tp__detail tp__clip">{item.detail}</span>}
                          <span className="tp__go" aria-hidden="true">
                            <ChevronRightIcon size={16} />
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              ) : (
                <div role="group" aria-label="Schemas">
                  <p className="tp__group">
                    Schemas
                    {!loading && rows.length > 0 && <span className="tp__count">{rows.length}</span>}
                  </p>
                  {loading ? (
                    <div className="tp__skels">
                      <p className="tp__hide" role="status">
                        {loadingText}
                      </p>
                      {[64, 48, 72].map((width, index) => (
                        <span key={index} className="tp__skel" aria-hidden="true" style={{ "--i": index } as CSSProperties}>
                          <i />
                          <i style={{ width: `${width}%` }} />
                        </span>
                      ))}
                    </div>
                  ) : rows.length === 0 ? (
                    <p className="tp__say">
                      {error ? "The schemas could not be listed." : "No schemas to show."}
                    </p>
                  ) : shownSchemas.length === 0 ? (
                    <p className="tp__say">No schema matches.</p>
                  ) : (
                    shownSchemas.map((name, index) => {
                      const selected = name === chosenSchema;
                      const known = statuses !== undefined && name in statuses;
                      return (
                        <button
                          key={name}
                          type="button"
                          className="tp__row"
                          style={{ "--i": Math.min(index, 8) } as CSSProperties}
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
          </div>

          <div className="tp__foot">
            <span>
              {view === "schemas"
                ? "Only schemas your role can read are listed."
                : "Pick a connection to see its schemas."}
            </span>
            <span className="tp__dots" aria-hidden="true">
              <i className={view === "connections" ? "on" : ""} />
              <i className={view === "schemas" ? "on" : ""} />
            </span>
          </div>
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
