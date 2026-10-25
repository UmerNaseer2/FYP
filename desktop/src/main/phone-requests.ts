/**
 * Answers a phone's requests (src/shared/remote/rpc.ts) by asking Schema
 * Studio's own server, the way the app's window does: through the routes the
 * window uses, with the sign-in cookie of whoever is signed in on the
 * computer. So the server checks a phone's request exactly as it checks a
 * click in the window, and a phone may do only what that person's role may.
 *
 * On top of that, a phone may use only the connections shared with phones in
 * Settings. That is checked here, before the server is asked anything, so a
 * request about any other connection never reaches it.
 *
 * A phone may change only two things. It may turn its own drift alerts on
 * and off: push.subscribe turns them on only while the role signed in on the
 * computer may see drift in the app (drift:read), since drift is what they
 * show, and src/main/phone-link.ts checks that again before each alert it
 * sends. push.unsubscribe needs no permission at all: turning alerts off
 * shows a phone nothing. And it may approve or reject a deploy or rollback
 * request, which src/main/phone-approvals.ts answers: only with a passkey
 * set up on that phone, and only as the person who set it up.
 *
 * Nothing the server says in words reaches a phone. Its error messages can
 * name a database's host or repeat what the database said, so a refusal is
 * always one of the fixed sentences in REFUSALS, picked by the answer's
 * status, and the server's words go to the computer's log. A result is copied
 * field by field into the shapes rpc.ts names, and writeResult checks it
 * again, so a field the server adds one day stays on the computer.
 *
 * Pure apart from the log: the server is asked through `call`, and a phone's
 * drift alerts are kept through `alerts`, so the tests can play both parts.
 */
import { readPushSubscription, type PushSubscriptionFields } from "../core/web-push";
import type { Bytes } from "../shared/remote/bytes";
import { objectFields } from "../shared/remote/json";
import {
  isSchemaName,
  readResult,
  writeError,
  writeResult,
  type CompareSummary,
  type ConnectionList,
  type ApprovalList,
  type ApprovalRead,
  type DecideParams,
  type DecisionChallenge,
  type ErrorCode,
  type HelloResult,
  type NewPasskeyParams,
  type PasskeyChallenge,
  type PasskeyState,
  type PushStatus,
  type PushSubscriptionParams,
  type Request,
  type SchemaList,
  type SchemaOverview,
  type SchemaRef,
} from "../shared/remote/rpc";
import { logWarn } from "./log";

/** What the app's server answered: the status, and the body read as JSON, or null when it was not JSON. */
export type AppAnswer = { status: number; json: unknown };

/**
 * Asks the app's server, as the app's window would. It throws when no answer
 * came back at all, and as soon as `signal` aborts.
 */
export type AppCaller = (method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal) => Promise<AppAnswer>;

/** The drift alerts of one paired phone, as src/main/phone-link.ts keeps them. */
export type PhoneAlerts = {
  /** The computer's public push key, as base64url, which the phone's browser turns alerts on with. */
  key: string;
  /** Whether the phone has drift alerts on. */
  on: () => boolean;
  /** Turns the phone's drift alerts on with this subscription, or off with null, and saves that. */
  set: (subscription: PushSubscriptionFields | null) => void;
};

/**
 * The approval requests of one paired phone, which src/main/phone-approvals.ts
 * answers. Each throws a Refused for a refusal.
 */
export type PhoneApprovalRequests = {
  list: (signal: AbortSignal) => Promise<ApprovalList>;
  read: (approvalId: number, signal: AbortSignal) => Promise<ApprovalRead>;
  beginPasskey: () => PasskeyChallenge;
  finishPasskey: (params: NewPasskeyParams, signal: AbortSignal) => Promise<{ passkey: PasskeyState }>;
  beginDecision: () => DecisionChallenge;
  decide: (params: DecideParams, signal: AbortSignal) => Promise<{ status: "approved" | "rejected" }>;
};

export type RequestOptions = {
  call: AppCaller;
  /** The connections shared with phones. Read for every request, so a change in Settings counts at once. */
  sharedConnectionIds: () => readonly number[];
  /** The version of the app on the computer, for hello. */
  appVersion: string;
  /** The drift alerts of the phone that asked, which push.status, push.subscribe and push.unsubscribe answer about. */
  alerts: PhoneAlerts;
  /** The approval requests of the phone that asked. */
  approvals: PhoneApprovalRequests;
};

