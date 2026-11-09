/**
 * Links this computer to a Schema Studio web site, so that its owner can
 * compare the connections shared here from the site's phone app, while the
 * database passwords stay on this computer.
 *
 * The site cannot reach this computer: most computers sit behind a home or
 * company router. So this computer asks. It calls the site every 15 seconds
 * for a question, and every 2 seconds for 2 minutes after one turns up. A held
 * connection would answer faster, but the site's free plan is measured in time
 * spent running, and one held for a working day uses up the month.
 *
 * Linking works like signing in to a command line tool. The site gives a short
 * code, the person's own browser opens the site, they sign in there as usual and
 * approve the code, and the site then hands this computer a token. This computer
 * never sees the person's Microsoft sign-in, and no second Azure app is needed.
 *
 * It keeps these promises:
 *  - It answers only schemas.list and compare.run, which change nothing, and only
 *    for connections shared in Settings. checkShared is the same one the phone
 *    link uses, and a new connection is not shared until someone says so.
 *  - Answers come from this computer's own server, as whoever is signed in here,
 *    so a role that may not compare is refused the same way as on this computer.
 *  - The site learns a connection's name and environment, and never its host,
 *    user, password or database name.
 *  - A refusal is one word. A local error's text can name a host, so it stays in
 *    this computer's log and the site hears "failed".
 *  - Only an answer of 401 ends the link. A site that is down or slow never does,
 *    or a short outage would make people link all their computers again.
 *  - The token, the codes and the site's answers never go in the log.
 *
 * Unlike the phone link, these answers are not encrypted end to end: they pass
 * through the site and its database. They hold schema names and a summary of
 * the changes, with no SQL, no hosts and no rows, and the site deletes them
 * within minutes.
 *
 * No Electron here, so that the tests can run it under node:test. The app gives
 * it a fetch from a session with no cookies (src/main/desktop-app.ts).
 */
import { parseCloudLinkState, type CloudLinkState } from "../core/cloud-agent-file";
import { staysHome } from "../core/stays-home";
import { utf8 } from "../shared/remote/bytes";
import type { CloudLinkResult, CloudView, DriftCheck, SyncAnswer, SyncStatus, WebsiteDrift, WebsiteDriftSchema } from "../shared/ipc";
import { readRelayOrigin } from "../shared/remote/relay-protocol";
import { readRequest, type CompareSummary, type Request } from "../shared/remote/rpc";
import type { Clock } from "./clock";
import { addLogSecret, logError, logInfo, logWarn } from "./log";
import { compare, listConnections, listSchemas, Refused, type AppCaller } from "./phone-requests";
import type { LoadResult, Protection } from "./secrets";

/** How often to ask for a question when nothing has happened lately. */
export const IDLE_POLL_MS = 15_000;
/** How often to ask once a question has turned up, because the next one tends to follow soon. */
export const BUSY_POLL_MS = 2_000;
/** How long the quicker asking lasts after a question. */
export const BUSY_FOR_MS = 120_000;
/** How long to wait after each failed call in a row. The last one repeats. */
export const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
/** How often to tell the site which connections are shared, so a renamed one catches up. */
export const PUBLISH_EVERY_MS = 300_000;
/** A slow compare must not stop the asking, or the site would read this computer as off, so a few run side by side. */
export const MOST_JOBS_AT_ONCE = 3;
/** Under the site's own limit for a running question (RUNNING_FOR_SECONDS), so the person hears why it stopped. */
export const JOB_LIMIT_MS = 150_000;
/** How long any one call to the site may take. */
const SITE_LIMIT_MS = 20_000;
/** The site turns away a bigger answer (MAX_ANSWER_BYTES in the web app's lib/agent-rules.ts). */
export const MAX_ANSWER_BYTES = 1024 * 1024;
/** The header this computer's server reads the sync token from (SYNC_HEADER in the web app's lib/desktop-sync.ts). */
export const SYNC_HEADER = "x-schema-studio-sync";
/** How often, at most, to ask the site whether its connections changed. Each ask follows a poll that worked. */
export const SYNC_EVERY_MS = 15_000;
/** How long to wait before asking again a site that has no sync, such as one not yet updated. */
export const NO_SYNC_RETRY_MS = 30 * 60_000;
/** How often, at most, to ask the site for its drift results. A check runs every few minutes at most. */
export const DRIFT_EVERY_MS = 60_000;
/** The Drift page asks again first when the results are older than this. */
export const DRIFT_FRESH_MS = 10_000;
/** The most schemas the site sends drift results for (MOST_DRIFT_SCHEMAS in the web app's lib/agent-rules.ts). */
export const MOST_DRIFT_SCHEMAS = 200;
/** The newest checks kept for each schema (DRIFT_HISTORY in the web app's lib/agent-rules.ts). */
const DRIFT_HISTORY = 5;
const DRIFT_STATUSES: readonly string[] = ["in_sync", "drifted", "unreachable"];

const BAD_ADDRESS = "That is not a web address Schema Studio can use. It looks like https://schema-studio.example.com.";
const NOT_REACHED = "Could not reach that site. Check the address and your connection.";
const NOT_A_SITE = "That site did not answer like Schema Studio. Check the address.";
const TOO_MANY = "Too many computers are waiting to be linked there. Try again in a few minutes.";
const ALREADY_LINKED = "This computer is already linked. Unlink it first.";
const CODE_RAN_OUT = "The code ran out before it was approved. Link again to get a new one.";
const TURNED_AWAY = "The site turned this link away. Link again if that was a mistake.";
const NOT_SAVED = "This computer was linked, but the link could not be saved. Link again.";
const UNLINKED_THERE = "The site no longer knows this computer, so it was unlinked. Link it again to go on using it.";
const SITE_TROUBLE = "Cannot reach the site right now. Schema Studio keeps trying.";
const LOCKED = "The site link could not be opened because the login keyring is locked. Unlock it and start Schema Studio again.";
const DAMAGED = "The saved site link could not be read. Unlink it to start again.";
const FAILED_TO_START = "The site link could not start. The log has the details.";
const STAYS_HOME = "Its address only works on this computer, so it stays here, password and all.";
const SAVED_HERE_OFFLINE =
  "The website cannot be reached right now, so this was saved on this computer only. Use Send to website once it is back.";
