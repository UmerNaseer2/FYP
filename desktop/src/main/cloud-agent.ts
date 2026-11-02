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
import { utf8 } from "../shared/remote/bytes";
import type { CloudLinkResult, CloudView } from "../shared/ipc";
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
};

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
    if (job === null) return this.schedulePoll(run, this.nextPollMs());
    this.busyUntil = this.options.clock.now() + BUSY_FOR_MS;
    void this.answer(run, link, job);
    // At once, because a second question may be waiting behind this one.
    this.schedulePoll(run, 0);
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
      const connections = await this.sharedConnections(ids);
      if (run !== this.run) return;
      const response = await this.send(link.origin, "PUT", "/api/agent/connections", { connections }, link.token);
      await response.body?.cancel().catch(() => undefined);
      if (run !== this.run) return;
      if (response.status === 401) return this.siteForgotUs();
      if (!response.ok) throw new Error(`The site answered ${response.status}.`);
      this.publishedIds = ids;
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