/**
 * Why the computer answers with an error: the codes rpc.ts gives a phone, and
 * five more that tell the person more than "failed", "bad-request" or
 * "forbidden" alone would.
 */
export type Refusal = ErrorCode | "access-unknown" | "bad-subscription" | "no-answer" | "too-slow" | "sql-missing";

/** The code and the sentence each refusal sends: words for the person holding the phone, with nothing from the server in them. */
export const REFUSALS: Readonly<Record<Refusal, { code: ErrorCode; message: string }>> = {
  "signed-out": { code: "signed-out", message: "Nobody is signed in to Schema Studio on the computer. Sign in there, then try again." },
  forbidden: { code: "forbidden", message: "The role signed in on the computer may not do this." },
  "not-shared": { code: "not-shared", message: "That connection is not shared with phones. Share it in Schema Studio's Settings on the computer." },
  "not-found": { code: "not-found", message: "That is not on the computer anymore." },
  unreachable: { code: "unreachable", message: "The computer could not reach that database." },
  "too-big": { code: "too-big", message: "The answer is too big to send to a phone." },
  busy: { code: "busy", message: "The phone has too many requests waiting. Try again in a moment." },
  "bad-request": { code: "bad-request", message: "The computer could not read that request. Reload the phone app, then try again." },
  "unknown-method": { code: "unknown-method", message: "Schema Studio on the computer is too old for that. Update it, then try again." },
  "not-allowed": {
    code: "not-allowed",
    message: "Approvals are not allowed for this phone right now. Choose Allow approvals for it in Schema Studio's Settings on the computer, then try again within 5 minutes.",
  },
  "no-passkey": {
    code: "no-passkey",
    message: "Approvals are not set up on this phone yet. Allow them in Schema Studio's Settings on the computer, then set them up here.",
  },
  "passkey-refused": { code: "passkey-refused", message: "The computer could not check the passkey's signature, so nothing changed. Try again." },
  "other-person": {
    code: "other-person",
    message: "The person signed in on the computer is not the one who set up approvals on this phone. Set them up again to decide as whoever is signed in now.",
  },
  changed: { code: "changed", message: "Something changed on the computer while you were deciding. Look at the request again, then try again." },
  "already-decided": { code: "already-decided", message: "That request is no longer waiting for a decision." },
  "own-request": { code: "own-request", message: "The person signed in on the computer asked for this request, so someone else has to decide it." },
  expired: { code: "expired", message: "Nothing was decided, because that took too long or the computer restarted. Try again." },
  failed: { code: "failed", message: "The computer could not do that. Its log has the details." },
  "access-unknown": { code: "failed", message: "The computer could not check what the signed-in role may do. Try again in a moment." },
  "bad-subscription": {
    code: "bad-request",
    message: "The computer cannot send drift alerts through this browser's push service. Try another browser on the phone.",
  },
  "no-answer": { code: "failed", message: "Schema Studio on the computer did not answer. Try again in a moment." },
  "too-slow": { code: "failed", message: "The computer took too long to answer." },
  "sql-missing": {
    code: "forbidden",
    message: "The computer cannot show the SQL this request runs, so it cannot be approved from a phone. Reject it here, or decide it in Schema Studio on the computer.",
  },
};

/** The longest piece of the server's error message that goes in the log, in characters. */
const MAX_LOGGED_WORDS = 200;

/** The answer that refuses request `id`, for this reason. */
export function writeRefusal(id: number, refusal: Refusal): Bytes {
  const { code, message } = REFUSALS[refusal];
  return writeError(id, code, message);
}

/**
 * The answer to a request, ready to send. It never throws: whatever goes
 * wrong is answered with a refusal, and anything unexpected is logged here.
 * Once `signal` aborts, the phone has gone or has been told the computer took
 * too long, so nothing is logged and what this gives is not sent.
 */
export async function answerRequest(request: Request, options: RequestOptions, signal: AbortSignal): Promise<Bytes> {
  try {
    return await answerOf(request, options, signal);
  } catch (error) {
    if (error instanceof Refused) return writeRefusal(request.id, error.refusal);
    if (!signal.aborted) logWarn(`The phone link could not answer a phone's ${request.method}.`, error);
    return writeRefusal(request.id, "failed");
  }
}

