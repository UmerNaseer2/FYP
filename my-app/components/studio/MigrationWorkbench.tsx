"use client";

import { useState } from "react";
import {
  ClipboardIcon,
  CheckIcon,
  RefreshIcon,
  AlertTriangleIcon,
} from "@/components/ui/icons";

// The severity bump a migration represents. It lives here now that the Compare
// workbench owns the save-to-GitHub flow directly (the old hand-off to the
// standalone /scripts page has been folded in and that page removed).
export type ChangeKind = "breaking" | "additive" | "patch";

// ---------------------------------------------------------------------------
// MigrationWorkbench — the right-hand "Generated migration" panel (Pass 5).
//
// The server page runs the compare engine + generateMigration and hands us the
// finished SQL text plus its suggested name/description/severity. Everything
// here is presentation + light client state: edit the SQL, pick a change level,
// then push it straight to the GitHub script registry (POST /api/github/push,
// which authenticates with the workspace PAT server-side — no connection or
// local DB step needed). Applying a pushed script to a database happens later
// from the Deploy screen.
//
// Deliberately a plain <textarea>, not the mockup's contenteditable+span editor:
// it's robust, accessible, and beginner-safe. Honest stubs over fake data — the
// exact next version number is assigned from the schema's lineage when the
// target is tracked; when it isn't, the user types the version explicitly
// rather than us fabricating one.
// ---------------------------------------------------------------------------

type Props = {
  /** Rendered migration SQL from renderMigrationScript(). */
  initialSql: string;
  /** Number of real statements (0 = schemas already in sync). */
  statementCount: number;
  suggestedName: string;
  suggestedDescription: string;
  /** The schema that the migration actually modifies (right/target). */
  targetLabel: string;
  /**
   * The bare target schema name (e.g. "public"). Used as the GitHub registry
   * folder the migration is pushed into: <targetSchema>/<script_name>/v<ver>.sql
   */
  targetSchema: string;
  /** Auto-suggested change level from the statement severities. */
  suggestedKind: ChangeKind;
  counts: { breaking: number; safe: number; info: number };
  warnings: string[];
  /**
   * When the target schema is tracked (Phase 6), the real next version for each
   * change level, derived from its lineage HEAD. Null when the target isn't
   * tracked — we then show an honest "track it to assign versions" message
   * instead of a fabricated number.
   */
  targetVersions?: {
    current: string | null;
    breaking: string;
    additive: string;
    patch: string;
  } | null;
};

const LEVELS: { kind: ChangeKind; label: string; bump: string }[] = [
  { kind: "breaking", label: "breaking", bump: "major" },
  { kind: "additive", label: "additive", bump: "minor" },
  { kind: "patch", label: "patch", bump: "patch" },
];

