/**
 * Chooses the port for Schema Studio's server.
 *
 * The server listens on 127.0.0.1 only, so the port is never open to the
 * network, but it still has to be one that no other program is using. The
 * same port is kept from one start to the next while it stays free, because
 * the web app keeps a few things in the window's storage (the theme, which
 * panels were open), and that storage belongs to an address, port included:
 * a new port every time would forget them. config.json remembers the port.
 *
 * A new port is picked at random between 20000 and 29999: above the ports
 * that well-known services use, and below 32768, where Linux starts handing
 * out ports for outgoing connections, so a port that is free now is unlikely
 * to be taken a moment later.
 */
import crypto from "node:crypto";
import net from "node:net";

import { isUsablePort } from "../core/config";
import { StartupError } from "./startup-error";

const FIRST_PORT = 20000;
const LAST_PORT = 29999;
const TRIES = 50;

/** True when nothing is listening on 127.0.0.1 at `port`. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * The port to start the server on: the saved one while it is still free,
 * otherwise a new one. `avoid` is a port the server just failed on, so a
 * second try never lands on it again.
 */
export async function choosePort(saved: number | null, avoid: number | null = null): Promise<number> {
  if (saved !== null && saved !== avoid && isUsablePort(saved) && (await isPortFree(saved))) return saved;
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const port = crypto.randomInt(FIRST_PORT, LAST_PORT + 1);
    if (port !== avoid && (await isPortFree(port))) return port;
  }
  throw new StartupError(
    "Schema Studio could not start",
    "Schema Studio could not find a free port on this computer to run on. Close some programs, then press Try again.",
  );
}
