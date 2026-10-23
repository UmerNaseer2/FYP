/**
 * A computer's room at the relay, as Cloudflare runs it: a Durable Object.
 * There is exactly one for each name, so all the connections to one
 * computer's room meet in one place, whichever of Cloudflare's machines they
 * came in through. The Worker (worker.ts) names each room after its
 * computer's ID, and the rules of a room are in room-logic.ts.
 *
 * Connections are accepted with Cloudflare's hibernation API: when a room
 * has nothing to do, Cloudflare takes it out of memory but keeps its
 * connections open, and a sleeping room costs nothing. When a message comes,
 * the room is built again from what was written to each connection. Pings
 * are answered by the platform itself, without waking the room at all.
 */
import { DurableObject } from "cloudflare:workers";

import { RoomLogic, type SocketState } from "./room-logic.js";
import { PING, PONG, readRelayPath } from "./shared/remote/relay-protocol.js";

export class Room extends DurableObject {
  private readonly logic: RoomLogic;

  // The room needs none of the Worker's settings, only its own connections.
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const sockets: [WebSocket, SocketState][] = [];
    for (const socket of ctx.getWebSockets()) {
      // Nothing is written to a connection the room has sent away or seen
      // close, and Cloudflare may still hand one back for a moment.
      const state: SocketState | null = socket.deserializeAttachment();
      if (state !== null) sockets.push([socket, state]);
    }
    this.logic = new RoomLogic(sockets);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request: Request): Promise<Response> {
    // The Worker has checked all this already. Checking again means the room
    // never takes a connection it would not know where to put.
    const address = readRelayPath(new URL(request.url).pathname);
    if (address === null || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response(null, { status: 400 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    if (address.role === "phone") {
      this.logic.addPhone(server);
    } else {
      this.logic.addDesktop(server, address.desktopId, Date.now());
      await this.setAlarm();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.logic.receive(socket, typeof message === "string" ? message : new Uint8Array(message), Date.now());
  }

  // From the compatibility date in wrangler.jsonc on, Cloudflare answers the
  // other end's close itself, so the room only has to forget the connection.
  async webSocketClose(socket: WebSocket): Promise<void> {
    this.logic.closed(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.logic.closed(socket);
  }

  /** Runs when a connection's time to sign in may have run out. */
  async alarm(): Promise<void> {
    this.logic.expire(Date.now());
    await this.setAlarm();
  }

  /** Wakes the room when the next connection's time to sign in runs out. */
  private async setAlarm(): Promise<void> {
    const next = this.logic.nextDeadline();
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
