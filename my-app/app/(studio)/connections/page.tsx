"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { parsePostgresUri } from "@/lib/parse-uri";
import {
  DEFAULT_SSL_MODE,
  PORT_MAX,
  PORT_MIN,
  sslModeFromLegacyBoolean,
  sslModeUsesTls,
  summariseErrors,
  toSslMode,
  validateConnection,
  type FieldErrors,
  type SslMode,
} from "@/lib/connection-validate";
import {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  ENVIRONMENT_META,
  environmentRank,
  isProduction,
  looksLikeProduction,
  toEnvironment,
  type Environment,
} from "@/lib/environments";
import {
  LogoIcon,
  PlusIcon,
  XIcon,
  CheckIcon,
  TrashIcon,
  EditIcon,
  EyeIcon,
  ClipboardIcon,
  InfoIcon,
  AlertCircleIcon,
  AlertTriangleIcon,
  LockIcon,
} from "@/components/ui/icons";

// ——— Data shapes ———
type Connection = {
  id: number;
  name: string;
  host: string;
  port: number;
  database_name: string;
  type: string;
  username: string;
  // The API never sends the connection string back (it embeds the password);
  // it only tells us whether one is stored so the UI can label/behave correctly.
  has_connection_string?: boolean;
  // `ssl` is the original boolean column; `ssl_mode` is the real setting and is
  // null on rows written before it existed. Read them through connSslMode().
  ssl: boolean;
  ssl_mode?: string | null;
  // dev / staging / prod. Null on rows written before the column existed; read
  // it through connEnvironment() so those come back as "unset" rather than
  // silently looking like a labelled target.
  environment?: string | null;
};

/** What DELETE reports when a connection is still in use. */
type Dependents = {
  trackedSchemas: number;
  schemaNames: string[];
  snapshots: number;
};

type RowResult =
  | { status: "testing" }
  | { status: "ok"; version: string; latencyMs: number }
  | { status: "err"; error: string };

type FieldMode = "uri" | "fields";
type Filter = "all" | "local" | "online" | "ssl" | Environment;

type DrawerTest =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; version: string; schemaCount: number; schemas: string[]; latencyMs: number; ssl: boolean }
  | { kind: "err"; error: string; sslRequired: boolean; detail: string };

const EMPTY_FORM = {
  name: "",
  uri: "",
  host: "localhost",
  port: "5432",
  database: "postgres",
  user: "postgres",
  password: "",
  sslMode: DEFAULT_SSL_MODE,
  environment: DEFAULT_ENVIRONMENT as Environment,
};