export function MigrationWorkbench({
  initialSql,
  statementCount,
  suggestedName,
  suggestedDescription,
  targetLabel,
  targetSchema,
  suggestedKind,
  counts,
  warnings,
  targetVersions,
}: Props) {
  const [name, setName] = useState(suggestedName);
  const [description, setDescription] = useState(suggestedDescription);
  const [sql, setSql] = useState(initialSql);
  const [level, setLevel] = useState<ChangeKind>(suggestedKind);
  const [copied, setCopied] = useState(false);
  // When the target isn't tracked there's no lineage version to assign, so the
  // user types one. Defaults to a sensible first release.
  const [manualVersion, setManualVersion] = useState("1.0.0");
  const [push, setPush] = useState<
    | { kind: "idle" }
    | { kind: "pushing" }
    | { kind: "ok"; message: string; url: string | null }
    | { kind: "err"; message: string }
  >({ kind: "idle" });

  const edited = sql !== initialSql;
  // Deploy wraps each migration in its own transaction, so manual BEGIN/COMMIT/
  // ROLLBACK would conflict. Flag it the moment it appears in the editor.
  const txnViolation = /\b(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql);
  const lineCount = sql.split("\n").length;
  const bumpWord = LEVELS.find((l) => l.kind === level)?.bump ?? "minor";
  // Real next version for the selected level when the target is tracked.
  const nextVersion = targetVersions ? targetVersions[level] : null;
  // Tracked → use the lineage version; untracked → use the one the user typed.
  const effectiveVersion = (nextVersion ?? manualVersion).trim();

  const inSync = statementCount === 0;

  async function copySql() {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (e.g. insecure context) — leave the button as-is.
    }
  }

  function regenerate() {
    if (edited && !window.confirm("Regenerate will discard your manual edits. Continue?")) {
      return;
    }
    setSql(initialSql);
  }

  // Push the migration straight to the GitHub script registry. The server route
  // holds the PAT, so there's no token or connection to pick here.
  async function pushToGitHub() {
    const scriptName = name.trim() || suggestedName;
    if (!effectiveVersion) {
      setPush({ kind: "err", message: "Enter a version number first." });
      return;
    }
    if (txnViolation) {
      setPush({
        kind: "err",
        message: "Remove BEGIN / COMMIT / ROLLBACK before pushing.",
      });
      return;
    }

    setPush({ kind: "pushing" });
    try {
      const res = await fetch("/api/github/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_name: targetSchema,
          script_name: scriptName,
          version: effectiveVersion,
          sql_content: sql,
          description: description.trim() || undefined,
        }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok) {
        setPush({ kind: "err", message: data.error ?? "Push to GitHub failed." });
        return;
      }
      setPush({
        kind: "ok",
        message: `v${effectiveVersion} pushed to ${targetSchema}/${scriptName} on GitHub.`,
        url: data.url ?? null,
      });
    } catch {
      setPush({ kind: "err", message: "Network error while pushing to GitHub." });
    }
  }

  return (
    <aside>
      <div className="sticky-panel space-y-4">
        <div className="card overflow-hidden">
          {/* Header: name + description */}
          <div className="px-5 pt-4 pb-3">
            <div className="flex items-center gap-2 mb-3">
              <span className="section-title">Generated migration</span>
              <span className="pill pill-neutral">
                <span className="dot" style={{ background: "var(--text-3)" }} />
                draft
              </span>
              <span className="ml-auto text-[11px]" style={{ color: "var(--text-3)" }}>
                modifies <span className="mono">{targetLabel}</span>
              </span>
            </div>

            <label className="label" htmlFor="mw-name">
              Migration name
            </label>
            <input
              id="mw-name"
              className="input mono mt-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="migration_name"
            />
            <textarea
              className="input mt-2"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional title / description for the changelog…"
              rows={2}
              style={{ resize: "none" }}
            />
          </div>

          {inSync ? (
            <div className="px-5 pb-5">
              <p className="help">
                No migration statements are needed — the two schemas are already in
                sync. There is nothing to save.
              </p>
            </div>
          ) : (
            <>
              {/* SQL editor */}
              <div className="px-5 pb-2">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="section-title">SQL</span>
                    <span className="pill pill-sync">
                      <span className="dot" />
                      editable
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={regenerate}
                      title="Reset the SQL to the freshly generated version (discards manual edits)"
                    >
                      <RefreshIcon size={12} />
                      Regenerate
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={copySql}>
                      {copied ? <CheckIcon size={12} /> : <ClipboardIcon size={12} />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>

                <textarea
                  className="sql-textarea mono"
                  value={sql}
                  onChange={(e) => setSql(e.target.value)}
                  spellCheck={false}
                />

                <div
                  className="flex items-center justify-between mt-1.5 text-[11px]"
                  style={{ color: "var(--text-3)" }}
                >
                  <span>
                    {lineCount} lines · {statementCount} statement
                    {statementCount === 1 ? "" : "s"} · SQL
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: edited ? "var(--drift)" : "var(--text-3)" }}
                    />
                    {edited ? "Edited" : "Unedited"}
                  </span>
                </div>

                {/* Severity tally from the generator */}
                <div className="flex items-center gap-1.5 mt-3">
                  <span className="delta delta-rem" style={counts.breaking ? undefined : { opacity: 0.45 }}>
                    {counts.breaking} breaking
                  </span>
                  <span className="delta delta-add" style={counts.safe ? undefined : { opacity: 0.45 }}>
                    {counts.safe} safe
                  </span>
                  <span className="delta delta-chg" style={counts.info ? undefined : { opacity: 0.45 }}>
                    {counts.info} info
                  </span>
                </div>

                {/* Transaction-control guardrail */}
                {txnViolation && (
                  <div className="warn-inline mt-3">
                    <span className="ico">
                      <AlertTriangleIcon size={14} />
                    </span>
                    <div>
                      <b>Transaction control isn&apos;t allowed.</b> Deploy wraps each
                      migration in its own transaction. Remove <span className="mono">BEGIN</span>{" "}
                      / <span className="mono">COMMIT</span> / <span className="mono">ROLLBACK</span>{" "}
                      before deploying.
                    </div>
                  </div>
                )}

                {/* Generator warnings (e.g. tables/columns only in target — not dropped) */}
                {warnings.length > 0 && (
                  <div className="warn-inline mt-3" style={{ flexDirection: "column", gap: 6 }}>
                    <div className="flex items-center gap-2">
                      <span className="ico">
                        <AlertTriangleIcon size={14} />
                      </span>
                      <b>Not included in this migration ({warnings.length})</b>
                    </div>
                    <ul className="space-y-1 mt-1" style={{ paddingLeft: 22 }}>
                      {warnings.map((w) => (
                        <li key={w} className="text-[12px]" style={{ color: "var(--text-2)" }}>
                          {w}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Change level + derived version */}
              <div
                className="px-5 py-4"
                style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="section-title">Change level</span>
                  <span className="text-[11px]" style={{ color: "var(--text-3)" }}>
                    auto-suggested
                  </span>
                </div>
                <div className="seg" role="group" aria-label="Change level">
                  {LEVELS.map((l) => (
                    <button
                      key={l.kind}
                      type="button"
                      className={`lvl-${l.kind}${level === l.kind ? " active" : ""}`}
                      onClick={() => setLevel(l.kind)}
                      aria-pressed={level === l.kind}
                    >
                      <span className="swatch" />
                      {l.label}
                    </button>
                  ))}
                </div>

                {nextVersion ? (
                  <div
                    className="panel p-3 mt-4 flex items-center justify-between"
                    style={{ background: "var(--surface)" }}
                  >
                    <div>
                      <div className="text-[11px]" style={{ color: "var(--text-3)" }}>
                        Next version in lineage
                      </div>
                      <div className="text-[15px] mt-0.5 font-semibold mono">
                        v{nextVersion}
                      </div>
                    </div>
                    <span className="help text-right max-w-[200px]">
                      <span className="mono">{targetLabel}</span> is at{" "}
                      <span className="mono">v{targetVersions?.current ?? "?"}</span>; a{" "}
                      {bumpWord} change bumps to this.
                    </span>
                  </div>
                ) : (
                  <div
                    className="panel p-3 mt-4 flex items-center justify-between"
                    style={{ background: "var(--surface)" }}
                  >
                    <div>
                      <div className="text-[11px]" style={{ color: "var(--text-3)" }}>
                        Will become
                      </div>
                      <div className="text-[15px] mt-0.5 font-semibold">
                        {bumpWord} bump
                      </div>
                    </div>
                    <span className="help text-right max-w-[200px]">
                      <span className="mono">{targetLabel}</span> isn&apos;t tracked yet —
                      track it to assign exact versions from its lineage.
                    </span>
                  </div>
                )}
              </div>

              {/* Footer: push to the GitHub registry */}
              <div
                className="px-5 py-3 space-y-3"
                style={{ borderTop: "1px solid var(--border)" }}
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  {/* Untracked targets have no lineage version — collect one. */}
                  {nextVersion ? (
                    <div className="text-[12px]" style={{ color: "var(--text-3)" }}>
                      Pushing as <span className="mono" style={{ color: "var(--text-2)" }}>v{nextVersion}</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <label className="label" htmlFor="mw-version">
                        Version
                      </label>
                      <input
                        id="mw-version"
                        className="input mono"
                        style={{ width: 110 }}
                        value={manualVersion}
                        onChange={(e) => setManualVersion(e.target.value)}
                        placeholder="1.0.0"
                      />
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={pushToGitHub}
                    disabled={push.kind === "pushing" || txnViolation}
                  >
                    {push.kind === "pushing" ? "Pushing…" : "Push to GitHub"}
                  </button>
                </div>

                {/* Inline push result */}
                {push.kind === "ok" && (
                  <div className="warn-inline" style={{ background: "var(--sync-soft)" }}>
                    <span className="ico" style={{ color: "var(--sync)" }}>
                      <CheckIcon size={14} />
                    </span>
                    <div>
                      {push.message}
                      {push.url && (
                        <>
                          {" "}
                          <a
                            href={push.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "var(--brand)", textDecoration: "underline" }}
                          >
                            View on GitHub
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                )}
                {push.kind === "err" && (
                  <div className="warn-inline">
                    <span className="ico">
                      <AlertTriangleIcon size={14} />
                    </span>
                    <div>{push.message}</div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* "What this will do" — honest about which steps exist today */}
        {!inSync && (
          <div className="card p-4">
            <div className="section-title mb-2">What this will do</div>
            <ul className="space-y-1.5 text-[12.5px]" style={{ color: "var(--text-2)" }}>
              <li className="flex gap-2">
                <span style={{ color: "var(--sync)" }}>●</span>
                Push this migration to the GitHub registry at{" "}
                <span className="mono">{targetSchema}/{name.trim() || suggestedName}/v{effectiveVersion}.sql</span>.
              </li>
              <li className="flex gap-2">
                <span style={{ color: "var(--sync)" }}>●</span>
                Make it available to apply to a database from{" "}
                <span className="mono">Deploy</span>.
              </li>
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}
