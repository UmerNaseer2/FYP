// SERVER-ONLY: the lookups the schema chat's AI may make.
//
// Every lookup goes through one of the app's own read routes, called in
// process inside the chat request. The route runs its own permission check on
// the same signed-in person, so the AI can never see more than that person's
// screens would show them. Comparing is the one lookup that is not a GET
// route; it calls the Compare screen's engine directly and checks Read on
// Compare first, as the screen's route does.
//
// There are no write tools. The AI can draft SQL in its answer, which the app
// checks and the person may open in the Script Editor; nothing it says is ever
// run.
//
// What goes back to the AI is structure, cut down by hand for each lookup:
// names, types, versions, counts and states. Never a host, port, database
// name, user name, password, the email of whoever asked for or decided an
// approval, an approval's note, or a row. Two app messages can name the host
// (a database that could not be reached, a comparison that failed), so those
// are replaced with a plain "could not read".

import { NextRequest } from "next/server";
import { z } from "zod";
import type { CompareScreen } from "../compare-run";
import { buildDiffDocument, type ChangeRow } from "../compare-export";
import type { SchemaSnapshot } from "../postgres";
import type { PermissionKey } from "../permissions";
import type { AiToolSpec } from "./provider";
import { knownNames } from "./checks";
import { tableText, viewText } from "./context";
import { changeLabel } from "./features/compare-summary";

type Handler = (request: NextRequest) => Promise<Response>;

export type ChatHandlers = {
  connections: Handler;
  schemas: Handler;
  snapshot: Handler;
  versionHistory: Handler;
  lineage: Handler;
  drift: Handler;
  approvals: Handler;
  advice: Handler;
};

export type ChatToolDeps = {
  /** The chat request's own origin, so the in-process calls have a full URL. */
  baseUrl: string;
  handlers: ChatHandlers;
  compare: (query: URLSearchParams) => Promise<CompareScreen>;
  /** Null when the person has the permission, else what the app says to someone without it. */
  refusal: (key: PermissionKey) => string | null;
};

export type ToolRun = { content: string; ok: boolean };

export type ChatTools = {
  specs: AiToolSpec[];
  run: (name: string, argumentsJson: string) => Promise<ToolRun>;
  /** The connection and schema the last lookup that named both was about. */
  lastTarget: () => { connectionId: number; schema: string } | null;
  /** Every object name in the schemas the lookups returned, as knownNames gives them. */
  known: Set<string>;
  /** Every identifier-like word in anything the lookups returned, lower-cased. */
  seenWords: Set<string>;
};

/** How much one lookup may hand back, in characters (about 1,500 tokens). */
export const MAX_TOOL_OUTPUT_CHARS = 6_000;
const MAX_ERROR_CHARS = 300;
const MAX_COLUMNS_LISTED = 40;
const MAX_CHANGE_ROWS = 80;
const MAX_COLUMN_MATCHES = 60;
const MAX_VERSION_ENTRIES = 15;
const MAX_APPROVALS = 20;
const MAX_ADVICE = 25;
const MAX_TRACKED = 50;

const UNREADABLE = "The app could not read that just now.";
const UNREACHABLE =
  "The app could not reach this database when it checked. The Drift screen shows why.";
/** Statuses whose message is the app's own words about the request, safe to pass on. */
const PASS_ON = new Set([400, 403, 404, 409]);

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function clipOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return (
    text.slice(0, MAX_TOOL_OUTPUT_CHARS).trimEnd() +
    "\n[Cut short here. Ask about one table, or narrow the question, to see the rest.]"
  );
}

function errorOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as Record<string, unknown>).error;
  return typeof error === "string" && error.trim() ? error.trim() : null;
}

const id = z.coerce.number().int().positive();
const schemaArg = z.string().trim().min(1).max(128);

