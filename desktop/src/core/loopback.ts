/**
 * The pure half of signing in through the browser: what the app does with
 * each request that reaches the small web server it opens while someone signs
 * in, and the pages it sends back.
 *
 * Signing in happens in the person's own browser rather than inside the app,
 * so their saved Microsoft sign-in, password manager and security key all
 * work. The app opens Microsoft's sign-in page there. Once the person is
 * through, Microsoft sends the browser on to http://localhost:<port>, where
 * the app listens on this computer only. The browser brings a one-time code,
 * which the app trades with Microsoft for the sign-in itself
 * (src/main/auth.ts).
 *
 * Microsoft is asked to hand the code over in a form the browser posts
 * (response_mode=form_post) rather than in the address. That keeps the code
 * out of the browser's history, its synced tabs and the address bar. Browsers
 * that stop web pages fetching from this computer's own address still let a
 * page post a form to it, because posting a form moves the whole tab there.
 *
 * Anything can send a request to that port while the app listens: another
 * program, or a web page open in the browser. So nothing counts unless it is
 * a form posted to the exact address, carrying the `state` value the app made
 * up for this sign-in, which only Microsoft's answer has. Everything else gets
 * a plain page and changes nothing.
 *
 * src/main/loopback-server.ts does the networking; this file is text in,
 * answer out, and tested in src/test/loopback.test.ts.
 */
import crypto from "node:crypto";

/** The largest form the app reads. Microsoft's answer is a few kilobytes. */
export const MAX_BODY_BYTES = 64 * 1024;

export type LoopbackPageKind = "signed-in" | "failed" | "waiting" | "unexpected";

/** The parts of a request the decision depends on. */
export type LoopbackRequest = {
  method: string | undefined;
  /** The Host header, if there was one. */
  host: string | undefined;
  /** The path and query from the request line, such as "/?a=b". */
  path: string;
  contentType: string | undefined;
  /** The body as text, or null when it was longer than MAX_BODY_BYTES. */
  body: string | null;
};

/**
 * What to do with a request:
 *
 *  - "respond": send this page with this status, and keep waiting.
 *  - "code": Microsoft's answer, with the code to trade for the sign-in.
 *  - "error": Microsoft's answer, saying the sign-in did not happen.
 */
export type LoopbackVerdict =
  | { kind: "respond"; status: number; page: LoopbackPageKind; headers?: Record<string, string> }
  | { kind: "code"; code: string; clientInfo: string | null }
  | { kind: "error"; error: string; description: string | null };

/** Sent with every page. The pages need nothing from anywhere, so nothing is allowed. */
export const LOOPBACK_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

const FORM_TYPE = "application/x-www-form-urlencoded";

function unexpected(status: number, headers?: Record<string, string>): LoopbackVerdict {
  return headers
    ? { kind: "respond", status, page: "unexpected", headers }
    : { kind: "respond", status, page: "unexpected" };
}

/** Compares in constant time, so the answer's timing says nothing about how much matched. */
function sameText(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The browser always names the address it was sent to. A request naming
 * anything else comes from a web page that made its own name point at this
 * computer, which is a known trick for reaching programs listening here.
 */
function isOurHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const lower = host.toLowerCase();
  return lower === `localhost:${port}` || lower === `127.0.0.1:${port}` || lower === `[::1]:${port}`;
}

/** Splits "/path?query#part" by hand: new URL() would read "//name/path" as an address. */
function splitPath(raw: string): { pathname: string; query: string } {
  const hash = raw.indexOf("#");
  const beforeHash = hash === -1 ? raw : raw.slice(0, hash);
  const question = beforeHash.indexOf("?");
  return question === -1
    ? { pathname: beforeHash, query: "" }
    : { pathname: beforeHash.slice(0, question), query: beforeHash.slice(question + 1) };
}

/** The form's fields, or null when one of them appears twice, which Microsoft never sends. */
function readForm(text: string): Map<string, string> | null {
  const fields = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(text)) {
    if (fields.has(key)) return null;
    fields.set(key, value);
  }
  return fields;
}

