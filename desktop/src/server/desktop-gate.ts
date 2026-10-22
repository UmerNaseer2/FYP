/**
 * The lock on the app's own web server.
 *
 * The desktop app runs the same Next.js server as the web version, here on
 * this computer at http://127.0.0.1:<port>. Every program on the computer can
 * reach that address, and a web page open in the person's browser can make the
 * browser send requests to it. The gate lets in only the app's own window:
 *
 *  - The request must come from this computer.
 *  - It must be addressed to 127.0.0.1:<port> exactly. A web page that makes
 *    its own name point at 127.0.0.1 (a trick called DNS rebinding) still
 *    sends its own name, so it is turned away.
 *  - It must carry a token the app makes up each time it starts and adds to
 *    every request its window sends (src/main/security.ts). Nothing else knows
 *    the token: it is never written to disk or put in an address.
 *
 * Everything else gets a short "403 Forbidden" before Next.js sees it. The
 * gate also turns away WebSocket upgrades and CONNECT, which the app never
 * uses.
 *
 * The gate wraps http.createServer before Next.js starts (desktop-launcher.ts),
 * so it stands in front of every server Next.js makes. Tested with a real
 * server in src/test/desktop-gate.test.ts.
 */
import crypto from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/** The request header that carries the token. */
export const GATE_HEADER = "x-schema-studio-gate";

const REFUSAL = "This server only answers the Schema Studio app on this computer.\n";

/** The one part of node:http the gate changes. Tests pass a stand-in, so the real one is left alone. */
export type HttpModule = { createServer: typeof import("node:http").createServer };

export type GateOptions = {
  /** The token every request must carry. */
  token: string;
  /** The port the server was told to use; requests must be addressed to it. */
  port: number;
  /** Called once, when the server starts listening on that port. */
  onListening: () => void;
};

type Emit = (event: string | symbol, ...args: unknown[]) => boolean;

export function installGate(httpModule: HttpModule, options: GateOptions): void {
  const createServer = httpModule.createServer as (...args: unknown[]) => Server;
  const expectedHost = `127.0.0.1:${options.port}`;
  const token = Buffer.from(options.token);
  let announced = false;

  function allowed(req: IncomingMessage): boolean {
    const address = req.socket.remoteAddress;
    if (address !== "127.0.0.1" && address !== "::ffff:127.0.0.1") return false;
    if (req.headers.host !== expectedHost) return false;
    // Two copies of the header arrive joined into one ("a, b") and fail here.
    const given = req.headers[GATE_HEADER];
    if (typeof given !== "string") return false;
    const givenBytes = Buffer.from(given);
    return givenBytes.length === token.length && crypto.timingSafeEqual(givenBytes, token);
  }

  // The token has done its job once the request is let in. Taking it out
  // means nothing further along (Next.js, the web app, a log) ever sees it.
  function removeToken(req: IncomingMessage): void {
    delete req.headers[GATE_HEADER];
    for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
      if (req.rawHeaders[i].toLowerCase() === GATE_HEADER) req.rawHeaders.splice(i, 2);
    }
  }

  function refuse(req: IncomingMessage, res: ServerResponse): void {
    // Read and drop whatever the request still sends, so the answer is not
    // held up behind it.
    req.resume();
    res.writeHead(403, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(REFUSAL),
      "Cache-Control": "no-store",
      Connection: "close",
    });
    res.end(REFUSAL);
  }

  function refuseSocket(socket: Duplex): void {
    socket.on("error", () => {
      // The other side went away first; there is nobody left to tell.
    });
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    // In case the other side never closes its end.
    setTimeout(() => socket.destroy(), 1000).unref();
  }

  function guard(server: Server): void {
    const emit = server.emit.bind(server) as Emit;
    const guarded: Emit = (event, ...args) => {
      if (event === "request" || event === "checkContinue" || event === "checkExpectation") {
        const req = args[0] as IncomingMessage;
        if (!allowed(req)) {
          refuse(req, args[1] as ServerResponse);
          return true;
        }
        removeToken(req);
      } else if (event === "upgrade" || event === "connect") {
        refuseSocket(args[1] as Duplex);
        return true;
      }

      const handled = emit(event, ...args);
      if (event === "listening" && !announced) {
        const address = server.address();
        if (address !== null && typeof address === "object" && address.port === options.port) {
          announced = true;
          options.onListening();
        }
      }
      return handled;
    };
    server.emit = guarded as typeof server.emit;
  }

  httpModule.createServer = function (this: unknown, ...args: unknown[]): Server {
    const server = createServer.apply(this, args);
    guard(server);
    return server;
  } as typeof httpModule.createServer;
}
