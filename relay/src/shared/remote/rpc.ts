/**
 * The requests a phone sends the computer once its session is open
 * (pairing.ts), and the computer's answers.
 *
 * Each request carries a number the phone gives it, and its answer carries
 * the same number, so answers may come back in any order: a comparison can
 * take a while, and a list asked for after it need not wait for it.
 *
 * A phone can only look, never change anything. The computer answers every
 * request through its own copy of the app, which checks it as it checks
 * anything asked from the app's window, so a phone may do only what the
 * person signed in on the computer may do, and only with the connections
 * chosen for phones in Settings.
 *
 * Every message is read strictly, except what a successful answer holds:
 *  - the computer refuses anything that is not exactly a request it knows,
 *    and either side refuses an answer that is not exactly an answer;
 *  - a result's readers leave out any field they do not know rather than
 *    refuse it, so a newer computer can add one without breaking an older
 *    phone app. The two are updated separately: the computer's app when a
 *    new version is installed, and the phone app whenever the relay is.
 * The computer reads its own results the same way before sending them
 * (writeResult), which copies only the fields named here: nothing reaches a
 * phone that this file does not list, however much more the app's server
 * said.
 */
import { utf8, type Bytes } from "./bytes.js";
import { hasExactly, objectFields, readJsonObject } from "./json.js";

/** The biggest request a phone may send. The biggest real one, a comparison with every target, is a few kilobytes. */
export const MAX_REQUEST_BYTES = 16 * 1024;
/** How many of one phone's requests the computer works on at once. It answers any more with "busy". */
export const MAX_PENDING_REQUESTS = 4;
/**
 * The computer answers every request within this long, if only to say it
 * failed, so a phone that has heard nothing for longer can give up on it.
 */
export const ANSWER_WITHIN_MS = 120_000;
/** The most schemas one comparison compares the source with. The same as MAX_COMPARISON_TARGETS in my-app/lib/comparison-set-rules.ts. */
export const MAX_COMPARE_TARGETS = 6;
/** The longest schema name a request may hold. PostgreSQL's own limit is 63 bytes. */
export const MAX_SCHEMA_NAME_LENGTH = 128;
/** The longest error message read from an answer, in characters. The computer's own are a sentence or two. */
const MAX_ERROR_MESSAGE_LENGTH = 500;

/** A connection's environment, as the app labels it (my-app/lib/environments.ts). */
export type Environment = "unset" | "dev" | "staging" | "prod";
const ENVIRONMENTS: readonly Environment[] = ["unset", "dev", "staging", "prod"];

/** A schema in one of the computer's saved connections. */
export type SchemaRef = {
  /** The connection's number in the app on the computer. */
  connectionId: number;
  /** The schema's name, such as "public". */
  schema: string;
};

/**
 * What a phone may ask:
 *  - hello: who is signed in on the computer, and what a phone may do. A
 *    phone asks it first.
 *  - connections.list: the connections shared with phones.
 *  - schemas.list: the schemas in one shared connection's database.
 *  - schema.read: one schema's tables and views.
 *  - compare.run: compares one schema with up to MAX_COMPARE_TARGETS others,
 *    as the app's Compare screen does.
 */
export type Request =
  | { id: number; method: "hello" }
  | { id: number; method: "connections.list" }
  | { id: number; method: "schemas.list"; params: { connectionId: number } }
  | { id: number; method: "schema.read"; params: SchemaRef }
  | { id: number; method: "compare.run"; params: { source: SchemaRef; targets: SchemaRef[] } };

export type Method = Request["method"];

export type HelloResult = {
  /** Whether anyone is signed in to the app on the computer. A phone can do nothing else until someone is. */
  signedIn: boolean;
  /** The signed-in person's role, as the app names it, such as "Viewer", or null when nobody is signed in. */
  role: string | null;
  /** Whether that role may compare schemas (compare.run). */
  canCompare: boolean;
  /** Whether that role may look at a schema's tables (schema.read). */
  canReadSchemas: boolean;
  /** The version of the app on the computer, such as "1.0.0". */
  appVersion: string;
};

/** A saved connection that the computer shares with phones. Only these fields ever leave the computer: never its host, user name or password. */
export type SharedConnection = {
  id: number;
  name: string;
  environment: Environment;
  /** The database's name on its server. */
  database: string;
};

export type ConnectionList = { connections: SharedConnection[] };

