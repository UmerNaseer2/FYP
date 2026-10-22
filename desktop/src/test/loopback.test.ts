/**
 * What the app does with each request to its sign-in address, the pages it
 * sends back, and how it explains Microsoft's errors (src/core/loopback.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  LOOPBACK_HEADERS,
  MAX_BODY_BYTES,
  describeAuthError,
  judgeLoopbackRequest,
  loopbackPage,
  type LoopbackPageKind,
  type LoopbackRequest,
} from "../core/loopback";

const EXPECTED = { port: 53123, state: "s-1234" };

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/** Microsoft's answer, posted by the browser, unless a test changes part of it. */
function request(changes: Partial<LoopbackRequest> = {}): LoopbackRequest {
  return {
    method: "POST",
    host: "localhost:53123",
    path: "/",
    contentType: "application/x-www-form-urlencoded",
    body: form({ code: "one-time-code", client_info: "client-info", state: "s-1234" }),
    ...changes,
  };
}

function judge(changes: Partial<LoopbackRequest> = {}) {
  return judgeLoopbackRequest(request(changes), EXPECTED);
}

function refused(status: number) {
  return { kind: "respond", status, page: "unexpected" };
}

const CODE = { kind: "code", code: "one-time-code", clientInfo: "client-info" };

test("takes the code from Microsoft's answer", () => {
  assert.deepEqual(judge(), CODE);
});

test("accepts the address the browser was sent to, written any of the ways it can be", () => {
  for (const host of ["localhost:53123", "LOCALHOST:53123", "127.0.0.1:53123", "[::1]:53123"]) {
    assert.deepEqual(judge({ host }), CODE, host);
  }
});

test("turns away a request addressed to any other name or port", () => {
  for (const host of ["localhost:1", "evil.example:53123", "localhost", undefined]) {
    assert.deepEqual(judge({ host }), refused(400), String(host));
  }
});

test("answers only at /, ignoring a #part and anything in the address of a post", () => {
  assert.deepEqual(judge({ path: "/callback" }), refused(404));
  assert.deepEqual(judge({ path: "//evil.example/" }), refused(404));
  assert.deepEqual(judge({ path: "/#part" }), CODE);
  assert.deepEqual(judge({ path: "/?x=1" }), CODE);
});

test("someone opening the address themselves gets the waiting page", () => {
  const waiting = { kind: "respond", status: 200, page: "waiting" };
  assert.deepEqual(judge({ method: "GET", body: "" }), waiting);
  assert.deepEqual(judge({ method: "HEAD", body: "" }), waiting);
  assert.deepEqual(judge({ method: "GET", path: "/?utm=1", body: "" }), waiting);
});

test("a code, error or state in the address is turned away, because Microsoft was asked to post them", () => {
  for (const path of ["/?code=abc", "/?error=access_denied", "/?state=s-1234"]) {
    assert.deepEqual(judge({ method: "GET", path, body: "" }), refused(400), path);
  }
});

test("other methods are turned away, saying which ones are allowed", () => {
  const notAllowed = { kind: "respond", status: 405, page: "unexpected", headers: { Allow: "GET, HEAD, POST" } };
  assert.deepEqual(judge({ method: "PUT" }), notAllowed);
  assert.deepEqual(judge({ method: undefined }), notAllowed);
});

test("only a posted form counts, whatever the case of its type", () => {
  assert.deepEqual(judge({ contentType: "Application/X-WWW-Form-URLEncoded; charset=UTF-8" }), CODE);
  assert.deepEqual(judge({ contentType: "text/plain" }), refused(415));
  assert.deepEqual(judge({ contentType: undefined }), refused(415));
});

test("a form too long to be Microsoft's is turned away", () => {
  assert.deepEqual(judge({ body: null }), refused(413));
  assert.equal(MAX_BODY_BYTES, 64 * 1024);
});

test("a form with a field in it twice is turned away", () => {
  assert.deepEqual(judge({ body: "state=s-1234&code=a&code=b" }), refused(400));
});

test("a form without this sign-in's state is turned away", () => {
  assert.deepEqual(judge({ body: form({ code: "c" }) }), refused(400));
  assert.deepEqual(judge({ body: form({ code: "c", state: "s-9999" }) }), refused(400));
  assert.deepEqual(judge({ body: form({ code: "c", state: "s-12345" }) }), refused(400));
});

test("Microsoft's error wins over a code", () => {
  const body = form({ error: "access_denied", error_description: "AADSTS65004: declined", code: "c", state: "s-1234" });
  assert.deepEqual(judge({ body }), { kind: "error", error: "access_denied", description: "AADSTS65004: declined" });
  assert.deepEqual(judge({ body: form({ error: "server_error", state: "s-1234" }) }), {
    kind: "error",
    error: "server_error",
    description: null,
  });
});

