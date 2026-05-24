"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CopyButton from "../../components/CopyButton";
import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";


type ScriptRecord = {
  id: number;
  script_name: string;
  version: string;
  sql_content: string;
  description: string | null;
  created_at: string;
};

type ListScriptsResponse = {
  scripts?: ScriptRecord[];
  error?: string;
};

type RegisterScriptResponse =
  | { success: true; script: ScriptRecord }
  | { error: string };

type ChangeKind = "breaking" | "additive" | "patch";

type PushState = "idle" | "pushing" | "done" | "error";
type GitHubScript = {
  script_name: string;
  version: string;
  path: string;
  download_url: string;
};

// A saved connection from /api/connections
type Connection = {
  id: number;
  name: string;
  host: string;
  port: number;
  database_name: string;
  type: string;
};

// What /api/scripts/preflight returns
type PatchEntry = {
  version: string;
  title: string | null;
  change_type: string;
  applied_at: string;
};

type PreflightResult = {
  hasVersionTable: boolean;
  needsInit: boolean;
  currentVersion: string | null;
  timeline: PatchEntry[];
  schema: string;
  scriptName: string | null;
  message: string;
};

// Per-script status while a deploy is running
type DeployItemStatus = "idle" | "applying" | "done" | "error";

function versionParts(version: string): number[] {
  return version
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number.parseInt(part.replace(/\D/g, ""), 10) || 0);
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length, 3);

  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }

  return left.localeCompare(right);
}

