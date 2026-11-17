"use client";

import "@/app/styles/atelier-dashboard.css";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { AskAdmin } from "@/components/studio/AskAdmin";
import {
  Button,
  Pill,
  Card,
  Skeleton,
  Drawer,
  ConfirmDialog,
  Label,
  Input,
} from "@/components/ui";
import { Select } from "@/components/ui/Select";
import { HelpHint } from "@/components/ui/HelpHint";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { SetupChecklist, type SetupStep } from "@/components/ui/SetupChecklist";
import { StatusChip, StatusGlyph, StatusGlyphPaths } from "@/components/ui/StatusChip";
import { PageHeader } from "@/components/studio/PageHeader";
import { useDriftCheckRefusal } from "@/components/studio/RecheckDriftButton";
import { useNow } from "@/hooks/useNow";
import { useOrg, useOrgHref } from "@/hooks/useOrg";
import { useUser } from "@/hooks/useUser";
import { refusalMessage, refusalMessageForAll, type PermissionKey } from "@/lib/roles/permissions";
import { STATUS_ORDER, statusLook, type StatusKey } from "@/lib/ui/status-look";
import { displayVersion } from "@/lib/versions/timeline";
import { CheckIcon, AlertCircleIcon, RefreshIcon, PlusIcon, InfoIcon } from "@/components/ui/icons";
import { apiFetch } from "@/lib/ui/api-fetch";
import { statusLine } from "./status-line";

/**
 * Dashboard: "The Skyline".
 *
 * Every tracked schema (GET /api/lineage) is drawn as one building in a small
 * city. The roof says what the last drift check found, with a colour and a
 * glyph from the one status system (lib/ui/status-look), and the height is a real
 * number about the schema: how many versions it has recorded, or how many
 * tables its latest recorded version had. Press a building to read about it
 * and to act on it. Drifted schemas stand at the front. Real data only.
 *
 * Above the city sits "Getting started": four steps for a new organization.
 * It goes away once every step is done, or when somebody presses Hide.
 *
 * Tracking, checking and untracking each have their own box on the Roles tab
 * (Drift tracking: Create, Run and Delete). A button the role may not use
 * stays on screen but off, and the page says why once, under the header.
 */

// ── Types: mirror of GET /api/lineage (TrackedSchemaListItem) ───────────────
type DriftStatus = "in_sync" | "drifted" | "unreachable";

type TrackedSchema = {
  id: number;
  connectionId: number;
  schemaName: string;
  label: string | null;
  createdAt: string;
  connectionName: string | null;
  connectionHost: string | null;
  connectionDatabase: string | null;
  headVersion: string | null;
  headSeq: number | null;
  migrationCount: number;
  driftStatus: DriftStatus | null;
  driftSummary: string | null;
  driftCheckedAt: string | null;
  // How often this schema is checked on its own, in minutes; 0 is manual only.
  driftIntervalMinutes?: number;
  // When a check last RAN. A scheduled check that changes nothing records no
  // event, so driftCheckedAt (the last recorded RESULT) can be much older.
  lastCheckedAt?: string | null;
};

/** A saved connection as GET /api/connections returns it (only fields we use). */
type ConnectionRow = {
  id: number;
  name: string;
  host: string;
  database_name: string;
  type: string;
};

/** What a building's height stands for. */
type HeightBy = "versions" | "tables";

/** Where the saved-connections fetch has got to. */
type ConnPhase = { kind: "idle" } | { kind: "loading" } | { kind: "ready" } | { kind: "error" };

// ── Small pure helpers ───────────────────────────────────────────────────────

/** Read a yes/no note this browser keeps. Private windows can refuse, so it never throws. */
function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** Keep a yes/no note in this browser. Quietly does nothing when it is refused. */
function writeFlag(key: string) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Nothing to do: the note is a convenience, not something the page needs.
  }
}

/** "1 schema is tracked", "4 schemas are tracked". */
function countPhrase(count: number, one: string, many: string, verb: string): string {
  return count === 1 ? `1 ${one} is ${verb}` : `${count} ${many} are ${verb}`;
}