const ARGS = {
  list_connections: z.object({}),
  list_schemas: z.object({ connectionId: id }),
  show_schema: z.object({ connectionId: id, schema: schemaArg, table: z.string().trim().min(1).max(128).optional() }),
  find_column: z.object({ connectionId: id, schema: schemaArg, name: z.string().trim().min(1).max(128) }),
  compare_schemas: z.object({
    sourceConnectionId: id,
    sourceSchema: schemaArg,
    targetConnectionId: id,
    targetSchema: schemaArg,
  }),
  version_history: z.object({ connectionId: id, schema: schemaArg }),
  list_tracked_schemas: z.object({}),
  drift_detail: z.object({ trackedSchemaId: id }),
  deploy_approvals: z.object({ connectionId: id, schema: schemaArg, scriptName: z.string().trim().min(1).max(200).optional() }),
  performance_advice: z.object({ connectionId: id, schema: schemaArg }),
} as const;

type ToolName = keyof typeof ARGS;

const CONNECTION = { type: "integer", description: "The saved connection's id, from the list the app sent with the question." };
const SCHEMA = { type: "string", description: "The schema's name, from list_schemas." };

function spec(name: ToolName, description: string, properties: Record<string, unknown> = {}, required: string[] = []): AiToolSpec {
  return { name, description, parameters: { type: "object", properties, required } };
}

/** What the AI is told it can call. Plain JSON Schema: the free Gemini service refuses some keywords. */
export const CHAT_TOOL_SPECS: AiToolSpec[] = [
  spec("list_connections", "The saved database connections: id, name, type and environment label."),
  spec("list_schemas", "The schemas on one saved connection.", { connectionId: CONNECTION }, ["connectionId"]),
  spec(
    "show_schema",
    "One schema's structure. Without a table: every table with its columns and their types (names only for a very large schema), the views, types, routines and sequences. With a table (or view): its full definition with keys, constraints, indexes and triggers.",
    { connectionId: CONNECTION, schema: SCHEMA, table: { type: "string", description: "A table or view name, for its full definition." } },
    ["connectionId", "schema"]
  ),
  spec(
    "find_column",
    "Columns in one schema whose name contains some text, with their table, type and whether they allow nulls.",
    { connectionId: CONNECTION, schema: SCHEMA, name: { type: "string", description: "Part of a column name." } },
    ["connectionId", "schema", "name"]
  ),
  spec(
    "compare_schemas",
    "Compares two schemas the way the Compare screen does: what would change to make the target match the source, breaking changes first.",
    {
      sourceConnectionId: CONNECTION,
      sourceSchema: SCHEMA,
      targetConnectionId: CONNECTION,
      targetSchema: SCHEMA,
    },
    ["sourceConnectionId", "sourceSchema", "targetConnectionId", "targetSchema"]
  ),
  spec(
    "version_history",
    "The schema version the database's own version table records, and the recent migrations applied to it.",
    { connectionId: CONNECTION, schema: SCHEMA },
    ["connectionId", "schema"]
  ),
  spec(
    "list_tracked_schemas",
    "The schemas the app tracks for drift: id, connection, environment, registry version and the last drift state."
  ),
  spec(
    "drift_detail",
    "Checks one tracked schema against its registry version now and lists what drifted.",
    { trackedSchemaId: { type: "integer", description: "The tracked schema's id, from list_tracked_schemas." } },
    ["trackedSchemaId"]
  ),
  spec(
    "deploy_approvals",
    "Recent deploy approvals for one schema: which script, its status, when it was asked for and decided.",
    { connectionId: CONNECTION, schema: SCHEMA, scriptName: { type: "string", description: "Only this script's approvals." } },
    ["connectionId", "schema"]
  ),
  spec(
    "performance_advice",
    "The Performance screen's advice for one schema: missing indexes, unused ones and the like, most important first.",
    { connectionId: CONNECTION, schema: SCHEMA },
    ["connectionId", "schema"]
  ),
];

const SEVERITY_ORDER: Record<ChangeRow["severity"], number> = { breaking: 0, safe: 1, info: 2 };

