/**
 * The connection pools for target databases: one small pool per connection
 * config, kept for the life of the process, plus the time limits every pool
 * and every schema read runs under.
 */
import type { ClientConfig } from "pg";
import { Pool } from "pg";
import { BlockedHostError, checkConnectableHost } from "../connections/host-guard";

declare global {
  var __comparePgPoolMap: Map<string, Pool> | undefined;
}

function poolMap(): Map<string, Pool> {
  if (!globalThis.__comparePgPoolMap) {
    globalThis.__comparePgPoolMap = new Map();
  }
  return globalThis.__comparePgPoolMap;
}

function poolKey(cfg: ClientConfig): string {
  return [
    cfg.host ?? "",
    String(cfg.port ?? ""),
    cfg.database ?? "",
    cfg.user ?? "",
    cfg.password ?? "",
    // Encode the FULL ssl shape, not just on/off: { rejectUnauthorized: false }
    // (accept any cert) and {} (verify the cert) are different TLS behaviours
    // for the same host, so they must NOT share a pool — otherwise whichever
    // pool was created first silently wins for both callers.
    JSON.stringify(cfg.ssl ?? false),
  ].join("\0");
}

/**
 * Connections this app will open to any ONE target database.
 *
 * Deliberately small. These are other people's databases — a Supabase or Neon
 * free tier tops out around fifteen connections for every client combined, and
 * a comparison tool that eats a third of that budget is a bad guest. Reading a
 * schema is one connection held for one transaction, so a bigger pool would buy
 * parallelism the databases cannot afford.
 *
 * Callers that want several jobs at once size themselves against this number
 * rather than raising it: see COMPARE_TARGET_CONCURRENCY in lib/compare/run.ts.
 */
export const POOL_MAX = 6;

/**
 * How long `pool.connect()` waits for a free connection before giving up.
 *
 * Without it, a caller that asks for a connection the pool cannot supply waits
 * forever and the request hangs with no error anywhere — the worst possible
 * failure for a screen whose job is to tell you what is wrong. Ten seconds is
 * long enough to cover a TLS handshake to a sleeping serverless database and
 * short enough that a wedged pool reports itself instead of timing out at the
 * browser.
 */
const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * How long an unused connection sits open before the pool closes it.
 *
 * pg's own default is 10s; 30s here because the studio's screens come in
 * bursts — open Compare, look, run it again — and reconnecting to a hosted
 * database costs a full TLS handshake each time.
 */
const IDLE_TIMEOUT_MS = 30_000;

/**
 * Ceiling on any single catalog query in fetchSchemaSnapshot.
 *
 * Generous on purpose — introspecting a large schema is real work, and a
 * comparison that gives up on a slow-but-healthy database is worse than one
 * that takes a moment. This is a backstop against hanging, not a performance
 * budget.
 */
export const INTROSPECTION_TIMEOUT_MS = 30_000;

/**
 * How long a connection may sit with nothing arriving before the operating
 * system starts asking whether the database at the other end is still there.
 *
 * statement_timeout is enforced by the server, so a server that stops answering
 * (frozen, powered off, or cut off by a dropped network) never sends the error,
 * and pg puts no limit of its own on the wait. Without TCP keepalive the socket
 * stays open for ever, and so does whatever is waiting on it: one such database
 * once stopped every scheduled drift check. With it, the operating system
 * notices the silence, closes the socket, and pg reports an ordinary error.
 *
 * Ten seconds of quiet before the first probe, because a probe is an empty
 * packet and costs nothing. How soon a dead peer is noticed after that is up to
 * the operating system. It is a backstop, not a time limit: a machine that is
 * still up answers the probes even while the database on it is stuck, which is
 * why lib/drift/scheduler also stops waiting for a slow check.
 *
 * There is deliberately no pool-wide query_timeout. These pools also run
 * migrations (app/api/scripts/apply), and a migration that rewrites a big table
 * can honestly take longer than any limit picked here.
 */
const KEEPALIVE_INITIAL_DELAY_MS = 10_000;

/**
 * The pool for a host this server refuses to dial.
 *
 * Every caller borrows a connection first — or calls query(), which borrows one
 * internally — so refusing both is enough to keep the socket from ever being
 * opened, and the caller's own "could not connect" path puts the reason in
 * front of the user. Handing back a real pool and trusting nobody to use it is
 * the bug this exists to prevent.
 *
 * Nothing is cached: there is no connection to reuse, and the answer can change
 * between one request and the next (ALLOW_PRIVATE_DB_HOSTS).
 */
function refusingPool(message: string): Pool {
  const refuse = () => Promise.reject(new BlockedHostError(message));
  // Written as a plain record and cast at the end: this is the small part of a
  // pg Pool this app uses — connect, query, end, and the "error" listener
  // getPoolForConfig attaches below — with the part that opens a socket left
  // out. TypeScript is right that it is not a Pool; the cast is the honest way
  // to say so in one place.
  const stub: Record<string, unknown> = {
    connect: refuse,
    query: refuse,
    end: () => Promise.resolve(),
  };
  // A pg pool hands itself back from .on() so listeners can be chained.
  stub.on = () => stub;
  return stub as unknown as Pool;
}

export function getPoolForConfig(cfg: ClientConfig): Pool {
  // Last line of defence against dialling a host this server refuses — cloud
  // metadata, the private network, its own unix socket. Saving a connection
  // checks the same rule (checkConnectionTarget), but rows saved before that
  // check existed, and a deployment that has since become production, both
  // arrive here. Every target-database connection in the app is opened through
  // this function, which is what makes "never dial a blocked host" true rather
  // than "checked wherever somebody remembered to".
  //
  // cfg.host is the host the driver uses: these configs come from buildPgConfig,
  // which has already resolved any connection string into plain fields.
  const hostCheck = checkConnectableHost(cfg.host);
  if (!hostCheck.ok) return refusingPool(hostCheck.message);

  const key = poolKey(cfg);
  const map = poolMap();
  let p = map.get(key);
  if (!p) {
    p = new Pool({
      ...cfg,
      max: POOL_MAX,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
    });
    // A pool with no 'error' listener crashes the process when an idle
    // connection drops — and hosted databases drop idle connections routinely.
    // Log it and let the pool discard the client; the next caller gets a fresh
    // one, which is exactly what the pool is for.
    p.on("error", (error) => {
      console.error(`Idle connection to ${cfg.host ?? "?"} failed:`, error.message);
    });
    map.set(key, p);
  }
  return p;
}
