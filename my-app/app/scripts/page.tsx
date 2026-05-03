"use client";

import { useState, useEffect, useRef } from "react";
import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";

export default function ScriptsPage() {
  const [scripts, setScripts] = useState<any[]>([]);
  const [scriptNames, setScriptNames] = useState<string[]>([]);
  const [selectedExisting, setSelectedExisting] = useState("");
  const [newScriptName, setNewScriptName] = useState("");
  const [form, setForm] = useState({
    script_name: "",
    version: "1.0.0",
    sql_content: "",
    description: "",
  });
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);

  // Highlight the newly registered script
  const [newScriptId, setNewScriptId] = useState<number | null>(null);

  // Track which script groups are expanded
  const [expandedScripts, setExpandedScripts] = useState<Record<string, boolean>>({});

  const formRef = useRef<HTMLDivElement>(null);

  const fetchScripts = async () => {
    try {
      const res = await fetch("/api/scripts/list");
      const data = await res.json();
      if (data.scripts) {
        setScripts(data.scripts);
        const names = Array.from(
          new Set(data.scripts.map((s: any) => s.script_name))
        ).sort() as string[];
        setScriptNames(names);
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchScripts();
  }, []);

  // Auto‑set version and pre‑fill SQL/description when choosing an existing script
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

    if (selectedExisting) {
      const sameScripts = scripts.filter((s) => s.script_name === selectedExisting);
      if (sameScripts.length > 0) {
        // Get the most recent version (by date) to pre‑fill SQL and description
        const sortedByDate = [...sameScripts].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        const latest = sortedByDate[0];
        const versions = sameScripts.map((s) => s.version);
        const nextVersion = getNextVersion(versions);

        setForm((prev) => ({
          ...prev,
          script_name: selectedExisting,
          version: nextVersion,
          sql_content: latest.sql_content || "",
          description: latest.description || "",
        }));
      } else {
        setForm((prev) => ({ ...prev, script_name: selectedExisting, version: "1.0.0" }));
      }
    }
  }, [selectedExisting, newScriptName, scripts]);

  function getNextVersion(versions: string[]): string {
    if (versions.length === 0) return "1.0.0";
    const sorted = [...versions].sort();
    const latest = sorted[sorted.length - 1];
    const parts = latest.split(".");
    const last = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(last)) {
      parts[parts.length - 1] = String(last + 1);
      return parts.join(".");
    }
    return latest + ".1";
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
     if (selectedExisting && selectedExisting !== "__new__") {
    const sameScripts = scripts.filter((s) => s.script_name === selectedExisting);
    if (sameScripts.length > 0) {
      const latest = [...sameScripts].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )[0];
      if (form.sql_content.trim() === latest.sql_content.trim()) {
        setMessage({
          type: "error",
          text: "No changes detected. Modify the SQL before registering a new version.",
        });
        return; // stop submission
      }
    }
  }
    setLoading(true);

    try {
      const res = await fetch("/api/scripts/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Script registered successfully!" });
        setNewScriptId(data.script.id);

        setForm({ script_name: "", version: "1.0.0", sql_content: "", description: "" });
        setSelectedExisting("");
        setNewScriptName("");
        setShowForm(false);

        await fetchScripts();
        setExpandedScripts((prev) => ({ ...prev, [data.script.script_name]: true }));
      } else {
        setMessage({ type: "error", text: data.error || "Registration failed" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setLoading(false);
    }
  };

  // Group scripts by script_name, versions sorted oldest‑first
  const groupedScripts = scripts.reduce((acc: Record<string, any[]>, script: any) => {
    if (!acc[script.script_name]) acc[script.script_name] = [];
    acc[script.script_name].push(script);
    return acc;
  }, {});

  Object.keys(groupedScripts).forEach((name) => {
    groupedScripts[name].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
  });

  const toggleGroup = (name: string) => {
    setExpandedScripts((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  return (
    <div className="db-layout">
      <Sidebar current="SQL Scripts" />

      <main className="db-main">
        <Topbar title="SQL Scripts" text="Review and register SQL scripts." />

        {message && (
          <div className={`script-message script-message--${message.type}`}>
            {message.text}
          </div>
        )}

        <div className="script-card">
          <div className="script-header">
            <h2 className="script-card__title">Registered Scripts</h2>
            <button
              className="script-btn script-btn--primary"
              onClick={() => setShowForm(!showForm)}
            >
              {showForm ? "Cancel" : "Register New Script"}
            </button>
          </div>

          {scripts.length === 0 ? (
            <p className="script-empty">No scripts registered yet.</p>
          ) : (
            <div className="script-list">
              {Object.entries(groupedScripts).map(([name, versions]) => (
                <div key={name} className="script-group">
                  <div
                    className="script-group__header"
                    onClick={() => toggleGroup(name)}
                  >
                    <div className="script-group__info">
                      <strong>{name}</strong>
                      <span className="script-group__latest-version">
                        latest: v{versions[versions.length - 1].version}
                      </span>
                      <small className="script-group__count">
                        ({versions.length} version{versions.length !== 1 ? "s" : ""})
                      </small>
                    </div>
                    <button className="script-btn script-btn--view">
                      {expandedScripts[name] ? "Hide" : "Show"}
                    </button>
                  </div>

                  {expandedScripts[name] && (
                    <div className="script-group__versions">
                      {versions.map((script: any) => (
                        <div
                          key={script.id}
                          className={`script-version-item ${
                            script.id === newScriptId ? "script-version-item--highlight" : ""
                          }`}
                        >
                          <div className="script-version-item__left">
                            <strong>v{script.version}</strong>
                            <small className="script-description">{script.description}</small>
                            <small className="script-date">
                              {new Date(script.created_at).toLocaleString()}
                            </small>
                          </div>
                          <div className="script-version-item__sql">
                            <pre className="script-sql-preview">{script.sql_content}</pre>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {showForm && (
          <div className="script-card script-card--form" ref={formRef}>
            <div className="script-header">
              <h2 className="script-card__title">Register New / Updated Script</h2>
            </div>
            <form onSubmit={handleSubmit} className="script-form">
              <div className="script-form-row">
                <div className="script-form-field">
                  <label className="script-label">Script Name</label>
                  <select
                    value={selectedExisting}
                    onChange={(e) => setSelectedExisting(e.target.value)}
                    className="script-input script-select"
                  >
                    <option value="">-- Choose existing or new --</option>
                    <option value="__new__">+ Create new script…</option>
                    {scriptNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  {selectedExisting === "__new__" && (
                    <input
                      type="text"
                      required
                      value={newScriptName}
                      onChange={(e) => setNewScriptName(e.target.value)}
                      className="script-input script-input--new-name"
                      placeholder="Enter new script name"
                    />
                  )}
                </div>
                <div className="script-form-field">
                  <label className="script-label">
                    Version
                    {selectedExisting && selectedExisting !== "__new__" && (
                      <span className="script-label-note">(auto‑incremented)</span>
                    )}
                  </label>
                  <input
                    type="text"
                    required
                    value={form.version}
                    onChange={(e) => setForm({ ...form, version: e.target.value })}
                    className="script-input"
                    placeholder="e.g., 2.0.0"
                  />
                  {selectedExisting && selectedExisting !== "__new__" && (
                    <small className="script-version-hint">
                      Latest was{" "}
                      {scripts
                        .filter((s) => s.script_name === selectedExisting)
                        .map((s) => s.version)
                        .sort()
                        .pop() || "?"}
                      . You can change it.
                    </small>
                  )}
                </div>
              </div>
              <div className="script-form-field">
                <label className="script-label">SQL Content</label>
                <textarea
                  required
                  rows={5}
                  value={form.sql_content}
                  onChange={(e) => setForm({ ...form, sql_content: e.target.value })}
                  className="script-input script-textarea"
                  placeholder="CREATE TABLE ..."
                />
              </div>
              <div className="script-form-field">
                <label className="script-label">Description (optional)</label>
                <input
                  type="text"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="script-input"
                  placeholder="What this change does"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="script-btn script-btn--primary"
              >
                {loading ? "Registering..." : "Register Script"}
              </button>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}