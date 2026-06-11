"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Select } from "@/components/ui/Select";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  EditIcon,
  ConnectionsIcon,
  CheckIcon,
  AlertTriangleIcon,
  RefreshIcon,
} from "@/components/ui/icons";
import {
  bumpVersion,
  compareVersions,
  isValidSemver,
  normalizeVersion,
  suggestBumpLevel,
  type BumpLevel,
} from "@/lib/script-status";

// ── Shapes of the data we pull from existing endpoints ──────────────────────
type Connection = {
  id: number;
  name: string;
  host: string;
  database_name: string;
};

type GitHubScript = {
  database_name: string;
  schema_name: string;
  script_name: string;
  version: string;
};

const BUMP_LEVELS: BumpLevel[] = ["patch", "minor", "major"];
const BUMP_DESC: Record<BumpLevel, string> = {
  patch: "data / fixes",
  minor: "additive",
  major: "breaking",
};

/** The highest version in a list, by semver. null for an empty list. */
function maxVersion(versions: string[]): string | null {
  if (versions.length === 0) return null;
  return versions.reduce((hi, v) => (compareVersions(v, hi) > 0 ? v : hi));
}

export default function ScriptEditorPage() {
  // ── Target selection ──────────────────────────────────────────────────────
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [connectionId, setConnectionId] = useState("");

  const [schemas, setSchemas] = useState<string[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [schemasError, setSchemasError] = useState("");
  const [schema, setSchema] = useState("");

  // The whole GitHub registry (used to derive existing families + saved versions).
  const [githubScripts, setGithubScripts] = useState<GitHubScript[]>([]);
  const [githubError, setGithubError] = useState("");

  const [familyMode, setFamilyMode] = useState<"existing" | "new">("existing");
  const [existingFamily, setExistingFamily] = useState("");
  const [newFamily, setNewFamily] = useState("");

  // ── Script + version ────────────────────────────────────────────────────--
  const [sql, setSql] = useState("");
  const [description, setDescription] = useState("");

  // Highest version already APPLIED for this family (from the target's
  // script_patch, via preflight). null = none applied / couldn't read.
  const [patchFloor, setPatchFloor] = useState<string | null>(null);
  const [patchLoading, setPatchLoading] = useState(false);
  const [patchUnreachable, setPatchUnreachable] = useState(false);

  const [versionChoice, setVersionChoice] = useState<BumpLevel | "custom">("patch");
  const [choiceTouched, setChoiceTouched] = useState(false);
  const [customVersion, setCustomVersion] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: true; url: string | null } | { ok: false; error: string } | null>(null);

  // ── Load connections + the GitHub registry once ─────────────────────────---
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/connections", { cache: "no-store" });
        const data = await res.json();
        if (active && Array.isArray(data)) setConnections(data);
      } catch {
        /* leave empty; the empty state guides the user */
      } finally {
        if (active) setConnectionsLoaded(true);
      }
    })();
    (async () => {
      try {
        const res = await fetch("/api/github/pull", { cache: "no-store" });
        const data = await res.json();
        if (!active) return;
        if (Array.isArray(data?.scripts)) setGithubScripts(data.scripts);
        else if (data?.error) setGithubError(String(data.error));
      } catch {
        if (active) setGithubError("Could not reach the GitHub registry.");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // ── Fetch schemas when the connection changes ───────────────────────────---
  useEffect(() => {
    // Clear the previous connection's schemas up front so a failed load can't
    // leave the old list selectable under the new target.
    setSchemas([]);
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

  // ── Derived target context ──────────────────────────────────────────────--
  const selectedConnection = useMemo(
    () => connections.find((c) => String(c.id) === connectionId) ?? null,
    [connections, connectionId],
  );
  const databaseName = selectedConnection?.database_name ?? "";

  const scriptName = (familyMode === "new" ? newFamily : existingFamily).trim();

  // Families that already exist in GitHub for this database + schema.
  const existingFamilies = useMemo(() => {
    if (!databaseName || !schema) return [];
    const names = githubScripts
      .filter((s) => s.database_name === databaseName && s.schema_name === schema)
      .map((s) => s.script_name);
    return Array.from(new Set(names)).sort();
  }, [githubScripts, databaseName, schema]);

  // Highest version already SAVED to GitHub for this exact family.
  const githubFloor = useMemo(() => {
    if (!databaseName || !schema || !scriptName) return null;
    return maxVersion(
      githubScripts
        .filter(
          (s) =>
            s.database_name === databaseName &&
            s.schema_name === schema &&
            s.script_name === scriptName,
        )
        .map((s) => s.version),
    );
  }, [githubScripts, databaseName, schema, scriptName]);

  // The floor: nothing may be created at or below this version.
  const floor = useMemo(() => {
    const both = [patchFloor, githubFloor].filter((v): v is string => !!v);
    return both.length ? both.reduce((hi, v) => (compareVersions(v, hi) > 0 ? v : hi)) : null;
  }, [patchFloor, githubFloor]);

  // ── Read the applied floor from script_patch when the family is chosen ────--
  useEffect(() => {
    // Blank the applied floor on every change so a previous family's value never
    // lingers while the new request is in flight.
    setPatchUnreachable(false);
    setPatchFloor(null);
    if (!connectionId || !schema || !scriptName) return;
    let active = true;
    setPatchLoading(true);
    (async () => {
      try {
        const res = await fetch("/api/scripts/preflight", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId: Number(connectionId), schemaName: schema, scriptName }),
        });
        const data = await res.json();
        if (!active) return;
        if (res.ok) {
          // Only trust a clean semver — a non-semver label (e.g. an externally
          // seeded "init" baseline) would otherwise collapse to 0.0.0 and make
          // the floor vanish, so we ignore it rather than mis-rank against it.
          const cv = data.currentVersion;
          setPatchFloor(typeof cv === "string" && isValidSemver(cv) ? cv : null);
        } else {
          // Couldn't read script_patch (target unreachable, etc.) — fall back to
          // the GitHub history alone and warn the user.
          setPatchFloor(null);
          setPatchUnreachable(true);
        }
      } catch {
        if (active) {
          setPatchFloor(null);
          setPatchUnreachable(true);
        }
      } finally {
        if (active) setPatchLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [connectionId, schema, scriptName]);

  // When the target/family changes, drop any manual version pick so each family
  // starts from its own SQL-based suggestion instead of carrying over the last
  // family's chosen level or custom string.
  useEffect(() => {
    setChoiceTouched(false);
    setVersionChoice("patch");
    setCustomVersion("");
  }, [connectionId, schema, scriptName]);

  // ── Version computation ─────────────────────────────────────────────────--
  const suggestedLevel = useMemo(() => suggestBumpLevel(sql), [sql]);
  // Follow the SQL-based suggestion until the user explicitly picks a level.
  const effectiveChoice: BumpLevel | "custom" = choiceTouched ? versionChoice : suggestedLevel;

  const effectiveVersion =
    effectiveChoice === "custom"
      ? customVersion.trim()
      : bumpVersion(floor, effectiveChoice);

  const normalizedVersion = normalizeVersion(effectiveVersion);
  const aboveFloor =
    !floor || (normalizedVersion != null && compareVersions(normalizedVersion, floor) > 0);

  let versionError = "";
  if (effectiveChoice === "custom") {
    if (!customVersion.trim()) versionError = "Enter a version.";
    else if (!isValidSemver(customVersion)) versionError = "Use a semver like 2.1.0.";
    else if (floor && compareVersions(customVersion, floor) <= 0)
      versionError = `Must be higher than ${floor}.`;
  }
  const versionValid = normalizedVersion != null && aboveFloor && !versionError;

  // The sanitizer turns junk like "@@@" or "   " into "___", which is otherwise
  // truthy and saveable — require at least one real alphanumeric character.
  const familyValid = /[a-zA-Z0-9]/.test(scriptName);

  // A new family that differs from an existing one only by case would create a
  // duplicate, case-variant folder (GitHub paths are case-sensitive). Warn.
  const caseClash =
    familyMode === "new" && scriptName
      ? existingFamilies.find((f) => f.toLowerCase() === scriptName.toLowerCase() && f !== scriptName) ?? null
      : null;

  const canSave =
    !!databaseName && !!schema && familyValid && sql.trim().length > 0 && versionValid && !saving;

  function pickLevel(choice: BumpLevel | "custom") {
    setVersionChoice(choice);
    setChoiceTouched(true);
    setSaveResult(null);
  }

  async function handleSave() {
    if (!canSave || !normalizedVersion) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch("/api/github/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          database_name: databaseName,
          schema_name: schema,
          script_name: scriptName,
          version: normalizedVersion,
          sql_content: sql,
          description: description.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setSaveResult({ ok: true, url: data.url ?? null });
        // Reflect the new file locally so the floor jumps immediately.
        setGithubScripts((prev) => [
          ...prev,
          { database_name: databaseName, schema_name: schema, script_name: scriptName, version: normalizedVersion },
        ]);
        // If it was a new family, switch to "existing" so it shows in the list.
        if (familyMode === "new") {
          setExistingFamily(scriptName);
          setFamilyMode("existing");
          setNewFamily("");
        }
      } else {
        setSaveResult({ ok: false, error: data.error ?? "Could not save the script." });
        // A 409 means that version already exists — our floor was stale. Refresh
        // the registry so the suggested version moves above what's really there.
        if (res.status === 409) {
          try {
            const r = await fetch("/api/github/pull", { cache: "no-store" });
            const d = await r.json();
            if (Array.isArray(d?.scripts)) setGithubScripts(d.scripts);
          } catch {
            /* keep the stale list; the error message still guides the user */
          }
        }
      }
    } catch {
      setSaveResult({ ok: false, error: "Could not reach the server. Try again." });
    } finally {
      setSaving(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────--
  return (
    <div className="p-4 sm:p-6 max-w-[1080px]">
      <div className="mb-4">
        <div className="section-title mb-2">Script Editor</div>
        <h1 className="text-[28px] font-semibold tracking-[-0.018em]">Write a migration script.</h1>
        <p className="text-[13.5px] mt-1.5 max-w-[64ch]" style={{ color: "var(--text-2)" }}>
          Hand-author SQL, give it a schema and a script family, and save it to the GitHub registry.
          The version is suggested from your SQL and is always kept above what is already applied or
          saved, in semver order.
        </p>
      </div>

      {connectionsLoaded && connections.length === 0 ? (
        <div style={{ minHeight: 360 }}>
          <EmptyState
            icon={<EditIcon size={22} />}
            title="Add a connection first"
            description="The editor needs a saved PostgreSQL connection to know the target database and read its applied versions."
            actions={
              <Link href="/connections" className="btn btn-primary btn-sm">
                <ConnectionsIcon size={14} />
                Go to Connections
              </Link>
            }
          />
        </div>
      ) : (
        <div className="grid gap-4">
          {/* ── Target ─────────────────────────────────────────────────────── */}
          <div className="card p-5">
            <div className="section-title mb-3">Target</div>
            <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
              <div>
                <label className="label" htmlFor="se-conn">Connection</label>
                <Select
                  variant="input"
                  id="se-conn"
                  className="mt-1"
                  ariaLabel="Connection"
                  value={connectionId}
                  placeholder="Select a connection…"
                  options={connections.map((c) => ({
                    value: String(c.id),
                    label: `${c.name} — ${c.host}/${c.database_name}`,
                  }))}
                  onChange={(value) => {
                    setConnectionId(value);
                    setSchema("");
                    setExistingFamily("");
                    setNewFamily("");
                    setSaveResult(null);
                  }}
                />
              </div>

              <div>
                <label className="label" htmlFor="se-schema">Schema</label>
                <Select
                  variant="input"
                  id="se-schema"
                  className="mt-1"
                  ariaLabel="Schema"
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
                  onChange={(value) => {
                    setSchema(value);
                    setExistingFamily("");
                    setNewFamily("");
                    setSaveResult(null);
                  }}
                />
                {schemasError && (
                  <p className="help mt-1" style={{ color: "var(--break)" }}>{schemasError}</p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="label" htmlFor="se-family">Script family</label>
                  <button
                    type="button"
                    className="family-toggle text-[11px]"
                    style={{ color: "var(--brand)" }}
                    onClick={() => {
                      setFamilyMode((m) => (m === "existing" ? "new" : "existing"));
                      setSaveResult(null);
                    }}
                  >
                    {familyMode === "existing" ? "+ New family" : "Pick existing"}
                  </button>
                </div>
                {familyMode === "existing" ? (
                  <Select
                    variant="input"
                    id="se-family"
                    className="mt-1"
                    mono
                    ariaLabel="Script family"
                    value={existingFamily}
                    disabled={!schema}
                    placeholder={
                      !schema
                        ? "Select a schema first"
                        : existingFamilies.length === 0
                          ? "No families yet — add one"
                          : "Select a family…"
                    }
                    options={existingFamilies.map((name) => ({ value: name, label: name }))}
                    onChange={(value) => {
                      setExistingFamily(value);
                      setSaveResult(null);
                    }}
                  />
                ) : (
                  <>
                    <input
                      id="se-family"
                      className="input mono mt-1"
                      placeholder="e.g. add_invoices"
                      value={newFamily}
                      disabled={!schema}
                      onChange={(e) => {
                        setNewFamily(e.target.value.replace(/[^a-zA-Z0-9_-]/g, "_"));
                        setSaveResult(null);
                      }}
                      aria-label="New script family name"
                    />
                    {newFamily.trim() && !familyValid && (
                      <p className="help mt-1" style={{ color: "var(--break)" }}>
                        Use at least one letter or number.
                      </p>
                    )}
                    {caseClash && (
                      <p className="help mt-1" style={{ color: "var(--drift)" }}>
                        A family &quot;{caseClash}&quot; already exists — use that exact name to add to it.
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
            {githubError && (
              <p className="help mt-3" style={{ color: "var(--drift)" }}>
                {githubError} Existing families can&apos;t be listed, but you can still add a new one.
              </p>
            )}
          </div>

          {/* ── Script ─────────────────────────────────────────────────────── */}
          <div className="card p-5">
            <div className="section-title mb-3">Script</div>
            <label className="label" htmlFor="se-sql">SQL</label>
            <textarea
              id="se-sql"
              className="input mono mt-1 se-textarea"
              style={{ minHeight: 300, lineHeight: 1.6, resize: "vertical" }}
              spellCheck={false}
              placeholder={"ALTER TABLE invoices\n  ADD COLUMN due_date date;"}
              value={sql}
              onChange={(e) => {
                setSql(e.target.value);
                setSaveResult(null);
              }}
            />
            <label className="label mt-3 block" htmlFor="se-desc">
              Description <span style={{ color: "var(--text-3)" }}>(optional, used as the commit message)</span>
            </label>
            <input
              id="se-desc"
              className="input mt-1"
              placeholder="What this script does"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                setSaveResult(null);
              }}
            />
          </div>

          {/* ── Version ────────────────────────────────────────────────────── */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="section-title">Version</div>
              <div className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--text-3)" }}>
                <span>
                  applied:{" "}
                  <span className="mono" style={{ color: "var(--text-2)" }}>
                    {patchLoading ? "…" : patchFloor ?? "—"}
                  </span>
                </span>
                <span>·</span>
                <span>
                  saved:{" "}
                  <span className="mono" style={{ color: "var(--text-2)" }}>
                    {githubFloor ?? "—"}
                  </span>
                </span>
              </div>
            </div>

            {scriptName ? (
              <>
                <div className="flex items-center gap-2 mb-3">
                  <span className="pill pill-neutral">
                    {floor ? <>floor <span className="mono ml-1">{floor}</span></> : "first version"}
                  </span>
                  {sql.trim() && (
                    <span className={`pill ${suggestedLevel === "major" ? "pill-break" : suggestedLevel === "minor" ? "pill-sync" : "pill-pending"}`}>
                      looks {BUMP_DESC[suggestedLevel]} · suggests {suggestedLevel}
                    </span>
                  )}
                  {patchUnreachable && (
                    <span className="pill pill-drift">couldn&apos;t read applied versions</span>
                  )}
                </div>

                <div className="ver-seg" role="group" aria-label="Version bump">
                  {BUMP_LEVELS.map((level) => (
                    <button
                      key={level}
                      type="button"
                      aria-pressed={effectiveChoice === level}
                      className={`ver-seg-btn${effectiveChoice === level ? " is-active" : ""}`}
                      onClick={() => pickLevel(level)}
                    >
                      <span className="ver-seg-label">
                        {level}
                        {suggestedLevel === level && sql.trim() ? (
                          <span className="ver-seg-suggest">suggested</span>
                        ) : null}
                      </span>
                      <span className="ver-seg-ver mono">{bumpVersion(floor, level)}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-pressed={effectiveChoice === "custom"}
                    className={`ver-seg-btn${effectiveChoice === "custom" ? " is-active" : ""}`}
                    onClick={() => pickLevel("custom")}
                  >
                    <span className="ver-seg-label">custom</span>
                    <span className="ver-seg-ver mono">x.y.z</span>
                  </button>
                </div>

                {effectiveChoice === "custom" && (
                  <div className="mt-3" style={{ maxWidth: 220 }}>
                    <input
                      className="input mono"
                      placeholder={floor ? `> ${floor}` : "1.0.0"}
                      value={customVersion}
                      onChange={(e) => {
                        setCustomVersion(e.target.value);
                        setSaveResult(null);
                      }}
                      aria-label="Custom version"
                    />
                    {versionError && (
                      <p className="help mt-1" style={{ color: "var(--break)" }}>{versionError}</p>
                    )}
                  </div>
                )}

                <div
                  className="mt-4 pt-3 flex items-center justify-between gap-3"
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <div className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
                    Saves to{" "}
                    <span className="mono">
                      {databaseName || "—"}/{schema || "—"}/{scriptName}/v{versionValid ? normalizedVersion : "?"}.sql
                    </span>
                  </div>
                  <button className="btn btn-primary" disabled={!canSave} onClick={handleSave}>
                    {saving ? <RefreshIcon size={14} className="spin-icon" /> : <CheckIcon size={14} />}
                    {saving ? "Saving…" : "Save to GitHub"}
                  </button>
                </div>
              </>
            ) : (
              <p className="help">Pick a schema and a script family to set the version.</p>
            )}

            {saveResult && (
              <div
                className="mt-3 banner"
                style={
                  saveResult.ok
                    ? { background: "var(--sync-soft)", borderColor: "color-mix(in oklab, var(--sync) 30%, transparent)" }
                    : undefined
                }
              >
                {saveResult.ok ? <CheckIcon size={16} className="ico" /> : <AlertTriangleIcon size={16} className="ico" />}
                <div className="body">
                  {saveResult.ok ? (
                    <>
                      <div className="title" style={{ color: "var(--sync)" }}>Saved to GitHub.</div>
                      {saveResult.url && (
                        <a href={saveResult.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-2)" }}>
                          View the file on GitHub →
                        </a>
                      )}
                    </>
                  ) : (
                    <div className="title">{saveResult.error}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
