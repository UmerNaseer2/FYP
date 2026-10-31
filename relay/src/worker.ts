/**
 * The relay's front door. It checks each request's address and passes
 * WebSocket connections on to the room of the computer they name (room.ts),
 * and plain requests about a short pairing code's locked box on to that box
 * (code-box.ts).
 *
 * The phone app's files, in public/, never reach this code: Cloudflare
 * serves a request for one of them itself ("assets" in wrangler.jsonc), so
 * the Worker sees only the rest.
 */
import type { CodeBox, CodeTries } from "./code-box.js";
import { concatBytes, type Bytes } from "./shared/remote/bytes.js";
import { readCodePath, readRelayPath } from "./shared/remote/relay-protocol.js";
import { MAX_CODE_BOX_BYTES } from "./shared/remote/short-code.js";

// Cloudflare finds the Durable Objects' classes among the Worker's exports.
export { CodeBox, CodeTries } from "./code-box.js";
export { Room } from "./room.js";

/** What wrangler.jsonc gives the Worker. */
export interface Env {
  ROOMS: DurableObjectNamespace;
  CODE_BOXES: DurableObjectNamespace<CodeBox>;
  CODE_TRIES: DurableObjectNamespace<CodeTries>;
}

/**
 * The body of a request, or null when it is empty or bigger than a box. It is
 * read only up to that limit, so that nobody can make the Worker read a huge
 * one, whatever length it declares. A declared length cannot be asked for,
 * because a program may send a body in pieces with none.
 */
async function readBox(request: Request): Promise<Bytes | null> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_CODE_BOX_BYTES) return null;
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const parts: Bytes[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_CODE_BOX_BYTES) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return size === 0 ? null : concatBytes(...parts);
}

/**
 * The door for a short code's box. PUT leaves a box and POST takes it away,
 * and neither needs anyone to sign in: anyone can make a key and sign in to a
 * room, so a signature here would prove nothing. What guards the door is how
 * few tries an address gets, how little a box lasts, and that a box means
 * nothing without its code (short-code.ts).
 */
async function codeDoor(request: Request, env: Env, url: URL, label: string): Promise<Response> {
  // The same rule as for a room: a browser may come only from the phone app, which the relay itself serves.
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== url.origin) {
    return new Response("Requests from other web sites are not allowed.", { status: 403 });
  }
  if (request.method !== "PUT" && request.method !== "POST") {
    return new Response("This address takes PUT and POST only.", { status: 405, headers: { Allow: "PUT, POST" } });
  }
  // Cloudflare sets this itself on every request, so a visitor cannot choose it.
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.CODE_TRIES.getByName(address).allow())) {
    return new Response("Too many tries. Wait a minute and try again.", { status: 429 });
  }
  const boxes = env.CODE_BOXES.getByName(label);
  if (request.method === "POST") {
    const box = await boxes.take();
    if (box === null) return new Response("There is no box under that label.", { status: 404 });
    return new Response(box, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
  }
  const box = await readBox(request);
  if (box === null) return new Response("That is not the size of a box.", { status: 413 });
  return (await boxes.store(box)) === "stored"
    ? new Response(null, { status: 201 })
    : new Response("That label holds a box already.", { status: 409 });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const label = readCodePath(url.pathname);
    if (label !== null) return codeDoor(request, env, url, label);
    const address = readRelayPath(url.pathname);
    if (address === null) return new Response("There is nothing at this address.", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      // The standard asks for an Upgrade header on this answer too, but the
      // Workers runtime drops that header from a Worker's answers.
      return new Response("This address takes WebSocket connections only.", { status: 426 });
    }
    // A browser says which web site opened a connection. Only the phone app,
    // served from the relay itself, may connect from a browser, so other web
    // sites cannot use the relay through their visitors. The desktop app is
    // not a browser and says nothing, and any program could say anything it
    // likes, so this is not what keeps a room safe: signing in and the
    // link's encryption are.
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin) {
      return new Response("Connections from other web sites are not allowed.", { status: 403 });
    }
    return env.ROOMS.getByName(address.desktopId).fetch(request);
  },
} satisfies ExportedHandler<Env>;