/** Thrown in this file, and in src/main/phone-approvals.ts, to answer with a refusal instead of a result. */
export class Refused extends Error {
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super(REFUSALS[refusal].message);
    this.refusal = refusal;
  }
}

async function answerOf(request: Request, options: RequestOptions, signal: AbortSignal): Promise<Bytes> {
  const { id } = request;
  switch (request.method) {
    case "hello":
      return writeResult(id, "hello", await hello(options, signal));
    case "connections.list":
      return writeResult(id, "connections.list", await listConnections(options, signal));
    case "schemas.list":
      return writeResult(id, "schemas.list", await listSchemas(request.params.connectionId, options, signal));
    case "schema.read":
      return writeResult(id, "schema.read", await readSchema(request.params, options, signal));
    case "compare.run":
      return writeResult(id, "compare.run", await compare(request.params.source, request.params.targets, options, signal));
    case "push.status":
      return writeResult(id, "push.status", pushStatus(options.alerts));
    case "push.subscribe":
      return writeResult(id, "push.subscribe", await subscribe(request.params, options, signal));
    case "push.unsubscribe":
      options.alerts.set(null);
      return writeResult(id, "push.unsubscribe", pushStatus(options.alerts));
    case "approvals.list":
      return writeResult(id, "approvals.list", await options.approvals.list(signal));
    case "approvals.read":
      return writeResult(id, "approvals.read", await options.approvals.read(request.params.approvalId, signal));
    case "passkey.begin":
      return writeResult(id, "passkey.begin", options.approvals.beginPasskey());
    case "passkey.finish":
      return writeResult(id, "passkey.finish", await options.approvals.finishPasskey(request.params, signal));
    case "approvals.begin":
      return writeResult(id, "approvals.begin", options.approvals.beginDecision());
    case "approvals.decide":
      return writeResult(id, "approvals.decide", await options.approvals.decide(request.params, signal));
  }
}

/**
 * Who is signed in, from the app's GET /api/me, which answers with the role
 * the server acts as. Nobody signed in is an answer here, not a refusal:
 * finding that out is what a phone asks hello for.
 */
async function hello(options: RequestOptions, signal: AbortSignal): Promise<HelloResult> {
  let json: unknown;
  try {
    json = await ask(options, "GET", "/api/me", undefined, signal);
  } catch (error) {
    if (error instanceof Refused && error.refusal === "signed-out") {
      return { signedIn: false, role: null, canCompare: false, canReadSchemas: false, appVersion: options.appVersion };
    }
    throw error;
  }
  const { me, permissions } = readMe(json);
  const may = (key: string): boolean => permissions.includes(key);
  return {
    signedIn: true,
    // The role's name as the app shows it, such as "Viewer", or its key when it has no name.
    role: typeof me.roleLabel === "string" ? me.roleLabel : typeof me.role === "string" ? me.role : null,
    // What POST /api/compare/phone asks for.
    canCompare: may("compare:read"),
    // GET /api/schema/snapshot asks for Visualizer, and GET /api/lineage/schemas, which lists the schemas to pick from, for any one of these three.
    canReadSchemas: may("visualizer:read") && (may("dashboard:read") || may("compare:read") || may("performance:read")),
    appVersion: options.appVersion,
  };
}

/** What GET /api/me answered with, and the keys of the role's permissions in it, such as "drift:read". */
function readMe(json: unknown): { me: Record<string, unknown>; permissions: unknown[] } {
  const me = objectFields(json);
  const permissions = me?.permissions;
  if (me === null || !Array.isArray(permissions)) throw new Error("GET /api/me did not answer with a list of permissions.");
  // The server could not read the role from its database, so the list says nothing about what the role may do.
  if (me.accessUnavailable === true) throw new Refused("access-unknown");
  return { me, permissions };
}

/**
 * The connections shared with phones, from the app's GET
 * /api/connections/phone, which answers with only what Compare's pickers
 * show. They come in the app's order, and a shared connection that has been
 * deleted is simply not there.
 */
