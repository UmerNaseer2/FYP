/**
 * The Microsoft sign-in (src/main/auth.ts) when it is cancelled at the last
 * moment, while the code from the browser is being traded for tokens.
 *
 * Microsoft's own library (MSAL) does its real work here, saving through the
 * app's cache plugin as it does in the app. Only the edges are stand-ins: the
 * network client plays Microsoft, a fake Electron "opens the browser", and
 * the test plays the browser coming back to the real local address
 * (loopback-server.ts). Nothing leaves this computer.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test, { mock } from "node:test";

import { loopbackPage } from "../core/loopback";
import type { AuthState } from "../core/secrets-file";
import type { SignInResult } from "../shared/ipc";

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const TENANT_ID = "66666666-7777-8888-9999-000000000000";
const OID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const MICROSOFT = "https://login.microsoftonline.com";

// Electron is not here when the tests run in Node, so a stand-in takes its
// place before auth.ts loads. It notes each address the app opens "in the
// browser".
let onOpen: (url: string) => void = () => {};
const electron = {
  shell: { openExternal: async (url: string) => onOpen(url) },
  net: { isOnline: () => true },
};
require.cache[require.resolve("electron")] = { exports: electron, loaded: true } as unknown as NodeJS.Module;
const { Auth } = require("../main/auth") as typeof import("../main/auth");
const { ElectronNetworkClient } = require("../main/net-client") as typeof import("../main/net-client");

type Answer = { headers: Record<string, string>; body: unknown; status: number };

/** Base64url, as JSON Web Tokens use. */
function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Microsoft's answer to the code: an ID token for this sign-in's nonce, and a refresh token. */
function tokens(nonce: string): Answer {
  const now = Math.floor(Date.now() / 1000);
  const idToken = [
    b64({ alg: "RS256", typ: "JWT" }),
    b64({
      aud: CLIENT_ID,
      iss: `${MICROSOFT}/${TENANT_ID}/v2.0`,
      iat: now,
      nbf: now,
      exp: now + 3600,
      nonce,
      oid: OID,
      sub: "subject",
      tid: TENANT_ID,
      preferred_username: "sam@example.com",
      name: "Sam",
      ver: "2.0",
    }),
    "signature",
  ].join(".");
  return {
    status: 200,
    headers: {},
    body: {
      token_type: "Bearer",
      scope: "openid profile email",
      expires_in: 3600,
      ext_expires_in: 3600,
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: idToken,
      client_info: b64({ uid: OID, utid: TENANT_ID }),
    },
  };
}

/** The browser coming back from Microsoft to the app's local address, with the code. Not awaited: the page waits until the code is traded. */
function comeBack(redirectUri: string, state: string): Promise<string> {
  const { port } = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/",
        headers: { Host: `localhost:${port}`, "Content-Type": "application/x-www-form-urlencoded" },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(`code=the-code&state=${encodeURIComponent(state)}`);
  });
}

/**
 * Starts a sign-in with nothing saved, and plays the browser and Microsoft
 * up to the moment Microsoft has been asked to trade the code. `answer`
 * then sends Microsoft's tokens.
 */
async function signInUpToTheTrade() {
  const saved: AuthState[] = [];
  const auth = new Auth({
    config: { clientId: CLIENT_ID, tenantId: TENANT_ID },
    state: { msalCache: null, lastOnlineCheck: null },
    save: (state) => {
      saved.push(state);
    },
    focusWindow: () => {},
  });

  let nonce = "";
  let page: Promise<string> | null = null;
  onOpen = (address) => {
    const url = new URL(address);
    nonce = url.searchParams.get("nonce") ?? "";
    page = comeBack(url.searchParams.get("redirect_uri") ?? "", url.searchParams.get("state") ?? "");
  };

  let trade: (answer: Answer) => void = () => {};
  const asked = new Promise<void>((askedNow) => {
    // MSAL knows where login.microsoftonline.com's pages are without asking, so the only request is the trade itself.
    mock.method(ElectronNetworkClient.prototype, "sendGetRequestAsync", async (url: string) => {
      throw new Error(`The test has no answer for GET ${url}`);
    });
    mock.method(ElectronNetworkClient.prototype, "sendPostRequestAsync", (url: string) => {
      if (!new URL(url).pathname.endsWith("/oauth2/v2.0/token")) throw new Error(`The test has no answer for POST ${url}`);
      askedNow();
      return new Promise<Answer>((answerNow) => {
        trade = answerNow;
      });
    });
  });

  const result: Promise<SignInResult> = auth.signIn();
  await asked;
  return {
    auth,
    saved,
    result,
    answer: () => trade(tokens(nonce)),
    page: () => page ?? Promise.reject(new Error("The browser was never opened.")),
  };
}

test("a sign-in that finishes keeps the account, so the test's stand-ins work", async (t) => {
  t.after(() => mock.restoreAll());
  const run = await signInUpToTheTrade();
  run.answer();
  const result = await run.result;
  assert.equal(result.ok, true);
  assert.ok(run.saved.some((state) => (state.msalCache ?? "").includes(OID)), "the account was saved");
  assert.equal(await run.auth.hasAccount(), true);
  assert.notEqual(run.auth.lastOnlineCheck(), null);
  await run.page();
});

test("Cancel while the code is being traded saves nothing, and leaves the person signed out", async (t) => {
  t.after(() => mock.restoreAll());
  const run = await signInUpToTheTrade();
  run.auth.cancelSignIn();
  run.answer();
  const result = await run.result;
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "cancelled");
  assert.deepEqual(run.saved, [], "nothing was saved");
  assert.equal(await run.auth.hasAccount(), false);
  assert.equal(run.auth.lastOnlineCheck(), null);
  // The browser tab is not told the sign-in worked.
  assert.equal(await run.page(), loopbackPage("failed"));
});

test("a newer sign-in started while the code is being traded makes the older one save nothing", async (t) => {
  t.after(() => mock.restoreAll());
  const run = await signInUpToTheTrade();
  // The newer sign-in waits in the browser, so only the older one reaches Microsoft.
  onOpen = () => {};
  // Pressing Sign in again starts over, which stops this attempt.
  const newer = run.auth.signIn();
  t.after(() => run.auth.cancelSignIn());
  run.answer();
  const result = await run.result;
  assert.equal(!result.ok && result.reason, "cancelled");
  assert.deepEqual(run.saved, [], "nothing was saved");
  run.auth.cancelSignIn();
  assert.equal((await newer).ok, false);
  assert.equal(await run.auth.hasAccount(), false);
});