export type SchemaList = { schemas: string[] };

export type ColumnOverview = {
  name: string;
  /** The column's type as PostgreSQL writes it, such as "character varying(80)". */
  type: string;
  nullable: boolean;
  /** The default value's expression, or null when it has none. */
  default: string | null;
};

export type ForeignKeyOverview = {
  columns: string[];
  /** The schema and table it points to, or null when PostgreSQL did not say. */
  referencedSchema: string | null;
  referencedTable: string | null;
  referencedColumns: string[];
};

export type TableOverview = {
  name: string;
  /** In the table's own order. */
  columns: ColumnOverview[];
  /** The primary key's columns, in order, or none when it has no primary key. */
  primaryKey: string[];
  foreignKeys: ForeignKeyOverview[];
};

export type ViewOverview = { name: string; materialized: boolean };

export type SchemaOverview = {
  database: string;
  schema: string;
  tables: TableOverview[];
  views: ViewOverview[];
};

/** One side of a comparison: the source, or one of its targets. */
export type ComparedSide = {
  /** The saved connection, or null when this side has none. */
  connectionId: number | null;
  /** The name the Compare screen shows for it. */
  name: string;
  environment: Environment;
  schema: string;
};

export type SourceSummary = ComparedSide & {
  /** Why the source could not be read, or null when it could. */
  error: string | null;
};

/**
 * How comparing with one target went:
 *  - compared: its changes are below (there may be none);
 *  - same-as-source: it is the source itself, so there is nothing to compare;
 *  - unreachable: the computer could not reach its database;
 *  - schema-missing: its database has no schema of that name;
 *  - duplicate: another target is the same schema in the same database;
 *  - no-connection: no saved connection was chosen for it;
 *  - failed: anything else went wrong.
 */
export type TargetStatus = "compared" | "same-as-source" | "unreachable" | "schema-missing" | "duplicate" | "no-connection" | "failed";
const TARGET_STATUSES: readonly TargetStatus[] = ["compared", "same-as-source", "unreachable", "schema-missing", "duplicate", "no-connection", "failed"];

export type ChangeKind = "added" | "dropped" | "changed" | "renamed" | "rename-suggested";
const CHANGE_KINDS: readonly ChangeKind[] = ["added", "dropped", "changed", "renamed", "rename-suggested"];

export type Severity = "breaking" | "safe" | "info";
const SEVERITIES: readonly Severity[] = ["breaking", "safe", "info"];

/** One change between the source and a target, as the app's diff export lists it. */
export type ChangeLine = {
  /** What kind of object changed, such as "Table" or "Column". */
  category: string;
  /** The table it belongs to, or "" for an object that belongs to the whole schema. */
  table: string;
  object: string;
  change: ChangeKind;
  severity: Severity;
  detail: string;
  /** Whether a person has to finish this change by hand. */
  manual: boolean;
};

export type TargetSummary = ComparedSide & {
  status: TargetStatus;
  /** Why it could not be compared, or null when it was. */
  error: string | null;
  /** How many changes there are, how many would break something, and how many a person has to finish by hand. */
  changes: number;
  breaking: number;
  manual: number;
  /** The changes, the ones that would break something first. A long list is cut short. */
  lines: ChangeLine[];
  /** How many changes were cut from the end of lines. */
  moreLines: number;
  /** A sentence on how these two have changed since they were last compared, or null. */
  history: string | null;
};

export type CompareSummary = { source: SourceSummary; targets: TargetSummary[] };

/** What the answer to each request holds when it succeeds. */
export type Results = {
  hello: HelloResult;
  "connections.list": ConnectionList;
  "schemas.list": SchemaList;
  "schema.read": SchemaOverview;
  "compare.run": CompareSummary;
};

/**
 * Why the computer could not do what was asked. The answer's message says it
 * in words for the person holding the phone; the code lets the phone app act
 * on it, for example by showing how to sign in on the computer.
 *  - signed-out: nobody is signed in to the app on the computer.
 *  - forbidden: the signed-in person's role may not do this.
 *  - not-shared: that connection is not shared with phones.
 *  - not-found: what the request names is not there anymore.
 *  - unreachable: the computer could not reach that database.
 *  - too-big: the answer is bigger than the link carries (link.ts).
 *  - busy: the phone has MAX_PENDING_REQUESTS requests waiting already.
 *  - bad-request: not a request the computer understands.
 *  - unknown-method: a request this version of the computer's app does not know.
 *  - failed: anything else.
 */