async function listConnections(options: RequestOptions, signal: AbortSignal): Promise<ConnectionList> {
  const shared = new Set(options.sharedConnectionIds());
  const rows = objectFields(await ask(options, "GET", "/api/connections/phone", undefined, signal))?.connections;
  if (!Array.isArray(rows)) throw new Error("GET /api/connections/phone did not answer with a list of connections.");
  const connections = rows.flatMap((row) => {
    const fields = objectFields(row);
    if (fields === null || typeof fields.id !== "number" || !shared.has(fields.id)) return [];
    return [{ id: fields.id, name: fields.name, environment: fields.environment, database: fields.database }];
  });
  // A shared connection the app describes wrongly is a bug worth hearing
  // about, so it fails the whole list instead of quietly going missing.
  const list = readResult("connections.list", { connections });
  if (list === null) throw new Error("GET /api/connections/phone answered with a connection the phone link cannot read.");
  return list;
}

/**
 * The schemas in a shared connection's database, from the app's GET
 * /api/lineage/schemas, which lists them as Compare's pickers do. A name that
 * a request could not hold (isSchemaName) is left out, so a phone is never
 * shown a schema it cannot ask about.
 */
async function listSchemas(connectionId: number, options: RequestOptions, signal: AbortSignal): Promise<SchemaList> {
  checkShared([connectionId], options);
  const schemas = objectFields(await ask(options, "GET", `/api/lineage/schemas?connectionId=${connectionId}`, undefined, signal))?.schemas;
  if (!Array.isArray(schemas)) throw new Error("GET /api/lineage/schemas did not answer with a list of schemas.");
  return { schemas: schemas.filter(isSchemaName) };
}

/**
 * A shared schema's tables and views, from the app's GET
 * /api/schema/snapshot: the same capture that Compare and the Visualizer
 * read, cut down to what a phone shows.
 */
async function readSchema(ref: SchemaRef, options: RequestOptions, signal: AbortSignal): Promise<SchemaOverview> {
  checkShared([ref.connectionId], options);
  const path = `/api/schema/snapshot?connectionId=${ref.connectionId}&schema=${encodeURIComponent(ref.schema)}`;
  const snapshot = objectFields(objectFields(await ask(options, "GET", path, undefined, signal))?.snapshot);
  const overview = snapshot === null ? null : readResult("schema.read", overviewOf(snapshot));
  if (overview === null) throw new Error("GET /api/schema/snapshot answered with a schema the phone link cannot read.");
  return overview;
}

/**
 * A capture (SchemaSnapshot in my-app/lib/postgres.ts) in the shape of a
 * SchemaOverview, field by field. Nothing is checked here: readResult checks
 * what comes out, and refuses a list that was not a list, which stays null.
 */
function overviewOf(snapshot: Record<string, unknown>): unknown {
  return {
    database: snapshot.database,
    schema: snapshot.schema,
    tables: mapEach(snapshot.tables, (table) => ({
      name: table.name,
      columns: mapEach(table.columns, (column) => ({
        name: column.name,
        type: column.typeDisplay,
        nullable: column.nullable,
        default: column.columnDefault,
      })),
      // A table without a primary key has null here.
      primaryKey: table.primaryKey === null ? [] : objectFields(table.primaryKey)?.columns,
      foreignKeys: mapEach(table.foreignKeys, (key) => ({
        columns: key.columns,
        referencedSchema: key.referencedSchema,
        referencedTable: key.referencedTable,
        referencedColumns: key.referencedColumns,
      })),
    })),
    // A capture leaves views out when it did not record them (see the note
    // on SchemaSnapshot). Compare must not read that as "no views", but a
    // phone only shows what there is, so none is the honest thing to show.
    views: snapshot.views === undefined ? [] : mapEach(snapshot.views, (view) => ({ name: view.name, materialized: view.materialized })),
  };
}

/** Each object in a list, mapped, with null for an item that is not an object; or null when it is not a list. */
function mapEach(value: unknown, map: (fields: Record<string, unknown>) => unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) => {
    const fields = objectFields(item);
    return fields === null ? null : map(fields);
  });
}

/**
 * Compares a shared schema with shared others through the app's POST
 * /api/compare/phone, which runs the Compare screen's own comparison and
 * answers with the summary rpc.ts describes.
 */
async function compare(source: SchemaRef, targets: readonly SchemaRef[], options: RequestOptions, signal: AbortSignal): Promise<CompareSummary> {
  checkShared([source, ...targets].map((ref) => ref.connectionId), options);
  const summary = readResult("compare.run", await ask(options, "POST", "/api/compare/phone", { source, targets }, signal));
  if (summary === null) throw new Error("POST /api/compare/phone answered with a summary the phone link cannot read.");
  return summary;
}