function isLocalHost(host: string): boolean {
  const h = (host ?? "").toLowerCase().trim();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** The TLS setting for a saved row: ssl_mode when present, else the old boolean. */
function connSslMode(conn: Connection): SslMode {
  return conn.ssl_mode ? toSslMode(conn.ssl_mode) : sslModeFromLegacyBoolean(conn.ssl);
}

/** The environment for a saved row. Anything unknown or missing reads "unset". */
function connEnvironment(conn: Connection): Environment {
  return toEnvironment(conn.environment);
}

/** The environment pill used in the table and in the delete dialog. */
function EnvironmentPill({ environment }: { environment: Environment }) {
  const meta = ENVIRONMENT_META[environment];
  return (
    <span className={`pill ${meta.pill}`} title={meta.help}>
      <span
        className="dot"
        style={environment === "unset" ? { background: "var(--text-3)" } : undefined}
      />
      {meta.label}
    </span>
  );
}

const SSL_CHOICES: { mode: SslMode; label: string; help: string }[] = [
  {
    mode: "disable",
    label: "Off",
    help: "No encryption. Normal for a localhost loopback connection.",
  },
  {
    mode: "require",
    label: "Require",
    help: "Encrypts the link but accepts whatever certificate the server presents. This is what hosted Postgres (Supabase, Neon, RDS) needs.",
  },
  {
    mode: "verify-full",
    label: "Verify full",
    help: "Encrypts and checks the certificate chain and hostname. Fails against a self-signed certificate.",
  },
];

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [groupByEnv, setGroupByEnv] = useState(false);
  const [rowResults, setRowResults] = useState<Record<number, RowResult>>({});

  // Drawer (add / edit)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [fieldMode, setFieldMode] = useState<FieldMode>("uri");
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [showPassword, setShowPassword] = useState(false);
  const [drawerTest, setDrawerTest] = useState<DrawerTest>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [formErrors, setFormErrors] = useState<FieldErrors>({});

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<Connection | null>(null);
  // Set once the API has told us the connection is still in use; the next press
  // of Delete carries confirm: true.
  const [deleteDependents, setDeleteDependents] = useState<Dependents | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Toast
  const [toastMsg, setToastMsg] = useState("");
  const [toastShow, setToastShow] = useState(false);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setToastShow(true);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastShow(false), 1800);
  }, []);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/connections");
      const data = await res.json();
      // The API answers with an array on success and { error } on failure.
      // Showing a failure as an empty list would say "you have no connections
      // yet" to someone whose connections are all still there — the single most
      // misleading thing this screen can do.
      if (!res.ok || !Array.isArray(data)) {
        setConnections([]);
        setLoadError(
          typeof data?.error === "string" ? data.error : "Could not read your saved connections."
        );
        return;
      }
      setConnections(data);
      setLoadError(null);
    } catch {
      setConnections([]);
      setLoadError("Could not reach the app server to read your connections.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Close drawer / modal on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setDrawerOpen(false);
      setDeleteTarget(null);
      setDeleteDependents(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // ——— Drawer open helpers ———
  function openAdd() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setFormErrors({});
    setFieldMode("uri");
    setShowPassword(false);
    setDrawerTest({ kind: "idle" });
    setDrawerOpen(true);
  }

  function openEdit(conn: Connection) {
    const hasUri = Boolean(conn.has_connection_string);
    setEditingId(conn.id);
    setForm({
      name: conn.name ?? "",
      uri: "", // never prefilled (it embeds the password); blank keeps the stored one
      host: conn.host ?? "localhost",
      port: String(conn.port ?? "5432"),
      database: conn.database_name ?? "postgres",
      user: conn.username ?? "postgres",
      password: "", // never prefilled; left blank keeps the stored one
      sslMode: connSslMode(conn),
      environment: connEnvironment(conn),
    });
    setFormErrors({});
    setFieldMode(hasUri ? "uri" : "fields");
    setShowPassword(false);
    setDrawerTest({ kind: "idle" });
    setDrawerOpen(true);
  }

  function quickStart(kind: "local" | "hosted") {
    if (kind === "local") {
      setForm((f) => ({
        ...f,
        uri: "postgres://postgres@localhost:5432/postgres",
        name: f.name || "Local Postgres",
        sslMode: "disable",
        // A loopback Postgres is a development database by definition. Hosted
        // is left unlabelled on purpose — only the user knows which it is.
        environment: "dev",
      }));
    } else {
      setForm((f) => ({
        ...f,
        uri: "postgres://user:password@host.neon.tech:5432/dbname?sslmode=require",
        name: f.name || "Hosted Postgres",
        sslMode: "require",
      }));
    }
    setFieldMode("uri");
    setDrawerTest({ kind: "idle" });
  }

  // Build the test/save payload from the current form + mode.
  function buildPayload() {
    const uri = form.uri.trim();
    // Only parse when there's actually a URI. On edit the field starts blank
    // (we never echo the stored string back), and a blank URI means "keep what's
    // saved" — so we must NOT parse "" into localhost/postgres defaults and
    // clobber the loose fields we loaded for this row. Fall back to those fields.
    const parsed = fieldMode === "uri" && uri ? parsePostgresUri(uri) : null;
    const fromUri = fieldMode === "uri" && parsed;
    return {
      type: "PostgreSQL",
      // ssl_mode is the setting the server acts on. The boolean is sent in step
      // with it so nothing that still reads the old `ssl` column goes stale.
      ssl: sslModeUsesTls(form.sslMode),
      ssl_mode: form.sslMode,
      environment: form.environment,
      connection_string: fieldMode === "uri" ? uri : "",
      // In Fields mode the user is defining the target by loose fields, so on
      // save any previously-stored connection string should be cleared (else
      // a stale URI would keep winning over these fields).
      clear_connection_string: fieldMode === "fields",
      host: fromUri ? parsed.host : form.host.trim(),
      port: fromUri ? parsed.port : form.port,
      database_name: fromUri ? parsed.database : form.database.trim(),
      username: fromUri ? parsed.user : form.user.trim(),
      password: fieldMode === "fields" ? form.password : "",
    };
  }

  // Apply a test-endpoint response to the drawer's result panel (shared by the
  // "test these fields" and "test the saved connection" paths below).
  function applyDrawerTestResult(data: {
    ok?: boolean;
    version?: string;
    schemaCount?: number;
    schemas?: unknown;
    latencyMs?: number;
    ssl?: boolean;
    error?: string;
    sslRequired?: boolean;
    detail?: string;
  }) {
    if (data.ok) {
      setDrawerTest({
        kind: "ok",
        version: data.version ?? "",
        schemaCount: data.schemaCount ?? 0,
        schemas: Array.isArray(data.schemas) ? (data.schemas as string[]) : [],
        latencyMs: data.latencyMs ?? 0,
        ssl: Boolean(data.ssl),
      });
    } else {
      setDrawerTest({
        kind: "err",
        error: data.error ?? "Could not connect.",
        sslRequired: Boolean(data.sslRequired),
        detail: data.detail ?? "",
      });
    }
  }

  // ——— Test (in drawer) ———
  async function runDrawerTest() {
    // URI mode with a blank field:
    if (fieldMode === "uri" && !form.uri.trim()) {
      // On EDIT the stored connection string is never echoed back, so test the
      // saved credentials by id — this is the documented "leave blank to keep
      // the stored connection string" path, and clicking Test should exercise
      // the real connection, not a blank one.
      if (editingId !== null) {
        setDrawerTest({ kind: "loading" });
        try {
          const res = await fetch("/api/connections/test-saved", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: editingId }),
          });
          applyDrawerTestResult(await res.json());
        } catch {
          setDrawerTest({ kind: "err", error: "Could not run the test.", sslRequired: false, detail: "" });
        }
        return;
      }
      // On a NEW connection there's nothing to test yet.
      setDrawerTest({
        kind: "err",
        error: "Paste a connection string first.",
        sslRequired: false,
        detail: "",
      });
      return;
    }

    // URI typed but not parseable (form.uri is non-blank here).
    if (fieldMode === "uri" && !parsePostgresUri(form.uri)) {
      setDrawerTest({
        kind: "err",
        error: "That connection string doesn't look valid.",
        sslRequired: false,
        detail: "",
      });
      return;
    }

    setDrawerTest({ kind: "loading" });
    const payload = buildPayload();
    try {
      const res = await fetch("/api/connections/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      applyDrawerTestResult(await res.json());
    } catch {
      setDrawerTest({ kind: "err", error: "Could not run the test.", sslRequired: false, detail: "" });
    }
  }

  // ——— Save ———
  async function save() {
    const name = form.name.trim();
    const payload = buildPayload();

    // A brand-new connection in URI mode has no stored string to fall back on,
    // and the validator would report that as four separate missing fields
    // instead of the one thing the user actually has to do. When *editing*, a
    // blank URI is allowed: it keeps the string already saved, and the loose
    // fields loaded for the row are what gets validated below.
    if (fieldMode === "uri" && editingId === null && !form.uri.trim()) {
      setFormErrors({ connection_string: "Paste a connection string first." });
      showToast("Paste a connection string first.");
      return;
    }

    // Exactly the rules /api/connections applies, from the same module — the
    // drawer cannot accept something the route will reject, or the reverse.
    const check = validateConnection(
      { ...payload, name },
      editingId === null ? "create" : "edit"
    );
    if (!check.ok) {
      setFormErrors(check.errors);
      showToast(summariseErrors(check.errors) || "Check the highlighted fields.");
      return;
    }
    setFormErrors({});

    setSaving(true);
    try {
      const res = await fetch("/api/connections", {
        method: editingId === null ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, name, id: editingId ?? undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        // The route returns the same field-keyed map, so a rule only it can
        // check (a duplicate name, a host it refuses to dial) lands on the
        // field it belongs to rather than in a toast that disappears.
        if (data?.errors && typeof data.errors === "object") setFormErrors(data.errors);
        showToast(data?.error ?? "Could not save the connection.");
        return;
      }
      setDrawerOpen(false);
      showToast(editingId === null ? "Connection saved" : "Connection updated");
      await reload();
    } catch {
      showToast("Could not save the connection.");
    } finally {
      setSaving(false);
    }
  }

  // ——— Row test (saved connection) ———
  async function testRow(conn: Connection) {
    setRowResults((r) => ({ ...r, [conn.id]: { status: "testing" } }));
    try {
      const res = await fetch("/api/connections/test-saved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: conn.id }),
      });
      const data = await res.json();
      if (data.ok) {
        setRowResults((r) => ({
          ...r,
          [conn.id]: { status: "ok", version: data.version, latencyMs: data.latencyMs },
        }));
        showToast(`Connection healthy · ${conn.name}`);
      } else {
        setRowResults((r) => ({ ...r, [conn.id]: { status: "err", error: data.error } }));
        showToast(`Test failed · ${conn.name}`);
      }
    } catch {
      setRowResults((r) => ({ ...r, [conn.id]: { status: "err", error: "Could not run the test." } }));
      showToast(`Test failed · ${conn.name}`);
    }
  }

  // ——— Delete ———
  function openDelete(conn: Connection) {
    setDeleteTarget(conn);
    setDeleteDependents(null);
  }

  function closeDelete() {
    setDeleteTarget(null);
    setDeleteDependents(null);
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/connections", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        // First press asks. If the API says the connection is still in use we
        // show what goes with it, and this second press confirms.
        body: JSON.stringify({ id: target.id, confirm: deleteDependents !== null }),
      });
      const data = await res.json().catch(() => null);

      if (res.status === 409 && data?.needsConfirmation) {
        setDeleteDependents(
          data.dependents ?? { trackedSchemas: 0, schemaNames: [], snapshots: 0 }
        );
        return;
      }
      if (!res.ok) {
        closeDelete();
        showToast(data?.error ?? "Could not delete the connection.");
        return;
      }

      closeDelete();
      showToast("Connection deleted");
      await reload();
    } catch {
      closeDelete();
      showToast("Could not delete the connection.");
    } finally {
      setDeleting(false);
    }
  }

  // ——— Derived view data ———
  const visible = connections.filter((c) => {
    if (filter === "local") return isLocalHost(c.host);
    if (filter === "online") return !isLocalHost(c.host);
    if (filter === "ssl") return sslModeUsesTls(connSslMode(c));
    if ((ENVIRONMENTS as readonly string[]).includes(filter)) {
      return connEnvironment(c) === filter;
    }
    return true;
  });

  // Rows split by environment, riskiest last, empty environments dropped. When
  // "Group by environment" is off this collapses to a single unheaded group so
  // the table body renders through exactly one code path either way.
  const groups: { environment: Environment | null; rows: Connection[] }[] = groupByEnv
    ? ENVIRONMENTS.slice()
        .sort((a, b) => environmentRank(a) - environmentRank(b))
        .map((environment) => ({
          environment,
          rows: visible.filter((c) => connEnvironment(c) === environment),
        }))
        .filter((group) => group.rows.length > 0)
    : [{ environment: null, rows: visible }];

  const localCount = connections.filter((c) => isLocalHost(c.host)).length;
  const onlineCount = connections.length - localCount;
  const sslCount = connections.filter((c) => sslModeUsesTls(connSslMode(c))).length;
  const envCount = (environment: Environment) =>
    connections.filter((c) => connEnvironment(c) === environment).length;
  const prodCount = envCount("prod");
  const unlabelledCount = envCount("unset");
  const healthyCount = Object.values(rowResults).filter((r) => r.status === "ok").length;
  const latencies = Object.values(rowResults).flatMap((r) =>
    r.status === "ok" ? [r.latencyMs] : []
  );
  const avgLatency =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;

  const tlsOn = sslModeUsesTls(form.sslMode);
  const sslChoice = SSL_CHOICES.find((c) => c.mode === form.sslMode) ?? SSL_CHOICES[0];

  return (
    <div style={{ background: "var(--bg)", minHeight: "100%" }}>
      {/* ——— Page header ——— */}
      <section className="px-8 pt-8 pb-2">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <div className="section-title mb-2">Connections</div>
            <h1 className="text-[28px] font-semibold tracking-[-0.018em]">Where your databases live.</h1>
            <p className="text-[13.5px] mt-1.5 max-w-[62ch]" style={{ color: "var(--text-2)" }}>
              Saved ways to reach your PostgreSQL servers — local or hosted. Test, edit, and connect
              tracked schemas through these. Passwords are never displayed.
            </p>
          </div>

          <div className="flex flex-col items-end gap-3">
            <button className="btn btn-primary btn-sm" onClick={openAdd}>
              <PlusIcon size={14} />
              Add connection
            </button>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <SummaryTile label="Total" value={String(connections.length)} />
              <SummaryTile
                label="Production"
                value={String(prodCount)}
                dot={prodCount > 0 ? "var(--break)" : "var(--text-3)"}
              />
              <SummaryTile
                label="Healthy"
                value={String(healthyCount)}
                dot={healthyCount > 0 ? "var(--sync)" : "var(--text-3)"}
              />
              <SummaryTile
                label="Avg latency"
                value={avgLatency === null ? "—" : String(avgLatency)}
                unit={avgLatency === null ? undefined : "ms"}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ——— Filters ——— */}
      <section className="px-8 pt-6 pb-3 flex items-center gap-1.5 flex-wrap">
        <FilterPill active={filter === "all"} onClick={() => setFilter("all")} count={connections.length}>
          All
        </FilterPill>
        <FilterPill active={filter === "local"} onClick={() => setFilter("local")} count={localCount}>
          Local
        </FilterPill>
        <FilterPill active={filter === "online"} onClick={() => setFilter("online")} count={onlineCount}>
          Online
        </FilterPill>
        <span className="hsep mx-1.5" />
        <FilterPill active={filter === "ssl"} onClick={() => setFilter("ssl")} count={sslCount}>
          SSL on
        </FilterPill>
        <span className="hsep mx-1.5" />
        {ENVIRONMENTS.map((environment) => (
          <FilterPill
            key={environment}
            active={filter === environment}
            onClick={() => setFilter(environment)}
            count={envCount(environment)}
          >
            {ENVIRONMENT_META[environment].label}
          </FilterPill>
        ))}
        <label
          className="flex items-center gap-2 ml-auto text-[12.5px] cursor-pointer"
          style={{ color: "var(--text-2)" }}
        >
          <input
            type="checkbox"
            checked={groupByEnv}
            onChange={(e) => setGroupByEnv(e.target.checked)}
          />
          Group by environment
        </label>
      </section>

      {/* One nudge, only while something is genuinely unlabelled. An unlabelled
          target is the state where Compare and Deploy cannot warn about prod. */}
      {!loading && !loadError && unlabelledCount > 0 && (
        <section className="px-8 pb-1">
          <div className="warn-inline">
            <span className="ico">
              <InfoIcon size={14} />
            </span>
            <div className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
              <b>
                {unlabelledCount} connection{unlabelledCount === 1 ? " has" : "s have"} no
                environment.
              </b>{" "}
              Compare and Deploy can only warn you that a target is production once it is
              labelled — edit each one and pick Dev, Staging or Production.
            </div>
          </div>
        </section>
      )}

      {/* ——— Table ——— */}
      <section className="px-8 pb-12">
        <div className="card overflow-hidden">
          {/* Scroll the table on narrow screens so the Actions column stays
              reachable instead of being clipped by the card. */}
          <div className="overflow-x-auto">
          <table className="conns responsive-table text-[13px]">
            <thead>
              <tr>
                <th>Name</th>
                <th>Environment</th>
                <th>Endpoint</th>
                <th>User</th>
                <th>SSL</th>
                <th>Server</th>
                <th>Last tested</th>
                <th style={{ textAlign: "right", width: 210 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={8} style={{ color: "var(--text-3)", textAlign: "center" }}>
                    Loading connections…
                  </td>
                </tr>
              )}

              {!loading && loadError && (
                <tr>
                  <td colSpan={8} style={{ padding: "40px 16px", textAlign: "center" }}>
                    <div className="flex flex-col items-center gap-3">
                      <div style={{ color: "var(--break)" }}>{loadError}</div>
                      <div className="help">
                        Your saved connections are still there — this screen just could not read
                        them.
                      </div>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setLoading(true);
                          reload();
                        }}
                        type="button"
                      >
                        Try again
                      </button>
                    </div>
                  </td>
                </tr>
              )}

              {!loading && !loadError && visible.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ padding: "40px 16px", textAlign: "center" }}>
                    <div className="flex flex-col items-center gap-3">
                      <div style={{ color: "var(--text-3)" }}>
                        {connections.length === 0
                          ? "No connections yet. Add your first PostgreSQL server."
                          : "No connections match this filter."}
                      </div>
                      {connections.length === 0 && (
                        <button className="btn btn-secondary btn-sm" onClick={openAdd}>
                          <PlusIcon size={14} />
                          Add connection
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )}

              {!loading &&
                !loadError &&
                groups.map((group) => (
                  <Fragment key={group.environment ?? "all"}>
                    {group.environment !== null && (
                      <tr className="group-head">
                        <td colSpan={8}>
                          <div className="flex items-center gap-2">
                            <EnvironmentPill environment={group.environment} />
                            <span className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
                              {group.rows.length} connection
                              {group.rows.length === 1 ? "" : "s"}
                            </span>
                          </div>
                        </td>
                      </tr>
                    )}
                    {group.rows.map((conn) => {
                    const result = rowResults[conn.id];
                    const dot =
                      result?.status === "ok" ? "ok" : result?.status === "err" ? "err" : "unknown";
                    const local = isLocalHost(conn.host);
                    const sslMode = connSslMode(conn);
                    return (
                      <tr key={conn.id}>
                        {/* Name */}
                        <td data-label="Name">
                          <div className="flex items-center gap-3">
                            <span className={`ind ${dot}`} aria-hidden="true" />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
                                <span className="font-medium" style={{ whiteSpace: "nowrap" }}>
                                  {conn.name}
                                </span>
                                {local ? (
                                  <span className="pill pill-neutral">
                                    <span className="dot" style={{ background: "var(--text-3)" }} />
                                    Local
                                  </span>
                                ) : (
                                  <span className="pill pill-brand">
                                    <span className="dot" />
                                    Online
                                  </span>
                                )}
                              </div>
                              <div className="mono text-[11.5px] mt-0.5" style={{ color: "var(--text-3)" }}>
                                {conn.has_connection_string ? "connection string" : "host & fields"} ·{" "}
                                <span style={{ color: "var(--text-2)" }}>{conn.database_name}</span>
                              </div>
                            </div>
                          </div>
                        </td>
                        {/* Environment */}
                        <td data-label="Environment">
                          <EnvironmentPill environment={connEnvironment(conn)} />
                        </td>
                        {/* Endpoint */}
                        <td data-label="Endpoint">
                          <div className="mono text-[12.5px] truncate" style={{ maxWidth: 320 }}>
                            {conn.host}
                            <span style={{ color: "var(--text-3)" }}>:{conn.port}/</span>
                            {conn.database_name}
                          </div>
                          <div className="text-[11px] mt-0.5" style={{ color: "var(--text-3)" }}>
                            {local ? "loopback" : "remote"} · {conn.type}
                          </div>
                        </td>
                        {/* User */}
                        <td data-label="User">
                          <span className="mono text-[12.5px]" style={{ color: "var(--text-2)" }}>
                            {conn.username || "—"}
                          </span>
                        </td>
                        {/* SSL */}
                        <td data-label="SSL">
                          {sslMode === "disable" ? (
                            <span className="pill pill-neutral">
                              <span className="dot" style={{ background: "var(--text-3)" }} />
                              off
                            </span>
                          ) : (
                            <span className="pill pill-sync">
                              <span className="dot" />
                              {sslMode === "verify-full" ? "verify" : "require"}
                            </span>
                          )}
                        </td>
                        {/* Server */}
                        <td data-label="Server">
                          <span className="mono text-[11.5px]" style={{ color: "var(--text-2)" }}>
                            {result?.status === "ok" ? result.version : "—"}
                          </span>
                        </td>
                        {/* Last tested */}
                        <td data-label="Last tested">
                          <RowTested result={result} />
                        </td>
                        {/* Actions */}
                        <td className="cell-actions" style={{ textAlign: "right" }}>
                          <div className="row-actions inline-flex gap-1 justify-end">
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => testRow(conn)}
                              disabled={result?.status === "testing"}
                            >
                              <CheckIcon size={12} />
                              Test
                            </button>
                            <button className="btn btn-ghost btn-sm" onClick={() => openEdit(conn)}>
                              <EditIcon size={12} />
                              Edit
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => openDelete(conn)}
                              style={{ color: "var(--break)" }}
                              aria-label={`Delete ${conn.name}`}
                            >
                              <TrashIcon size={12} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                    })}
                  </Fragment>
                ))}
            </tbody>
          </table>
          </div>
        </div>

        {!loading && !loadError && connections.length > 0 && (
          <div className="mt-5 text-[12px]" style={{ color: "var(--text-3)" }}>
            Showing{" "}
            <span className="mono" style={{ color: "var(--text-2)" }}>
              {visible.length} of {connections.length}
            </span>{" "}
            connections.
          </div>
        )}
      </section>

      {/* ——— Scrim + Drawer ——— */}
      <div className={`scrim ${drawerOpen ? "open" : ""}`} onClick={() => setDrawerOpen(false)} />
      <aside className={`drawer ${drawerOpen ? "open" : ""}`} aria-hidden={!drawerOpen}>
        <div className="drawer-header">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="w-7 h-7 rounded-lg grid place-items-center flex-none"
              style={{ background: "var(--brand-soft)", color: "var(--brand)" }}
            >
              <LogoIcon size={14} />
            </div>
            <div className="leading-tight min-w-0">
              <h2 className="text-[14.5px] font-semibold truncate">
                {editingId === null ? "Add connection" : `Edit ${form.name || "connection"}`}
              </h2>
              <div className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
                {editingId === null
                  ? "Reach a PostgreSQL server, local or hosted."
                  : "Update credentials, re-test, then save."}
              </div>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setDrawerOpen(false)} aria-label="Close">
            <XIcon size={14} />
          </button>
        </div>

        <div className="drawer-body">
          {/* Quick start */}
          <div className="mb-5">
            <div className="label mb-2">Quick start</div>
            <div className="flex gap-2 flex-wrap">
              <button className="pill pill-outline" onClick={() => quickStart("local")}>
                Local Postgres
              </button>
              <button className="pill pill-outline" onClick={() => quickStart("hosted")}>
                Hosted (Neon · Supabase · RDS)
              </button>
            </div>
            <div className="help mt-2">Pre-fills the SSL default. You can still edit anything below.</div>
          </div>

          {/* Name */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <label className="label">
                Friendly name <span style={{ color: "var(--break)" }}>*</span>
              </label>
              <span className="help">Shown in lists and breadcrumbs.</span>
            </div>
            <input
              className="input"
              placeholder="e.g. Staging — Neon"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <FieldError message={formErrors.name} />
          </div>

          {/* Environment — a typed label rather than a word inside the name.
              This is the field Compare and Deploy read before they touch a
              database, so "Prod — RDS" in the name above buys you nothing. */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <label className="label">Environment</label>
              <span className="help">Drives the production warnings.</span>
            </div>
            <div className="seg" role="radiogroup" aria-label="Environment" style={{ display: "flex" }}>
              {ENVIRONMENTS.map((environment) => (
                <button
                  key={environment}
                  className={form.environment === environment ? "active" : ""}
                  role="radio"
                  aria-checked={form.environment === environment}
                  onClick={() => setForm((f) => ({ ...f, environment }))}
                  type="button"
                  style={{ flex: 1 }}
                >
                  {ENVIRONMENT_META[environment].label}
                </button>
              ))}
            </div>
            <div className="help mt-1.5">{ENVIRONMENT_META[form.environment].help}</div>

            {isProduction(form.environment) && (
              <div className="warn-inline mt-2">
                <span className="ico" style={{ color: "var(--break)" }}>
                  <AlertTriangleIcon size={14} />
                </span>
                <div className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
                  Saved as production. Compare and Deploy will call this out before they
                  generate or run anything against it.
                </div>
              </div>
            )}

            {/* A nudge, never a silent write: the name is a hint about intent,
                but only the person saving the row actually knows. */}
            {!isProduction(form.environment) && looksLikeProduction(form.name) && (
              <div className="warn-inline mt-2">
                <span className="ico">
                  <InfoIcon size={14} />
                </span>
                <div className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
                  The name says production but the label doesn&apos;t.{" "}
                  <button
                    className="btn btn-ghost btn-xs"
                    onClick={() => setForm((f) => ({ ...f, environment: "prod" }))}
                    type="button"
                  >
                    Mark as production
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Mode toggle */}
          <div className="mb-3 flex items-center justify-between">
            <label className="label">Connection details</label>
            <div className="seg">
              <button
                className={fieldMode === "uri" ? "active" : ""}
                onClick={() => {
                  setFieldMode("uri");
                  setFormErrors({});
                }}
                type="button"
              >
                Connection string
              </button>
              <button
                className={fieldMode === "fields" ? "active" : ""}
                onClick={() => {
                  setFieldMode("fields");
                  setFormErrors({});
                }}
                type="button"
              >
                Fields
              </button>
            </div>
          </div>

          {/* URI mode */}
          {fieldMode === "uri" && (
            <div className="space-y-3">
              <div className="relative">
                <input
                  className="input mono"
                  style={{ paddingRight: 70 }}
                  placeholder="postgres://user:pass@host:5432/database?sslmode=require"
                  value={form.uri}
                  onChange={(e) => setForm((f) => ({ ...f, uri: e.target.value }))}
                />
                <button
                  className="btn btn-ghost btn-xs"
                  style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)" }}
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText();
                      if (text) setForm((f) => ({ ...f, uri: text.trim() }));
                    } catch {
                      showToast("Clipboard not available — paste manually.");
                    }
                  }}
                  type="button"
                >
                  <ClipboardIcon size={11} />
                  Paste
                </button>
              </div>
              <FieldError message={formErrors.connection_string} />
              {editingId !== null && (
                <div className="help">
                  Leave blank to keep the saved connection string, or paste a new one to replace it.
                </div>
              )}
              <UriPreview uri={form.uri} />
            </div>
          )}

          {/* Fields mode */}
          {fieldMode === "fields" && (
            <div className="space-y-3">
              <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 120px" }}>
                <div>
                  <div className="label mb-1">Host</div>
                  <input
                    className="input mono"
                    placeholder="db.example.com"
                    value={form.host}
                    onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
                  />
                  <FieldError message={formErrors.host} />
                </div>
                <div>
                  <div className="label mb-1">Port</div>
                  <input
                    className="input mono"
                    type="number"
                    min={PORT_MIN}
                    max={PORT_MAX}
                    placeholder="5432"
                    value={form.port}
                    onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
                  />
                  <FieldError message={formErrors.port} />
                </div>
              </div>
              <div>
                <div className="label mb-1">Database</div>
                <input
                  className="input mono"
                  placeholder="postgres"
                  value={form.database}
                  onChange={(e) => setForm((f) => ({ ...f, database: e.target.value }))}
                />
                <FieldError message={formErrors.database_name} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="label mb-1">User</div>
                  <input
                    className="input mono"
                    placeholder="postgres"
                    value={form.user}
                    onChange={(e) => setForm((f) => ({ ...f, user: e.target.value }))}
                  />
                  <FieldError message={formErrors.username} />
                </div>
                <div>
                  <div className="label mb-1">
                    Password{" "}
                    {editingId !== null && (
                      <span className="help">· blank keeps current</span>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      className="input mono"
                      style={{ paddingRight: 38 }}
                      type={showPassword ? "text" : "password"}
                      placeholder="••••••••"
                      value={form.password}
                      onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                    />
                    <button
                      className="btn btn-ghost btn-xs"
                      style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)" }}
                      onClick={() => setShowPassword((s) => !s)}
                      type="button"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      <EyeIcon size={12} />
                    </button>
                  </div>
                  <FieldError message={formErrors.password} />
                </div>
              </div>
            </div>
          )}

          {/* SSL — three modes, because "on" hid a real difference: `require`
              encrypts without checking the certificate, `verify-full` checks it. */}
          <div className="mt-6">
            <div className="flex items-center justify-between mb-2">
              <div className="label">Security</div>
              <div className="seg" role="radiogroup" aria-label="SSL mode">
                {SSL_CHOICES.map((choice) => (
                  <button
                    key={choice.mode}
                    className={form.sslMode === choice.mode ? "active" : ""}
                    role="radio"
                    aria-checked={form.sslMode === choice.mode}
                    onClick={() => setForm((f) => ({ ...f, sslMode: choice.mode }))}
                    type="button"
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            </div>
            <div className={`ssl-card ${tlsOn ? "on" : ""}`}>
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className="w-9 h-9 rounded-lg grid place-items-center flex-none"
                  style={{
                    background: tlsOn ? "var(--sync-soft)" : "var(--surface-3)",
                    color: tlsOn ? "var(--sync)" : "var(--text-3)",
                  }}
                >
                  <LockIcon size={16} />
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">
                    SSL / TLS{" "}
                    <span
                      className="mono"
                      style={{
                        color: tlsOn ? "var(--sync)" : "var(--text-3)",
                        fontWeight: 500,
                        marginLeft: 6,
                      }}
                    >
                      {form.sslMode}
                    </span>
                  </div>
                  <div className="help mt-0.5">{sslChoice.help}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Test result */}
          <div className="mt-6">
            <div className="flex items-center justify-between mb-2">
              <div className="label">Test connection</div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={runDrawerTest}
                disabled={drawerTest.kind === "loading"}
                type="button"
              >
                <CheckIcon size={12} />
                Test now
              </button>
            </div>
            <DrawerTestBanner
              test={drawerTest}
              sslOn={tlsOn}
              onEnableSsl={() => setForm((f) => ({ ...f, sslMode: "require" }))}
            />
          </div>
        </div>

        <div className="drawer-footer">
          <div className="text-[11.5px] mono" style={{ color: "var(--text-3)" }}>
            credentials stored for this workspace
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-ghost btn-sm" onClick={() => setDrawerOpen(false)} type="button">
              Cancel
            </button>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving} type="button">
              {saving ? "Saving…" : editingId === null ? "Save connection" : "Save changes"}
            </button>
          </div>
        </div>
      </aside>

      {/* ——— Delete confirm modal ——— */}
      <div
        className={`modal-scrim ${deleteTarget ? "open" : ""}`}
        role="dialog"
        aria-modal="true"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeDelete();
        }}
      >
        <div className="modal p-5">
          <div className="flex items-start gap-3">
            <div
              className="w-10 h-10 rounded-full grid place-items-center flex-none"
              style={{ background: "var(--break-soft)", color: "var(--break)" }}
            >
              <AlertTriangleIcon size={18} />
            </div>
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold tracking-[-0.005em]">
                Delete <span className="mono">{deleteTarget?.name}</span>?
              </h3>
              <p className="text-[13px] mt-1.5" style={{ color: "var(--text-2)" }}>
                This removes the saved connection. Tracked schemas that use it will lose their way to
                reach the database. This can&apos;t be undone.
              </p>

              {deleteDependents && (
                <div
                  className="mt-3 panel p-3"
                  style={{
                    background: "var(--break-soft)",
                    borderColor: "color-mix(in oklab, var(--break) 30%, transparent)",
                  }}
                >
                  <div className="text-[12.5px] font-medium" style={{ color: "var(--break)" }}>
                    Still in use by {deleteDependents.trackedSchemas} tracked schema
                    {deleteDependents.trackedSchemas === 1 ? "" : "s"}
                  </div>
                  <div className="text-[12px] mt-1" style={{ color: "var(--text-2)" }}>
                    Deleting it also removes {deleteDependents.snapshots} snapshot
                    {deleteDependents.snapshots === 1 ? "" : "s"} and their drift history.
                  </div>
                  {deleteDependents.schemaNames.length > 0 && (
                    <div className="mono text-[11.5px] mt-2" style={{ color: "var(--text-3)" }}>
                      {deleteDependents.schemaNames.slice(0, 6).join(", ")}
                      {deleteDependents.schemaNames.length > 6
                        ? `, +${deleteDependents.schemaNames.length - 6} more`
                        : ""}
                    </div>
                  )}
                </div>
              )}
              <div className="mt-3 panel p-3" style={{ background: "var(--surface-2)" }}>
                <div className="text-[12px] flex items-center justify-between">
                  <span style={{ color: "var(--text-3)" }}>Connection</span>
                  <span className="mono" style={{ color: "var(--text-2)" }}>
                    {deleteTarget
                      ? `${deleteTarget.host}:${deleteTarget.port}/${deleteTarget.database_name}`
                      : ""}
                  </span>
                </div>
                <div className="text-[12px] flex items-center justify-between mt-1">
                  <span style={{ color: "var(--text-3)" }}>SSL</span>
                  <span className="mono" style={{ color: "var(--text-2)" }}>
                    {deleteTarget ? connSslMode(deleteTarget) : ""}
                  </span>
                </div>
                <div className="text-[12px] flex items-center justify-between mt-1">
                  <span style={{ color: "var(--text-3)" }}>Environment</span>
                  {deleteTarget ? (
                    <EnvironmentPill environment={connEnvironment(deleteTarget)} />
                  ) : null}
                </div>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-5">
            <button className="btn btn-ghost btn-sm" onClick={closeDelete} type="button">
              Cancel
            </button>
            <button
              className="btn btn-destructive btn-sm"
              onClick={confirmDelete}
              disabled={deleting}
              type="button"
            >
              <TrashIcon size={12} />
              {deleting
                ? "Deleting…"
                : deleteDependents
                  ? "Delete anyway"
                  : "Delete connection"}
            </button>
          </div>
        </div>
      </div>

      {/* ——— Toast ——— */}
      <div className={`toast ${toastShow ? "show" : ""}`} role="status">
        <CheckIcon size={14} />
        <span>{toastMsg}</span>
      </div>
    </div>
  );
}