/** Drifted first (hero), then unreachable, then never-checked, then in-sync. */
function sortPriority(status: DriftStatus | null): number {
  switch (status) {
    case "drifted":
      return 0;
    case "unreachable":
      return 1;
    case "in_sync":
      return 3;
    default:
      return 2; // null, tracked but never drift-checked
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const orgPath = useOrgHref();
  // What this role may do here, one box per write.
  const { roleLabel, loading: sessionLoading, can } = useUser();
  const orgSlug = useOrg()?.slug ?? "";
  const trackRefusal =
    sessionLoading || can("drift:create") ? null : refusalMessage(roleLabel, "drift:create");
  const checkRefusal = useDriftCheckRefusal();
  const untrackRefusal =
    sessionLoading || can("drift:delete") ? null : refusalMessage(roleLabel, "drift:delete");

  // The tracked-schema list (the grid + summary strip read from this).
  const [items, setItems] = useState<TrackedSchema[]>([]);
  const [listPhase, setListPhase] = useState<"loading" | "ready" | "error">("loading");
  const [checkingId, setCheckingId] = useState<number | null>(null);
  // What went wrong on the picked card, and whether a new check could fix it.
  const [cardError, setCardError] = useState<{
    id: number;
    msg: string;
    from: "check" | "untrack";
  } | null>(null);
  // The building whose details are on screen. Null means the first one.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [heightBy, setHeightBy] = useState<HeightBy>("versions");
  // Tables in each schema's latest recorded version, by tracked schema id.
  // Missing means not read yet; null means the read failed.
  const [tableCounts, setTableCounts] = useState<Record<number, number | null>>({});
  // Which schemas we have already asked about, so each is asked once.
  const askedTables = useRef(new Set<number>());

  // Track-a-schema drawer.
  const [trackOpen, setTrackOpen] = useState(false);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  // Every saved connection, whatever its type. Getting started counts them.
  const [savedConnections, setSavedConnections] = useState<{ name: string }[]>([]);
  const [connPhase, setConnPhase] = useState<ConnPhase>({ kind: "idle" });
  const [trackConnId, setTrackConnId] = useState("");
  const [schemaOptions, setSchemaOptions] = useState<string[]>([]);
  const [schemaPhase, setSchemaPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [schemaError, setSchemaError] = useState<string | null>(null);
  // Which schema-list request is the current one. Picking a second connection
  // while the first is still loading used to let the SLOWER answer land last
  // and overwrite the newer list, so the box offered schemas that live on a
  // connection nobody had selected any more, and tracking one of them failed
  // with "schema not found" naming a schema this screen had just offered.
  // Same guard the compare screen's slot pickers take.
  const latestSchemaRequest = useRef(0);
  const [trackSchema, setTrackSchema] = useState("");
  const [trackLabel, setTrackLabel] = useState("");
  const [trackSubmitting, setTrackSubmitting] = useState(false);
  const [trackError, setTrackError] = useState<string | null>(null);

  // Untrack confirm. No "removing" flag, ConfirmDialog closes on confirm, so
  // a busy label on its button could never be seen.
  const [untrackTarget, setUntrackTarget] = useState<TrackedSchema | null>(null);

  // ── Load the list ──────────────────────────────────────────────────────────
  const loadList = useCallback(async () => {
    setListPhase("loading");
    try {
      const res = await apiFetch("/api/lineage", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      // The route answers with an error object, not a list, when it cannot read
      // the database. Checking the status matters more than the shape: an empty
      // dashboard has to mean "you track nothing", never "the query failed".
      if (!res.ok || !Array.isArray(data)) {
        setItems([]);
        setListPhase("error");
        return;
      }
      setItems(data);
      setListPhase("ready");
    } catch {
      setItems([]);
      setListPhase("error");
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // ── Read the table counts ──────────────────────────────────────────────────
  // Only once somebody picks "Tables" as the height. The list does not carry
  // the number, so each schema's own details are read (GET /api/lineage/[id])
  // and the newest version's snapshot says how many tables it had.
  useEffect(() => {
    if (heightBy !== "tables") return;

    async function readTableCount(id: number) {
      let count: number | null = null;
      try {
        const res = await apiFetch(`/api/lineage/${id}`, { cache: "no-store" });
        const data = res.ok ? await res.json() : null;
        const tables = data?.migrations?.[0]?.snapshot?.tableCount;
        if (typeof tables === "number") count = tables;
      } catch {
        count = null;
      }
      setTableCounts((previous) => ({ ...previous, [id]: count }));
    }

    for (const item of items) {
      if (askedTables.current.has(item.id)) continue;
      askedTables.current.add(item.id);
      void readTableCount(item.id);
    }
  }, [heightBy, items]);

  // ── Load the saved connections ─────────────────────────────────────────────
  // On mount as well as on every drawer open: the dashboard has to know whether
  // tracking is even possible before it offers "Track a schema" as the only
  // thing a first-time user can press.
  const loadConnections = useCallback(async () => {
    setConnPhase({ kind: "loading" });
    try {
      const res = await apiFetch("/api/connections", { cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      if (!Array.isArray(data)) {
        setConnections([]);
        setSavedConnections([]);
        setConnPhase({ kind: "error" });
        return;
      }
      setSavedConnections(data);
      setConnections(data.filter((c: ConnectionRow) => c.type === "PostgreSQL"));
      setConnPhase({ kind: "ready" });
    } catch {
      setConnections([]);
      setSavedConnections([]);
      setConnPhase({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  // ── Getting started ────────────────────────────────────────────────────────
  // Two of the four steps are about things this page does not load anyway, so
  // they are asked for here: has anybody compared (a saved comparison set, or
  // the note the Compare page leaves in this browser), and is GitHub set up
  // (GET /api/admin/github, for roles that may see it). Both fail quietly: a
  // step we cannot read just stays "to do".
  const hideKey = `schema-studio:setup-hidden:${orgSlug}`;
  const comparedKey = `schema-studio:first-compare:${orgSlug}`;
  const maySeeSets = !sessionLoading && can("comparison_sets:read");
  const maySeeGitHub = !sessionLoading && can("github:read");
  // Null until this browser's note has been read, so the list never flashes.
  const [setupHidden, setSetupHidden] = useState<boolean | null>(null);
  // Null until the two reads have finished.
  const [setupFacts, setSetupFacts] = useState<{
    compared: boolean;
    github: "done" | "todo" | "unknown";
  } | null>(null);

  useEffect(() => {
    if (sessionLoading) return;
    let stale = false;

    async function readSetup() {
      const hidden = readFlag(hideKey);
      if (!stale) setSetupHidden(hidden);
      if (hidden) return;

      let compared = readFlag(comparedKey);
      if (!compared && maySeeSets) {
        try {
          const res = await apiFetch("/api/comparison-sets", { cache: "no-store" });
          const data = res.ok ? await res.json() : null;
          compared = Array.isArray(data?.sets) && data.sets.length > 0;
        } catch {
          compared = false;
        }
      }

      let github: "done" | "todo" | "unknown" = "unknown";
      if (maySeeGitHub) {
        try {
          const res = await apiFetch("/api/admin/github", { cache: "no-store" });
          const data = res.ok ? await res.json() : null;
          if (data && typeof data.source === "string") {
            github = data.source !== "none" && !data.tokenUnreadable ? "done" : "todo";
          }
        } catch {
          github = "unknown";
        }
      }

      if (!stale) setSetupFacts({ compared, github });
    }

    void readSetup();
    return () => {
      stale = true;
    };
  }, [sessionLoading, hideKey, comparedKey, maySeeSets, maySeeGitHub]);

  function hideSetup() {
    writeFlag(hideKey);
    setSetupHidden(true);
  }

  // ── Track flow ─────────────────────────────────────────────────────────────
  function resetTrackForm() {
    setTrackConnId("");
    setSchemaOptions([]);
    setSchemaPhase("idle");
    setSchemaError(null);
    setTrackSchema("");
    setTrackLabel("");
    setTrackError(null);
  }

  function openTrack() {
    // The buttons that open it are off already.
    if (trackRefusal !== null) return;
    resetTrackForm();
    setTrackOpen(true);
    // Pull the connection list fresh each time the drawer opens, one may have
    // been saved on the Connections page since this dashboard loaded. It also
    // clears a previous failure, so reopening the drawer is the retry.
    void loadConnections();
  }

  async function onPickConnection(id: string) {
    setTrackConnId(id);
    setTrackSchema("");
    setSchemaOptions([]);
    setSchemaError(null);
    setTrackError(null);
    // Claimed BEFORE the empty-id exit, not after. Clearing the picker is also
    // a newer answer than a request still in flight: leaving the counter alone
    // here let that older request land and fill the box for a connection that
    // is no longer selected at all.
    const request = ++latestSchemaRequest.current;
    if (!id) {
      setSchemaPhase("idle");
      return;
    }
    setSchemaPhase("loading");
    try {
      const res = await apiFetch(`/api/lineage/schemas?connectionId=${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      const data = await res.json();
      // Every exit below is guarded, not just the success one: a stale ERROR
      // would paint a working connection as broken just as wrongly as a stale
      // list paints it with the wrong schemas.
      if (request !== latestSchemaRequest.current) return;
      if (!res.ok) {
        setSchemaError(data.error ?? "Could not list schemas for this connection.");
        setSchemaPhase("error");
        return;
      }
      setSchemaOptions(Array.isArray(data.schemas) ? data.schemas : []);
      setSchemaPhase("ready");
    } catch {
      if (request !== latestSchemaRequest.current) return;
      setSchemaError("Network error while listing schemas.");
      setSchemaPhase("error");
    }
  }

  async function submitTrack() {
    if (!trackConnId || !trackSchema || trackRefusal !== null) return;
    setTrackSubmitting(true);
    setTrackError(null);
    try {
      const res = await apiFetch("/api/lineage/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(trackConnId),
          schemaName: trackSchema,
          label: trackLabel.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTrackError(data.error ?? "Could not track this schema.");
        return;
      }
      setTrackOpen(false);
      await loadList();
    } catch {
      setTrackError("Network error while tracking the schema.");
    } finally {
      setTrackSubmitting(false);
    }
  }

  // ── Actions on the picked schema ───────────────────────────────────────────────────────
  async function checkDrift(item: TrackedSchema) {
    if (checkRefusal !== null) return;
    setCheckingId(item.id);
    setCardError(null);
    try {
      const res = await apiFetch("/api/lineage/drift", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackedSchemaId: item.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.status) {
        setCardError({ id: item.id, msg: data.error ?? "Drift check failed.", from: "check" });
        return;
      }
      // The check wrote a drift_event; reload so the card + summary reflect it.
      await loadList();
    } catch {
      setCardError({ id: item.id, msg: "Network error during the drift check.", from: "check" });
    } finally {
      setCheckingId(null);
    }
  }

  async function confirmUntrack() {
    if (!untrackTarget || untrackRefusal !== null) return;
    // ConfirmDialog closes itself the moment you press confirm, so the failure
    // has to land on the card, the dialog is gone before the fetch resolves,
    // and a schema that is still tracked looks exactly like one that was
    // removed.
    const target = untrackTarget;
    try {
      const res = await apiFetch("/api/lineage", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: target.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setCardError({
          id: target.id,
          msg: data?.error ?? "Could not stop tracking this schema.",
          from: "untrack",
        });
        setUntrackTarget(null);
        return;
      }
      setCardError(null);
      setUntrackTarget(null);
      await loadList();
    } catch {
      setCardError({
        id: target.id,
        msg: "Network error while untracking the schema.",
        from: "untrack",
      });
      setUntrackTarget(null);
    }
  }

  // ── Derived: summary counts + hero-first ordering ──────────────────────────
  const total = items.length;
  const visible = items;

  // The tiles count what is on screen, so they agree with the grid under it.
  const drifted = visible.filter((i) => i.driftStatus === "drifted").length;
  const inSync = visible.filter((i) => i.driftStatus === "in_sync").length;
  const unreachable = visible.filter((i) => i.driftStatus === "unreachable").length;
  // The fourth state, and the one every schema starts in. Without a tile of its
  // own a freshly tracked schema showed as "Tracked 1" over "Drifted 0 · In
  // sync 0 · Unreachable 0", three zeros that do not add up to one, which
  // reads as the dashboard having lost it. Counting it here makes the strip
  // account for every row: drifted + in sync + unreachable + not checked
  // is always the tracked count.
  const notChecked = visible.length - drifted - inSync - unreachable;
  const sorted = [...visible].sort(
    (a, b) => sortPriority(a.driftStatus) - sortPriority(b.driftStatus)
  );

  // The building on show: the one picked, or the first if that one has gone
  // (untracked).
  const selected = sorted.find((i) => i.id === selectedId) ?? sorted[0] ?? null;
  const needsYou = sorted.filter(
    (i) => i.driftStatus === "drifted" || i.driftStatus === "unreachable"
  );
  const noConnections = connPhase.kind === "ready" && connections.length === 0;

  const buildings: Building[] = sorted.map((item) => {
    const tables = tableCounts[item.id];
    const amount =
      heightBy === "versions"
        ? `${item.migrationCount} recorded version${item.migrationCount === 1 ? "" : "s"}`
        : typeof tables === "number"
          ? `${tables} table${tables === 1 ? "" : "s"}`
          : "table count not known";
    return {
      id: item.id,
      name: item.schemaName,
      status: item.driftStatus ?? "unchecked",
      value: heightBy === "versions" ? item.migrationCount : (tables ?? null),
      label:
        `${item.schemaName}, ` +
        `${statusLook(item.driftStatus).label}, ${amount}`,
    };
  });

  // The connection picked in the drawer, so an error there can name it.
  const pickedConnection = connections.find((c) => String(c.id) === trackConnId);

  const trackButton = (
    <Button
      variant="primary"
      onClick={openTrack}
      data-tour="track-schema"
      disabled={trackRefusal !== null}
      title={trackRefusal ?? undefined}
    >
      <PlusIcon size={14} /> Track a schema
    </Button>
  );

  // Getting started: the four steps, each worked out from what is loaded.
  const connectDone = savedConnections.length > 0 || total > 0;
  const trackDone = total > 0;
  const connReadFailed = connPhase.kind === "error";
  // Tracking reads PostgreSQL, so only those connections open the drawer's picker.
  const canTrackSomewhere = connections.length > 0;
  const mayEditGitHub = can("github:update");
  const githubState = setupFacts?.github ?? "unknown";
  const setupSteps: SetupStep[] = [
    {
      key: "connect",
      label: "Connect a database",
      done: connectDone,
      detail: !connectDone
        ? connReadFailed
          ? "Your connections couldn't be read just now. Reload the page to try again."
          : "Save the details of a database you want to look after."
        : savedConnections.length === 1
          ? `Done. ${savedConnections[0].name} is connected.`
          : savedConnections.length > 1
            ? `Done. ${savedConnections.length} databases are connected.`
            : "Done.",
      action: { label: "Open Connections", href: orgPath("/connections") },
    },
    {
      key: "track",
      label: "Track a schema",
      done: trackDone,
      detail: trackDone
        ? `Done. ${countPhrase(total, "schema", "schemas", "tracked")}.`
        : trackRefusal
          ? "Your role can't track a schema. An Admin can turn this on."
          : connReadFailed
            ? "This opens once your connections can be read."
            : canTrackSomewhere
              ? "Record what a schema looks like today and hear when it changes."
              : connectDone
                ? "Tracking reads PostgreSQL. Add a PostgreSQL connection first."
                : "Connect a database first.",
      action:
        trackRefusal || !canTrackSomewhere ? undefined : { label: "Start tracking", onClick: openTrack },
    },
    {
      key: "compare",
      label: "Run your first compare",
      done: setupFacts?.compared ?? false,
      detail: setupFacts?.compared ? "Done." : "See what differs between two schemas.",
      action: { label: "Start", href: orgPath("/compare") },
    },
    {
      key: "github",
      label: "Set up GitHub for deploys",
      done: githubState === "done",
      detail:
        githubState === "done"
          ? "Done. GitHub is connected."
          : mayEditGitHub
            ? "Deploy scripts are kept in a GitHub repository."
            : "An Admin sets this up.",
      // Offered only to a role that may change the GitHub settings. Everyone
      // else reads that an Admin does it.
      action: mayEditGitHub ? { label: "Set up GitHub", href: orgPath("/admin?tab=github") } : undefined,
    },
  ];
  // A step this person's role cannot read (GitHub, for most roles) must not
  // keep the list on screen for ever, so it does not count against "all done".
  const setupAllDone = setupSteps.every(
    (step) => step.done || (step.key === "github" && githubState === "unknown")
  );
  const showSetup =
    listPhase === "ready" &&
    setupHidden === false &&
    setupFacts !== null &&
    (connPhase.kind === "ready" || connPhase.kind === "error") &&
    !setupAllDone;

  // Why buttons on this page are off for this role, in one sentence rather
  // than a paragraph per button. The card buttons only count once there are
  // cards to press them on. A single refusal opens Requests with it picked.
  // A check is allowed by Drift: Run or Deploy: Run (useDriftCheckRefusal),
  // and its refusal names the Drift one.
  const refusedKeys: PermissionKey[] = [];
  if (trackRefusal) refusedKeys.push("drift:create");
  if (total > 0 && checkRefusal) refusedKeys.push("drift:run");
  if (total > 0 && untrackRefusal) refusedKeys.push("drift:delete");
  const roleNote = refusedKeys.length > 0 ? refusalMessageForAll(roleLabel, refusedKeys) : null;

  return (
    <div className="sk-page max-w-[1100px] mx-auto px-4 sm:px-8 py-8 sm:py-10">
      {/* Header. The title and its one line come from lib/help/studio.ts. */}
      <PageHeader
        page="/studio"
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => void loadList()}
              disabled={listPhase === "loading"}
              aria-label="Refresh"
            >
              <RefreshIcon size={14} /> Refresh
            </Button>
            {trackButton}
          </>
        }
      />

      {/* Said once for the page rather than beside every button. */}
      {roleNote && (
        <div className="role-note">
          <InfoIcon size={15} className="ico" />
          <div className="body">
            <p>
              {roleNote}
              <AskAdmin permission={refusedKeys.length === 1 ? refusedKeys[0] : undefined} />
            </p>
          </div>
        </div>
      )}

      {showSetup && (
        <SetupChecklist
          className="sk-setup"
          title="Getting started"
          lead="Four steps from an empty organization to a schema you can deploy to."
          steps={setupSteps}
          onHide={hideSetup}
        />
      )}

      {listPhase === "loading" && (
        <div role="status" aria-label="Loading the dashboard">
          <Skeleton width="100%" height={380} radius={24} />
        </div>
      )}

      {listPhase === "error" && (
        <StateCard
          tone="break"
          icon={<AlertCircleIcon size={22} />}
          title="Couldn't load tracked schemas"
          description="The app database may be unreachable. Try again in a moment."
        >
          <Button variant="secondary" onClick={() => void loadList()}>
            <RefreshIcon size={14} /> Retry
          </Button>
        </StateCard>
      )}

      {/* Two first-run states, not one. Offering "Track a schema" to somebody
          with no saved connection sends them into a drawer whose only option is
          an empty list, so the connections are read on mount and we can tell
          them first. A failed connections read deliberately falls through to
          the second card rather than claiming they have no connections. */}
      {listPhase === "ready" && total === 0 && noConnections && (
        <FirstRun
          step={1}
          title="Add a connection first"
          description="Save a PostgreSQL connection, then come back and track a schema on it."
        >
          <Link href={orgPath("/connections")} className="btn btn-primary">
            <PlusIcon size={14} /> Add a connection
          </Link>
        </FirstRun>
      )}

      {listPhase === "ready" && total === 0 && !noConnections && (
        <FirstRun
          step={2}
          title="Nothing tracked yet"
          description="Track a schema to record what it looks like today and to hear when the live database changes."
        >
          {trackButton}
        </FirstRun>
      )}

      {listPhase === "ready" && total > 0 && (
        <>
          <section className="sk-stage" data-tour="city" aria-label="Your schemas">
            <div className="sk-top">
              <h2>Your schemas</h2>
              <div className="sk-seg" data-tour="height-shows" role="radiogroup" aria-label="Height shows">
                <span aria-hidden="true">Height shows</span>
                <button
                  type="button"
                  role="radio"
                  aria-checked={heightBy === "versions"}
                  onClick={() => setHeightBy("versions")}
                >
                  Versions
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={heightBy === "tables"}
                  onClick={() => setHeightBy("tables")}
                >
                  Tables
                </button>
              </div>
            </div>

            {/* What the roofs mean, right above the city: a glyph and a word
                for each of the four states, never a colour on its own. */}
            <ul className="sk-leg" aria-label="What the roofs mean">
              {STATUS_ORDER.map((key) => (
                <li key={key} data-s={key} title={statusLook(key).meaning}>
                  <i aria-hidden="true">
                    <StatusGlyph status={key} size={11} />
                  </i>
                  {statusLook(key).label}
                </li>
              ))}
            </ul>

            {sorted.length > 0 && selected && (
              <>
                <div className="sk-mid">
                  <div className="sk-city">
                    <Skyline
                      buildings={buildings}
                      selectedId={selected.id}
                      onSelect={setSelectedId}
                    />
                  </div>
                  <Inspector
                    key={selected.id}
                    item={selected}
                    tables={tableCounts[selected.id]}
                    heightBy={heightBy}
                    checking={checkingId === selected.id}
                    error={cardError?.id === selected.id ? cardError.msg : null}
                    errorFromCheck={cardError?.from === "check"}
                    checkRefusal={checkRefusal}
                    untrackRefusal={untrackRefusal}
                    onCheckDrift={() => void checkDrift(selected)}
                    onUntrack={() => setUntrackTarget(selected)}
                  />
                </div>

                <p className="sk-bot">
                  {heightBy === "versions"
                    ? "Each building is one tracked schema. A taller one has more recorded versions."
                    : "Each building is one tracked schema. A taller one had more tables in its latest recorded version."}
                </p>

                <details className="sk-tb">
                  <summary>Show as a table</summary>
                  <div className="sk-tb-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Schema</th>
                          <th scope="col">Last check found</th>
                          <th scope="col">Versions</th>
                          {heightBy === "tables" && <th scope="col">Tables</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((item) => (
                          <tr key={item.id}>
                            <td>
                              <button
                                type="button"
                                aria-label={`Show ${item.schemaName} in the skyline`}
                                onClick={() => setSelectedId(item.id)}
                              >
                                {item.schemaName}
                              </button>
                            </td>
                            <td>
                              <StatusChip status={item.driftStatus} variant="mark" size="sm" />
                            </td>
                            <td>{item.migrationCount}</td>
                            {heightBy === "tables" && <td>{tablesText(tableCounts[item.id])}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )}
          </section>

          {/* Every number counts what is on screen, so the numbers and the
              city can never disagree. Drifted, in sync, unreachable and not
              checked always add up to the first one. */}
          <div className="sk-vit" data-tour="schema-counts">
            <Vital label="Tracked" value={visible.length} />
            <Vital status="in_sync" value={inSync} />
            <Vital status="drifted" value={drifted} />
            <Vital status="unreachable" value={unreachable} />
            <Vital status="unchecked" value={notChecked} />
          </div>

          <Card className="sk-need">
            <div className="sk-hd">
              <h2>Needs you</h2>
              <small>
                {needsYou.length} of {visible.length}
              </small>
            </div>
            {needsYou.length === 0 && (
              <p className="sk-quiet">Nothing here has drifted or stopped answering.</p>
            )}
            {needsYou.map((item) => (
              <button
                key={item.id}
                type="button"
                className="sk-nr"
                aria-pressed={selected?.id === item.id}
                onClick={() => setSelectedId(item.id)}
              >
                <span className="sk-nr-main">
                  <b title={item.schemaName}>{item.schemaName}</b>
                  <StatusChip status={item.driftStatus} variant="mark" size="sm" />
                  <span className="sk-nr-sum">{item.driftSummary ?? "No details were recorded."}</span>
                </span>
                <span className="sk-nr-go">Show in the skyline</span>
              </button>
            ))}
          </Card>
        </>
      )}

      {/* Track-a-schema drawer */}
      <Drawer
        open={trackOpen}
        onClose={() => setTrackOpen(false)}
        title="Track a schema"
        badge={<Pill tone="brand" dot={false}>new baseline</Pill>}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setTrackOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void submitTrack()}
              disabled={!trackConnId || !trackSchema || trackSubmitting}
            >
              {trackSubmitting ? "Tracking…" : "Track schema"}
            </Button>
          </>
        }
      >
        <p className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
          A baseline snapshot is taken now, as lineage <span className="mono">v1.0.0</span>.
        </p>

        <div>
          <Label className="mb-1 block">Connection</Label>
          <Select
            variant="input"
            ariaLabel="Connection"
            value={trackConnId}
            disabled={connPhase.kind !== "ready"}
            placeholder={
              connPhase.kind === "loading" ? "Loading connections…" : "Select a connection…"
            }
            options={connections.map((c) => ({
              value: String(c.id),
              label: `${c.name} · ${c.host}/${c.database_name}`,
            }))}
            onChange={(value) => void onPickConnection(value)}
          />
          {/* Only once the fetch has settled, while it is in flight the Select
              is disabled and says so, and an empty list means nothing yet. */}
          {connPhase.kind === "error" && (
            <ErrorNotice
              variant="inline"
              className="mt-2"
              error="Your saved connections could not be read."
              onRetry={() => void loadConnections()}
            />
          )}
          {connPhase.kind === "ready" && connections.length === 0 && (
            <p className="help mt-1">
              No PostgreSQL connections saved yet.{" "}
              <Link href={orgPath("/connections")} style={{ color: "var(--brand)" }}>
                Add one on the Connections page
              </Link>
              .
            </p>
          )}
        </div>

        <div>
          <Label className="mb-1 block">Schema</Label>
          <Select
            variant="input"
            ariaLabel="Schema"
            value={trackSchema}
            disabled={!trackConnId || schemaPhase !== "ready"}
            placeholder={
              schemaPhase === "loading"
                ? "Loading schemas…"
                : schemaPhase === "ready"
                  ? "Select a schema…"
                  : "Pick a connection first"
            }
            options={schemaOptions.map((s) => ({ value: s, label: s }))}
            onChange={(value) => setTrackSchema(value)}
          />
          {schemaPhase === "error" && (
            <ErrorNotice
              variant="inline"
              className="mt-2"
              error={schemaError}
              connectionName={pickedConnection?.name}
              connectionId={trackConnId}
              onRetry={() => void onPickConnection(trackConnId)}
            />
          )}
          {schemaPhase === "ready" && schemaOptions.length === 0 && (
            <p className="help mt-1">This connection has no user schemas to track.</p>
          )}
        </div>

        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <Label>Label (optional)</Label>
            <HelpHint label="Label">
              A friendly name to show on its card.
            </HelpHint>
          </div>
          <Input
            placeholder="e.g. Billing service"
            value={trackLabel}
            onChange={(e) => setTrackLabel(e.target.value)}
          />
        </div>

        <ErrorNotice
          variant="inline"
          error={trackError}
          connectionName={pickedConnection?.name}
          connectionId={trackConnId}
        />
      </Drawer>

      {/* Untrack confirm */}
      <ConfirmDialog
        open={untrackTarget !== null}
        onClose={() => setUntrackTarget(null)}
        onConfirm={() => void confirmUntrack()}
        destructive
        title="Stop tracking this schema?"
        description={
          <>
            <span className="mono">{untrackTarget?.schemaName}</span>{" "}
            and its captured snapshots, lineage, and drift history will be
            removed. This can&apos;t be undone.
          </>
        }
        confirmLabel="Stop tracking"
      />
    </div>
  );
}

// ── Presentational pieces ────────────────────────────────────────────────────

/**
 * One big number above the "Needs you" list. A tile that counts a state shows
 * that state's glyph and word, the same as everywhere else.
 */
function Vital({ label, status, value }: { label?: string; status?: StatusKey; value: number }) {
  return (
    <Card className="sk-v">
      {status ? <StatusChip status={status} variant="mark" size="sm" /> : <small>{label}</small>}
      <b>{value}</b>
    </Card>
  );
}

/** A plain card for "this went wrong": an icon, what happened, and a way on. */
function StateCard({
  tone,
  icon,
  title,
  description,
  children,
}: {
  tone?: "break";
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card className="sk-state" data-tone={tone}>
      <div className="sk-state-ico">{icon}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      <div className="sk-go">{children}</div>
    </Card>
  );
}

const FIRST_RUN_STEPS = ["Add a connection", "Track a schema", "See the skyline grow"];

/**
 * The dashboard before anything is tracked: an empty plot of land, the three
 * steps to a first building, and the one button for the step you are on.
 */
function FirstRun({
  step,
  title,
  description,
  children,
}: {
  /** Which of the three steps comes next: 1 or 2. */
  step: 1 | 2;
  title: string;
  description: string;
  children: ReactNode;
}) {
  // Nine empty plots. The middle one is dashed: that is where the first
  // building will go.
  const plots = [];
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      const cx = 270 + ((x - y) * CELL_W) / 2;
      const cy = 70 + ((x + y) * CELL_H) / 2;
      plots.push(
        <polygon
          key={`${x}-${y}`}
          className={x === 1 && y === 1 ? "sk-plot-next" : "sk-plot"}
          points={diamond(cx, cy, CELL_W / 2 - 4, CELL_H / 2 - 2)}
        />
      );
    }
  }

  return (
    <Card className="sk-first">
      <div className="sk-first-stage" aria-hidden="true">
        <svg viewBox="0 0 540 270">{plots}</svg>
      </div>
      <div className="sk-first-side">
        <ol className="sk-steps">
          {FIRST_RUN_STEPS.map((name, i) => (
            <li
              key={name}
              data-step={i + 1 < step ? "done" : i + 1 === step ? "on" : undefined}
              aria-current={i + 1 === step ? "step" : undefined}
            >
              {i + 1 < step && <CheckIcon size={12} />} {name}
            </li>
          ))}
        </ol>
        <small>Step {step} of 3</small>
        <h2>{title}</h2>
        <p>{description}</p>
        <div className="sk-go">{children}</div>
      </div>
    </Card>
  );
}

// ── The skyline drawing ──────────────────────────────────────────────────────

/** What the drawing needs to know about one tracked schema. */
type Building = {
  id: number;
  name: string;
  /** Sets the roof's colour and glyph. "unchecked" is a schema nobody has checked yet. */
  status: DriftStatus | "unchecked";
  /** What the height stands for, or null when the number is not known. */
  value: number | null;
  /** The whole building in words, for a screen reader and the tooltip. */
  label: string;
};

// The size of one plot of land, and how much of it a building covers.
const CELL_W = 116;
const CELL_H = 58;
const FOOTPRINT = 0.72;
const MIN_HEIGHT = 10;

/** How tall the tallest building is drawn. A crowded city gets shorter rows. */
function tallestFor(count: number): number {
  if (count > 12) return 84;
  if (count > 6) return 120;
  return 168;
}

/** The four corners of a diamond around (cx, cy), as an SVG points string. */
function diamond(cx: number, cy: number, halfWidth: number, halfHeight: number): string {
  return [
    `${cx - halfWidth},${cy}`,
    `${cx},${cy - halfHeight}`,
    `${cx + halfWidth},${cy}`,
    `${cx},${cy + halfHeight}`,
  ].join(" ");
}

/**
 * The city: one building per tracked schema, standing side by side in rows.
 * Each building is its own button, with its name on one line underneath (a
 * long name ends in an ellipsis; the full one is in the tooltip). A building's
 * height is its value against the largest value on screen, so the tallest
 * building always has the most. The roof carries the state's colour and glyph.
 */
function Skyline({
  buildings,
  selectedId,
  onSelect,
}: {
  buildings: Building[];
  selectedId: number;
  onSelect: (id: number) => void;
}) {
  const largest = Math.max(1, ...buildings.map((b) => b.value ?? 0));
  const tallest = tallestFor(buildings.length);
  const halfW = (CELL_W / 2) * FOOTPRINT;
  const halfH = (CELL_H / 2) * FOOTPRINT;

  // Every drawing is the same size, so the buildings stand on one line.
  const viewHeight = tallest + MIN_HEIGHT + CELL_H + 8;
  const cx = CELL_W / 2;
  const cy = viewHeight - CELL_H / 2 - 2;

  return (
    <ul className="sk-row" aria-label="Tracked schemas, drawn as buildings">
      {buildings.map((building, i) => {
        const height = MIN_HEIGHT + (tallest * (building.value ?? 0)) / largest;
        const roofY = cy - height;
        return (
          <li key={building.id}>
            <button
              type="button"
              className="sk-b"
              data-s={building.status}
              aria-pressed={building.id === selectedId}
              aria-label={building.label}
              title={building.label}
              style={{ animationDelay: `${i * 40}ms` }}
              onClick={() => onSelect(building.id)}
            >
              <svg viewBox={`0 0 ${CELL_W} ${viewHeight}`} aria-hidden="true">
                <polygon className="sk-gd" points={diamond(cx, cy, CELL_W / 2 - 2, CELL_H / 2 - 1)} />
                <polygon
                  className="sk-fl"
                  points={`${cx - halfW},${cy} ${cx},${cy + halfH} ${cx},${roofY + halfH} ${cx - halfW},${roofY}`}
                />
                <polygon
                  className="sk-fr"
                  points={`${cx},${cy + halfH} ${cx + halfW},${cy} ${cx + halfW},${roofY} ${cx},${roofY + halfH}`}
                />
                <polygon className="sk-ft" points={diamond(cx, roofY, halfW, halfH)} />
                {/* The state's glyph on the roof, so the colour never stands alone. */}
                <g className="sk-glyph" transform={`translate(${cx - 11} ${roofY - 11}) scale(0.92)`}>
                  <StatusGlyphPaths glyph={statusLook(building.status).glyph} />
                </g>
              </svg>
              <span className="sk-name">{building.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** "12", or why there is no number: still being read, or could not be read. */
function tablesText(count: number | null | undefined): string {
  if (count === undefined) return "Reading…";
  if (count === null) return "Couldn't read";
  return String(count);
}

// ── The picked building's card ───────────────────────────────────────────────

/**
 * What ran the check behind the picked schema's state: the scheduler, a
 * person, a deploy. The list does not say, so the newest drift event is read
 * (GET /api/lineage/audit, one row). Null while reading, when the role may not
 * read events, or when the read fails; the status line then leaves it out.
 */
function useFoundBy(item: TrackedSchema): string | null {
  const { can, loading } = useUser();
  const mayRead = !loading && can("drift:read");
  // Kept with the state it was read for, so another schema or a newer check
  // never shows the old answer while the new one is read.
  const key = `${item.id}:${item.driftStatus}:${item.driftCheckedAt}`;
  const [found, setFound] = useState<{ key: string; source: string | null } | null>(null);

  useEffect(() => {
    if (!mayRead || item.driftStatus === null) return;
    let stale = false;

    async function read() {
      let source: string | null = null;
      try {
        const res = await apiFetch(`/api/lineage/audit?trackedSchemaId=${item.id}&limit=1`, {
          cache: "no-store",
        });
        const data = res.ok ? await res.json() : null;
        const newest = Array.isArray(data) ? data[0] : null;
        // Only believed when it is about the state on screen.
        if (newest && newest.status === item.driftStatus && typeof newest.source === "string") {
          source = newest.source;
        }
      } catch {
        source = null;
      }
      if (!stale) setFound({ key, source });
    }

    void read();
    return () => {
      stale = true;
    };
  }, [mayRead, item.id, item.driftStatus, item.driftCheckedAt, key]);

  return mayRead && item.driftStatus !== null && found?.key === key ? found.source : null;
}

/** One line of the More menu: a link when it has an address, a button otherwise. */
type MenuItem = {
  key: string;
  label: string;
  /** The full name for a screen reader, such as "Stop tracking shop". */
  ariaLabel?: string;
  href?: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** Why it is off, as a tooltip. */
  title?: string;
};

/**
 * The round "More" button and its menu: everything you can do with the picked
 * schema besides the card's one main action. Works from the keyboard: Enter or
 * Space opens it, the arrow keys move, Escape closes it and goes back to the
 * button. It opens upward because the stage clips whatever hangs below it.
 */
function MoreMenu({ name, items }: { name: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  /** The menu lines a key press can land on (the switched-off ones are skipped). */
  function reachable(): HTMLElement[] {
    const found = wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])');
    return Array.from(found ?? []);
  }

  useEffect(() => {
    if (!open) return;
    // Start on the first line, so the arrow keys work straight away.
    const first = wrap.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    first?.focus();
    // A press anywhere else closes it.
    function onPressOutside(event: MouseEvent) {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPressOutside);
    return () => document.removeEventListener("mousedown", onPressOutside);
  }, [open]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    if (event.key === "Escape") {
      // Kept from reaching anything behind the menu that also listens for it.
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const lines = reachable();
    if (lines.length === 0) return;
    const at = lines.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === "ArrowDown") next = (at + 1) % lines.length;
    if (event.key === "ArrowUp") next = (at - 1 + lines.length) % lines.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = lines.length - 1;
    if (next >= 0) {
      event.preventDefault();
      lines[next].focus();
    }
  }

  return (
    <div className="sk-more" ref={wrap} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className="btn btn-secondary btn-sm sk-more-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${name}`}
        title="More actions"
        onClick={() => setOpen((was) => !was)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.9" />
          <circle cx="12" cy="12" r="1.9" />
          <circle cx="19" cy="12" r="1.9" />
        </svg>
      </button>
      {open && (
        <div className="sk-menu" role="menu" aria-label={`More actions for ${name}`}>
          {items.map((item) =>
            item.href ? (
              <Link
                key={item.key}
                href={item.href}
                role="menuitem"
                aria-label={item.ariaLabel}
                onClick={() => setOpen(false)}
              >
                {item.label}
              </Link>
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                aria-label={item.ariaLabel}
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  setOpen(false);
                  button.current?.focus();
                  item.onSelect?.();
                }}
              >
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The picked building in words: its state as a chip, its name, two numbers,
 * ONE status line (the state, who found it, when, and how often it is
 * checked), one main button, and a More menu for everything else.
 */
function Inspector({
  item,
  tables,
  heightBy,
  checking,
  error,
  errorFromCheck,
  checkRefusal,
  untrackRefusal,
  onCheckDrift,
  onUntrack,
}: {
  item: TrackedSchema;
  /** Tables in the latest recorded version: undefined until read, null if unreadable. */
  tables: number | null | undefined;
  heightBy: HeightBy;
  checking: boolean;
  error: string | null;
  /** True when the error came from a drift check, which "Try again" can repeat. */
  errorFromCheck: boolean;
  /** Why this role may not check drift, or null. The page says it once. */
  checkRefusal: string | null;
  /** Why this role may not stop tracking, or null. */
  untrackRefusal: string | null;
  onCheckDrift: () => void;
  onUntrack: () => void;
}) {
  const orgPath = useOrgHref();
  // The age in the status line ticks, because a dashboard is left open.
  const now = useNow(30_000);
  const foundBy = useFoundBy(item);
  const name = item.schemaName;
  const connectionGone = item.connectionName === null;
  // Where the schema lives. Shown under the name rather than replaced by a
  // label, because a label says nothing about which database this is.
  const source = item.connectionName
    ? `${item.connectionName} · ${item.connectionDatabase ?? "?"}`
    : "Connection removed";

  // now === null is the frame before the browser takes over; an empty line
  // for it beats an age that then has to be corrected.
  const line = checking
    ? "Checking now…"
    : now === null
      ? " "
      : statusLine(
          {
            status: item.driftStatus,
            foundAt: item.driftCheckedAt,
            lastRanAt: item.lastCheckedAt,
            source: foundBy,
            intervalMinutes: item.driftIntervalMinutes,
          },
          now
        );

  // One main action. A drifted schema needs the drift detail (what changed,
  // and the ways to resolve it) more than another check; one that is in sync
  // is most useful opened; anything else wants a check.
  const main =
    item.driftStatus === "drifted" ? "review" : item.driftStatus === "in_sync" ? "open" : "check";

  // The rest goes in the More menu.
  const more: MenuItem[] = [];
  if (main !== "open") {
    more.push({ key: "open", label: "Open", href: orgPath(`/schemas/${item.id}`) });
  }
  if (main !== "check") {
    more.push({
      key: "check",
      label: "Check drift",
      onSelect: onCheckDrift,
      disabled: checking || checkRefusal !== null,
      title: checkRefusal ?? undefined,
    });
  }
  if (!connectionGone) {
    more.push({
      key: "compare",
      label: "Compare",
      href: orgPath(
        `/compare?targetConnection=${item.connectionId}&targetSchema=${encodeURIComponent(name)}`
      ),
    });
  }
  more.push({
    key: "stop",
    label: "Stop tracking",
    ariaLabel: `Stop tracking ${name}`,
    onSelect: onUntrack,
    disabled: untrackRefusal !== null,
    title: untrackRefusal ?? undefined,
  });

  return (
    <div className="sk-ins">
      <StatusChip status={item.driftStatus} />

      <div className="sk-id">
        <h2 title={name}>{name}</h2>
        {item.label && (
          <p className="sk-label" title={item.label}>
            {item.label}
          </p>
        )}
        <p className="sk-src mono" title={source}>
          {source}
        </p>
      </div>

      <dl className="sk-st">
        <div>
          <dt>Versions</dt>
          <dd>{item.migrationCount}</dd>
        </div>
        {heightBy === "tables" && (
          <div>
            <dt>Tables</dt>
            <dd>{tablesText(tables)}</dd>
          </div>
        )}
        {/* "lineage" is spelled out because this number is Schema Studio's own
            counter for the tracked schema, and without the word it reads like
            the script version Deploy shows as "Applied to target". */}
        <div title="Schema Studio's lineage number for this tracked schema. It moves when a deploy or re-baseline changes the structure, and is separate from the script versions in GitHub.">
          <dt>Lineage</dt>
          <dd>{item.headVersion ? displayVersion(item.headVersion, true) : "None yet"}</dd>
        </div>
        {item.headSeq !== null && (
          <div>
            <dt>Latest seq</dt>
            <dd>{String(item.headSeq).padStart(4, "0")}</dd>
          </div>
        )}
      </dl>

      {/* The one status line. Read out when it changes, such as after a check. */}
      <p className="sk-line" aria-live="polite">
        {line}
      </p>

      <ErrorNotice
        variant="inline"
        error={error}
        connectionName={item.connectionName}
        connectionId={connectionGone ? null : item.connectionId}
        onRetry={errorFromCheck && checkRefusal === null ? onCheckDrift : undefined}
      />

      <div className="sk-acts" data-tour="schema-actions">
        {main === "review" && (
          <Link
            href={orgPath(`/drift?tab=detail&schema=${item.id}`)}
            className="btn btn-primary btn-sm"
            aria-label={`Review drift on ${name}`}
          >
            Review drift
          </Link>
        )}
        {main === "open" && (
          <Link
            href={orgPath(`/schemas/${item.id}`)}
            className="btn btn-secondary btn-sm"
            aria-label={`Open ${name}`}
          >
            Open
          </Link>
        )}
        {main === "check" && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onCheckDrift}
            disabled={checking || checkRefusal !== null}
            title={checkRefusal ?? undefined}
          >
            {checking ? (
              "Checking…"
            ) : (
              <>
                <RefreshIcon size={13} /> Check drift
              </>
            )}
          </Button>
        )}
        <MoreMenu name={name} items={more} />
      </div>
    </div>
  );
}
