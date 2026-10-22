/**
 * The local address the browser comes back to after the Microsoft sign-in
 * (src/main/loopback-server.ts), over real connections on this computer.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { loopbackPage } from "../core/loopback";
import { LoopbackServer } from "../main/loopback-server";

const STATE = "state-" + "s".repeat(30);

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

/** One request, as the browser would send it, on a connection of its own. A form makes it a POST. */
function ask(loopback: LoopbackServer, options: { method?: string; host?: string; form?: string } = {}): Promise<Reply> {
  const { port } = loopback;
  const headers: Record<string, string> = { Host: options.host ?? `localhost:${port}` };
  if (options.form !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
  const method = options.method ?? (options.form === undefined ? "GET" : "POST");
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: "/", headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(options.form);
  });
}

async function withLoopback(run: (loopback: LoopbackServer) => Promise<void>): Promise<void> {
  const loopback = await LoopbackServer.open(STATE);
  try {
    await run(loopback);
  } finally {
    loopback.close();
  }
}

/** A signal that is never aborted. */
const forever = () => new AbortController().signal;

test("the address Microsoft sends the browser back to is http://localhost and the port", async () => {
  await withLoopback(async (loopback) => {
    assert.ok(loopback.port > 0);
    assert.equal(loopback.redirectUri, `http://localhost:${loopback.port}`);
  });
});

test("a tab that opens the address before the sign-in ends is told to wait", async () => {
  await withLoopback(async (loopback) => {
    const reply = await ask(loopback);
    assert.equal(reply.status, 200);
    assert.equal(reply.body, loopbackPage("waiting"));
    assert.equal(reply.headers["cache-control"], "no-store");
    assert.equal(reply.headers.connection, "close");
  });
});

test("a HEAD request gets the headers and no page", async () => {
  await withLoopback(async (loopback) => {
    const reply = await ask(loopback, { method: "HEAD" });
    assert.equal(reply.status, 200);
    assert.equal(reply.body, "");
    assert.equal(reply.headers["content-length"], String(Buffer.byteLength(loopbackPage("waiting"))));
  });
});

test("the tab that brings the code waits until the code has been traded", async () => {
  await withLoopback(async (loopback) => {
    const reply = ask(loopback, { form: `code=the-code&state=${STATE}&client_info=info` });
    assert.deepEqual(await loopback.waitForResult(forever()), { kind: "code", code: "the-code", clientInfo: "info" });
    loopback.finish("signed-in");
    const page = await reply;
    assert.equal(page.status, 200);
    assert.equal(page.body, loopbackPage("signed-in"));
  });
});

test("the tab hears that the sign-in did not finish when the trade fails", async () => {
  await withLoopback(async (loopback) => {
    const reply = ask(loopback, { form: `code=the-code&state=${STATE}` });
    await loopback.waitForResult(forever());
    loopback.finish("failed");
    assert.equal((await reply).body, loopbackPage("failed"));
  });
});

test("an answer with the wrong state is refused and does not count", async () => {
  await withLoopback(async (loopback) => {
    const wrong = await ask(loopback, { form: "code=stolen&state=wrong" });
    assert.equal(wrong.status, 400);
    const reply = ask(loopback, { form: `code=the-code&state=${STATE}` });
    assert.deepEqual(await loopback.waitForResult(forever()), { kind: "code", code: "the-code", clientInfo: null });
    loopback.finish("signed-in");
    assert.equal((await reply).status, 200);
  });
});

test("Microsoft's error is passed on, and the tab is told the sign-in did not finish", async () => {
  await withLoopback(async (loopback) => {
    const reply = await ask(loopback, {
      form: `error=access_denied&error_description=AADSTS65004%3A+User+declined&state=${STATE}`,
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.body, loopbackPage("failed"));
    assert.deepEqual(await loopback.waitForResult(forever()), {
      kind: "error",
      error: "access_denied",
      description: "AADSTS65004: User declined",
    });
  });
});

test("only the first answer counts", async () => {
  await withLoopback(async (loopback) => {
    await ask(loopback, { form: `error=access_denied&state=${STATE}` });
    const again = await ask(loopback, { form: `code=the-code&state=${STATE}` });
    assert.equal(again.status, 400);
    assert.equal(again.body, loopbackPage("unexpected"));
    assert.equal((await loopback.waitForResult(forever())).kind, "error");
  });
});

test("a request that names another host is refused", async () => {
  await withLoopback(async (loopback) => {
    const reply = await ask(loopback, { host: `attacker.example:${loopback.port}`, form: `code=the-code&state=${STATE}` });
    assert.equal(reply.status, 400);
  });
});

test("stopping the wait rejects it with the reason, before or during the wait", async () => {
  await withLoopback(async (loopback) => {
    const reason = new Error("stopped");
    const before = new AbortController();
    before.abort(reason);
    await assert.rejects(loopback.waitForResult(before.signal), (error) => error === reason);

    const during = new AbortController();
    const waiting = loopback.waitForResult(during.signal);
    during.abort(reason);
    await assert.rejects(waiting, (error) => error === reason);
  });
});

test("closing tells a tab still waiting that the sign-in did not finish, and takes no more connections", async () => {
  const loopback = await LoopbackServer.open(STATE);
  const reply = ask(loopback, { form: `code=the-code&state=${STATE}` });
  await loopback.waitForResult(forever());
  loopback.close();
  const page = await reply;
  assert.equal(page.status, 200);
  assert.equal(page.body, loopbackPage("failed"));
  await assert.rejects(ask(loopback));
});