export function judgeLoopbackRequest(
  request: LoopbackRequest,
  expected: { port: number; state: string },
): LoopbackVerdict {
  if (!isOurHost(request.host, expected.port)) return unexpected(400);

  const { pathname, query } = splitPath(request.path);
  if (pathname !== "/") return unexpected(404);

  if (request.method === "GET" || request.method === "HEAD") {
    // Someone opened the address themselves, or the browser reloaded it, so
    // the page says what is going on. A code in the address cannot be
    // Microsoft's, which was asked to post it.
    const params = new URLSearchParams(query);
    if (params.has("code") || params.has("error") || params.has("state")) return unexpected(400);
    return { kind: "respond", status: 200, page: "waiting" };
  }

  if (request.method !== "POST") return unexpected(405, { Allow: "GET, HEAD, POST" });

  // Only the posted form counts; anything in the address is ignored.
  const mediaType = (request.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== FORM_TYPE) return unexpected(415);
  if (request.body === null) return unexpected(413);

  const form = readForm(request.body);
  if (form === null) return unexpected(400);

  const state = form.get("state");
  if (state === undefined || !sameText(state, expected.state)) return unexpected(400);

  const error = form.get("error");
  if (error) return { kind: "error", error, description: form.get("error_description") || null };
  const code = form.get("code");
  if (code) return { kind: "code", code, clientInfo: form.get("client_info") || null };
  return unexpected(400);
}

const PAGES: Record<LoopbackPageKind, { title: string; text: string; tone: "good" | "bad" | "plain" }> = {
  "signed-in": {
    title: "You're signed in",
    text: "You can close this tab and go back to Schema Studio.",
    tone: "good",
  },
  failed: {
    title: "Sign-in did not finish",
    text: "Go back to Schema Studio to try again.",
    tone: "bad",
  },
  waiting: {
    title: "Waiting for Microsoft",
    text: "Schema Studio is waiting for you to finish signing in with Microsoft in this browser.",
    tone: "plain",
  },
  unexpected: {
    title: "Schema Studio was not expecting this",
    text: "This page does not belong to the sign-in Schema Studio is waiting for. Go back to Schema Studio to finish signing in, or to start again.",
    tone: "plain",
  },
};

/** The small mark beside each heading, drawn in the page's tone. */
const TONE_ICONS: Record<"good" | "bad" | "plain", string> = {
  good: '<circle cx="12" cy="12" r="10"/><path d="m8 12.5 2.6 2.6L16 9.6"/>',
  bad: '<circle cx="12" cy="12" r="10"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/>',
  plain: '<circle cx="12" cy="12" r="10"/><path d="M12 7v5l3 2"/>',
};

/** The app's icon: a database drawn in white on the brand's indigo. */
const APP_MARK =
  '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true">' +
  '<defs><linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#4f52e0"/></linearGradient></defs>' +
  '<rect width="32" height="32" rx="8" fill="url(#brand)"/>' +
  '<g transform="translate(4 4)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<ellipse cx="12" cy="6" rx="8" ry="3"/>' +
  '<path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/>' +
  '<path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></g></svg>';

const PAGE_STYLE = `
:root {
  --bg: #f7f7f8; --surface: #ffffff; --border: #e7e7eb;
  --text: #18181b; --text-2: #52525b;
  --good: #16a34a; --bad: #dc2626; --plain: #6366f1;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0a0a0c; --surface: #15161a; --border: #26272d;
    --text: #f3f3f5; --text-2: #b0b0ba;
    --good: #22c55e; --bad: #f87171; --plain: #7c7fff;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; padding: 16vh 16px 32px;
  display: flex; justify-content: center; align-items: flex-start;
  background: var(--bg); color: var(--text);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Ubuntu, Cantarell, "Noto Sans", sans-serif;
}
main {
  width: 100%; max-width: 30rem; padding: 28px 28px 30px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
}
.brand {
  display: flex; align-items: center; gap: 10px; margin-bottom: 24px;
  font-size: 14px; font-weight: 600; letter-spacing: 0.01em; color: var(--text-2);
}
.mark { display: block; width: 28px; height: 28px; }
h1 {
  display: flex; align-items: flex-start; gap: 10px; margin: 0 0 8px;
  font-size: 21px; line-height: 1.3; font-weight: 650; text-wrap: balance;
}
.tone {
  flex: none; width: 24px; height: 24px; margin-top: 1px;
  fill: none; stroke: var(--tone); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
}
.good { --tone: var(--good); }
.bad { --tone: var(--bad); }
.plain { --tone: var(--plain); }
p { margin: 0 0 0 34px; color: var(--text-2); }
`;

