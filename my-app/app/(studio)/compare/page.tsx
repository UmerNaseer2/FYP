"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { isProduction, toEnvironment, type Environment } from "@/lib/environments";
import {
  pickSchemaAfterConnectionChange,
  selectionToQuery,
  swapSourceWithTarget,
} from "@/lib/compare-selection";
import { buildDiffDocument } from "@/lib/compare-export";
import type {
  CompareScreen,
  ConnectionView,
  OutcomeView,
} from "@/lib/compare-run";
import { DiffReport } from "@/components/studio/DiffReport";
import { ExportBar } from "@/components/studio/ExportBar";
import { SummaryMatrix } from "@/components/studio/SummaryMatrix";
import { DataCompare } from "@/components/studio/DataCompare";
import { MigrationWorkbench } from "@/components/studio/MigrationWorkbench";
import { VersionDetectBar } from "@/components/studio/VersionDetectBar";
import { ComparisonSetBar } from "@/components/studio/ComparisonSetBar";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Select } from "@/components/ui/Select";
import { EnvironmentPill } from "@/components/ui/EnvironmentPill";
import {
  CompareIcon,
  AlertTriangleIcon,
  ConnectionsIcon,
  PlusIcon,
  XIcon,
} from "@/components/ui/icons";

// ---------------------------------------------------------------------------
// Compare & Author.
//
// The screen only draws. Every connection, snapshot and diff on it is computed
// by POST /api/compare, which is the only thing here that touches a database —
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
 * `targetSchema`, so the browser submits them as two parallel lists — that is
 * what makes "add another target" work with a plain <form>.
 *
 * Changing the connection fetches that database's schemas straight away. The
 * schema box used to keep offering the OLD connection's list until Compare was
 * pressed, so the usual move — dev.public to staging.public — took two
 * submits, and the first one compared a schema the new database might not have.
 */
