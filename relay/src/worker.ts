/**
 * The relay's front door. It checks each request's address and passes
 * WebSocket connections on to the room of the computer they name (room.ts).
 * The phone app will be served from here too, later.
 */
import { readRelayPath } from "./shared/remote/relay-protocol.js";

// Cloudflare finds the Durable Object's class among the Worker's exports.
export { Room } from "./room.js";

/** What wrangler.jsonc gives the Worker. */
export interface Env {
  ROOMS: DurableObjectNamespace;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
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