const SITE_HAS_NO_SYNC = "The linked website does not share connections yet, so this was saved on this computer only.";
const WRITE_OFFLINE = "The website cannot be reached right now, so nothing was changed. Try again once it is back.";
const GONE_HERE = "That connection is no longer on this computer.";

export type CloudStore = {
  load(): LoadResult<CloudLinkState>;
  save(values: CloudLinkState): Protection;
  remove(): void;
};

/** Sends one request: a session's fetch in the app, a fake in the tests. */
export type CloudFetch = (url: string, init: RequestInit) => Promise<Response>;

export type CloudAgentOptions = {
  store: CloudStore;
  fetch: CloudFetch;
  clock: Clock;
  /** Asks this computer's own server, as whoever is signed in here. */
  call: AppCaller;
  /** The connections shared in Settings. Read for every question, so a change counts at once. */
  sharedConnectionIds: () => readonly number[];
  computerName: string;
  /** Opens the person's own web browser, where they are signed in or can sign in. */
  openBrowser: (url: string) => void;
  /** Called after each change to what view() gives. */
  onChange: () => void;
  /** How long one question may take. Only the tests change it. */
  jobLimitMs?: number;
  /** This computer's own server's side of the two-way sync. Without it, nothing is synced. */
  sync?: SyncHost;
};

/**
 * One of this computer's own connections, as the site lists it under the
 * computer, with the drift results of the schemas tracked on it. The drift
 * goes to the site as this computer's server gave it; the site checks it.
 */
export type OwnConnection = { id: number; name: string; environment: string; drift?: readonly unknown[] };

/**
 * This computer's own server's side of the two-way sync
 * (docs/two-way-sync-plan.md; app/api/desktop/sync in the web app). The app
 * calls it with a token only the main process holds.
 */
export type SyncHost = {
  /** Makes this computer's copies of the site's connections match the list. Throws when it could not. */
  apply(connections: readonly unknown[]): Promise<void>;
  /** This computer's own connections, by name only. */
  local(): Promise<OwnConnection[]>;
  /** One of this computer's own connections in full, password included, or null when it is not one. */
  export(id: number): Promise<Record<string, unknown> | null>;
  /** One of this computer's own connections became that site connection. */
  adopt(id: number, siteId: number, siteVersion: number): Promise<boolean>;
};

/** This computer's server's list of its own connections ({ connections } from the "local" action). Throws when it is not one. */
export function readOwnConnections(body: unknown): OwnConnection[] {
  if (!isRecord(body) || !Array.isArray(body.connections)) throw new Error("This computer's list of connections could not be read.");
  return body.connections.flatMap((row): OwnConnection[] => {
    if (!isRecord(row)) return [];
    const { id, name, environment, drift } = row;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return [];
    if (typeof name !== "string" || typeof environment !== "string") return [];
    const own: OwnConnection = { id, name: name.slice(0, 200), environment: environment.slice(0, 50) };
    if (Array.isArray(drift)) own.drift = drift.slice(0, MOST_DRIFT_SCHEMAS);
    return [own];
  });
}

/** One connection from the server's "export" action, or null. */
export function readExported(body: unknown): Record<string, unknown> | null {
  return isRecord(body) && isRecord(body.connection) ? body.connection : null;
}

/** What the site sent back to a change, or why there is nothing to read. */
type SiteWrite = { kind: "answer"; status: number; json: unknown } | { kind: "offline"; message: string } | { kind: "not-linked" };

type Linking = {
  origin: string;
  code: string;
  deviceCode: string;
  until: number;
  everyMs: number;
};

type SiteJob = { id: number; method: unknown; params: unknown };