export type ErrorCode =
  | "signed-out"
  | "forbidden"
  | "not-shared"
  | "not-found"
  | "unreachable"
  | "too-big"
  | "busy"
  | "bad-request"
  | "unknown-method"
  | "failed";
const ERROR_CODES: readonly ErrorCode[] = [
  "signed-out",
  "forbidden",
  "not-shared",
  "not-found",
  "unreachable",
  "too-big",
  "busy",
  "bad-request",
  "unknown-method",
  "failed",
];

/** An answer as readAnswer reads it. Its result is checked with readResult, by whoever knows which request it answers. */
export type Answer = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: { code: ErrorCode; message: string } };

/**
 * What readRequest makes of a message: the request, or why it was refused.
 * The id is null when the message does not say which request it is. Then the
 * computer cannot answer, since the phone would not know what the answer is
 * for, so it closes the link instead; only a broken phone app sends one.
 */
export type RequestReading = { ok: true; request: Request } | { ok: false; id: number | null; code: "bad-request" | "unknown-method" };

const METHODS: readonly Method[] = ["hello", "connections.list", "schemas.list", "schema.read", "compare.run"];

/** Writes a request. Only its own fields are written, so a SchemaRef that carries more, such as a connection's name, goes out without it. */
export function writeRequest(request: Request): Bytes {
  const { id } = request;
  switch (request.method) {
    case "hello":
    case "connections.list":
      return writeJson({ id, method: request.method });
    case "schemas.list":
      return writeJson({ id, method: request.method, params: { connectionId: request.params.connectionId } });
    case "schema.read":
      return writeJson({ id, method: request.method, params: copySchemaRef(request.params) });
    case "compare.run": {
      const { source, targets } = request.params;
      return writeJson({ id, method: request.method, params: { source: copySchemaRef(source), targets: targets.map(copySchemaRef) } });
    }
  }
}

export function readRequest(message: Bytes): RequestReading {
  const fields = message.length <= MAX_REQUEST_BYTES ? readJsonObject(message) : null;
  const id = fields?.id;
  if (fields === null || !isPositiveInteger(id)) return { ok: false, id: null, code: "bad-request" };
  const request = readKnownRequest(id, fields);
  if (request !== null) return { ok: true, request };
  const method = fields.method;
  const unknown = typeof method === "string" && !METHODS.some((known) => known === method);
  return { ok: false, id, code: unknown ? "unknown-method" : "bad-request" };
}

/** The request in a message whose id is good, or null when it is not exactly one of the requests above. */
function readKnownRequest(id: number, fields: Record<string, unknown>): Request | null {
  const method = fields.method;
  if (method === "hello" || method === "connections.list") return hasExactly(fields, "id", "method") ? { id, method } : null;
  const params = objectFields(fields.params);
  if (!hasExactly(fields, "id", "method", "params") || params === null) return null;
  switch (method) {
    case "schemas.list": {
      const connectionId = params.connectionId;
      return hasExactly(params, "connectionId") && isPositiveInteger(connectionId) ? { id, method, params: { connectionId } } : null;
    }
    case "schema.read": {
      const ref = readSchemaRef(params);
      return ref === null ? null : { id, method, params: ref };
    }
    case "compare.run": {
      const source = readSchemaRef(params.source);
      const targets = readEach(params.targets, readSchemaRef);
      if (!hasExactly(params, "source", "targets") || source === null || targets === null) return null;
      return targets.length >= 1 && targets.length <= MAX_COMPARE_TARGETS ? { id, method, params: { source, targets } } : null;
    }
    default:
      return null;
  }
}

/**
 * Writes the answer to a request that succeeded. The result is read the way
 * the phone will read it before it is written, which keeps only the fields
 * named here and checks their types: an object that carries more, such as a
 * connection straight from the app's server with its host, goes out without
 * it.
 */
export function writeResult<M extends Method>(id: number, method: M, result: Results[M]): Bytes {
  const checked = readResult(method, result);
  if (checked === null) throw new Error(`The answer to ${method} does not have the fields that rpc.ts gives it.`);
  return writeJson({ id, result: checked });
}

/** Writes the answer to a request that could not be done. */
export function writeError(id: number, code: ErrorCode, message: string): Bytes {
  return writeJson({ id, error: { code, message } });
}

