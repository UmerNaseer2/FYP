"use client";

import Link from "next/link";
import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useSearchParams } from "next/navigation";
import {
  pickSchemaAfterConnectionChange,
  selectionToQuery,
  swapSourceWithTarget,
} from "@/lib/compare-selection";
import { buildDiffDocument } from "@/lib/compare-export";
import { renameMatchingSkipped } from "@/lib/compare";
import type {
  CompareScreen,
  ConnectionView,
  OutcomeView,
} from "@/lib/compare-run";
import { DiffReport, type DiffFilter } from "@/components/studio/DiffReport";
import { ExportBar } from "@/components/studio/ExportBar";
import { SummaryMatrix } from "@/components/studio/SummaryMatrix";
import { DataCompare } from "@/components/studio/DataCompare";
import { CriticalChanges } from "@/components/studio/CriticalChanges";
import { CompareSummaryPanel } from "@/components/studio/CompareSummaryPanel";
import { CompareHistory } from "@/components/studio/CompareHistory";
import { MigrationWorkbench } from "@/components/studio/MigrationWorkbench";
import { VersionDetectBar } from "@/components/studio/VersionDetectBar";
import { CompareVersionTimeline } from "@/components/studio/CompareVersionTimeline";
import { ComparisonSetBar } from "@/components/studio/ComparisonSetBar";
import { PageHeader } from "@/components/studio/PageHeader";
import { Button } from "@/components/ui/Button";
import { HelpHint } from "@/components/ui/HelpHint";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Select } from "@/components/ui/Select";
import {
  CompareIcon,
  AlertTriangleIcon,
  ConnectionsIcon,
  PlusIcon,
  RefreshIcon,
  SchemaMapIcon,
  XIcon,
} from "@/components/ui/icons";
import { apiFetch } from "@/lib/api-fetch";
import { useOrgHref } from "@/hooks/useOrg";
import "@/app/styles/atelier-compare.css";

// ---------------------------------------------------------------------------
// Compare & Author.
//
// The screen only draws. Every connection, snapshot and diff on it is computed
// by POST /api/compare, which is the only thing here that touches a database ,
// the browser never sees a host or a password, and the page can be rendered
// before any of that work has finished.
//
// It reads its whole selection out of the query string, which is what keeps a
// comparison shareable and reloadable. The picker bar is still a plain GET
// <form>: "add target" is a submit, and repeated field names arrive as
// parallel lists. The one thing a picker does on its own is fetch the schema
// list when its connection changes, so the schema box never offers the last
// database's schemas for the new one.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

/**
 * One LIVE selector (connection + schema) inside the picker bar.
 *
 * All the target pickers share the field names `targetConnection` and
 * `targetSchema`, so the browser submits them as two parallel lists, that is
 * what makes "add another target" work with a plain <form>.
 *
 * Changing the connection fetches that database's schemas straight away. The
 * schema box used to keep offering the OLD connection's list until Compare was
 * pressed, so the usual move, dev.public to staging.public, took two
 * submits, and the first one compared a schema the new database might not have.
 */
/**
 * The options bar's form id.
 *
 * Named rather than written twice because the data panel's table picker sits
 * far below the bar, outside the <form> element entirely, and reaches it with
 * the HTML `form` attribute. That is the whole reason the picker needs no
 * client state: its checkboxes are part of this form despite where they are
 * drawn, so Compare submits them along with everything else.
 */
const COMPARE_FORM_ID = "compare-options";

