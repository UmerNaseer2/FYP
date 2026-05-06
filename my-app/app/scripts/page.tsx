"use client";

import { useEffect, useMemo, useState } from "react";
import CopyButton from "../../components/CopyButton";
import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";
import { useUser } from "@/hooks/useUser";


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

function getNextVersion(versions: string[]): string {
  if (versions.length === 0) return "1.0.0";

  const latest = [...versions].sort(compareVersions).at(-1) ?? "1.0.0";
  const parts = latest.replace(/^v/i, "").split(".");

  while (parts.length < 3) {
    parts.push("0");
  }

  const patchIndex = parts.length - 1;
  const patch = Number.parseInt(parts[patchIndex], 10);
  parts[patchIndex] = String(Number.isNaN(patch) ? 1 : patch + 1);

  return parts.join(".");
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
  const { isAdmin, loading: roleLoading } = useUser();   // <-- added

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
  const [expandedScripts, setExpandedScripts] = useState<Record<string, boolean>>({});

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

  useEffect(() => {
    fetchScripts();
  }, []);

  useEffect(() => {
    if (selectedExisting === "__new__") {
      setForm((prev) => ({
        ...prev,
        script_name: newScriptName,
        sql_content: "",
        description: "",
      }));
      return;
    }

    if (!selectedExisting) return;

    const sameScripts = groupedScripts[selectedExisting] ?? [];
    const sortedScripts = sortScriptsByVersion(sameScripts);
    const latest = sortedScripts.at(-1);
    const nextVersion = getNextVersion(sameScripts.map((script) => script.version));

    setForm((prev) => ({
      ...prev,
      script_name: selectedExisting,
      version: nextVersion,
      sql_content: latest?.sql_content ?? "",
      description: latest?.description ?? "",
    }));
  }, [groupedScripts, newScriptName, selectedExisting]);

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

  // Show a loading indicator while role is being fetched (optional)
  if (roleLoading) {
    return <div className="loading-state">Checking permissions...</div>;
  }

  return (
    <div className="db-layout">
      <Sidebar current="SQL Scripts" />

      <main className="db-main">
        <Topbar
          title="SQL Scripts"
          text="Approved migration registry and version history."
        />

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
                {/* Only admin sees the Register Script button */}
                {isAdmin && (
                  <button
                    className="script-btn script-btn--primary"
                    onClick={() => setShowForm((current) => !current)}
                    type="button"
                  >
                    {showForm ? "Close Form" : "Register Script"}
                  </button>
                )}
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

          {/* Only admin sees the registration form */}
          {isAdmin && (
            <aside className="script-side-column">
              {showForm && (
                <section className="script-panel script-panel--form">
                  <div className="script-panel__header">
                    <div>
                      <h2 className="script-panel__title">Register Version</h2>
                      <p className="script-panel__eyebrow">
                        Manual entry until compare approval is wired in
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
          )}
        </section>
      </main>
    </div>
  );
}