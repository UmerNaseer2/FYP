// A stand-in for a pg PoolClient, for route tests that must never reach a real
// database.
//
// A test lists "steps". Each one says which SQL it answers (a regular
// expression over the query text, plus an optional check on the bound values)
// and what to answer with: rows, a rowCount, an error carrying a SQLSTATE
// code, or a NOTICE to emit first. The first step that matches wins, so put
// the specific patterns before the general ones. A query no step matches gets
// no rows back, which is what most setup statements (BEGIN, SET LOCAL,
// CREATE TABLE IF NOT EXISTS) look like to a route anyway.
//
// Every query is recorded in order, so a test can check what the route said
// to the database: the order of BEGIN and the locks, the values bound to an
// INSERT, or that no DELETE ran at all.
//
// This file is not a test itself: Jest only runs tests/**/*.test.ts.

export type FakeStep = {
  /** Which queries this step answers. */
  match: RegExp;
  /** Also require the bound values to pass this check (for two queries with the same text). */
  when?: (values: readonly unknown[]) => boolean;
  rows?: Record<string, unknown>[];
  /** Defaults to the number of rows. */
  rowCount?: number;
  /**
   * Throw this instead of answering, the way pg reports a failed statement.
   * constraint and table are the extra fields a real pg error carries for a
   * constraint violation, and a route may read them to name what went wrong.
   */
  error?: { code?: string; message: string; constraint?: string; table?: string };
  /** Emit this NOTICE before answering, the way RAISE NOTICE arrives. */
  notice?: string;
  /**
   * The database ends the session just before this query arrives (its idle
   * limit, an administrator), and pg reports it the way it does for real
   * (checked on PostgreSQL 18): the connection's "error" listeners hear the
   * database's reason first, with this code, and then pg's own "Connection
   * terminated unexpectedly". This query and every later one fail with pg's
   * "not queryable" error, which has no code, and none of them is recorded,
   * as none reached the database.
   */
  endsSession?: { code: string; message: string };
};

export type RecordedQuery = {
  text: string;
  values: unknown[] | undefined;
  /** The protocol the route asked for: "extended" when it passed queryMode. */
  queryMode: string | undefined;
};

type NoticeListener = (notice: { message: string }) => void;
/** What pg hands an "error" listener: an Error, with a SQLSTATE code when the database sent it. */
type ErrorListener = (error: Error & { code?: string }) => void;

/** What pg answers a query sent on a connection that has already failed. */
const NOT_QUERYABLE = "Client has encountered a connection error and is not queryable";

export type FakeResult = { rows: Record<string, unknown>[]; rowCount: number };

/**
 * A query the way node-postgres accepts it: either the text on its own, or a
 * config object. The real client takes the same two shapes, and the analyze
 * route passes a config to ask for the extended protocol, so the stand-in has
 * to read a config too or that call would record as "[object Object]".
 */
export type QueryArg =
  | string
  | { text: string; values?: unknown[]; queryMode?: string };

export type FakeClient = {
  query: (arg: QueryArg, values?: unknown[]) => Promise<FakeResult>;
  on: (event: string, listener: NoticeListener | ErrorListener) => FakeClient;
  off: (event: string, listener: NoticeListener | ErrorListener) => FakeClient;
  listenerCount: (event: string) => number;
  release: (destroy?: boolean | Error) => void;
  /** Every query the route sent, in order. */
  queries: RecordedQuery[];
  /** How many times release() was called. More than once is a bug in the route. */
  releaseCount: number;
  /**
   * What release() was last called with. pg closes the connection instead of
   * returning it to the pool when this is true or an Error; undefined or false
   * hands it to the next request.
   */
  releasedWith: boolean | Error | undefined;
  /** NOTICE listeners still attached when release() was first called (should be 0). */
  listenersAtRelease: number | null;
};

export function createFakeClient(steps: FakeStep[]): FakeClient {
  const listeners = new Set<NoticeListener>();
  const errorListeners = new Set<ErrorListener>();
  // Set once a step has ended the session (endsSession).
  let sessionEnded = false;

  const client: FakeClient = {
    queries: [],
    releaseCount: 0,
    releasedWith: undefined,
    listenersAtRelease: null,

    async query(arg: QueryArg, values?: unknown[]): Promise<FakeResult> {
      // Normalise the two call shapes to one: a config object carries its own
      // text and values (and maybe a queryMode), while the plain-text form
      // takes its values from the second argument.
      const text = typeof arg === "string" ? arg : arg.text;
      const boundValues = typeof arg === "string" ? values : arg.values ?? values;
      const queryMode = typeof arg === "string" ? undefined : arg.queryMode;
      if (sessionEnded) throw new Error(NOT_QUERYABLE);
      const step = steps.find(
        (candidate) =>
          candidate.match.test(text) && (!candidate.when || candidate.when(boundValues ?? []))
      );
      if (step?.endsSession) {
        sessionEnded = true;
        // A real pg client with no "error" listener throws this out of the
        // socket's event handler, which takes the whole server down.
        if (errorListeners.size === 0) {
          throw new Error("fake-pg: the session ended and nothing was listening for the connection's errors");
        }
        const reason = Object.assign(new Error(step.endsSession.message), { code: step.endsSession.code });
        for (const listener of [...errorListeners]) listener(reason);
        const closed = new Error("Connection terminated unexpectedly");
        for (const listener of [...errorListeners]) listener(closed);
        throw new Error(NOT_QUERYABLE);
      }
      client.queries.push({ text, values: boundValues, queryMode });
      if (!step) return { rows: [], rowCount: 0 };

      if (step.notice) {
        for (const listener of [...listeners]) listener({ message: step.notice });
      }
      if (step.error) {
        const error = new Error(step.error.message) as Error & {
          code?: string;
          constraint?: string;
          table?: string;
        };
        if (step.error.code) error.code = step.error.code;
        if (step.error.constraint) error.constraint = step.error.constraint;
        if (step.error.table) error.table = step.error.table;
        throw error;
      }
      const rows = step.rows ?? [];
      return { rows, rowCount: step.rowCount ?? rows.length };
    },

    on(event: string, listener: NoticeListener | ErrorListener): FakeClient {
      if (event === "notice") listeners.add(listener as NoticeListener);
      if (event === "error") errorListeners.add(listener as ErrorListener);
      return client;
    },

    off(event: string, listener: NoticeListener | ErrorListener): FakeClient {
      if (event === "notice") listeners.delete(listener as NoticeListener);
      if (event === "error") errorListeners.delete(listener as ErrorListener);
      return client;
    },

    listenerCount(event: string): number {
      return event === "notice" ? listeners.size : 0;
    },

    release(destroy?: boolean | Error): void {
      if (client.releaseCount === 0) client.listenersAtRelease = listeners.size;
      client.releaseCount += 1;
      client.releasedWith = destroy;
    },
  };

  return client;
}

/** The texts of the recorded queries, with whitespace squeezed so a test can match one line. */
export function queryTexts(client: FakeClient): string[] {
  return client.queries.map((query) => query.text.replace(/\s+/g, " ").trim());
}

/** The recorded queries whose text matches a pattern. */
export function queriesMatching(client: FakeClient, pattern: RegExp): RecordedQuery[] {
  return client.queries.filter((query) => pattern.test(query.text));
}