function changeLines(rows: ChangeRow[]): string[] {
  const sorted = [...rows].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts = { breaking: 0, safe: 0, info: 0 };
  for (const row of rows) counts[row.severity] += 1;
  const lines = [`${rows.length} changes: ${counts.breaking} breaking, ${counts.safe} safe, ${counts.info} info.`];
  for (const row of sorted.slice(0, MAX_CHANGE_ROWS)) {
    const detail = row.detail ? `: ${clip(row.detail, 160)}` : "";
    lines.push(`- [${row.severity}] ${changeLabel(row)}${detail}${row.manual ? " (needs a person to plan it)" : ""}`);
  }
  if (rows.length > MAX_CHANGE_ROWS) lines.push(`(${rows.length - MAX_CHANGE_ROWS} more not listed.)`);
  return lines;
}

function list(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "none";
}

/**
 * Every table with its columns. With their types when that still fits in one
 * lookup, so a question about types needs one step instead of one per table
 * (each step is a request against the service's per-minute allowance).
 */
function schemaOutline(snapshot: SchemaSnapshot): string {
  const tables = [...snapshot.tables].sort((a, b) => a.name.localeCompare(b.name));
  const tableLines = (typed: boolean) =>
    tables.map((table) => {
      const columns = [...table.columns]
        .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
        .map((c) => (typed ? `${c.name} ${c.typeDisplay}${c.nullable ? "" : " NOT NULL"}` : c.name));
      const more = columns.length > MAX_COLUMNS_LISTED ? `, and ${columns.length - MAX_COLUMNS_LISTED} more` : "";
      return `TABLE ${table.name} (${columns.slice(0, MAX_COLUMNS_LISTED).join(", ")}${more})`;
    });
  const typed = tableLines(true);
  const fits = typed.join("\n").length <= MAX_TOOL_OUTPUT_CHARS * 0.75;
  const lines = [
    `Schema ${snapshot.schema}: ${snapshot.tables.length} tables, ${(snapshot.views ?? []).length} views.` +
      (fits ? "" : " Column types are left out to keep this short: ask for one table to see them."),
    ...(fits ? typed : tableLines(false)),
  ];
  for (const view of snapshot.views ?? []) {
    lines.push(`${view.materialized ? "MATERIALIZED VIEW" : "VIEW"} ${view.name} (${view.columns.join(", ")})`);
  }
  lines.push(`TYPES: ${list((snapshot.types ?? []).map((t) => `${t.name} (${t.kind.toLowerCase()})`))}`);
  lines.push(`ROUTINES: ${list((snapshot.routines ?? []).map((r) => `${r.name}(${r.identityArguments})`))}`);
  lines.push(`SEQUENCES: ${list((snapshot.sequences ?? []).map((s) => s.name))}`);
  return lines.join("\n");
}

function isEmpty(snapshot: SchemaSnapshot): boolean {
  return (
    snapshot.tables.length === 0 &&
    (snapshot.views ?? []).length === 0 &&
    (snapshot.types ?? []).length === 0 &&
    (snapshot.routines ?? []).length === 0 &&
    (snapshot.sequences ?? []).length === 0
  );
}

type Read = { body: unknown } | { refused: string };

