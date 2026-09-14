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
  /** Throw this instead of answering, the way pg reports a failed statement. */
  error?: { code?: string; message: string };
  /** Emit this NOTICE before answering, the way RAISE NOTICE arrives. */
  notice?: string;
};

export type RecordedQuery = { text: string; values: unknown[] | undefined };

type NoticeListener = (notice: { message: string }) => void;

export type FakeResult = { rows: Record<string, unknown>[]; rowCount: number };

export type FakeClient = {
  query: (text: string, values?: unknown[]) => Promise<FakeResult>;
  on: (event: string, listener: NoticeListener) => FakeClient;
  off: (event: string, listener: NoticeListener) => FakeClient;
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

  const client: FakeClient = {
    queries: [],
    releaseCount: 0,
    releasedWith: undefined,
    listenersAtRelease: null,

    async query(text: string, values?: unknown[]): Promise<FakeResult> {
      client.queries.push({ text, values });
      const step = steps.find(
        (candidate) => candidate.match.test(text) && (!candidate.when || candidate.when(values ?? []))
      );
      if (!step) return { rows: [], rowCount: 0 };

      if (step.notice) {
        for (const listener of [...listeners]) listener({ message: step.notice });
      }
      if (step.error) {
        const error = new Error(step.error.message) as Error & { code?: string };
        if (step.error.code) error.code = step.error.code;
        throw error;
      }
      const rows = step.rows ?? [];
      return { rows, rowCount: step.rowCount ?? rows.length };
    },

    on(event: string, listener: NoticeListener): FakeClient {
      if (event === "notice") listeners.add(listener);
      return client;
    },

    off(event: string, listener: NoticeListener): FakeClient {
      if (event === "notice") listeners.delete(listener);
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