test("an empty error is no error, and an empty code is no code", () => {
  assert.deepEqual(judge({ body: form({ error: "", code: "one-time-code", state: "s-1234" }) }), {
    kind: "code",
    code: "one-time-code",
    clientInfo: null,
  });
  assert.deepEqual(judge({ body: form({ code: "", state: "s-1234" }) }), refused(400));
  assert.deepEqual(judge({ body: form({ state: "s-1234" }) }), refused(400));
});

test("client_info is optional", () => {
  const empty = { kind: "code", code: "c", clientInfo: null };
  assert.deepEqual(judge({ body: form({ code: "c", state: "s-1234" }) }), empty);
  assert.deepEqual(judge({ body: form({ code: "c", client_info: "", state: "s-1234" }) }), empty);
});

test("every page is sent with headers that allow it nothing from anywhere", () => {
  assert.deepEqual(LOOPBACK_HEADERS, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
});

const PAGES: Record<LoopbackPageKind, { title: string; tone: string }> = {
  "signed-in": { title: "You're signed in", tone: "good" },
  failed: { title: "Sign-in did not finish", tone: "bad" },
  waiting: { title: "Waiting for Microsoft", tone: "plain" },
  unexpected: { title: "Schema Studio was not expecting this", tone: "plain" },
};

for (const [kind, { title, tone }] of Object.entries(PAGES) as [LoopbackPageKind, { title: string; tone: string }][]) {
  test(`the "${kind}" page is a whole page with no scripts and nothing loaded from anywhere`, () => {
    const page = loopbackPage(kind);
    assert.ok(page.startsWith("<!doctype html>\n"));
    assert.ok(page.endsWith("</html>\n"));
    assert.ok(page.includes(`<title>${title} · Schema Studio</title>`));
    assert.ok(page.includes(`<main class="${tone}">`));
    assert.ok(page.includes('<meta name="color-scheme" content="light dark">'));
    assert.doesNotMatch(page, /<script/i);
    assert.doesNotMatch(page, /https?:/i);
    assert.doesNotMatch(page, /\b(?:src|href)=/i);
  });
}

test("pressing Cancel at Microsoft counts as cancelling, not as an error", () => {
  const cancelled = { reason: "cancelled", message: "The sign-in was cancelled in the browser." };
  assert.deepEqual(describeAuthError({ error: "access_denied", description: null }), cancelled);
  assert.deepEqual(
    describeAuthError({ error: "access_denied", description: "AADSTS65004: User declined to consent to access the app." }),
    cancelled,
  );
});

test("an administrator's policy saying no is an error, in Microsoft's words", () => {
  assert.deepEqual(
    describeAuthError({
      error: "access_denied",
      description: "AADSTS53003: Access has been blocked by Conditional Access policies.",
    }),
    { reason: "failed", message: "Microsoft said: Access has been blocked by Conditional Access policies. (AADSTS53003)" },
  );
});

test("set-up mistakes in Microsoft Entra are explained with what to do", () => {
  const cases: [string, RegExp][] = [
    ["50011", /add http:\/\/localhost as a redirect URI under Mobile and desktop applications/],
    ["7000218", /registered under Web in Microsoft Entra/],
    ["9002327", /registered as a single-page application/],
    ["50020", /not part of the organization this app signs in to/],
  ];
  for (const [code, expected] of cases) {
    const result = describeAuthError({ error: "invalid_request", description: `AADSTS${code}: Something went wrong.` });
    assert.equal(result.reason, "failed", code);
    assert.match(result.message, expected, code);
  }
});

test("an error with no description names the error only when it looks like a standard one", () => {
  assert.deepEqual(describeAuthError({ error: "server_error", description: null }), {
    reason: "failed",
    message: "Microsoft did not finish the sign-in (server_error). Try again in a moment.",
  });
  assert.deepEqual(describeAuthError({ error: "Weird Error!", description: null }), {
    reason: "failed",
    message: "Microsoft did not finish the sign-in. Try again in a moment.",
  });
  assert.deepEqual(describeAuthError({ error: "invalid_grant", description: "AADSTS50058:" }), {
    reason: "failed",
    message: "Microsoft did not finish the sign-in (AADSTS50058). Try again in a moment.",
  });
});

test("only the first line of Microsoft's description is shown", () => {
  assert.deepEqual(
    describeAuthError({
      error: "unauthorized_client",
      description: "AADSTS700016: Application not found.\r\nTrace ID: 0000\r\nCorrelation ID: 1111",
    }),
    { reason: "failed", message: "Microsoft said: Application not found. (AADSTS700016)" },
  );
});

test("a long description is cut short, and invisible characters become spaces", () => {
  const prefix = "Microsoft said: ";
  for (const description of ["word ".repeat(80), "x".repeat(300)]) {
    const { message } = describeAuthError({ error: "server_error", description });
    assert.ok(message.startsWith(prefix));
    assert.ok(message.length - prefix.length <= 201, String(message.length));
    assert.ok(message.endsWith("…"));
  }
  assert.equal(
    describeAuthError({ error: "server_error", description: "Bad\u0007thing\there" }).message,
    "Microsoft said: Bad thing here",
  );
});