/** Reads an answer, or gives null when the message is not exactly one. An error code this version does not know is read as "failed", with its message. */
export function readAnswer(message: Bytes): Answer | null {
  const fields = readJsonObject(message);
  const id = fields?.id;
  if (fields === null || !isPositiveInteger(id)) return null;
  if (hasExactly(fields, "id", "result")) return { id, ok: true, result: fields.result };
  const error = objectFields(fields.error);
  if (!hasExactly(fields, "id", "error") || error === null || !hasExactly(error, "code", "message")) return null;
  const { code, message: text } = error;
  if (typeof code !== "string" || typeof text !== "string") return null;
  const known = isErrorCode(code) ? code : "failed";
  return { id, ok: false, error: { code: known, message: Array.from(text).slice(0, MAX_ERROR_MESSAGE_LENGTH).join("") } };
}

const RESULT_READERS: { [M in Method]: (value: unknown) => Results[M] | null } = {
  hello: readHelloResult,
  "connections.list": readConnectionList,
  "schemas.list": readSchemaList,
  "schema.read": readSchemaOverview,
  "compare.run": readCompareSummary,
};

/** Reads what a successful answer to this kind of request holds, or gives null when it is not that. */
export function readResult<M extends Method>(method: M, value: unknown): Results[M] | null {
  return RESULT_READERS[method](value);
}

function readHelloResult(value: unknown): HelloResult | null {
  const fields = objectFields(value);
  if (fields === null) return null;
  const { signedIn, role, canCompare, canReadSchemas, appVersion } = fields;
  if (typeof signedIn !== "boolean" || !isTextOrNull(role) || typeof canCompare !== "boolean" || typeof canReadSchemas !== "boolean" || typeof appVersion !== "string") return null;
  return { signedIn, role, canCompare, canReadSchemas, appVersion };
}

function readConnectionList(value: unknown): ConnectionList | null {
  const connections = readEach(objectFields(value)?.connections, readSharedConnection);
  return connections === null ? null : { connections };
}

function readSharedConnection(value: unknown): SharedConnection | null {
  const fields = objectFields(value);
  if (fields === null) return null;
  const { id, name, environment, database } = fields;
  if (!isPositiveInteger(id) || typeof name !== "string" || !isEnvironment(environment) || typeof database !== "string") return null;
  return { id, name, environment, database };
}

function readSchemaList(value: unknown): SchemaList | null {
  const schemas = readEach(objectFields(value)?.schemas, readText);
  return schemas === null ? null : { schemas };
}

function readSchemaOverview(value: unknown): SchemaOverview | null {
  const fields = objectFields(value);
  if (fields === null) return null;
  const { database, schema } = fields;
  const tables = readEach(fields.tables, readTableOverview);
  const views = readEach(fields.views, readViewOverview);
  if (typeof database !== "string" || typeof schema !== "string" || tables === null || views === null) return null;
  return { database, schema, tables, views };
}

function readTableOverview(value: unknown): TableOverview | null {
  const fields = objectFields(value);
  if (fields === null) return null;
  const name = fields.name;
  const columns = readEach(fields.columns, readColumnOverview);
  const primaryKey = readEach(fields.primaryKey, readText);
  const foreignKeys = readEach(fields.foreignKeys, readForeignKeyOverview);
  if (typeof name !== "string" || columns === null || primaryKey === null || foreignKeys === null) return null;
  return { name, columns, primaryKey, foreignKeys };
}

function readColumnOverview(value: unknown): ColumnOverview | null {
  const fields = objectFields(value);
  if (fields === null) return null;
  const { name, type, nullable } = fields;
  // "default" is a word JavaScript keeps for itself, so it cannot be a variable's name.
  const defaultValue = fields.default;
  if (typeof name !== "string" || typeof type !== "string" || typeof nullable !== "boolean" || !isTextOrNull(defaultValue)) return null;
  return { name, type, nullable, default: defaultValue };
}

function readForeignKeyOverview(value: unknown): ForeignKeyOverview | null {
  const fields = objectFields(value);
  if (fields === null) return null;
  const { referencedSchema, referencedTable } = fields;
  const columns = readEach(fields.columns, readText);
  const referencedColumns = readEach(fields.referencedColumns, readText);
  if (columns === null || !isTextOrNull(referencedSchema) || !isTextOrNull(referencedTable) || referencedColumns === null) return null;
  return { columns, referencedSchema, referencedTable, referencedColumns };
}

