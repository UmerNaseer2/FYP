/**
 * The local address the browser comes back to after the Microsoft sign-in.
 *
 * Microsoft sends the browser back to http://localhost:<port>, on this
 * computer, with the sign-in's one-time code in a form that the page posts
 * there ("form_post"). That keeps the code out of the address bar and the
 * browser's history. Microsoft ignores the port when it checks the address
 * against the app's registration, so any free port works.
 *
 * judgeLoopbackRequest (src/core/loopback.ts) decides what each request is;
 * this file does the networking. The tab that posted the code is kept
 * waiting until the app has traded the code for tokens, so that the page it
 * then shows can truthfully say "You're signed in" or that the sign-in did
 * not finish.
 *
 * "localhost" means 127.0.0.1 on some computers and ::1 on others, so it
 * listens on both, on the same port. Neither can be reached from the network.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  judgeLoopbackRequest,
  loopbackPage,
  LOOPBACK_HEADERS,
  MAX_BODY_BYTES,
  type LoopbackPageKind,
  type LoopbackVerdict,
} from "../core/loopback";
import { logInfo, logWarn } from "./log";

/** What the browser brought back: a code to trade, or Microsoft's error. */
export type LoopbackResult = Exclude<LoopbackVerdict, { kind: "respond" }>;

/** How long the tab that brought the code waits for the app to finish with it. */
const HOLD_MS = 60_000;
/** Tries at finding a port that is free on both addresses. */
const BIND_TRIES = 5;

function listen(server: http.Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => {
      server.off("error", reject);
      server.on("error", (error) => logWarn("The sign-in's local address hit a problem.", error));
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

export class LoopbackServer {
  private readonly state: string;
  private readonly servers: http.Server[] = [];
  private boundPort = 0;
  private result: LoopbackResult | null = null;
  private readonly waiters: ((result: LoopbackResult) => void)[] = [];
  /** The tab that brought the code, until it is told how the sign-in ended. */
  private held: { res: http.ServerResponse; timer: NodeJS.Timeout } | null = null;
  private closed = false;

  private constructor(state: string) {
    this.state = state;
  }

  /** Starts listening on a free port. `state` is the sign-in's own random value, which the answer must carry. */
  static async open(state: string): Promise<LoopbackServer> {
    const loopback = new LoopbackServer(state);
    await loopback.bind();
    logInfo(`Waiting for the browser to come back from Microsoft, on port ${loopback.port}.`);
    return loopback;
  }

  get port(): number {
    return this.boundPort;
  }

  /** The address Microsoft sends the browser back to. It says "localhost", as registered in Microsoft Entra. */
  get redirectUri(): string {
    return `http://localhost:${this.boundPort}`;
  }

  private makeServer(): http.Server {
    return http.createServer((req, res) => this.handle(req, res));
  }

  private async bind(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const v4 = this.makeServer();
      const port = await listen(v4, "127.0.0.1", 0);
      const v6 = this.makeServer();
      try {
        await listen(v6, "::1", port);
        this.servers.push(v4, v6);
      } catch (error) {
        const code = errorCode(error);
        if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") {
          // No IPv6 on this computer, so "localhost" can only mean 127.0.0.1.
          this.servers.push(v4);
        } else {
          v4.close();
          // Another program has that port on ::1: try another port.
          if (code === "EADDRINUSE" && attempt < BIND_TRIES) continue;
          throw error;
        }
      }
      this.boundPort = port;
      return;
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Answered now; the rest is read and thrown away.
        tooBig = true;
        chunks.length = 0;
        this.respondTo(req, res, null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooBig) this.respondTo(req, res, Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => res.destroy());
  }

  private respondTo(req: http.IncomingMessage, res: http.ServerResponse, body: string | null): void {
    const method = req.method;
    // One answer per sign-in. Anything after it is not from Microsoft.
    if (this.result !== null || this.closed) {
      this.send(res, method, 400, "unexpected");
      return;
    }
    const verdict = judgeLoopbackRequest(
      { method, host: req.headers.host, path: req.url ?? "/", contentType: req.headers["content-type"], body },
      { port: this.boundPort, state: this.state },
    );
    switch (verdict.kind) {
      case "respond":
        this.send(res, method, verdict.status, verdict.page, verdict.headers);
        return;
      case "code": {
        // Answered by finish(), once the code has been traded, or after a
        // minute whatever happens.
        const timer = setTimeout(() => this.answerHeld("failed"), HOLD_MS);
        timer.unref();
        this.held = { res, timer };
        break;
      }
      case "error":
        this.send(res, method, 200, "failed");
        break;
    }
    this.result = verdict;
    for (const notify of this.waiters.splice(0)) notify(verdict);
  }

  /** The browser's answer, once it comes. Rejects with the signal's reason if the wait is stopped first. */
  waitForResult(signal: AbortSignal): Promise<LoopbackResult> {
    const { result } = this;
    if (result !== null) return Promise.resolve(result);
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      const waiter = (value: LoopbackResult) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Tells the tab that brought the code how the sign-in ended. */
  finish(outcome: "signed-in" | "failed"): void {
    this.answerHeld(outcome);
  }

  private answerHeld(kind: LoopbackPageKind): void {
    const { held } = this;
    if (held === null) return;
    this.held = null;
    clearTimeout(held.timer);
    this.send(held.res, "POST", 200, kind);
  }

  private send(
    res: http.ServerResponse,
    method: string | undefined,
    status: number,
    kind: LoopbackPageKind,
    extra?: Record<string, string>,
  ): void {
    // The tab may have been closed while it waited.
    if (res.headersSent || res.destroyed) return;
    const page = loopbackPage(kind);
    res.writeHead(status, {
      ...LOOPBACK_HEADERS,
      ...extra,
      Connection: "close",
      "Content-Length": Buffer.byteLength(page),
    });
    if (method === "HEAD") res.end();
    else res.end(page);
  }

  /** Stops listening. A tab still waiting is told the sign-in did not finish. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.answerHeld("failed");
    for (const server of this.servers) {
      server.close();
      server.closeIdleConnections();
    }
    // A browser may hold a connection open. The last page gets a moment to
    // arrive before every connection is cut.
    const timer = setTimeout(() => {
      for (const server of this.servers) server.closeAllConnections();
    }, 2_000);
    timer.unref();
  }
}