function SlotPicker({
  role,
  fieldPrefix,
  slotKey,
  connections,
  selectedConnectionId,
  schemaOptions,
  selectedSchema,
  missingMessage,
  onDirtyChange,
}: {
  role: string;
  fieldPrefix: "source" | "target";
  /** Names this picker when it reports to onDirtyChange. */
  slotKey: string;
  connections: ConnectionView[];
  /** What the comparison on screen used; "" when this side has no connection. */
  selectedConnectionId: string;
  schemaOptions: string[];
  selectedSchema: string;
  /** Why this side has no connection to read, or null when it has one. */
  missingMessage: string | null;
  /** Told whether the picks now differ from what the comparison on screen used. */
  onDirtyChange: (slotKey: string, dirty: boolean) => void;
}) {
  const [connectionId, setConnectionId] = useState(selectedConnectionId);
  const [options, setOptions] = useState(schemaOptions);
  const [schema, setSchema] = useState(selectedSchema);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  // Picking A and then B quickly sends two requests, and A's answer can land
  // second. Only the newest request is allowed to fill the list.
  const latestRequest = useRef(0);

  // Compared with what the screen used, not with "has anything been touched":
  // picking another connection and then the first one again is back to clean.
  const dirty = connectionId !== selectedConnectionId || schema !== selectedSchema;
  useEffect(() => {
    onDirtyChange(slotKey, dirty);
  }, [slotKey, dirty, onDirtyChange]);

  async function changeConnection(next: string) {
    if (next === connectionId) return;
    setConnectionId(next);
    setListError(null);
    setLoading(true);
    const request = ++latestRequest.current;
    try {
      const response = await apiFetch(
        `/api/lineage/schemas?connectionId=${encodeURIComponent(next)}`,
        { cache: "no-store" },
      );
      const data = await response.json().catch(() => null);
      if (request !== latestRequest.current) return;
      if (response.ok && Array.isArray(data?.schemas)) {
        const list: string[] = data.schemas;
        setOptions(list);
        setSchema((previous) => pickSchemaAfterConnectionChange(previous, list));
      } else {
        // The schema already in the box stays. Compare still tries it, and the
        // result says whether that database could be read at all.
        setOptions([]);
        setListError(data?.error ?? "Could not list the schemas on that connection.");
      }
    } catch {
      if (request !== latestRequest.current) return;
      setOptions([]);
      setListError("Network error while listing the schemas on that connection.");
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
  }

  // A schema the list does not contain, typed into a URL, or kept after a
  // listing failed, still shows, so the box never looks empty while it
  // would submit something.
  const schemaChoices = options.length > 0 ? options : schema.length > 0 ? [schema] : [];

  return (
    <div className="cp-pick">
      <div className="cp-pick__role">
        <span>{role}</span>
        {/* The pill is one word of jargon. A title alone reaches neither a
            screen reader nor a touch device, so the name goes on the element. */}
        <span
          className="cp-live"
          title="Read live from the server, not from a saved snapshot"
          aria-label="Read live from the server, not from a saved snapshot"
        >
          live
        </span>
      </div>
      <Select
        name={`${fieldPrefix}Connection`}
        value={connectionId}
        onChange={(next) => void changeConnection(next)}
        ariaLabel={`${role} connection`}
        placeholder="Pick a connection…"
        options={connections.map((connection) => ({
          value: String(connection.id),
          label: `${connection.name} (${connection.database_name})`,
        }))}
      />
      {/* Blank while loading, so a Compare pressed mid-load sends no schema
          and the server picks the default rather than the old database's. */}
      <Select
        name={`${fieldPrefix}Schema`}
        value={loading ? "" : schema}
        onChange={setSchema}
        ariaLabel={`${role} schema`}
        variant="sub"
        mono
        disabled={loading || schemaChoices.length === 0}
        placeholder={
          loading
            ? "Loading schemas…"
            : connectionId === ""
              ? "Pick a connection first"
              : "No schemas on this connection"
        }
        options={schemaChoices.map((name) => ({ value: name, label: name }))}
      />
      {listError ? (
        <span className="cp-pick__problem" role="alert">
          {listError}
        </span>
      ) : missingMessage && connectionId === selectedConnectionId ? (
        <span className="cp-pick__problem">{missingMessage}</span>
      ) : null}
    </div>
  );
}

/** What one tile filters the diff to, and the words on it. */
const TILES: { filter: DiffFilter; tone: string; label: string; hint: string }[] = [
  { filter: "add", tone: "add", label: "Added", hint: "+ to create" },
  { filter: "chg", tone: "chg", label: "Changed", hint: "~ to alter" },
  { filter: "rem", tone: "rem", label: "Removed", hint: "\u2212 to drop" },
  { filter: "same", tone: "same", label: "In sync", hint: "= tables left alone" },
];

/**
 * The four big counts above a target's diff. Each one is a button: pressing it
 * narrows the diff below to that kind of change, and pressing it again shows
 * everything.
 */
function ChangeTiles({
  counts,
  active,
  onPick,
}: {
  counts: Record<DiffFilter, number>;
  active: DiffFilter | null;
  onPick: (next: DiffFilter | null) => void;
}) {
  return (
    <div
      className={active ? "cp-tiles cp-tiles--filtered" : "cp-tiles"}
      role="group"
      aria-label="Show one kind of change"
    >
      {TILES.map((tile, index) => (
        <button
          key={tile.filter}
          type="button"
          className={`cp-tile cp-tile--${tile.tone} rise`}
          style={{ "--d": index * 60 } as CSSProperties}
          aria-pressed={active === tile.filter}
          onClick={() => onPick(active === tile.filter ? null : tile.filter)}
        >
          <b>{counts[tile.filter]}</b>
          <span>
            {tile.label}
            <i>{tile.hint}</i>
          </span>
        </button>
      ))}
    </div>
  );
}

/** The one-line "X of Y targets differ" bar above the per-target sections. */
function RunSummary({ outcomes }: { outcomes: OutcomeView[] }) {
  const compared = outcomes.filter((o) => o.delta);
  const differing = compared.filter((o) => (o.delta?.total ?? 0) > 0).length;
  const inSync = compared.length - differing;
  // Counted off the reason, not by subtraction. "Everything without a diff is
  // unreachable" swept up a server that answered fine and has no schema by that
  // name, and a target compared with itself, which was never dialled at all.
  const unreachable = outcomes.filter((o) => o.failure === "unreachable").length;
  const schemaMissing = outcomes.filter((o) => o.failure === "schema-missing").length;
  const noConnection = outcomes.filter((o) => o.failure === "no-connection").length;
  const duplicates = outcomes.filter((o) => o.failure === "duplicate").length;
  // A target whose comparison threw. Counted on its own rather than added to
  // "unreachable", which would point the reader at a network that is fine.
  const failed = outcomes.filter((o) => o.failure === "failed").length;
  const sameAsSource = outcomes.filter((o) => o.sameAsSource).length;

  return (
    <div className="cp-run-summary">
      <h2 className="cp-h2">Results</h2>
      <span className="cp-run-summary__count">
        <b>{outcomes.length}</b> target{outcomes.length === 1 ? "" : "s"}
      </span>
      <span className="delta delta-chg" style={differing ? undefined : { opacity: 0.5 }}>
        {differing} differing
      </span>
      <span className="delta delta-add" style={inSync ? undefined : { opacity: 0.5 }}>
        {inSync} in sync
      </span>
      {unreachable > 0 && (
        <span className="delta delta-rem">{unreachable} unreachable</span>
      )}
      {schemaMissing > 0 && (
        <span className="delta delta-rem">{schemaMissing} schema not found</span>
      )}
      {noConnection > 0 && (
        <span className="delta delta-rem">{noConnection} without a connection</span>
      )}
      {failed > 0 && (
        <span className="delta delta-rem">{failed} failed to compare</span>
      )}
      {/* Not failures, nothing was dialled because the answer was known. */}
      {sameAsSource > 0 && (
        <span className="pill pill-neutral">{sameAsSource} same as source</span>
      )}
      {duplicates > 0 && (
        <span className="pill pill-neutral">
          {duplicates} duplicate{duplicates === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * The query string is read with useSearchParams, which Next requires to sit
 * under a Suspense boundary, without one the build fails rather than the page.
 */
export default function ComparePage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <CompareRoute />
    </Suspense>
  );
}

/**
 * Shown while the first comparison is still running.
 *
 * Shaped like the real screen, picker bar, then one diff panel, so the page
 * does not jump when the answer arrives.
 */
function LoadingScreen() {
  return (
    <div className="cp-page" aria-busy="true">
      <PageHeader page="/compare" />
      <div className="card cp-form">
        <div className="cp-pair">
          <div className="cp-db">
            <Skeleton width={180} height={11} />
            <Skeleton height={64} radius={12} className="mt-2" />
          </div>
          <div className="cp-flow" aria-hidden="true" />
          <div className="cp-db">
            <Skeleton width={220} height={11} />
            <Skeleton height={64} radius={12} className="mt-2" />
          </div>
        </div>
      </div>
      <div className="cp-tiles">
        <Skeleton height={68} radius={24} />
        <Skeleton height={68} radius={24} />
        <Skeleton height={68} radius={24} />
        <Skeleton height={68} radius={24} />
      </div>
      <Skeleton height={200} radius={24} />
      <p className="cp-loading-say" role="status">
        <i aria-hidden="true" />
        Reading both schemas
      </p>
    </div>
  );
}

/**
 * The URL is the whole selection, so it is read once here and handed down as a
 * single string. The key remounts the screen whenever it changes, so a new
 * comparison starts from the skeleton instead of leaving the previous run's
 * diff on screen looking like the answer.
 */
function CompareRoute() {
  const query = useSearchParams().toString();
  return <CompareScreenView key={query} query={query} />;
}

function CompareScreenView({ query }: { query: string }) {
  const orgPath = useOrgHref();
  const [screen, setScreen] = useState<CompareScreen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Counts the comparison's successful runs. The version timeline is keyed on
  // it: a re-run of the same query (after Save, say) keeps this component, and
  // without a new key the timeline would keep the history it loaded for the
  // run before.
  const [runSerial, setRunSerial] = useState(0);

  // `record` asks the server to stamp the open saved set's "last run" time. It
  // goes once per URL that carries `run=1`, Compare, opening a set, or a link
  // that asks to run, and not on the reload after Save, which would count the
  // same run twice. The ref remembers which URL has been stamped.
  const recorded = useRef<string | null>(null);

  // The two run options are the only fields in the picker bar that change what
  // the diff SAYS rather than which schemas it reads, and this is a plain GET
  // form: ticking a box changes nothing until Compare is pressed. The report
  // below meanwhile says "Untick Allow data loss to hold it back", so a reader
  // who did exactly that watched the page keep insisting the drop was armed.
  //
  // null means "not touched since this comparison ran", which is not the same
  // as false, the value that produced what is on screen can come from a saved
  // set rather than from the query string, so it is read off `screen` and not
  // re-derived here. Pressing Compare submits the form, which changes the
  // query, which remounts this component with a fresh key, so these go back
  // to null on their own and there is nothing to reset.
  const [pendingDataLoss, setPendingDataLoss] = useState<boolean | null>(null);
  const [pendingRowData, setPendingRowData] = useState<boolean | null>(null);

  // The same idea for the pickers: which of them now differ from what the
  // comparison on screen used. Keyed by picker, because one picker going back
  // to clean must not hide another that is still changed.
  const [dirtyPickers, setDirtyPickers] = useState<Record<string, boolean>>({});
  // Which kind of change each target's diff is narrowed to, by target number.
  // Nothing in here means "show everything". A new comparison remounts this
  // component, so the tiles start unpressed again on their own.
  const [filters, setFilters] = useState<Record<number, DiffFilter | null>>({});

  const reportDirty = useCallback((slotKey: string, dirty: boolean) => {
    setDirtyPickers((previous) =>
      Boolean(previous[slotKey]) === dirty ? previous : { ...previous, [slotKey]: dirty },
    );
  }, []);

  // One run of the comparison. Everything it needs is in the query string, so
  // it is sent verbatim and the server decides what it means, two places
  // parsing "?targetConnection=3&targetConnection=7" would eventually disagree.
  const load = useCallback(async () => {
    const record =
      new URLSearchParams(query).get("run") === "1" && recorded.current !== query;
    if (record) recorded.current = query;

    setLoading(true);
    try {
      const response = await apiFetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, record }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data) {
        setScreen(data as CompareScreen);
        setError(null);
        setRunSerial((serial) => serial + 1);
      } else {
        setError(data?.error ?? "Could not run this comparison.");
      }
    } catch {
      setError("Network error while running the comparison.");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
    // React in development runs every effect twice, and the two answers can
    // land in either order. When only the first run stamped the set, the
    // second could land last carrying the time from before the stamp, and a
    // set that had just run read "never run". Forgetting the stamp here lets
    // both runs stamp it: twice, milliseconds apart, and only in development.
    return () => {
      recorded.current = null;
    };
  }, [load]);

  // A comparison that never arrived at all, there is nothing else to draw.
  if (error && !screen) {
    return (
      <div className="cp-page">
        <PageHeader page="/compare" />
        <div className="card cp-state">
          <span className="cp-state__icon" aria-hidden="true">
            <AlertTriangleIcon size={24} />
          </span>
          <small>Compare</small>
          <h2>This comparison did not run</h2>
          <p role="alert">{error}</p>
          <div className="cp-state__actions">
            <Button variant="primary" onClick={() => void load()} disabled={loading}>
              <RefreshIcon size={14} />
              {loading ? "Trying again" : "Try again"}
            </Button>
            <Link href={orgPath("/connections")} className="btn btn-ghost">
              Check connections
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Nothing rendered yet, the first run is still going.
  if (!screen) return <LoadingScreen />;

  // Nothing to compare with: point at Connections rather than rendering an
  // empty form that cannot do anything.
  if (screen.kind === "no-connections") {
    return (
      <div className="cp-page">
        {/* The title stays, like every other page with nothing to show yet. */}
        <PageHeader page="/compare" />
        <EmptyState
          icon={<CompareIcon size={22} />}
          title="Add a connection to compare"
          description={
            <>
              {/*
                This used to say "at least two connections", but the branch it
                sits in fires on ZERO, and one connection is genuinely enough,
                because the two sides of a comparison are two SCHEMAS and both
                can live on the same server. Asking for a second one sent people
                off to invent a connection they did not need.
              */}
              Comparing reads two schemas through your saved PostgreSQL
              connections. One is enough to start: the two sides can be two
              schemas on the same server.
            </>
          }
          actions={
            <Link href={orgPath("/connections")} className="btn btn-primary btn-sm">
              <ConnectionsIcon size={14} />
              Go to Connections
            </Link>
          }
        />
      </div>
    );
  }

  // The names below are the ones the markup has always used. Kept as they were
  // so the payload could change shape without the whole screen moving with it.
  const savedConnections = screen.connections;
  const resolvedTargets = screen.targets;
  const setOptions = screen.sets;
  const outcomes = screen.outcomes;
  const source = screen.source;
  const {
    canAddTarget,
    maxTargets,
    activeSetId,
    setNotFound,
    setsRefusal,
    setModified,
    selection,
    sourceError,
    allowDataLoss,
    compareData,
    dataTables,
    asked,
  } = screen;

  // What the boxes show, versus what the comparison on screen was actually run
  // with. They differ only while a tick is waiting for the next Compare.
  const dataLossBox = pendingDataLoss ?? allowDataLoss;
  const rowDataBox = pendingRowData ?? compareData;
  const optionsPending = dataLossBox !== allowDataLoss || rowDataBox !== compareData;
  const picksChanged = Object.values(dirtyPickers).some(Boolean);
  const unapplied = optionsPending || picksChanged;

  // The line under the page title. With one compared target it says what was
  // found, in the server's own counts; otherwise the help text's line stays.
  const onlyOutcome = outcomes.length === 1 ? outcomes[0] : null;
  const blurb =
    onlyOutcome && onlyOutcome.delta
      ? `${onlyOutcome.delta.total} change${onlyOutcome.delta.total === 1 ? "" : "s"} across ${
          onlyOutcome.delta.tablesTouched
        } table${onlyOutcome.delta.tablesTouched === 1 ? "" : "s"} to make ${
          onlyOutcome.displayName
        }.${onlyOutcome.schema} match ${source.displayName}.${source.schema}.`
      : undefined;

  return (
    <div
      className={loading ? "cp-page cp-page--busy" : "cp-page"}
      // A re-run keeps the current comparison on screen and fades it, rather
      // than dropping back to the skeleton. The numbers below are still the
      // last true answer until the new one lands. The dim on its own said none
      // of that, so the strip under the form says it in words too.
      aria-busy={loading}
    >
      <PageHeader page="/compare" blurb={blurb} />

      {/* A re-run that failed. The comparison below is the previous one, so it
          stays, but it is no longer what the screen was asked for. */}
      {error && (
        <div className="warn-inline" role="alert">
          <span className="ico">
            <AlertTriangleIcon size={14} />
          </span>
          <span>{error}</span>
        </div>
      )}

      {/* Saved sets sit above the pickers because they change what the pickers
          show. Its own island, not part of the form below: saving writes to
          the database, and this page's form is a GET that has to stay safe to
          reload and share. */}
      <div className="cp-sets">
        <ComparisonSetBar
          sets={setOptions}
          activeSetId={activeSetId}
          modified={setModified}
          selection={selection}
          hasUnappliedChanges={unapplied}
          asked={asked}
          onDone={() => void load()}
        />
      </div>

      {/* Selection, a plain form GET. The target pickers repeat one pair of
          field names, so the browser submits them as parallel lists and "add
          target" needs no client state at all. */}
      <form action={orgPath("/compare")} className="card cp-form" id={COMPARE_FORM_ID}>
        {/* Only the Compare button sends run=1. Add target and Remove change
            the pickers without running anything. This copy of it comes first
            because the first submit button in a form is the one Enter
            presses, and without it that was a target's Remove. */}
        <button
          type="submit"
          name="run"
          value="1"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
        >
          Compare
        </button>
        {/* Carried through every submit so the bar still knows which set is
            open after you add a target or press Compare. */}
        {activeSetId !== null && (
          <input type="hidden" name="set" value={String(activeSetId)} />
        )}

        <div className="cp-pair">
          <div className="cp-db">
            <span className="cp-db__icon" aria-hidden="true">
              <SchemaMapIcon size={18} />
            </span>
            <div className="cp-db__body">
              <div className="cp-db__label">Source, the schema you want</div>
              {/* Keyed by what the server resolved, so a reload that answers
                  differently starts the picker again from that answer. */}
              <SlotPicker
                key={`${source.connectionId}:${source.schema}`}
                role="Source · desired"
                fieldPrefix="source"
                slotKey="source"
                connections={savedConnections}
                selectedConnectionId={
                  source.connectionId === null ? "" : String(source.connectionId)
                }
                schemaOptions={source.schemaOptions}
                selectedSchema={source.schema}
                missingMessage={source.missingMessage}
                onDirtyChange={reportDirty}
              />
            </div>
          </div>

          {/* The dashed line runs from the source to the target. Swap is only
              offered when the server built a link for it: one target, and a
              saved connection on both sides. It runs the swapped comparison. */}
          <div className="cp-flow">
            {screen.swapHref && (
              <Link
                href={orgPath(screen.swapHref)}
                className="cp-swap"
                title="Make the target the source and the source the target, then compare again"
              >
                <RefreshIcon size={13} />
                Swap
              </Link>
            )}
          </div>

          <div className="cp-targets">
            {resolvedTargets.map((slot, index) => (
              <div className="cp-db cp-db--target" key={`target-${index}`}>
                <span className="cp-db__icon" aria-hidden="true">
                  <SchemaMapIcon size={18} />
                </span>
                <div className="cp-db__body">
                  <div className="cp-db__label">
                    {resolvedTargets.length === 1
                      ? "Target, this one gets updated"
                      : `Target ${index + 1} of ${resolvedTargets.length}, gets its own migration`}
                  </div>
                  <SlotPicker
                    key={`${slot.connectionId}:${slot.schema}`}
                    role={
                      resolvedTargets.length === 1
                        ? "Target · updated"
                        : `Target ${index + 1} · updated`
                    }
                    fieldPrefix="target"
                    slotKey={`target-${index}`}
                    connections={savedConnections}
                    selectedConnectionId={
                      slot.connectionId === null ? "" : String(slot.connectionId)
                    }
                    schemaOptions={slot.schemaOptions}
                    selectedSchema={slot.schema}
                    missingMessage={slot.missingMessage}
                    onDirtyChange={reportDirty}
                  />
                </div>
                {resolvedTargets.length > 1 && (
                  <button
                    type="submit"
                    name="removeTarget"
                    value={String(index)}
                    className="btn btn-ghost btn-icon cp-db__remove"
                    title={`Remove target ${index + 1}`}
                    aria-label={`Remove target ${index + 1}`}
                  >
                    <XIcon size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="cp-opts">
          {/* These two decide whether the generated script destroys data and
              whether the run reads table contents at all. What each one does
              is in the "?" beside it, which opens on a click, so it works on a
              touch screen and a screen reader announces it. The "?" sits
              beside the label, not inside it, so pressing it never flips the
              switch. */}
          <span className="cp-opt">
            <label className="cp-switch">
              <input
                type="checkbox"
                name="allowDataLoss"
                value="1"
                checked={dataLossBox}
                onChange={(e) => setPendingDataLoss(e.target.checked)}
              />
              <span className="cp-switch__track" aria-hidden="true" />
              Allow data loss
            </label>
            <HelpHint label="Allow data loss">
              While this is off, DROP TABLE, DROP COLUMN and any materialized
              view rebuild that has to drop the view first are written into the
              script commented out. Takes effect on the next Compare.
            </HelpHint>
          </span>
          <span className="cp-opt">
            <label className="cp-switch">
              <input
                type="checkbox"
                name="compareData"
                value="1"
                checked={rowDataBox}
                onChange={(e) => setPendingRowData(e.target.checked)}
              />
              <span className="cp-switch__track" aria-hidden="true" />
              Compare row data
            </label>
            <HelpHint label="Compare row data">
              Also reads the rows of every table and reports which tables differ,
              not just the structure. Much slower on big tables. Takes effect on
              the next Compare.
            </HelpHint>
          </span>
          {canAddTarget ? (
            <button type="submit" name="addTarget" value="1" className="btn btn-ghost btn-sm">
              <PlusIcon size={14} />
              Add target
            </button>
          ) : (
            <span className="cp-opts__limit">
              {maxTargets} targets is the maximum for one comparison.
            </span>
          )}
          {/* Said right by the button that applies it, because this is the
              moment the reader is deciding whether anything more is needed.
              The line keeps its room while hidden, so its arrival never moves
              the button away from where the reader was about to press. */}
          <div className="cp-run">
            <span
              className="cp-run__note"
              style={{ visibility: unapplied ? "visible" : "hidden" }}
            >
              <AlertTriangleIcon size={13} />
              Not applied yet. Press Compare.
            </span>
            <button type="submit" name="run" value="1" className="btn btn-primary">
              <CompareIcon size={14} />
              Compare
            </button>
          </div>
        </div>

        {/* The thin accent line that grows while a re-run is on its way. */}
        {loading && <div className="cp-bar" aria-hidden="true" />}
      </form>

      {/* A re-run leaves the previous diff on screen, faded, and a dim page is
          not a message: plenty of readers took it for the current answer
          being greyed out. This cannot appear on a first load, where `screen`
          is still null and the skeleton renders instead. */}
      {loading && (
        <div className="warn-inline" role="status">
          <span className="ico">
            <AlertTriangleIcon size={14} />
          </span>
          <span>
            Comparing again against the live databases. The diff below is the
            previous result.
          </span>
        </div>
      )}

      {/* A link to a saved set that has since been deleted. Said whether or
          not anything ran, because the bar above now shows no set open and
          would otherwise leave the reader wondering where it went. A role that
          may not open saved sets is told that instead: the set may be fine. */}
      {setNotFound && (
        <div className="warn-inline">
          <span className="ico">
            <AlertTriangleIcon size={14} />
          </span>
          <span>
            {setsRefusal ?? "That saved set no longer exists. It may have been deleted."}
            {asked
              ? " The comparison below is the one in the pickers."
              : " The pickers show the defaults instead; pick what to compare, then press Compare."}
          </span>
        </div>
      )}

      {/* A migration generated for a pair nobody chose reads as a
          recommendation, so a screen nobody asked to run says so and stops. */}
      {(!asked || source.missingMessage) && (
        <div className="card cp-quiet">
          <span className="cp-quiet__icon" aria-hidden="true">
            <CompareIcon size={20} />
          </span>
          <div>
            <h2 className="cp-h2">Nothing compared yet</h2>
            <p>
              {source.missingMessage
                ? "The source has no connection, so there is nothing to compare the targets with. Pick a source connection above, then press Compare."
                : "Nothing has been read from the databases yet. Press Compare to read the schemas picked above and generate each target's migration."}
            </p>
          </div>
        </div>
      )}

      <div className="cp-results">
        {/* A source we cannot read blocks every target, so it is reported once. */}
        {sourceError && (
          <div className="card cp-state cp-state--inline">
            <span className="cp-state__icon" aria-hidden="true">
              <AlertTriangleIcon size={24} />
            </span>
            <small>Source</small>
            <h2>Unable to read the source schema</h2>
            <p>{sourceError}</p>
          </div>
        )}

        {outcomes.length > 1 && <RunSummary outcomes={outcomes} />}

        {outcomes.map((outcome) => {
          // Flattened once per target, here, because three things below read
          // it: the export bar, the critical-differences panel, and nothing
          // else may build a second copy. Two copies could grade one change
          // differently.
          const diffDoc = outcome.report
            ? buildDiffDocument(outcome.report, outcome.data)
            : null;
          const filter = filters[outcome.index] ?? null;
          return (
            <section key={`outcome-${outcome.index}`} className="cp-outcome">
              {/* Per-target header: what is being compared, and how much differs. */}
              <div className="cp-outcome__head">
                {/* A heading rather than a span: with several targets this is
                    the only way to jump between their sections. */}
                <h2 className="cp-h2">
                  {outcomes.length === 1 ? "Diff" : `Target ${outcome.index + 1}`}
                </h2>
                {outcome.delta ? (
                  <span className="cp-outcome__count">
                    <b>{outcome.delta.total}</b> change
                    {outcome.delta.total === 1 ? "" : "s"} ·{" "}
                    <b>
                      {outcome.delta.tablesTouched} table
                      {outcome.delta.tablesTouched === 1 ? "" : "s"}
                    </b>
                  </span>
                ) : null}
                <span className="cp-outcome__path">
                  <span className="mono">
                    {source.displayName}.{source.schema}
                  </span>{" "}
                  →{" "}
                  <span className="mono">
                    {outcome.displayName}.{outcome.schema}
                  </span>
                </span>
                {/* Only for a target that was actually read. Swapping in one
                    that could not be reached, or that repeats another, gives a
                    source the next Compare cannot read either. No run=1: the
                    swap only fills the pickers, and the reader decides when to
                    run it. */}
                {outcome.report && (
                  <Link
                    href={orgPath(
                      `/compare?${selectionToQuery(swapSourceWithTarget(selection, outcome.index))}`
                    )}
                    className="btn btn-ghost btn-sm"
                    title="Make this target the source and the current source a target. Press Compare to run it."
                  >
                    Use as source
                  </Link>
                )}
              </div>

              {outcome.sameAsSource ? (
                <div className="warn-inline">
                  <span className="ico">
                    <AlertTriangleIcon size={14} />
                  </span>
                  <span>
                    {selection.targets[outcome.index]?.connectionId ===
                    selection.sourceConnectionId
                      ? "This target is the source itself, the same connection and schema ("
                      : "This target reaches the same database and schema as the source through a different saved connection ("}
                    <span className="mono">
                      {outcome.connectionDatabase ?? outcome.displayName} · {outcome.schema}
                    </span>
                    ). A schema always matches itself, so there is nothing to report
                    and nothing to migrate. Pick a different schema or connection for
                    this target, then press Compare.
                  </span>
                </div>
              ) : outcome.error ? (
                <div className="warn-inline">
                  <span className="ico">
                    <AlertTriangleIcon size={14} />
                  </span>
                  <span>{outcome.error}</span>
                </div>
              ) : outcome.report && diffDoc ? (
                <>

                  {/* Before the diff, because it can change what the diff MEANS:
                      if the target declares the higher version, the script on
                      the right would move it backwards. */}
                  <VersionDetectBar
                    sourceName={`${source.displayName}.${source.schema}`}
                    source={source.detectedVersion}
                    targetName={`${outcome.displayName}.${outcome.schema}`}
                    target={outcome.detectedVersion}
                    verdict={outcome.versionVerdict}
                    // The Workbench's own test for "nothing to push", so the bar
                    // never warns about a backwards push the button can't make.
                    inSync={outcome.statementCount === 0}
                    timeline={
                      <CompareVersionTimeline
                        key={runSerial}
                        left={{
                          label: "Source",
                          name: `${source.displayName}.${source.schema}`,
                          detected: source.detectedVersion,
                          connectionId: source.connectionId,
                          schema: source.schema,
                        }}
                        right={{
                          label: "Target",
                          name: `${outcome.displayName}.${outcome.schema}`,
                          detected: outcome.detectedVersion,
                          connectionId: outcome.connectionId,
                          schema: outcome.schema,
                        }}
                        verdict={outcome.versionVerdict}
                      />
                    }
                  />

                  {/* Between the version bar and the diff, because it is about
                      the same two schemas the diff is about, just across time
                      instead of across databases. Null on the first comparison
                      of a pair: see the note at the top of CompareHistory. */}
                  {outcome.history && <CompareHistory history={outcome.history} />}

                  {/* Two-column body: the changes (left) and the migration
                      draft (right, sticky). Stacks on narrow screens. */}
                  <div className="cp-grid">
                    <div className="cp-col">
                      {/* The four counts. Each one narrows the diff below to
                          that kind of change. The first three are the header's
                          own numbers; the fourth counts the tables that match. */}
                      {outcome.delta && (
                        <ChangeTiles
                          counts={{
                            add: outcome.delta.adds,
                            chg: outcome.delta.chgs,
                            rem: outcome.delta.rems,
                            same: outcome.report.matchedTables.filter(
                              (match) => !match.hasChanges,
                            ).length,
                          }}
                          active={filter}
                          onPick={(next) =>
                            setFilters((previous) => ({ ...previous, [outcome.index]: next }))
                          }
                        />
                      )}
                      {/* One document, three readers: the export writes it out,
                          CriticalChanges pulls the breaking rows out of it, and
                          both grade every change with the same functions the
                          canvas below grades them with. Building it twice would
                          let the panel and the file disagree about one change. */}
                      <ExportBar doc={diffDoc} />
                      {/* Above the board, because the board answers "what kind
                          of changes are there" and this answers "which of them
                          can hurt", and somebody who only reads one line of
                          this page should read that one. */}
                      <CriticalChanges doc={diffDoc} allowDataLoss={allowDataLoss} />
                      {/* The AI's read of the same rows, under the engine's own
                          list. It draws nothing without "Use AI assistance". */}
                      {diffDoc.changes.length > 0 && (
                        <CompareSummaryPanel
                          query={query}
                          target={outcome.index}
                          resetKey={`${query}|${outcome.index}|${runSerial}`}
                        />
                      )}
                      {/* Two big schemas with little in common are not searched
                          for renamed tables (lib/compare has a limit, or the
                          search takes minutes). Said here, or a reader who knows
                          a table was renamed sees a create and a drop for it and
                          takes the report to be wrong. */}
                      {renameMatchingSkipped(outcome.report) && (
                        <div className="role-note" role="note">
                          <span>
                            <b>Renamed tables were not looked for.</b> Too many
                            tables are in one schema only ({outcome.report.tablesOnlyInA.length}{" "}
                            in the source, {outcome.report.tablesOnlyInB.length} in
                            the target) to match them up in a reasonable time. A
                            table that was only renamed shows as one table to
                            create and one to drop.
                          </span>
                        </div>
                      )}
                      {/* The board first, then the narrative. The diff below
                          only shows what changed, so it cannot say "nothing
                          happened to your views". This can, and it is the
                          answer people scroll the whole page looking for. It
                          gets the same switch the two widgets below get:
                          without it the board said "dropped" over a script
                          that has every drop commented out. */}
                      <SummaryMatrix
                        report={outcome.report}
                        allowDataLoss={allowDataLoss}
                      />
                      <DiffReport
                        report={outcome.report}
                        allowDataLoss={allowDataLoss}
                        only={filter}
                      />
                      {outcome.data && (
                        <DataCompare
                          result={outcome.data}
                          allowDataLoss={allowDataLoss}
                          dataTables={dataTables}
                          formId={COMPARE_FORM_ID}
                        />
                      )}
                    </div>
                    <MigrationWorkbench
                      initialSql={outcome.sqlText}
                      statementCount={outcome.statementCount}
                      heldBackCount={outcome.heldBackCount}
                      manualCount={outcome.manualCount}
                      rollbackManualCount={outcome.rollbackManualCount}
                      initialRollbackSql={outcome.rollbackText}
                      rollbackStatementCount={outcome.rollbackStatementCount}
                      rollbackCounts={outcome.rollbackCounts}
                      rollbackWarnings={outcome.rollbackWarnings}
                      // Named after both ends, not just the schemas: with several
                      // targets on one page they are usually all called "public",
                      // and three drafts called sync_public_to_public would be
                      // impossible to tell apart in the registry or in review.
                      suggestedName={`sync_${outcome.report.right.database}_${outcome.report.right.schema}_from_${outcome.report.left.database}_${outcome.report.left.schema}`
                        .replace(/[^a-z0-9_]/gi, "_")
                        .toLowerCase()}
                      suggestedDescription={`Sync ${outcome.report.right.database}.${outcome.report.right.schema} to match ${outcome.report.left.database}.${outcome.report.left.schema}`}
                      targetLabel={`${outcome.report.right.database}.${outcome.report.right.schema}`}
                      targetSchema={outcome.report.right.schema}
                      targetDatabase={
                        outcome.connectionDatabase ?? outcome.report.right.database
                      }
                      suggestedKind={outcome.overallKind}
                      counts={outcome.counts}
                      warnings={outcome.warnings}
                      // The Workbench reads the versions applied to this target
                      // through the saved connection, so it can show the same
                      // next version the Script Editor shows. Null when the
                      // target has no saved connection: then only GitHub counts.
                      targetConnectionId={outcome.connectionId}
                      // The backwards warning above, repeated next to the Push
                      // button with the same names, so the two never disagree.
                      versionVerdict={outcome.versionVerdict}
                      sourceVersion={source.detectedVersion}
                      targetVersion={outcome.detectedVersion}
                      sourceName={`${source.displayName}.${source.schema}`}
                      targetName={`${outcome.displayName}.${outcome.schema}`}
                      swapHref={screen.swapHref}
                    />
                  </div>
                </>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
