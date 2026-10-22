/**
 * The lock on the app's own web server (src/server/desktop-gate.ts), tried
 * against real servers on this computer.
 *
 * Each test gives the gate a stand-in for node:http, so the real
 * http.createServer, which the test's own requests use, is never changed.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import { GATE_HEADER, installGate, type HttpModule } from "../server/desktop-gate";

// Made up for the tests. The app makes a new random one every time it starts.
const TOKEN = "test-gate-" + "t".repeat(33);

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as net.AddressInfo;
  const closed = once(probe, "close");
  probe.close();
  await closed;
  return port;
}

type Gated = {
  server: http.Server;
  /** The requests that got past the gate, as the web app sees them. */
  seen: http.IncomingMessage[];
  listeningCalls: () => number;
};

/** A server behind a gate that expects `port`. It is not listening yet. */
function gatedServer(port: number): Gated {
  const fake: HttpModule = { createServer: http.createServer };
  let calls = 0;
  installGate(fake, {
    token: TOKEN,
    port,
    onListening: () => {
      calls += 1;
    },
  });
  const seen: http.IncomingMessage[] = [];
  const server = fake.createServer((req, res) => {
    seen.push(req);
    res.end("hello from the web app");
  });
  return { server, seen, listeningCalls: () => calls };
}

async function listen(server: http.Server, port: number, host = "127.0.0.1"): Promise<void> {
  server.listen(port, host);
  await once(server, "listening");
}

async function stop(server: http.Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  const closed = once(server, "close");
  server.close();
  await closed;
}

type Answer = { status: number; body: string };

function send(port: number, headers: http.OutgoingHttpHeaders, host = "127.0.0.1"): Promise<Answer> {
  return new Promise((resolve, reject) => {
    // A connection of its own each time (agent: false), so none stays open
    // after the test.
    const req = http.request({ host, port, path: "/", method: "GET", headers, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("lets in the app's window, and takes the token out before the web app sees the request", async () => {
  const port = await freePort();
  const gated = gatedServer(port);
  await listen(gated.server, port);
  try {
    const answer = await send(port, { [GATE_HEADER]: TOKEN, "x-other": "kept" });
    assert.deepEqual(answer, { status: 200, body: "hello from the web app" });
    assert.equal(gated.seen.length, 1);
    const req = gated.seen[0];
    assert.equal(req.headers[GATE_HEADER], undefined);
    assert.equal(req.rawHeaders.some((part) => part.toLowerCase() === GATE_HEADER || part === TOKEN), false);
    assert.equal(req.headers["x-other"], "kept");
  } finally {
    await stop(gated.server);
  }
});

test("says the server is listening, once", async () => {
  const port = await freePort();
  const gated = gatedServer(port);
  await listen(gated.server, port);
  try {
    await send(port, { [GATE_HEADER]: TOKEN });
    assert.equal(gated.listeningCalls(), 1);
  } finally {
    await stop(gated.server);
  }
});

test("does not say the server is listening when it is on a different port", async () => {
  const port = await freePort();
  let other = await freePort();
  while (other === port) other = await freePort();
  const gated = gatedServer(port);
  await listen(gated.server, other);
  try {
    assert.equal(gated.listeningCalls(), 0);
  } finally {
    await stop(gated.server);
  }
});

test("turns away every request without the right token and name, before the web app sees it", async () => {
  const port = await freePort();
  const gated = gatedServer(port);
  await listen(gated.server, port);
  try {
    const attempts: [string, http.OutgoingHttpHeaders][] = [
      ["no token", {}],
      ["a wrong token of the same length", { [GATE_HEADER]: TOKEN.slice(0, -1) + "x" }],
      ["a shorter token", { [GATE_HEADER]: TOKEN.slice(0, 10) }],
      ["the token sent twice", { [GATE_HEADER]: [TOKEN, TOKEN] }],
      ["the token for another name", { host: `evil.example:${port}`, [GATE_HEADER]: TOKEN }],
      ["the token for localhost instead of 127.0.0.1", { host: `localhost:${port}`, [GATE_HEADER]: TOKEN }],
      ["the token without the port", { host: "127.0.0.1", [GATE_HEADER]: TOKEN }],
    ];
    for (const [what, headers] of attempts) {
      const answer = await send(port, headers);
      assert.equal(answer.status, 403, what);
      assert.match(answer.body, /only answers the Schema Studio app/, what);
    }
    assert.equal(gated.seen.length, 0);
  } finally {
    await stop(gated.server);
  }
});

test("turns away WebSocket upgrades, even with the token", async () => {
  const port = await freePort();
  const gated = gatedServer(port);
  let upgraded = false;
  gated.server.on("upgrade", () => {
    upgraded = true;
  });
  await listen(gated.server, port);
  try {
    const answer = await send(port, { [GATE_HEADER]: TOKEN, Connection: "Upgrade", Upgrade: "websocket" });
    assert.equal(answer.status, 403);
    assert.equal(upgraded, false);
    assert.equal(gated.seen.length, 0);
  } finally {
    await stop(gated.server);
  }
});

test("lets in only 127.0.0.1, even on a server that also listens on IPv6", async (t) => {
  const port = await freePort();
  const gated = gatedServer(port);
  try {
    await listen(gated.server, port, "::");
  } catch {
    t.skip("this computer has no IPv6");
    return;
  }
  try {
    // From IPv4, a server listening on "::" sees ::ffff:127.0.0.1, which is still 127.0.0.1.
    assert.equal((await send(port, { [GATE_HEADER]: TOKEN })).status, 200);

    let fromIpv6: Answer;
    try {
      fromIpv6 = await send(port, { host: `127.0.0.1:${port}`, [GATE_HEADER]: TOKEN }, "::1");
    } catch {
      t.skip("this computer cannot connect over IPv6");
      return;
    }
    assert.equal(fromIpv6.status, 403);
    assert.equal(gated.seen.length, 1);
  } finally {
    await stop(gated.server);
  }
});