export function makeChatTools(deps: ChatToolDeps): ChatTools {
  const known = new Set<string>();
  const seenWords = new Set<string>();
  const snapshots = new Map<string, SchemaSnapshot>();
  let target: { connectionId: number; schema: string } | null = null;

  async function read(handler: Handler, path: string, params: Record<string, string | number | undefined>): Promise<Read> {
    const url = new URL(path, deps.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    let response: Response;
    let body: unknown;
    try {
      response = await handler(new NextRequest(url));
      body = await response.json();
    } catch (error) {
      console.error(`Schema chat: ${path} failed:`, error instanceof Error ? error.message : error);
      return { refused: UNREADABLE };
    }
    if (response.ok) return { body };
    if (PASS_ON.has(response.status)) return { refused: clip(errorOf(body) ?? "The app refused that lookup.", MAX_ERROR_CHARS) };
    return { refused: UNREADABLE };
  }

  async function snapshotOf(connectionId: number, schema: string): Promise<SchemaSnapshot | { refused: string }> {
    const key = `${connectionId}/${schema}`;
    const cached = snapshots.get(key);
    if (cached) return cached;
    const got = await read(deps.handlers.snapshot, "/api/schema/snapshot", { connectionId, schema });
    if ("refused" in got) return got;
    const snapshot = (got.body as { snapshot?: SchemaSnapshot }).snapshot;
    if (!snapshot || !Array.isArray(snapshot.tables)) return { refused: UNREADABLE };
    if (isEmpty(snapshot)) {
      return { refused: `Schema ${schema} has nothing in it on connection ${connectionId}, or is not there. list_schemas shows what is.` };
    }
    snapshots.set(key, snapshot);
    for (const name of knownNames(snapshot)) known.add(name);
    target = { connectionId, schema };
    return snapshot;
  }

  const tools: { [K in ToolName]: (args: z.infer<(typeof ARGS)[K]>) => Promise<ToolRun> } = {
    async list_connections() {
      const got = await read(deps.handlers.connections, "/api/connections", {});
      if ("refused" in got) return { content: got.refused, ok: false };
      const rows = Array.isArray(got.body) ? (got.body as Record<string, unknown>[]) : [];
      if (rows.length === 0) return { content: "There are no saved connections.", ok: true };
      const lines = ["Saved connections (id: name, type, environment):"];
      for (const row of rows) {
        lines.push(`- ${row.id}: ${clip(String(row.name ?? ""), 80)}, ${row.type ?? "unknown type"}, ${row.environment ?? "no label"}`);
      }
      return { content: lines.join("\n"), ok: true };
    },

    async list_schemas({ connectionId }) {
      const got = await read(deps.handlers.schemas, "/api/scripts/schemas", { connectionId });
      if ("refused" in got) return { content: got.refused, ok: false };
      const schemas = (got.body as { schemas?: unknown }).schemas;
      const names = Array.isArray(schemas) ? schemas.filter((s): s is string => typeof s === "string") : [];
      return { content: `Schemas on connection ${connectionId}: ${list(names)}.`, ok: true };
    },

    async show_schema({ connectionId, schema, table }) {
      const snapshot = await snapshotOf(connectionId, schema);
      if ("refused" in snapshot) return { content: snapshot.refused, ok: false };
      if (!table) return { content: schemaOutline(snapshot), ok: true };
      const wanted = table.replace(/^"|"$/g, "");
      const lower = wanted.toLowerCase();
      const found =
        snapshot.tables.find((t) => t.name === wanted) ?? snapshot.tables.find((t) => t.name.toLowerCase() === lower);
      if (found) return { content: tableText(found), ok: true };
      const views = snapshot.views ?? [];
      const view = views.find((v) => v.name === wanted) ?? views.find((v) => v.name.toLowerCase() === lower);
      if (view) return { content: viewText(view), ok: true };
      return {
        content:
          `There is no table or view called ${wanted} in ${schema}. ` +
          `Tables: ${list(snapshot.tables.map((t) => t.name))}. Views: ${list(views.map((v) => v.name))}.`,
        ok: false,
      };
    },

    async find_column({ connectionId, schema, name }) {
      const snapshot = await snapshotOf(connectionId, schema);
      if ("refused" in snapshot) return { content: snapshot.refused, ok: false };
      const part = name.toLowerCase();
      const matches: string[] = [];
      for (const table of snapshot.tables) {
        for (const column of table.columns) {
          if (column.name.toLowerCase().includes(part)) {
            matches.push(`${table.name}.${column.name} ${column.typeDisplay}${column.nullable ? "" : " NOT NULL"}`);
          }
        }
      }
      for (const view of snapshot.views ?? []) {
        for (const column of view.columns) {
          if (column.toLowerCase().includes(part)) matches.push(`${view.name}.${column} (view column)`);
        }
      }
      if (matches.length === 0) return { content: `No column in ${schema} has "${name}" in its name.`, ok: true };
      const shown = matches.slice(0, MAX_COLUMN_MATCHES);
      const more = matches.length > shown.length ? `\n(${matches.length - shown.length} more not listed.)` : "";
      return { content: `Columns in ${schema} with "${name}" in the name:\n- ${shown.join("\n- ")}${more}`, ok: true };
    },

    async compare_schemas({ sourceConnectionId, sourceSchema, targetConnectionId, targetSchema }) {
      const refused = deps.refusal("compare:read");
      if (refused) return { content: refused, ok: false };
      const query = new URLSearchParams({
        sourceConnection: String(sourceConnectionId),
        sourceSchema,
        targetConnection: String(targetConnectionId),
        targetSchema,
        run: "1",
      });
      let screen: CompareScreen;
      try {
        screen = await deps.compare(query);
      } catch (error) {
        console.error("Schema chat: compare failed:", error instanceof Error ? error.message : error);
        return { content: UNREADABLE, ok: false };
      }
      if (screen.kind !== "ready") return { content: "There are no saved connections to compare.", ok: false };
      // The engine falls back to the first schema it finds when the one asked
      // for is not there. A report about another schema would be a wrong answer.
      if (screen.source.connectionId !== sourceConnectionId || screen.source.schema !== sourceSchema) {
        return { content: `Schema ${sourceSchema} was not found on connection ${sourceConnectionId}. list_schemas shows what is there.`, ok: false };
      }
      if (screen.source.missingMessage || screen.sourceError) {
        return { content: "The app could not read the source schema. The Compare screen shows why.", ok: false };
      }
      const outcome = screen.outcomes[0];
      if (!outcome || outcome.connectionId !== targetConnectionId || outcome.schema !== targetSchema) {
        return { content: `Schema ${targetSchema} was not found on connection ${targetConnectionId}. list_schemas shows what is there.`, ok: false };
      }
      if (outcome.sameAsSource) {
        return { content: "Those name the same schema on the same database, so there is nothing to compare.", ok: false };
      }
      if (outcome.error || !outcome.report) {
        return { content: "The app could not read the target schema. The Compare screen shows why.", ok: false };
      }
      for (const name of knownNames(outcome.report.left, outcome.report.right)) known.add(name);
      target = { connectionId: targetConnectionId, schema: targetSchema };
      const rows = buildDiffDocument(outcome.report).changes;
      if (rows.length === 0) return { content: `${sourceSchema} and ${targetSchema} have the same structure.`, ok: true };
      return {
        content: [
          `Changes to make ${targetSchema} on connection ${targetConnectionId} match ${sourceSchema} on connection ${sourceConnectionId}.`,
          ...changeLines(rows),
        ].join("\n"),
        ok: true,
      };
    },

    async version_history({ connectionId, schema }) {
      const got = await read(deps.handlers.versionHistory, "/api/compare/version-history", { connectionId, schema });
      if ("refused" in got) return { content: got.refused, ok: false };
      target = { connectionId, schema };
      const detected = (got.body as { detected?: unknown }).detected as
        | {
            table: string | null;
            version: string | null;
            recent?: {
              version: string;
              label: string | null;
              appliedAt: string | null;
              changeLevel: string | null;
              scriptName: string | null;
              succeeded: boolean | null;
              current: boolean;
            }[];
          }
        | null
        | undefined;
      if (!detected || !detected.table) {
        return { content: `Schema ${schema} on connection ${connectionId} has no version table the app recognises.`, ok: true };
      }
      const lines = [`Version table: ${detected.table}. Current version: ${detected.version ?? "none recorded"}.`];
      const recent = (detected.recent ?? []).slice(0, MAX_VERSION_ENTRIES);
      if (recent.length > 0) lines.push("Recent migrations, newest first:");
      for (const entry of recent) {
        const parts = [`- ${entry.version}`];
        if (entry.changeLevel) parts.push(`(${entry.changeLevel})`);
        if (entry.label) parts.push(`"${clip(entry.label, 120)}"`);
        if (entry.appliedAt) parts.push(`applied ${entry.appliedAt}`);
        if (entry.scriptName) parts.push(`script ${clip(entry.scriptName, 120)}`);
        if (entry.succeeded === false) parts.push("FAILED");
        if (entry.current) parts.push("(current)");
        lines.push(parts.join(" "));
      }
      return { content: lines.join("\n"), ok: true };
    },

    async list_tracked_schemas() {
      const got = await read(deps.handlers.lineage, "/api/lineage", {});
      if ("refused" in got) return { content: got.refused, ok: false };
      const items = Array.isArray(got.body) ? (got.body as Record<string, unknown>[]) : [];
      if (items.length === 0) return { content: "No schemas are tracked for drift yet.", ok: true };
      const lines = ["Tracked schemas (id: schema on connection, environment, registry version, drift):"];
      for (const item of items.slice(0, MAX_TRACKED)) {
        const status = typeof item.driftStatus === "string" ? item.driftStatus : "not checked";
        const summary =
          status === "unreachable"
            ? UNREACHABLE
            : typeof item.driftSummary === "string" && item.driftSummary
              ? clip(item.driftSummary, 200)
              : "";
        const label = typeof item.label === "string" && item.label ? ` "${clip(item.label, 60)}"` : "";
        lines.push(
          `- ${item.id}: ${item.schemaName}${label} on ${clip(String(item.connectionName ?? ""), 80)} (connection ${item.connectionId}), ` +
            `${item.environment ?? "no label"}, version ${item.headVersion ?? "none"}, ${status}` +
            (summary ? `: ${summary}` : "") +
            (item.driftCheckedAt ? `, checked ${item.driftCheckedAt}` : "")
        );
      }
      if (items.length > MAX_TRACKED) lines.push(`(${items.length - MAX_TRACKED} more not listed.)`);
      return { content: lines.join("\n"), ok: true };
    },

    async drift_detail({ trackedSchemaId }) {
      const got = await read(deps.handlers.drift, "/api/lineage/drift", { trackedSchemaId });
      if ("refused" in got) return { content: got.refused, ok: false };
      const view = got.body as {
        schemaName: string;
        environment: string;
        connection: { id: number; name: string } | null;
        expected: { version: string | null };
        state: string;
        summary: string;
        counts: Record<string, number | undefined> | null;
        report: Parameters<typeof buildDiffDocument>[0] | null;
        lastRecorded: { status: string; detectedAt: string; acknowledgedAt: string | null } | null;
      };
      if (view.connection) target = { connectionId: view.connection.id, schema: view.schemaName };
      const lines = [
        `Tracked schema ${trackedSchemaId}: ${view.schemaName} on ${view.connection ? `${clip(view.connection.name, 80)} (connection ${view.connection.id})` : "a deleted connection"}, ${view.environment}.`,
        `Registry version: ${view.expected?.version ?? "none"}. State now: ${view.state}.`,
        view.state === "unreachable" ? UNREACHABLE : clip(view.summary ?? "", 400),
      ];
      if (view.counts) {
        const c = view.counts;
        lines.push(
          `Tables added ${c.tablesAdded ?? 0}, removed ${c.tablesRemoved ?? 0}, changed ${c.tablesChanged ?? 0}; ` +
            `constraints changed ${c.constraintsChanged ?? 0}; other objects changed ${c.objectsChanged ?? 0}.`
        );
      }
      if (view.lastRecorded) {
        const r = view.lastRecorded;
        lines.push(
          `Last recorded check: ${r.status} at ${r.detectedAt}${r.acknowledgedAt ? `, acknowledged ${r.acknowledgedAt}` : ", not acknowledged"}.`
        );
      }
      if (view.report) {
        for (const name of knownNames(view.report.left, view.report.right)) known.add(name);
        const rows = buildDiffDocument(view.report).changes;
        if (rows.length > 0) {
          lines.push("What differs from the registry (the live database is the target):");
          lines.push(...changeLines(rows));
        }
      }
      return { content: lines.filter(Boolean).join("\n"), ok: true };
    },

    async deploy_approvals({ connectionId, schema, scriptName }) {
      const got = await read(deps.handlers.approvals, "/api/deploy/approvals", { connectionId, schemaName: schema, scriptName });
      if ("refused" in got) return { content: got.refused, ok: false };
      target = { connectionId, schema };
      const approvals = (got.body as { approvals?: unknown }).approvals;
      const rows = Array.isArray(approvals) ? (approvals as Record<string, unknown>[]) : [];
      if (rows.length === 0) return { content: `No deploy approvals recorded for ${schema} on connection ${connectionId}.`, ok: true };
      const lines = ["Deploy approvals, newest first (who asked and who decided are left out):"];
      for (const row of rows.slice(0, MAX_APPROVALS)) {
        const parts = [
          `- #${row.id} ${row.action ?? "deploy"} of ${clip(String(row.script_name ?? ""), 120)} to ${row.target_version}: ${row.status}`,
        ];
        if (row.self_approved) parts.push("(self-approved)");
        parts.push(`${row.migration_count} migrations, ${row.breaking_count} breaking`);
        parts.push(`asked ${row.requested_at}`);
        if (row.decided_at) parts.push(`decided ${row.decided_at}`);
        if (row.used_at) parts.push(`used ${row.used_at}`);
        if (row.expires_at) parts.push(`expires ${row.expires_at}`);
        lines.push(parts.join(", "));
      }
      if (rows.length > MAX_APPROVALS) lines.push(`(${rows.length - MAX_APPROVALS} older ones not listed.)`);
      return { content: lines.join("\n"), ok: true };
    },

    async performance_advice({ connectionId, schema }) {
      const got = await read(deps.handlers.advice, "/api/performance/advice", { connectionId, schema });
      if ("refused" in got) return { content: got.refused, ok: false };
      target = { connectionId, schema };
      const view = got.body as {
        advice?: {
          severity: string;
          title: string;
          object: string;
          detail: string;
          fix: string | null;
          origin: string;
        }[];
        counts?: { high: number; medium: number; low: number; total: number };
        tablesAnalyzed?: number;
      };
      const advice = Array.isArray(view.advice) ? view.advice : [];
      const counts = view.counts;
      const lines = [
        `Performance advice for ${schema}: ${counts ? `${counts.total} items (${counts.high} high, ${counts.medium} medium, ${counts.low} low)` : `${advice.length} items`}` +
          `${typeof view.tablesAnalyzed === "number" ? `, ${view.tablesAnalyzed} tables analysed` : ""}.`,
      ];
      for (const item of advice.slice(0, MAX_ADVICE)) {
        const head = `- [${item.severity}] ${clip(item.title, 160)} (${clip(item.object, 120)})`;
        if (item.origin === "queries") {
          // Built from searches people ran. The title and object say what to
          // index; the rest is left out.
          lines.push(`${head}, from searches run against this schema`);
        } else {
          const fix = item.fix ? ` Fix: ${clip(item.fix, 300)}` : "";
          lines.push(`${head}: ${clip(item.detail ?? "", 300)}${fix}`);
        }
      }
      if (advice.length > MAX_ADVICE) lines.push(`(${advice.length - MAX_ADVICE} more not listed.)`);
      return { content: lines.join("\n"), ok: true };
    },
  };

  async function run(name: string, argumentsJson: string): Promise<ToolRun> {
    if (!(name in ARGS)) {
      return { content: `There is no lookup called ${clip(name, 60)}. The lookups are: ${Object.keys(ARGS).join(", ")}.`, ok: false };
    }
    let raw: unknown;
    try {
      raw = argumentsJson.trim() ? JSON.parse(argumentsJson) : {};
    } catch {
      return { content: "Those arguments were not valid JSON.", ok: false };
    }
    const tool = name as ToolName;
    const parsed = ARGS[tool].safeParse(raw);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`);
      return { content: `Those arguments do not fit ${tool}: ${problems.slice(0, 3).join("; ")}.`, ok: false };
    }
    const result = await (tools[tool] as (args: unknown) => Promise<ToolRun>)(parsed.data);
    const content = clipOutput(result.content);
    for (const match of content.matchAll(/[a-z_][a-z0-9_$]*/gi)) seenWords.add(match[0].toLowerCase());
    return { content, ok: result.ok };
  }

  return { specs: CHAT_TOOL_SPECS, run, lastTarget: () => target, known, seenWords };
}