function SlotPicker({
  role,
  fieldPrefix,
  slotKey,
  connections,
  selectedConnectionId,
  schemaOptions,
  selectedSchema,
  environment,
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
  environment: Environment;
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
      const response = await fetch(
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

  const picked = connections.find((connection) => String(connection.id) === connectionId);
  // The server's answer until somebody picks another connection; after that
  // the picked connection's own label, because the server has not seen it yet.
  const shownEnvironment =
    connectionId === selectedConnectionId || !picked
      ? environment
      : toEnvironment(picked.environment);
  // A schema the list does not contain — typed into a URL, or kept after a
  // listing failed — still shows, so the box never looks empty while it
  // would submit something.
  const schemaChoices = options.length > 0 ? options : schema.length > 0 ? [schema] : [];

  return (
    <div className="picker">
      {/* The pill is two letters of jargon. A title alone reaches neither a
          screen reader nor a touch device, so the name goes on the element. */}
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
            {role}
          </span>
          <EnvironmentPill environment={shownEnvironment} />
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
          <span className="text-[11.5px]" role="alert" style={{ color: "var(--drift)" }}>
            {listError}
          </span>
        ) : missingMessage && connectionId === selectedConnectionId ? (
          <span className="text-[11.5px]" style={{ color: "var(--drift)" }}>
            {missingMessage}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function PageHeader({ targetCount }: { targetCount: number }) {
  return (
    <div className="mb-4">
      <div className="section-title mb-2">Compare &amp; Author</div>
      <h1 className="text-[28px] font-semibold tracking-[-0.018em]">
        Turn a diff into editable SQL.
      </h1>
      <p className="text-[13.5px] mt-1.5 max-w-[64ch]" style={{ color: "var(--text-2)" }}>
        Pick one <b>source</b> schema and compare it against{" "}
        {targetCount === 1 ? "a target." : `${targetCount} targets at once.`} Each
        target gets its own diff and its own migration, and every generated script
        updates <b>that target</b> to match the source — you can edit it freely
        before saving.
      </p>
      {targetCount > 1 && (
        <p className="text-[12.5px] mt-1 max-w-[64ch]" style={{ color: "var(--text-3)" }}>
          Each target is compared with the source only — targets are not compared
          with each other. To compare two targets, press <b>Use as source</b> on
          one of their results.
        </p>
      )}
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
  const sameAsSource = outcomes.filter((o) => o.sameAsSource).length;
  const production = outcomes.filter((o) => isProduction(o.environment)).length;

  return (
    <div className="compare-header flex items-center gap-2 flex-wrap mt-6">
      <h2 className="section-title m-0">Results</h2>
      <span className="text-[13px]" style={{ color: "var(--text-2)" }}>
        <b>{outcomes.length}</b> target{outcomes.length === 1 ? "" : "s"}
      </span>
      <span style={{ width: 1, height: 18, background: "var(--border)" }} className="mx-1" />
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
      {/* Not failures — nothing was dialled because the answer was known. */}
      {sameAsSource > 0 && (
        <span className="pill pill-neutral">{sameAsSource} same as source</span>
      )}
      {duplicates > 0 && (
        <span className="pill pill-neutral">
          {duplicates} duplicate{duplicates === 1 ? "" : "s"}
        </span>
      )}
      {production > 0 && (
        <span className="pill pill-break">
          {production} production
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
 * under a Suspense boundary — without one the build fails rather than the page.
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
 * Shaped like the real screen — picker bar, then one diff panel — so the page
 * does not jump when the answer arrives.
 */
function LoadingScreen() {
  return (
    <div className="px-4 sm:px-8 py-6 sm:py-8">
      <PageHeader targetCount={1} />
      <div className="source-bar">
        <div className="source-bar__group">
          <Skeleton width={180} height={11} />
          <Skeleton height={64} radius={10} className="mt-2" />
        </div>
        <div className="source-bar__group">
          <Skeleton width={220} height={11} />
          <Skeleton height={64} radius={10} className="mt-2" />
        </div>
      </div>
      <div className="mt-6 space-y-3">
        <Skeleton width={260} height={18} />
        <Skeleton height={200} radius={10} />
      </div>
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
  const [screen, setScreen] = useState<CompareScreen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // `record` asks the server to stamp the open saved set's "last run" time. It
  // goes once per URL that carries `run=1` — Compare, opening a set, or a link
  // that asks to run — and not on the reload after Save, which would count the
  // same run twice. The ref remembers which URL has been stamped.
  const recorded = useRef<string | null>(null);

  // The two run options are the only fields in the picker bar that change what
  // the diff SAYS rather than which schemas it reads, and this is a plain GET
  // form: ticking a box changes nothing until Compare is pressed. The report
  // below meanwhile says "Untick Allow data loss to hold it back", so a reader
  // who did exactly that watched the page keep insisting the drop was armed.
  //
  // null means "not touched since this comparison ran", which is not the same
  // as false — the value that produced what is on screen can come from a saved
  // set rather than from the query string, so it is read off `screen` and not
  // re-derived here. Pressing Compare submits the form, which changes the
  // query, which remounts this component with a fresh key — so these go back
  // to null on their own and there is nothing to reset.
  const [pendingDataLoss, setPendingDataLoss] = useState<boolean | null>(null);
  const [pendingRowData, setPendingRowData] = useState<boolean | null>(null);

  // The same idea for the pickers: which of them now differ from what the
  // comparison on screen used. Keyed by picker, because one picker going back
  // to clean must not hide another that is still changed.
  const [dirtyPickers, setDirtyPickers] = useState<Record<string, boolean>>({});
  const reportDirty = useCallback((slotKey: string, dirty: boolean) => {
    setDirtyPickers((previous) =>
      Boolean(previous[slotKey]) === dirty ? previous : { ...previous, [slotKey]: dirty },
    );
  }, []);

  // One run of the comparison. Everything it needs is in the query string, so
  // it is sent verbatim and the server decides what it means — two places
  // parsing "?targetConnection=3&targetConnection=7" would eventually disagree.
  const load = useCallback(async () => {
    const record =
      new URLSearchParams(query).get("run") === "1" && recorded.current !== query;
    if (record) recorded.current = query;

    setLoading(true);
    try {
      const response = await fetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, record }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data) {
        setScreen(data as CompareScreen);
        setError(null);
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

  // A comparison that never arrived at all — there is nothing else to draw.
  if (error && !screen) {
    return (
      <div className="px-4 sm:px-8 py-6 sm:py-8">
        <PageHeader targetCount={1} />
        <div className="warn-inline">
          <span className="ico">
            <AlertTriangleIcon size={14} />
          </span>
          <span>{error}</span>
        </div>
      </div>
    );
  }

  // Nothing rendered yet — the first run is still going.
  if (!screen) return <LoadingScreen />;

  // Nothing to compare with: point at Connections rather than rendering an
  // empty form that cannot do anything.
  if (screen.kind === "no-connections") {
    return (
      <EmptyState
        icon={<CompareIcon size={22} />}
        title="Add a connection to compare"
        description={
          <>
            {/*
              This used to say "at least two connections", but the branch it
              sits in fires on ZERO — and one connection is genuinely enough,
              because the two sides of a comparison are two SCHEMAS and both
              can live on the same server. Asking for a second one sent people
              off to invent a connection they did not need.
            */}
            Comparing reads two schemas through your saved PostgreSQL
            connections. One is enough to start — the two sides can be two
            schemas on the same server.
          </>
        }
        actions={
          <Link href="/connections" className="btn btn-primary btn-sm">
            <ConnectionsIcon size={14} />
            Go to Connections
          </Link>
        }
      />
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
    setModified,
    selection,
    sourceError,
    allowDataLoss,
    compareData,
    asked,
  } = screen;

  const productionTargets = outcomes.filter((outcome) =>
    isProduction(outcome.environment),
  );

  // What the boxes show, versus what the comparison on screen was actually run
  // with. They differ only while a tick is waiting for the next Compare.
  const dataLossBox = pendingDataLoss ?? allowDataLoss;
  const rowDataBox = pendingRowData ?? compareData;
  const optionsPending = dataLossBox !== allowDataLoss || rowDataBox !== compareData;
  const picksChanged = Object.values(dirtyPickers).some(Boolean);
  const unapplied = optionsPending || picksChanged;

  return (
    <div
      className="px-4 sm:px-8 py-6 sm:py-8"
      // A re-run keeps the current comparison on screen and fades it, rather
      // than dropping back to the skeleton — the numbers below are still the
      // last true answer until the new one lands. The dim on its own said none
      // of that, so the strip under the form says it in words too.
      aria-busy={loading}
      style={loading ? { opacity: 0.55, transition: "opacity 120ms" } : undefined}
    >
      <PageHeader targetCount={resolvedTargets.length} />

      {/* A re-run that failed. The comparison below is the previous one, so it
          stays — but it is no longer what the screen was asked for. */}
      {error && (
        <div className="warn-inline mb-4">
          <span className="ico">
            <AlertTriangleIcon size={14} />
          </span>
          <span>{error}</span>
        </div>
      )}

      {/* Saved sets sit above the pickers because they change what the pickers
          show. Its own island, not part of the form below — saving writes to
          the database, and this page's form is a GET that has to stay safe to
          reload and share. */}
      <ComparisonSetBar
        sets={setOptions}
        activeSetId={activeSetId}
        modified={setModified}
        selection={selection}
        hasUnappliedChanges={unapplied}
        asked={asked}
        onDone={() => void load()}
      />

      {/* Selection — plain form-GET. The target pickers repeat one pair of field
          names, so the browser submits them as parallel lists and "add target"
          needs no client state at all. */}
      <form action="/compare" className="source-bar">
        {/* Only the Compare button sends run=1 — Add target and Remove change
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

        <div className="source-bar__group">
          <div className="source-bar__label">Source · the schema you want</div>
          <div className="source-bar__slot">
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
              environment={source.environment}
              missingMessage={source.missingMessage}
              onDirtyChange={reportDirty}
            />
          </div>
        </div>

        <div className="source-bar__group">
          <div className="source-bar__label">
            {resolvedTargets.length === 1
              ? "Target · the schema that gets updated"
              : `${resolvedTargets.length} targets · each gets its own migration`}
          </div>
          <div className="source-bar__grid">
            {resolvedTargets.map((slot, index) => (
              <div className="source-bar__slot" key={`target-${index}`}>
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
                  environment={slot.environment}
                  missingMessage={slot.missingMessage}
                  onDirtyChange={reportDirty}
                />
                {resolvedTargets.length > 1 && (
                  <button
                    type="submit"
                    name="removeTarget"
                    value={String(index)}
                    className="btn btn-ghost btn-icon self-start"
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

        <div className="source-bar__actions">
          {canAddTarget ? (
            <button type="submit" name="addTarget" value="1" className="btn btn-ghost btn-sm">
              <PlusIcon size={14} />
              Add target
            </button>
          ) : (
            <span className="text-[12px]" style={{ color: "var(--text-3)" }}>
              {maxTargets} targets is the maximum for one comparison.
            </span>
          )}
          {/* These two decide whether the generated script destroys data and
              whether the run reads table contents at all, and a hover tooltip
              was the only place either of them said so — no use on a touch
              screen, and nothing a screen reader announces. */}
          <label
            className="flex items-start gap-2 text-[12.5px] cursor-pointer"
            style={{ color: "var(--text-2)" }}
          >
            <input
              type="checkbox"
              name="allowDataLoss"
              value="1"
              className="mt-[3px]"
              checked={dataLossBox}
              onChange={(e) => setPendingDataLoss(e.target.checked)}
            />
            <span className="flex flex-col">
              Allow data loss
              <span
                className="text-[11.5px] max-w-[34ch]"
                style={{ color: "var(--text-3)" }}
              >
                Off, DROP TABLE, DROP COLUMN and any materialized view rebuild
                that has to drop the view first are written into the script but
                commented out. Takes effect on the next Compare.
              </span>
            </span>
          </label>
          <label
            className="flex items-start gap-2 text-[12.5px] cursor-pointer"
            style={{ color: "var(--text-2)" }}
          >
            <input
              type="checkbox"
              name="compareData"
              value="1"
              className="mt-[3px]"
              checked={rowDataBox}
              onChange={(e) => setPendingRowData(e.target.checked)}
            />
            <span className="flex flex-col">
              Compare row data
              <span
                className="text-[11.5px] max-w-[34ch]"
                style={{ color: "var(--text-3)" }}
              >
                Reads the rows of every table and reports which ones differ, not
                just the catalog — much slower on big tables. Takes effect on the
                next Compare.
              </span>
            </span>
          </label>
          <span className="source-bar__spacer" />
          {/* Said beside the button that applies it, because this is the moment
              the reader is deciding whether anything more is needed. */}
          {unapplied && (
            <span
              className="text-[12px] flex items-center gap-1.5"
              style={{ color: "var(--drift)" }}
            >
              <AlertTriangleIcon size={13} />
              Not applied yet — press Compare.
            </span>
          )}
          <button type="submit" name="run" value="1" className="btn btn-primary">
            <CompareIcon size={14} />
            Compare
          </button>
        </div>
      </form>

      {/* A re-run leaves the previous diff on screen at 55% opacity, and a dim
          page is not a message — plenty of readers took it for the current
          answer being greyed out. This cannot appear on a first load, where
          `screen` is still null and the skeleton renders instead. */}
      {loading && (
        <div className="warn-inline mt-3">
          <span className="ico">
            <AlertTriangleIcon size={14} />
          </span>
          <span>
            Re-running the comparison against the live databases — the diff below
            is the previous result.
          </span>
        </div>
      )}

      {/* A migration generated for a pair nobody chose reads as a
          recommendation, so a screen nobody asked to run says so and stops. */}
      {/* A link to a saved set that has since been deleted. Said whether or
          not anything ran, because the bar above now shows no set open and
          would otherwise leave the reader wondering where it went. */}
      {setNotFound && (
        <div className="warn-inline mt-4">
          <span className="ico">
            <AlertTriangleIcon size={14} />
          </span>
          <span>
            That saved set no longer exists — it may have been deleted.
            {asked
              ? " The comparison below is the one in the pickers."
              : " The pickers show the defaults instead; pick what to compare, then press Compare."}
          </span>
        </div>
      )}

      {(!asked || source.missingMessage) && (
        <div className="panel mt-6 p-4">
          <h2 className="section-title m-0">Nothing compared yet</h2>
          <p className="text-[13px] mt-1.5" style={{ color: "var(--text-2)" }}>
            {source.missingMessage
              ? "The source has no connection, so there is nothing to compare the targets with. Pick a source connection above, then press Compare."
              : "Nothing has been read from the databases yet. Press Compare to read the schemas picked above and generate each target's migration."}
          </p>
        </div>
      )}

      {/* A production target is worth saying once at the top, before the reader
          scrolls into a workbench with a "push to registry" button in it. */}
      {productionTargets.length > 0 && (
        <div className="warn-inline mt-4">
          <span className="ico">
            <AlertTriangleIcon size={14} />
          </span>
          <span>
            <b>
              {productionTargets.length === 1
                ? "One target is production"
                : `${productionTargets.length} targets are production`}
              :
            </b>{" "}
            {productionTargets
              .map((outcome) => `${outcome.displayName}.${outcome.schema}`)
              .join(", ")}
            . Read the generated SQL before you push it — once it runs on
            production, a dropped column comes back only from a point-in-time
            restore of the database, not from this app.
          </span>
        </div>
      )}

      {/* A source we cannot read blocks every target, so it is reported once. */}
      {sourceError && (
        <div className="warn-inline mt-4" style={{ flexDirection: "column", gap: 6 }}>
          <div className="flex items-center gap-2">
            <span className="ico">
              <AlertTriangleIcon size={14} />
            </span>
            <b>Unable to read the source schema</b>
          </div>
          <p className="text-[12.5px]" style={{ color: "var(--text-2)", paddingLeft: 22 }}>
            {sourceError}
          </p>
        </div>
      )}

      {outcomes.length > 1 && <RunSummary outcomes={outcomes} />}

      {outcomes.map((outcome) => (
        <section key={`outcome-${outcome.index}`} className="mt-6">
          {/* Per-target header: what is being compared, and how much differs. */}
          <div className="compare-header flex items-center gap-2 flex-wrap mb-3">
            {/* A heading rather than a span: with several targets this is the
                only way to jump between their sections. */}
            <h2 className="section-title m-0">
              {outcomes.length === 1 ? "Diff" : `Target ${outcome.index + 1}`}
            </h2>
            <EnvironmentPill environment={outcome.environment} />
            {outcome.delta ? (
              <>
                <span className="text-[13px]" style={{ color: "var(--text-2)" }}>
                  <b>{outcome.delta.total}</b> change
                  {outcome.delta.total === 1 ? "" : "s"} ·{" "}
                  <b>
                    {outcome.delta.tablesTouched} table
                    {outcome.delta.tablesTouched === 1 ? "" : "s"}
                  </b>
                </span>
                <span
                  style={{ width: 1, height: 18, background: "var(--border)" }}
                  className="mx-1"
                />
                <span
                  className="delta delta-add"
                  style={outcome.delta.adds ? undefined : { opacity: 0.5 }}
                >
                  + {outcome.delta.adds}
                </span>
                <span
                  className="delta delta-chg"
                  style={outcome.delta.chgs ? undefined : { opacity: 0.5 }}
                >
                  ~ {outcome.delta.chgs}
                </span>
                <span
                  className="delta delta-rem"
                  style={outcome.delta.rems ? undefined : { opacity: 0.5 }}
                >
                  − {outcome.delta.rems}
                </span>
              </>
            ) : null}
            <span className="ml-auto text-[12px]" style={{ color: "var(--text-3)" }}>
              <span className="mono">
                {source.displayName}.{source.schema}
              </span>{" "}
              →{" "}
              <span className="mono">
                {outcome.displayName}.{outcome.schema}
              </span>
            </span>
            {/* Only for a target that was actually read — swapping in one that
                could not be reached, or that repeats another, gives a source
                the next Compare cannot read either. No run=1: the swap only
                fills the pickers, and the reader decides when to run it. */}
            {outcome.report && (
              <Link
                href={`/compare?${selectionToQuery(swapSourceWithTarget(selection, outcome.index))}`}
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
                  ? "This target is the source itself — the same connection and schema ("
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
          ) : outcome.report ? (
            <>
              {isProduction(outcome.environment) && (
                <div className="warn-inline mb-3">
                  <span className="ico">
                    <AlertTriangleIcon size={14} />
                  </span>
                  {/* Nothing on /compare can reach the target database — the
                      only mutating request here is the push to the GitHub
                      registry. Saying "rewrites production" put the alarm one
                      screen too early and made the real one, on Deploy, look
                      like a repeat. */}
                  <span>
                    <b>This target is production.</b> Nothing on this screen
                    touches it — Push to GitHub writes the SQL to the registry.
                    Someone still has to run it from Deploy, and when they do it
                    rewrites{" "}
                    <span className="mono">
                      {outcome.displayName}.{outcome.schema}
                    </span>
                    {outcome.counts.breaking > 0
                      ? ` with ${outcome.counts.breaking} breaking statement${
                          outcome.counts.breaking === 1 ? "" : "s"
                        }.`
                      : "."}
                  </span>
                </div>
              )}

              {/* Before the diff, because it can change what the diff MEANS: if
                  the target declares the higher version, the script on the right
                  would move it backwards. */}
              <VersionDetectBar
                sourceName={`${source.displayName}.${source.schema}`}
                source={source.detectedVersion}
                targetName={`${outcome.displayName}.${outcome.schema}`}
                target={outcome.detectedVersion}
                verdict={outcome.versionVerdict}
              />

              {/* Two-column body: diff canvas (left) + migration draft (right,
                  sticky). Stacks under 980px via the .compare-layout rule. */}
              <div className="compare-layout">
                <div className="space-y-3">
                  {/* Built on the server: the export has to grade every change
                      with the same functions the canvas below grades them
                      with, and those live in the compare engine. */}
                  <ExportBar doc={buildDiffDocument(outcome.report, outcome.data)} />
                  {/* The board first, then the narrative. The diff below only
                      shows what changed, so it cannot say "nothing happened to
                      your views" — this can, and it is the answer people scroll
                      the whole page looking for. */}
                  {/* Same switch the two widgets below get — without it the
                      board said "dropped" over a script that has every drop
                      commented out. */}
                  <SummaryMatrix
                    report={outcome.report}
                    allowDataLoss={allowDataLoss}
                  />
                  <DiffReport report={outcome.report} allowDataLoss={allowDataLoss} />
                  {outcome.data && (
                    <DataCompare
                      result={outcome.data}
                      allowDataLoss={allowDataLoss}
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
                  targetVersions={outcome.targetVersions}
                />
              </div>
            </>
          ) : null}
        </section>
      ))}
    </div>
  );
}