function pushStatus(alerts: PhoneAlerts): PushStatus {
  return { key: alerts.key, subscribed: alerts.on() };
}

/**
 * Turns the phone's drift alerts on with the subscription its browser made,
 * once the signed-in role turns out to be one that may see drift. A
 * subscription the computer would not send to (readPushSubscription) is
 * refused before the server is asked anything.
 */
async function subscribe(params: PushSubscriptionParams, options: RequestOptions, signal: AbortSignal): Promise<PushStatus> {
  const subscription = readPushSubscription(params);
  if (subscription === null) throw new Refused("bad-subscription");
  await checkDriftAlerts(options, signal);
  // A phone that has stopped waiting never hears that its alerts are on, so
  // they stay off rather than arrive as a surprise.
  signal.throwIfAborted();
  options.alerts.set(subscription);
  return pushStatus(options.alerts);
}

/**
 * Whether drift alerts may go to phones now: "yes" when someone is signed in
 * on the computer whose role may see drift, or else why not. The phone link
 * asks before each alert it sends, since the person signed in, or their
 * role, may have changed since a phone turned its alerts on. It never throws,
 * and logs anything unexpected unless `signal` has aborted.
 */
export async function driftAlertsAllowed(call: AppCaller, signal: AbortSignal): Promise<"yes" | Refusal> {
  try {
    await checkDriftAlerts({ call }, signal);
    return "yes";
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    if (!signal.aborted) logWarn("The phone link could not check whether drift alerts may go to phones.", error);
    return "failed";
  }
}

/** Refuses unless the role signed in on the computer may see drift (drift:read), which is what drift alerts show. */
async function checkDriftAlerts(options: Pick<RequestOptions, "call">, signal: AbortSignal): Promise<void> {
  const { permissions } = readMe(await ask(options, "GET", "/api/me", undefined, signal));
  if (!permissions.includes("drift:read")) throw new Refused("forbidden");
}

/** Refuses unless every connection named is shared with phones. */
function checkShared(connectionIds: readonly number[], options: RequestOptions): void {
  const shared = options.sharedConnectionIds();
  if (!connectionIds.every((id) => shared.includes(id))) throw new Refused("not-shared");
}

/**
 * Asks the app's server, and gives the body of a 200 answer. Any other status
 * is thrown as the refusal it stands for: the one in `special` when the route
 * gives that status a meaning of its own, or else refusalFor's. The server's
 * words are logged only with a refusal that does not explain itself; the
 * others, such as a database that is down, are expected, and the server logs
 * them in its own log anyway.
 */
export async function ask(
  options: Pick<RequestOptions, "call">,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  signal: AbortSignal,
  special: Readonly<Partial<Record<number, Refusal>>> = {},
): Promise<unknown> {
  // The route without its query: which connection and schema a phone asked about does not belong in the log.
  const route = `${method} ${path.split("?")[0]}`;
  let answer: AppAnswer;
  try {
    answer = await options.call(method, path, body, signal);
  } catch (error) {
    if (!signal.aborted) logWarn(`The phone link could not reach the app for ${route}.`, error);
    throw new Refused("no-answer");
  }
  if (answer.status === 200) return answer.json;
  const refusal = special[answer.status] ?? refusalFor(answer.status);
  if (refusal === "failed" || refusal === "access-unknown") {
    logWarn(`The app answered the phone link's ${route} with ${answer.status}: ${serverWords(answer.json)}`);
  }
  throw new Refused(refusal);
}

/**
 * The refusal that an answer with this status, other than 200, stands for.
 * The routes above answer with these, and 503 is requirePermission saying it
 * could not read the role (my-app/lib/auth-guard.ts).
 */
function refusalFor(status: number): Refusal {
  switch (status) {
    case 401:
      return "signed-out";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 502:
      return "unreachable";
    case 503:
      return "access-unknown";
    default:
      return "failed";
  }
}

/** The start of the server's error message in a body, for the log. */
function serverWords(json: unknown): string {
  const error = objectFields(json)?.error;
  return typeof error === "string" ? Array.from(error).slice(0, MAX_LOGGED_WORDS).join("") : "(no message)";
}