type JobAnswer = { result: unknown } | { refusal: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Gives the body of an answer, or null when it is not JSON. */
async function bodyOf(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

/** The first answer to a request to link, or null when it did not come from Schema Studio. */
function readStartedLink(body: unknown): { deviceCode: string; userCode: string; verifyPath: string; everyMs: number; forMs: number } | null {
  if (!isRecord(body)) return null;
  const { deviceCode, userCode, verifyPath, intervalSeconds, expiresInSeconds } = body;
  if (typeof deviceCode !== "string" || deviceCode.length < 16 || deviceCode.length > 200) return null;
  if (typeof userCode !== "string" || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode)) return null;
  // Checked closely because it goes to the web browser: only the site's own page, with only the code.
  if (typeof verifyPath !== "string" || verifyPath !== `/link-computer?code=${userCode}`) return null;
  if (typeof intervalSeconds !== "number" || !(intervalSeconds >= 1 && intervalSeconds <= 60)) return null;
  if (typeof expiresInSeconds !== "number" || !(expiresInSeconds >= 1 && expiresInSeconds <= 3600)) return null;
  return { deviceCode, userCode, verifyPath, everyMs: intervalSeconds * 1000, forMs: expiresInSeconds * 1000 };
}

/** The job in an answer from the site, or null when there is none. */
function readSiteJob(body: unknown): SiteJob | null {
  if (!isRecord(body) || !isRecord(body.job)) return null;
  const { id, method, params } = body.job;
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 1 ? { id, method, params } : null;
}

/**
 * The question a job asks, or null when this computer does not answer it. The
 * same check every phone's request goes through, then a shorter list of methods:
 * nothing from the site can start a deploy or anything else that changes a
 * database, whatever the site is told to send.
 */
/**
 * The compare route names each connection with its database, as the Compare
 * screen does. A database's name stays on this computer, so the site gets only
 * the name it was already told, and never one this could not look up.
 */
function withoutDatabases(summary: CompareSummary, shared: readonly { id: number; name: string }[]): CompareSummary {
  const nameOf = (connectionId: number | null) => shared.find((entry) => entry.id === connectionId)?.name ?? "A connection";
  return {
    source: { ...summary.source, name: nameOf(summary.source.connectionId) },
    targets: summary.targets.map((target) => ({ ...target, name: nameOf(target.connectionId) })),
  };
}

export function readCloudJob(method: unknown, params: unknown): Extract<Request, { method: "schemas.list" | "compare.run" }> | null {
  const reading = readRequest(utf8(JSON.stringify({ id: 1, method, params })));
  if (!reading.ok) return null;
  const { request } = reading;
  return request.method === "schemas.list" || request.method === "compare.run" ? request : null;
}

/** The site's answer to GET /api/agent/sync, or null when it is not one. Each row is checked by this computer's server. */
function readSyncAnswer(body: unknown): { rev: string; connections: readonly unknown[] | null } | null {
  if (!isRecord(body) || typeof body.rev !== "string" || body.rev.length === 0 || body.rev.length > 100) return null;
  if (body.same === true) return { rev: body.rev, connections: null };
  if (body.same !== false || !Array.isArray(body.connections) || body.connections.length > 2000) return null;
  return { rev: body.rev, connections: body.connections };
}

/** A text field from the site, cut to `most` characters, or null when it is not text. */
function textOf(value: unknown, most: number): string | null {
  return typeof value === "string" ? value.slice(0, most) : null;
}

/** An ISO time from the site, or null. */
function timeOf(value: unknown): string | null {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
}

function readDriftCheck(value: unknown): DriftCheck | null {
  if (!isRecord(value)) return null;
  const { status, summary, checkedAt, source, acknowledged } = value;
  const at = timeOf(checkedAt);
  if (typeof status !== "string" || !DRIFT_STATUSES.includes(status) || at === null) return null;
  return {
    status: status as DriftCheck["status"],
    summary: textOf(summary, 300) ?? "",
    checkedAt: at,
    source: textOf(source, 40) ?? "unknown",
    acknowledged: acknowledged === true,
  };
}

function readWebsiteDriftSchema(value: unknown): WebsiteDriftSchema | null {
  if (!isRecord(value)) return null;
  const { connectionId, connectionName, environment, schema, label, intervalMinutes, lastCheckedAt, checks } = value;
  if (typeof connectionId !== "number" || !Number.isSafeInteger(connectionId) || connectionId <= 0) return null;
  const name = textOf(connectionName, 200);
  const schemaName = textOf(schema, 128);
  if (name === null || schemaName === null || schemaName === "") return null;
  return {
    connectionId,
    connectionName: name,
    environment: textOf(environment, 50) ?? "",
    schema: schemaName,
    label: textOf(label, 200) || null,
    intervalMinutes:
      typeof intervalMinutes === "number" && Number.isSafeInteger(intervalMinutes) && intervalMinutes >= 0 ? intervalMinutes : 0,
    lastCheckedAt: timeOf(lastCheckedAt),
    checks: Array.isArray(checks)
      ? checks.slice(0, 20).flatMap((check) => readDriftCheck(check) ?? []).slice(0, DRIFT_HISTORY)
      : [],
  };
}

/** The site's answer to GET /api/agent/sync/drift, or null when it is not one. Bad schemas are left out, not the whole list. */
export function readDriftAnswer(
  body: unknown
): { rev: string; results: { allowed: boolean; orgSlug: string | null; schemas: WebsiteDriftSchema[] } | null } | null {
  if (!isRecord(body) || typeof body.rev !== "string" || body.rev.length === 0 || body.rev.length > 100) return null;
  if (body.same === true) return { rev: body.rev, results: null };
  if (body.same !== false || typeof body.allowed !== "boolean" || !Array.isArray(body.schemas)) return null;
  const slug = typeof body.orgSlug === "string" && /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(body.orgSlug) ? body.orgSlug : null;
  const schemas = body.allowed
    ? body.schemas.slice(0, MOST_DRIFT_SCHEMAS).flatMap((schema) => readWebsiteDriftSchema(schema) ?? [])
    : [];
  return { rev: body.rev, results: { allowed: body.allowed, orgSlug: slug, schemas } };
}

/** The id and version of a connection the site just saved, or null. */
function readSaved(body: unknown): { id: number; version: number } | null {
  if (!isRecord(body)) return null;
  const id = Number(body.id);
  const version = Number(body.version);
  return Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(version) && version > 0 ? { id, version } : null;
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export class CloudAgent {
  private link: CloudLinkState | null = null;
  private linking: Linking | null = null;
  private unavailable: string | null = null;
  private lastOrigin: string | null = null;
  private notice: string | null = null;
  private problem: string | null = null;
  private damaged = false;

  /** Moves on each time the loop starts or stops, so that a call still under way from before drops its answer. */
  private run = 0;
  private stopping = new AbortController();
  private pollTimer: unknown = null;
  private publishTimer: unknown = null;
  private claimTimer: unknown = null;
  private failures = 0;
  private busyUntil = 0;
  private jobsRunning = 0;

  private publishing = false;
  private publishAgain = false;
  /** Sorted, or null before the first time the site heard. */
  private publishedIds: readonly number[] | null = null;
  /** What the site last heard of this computer's own connections, to notice one added, renamed or deleted here. */
  private publishedOwn: string | null = null;

  // The two-way sync. All of its work runs one piece at a time, in order, on syncChain.
  private syncChain: Promise<unknown> = Promise.resolve();
  /** The site's mark for the list this computer has, so an unchanged list is not sent again. */
  private syncRev: string | null = null;
  private lastSyncTry = 0;
  private syncedAt: number | null = null;
  /** When the site's connections last changed here, so the Connections screen knows to read them again. */
  private changedAt: number | null = null;
  /** Whether the site has the sync: null until it answers. */
  private siteSyncs: boolean | null = null;
  private noSyncUntil = 0;

  // The website's drift results, for the Drift page. Asked for apart from the connections, less often.
  private drift: { rev: string; allowed: boolean; orgSlug: string | null; schemas: WebsiteDriftSchema[] } | null = null;
  private driftSyncedAt: number | null = null;
  private lastDriftTry = 0;
  private noDriftUntil = 0;
  /** Only the first of a run of failures goes in the log. */
  private driftFailing = false;
  private driftPulling: Promise<void> | null = null;

  constructor(private readonly options: CloudAgentOptions) {}

  /** Opens the saved link, if there is one, and starts asking for questions. */
  start(): void {
    try {
      const loaded = this.options.store.load();
      switch (loaded.status) {
        case "missing":
          break;
        case "values":
          if (loaded.upgrade) this.moveIntoKeyring(loaded.values);
          addLogSecret(loaded.values.token);
          this.link = loaded.values;
          this.lastOrigin = loaded.values.origin;
          this.startLoop();
          break;
        case "locked":
          logWarn(loaded.message);
          this.unavailable = LOCKED;
          break;
        case "damaged":
          logWarn(loaded.message);
          this.unavailable = DAMAGED;
          this.damaged = true;
          break;
      }
    } catch (error) {
      logError("The site link could not start.", error);
      this.unavailable = FAILED_TO_START;
    }
    this.options.onChange();
  }

  /** Stops every timer and call. The saved link stays, for the next start. */
  stop(): void {
    this.stopLoop();
    this.endLinking();
  }

  view(): CloudView {
    if (this.unavailable !== null) return { state: "unavailable", message: this.unavailable, canClear: this.damaged };
    if (this.link !== null) {
      return { state: "linked", origin: this.link.origin, orgName: this.link.orgName, linkedAt: this.link.linkedAt, problem: this.problem };
    }
    if (this.linking !== null) return { state: "linking", origin: this.linking.origin, code: this.linking.code };
    return { state: "off", origin: this.lastOrigin, notice: this.notice };
  }

  /** Asks the site for a code, and opens the person's web browser to approve it. Takes what the page sent as it is. */
  async startLink(text: string): Promise<CloudLinkResult> {
    if (this.link !== null) return { ok: false, message: ALREADY_LINKED };
    if (this.unavailable !== null) return { ok: false, message: this.unavailable };
    const origin = readRelayOrigin(text.trim());
    if (origin === null) return { ok: false, message: BAD_ADDRESS };

    this.endLinking();
    this.notice = null;
    this.lastOrigin = origin;
    // Whatever comes back from before a later link or a stop is dropped.
    const run = this.run;
    let started: ReturnType<typeof readStartedLink>;
    try {
      const response = await this.send(origin, "POST", "/api/agent/link", { computerName: this.options.computerName });
      if (run !== this.run) return { ok: false, message: NOT_REACHED };
      if (response.status === 429) return { ok: false, message: TOO_MANY };
      if (response.status !== 201) return { ok: false, message: NOT_A_SITE };
      started = readStartedLink(await bodyOf(response));
    } catch (error) {
      logWarn(`Could not ask a site to link this computer: ${error instanceof Error ? error.name : "unknown error"}.`);
      return { ok: false, message: NOT_REACHED };
    }
    if (started === null || run !== this.run) return { ok: false, message: NOT_A_SITE };

    addLogSecret(started.deviceCode);
    this.linking = {
      origin,
      code: started.userCode,
      deviceCode: started.deviceCode,
      until: this.options.clock.now() + started.forMs,
      everyMs: started.everyMs,
    };
    this.options.openBrowser(`${origin}${started.verifyPath}`);
    this.scheduleClaim(run);
    this.options.onChange();
    return { ok: true };
  }

  /** Makes the code on show link nothing here. The site forgets it when it runs out. */
  cancelLink(): void {
    if (this.linking === null) return;
    this.endLinking();
    this.options.onChange();
  }

  /** Ends the link here, and tells the site if it can be reached. Also clears a saved link that cannot be read. */
  unlink(): void {
    const link = this.link;
    this.stopLoop();
    this.link = null;
    this.problem = null;
    this.publishedIds = null;
    this.dropCopies();
    if (this.damaged) {
      this.damaged = false;
      this.unavailable = null;
    }
    try {
      this.options.store.remove();
    } catch (error) {
      logWarn("Could not delete the saved site link.", error);
    }
    if (link !== null) {
      this.send(link.origin, "DELETE", "/api/agent/self", undefined, link.token).then(
        (response) => void response.body?.cancel().catch(() => undefined),
        // The token still works there until the person removes the computer on the site, which says so.
        () => logWarn("Could not tell the site this computer was unlinked.")
      );
    }
    this.options.onChange();
  }

  /** Settings changed which connections are shared. Tells the site at once rather than in up to 5 minutes. */
  sharedChanged(): void {
    if (this.link === null) return;
    if (this.publishing || this.publishedIds === null || !sameIds(this.sharedIds(), this.publishedIds)) void this.publish(this.run);
  }

  /** How this computer stands with the site, for the Connections screen. */
  syncStatus(): SyncStatus {
    const link = this.link;
    if (link === null || this.options.sync === undefined || this.siteSyncs === false) return { linked: false, changedAt: this.changedAt };
    return {
      linked: true,
      origin: link.origin,
      orgName: link.orgName,
      online: this.problem === null,
      lastSyncedAt: this.syncedAt,
      changedAt: this.changedAt,
    };
  }

  /** The website's drift results, as last asked for. */
  driftStatus(): WebsiteDrift {
    const link = this.link;
    if (link === null || this.options.sync === undefined || this.siteSyncs === false) return { linked: false };
    const drift = this.drift;
    return {
      linked: true,
      origin: link.origin,
      orgName: link.orgName,
      // The site's own word first, since an organization can be renamed after the link.
      orgSlug: drift?.orgSlug ?? link.orgSlug,
      online: this.problem === null,
      syncedAt: this.driftSyncedAt,
      allowed: drift?.allowed ?? false,
      schemas: drift === null ? null : drift.schemas,
    };
  }

  /** The website's drift results for the Drift page, asked for again first when they are more than a few seconds old. */
  async websiteDrift(): Promise<WebsiteDrift> {
    const now = this.options.clock.now();
    if (this.driftPulling !== null) await this.driftPulling;
    else if (this.link !== null && this.siteSyncs !== false && now >= this.noDriftUntil && now - this.lastDriftTry >= DRIFT_FRESH_MS) {
      await this.pullDrift(this.run);
    }
    return this.driftStatus();
  }

  /**
   * Adds a connection on the site, when the site can reach its database. One
   * whose address only works here never leaves this computer; one the site
   * cannot reach stays here too (docs/two-way-sync-plan.md, rules 2 and 3).
   */
  syncCreate(connection: Record<string, unknown>): Promise<SyncAnswer> {
    if (this.link === null || this.options.sync === undefined) return Promise.resolve({ kind: "not-linked" });
    if (staysHome(connection)) return Promise.resolve({ kind: "local", reason: STAYS_HOME });
    return this.queue(async () => {
      const link = this.link;
      if (link === null) return { kind: "not-linked" };
      if (this.siteSyncs === false) return { kind: "local", reason: SITE_HAS_NO_SYNC };
      if (this.problem !== null) return { kind: "local", reason: SAVED_HERE_OFFLINE };
      const run = this.run;
      const sent = await this.siteWrite(link, "POST", connection);
      if (sent.kind !== "answer") return sent.kind === "offline" ? { kind: "local", reason: SAVED_HERE_OFFLINE } : sent;
      const { status, json } = sent;
      if (status === 404) return this.siteHasNoSync();
      if (status === 200 && isRecord(json) && json.saved === false) {
        return { kind: "local", reason: typeof json.reason === "string" && json.reason !== "" ? json.reason : SAVED_HERE_OFFLINE };
      }
      if (status === 200 && isRecord(json) && json.saved === true) {
        await this.syncDown(run);
        return { kind: "saved", body: json.connection };
      }
      return { kind: "refused", status, body: json };
    });
  }

  /** Saves a change to one of the site's connections, on the site. It comes back down with the next sync, which runs at once. */
  syncUpdate(siteId: number, connection: Record<string, unknown>): Promise<SyncAnswer> {
    return this.siteChange("PUT", { ...connection, id: siteId });
  }

  /** Deletes one of the site's connections, on the site. */
  syncRemove(siteId: number, baseVersion: number | null, confirm: boolean): Promise<SyncAnswer> {
    return this.siteChange("DELETE", { id: siteId, base_version: baseVersion, confirm });
  }

  /**
   * Sends one of this computer's own connections up to the site. The site
   * tests it first and keeps it only if it can reach the database. The row
   * here then becomes the site's copy, keeping its number, so its history
   * and saved comparisons keep working.
   */
  syncSendUp(localId: number): Promise<SyncAnswer> {
    const sync = this.options.sync;
    if (this.link === null || sync === undefined) return Promise.resolve({ kind: "not-linked" });
    return this.queue(async () => {
      const link = this.link;
      if (link === null) return { kind: "not-linked" };
      const run = this.run;
      const connection = await sync.export(localId);
      if (connection === null) return { kind: "refused", status: 404, body: { error: GONE_HERE } };
      if (staysHome(connection)) return { kind: "local", reason: STAYS_HOME };
      const sent = await this.siteWrite(link, "POST", connection);
      if (sent.kind !== "answer") return sent;
      const { status, json } = sent;
      if (status === 404) return this.siteHasNoSync();
      if (status === 200 && isRecord(json) && json.saved === false) {
        return { kind: "local", reason: typeof json.reason === "string" && json.reason !== "" ? json.reason : WRITE_OFFLINE };
      }
      const saved = status === 200 && isRecord(json) && json.saved === true ? readSaved(json.connection) : null;
      if (saved === null) return { kind: "refused", status, body: json };
      if (run !== this.run) return { kind: "not-linked" };
      await sync.adopt(localId, saved.id, saved.version);
      await this.syncDown(run);
      void this.publish(run);
      return { kind: "saved", body: isRecord(json) ? json.connection : null };
    });
  }

  /** Adding is the one change that never answers 404 on a site that has the sync, so a 404 means the site has none yet. */
  private siteHasNoSync(): SyncAnswer {
    this.siteSyncs = false;
    this.noSyncUntil = this.options.clock.now() + NO_SYNC_RETRY_MS;
    return { kind: "local", reason: SITE_HAS_NO_SYNC };
  }

  private siteChange(method: "PUT" | "DELETE", body: Record<string, unknown>): Promise<SyncAnswer> {
    if (this.link === null || this.options.sync === undefined) return Promise.resolve({ kind: "not-linked" });
    return this.queue(async () => {
      const link = this.link;
      if (link === null) return { kind: "not-linked" };
      const run = this.run;
      const sent = await this.siteWrite(link, method, body);
      if (sent.kind !== "answer") return sent;
      if (sent.status !== 200) return { kind: "refused", status: sent.status, body: sent.json };
      await this.syncDown(run);
      return { kind: "saved", body: sent.json };
    });
  }

  /** Sends one change to the site's connections, as the person who linked this computer. */
  private async siteWrite(link: CloudLinkState, method: "POST" | "PUT" | "DELETE", body: unknown): Promise<SiteWrite> {
    const run = this.run;
    try {
      const response = await this.send(link.origin, method, "/api/agent/sync/connections", body, link.token);
      const json = await bodyOf(response);
      if (run !== this.run) return { kind: "not-linked" };
      if (response.status === 401) {
        this.siteForgotUs();
        return { kind: "not-linked" };
      }
      // A host's own error page, not the site's answer.
      if (response.status >= 500 && !(isRecord(json) && typeof json.error === "string")) throw new Error(`The site answered ${response.status}.`);
      this.setProblem(null);
      return { kind: "answer", status: response.status, json };
    } catch (error) {
      if (run !== this.run) return { kind: "not-linked" };
      logWarn(`Could not send a change to the site: ${error instanceof Error ? error.name : "unknown error"}.`);
      this.setProblem(SITE_TROUBLE);
      return { kind: "offline", message: WRITE_OFFLINE };
    }
  }

  /** Runs one piece of sync work after the ones before it, whatever became of them. */
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.syncChain.then(work, work);
    this.syncChain = next.catch(() => undefined);
    return next;
  }

  /**
   * Asks the site for its connections, and makes this computer's copies
   * match. The site answers "same" when nothing changed since the last ask,
   * which is most of the time. Returns whether it worked.
   */
  private async syncDown(run: number): Promise<boolean> {
    const link = this.link;
    const sync = this.options.sync;
    if (link === null || sync === undefined || run !== this.run) return false;
    const now = this.options.clock.now();
    this.lastSyncTry = now;
    try {
      const rev = this.syncRev === null ? "" : `?rev=${encodeURIComponent(this.syncRev)}`;
      const response = await this.send(link.origin, "GET", `/api/agent/sync${rev}`, undefined, link.token);
      if (run !== this.run) return false;
      if (response.status === 401) {
        this.siteForgotUs();
        return false;
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        if (this.siteSyncs !== false) logInfo("The linked site does not share its connections yet. Asking again later.");
        this.siteSyncs = false;
        this.noSyncUntil = now + NO_SYNC_RETRY_MS;
        return false;
      }
      if (!response.ok) throw new Error(`The site answered ${response.status}.`);
      const answer = readSyncAnswer(await bodyOf(response));
      if (run !== this.run) return false;
      if (answer === null) throw new Error("The site's list could not be read.");
      const first = this.siteSyncs !== true;
      this.siteSyncs = true;
      if (answer.connections !== null) {
        await sync.apply(answer.connections);
        if (run !== this.run) return false;
        this.changedAt = this.options.clock.now();
      }
      this.syncRev = answer.rev;
      this.syncedAt = this.options.clock.now();
      // The first time, the site hears about every connection here, not just the shared ones. After that, when one changes.
      if (first || (await this.ownPrint()) !== this.publishedOwn) void this.publish(run);
      return true;
    } catch (error) {
      if (run === this.run) logWarn(`Could not bring the site's connections up to date: ${error instanceof Error ? error.name : "unknown error"}.`);
      return false;
    }
  }

  /** Asks the site for its drift results, once at a time. */
  private pullDrift(run: number): Promise<void> {
    if (this.driftPulling === null) {
      const pulling = this.syncDrift(run).finally(() => {
        if (this.driftPulling === pulling) this.driftPulling = null;
      });
      this.driftPulling = pulling;
    }
    return this.driftPulling;
  }

  /**
   * Asks the site for the drift results it keeps on its own connections. Only
   * results come down; the site answers "same" when none changed. A site from
   * before the drift sync answers 404, and is asked again much later.
   */
  private async syncDrift(run: number): Promise<void> {
    const link = this.link;
    if (link === null || this.options.sync === undefined || run !== this.run) return;
    const now = this.options.clock.now();
    this.lastDriftTry = now;
    try {
      const rev = this.drift === null ? "" : `?rev=${encodeURIComponent(this.drift.rev)}`;
      const response = await this.send(link.origin, "GET", `/api/agent/sync/drift${rev}`, undefined, link.token);
      if (run !== this.run) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      if (response.status === 401) return this.siteForgotUs();
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        this.noDriftUntil = now + NO_SYNC_RETRY_MS;
        return;
      }
      if (!response.ok) throw new Error(`The site answered ${response.status}.`);
      const answer = readDriftAnswer(await bodyOf(response));
      if (run !== this.run) return;
      if (answer === null || (answer.results === null && this.drift === null)) throw new Error("The site's drift results could not be read.");
      if (answer.results !== null) this.drift = { rev: answer.rev, ...answer.results };
      this.driftSyncedAt = this.options.clock.now();
      this.driftFailing = false;
    } catch (error) {
      if (run === this.run && !this.driftFailing) {
        logWarn(`Could not bring the site's drift results up to date: ${error instanceof Error ? error.name : "unknown error"}.`);
      }
      if (run === this.run) this.driftFailing = true;
    }
  }

  /** What this computer's own connections look like to the site now, to notice a change. */
  private async ownPrint(): Promise<string | null> {
    try {
      return JSON.stringify(await this.ownConnections());
    } catch {
      return this.publishedOwn;
    }
  }

  /** Every one of this computer's own connections, each marked shared or not. Only for a site that has the sync. */
  private async ownConnections(): Promise<(OwnConnection & { shared: boolean })[]> {
    const sync = this.options.sync;
    if (sync === undefined) return [];
    const shared = new Set(this.options.sharedConnectionIds());
    return (await sync.local()).map(({ id, name, environment, drift }) => ({
      id,
      name,
      environment,
      shared: shared.has(id),
      // Each schema's newest results, so the site can show them on its Drift page.
      ...(drift === undefined ? {} : { drift }),
    }));
  }

  /** Clears this computer's copies of a site's connections, after a link ends or before a new one starts. */
  private dropCopies(): void {
    const sync = this.options.sync;
    this.syncRev = null;
    this.syncedAt = null;
    this.siteSyncs = null;
    this.noSyncUntil = 0;
    this.lastSyncTry = 0;
    this.publishedOwn = null;
    this.drift = null;
    this.driftSyncedAt = null;
    this.lastDriftTry = 0;
    this.noDriftUntil = 0;
    this.driftFailing = false;
    if (sync === undefined) return;
    void this.queue(async () => {
      try {
        await sync.apply([]);
        this.changedAt = this.options.clock.now();
      } catch (error) {
        logWarn("Could not remove the site's connections from this computer.", error);
      }
    });
  }

  private sharedIds(): number[] {
    return [...this.options.sharedConnectionIds()].sort((a, b) => a - b);
  }

  private moveIntoKeyring(values: CloudLinkState): void {
    try {
      if (this.options.store.save(values) === "keyring") logInfo("Moved the site link into the login keyring.");
    } catch (error) {
      logWarn("Could not move the site link into the login keyring.", error);
    }
  }

  private send(origin: string, method: string, path: string, body: unknown, token?: string): Promise<Response> {
    return this.options.fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(SITE_LIMIT_MS), this.stopping.signal]),
      // A redirect could carry the token to another address.
      redirect: "error",
      cache: "no-store",
    });
  }

  private endLinking(): void {
    if (this.claimTimer !== null) this.options.clock.clearTimeout(this.claimTimer);
    this.claimTimer = null;
    this.linking = null;
    // So that a claim under way drops its answer. The asking loop, if any, is not running while linking.
    this.run += 1;
  }

  private scheduleClaim(run: number): void {
    const linking = this.linking;
    if (linking === null) return;
    this.claimTimer = this.options.clock.setTimeout(() => void this.claim(run), linking.everyMs);
  }

  private async claim(run: number): Promise<void> {
    const linking = this.linking;
    if (linking === null || run !== this.run) return;
    if (this.options.clock.now() >= linking.until) return this.linkEnded(CODE_RAN_OUT);
    try {
      const response = await this.send(linking.origin, "POST", "/api/agent/link/claim", { deviceCode: linking.deviceCode });
      if (run !== this.run) return;
      if (response.status === 410) return this.linkEnded(TURNED_AWAY);
      if (response.status === 200) {
        const body = await bodyOf(response);
        if (run !== this.run) return;
        return this.finishLinking(linking, body);
      }
    } catch (error) {
      if (run !== this.run) return;
      // A hiccup is not the end of it: the code is good until it runs out.
      logWarn(`Could not ask whether a link was approved: ${error instanceof Error ? error.name : "unknown error"}.`);
    }
    this.scheduleClaim(run);
  }

  private linkEnded(notice: string): void {
    this.endLinking();
    this.notice = notice;
    this.options.onChange();
  }

  private finishLinking(linking: Linking, body: unknown): void {
    const org = isRecord(body) && isRecord(body.org) ? body.org : null;
    const token = isRecord(body) ? body.token : null;
    const state = parseCloudLinkState({
      origin: linking.origin,
      token,
      orgName: org?.name,
      orgSlug: org?.slug,
      linkedAt: this.options.clock.now(),
    });
    if (state === null) return this.linkEnded(NOT_A_SITE);
    addLogSecret(state.token);
    try {
      this.options.store.save(state);
    } catch (error) {
      logError("Could not save the site link.", error);
      return this.linkEnded(NOT_SAVED);
    }
    this.endLinking();
    // Copies left by a link to another site, if any, go before this one's arrive.
    this.dropCopies();
    this.link = state;
    this.notice = null;
    this.problem = null;
    logInfo("This computer is linked to a Schema Studio site.");
    this.startLoop();
    this.options.onChange();
  }

  private startLoop(): void {
    this.stopping = new AbortController();
    this.run += 1;
    this.failures = 0;
    this.busyUntil = 0;
    this.publishedIds = null;
    void this.poll(this.run);
    void this.publish(this.run);
  }

  private stopLoop(): void {
    this.run += 1;
    this.stopping.abort();
    this.stopping = new AbortController();
    if (this.pollTimer !== null) this.options.clock.clearTimeout(this.pollTimer);
    if (this.publishTimer !== null) this.options.clock.clearTimeout(this.publishTimer);
    this.pollTimer = null;
    this.publishTimer = null;
    this.publishing = false;
    this.publishAgain = false;
  }

  private schedulePoll(run: number, ms: number): void {
    if (this.pollTimer !== null) this.options.clock.clearTimeout(this.pollTimer);
    this.pollTimer = this.options.clock.setTimeout(() => void this.poll(run), ms);
  }

  private nextPollMs(): number {
    return this.options.clock.now() < this.busyUntil ? BUSY_POLL_MS : IDLE_POLL_MS;
  }

  /** Asks the site for the next question. */
  private async poll(run: number): Promise<void> {
    const link = this.link;
    if (link === null || run !== this.run) return;
    this.pollTimer = null;
    // Full up. A job finishing does not need to hurry this along: the next try is soon.
    if (this.jobsRunning >= MOST_JOBS_AT_ONCE) return this.schedulePoll(run, BUSY_POLL_MS);

    let job: SiteJob | null;
    try {
      const response = await this.send(link.origin, "POST", "/api/agent/jobs/next", {}, link.token);
      if (run !== this.run) return;
      if (response.status === 401) return this.siteForgotUs();
      if (!response.ok) throw new Error(`The site answered ${response.status}.`);
      const body = await bodyOf(response);
      if (run !== this.run) return;
      job = readSiteJob(body);
    } catch (error) {
      if (run !== this.run) return;
      this.pollFailed(run, error);
      return;
    }

    this.failures = 0;
    this.setProblem(null);
    this.maybeSync(run);
    if (job === null) return this.schedulePoll(run, this.nextPollMs());
    this.busyUntil = this.options.clock.now() + BUSY_FOR_MS;
    void this.answer(run, link, job);
    // At once, because a second question may be waiting behind this one.
    this.schedulePoll(run, 0);
  }

  /** After a poll that worked: asks the site whether its connections, or its drift results, changed, if it is time. */
  private maybeSync(run: number): void {
    if (this.options.sync === undefined) return;
    const now = this.options.clock.now();
    if (now - this.lastSyncTry >= SYNC_EVERY_MS && now >= this.noSyncUntil) {
      this.lastSyncTry = now;
      void this.queue(() => this.syncDown(run));
    }
    // Only once the site has shown it has the sync, so a site from before it is not asked twice.
    if (this.siteSyncs === true && now - this.lastDriftTry >= DRIFT_EVERY_MS && now >= this.noDriftUntil) void this.pullDrift(run);
  }

  private pollFailed(run: number, error: unknown): void {
    // Only the first of a run of failures goes in the log, or an outage would fill it.
    if (this.failures === 0) logWarn(`Could not ask the site for questions: ${error instanceof Error ? error.name : "unknown error"}.`);
    const wait = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
    this.failures += 1;
    this.setProblem(SITE_TROUBLE);
    this.schedulePoll(run, wait);
  }

  private setProblem(problem: string | null): void {
    if (this.problem === problem) return;
    this.problem = problem;
    this.options.onChange();
  }

  /** The site answered 401: it no longer knows this token. */
  private siteForgotUs(): void {
    logWarn("The site no longer knows this computer, so the link was removed.");
    this.stopLoop();
    this.link = null;
    this.problem = null;
    this.publishedIds = null;
    this.dropCopies();
    this.notice = UNLINKED_THERE;
    try {
      this.options.store.remove();
    } catch (error) {
      logWarn("Could not delete the saved site link.", error);
    }
    this.options.onChange();
  }

  /** Works out the answer to one question and sends it, without holding up the asking. */
  private async answer(run: number, link: CloudLinkState, job: SiteJob): Promise<void> {
    this.jobsRunning += 1;
    try {
      const answer = await this.work(job);
      if (run !== this.run) return;
      const response = await this.send(link.origin, "POST", `/api/agent/jobs/${job.id}`, answer, link.token);
      await response.body?.cancel().catch(() => undefined);
      if (run === this.run && response.status === 401) this.siteForgotUs();
    } catch (error) {
      // The site gives up on the question by itself, and tells the person so.
      if (run === this.run) logWarn(`Could not send an answer to the site: ${error instanceof Error ? error.name : "unknown error"}.`);
    } finally {
      this.jobsRunning -= 1;
    }
  }

  private async work(job: SiteJob): Promise<JobAnswer> {
    const request = readCloudJob(job.method, job.params);
    if (request === null) return { refusal: "bad-request" };
    const signal = AbortSignal.any([AbortSignal.timeout(this.options.jobLimitMs ?? JOB_LIMIT_MS), this.stopping.signal]);
    const asker = { call: this.options.call, sharedConnectionIds: this.options.sharedConnectionIds };
    try {
      const result =
        request.method === "schemas.list"
          ? await listSchemas(request.params.connectionId, asker, signal)
          : withoutDatabases(
              await compare(request.params.source, request.params.targets, asker, signal),
              (await listConnections(asker, signal)).connections
            );
      return Buffer.byteLength(JSON.stringify({ result })) > MAX_ANSWER_BYTES ? { refusal: "too-big" } : { result };
    } catch (error) {
      // First, because a call the limit stopped reads as the server not answering.
      if (signal.aborted) return { refusal: "too-slow" };
      if (error instanceof Refused) return { refusal: error.refusal };
      logWarn("Could not answer a question from the site.", error);
      return { refusal: "failed" };
    }
  }

  /** Tells the site which connections are shared here. Only their names and environments, and nothing else. */
  private async publish(run: number): Promise<void> {
    const link = this.link;
    if (link === null || run !== this.run) return;
    if (this.publishing) {
      this.publishAgain = true;
      return;
    }
    this.publishing = true;
    if (this.publishTimer !== null) this.options.clock.clearTimeout(this.publishTimer);
    this.publishTimer = this.options.clock.setTimeout(() => void this.publish(run), PUBLISH_EVERY_MS);
    try {
      const ids = this.sharedIds();
      // A site with the sync hears of every connection here, each marked shared or not, so it can list them under
      // this computer. Read through the main process's own token, so it works with nobody signed in here.
      const own = this.siteSyncs === true && this.options.sync !== undefined ? await this.ownConnections() : null;
      const connections = own ?? (await this.sharedConnections(ids));
      if (run !== this.run) return;
      const response = await this.send(link.origin, "PUT", "/api/agent/connections", { connections }, link.token);
      await response.body?.cancel().catch(() => undefined);
      if (run !== this.run) return;
      if (response.status === 401) return this.siteForgotUs();
      if (!response.ok) throw new Error(`The site answered ${response.status}.`);
      this.publishedIds = ids;
      if (own !== null) this.publishedOwn = JSON.stringify(own);
    } catch (error) {
      // Tried again at the next turn. A person signed out here keeps the list the site already has.
      if (run === this.run && !(error instanceof Refused)) {
        logWarn(`Could not tell the site which connections are shared: ${error instanceof Error ? error.name : "unknown error"}.`);
      }
    } finally {
      if (run === this.run) {
        this.publishing = false;
        if (this.publishAgain) {
          this.publishAgain = false;
          void this.publish(run);
        }
      }
    }
  }

  /** Nothing to ask when nothing is shared, so unsharing everything reaches the site even with nobody signed in here. */
  private async sharedConnections(ids: readonly number[]): Promise<{ id: number; name: string; environment: string }[]> {
    if (ids.length === 0) return [];
    const signal = AbortSignal.any([AbortSignal.timeout(SITE_LIMIT_MS), this.stopping.signal]);
    const list = await listConnections({ call: this.options.call, sharedConnectionIds: this.options.sharedConnectionIds }, signal);
    return list.connections.map(({ id, name, environment }) => ({ id, name, environment }));
  }
}