function sortScriptsByVersion(scripts: ScriptRecord[]): ScriptRecord[] {
  return [...scripts].sort((a, b) => {
    const versionDiff = compareVersions(a.version, b.version);
    if (versionDiff !== 0) return versionDiff;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

function getNextVersion(versions: string[], kind: ChangeKind = "patch"): string {
  if (versions.length === 0) return "1.0.0";

  const latest = [...versions].sort(compareVersions).at(-1) ?? "1.0.0";
  const parts = latest.replace(/^v/i, "").split(".");

  while (parts.length < 3) parts.push("0");

  const major = Number.parseInt(parts[0], 10) || 0;
  const minor = Number.parseInt(parts[1], 10) || 0;
  const patch = Number.parseInt(parts[2], 10) || 0;

  if (kind === "breaking") return `${major + 1}.0.0`;
  if (kind === "additive") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function inferChangeKind(sql: string): ChangeKind {
  const normalized = sql.toLowerCase();

  if (
    normalized.includes("drop table") ||
    normalized.includes("drop column") ||
    normalized.includes("drop constraint") ||
    normalized.includes(" set not null") ||
    normalized.includes(" alter column") ||
    normalized.includes(" rename ")
  ) {
    return "breaking";
  }

  if (
    normalized.includes("create table") ||
    normalized.includes("add column") ||
    normalized.includes("add constraint") ||
    normalized.includes("create index")
  ) {
    return "additive";
  }

  return "patch";
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function getSqlLineCount(sql: string): number {
  return sql.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

export default function ScriptsPage() {
  const [scripts, setScripts] = useState<ScriptRecord[]>([]);
  const [scriptNames, setScriptNames] = useState<string[]>([]);
  const [selectedExisting, setSelectedExisting] = useState("");
  const [newScriptName, setNewScriptName] = useState("");
  const [form, setForm] = useState({
    script_name: "",
    version: "1.0.0",
    sql_content: "",
    description: "",
  });
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingScripts, setLoadingScripts] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState("");
  const [newScriptId, setNewScriptId] = useState<number | null>(null);
  const [changeKind, setChangeKind] = useState<ChangeKind>("patch");
  const [expandedScripts, setExpandedScripts] = useState<Record<string, boolean>>({});
  const [pushStates, setPushStates] = useState<Record<string, PushState>>({});
  const [pushUrls, setPushUrls] = useState<Record<string, string>>({});
  const [githubScripts, setGithubScripts] = useState<GitHubScript[] | null>(null);
  const [pullLoading, setPullLoading] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [fromCompareNote, setFromCompareNote] = useState<string | null>(null);
  const [pendingChangeKind, setPendingChangeKind] = useState<ChangeKind | null>(null);
  const fromCompareRef = useRef(false);
  const prevSelectedRef = useRef<string>("");

  // ── Deploy panel state ────────────────────────────────────────────────────
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [deployConnectionId, setDeployConnectionId] = useState<string>("");
  const [deploySchema, setDeploySchema] = useState<string>("public");
  const [deployScriptGroup, setDeployScriptGroup] = useState<string>("");
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  // Set of script IDs the user has ticked to deploy
  const [selectedVersionIds, setSelectedVersionIds] = useState<Set<number>>(new Set());
  // Execution state — set during an active deploy run
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployStatus, setDeployStatus] = useState<Record<number, DeployItemStatus>>({});
  const [deployErrors, setDeployErrors] = useState<Record<number, string>>({});
  const [deployComplete, setDeployComplete] = useState(false);

  const groupedScripts = useMemo(() => {
    return scripts.reduce<Record<string, ScriptRecord[]>>((acc, script) => {
      if (!acc[script.script_name]) acc[script.script_name] = [];
      acc[script.script_name].push(script);
      return acc;
    }, {});
  }, [scripts]);

  const groupedEntries = useMemo(() => {
    return Object.entries(groupedScripts)
      .map(([name, versions]) => [name, sortScriptsByVersion(versions)] as const)
      .sort(([leftName, leftVersions], [rightName, rightVersions]) => {
        const leftLatest = leftVersions.at(-1);
        const rightLatest = rightVersions.at(-1);
        const dateDiff =
          new Date(rightLatest?.created_at ?? 0).getTime() -
          new Date(leftLatest?.created_at ?? 0).getTime();
        return dateDiff || leftName.localeCompare(rightName);
      });
  }, [groupedScripts]);

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groupedEntries;

    return groupedEntries.filter(([name, versions]) => {
      return (
        name.toLowerCase().includes(needle) ||
        versions.some(
          (script) =>
            script.version.toLowerCase().includes(needle) ||
            script.sql_content.toLowerCase().includes(needle) ||
            (script.description ?? "").toLowerCase().includes(needle)
        )
      );
    });
  }, [groupedEntries, query]);

  // Scripts that haven't been applied to the target DB yet.
  // Recalculates whenever the user switches connection/schema or preflight returns.
  const pendingScripts = useMemo<ScriptRecord[]>(() => {
    if (!deployScriptGroup || !preflightResult) return [];

    const groupVersions = groupedScripts[deployScriptGroup] ?? [];
    const sorted = sortScriptsByVersion(groupVersions);

    // If no version recorded in the DB, every script in the group is pending
    if (!preflightResult.currentVersion) return sorted;

    // Only scripts whose version is strictly greater than the DB's current highest version
    return sorted.filter(
      (s) => compareVersions(s.version, preflightResult.currentVersion!) > 0
    );
  }, [deployScriptGroup, preflightResult, groupedScripts]);

  const latestScript = groupedEntries[0]?.[1].at(-1) ?? null;
  const totalVersions = scripts.length;
  const breakingCount = scripts.filter(
    (script) => inferChangeKind(script.sql_content) === "breaking"
  ).length;

  const fetchScripts = async () => {
    setLoadingScripts(true);
    try {
      const res = await fetch("/api/scripts/list");
      const data = (await res.json()) as ListScriptsResponse;

      if (!res.ok) {
        setMessage({
          type: "error",
          text: data.error ?? "Could not load scripts from the registry.",
        });
        return;
      }

      const loadedScripts = data.scripts ?? [];
      setScripts(loadedScripts);

      const names = Array.from(
        new Set(loadedScripts.map((script) => script.script_name))
      ).sort();
      setScriptNames(names);
    } catch {
      setMessage({ type: "error", text: "Could not reach the scripts API." });
    } finally {
      setLoadingScripts(false);
    }
  };

  // Load saved connections for the deploy panel target selector
  useEffect(() => {
    fetch("/api/connections", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: unknown) => {
        if (Array.isArray(data)) setConnections(data as Connection[]);
      })
      .catch(() => {
        // Fail silently — deploy panel shows empty dropdown, not a crash
      })
      .finally(() => {
        // Mark as loaded so the "no connections" hint only shows after fetch completes,
        // not as a flash on every page load before the response arrives.
        setConnectionsLoaded(true);
      });
  }, []);

  // Bare API call — just fetches preflight result and updates state.
  // Called both from the "Check DB" button and automatically after a successful deploy.
  // scriptName scopes the timeline and currentVersion to a specific script family so
  // that "products_migration v2.0.0" doesn't make "users_migration v1.0.0" look applied.
  const runPreflightCheck = async (
    connectionId: string,
    schema: string,
    scriptName: string,
  ) => {
    setPreflightLoading(true);
    setPreflightError(null);
    try {
      const res = await fetch("/api/scripts/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(connectionId),
          schemaName: schema || "public",
          scriptName: scriptName || undefined,
        }),
      });
      const data = (await res.json()) as PreflightResult & { error?: string };
      if (!res.ok) {
        setPreflightError(data.error ?? "Pre-flight check failed.");
        return;
      }
      setPreflightResult(data);
    } catch {
      setPreflightError("Network error during pre-flight check.");
    } finally {
      setPreflightLoading(false);
    }
  };

  // Button handler — resets all deploy state first, then runs the check.
  const handlePreflight = async () => {
    if (!deployConnectionId) return;
    setPreflightResult(null);
    setSelectedVersionIds(new Set());
    setDeployStatus({});
    setDeployErrors({});
    setDeployComplete(false);
    await runPreflightCheck(deployConnectionId, deploySchema, deployScriptGroup);
  };

  // Apply selected pending scripts to the target DB, one at a time, in version order.
  // Stops immediately if any script fails — later scripts are skipped to avoid
  // applying a version on top of a broken schema state.
  const handleDeploy = async () => {
    if (selectedVersionIds.size === 0 || isDeploying) return;

    // Apply in ascending version order — pendingScripts is already sorted this way
    const toApply = pendingScripts.filter((s) => selectedVersionIds.has(s.id));

    setIsDeploying(true);
    setDeployComplete(false);
    setDeployErrors({});
    // Mark every selected script as idle so the status column renders immediately
    setDeployStatus(
      Object.fromEntries(toApply.map((s) => [s.id, "idle" as DeployItemStatus]))
    );

    let anyFailed = false;

    for (const script of toApply) {
      // Update this script to "applying" — shows a spinner in the row
      setDeployStatus((prev) => ({ ...prev, [script.id]: "applying" }));

      try {
        const res = await fetch("/api/scripts/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectionId: Number(deployConnectionId),
            schemaName: deploySchema || "public",
            // script_name scopes this entry in script_patch so different families
            // at the same version number don't block or pollute each other.
            script_name: script.script_name,
            sql_content: script.sql_content,
            version: script.version,
            // Use description as title; fall back to the script family name
            title: script.description?.trim() || script.script_name,
            description: script.description ?? undefined,
            // inferChangeKind returns "breaking"|"additive"|"patch" — all valid change_types
            change_type: inferChangeKind(script.sql_content),
          }),
        });

        const data = (await res.json()) as { success?: boolean; error?: string };

        if (!res.ok || !data.success) {
          setDeployStatus((prev) => ({ ...prev, [script.id]: "error" }));
          setDeployErrors((prev) => ({
            ...prev,
            [script.id]: data.error ?? "Unknown error from apply API.",
          }));
          anyFailed = true;
          break; // Stop — do not apply subsequent scripts after a failure
        }

        setDeployStatus((prev) => ({ ...prev, [script.id]: "done" }));
      } catch {
        setDeployStatus((prev) => ({ ...prev, [script.id]: "error" }));
        setDeployErrors((prev) => ({
          ...prev,
          [script.id]: "Network error — could not reach /api/scripts/apply.",
        }));
        anyFailed = true;
        break;
      }
    }

    setIsDeploying(false);
    setDeployComplete(true);

    // On full success: re-query the DB so the current version + pending list refresh.
    // We call runPreflightCheck directly (not handlePreflight) so we don't wipe the
    // deployStatus display — the user still sees the ✓ / ✗ marks after the refresh.
    if (!anyFailed) {
      setSelectedVersionIds(new Set());
      await runPreflightCheck(deployConnectionId, deploySchema, deployScriptGroup);
    }
  };

  useEffect(() => {
    const raw = sessionStorage.getItem("pendingScript");
    if (!raw) return;
    sessionStorage.removeItem("pendingScript");
    try {
      const data = JSON.parse(raw) as {
        sql_content: string;
        script_name: string;
        description: string;
        sourceLabel: string;
        changeKind: ChangeKind;
      };
      fromCompareRef.current = true;
      setSelectedExisting("__new__");
      setNewScriptName(data.script_name);
      setForm((prev) => ({
        ...prev,
        script_name: data.script_name,
        sql_content: data.sql_content,
        description: data.description,
        version: "1.0.0", // placeholder — recalculated once scripts load
      }));
      setShowForm(true);
      setPendingChangeKind(data.changeKind ?? "additive");
      setFromCompareNote(
        `Pre-filled from Schema Comparison (${data.sourceLabel}). Review and save when ready.`
      );
    } catch {
      // Malformed sessionStorage data — ignore
    }
  }, []);

  useEffect(() => {
    fetchScripts();
  }, []);

  // Once the registry loads, recalculate the suggested version using the
  // actual change kind so the version bump is correct (breaking/additive/patch).
  useEffect(() => {
    if (!pendingChangeKind || loadingScripts || selectedExisting !== "__new__" || !newScriptName) return;
    const existing = groupedScripts[newScriptName] ?? [];
    const nextVersion = getNextVersion(existing.map((s) => s.version), pendingChangeKind);
    setForm((f) => ({ ...f, version: nextVersion }));
    setChangeKind(pendingChangeKind);
    setPendingChangeKind(null);
  }, [groupedScripts, loadingScripts, pendingChangeKind, selectedExisting, newScriptName]);

  useEffect(() => {
    const prevSelected = prevSelectedRef.current;
    prevSelectedRef.current = selectedExisting;

    if (selectedExisting === "__new__") {
      if (fromCompareRef.current) {
        // First fire after sessionStorage load — only sync the name,
        // do not clear sql_content or description.
        fromCompareRef.current = false;
        setForm((f) => ({ ...f, script_name: newScriptName }));
        return;
      }
      if (prevSelected !== "__new__") {
        // User just switched to "Create new script" — clear the form
        setForm((f) => ({ ...f, script_name: newScriptName, sql_content: "", description: "" }));
      } else {
        // groupedScripts reloaded while still on __new__ — only sync the name
        setForm((f) => ({ ...f, script_name: newScriptName }));
      }
      return;
    }

    if (!selectedExisting) return;

    const sameScripts = groupedScripts[selectedExisting] ?? [];
    const sortedScripts = sortScriptsByVersion(sameScripts);
    const latest = sortedScripts.at(-1);
    const nextVersion = getNextVersion(sameScripts.map((script) => script.version), changeKind);

    setForm((prev) => ({
      ...prev,
      script_name: selectedExisting,
      version: nextVersion,
      sql_content: latest?.sql_content ?? "",
      description: latest?.description ?? "",
    }));
  }, [groupedScripts, newScriptName, selectedExisting, changeKind]);

  const handlePush = async (script: ScriptRecord) => {
    const key = `${script.script_name}@${script.version}`;
    setPushStates((prev) => ({ ...prev, [key]: "pushing" }));
    try {
      const res = await fetch("/api/github/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script_name: script.script_name,
          version: script.version,
          sql_content: script.sql_content,
          description: script.description ?? undefined,
        }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setPushStates((prev) => ({ ...prev, [key]: "error" }));
      } else {
        setPushStates((prev) => ({ ...prev, [key]: "done" }));
        setPushUrls((prev) => ({ ...prev, [key]: data.url! }));
      }
    } catch {
      setPushStates((prev) => ({ ...prev, [key]: "error" }));
    }
  };

  const handlePull = async () => {
    setPullLoading(true);
    setPullError(null);
    try {
      const res = await fetch("/api/github/pull");
      const data = (await res.json()) as { scripts?: GitHubScript[]; error?: string };
      if (!res.ok || !data.scripts) {
        setPullError(data.error ?? "Could not fetch scripts from GitHub.");
      } else {
        setGithubScripts(data.scripts);
      }
    } catch {
      setPullError("Network error fetching from GitHub.");
    } finally {
      setPullLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    const normalizedName = form.script_name.trim();

    if (!normalizedName) {
      setMessage({ type: "error", text: "Script name is required." });
      return;
    }

    if (selectedExisting && selectedExisting !== "__new__") {
      const sameScripts = groupedScripts[selectedExisting] ?? [];
      const latest = sortScriptsByVersion(sameScripts).at(-1);

      if (latest && form.sql_content.trim() === latest.sql_content.trim()) {
        setMessage({
          type: "error",
          text: "No SQL changes detected for the next version.",
        });
        return;
      }
    }

    setLoading(true);

    try {
      const res = await fetch("/api/scripts/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, script_name: normalizedName }),
      });

      const data = (await res.json()) as RegisterScriptResponse;

      if (!res.ok) {
        setMessage({
          type: "error",
          text: "error" in data ? data.error : "Registration failed.",
        });
        return;
      }

      if (!("script" in data)) {
        setMessage({
          type: "error",
          text: "Registration response was missing script data.",
        });
        return;
      }

      setMessage({ type: "success", text: "Script registered." });
      setNewScriptId(data.script.id);
      setForm({ script_name: "", version: "1.0.0", sql_content: "", description: "" });
      setSelectedExisting("");
      setNewScriptName("");
      setShowForm(false);
      setFromCompareNote(null);
      setPendingChangeKind(null);
      setExpandedScripts((prev) => ({ ...prev, [data.script.script_name]: true }));

      await fetchScripts();
    } catch {
      setMessage({ type: "error", text: "Network error while registering script." });
    } finally {
      setLoading(false);
    }
  };

  const toggleGroup = (name: string) => {
    setExpandedScripts((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  return (
    <div className="db-layout">
      <Sidebar current="SQL Scripts" />

      <main className="db-main">
        <Topbar
          title="SQL Scripts"
          text="Approved migration registry and version history."
        />

        {fromCompareNote && (
          <div className="script-message script-message--info">
            {fromCompareNote}
          </div>
        )}

        {message && (
          <div className={`script-message script-message--${message.type}`}>
            {message.text}
          </div>
        )}

        <section className="script-summary-grid" aria-label="Script registry summary">
          <div className="script-summary-card">
            <span className="script-summary-card__label">Script Families</span>
            <strong className="script-summary-card__value">{scriptNames.length}</strong>
            <span className="script-summary-card__meta">Grouped by script name</span>
          </div>
          <div className="script-summary-card">
            <span className="script-summary-card__label">Saved Versions</span>
            <strong className="script-summary-card__value">{totalVersions}</strong>
            <span className="script-summary-card__meta">Registry rows</span>
          </div>
          <div className="script-summary-card">
            <span className="script-summary-card__label">Needs Care</span>
            <strong className="script-summary-card__value">{breakingCount}</strong>
            <span className="script-summary-card__meta">Breaking-looking SQL</span>
          </div>
          <div className="script-summary-card">
            <span className="script-summary-card__label">Latest Save</span>
            <strong className="script-summary-card__value script-summary-card__value--small">
              {latestScript ? `v${latestScript.version}` : "None"}
            </strong>
            <span className="script-summary-card__meta">
              {latestScript ? latestScript.script_name : "No scripts yet"}
            </span>
          </div>
        </section>

        <section className="script-workspace">
          <div className="script-main-column">
            <section className="script-panel">
              <div className="script-panel__header">
                <div>
                  <h2 className="script-panel__title">Registry</h2>
                  <p className="script-panel__eyebrow">
                    Stored in PostgreSQL table <code>public.scripts</code>
                  </p>
                </div>
                <button
                  className="script-btn script-btn--primary"
                  onClick={() => setShowForm((current) => !current)}
                  type="button"
                >
                  {showForm ? "Close Form" : "Register Script"}
                </button>
              </div>

              <div className="script-toolbar">
                <input
                  className="script-input script-input--search"
                  placeholder="Search name, version, description, or SQL"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button
                  className="script-btn script-btn--secondary"
                  onClick={fetchScripts}
                  type="button"
                >
                  Refresh
                </button>
              </div>

              {loadingScripts ? (
                <div className="script-empty-state">Loading registry...</div>
              ) : scripts.length === 0 ? (
                <div className="script-empty-state">
                  No scripts registered yet. Save the first approved migration.
                </div>
              ) : filteredEntries.length === 0 ? (
                <div className="script-empty-state">No matching scripts.</div>
              ) : (
                <div className="script-registry-list">
                  {filteredEntries.map(([name, versions]) => {
                    const latest = versions.at(-1);
                    const isExpanded = expandedScripts[name] ?? false;
                    const kind = latest ? inferChangeKind(latest.sql_content) : "patch";

                    return (
                      <article key={name} className="script-family">
                        <button
                          className="script-family__header"
                          onClick={() => toggleGroup(name)}
                          type="button"
                        >
                          <span className="script-family__identity">
                            <strong>{name}</strong>
                            <span>
                              {versions.length} version{versions.length === 1 ? "" : "s"}
                            </span>
                          </span>
                          <span className="script-family__meta">
                            <span className={`script-kind script-kind--${kind}`}>
                              {kind}
                            </span>
                            <span className="script-version-pill">
                              latest v{latest?.version ?? "?"}
                            </span>
                            <span className="script-toggle">
                              {isExpanded ? "Hide" : "View"}
                            </span>
                          </span>
                        </button>

                        {isExpanded && (
                          <div className="script-version-list">
                            {versions.map((script) => {
                              const scriptKind = inferChangeKind(script.sql_content);

                              return (
                                <div
                                  key={script.id}
                                  className={`script-version-row ${
                                    script.id === newScriptId
                                      ? "script-version-row--new"
                                      : ""
                                  }`}
                                >
                                  <div className="script-version-row__top">
                                    <div>
                                      <div className="script-version-row__title">
                                        v{script.version}
                                      </div>
                                      <div className="script-version-row__meta">
                                        {formatDate(script.created_at)} ·{" "}
                                        {getSqlLineCount(script.sql_content)} SQL lines
                                      </div>
                                    </div>
                                    <div className="script-version-row__actions">
                                      <span className={`script-kind script-kind--${scriptKind}`}>
                                        {scriptKind}
                                      </span>
                                      <CopyButton text={script.sql_content} />
                                      {(() => {
                                        const key = `${script.script_name}@${script.version}`;
                                        const state = pushStates[key] ?? "idle";
                                        const url = pushUrls[key];
                                        if (state === "done" && url) {
                                          return (
                                            <a
                                              href={url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="script-btn script-btn--github-done"
                                            >
                                              ↑ On GitHub
                                            </a>
                                          );
                                        }
                                        return (
                                          <button
                                            className={`script-btn script-btn--github-push${state === "error" ? " script-btn--error" : ""}`}
                                            onClick={() => handlePush(script)}
                                            disabled={state === "pushing"}
                                            type="button"
                                          >
                                            {state === "pushing" ? "Pushing..." : state === "error" ? "Retry ↑" : "↑ Push"}
                                          </button>
                                        );
                                      })()}
                                    </div>
                                  </div>

                                  {script.description && (
                                    <p className="script-description">
                                      {script.description}
                                    </p>
                                  )}

                                  <pre className="script-sql-preview">
                                    {script.sql_content}
                                  </pre>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

          <aside className="script-side-column">
              {showForm && (
                <section className="script-panel script-panel--form">
                  <div className="script-panel__header">
                    <div>
                      <h2 className="script-panel__title">Register Version</h2>
                      <p className="script-panel__eyebrow">
                        Save approved migration SQL to the registry
                      </p>
                    </div>
                  </div>

                  <form onSubmit={handleSubmit} className="script-form">
                    <div className="script-form-field">
                      <label className="script-label" htmlFor="script-name-mode">
                        Script
                      </label>
                      <select
                        id="script-name-mode"
                        value={selectedExisting}
                        onChange={(event) => setSelectedExisting(event.target.value)}
                        className="script-input script-select"
                      >
                        <option value="">Choose existing or new</option>
                        <option value="__new__">Create new script</option>
                        {scriptNames.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {selectedExisting === "__new__" && (
                      <div className="script-form-field">
                        <label className="script-label" htmlFor="new-script-name">
                          New Script Name
                        </label>
                        <input
                          id="new-script-name"
                          type="text"
                          required
                          value={newScriptName}
                          onChange={(event) => setNewScriptName(event.target.value)}
                          className="script-input"
                          placeholder="sync_public_to_staging"
                        />
                      </div>
                    )}

                    {selectedExisting && selectedExisting !== "__new__" && (
                      <div className="script-form-field">
                        <label className="script-label" htmlFor="change-kind">
                          Change Kind
                        </label>
                        <div className="change-kind-selector">
                          {(["patch", "additive", "breaking"] as ChangeKind[]).map((k) => (
                            <button
                              key={k}
                              type="button"
                              className={`change-kind-btn change-kind-btn--${k}${changeKind === k ? " change-kind-btn--active" : ""}`}
                              onClick={() => setChangeKind(k)}
                            >
                              {k}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="script-form-field">
                      <label className="script-label" htmlFor="script-version">
                        Version
                      </label>
                      <input
                        id="script-version"
                        type="text"
                        required
                        value={form.version}
                        onChange={(event) =>
                          setForm({ ...form, version: event.target.value })
                        }
                        className="script-input"
                        placeholder="1.0.0"
                      />
                    </div>

                    <div className="script-form-field">
                      <label className="script-label" htmlFor="script-sql">
                        SQL Content
                      </label>
                      <textarea
                        id="script-sql"
                        required
                        rows={9}
                        value={form.sql_content}
                        onChange={(event) =>
                          setForm({ ...form, sql_content: event.target.value })
                        }
                        className="script-input script-textarea"
                        placeholder="CREATE TABLE ..."
                      />
                    </div>

                    <div className="script-form-field">
                      <label className="script-label" htmlFor="script-description">
                        Description
                      </label>
                      <input
                        id="script-description"
                        type="text"
                        value={form.description}
                        onChange={(event) =>
                          setForm({ ...form, description: event.target.value })
                        }
                        className="script-input"
                        placeholder="Short change summary"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={loading}
                      className="script-btn script-btn--primary script-btn--wide"
                    >
                      {loading ? "Registering..." : "Save Version"}
                    </button>
                  </form>
                </section>
              )}
            </aside>
        </section>

        {/* ── Deploy Panel ──────────────────────────────────────────────── */}
        <section className="script-panel deploy-section">
          <div className="script-panel__header">
            <div>
              <h2 className="script-panel__title">Deploy to Database</h2>
              <p className="script-panel__eyebrow">
                Check what&apos;s pending and apply migrations to a target connection
              </p>
            </div>
          </div>

          {/* Step 1 — pick target connection, schema, and script group */}
          <div className="deploy-controls">
            <div className="script-form-field">
              <label className="script-label" htmlFor="deploy-connection">
                Target Connection
              </label>
              <select
                id="deploy-connection"
                className="script-input script-select"
                value={deployConnectionId}
                disabled={isDeploying}
                onChange={(e) => {
                  setDeployConnectionId(e.target.value);
                  setPreflightResult(null);
                  setPreflightError(null);
                  setSelectedVersionIds(new Set());
                  setDeployStatus({});
                  setDeployErrors({});
                  setDeployComplete(false);
                  setIsDeploying(false);
                }}
              >
                <option value="">Select a connection…</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.host}/{c.database_name}
                  </option>
                ))}
              </select>
              {connectionsLoaded && connections.length === 0 && (
                <p className="deploy-hint">
                  No connections saved yet. Add one on the Connections page first.
                </p>
              )}
            </div>

            <div className="script-form-field">
              <label className="script-label" htmlFor="deploy-schema">
                Schema
              </label>
              <input
                id="deploy-schema"
                type="text"
                className="script-input"
                placeholder="public"
                value={deploySchema}
                disabled={isDeploying}
                onChange={(e) => {
                  setDeploySchema(e.target.value);
                  setPreflightResult(null);
                  setPreflightError(null);
                  setSelectedVersionIds(new Set());
                  setDeployStatus({});
                  setDeployErrors({});
                  setDeployComplete(false);
                  setIsDeploying(false);
                }}
              />
            </div>

            <div className="script-form-field">
              <label className="script-label" htmlFor="deploy-script-group">
                Script Group
              </label>
              <select
                id="deploy-script-group"
                className="script-input script-select"
                value={deployScriptGroup}
                disabled={isDeploying}
                onChange={(e) => {
                  setDeployScriptGroup(e.target.value);
                  setSelectedVersionIds(new Set());
                  setDeployStatus({});
                  setDeployErrors({});
                  setDeployComplete(false);
                }}
              >
                <option value="">Select a script group…</option>
                {scriptNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            <button
              className="script-btn script-btn--primary"
              type="button"
              disabled={!deployConnectionId || preflightLoading || isDeploying}
              onClick={handlePreflight}
            >
              {preflightLoading ? "Checking…" : "Check DB"}
            </button>
          </div>

          {/* Pre-flight error */}
          {preflightError && (
            <div className="script-message script-message--error">
              {preflightError}
            </div>
          )}

          {/* Step 2 — preflight result: current version + applied history */}
          {preflightResult && (
            <div className="deploy-preflight">
              {preflightResult.needsInit && (
                <div className="script-message script-message--info">
                  No <code>script_patch</code> table found in schema &quot;{preflightResult.schema}&quot;.
                  It will be created automatically on first deploy.
                </div>
              )}

              <div className="deploy-version-status">
                <span className="deploy-version-label">DB current version:</span>
                <strong className="deploy-version-value">
                  {preflightResult.currentVersion
                    ? `v${preflightResult.currentVersion}`
                    : "None (no versions applied yet)"}
                </strong>
              </div>

              {preflightResult.timeline.length > 0 && (
                <details className="deploy-history">
                  <summary className="deploy-history__summary">
                    Applied history ({preflightResult.timeline.length} entr{preflightResult.timeline.length === 1 ? "y" : "ies"})
                  </summary>
                  <ul className="deploy-history-list">
                    {preflightResult.timeline.map((entry) => (
                      <li key={entry.version + "-" + entry.applied_at} className="deploy-history-item">
                        <span className={`script-kind script-kind--${entry.change_type}`}>
                          {entry.change_type}
                        </span>
                        <span className="deploy-history-version">v{entry.version}</span>
                        {entry.title && (
                          <span className="deploy-history-title">{entry.title}</span>
                        )}
                        <span className="deploy-history-date">
                          {new Date(entry.applied_at).toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {/* Step 3 — pending scripts list with checkboxes */}
          {preflightResult && deployScriptGroup && (
            <div className="deploy-pending">

              {/* Deploy summary — lives OUTSIDE the pending/empty ternary so it
                  stays visible even after a successful deploy empties the list */}
              {deployComplete && (
                <div
                  className={
                    Object.values(deployStatus).some((s) => s === "error")
                      ? "script-message script-message--error"
                      : "script-message script-message--success"
                  }
                >
                  {Object.values(deployStatus).every((s) => s === "done") ? (
                    <>
                      ✓ All {Object.values(deployStatus).length} script
                      {Object.values(deployStatus).length !== 1 ? "s" : ""} applied
                      successfully. DB version has been updated.
                    </>
                  ) : (
                    <>
                      Deployment stopped early — one or more scripts failed.
                      Scripts after the failure point were not applied.
                      Fix the error above and retry.
                    </>
                  )}
                </div>
              )}

              {pendingScripts.length === 0 ? (
                <div className="script-empty-state">
                  ✓ This database is already up to date. No pending scripts for &quot;{deployScriptGroup}&quot;.
                </div>
              ) : (
                <>
                  <div className="deploy-pending__header">
                    <h3 className="deploy-pending__title">
                      Pending ({pendingScripts.length})
                    </h3>
                    {/* Disabled while a deploy is running */}
                    <button
                      type="button"
                      className="script-btn script-btn--secondary"
                      disabled={isDeploying}
                      onClick={() => {
                        if (selectedVersionIds.size === pendingScripts.length) {
                          setSelectedVersionIds(new Set());
                        } else {
                          setSelectedVersionIds(
                            new Set(pendingScripts.map((s) => s.id))
                          );
                        }
                      }}
                    >
                      {selectedVersionIds.size === pendingScripts.length
                        ? "Deselect All"
                        : "Select All"}
                    </button>
                  </div>

                  <div className="deploy-pending-list">
                    {pendingScripts.map((script) => {
                      const kind = inferChangeKind(script.sql_content);
                      const isChecked = selectedVersionIds.has(script.id);
                      const status = deployStatus[script.id] ?? "idle";
                      const errorMsg = deployErrors[script.id];

                      return (
                        <div key={script.id}>
                          <label
                            className={[
                              "deploy-pending-item",
                              `deploy-pending-item--${kind}`,
                              isChecked ? "deploy-pending-item--selected" : "",
                              status === "done"  ? "deploy-pending-item--done"  : "",
                              status === "error" ? "deploy-pending-item--error-state" : "",
                            ].filter(Boolean).join(" ")}
                          >
                            <input
                              type="checkbox"
                              className="deploy-pending-item__checkbox"
                              checked={isChecked}
                              // Lock checkboxes while deploying or once a script is applied
                              disabled={isDeploying || status === "done"}
                              onChange={() => {
                                setSelectedVersionIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(script.id)) next.delete(script.id);
                                  else next.add(script.id);
                                  return next;
                                });
                              }}
                            />

                            <div className="deploy-pending-item__info">
                              <span className="deploy-pending-item__version">
                                v{script.version}
                              </span>
                              <span className={`script-kind script-kind--${kind}`}>
                                {kind}
                              </span>
                              {script.description && (
                                <span className="deploy-pending-item__desc">
                                  {script.description}
                                </span>
                              )}
                              <span className="deploy-pending-item__lines">
                                {getSqlLineCount(script.sql_content)} SQL lines
                              </span>
                            </div>

                            {/* Per-script status — only visible once deploy starts */}
                            <div className="deploy-pending-item__status">
                              {status === "applying" && (
                                <span className="deploy-status deploy-status--applying">
                                  Applying…
                                </span>
                              )}
                              {status === "done" && (
                                <span className="deploy-status deploy-status--done">
                                  ✓ Applied
                                </span>
                              )}
                              {status === "error" && (
                                <span className="deploy-status deploy-status--error">
                                  ✗ Failed
                                </span>
                              )}
                            </div>
                          </label>

                          {/* Error detail shown below the row, not inside the label */}
                          {errorMsg && (
                            <p className="deploy-pending-item__error-msg">
                              {errorMsg}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Deploy button */}
                  <button
                    type="button"
                    className="script-btn script-btn--primary script-btn--wide"
                    disabled={selectedVersionIds.size === 0 || isDeploying}
                    onClick={handleDeploy}
                  >
                    {isDeploying
                      ? "Deploying…"
                      : selectedVersionIds.size === 0
                        ? "Select scripts to deploy"
                        : `Deploy ${selectedVersionIds.size} script${selectedVersionIds.size > 1 ? "s" : ""} →`}
                  </button>
                </>
              )}
            </div>
          )}
        </section>

        {/* GitHub section */}
        <section className="script-panel github-section">
          <div className="script-panel__header">
            <div>
              <h2 className="script-panel__title">GitHub</h2>
              <p className="script-panel__eyebrow">
                Push individual versions or view what&apos;s already in the repo
              </p>
            </div>
            <button
              className="script-btn script-btn--github"
              onClick={handlePull}
              disabled={pullLoading}
              type="button"
            >
              {pullLoading ? "Fetching..." : "↓ Sync from GitHub"}
            </button>
          </div>

          {pullError && (
            <div className="script-message script-message--error">{pullError}</div>
          )}

          {githubScripts === null ? (
            <p className="script-empty-state">
              Click &quot;Sync from GitHub&quot; to see what&apos;s in the repo. Use the &quot;↑ Push&quot; button on any script version to upload it.
            </p>
          ) : githubScripts.length === 0 ? (
            <p className="script-empty-state">No .sql files found in the repo yet.</p>
          ) : (
            <ul className="github-file-list">
              {githubScripts.map((f) => (
                <li key={f.path} className="github-file-item">
                  <span className="github-file-item__name">{f.script_name}</span>
                  <span className="script-version-pill">v{f.version}</span>
                  <a
                    href={f.download_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="github-file-item__link"
                  >
                    View SQL ↗
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