/** A whole page: no scripts, no files from anywhere, and it follows the browser's light or dark setting. */
export function loopbackPage(kind: LoopbackPageKind): string {
  const page = PAGES[kind];
  return (
    "<!doctype html>\n" +
    '<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="color-scheme" content="light dark">\n' +
    `<title>${page.title} · Schema Studio</title>\n` +
    `<style>${PAGE_STYLE}</style>\n</head>\n<body>\n` +
    `<main class="${page.tone}">\n` +
    `<div class="brand">${APP_MARK}<span>Schema Studio</span></div>\n` +
    `<h1><svg class="tone" viewBox="0 0 24 24" aria-hidden="true">${TONE_ICONS[page.tone]}</svg>` +
    `<span>${page.title}</span></h1>\n` +
    `<p>${page.text}</p>\n` +
    "</main>\n</body>\n</html>\n"
  );
}

export type AuthErrorDescription = { reason: "cancelled" | "failed"; message: string };

/**
 * Microsoft's error numbers (the "AADSTS" codes) that come from setting the
 * app up wrongly in Microsoft Entra, or from using the wrong account, with
 * what to do about each.
 */
const KNOWN_CODES = new Map<string, string>([
  [
    "50011",
    "This app's sign-in is not set up in Microsoft Entra yet: add http://localhost as a redirect URI under Mobile and desktop applications in the Schema Studio app registration.",
  ],
  [
    "7000218",
    "The http://localhost redirect URI is registered under Web in Microsoft Entra. It must be under Mobile and desktop applications instead, because the desktop app has no client secret.",
  ],
  [
    "9002327",
    "The http://localhost redirect URI is registered as a single-page application in Microsoft Entra. Move it to Mobile and desktop applications.",
  ],
  [
    "50020",
    "That Microsoft account is not part of the organization this app signs in to. Sign in with your organization account, or ask an administrator to invite this one.",
  ],
]);

/** "The person declined to give the app access", which Microsoft sends when they press Cancel. */
const DECLINED = "65004";

const MAX_MESSAGE_LENGTH = 200;

/** The first line of Microsoft's description, without its "AADSTS50058: " start or any control characters. */
function firstLine(description: string): string {
  return description
    .split(/[\r\n]/)[0]
    .replace(/^\s*AADSTS\d+:\s*/, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shorten(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  const cut = text.slice(0, MAX_MESSAGE_LENGTH);
  const space = cut.lastIndexOf(" ");
  return (space > MAX_MESSAGE_LENGTH / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "") + "…";
}

/**
 * Turns Microsoft's error (from the browser's answer, or from trading the code)
 * into words for the sign-in screen, and says whether the person simply
 * cancelled, which is not worth an error message of its own.
 */
export function describeAuthError(input: { error: string; description: string | null }): AuthErrorDescription {
  const code = input.description === null ? null : (/AADSTS(\d+)/.exec(input.description)?.[1] ?? null);

  // "access_denied" also covers an administrator's policy saying no, which
  // comes with its own number; only no number, or "declined", is a cancel.
  if (input.error === "access_denied" && (code === null || code === DECLINED)) {
    return { reason: "cancelled", message: "The sign-in was cancelled in the browser." };
  }

  const known = code === null ? undefined : KNOWN_CODES.get(code);
  if (known) return { reason: "failed", message: known };

  const said = input.description === null ? "" : firstLine(input.description);
  if (said) {
    return { reason: "failed", message: `Microsoft said: ${shorten(said)}${code ? ` (AADSTS${code})` : ""}` };
  }

  // Nothing readable came with it: name the error only when it looks like one
  // of the standard names ("server_error"), never anything stranger.
  const detail = code ? `AADSTS${code}` : /^[a-z_]{1,64}$/.test(input.error) ? input.error : null;
  return {
    reason: "failed",
    message: `Microsoft did not finish the sign-in${detail ? ` (${detail})` : ""}. Try again in a moment.`,
  };
}

/** What MSAL writes for a part of Microsoft's answer that was left out. */
const NOT_AVAILABLE = "Not Available";

/**
 * Microsoft's own description, from an error MSAL threw. For a ServerError,
 * MSAL wraps it in a longer message ("Error(s): … - Timestamp: … -
 * Description: AADSTS…: … - Correlation ID: … - Trace ID: …"); an
 * InteractionRequiredAuthError carries the description alone.
 */
export function microsoftDescription(message: string): string | null {
  const match = /Description:\s*([\s\S]*?)\s+-\s+Correlation ID:/.exec(message);
  const text = (match ? match[1] : message).trim();
  return text === "" || text === NOT_AVAILABLE ? null : text;
}