function readViewOverview(value: unknown): ViewOverview | null {
  const fields = objectFields(value);
  if (fields === null) return null;
  const { name, materialized } = fields;
  return typeof name === "string" && typeof materialized === "boolean" ? { name, materialized } : null;
}

function readCompareSummary(value: unknown): CompareSummary | null {
  const fields = objectFields(value);
  if (fields === null) return null;
  const source = readSourceSummary(fields.source);
  const targets = readEach(fields.targets, readTargetSummary);
  return source === null || targets === null ? null : { source, targets };
}

/** The fields both sides of a comparison have, from an object that has them. */
function readComparedSide(fields: Record<string, unknown>): ComparedSide | null {
  const { connectionId, name, environment, schema } = fields;
  if (!isPositiveIntegerOrNull(connectionId) || typeof name !== "string" || !isEnvironment(environment) || typeof schema !== "string") return null;
  return { connectionId, name, environment, schema };
}

function readSourceSummary(value: unknown): SourceSummary | null {
  const fields = objectFields(value);
  const side = fields === null ? null : readComparedSide(fields);
  const error = fields?.error;
  return side === null || !isTextOrNull(error) ? null : { ...side, error };
}

function readTargetSummary(value: unknown): TargetSummary | null {
  const fields = objectFields(value);
  const side = fields === null ? null : readComparedSide(fields);
  if (fields === null || side === null) return null;
  const { status, error, changes, breaking, manual, moreLines, history } = fields;
  const lines = readEach(fields.lines, readChangeLine);
  if (
    !isTargetStatus(status) ||
    !isTextOrNull(error) ||
    !isCount(changes) ||
    !isCount(breaking) ||
    !isCount(manual) ||
    lines === null ||
    !isCount(moreLines) ||
    !isTextOrNull(history)
  ) {
    return null;
  }
  return { ...side, status, error, changes, breaking, manual, lines, moreLines, history };
}

function readChangeLine(value: unknown): ChangeLine | null {
  const fields = objectFields(value);
  if (fields === null) return null;
  const { category, table, object, change, severity, detail, manual } = fields;
  if (
    typeof category !== "string" ||
    typeof table !== "string" ||
    typeof object !== "string" ||
    !isChangeKind(change) ||
    !isSeverity(severity) ||
    typeof detail !== "string" ||
    typeof manual !== "boolean"
  ) {
    return null;
  }
  return { category, table, object, change, severity, detail, manual };
}

/** A strict copy of a SchemaRef in a request: exactly its two fields, each of the right kind. */
function readSchemaRef(value: unknown): SchemaRef | null {
  const fields = objectFields(value);
  if (fields === null || !hasExactly(fields, "connectionId", "schema")) return null;
  const { connectionId, schema } = fields;
  return isPositiveInteger(connectionId) && isSchemaName(schema) ? { connectionId, schema } : null;
}

function copySchemaRef(ref: SchemaRef): SchemaRef {
  return { connectionId: ref.connectionId, schema: ref.schema };
}

/** Reads every item of a JSON array, or gives null when it is not an array or any item is not what `read` reads. */
function readEach<T>(value: unknown, read: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    const readItem = read(item);
    if (readItem === null) return null;
    items.push(readItem);
  }
  return items;
}

function writeJson(value: unknown): Bytes {
  return utf8(JSON.stringify(value));
}

function readText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isTextOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** A request's number or a connection's: a whole number from 1 up, small enough for JSON to carry exactly. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isPositiveIntegerOrNull(value: unknown): value is number | null {
  return value === null || isPositiveInteger(value);
}

/** How many of something there are: a whole number from 0 up. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSchemaName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_SCHEMA_NAME_LENGTH;
}

/** A check for one of a fixed list of words. */
function oneOf<T extends string>(choices: readonly T[]): (value: unknown) => value is T {
  return (value): value is T => choices.some((choice) => choice === value);
}

const isEnvironment = oneOf(ENVIRONMENTS);
const isTargetStatus = oneOf(TARGET_STATUSES);
const isChangeKind = oneOf(CHANGE_KINDS);
const isSeverity = oneOf(SEVERITIES);
const isErrorCode = oneOf(ERROR_CODES);