// ——— Small presentational helpers ———

/** One validation message under the field it belongs to. Renders nothing when clear. */
function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="text-[11.5px] mt-1" style={{ color: "var(--break)" }}>
      {message}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  unit,
  dot,
}: {
  label: string;
  value: string;
  unit?: string;
  dot?: string;
}) {
  return (
    <div className="card px-4 py-3" style={{ minWidth: 110 }}>
      <div className="text-[11px]" style={{ color: "var(--text-3)" }}>
        {label}
      </div>
      <div className="text-[20px] font-semibold mono mt-0.5 flex items-center gap-2">
        {dot && <span className="w-2 h-2 rounded-full" style={{ background: dot }} />}
        {value}
        {unit && (
          <span className="text-[12px]" style={{ color: "var(--text-3)", marginLeft: 2 }}>
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

function FilterPill({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className={`pill ${active ? "pill-brand" : "pill-outline"}`} onClick={onClick} type="button">
      {active && <span className="dot" />}
      {children}
      <span className="mono ml-1" style={{ opacity: 0.7 }}>
        {count}
      </span>
    </button>
  );
}

function RowTested({ result }: { result?: RowResult }) {
  if (!result) {
    return (
      <span className="text-[12.5px]" style={{ color: "var(--text-3)" }}>
        Never
      </span>
    );
  }
  if (result.status === "testing") {
    return (
      <div className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--text-2)" }}>
        <span className="spin" style={{ width: 14, height: 14 }} />
        testing…
      </div>
    );
  }
  if (result.status === "err") {
    return (
      <div className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--break)" }}>
        <AlertCircleIcon size={12} />
        failed
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <CheckIcon size={12} style={{ color: "var(--sync)" }} />
      <div className="leading-tight">
        <div className="text-[12.5px]">just now</div>
        <div className="mono text-[10.5px]" style={{ color: "var(--text-3)" }}>
          {result.latencyMs} ms
        </div>
      </div>
    </div>
  );
}

function UriPreview({ uri }: { uri: string }) {
  const parsed = parsePostgresUri(uri);
  return (
    <div className="panel p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="section-title">Parsed</span>
        <span
          className="text-[11px] mono"
          style={{ color: parsed ? "var(--sync)" : "var(--text-3)" }}
        >
          {parsed ? "parsed ok" : "awaiting input"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px]">
        <PreviewRow k="host" v={parsed?.host ?? "—"} />
        <PreviewRow k="port" v={parsed?.port ?? "—"} />
        <PreviewRow k="database" v={parsed?.database ?? "—"} />
        <PreviewRow k="user" v={parsed?.user ?? "—"} />
      </div>
    </div>
  );
}

function PreviewRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span style={{ color: "var(--text-3)" }}>{k}</span>
      <span className="mono" style={{ color: "var(--text-2)" }}>
        {v}
      </span>
    </div>
  );
}

function DrawerTestBanner({
  test,
  sslOn,
  onEnableSsl,
}: {
  test: DrawerTest;
  sslOn: boolean;
  onEnableSsl: () => void;
}) {
  if (test.kind === "idle") {
    return (
      <div className="test-banner test-load">
        <InfoIcon size={16} className="ico" />
        <div className="body">
          <div className="title">Not tested yet</div>
          <div style={{ color: "var(--text-3)" }}>
            Click <b>Test now</b> to verify the credentials before saving.
          </div>
        </div>
      </div>
    );
  }

  if (test.kind === "loading") {
    return (
      <div className="test-banner test-load">
        <span className="spin" style={{ width: 16, height: 16 }} />
        <div className="body">
          <div className="title">Connecting…</div>
          <div className="mono text-[11.5px]" style={{ color: "var(--text-3)" }}>
            resolving host · opening tcp · negotiating tls · authenticating
          </div>
        </div>
      </div>
    );
  }

  if (test.kind === "ok") {
    return (
      <div className="test-banner test-ok">
        <CheckIcon size={16} className="ico" />
        <div className="body">
          <div className="title">
            Connected. Found <span className="mono">{test.schemaCount}</span>{" "}
            {test.schemaCount === 1 ? "schema" : "schemas"}.
          </div>
          <div style={{ color: "var(--text-2)" }}>
            <span className="mono text-[11.5px]">
              {test.version.toLowerCase()} · roundtrip {test.latencyMs}ms · ssl {test.ssl ? "on" : "off"}
            </span>
          </div>
          {test.schemas.length > 0 && (
            <div className="flex gap-1.5 flex-wrap mt-2">
              {test.schemas.slice(0, 8).map((s) => (
                <span key={s} className="pill pill-neutral mono">
                  {s}
                </span>
              ))}
              {test.schemas.length > 8 && (
                <span className="pill pill-neutral mono">+{test.schemas.length - 8}</span>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // err — the message from describeDbError is already a full, actionable
  // sentence, so it carries the headline; no need for a generic second line.
  return (
    <div className="test-banner test-err">
      <AlertCircleIcon size={16} className="ico" />
      <div className="body">
        <div className="title">{test.error}</div>
        {test.sslRequired && !sslOn && (
          <button className="btn btn-secondary btn-xs mt-2" onClick={onEnableSsl} type="button">
            <LockIcon size={12} />
            Turn SSL on
          </button>
        )}
        {test.detail && (
          <details>
            <summary>Details</summary>
            <pre>{test.detail}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
