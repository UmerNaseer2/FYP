/**
 * The pure half of "Find databases on this computer" on the Connections
 * screen: recognizing a PostgreSQL server's reply, reading what Docker says
 * about its containers, and merging both into one tidy list.
 *
 * The main process (src/main/finder.ts) does the actual looking:
 *
 *  - It knocks on ports 5432 to 5439 of this computer with the first message
 *    a PostgreSQL client sends when it wants encryption (an "SSLRequest").
 *    A PostgreSQL server always answers that with exactly one byte, "S" (yes)
 *    or "N" (no), and then waits. Almost nothing else on a computer answers
 *    that way, so this is a safe way to tell PostgreSQL apart without
 *    logging in or guessing a password.
 *  - It asks Docker, when Docker is installed and this user may use it, which
 *    running containers publish PostgreSQL's port 5432 to this computer.
 *
 * Only a database's user name and database name are ever read from Docker,
 * never its password: the person still types that themselves.
 */
import type { FoundDatabase } from "../shared/ipc";

/** The ports the finder knocks on: PostgreSQL's own and the next seven. */
export const PROBE_PORTS = [5432, 5433, 5434, 5435, 5436, 5437, 5438, 5439];

/** The SSLRequest message: length 8, then the magic code 80877103. */
export const SSL_REQUEST = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);

/**
 * True when the first data that came back is a PostgreSQL server's answer to
 * the SSLRequest: one byte, "S" or "N". Anything longer is something else
 * that happened to start talking (MySQL, for one, greets every new
 * connection with a whole packet).
 */
export function isPostgresReply(firstChunk: Buffer): boolean {
  return firstChunk.length === 1 && (firstChunk[0] === 0x53 || firstChunk[0] === 0x4e);
}

/** What `docker inspect` reports about one container, cut down to what is used. */
export type DockerContainer = {
  name: string;
  image: string;
  env: Record<string, string>;
  /** Where the container's port 5432 is published on this computer. */
  published: { hostIp: string; hostPort: number }[];
};

/**
 * Reads `docker inspect`'s JSON. Containers that do not publish port 5432,
 * and anything that is not shaped as expected, are left out rather than
 * guessed at.
 */
export function parseDockerInspect(stdout: string): DockerContainer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const containers: DockerContainer[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, any>;
    const name = typeof c.Name === "string" ? c.Name.replace(/^\//, "") : "";
    const image = typeof c.Config?.Image === "string" ? c.Config.Image : "";
    const env: Record<string, string> = {};
    if (Array.isArray(c.Config?.Env)) {
      for (const entry of c.Config.Env) {
        if (typeof entry !== "string") continue;
        const eq = entry.indexOf("=");
        if (eq <= 0) continue;
        const key = entry.slice(0, eq);
        // The user and database names only: never POSTGRES_PASSWORD.
        if (key === "POSTGRES_USER" || key === "POSTGRES_DB") env[key] = entry.slice(eq + 1);
      }
    }
    const bindings = c.NetworkSettings?.Ports?.["5432/tcp"];
    const published: DockerContainer["published"] = [];
    if (Array.isArray(bindings)) {
      for (const b of bindings) {
        const hostPort = Number(b?.HostPort);
        if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) continue;
        published.push({ hostIp: typeof b?.HostIp === "string" ? b.HostIp : "", hostPort });
      }
    }
    if (name && published.length > 0) containers.push({ name, image, env, published });
  }
  return containers;
}

/**
 * True for the official postgres image and the PostGIS image built on it,
 * however it is written: "postgres", "postgres:17-alpine",
 * "docker.io/library/postgres:16", "postgis/postgis:17-3.5". Only these are
 * known to default the user to "postgres" when POSTGRES_USER is not set.
 */
export function isOfficialPostgresImage(image: string): boolean {
  const withoutTag = image.split("@")[0].replace(/:[^/:]+$/, "");
  const name = withoutTag.replace(/^(docker\.io\/|index\.docker\.io\/|registry-1\.docker\.io\/)/, "");
  return name === "postgres" || name === "library/postgres" || name === "postgis/postgis";
}

/** Docker's "every address" bindings mean this computer's own address. */
function reachableHost(hostIp: string): string {
  return hostIp === "" || hostIp === "0.0.0.0" || hostIp === "::" ? "127.0.0.1" : hostIp;
}

export function dockerFindings(containers: DockerContainer[]): FoundDatabase[] {
  const found: FoundDatabase[] = [];
  for (const c of containers) {
    const official = isOfficialPostgresImage(c.image);
    const user = c.env.POSTGRES_USER || (official ? "postgres" : null);
    // The official image names the first database after the user.
    const database = c.env.POSTGRES_DB || (official ? user : null);
    const seen = new Set<string>();
    for (const p of c.published) {
      const host = reachableHost(p.hostIp);
      const key = `${host}:${p.hostPort}`;
      // Docker lists 0.0.0.0 and :: separately for the same published port.
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        source: "docker",
        label: c.image ? `Docker: ${c.name} (${c.image})` : `Docker: ${c.name}`,
        host,
        port: p.hostPort,
        user,
        database,
        container: c.name,
      });
    }
  }
  return found;
}

export function portFinding(port: number): FoundDatabase {
  return {
    source: "port",
    label: `PostgreSQL on port ${port}`,
    host: "127.0.0.1",
    port,
    user: null,
    database: null,
  };
}

/**
 * One list, sorted by port. When Docker explains a port the knock also
 * found, the Docker entry wins, because it knows the user and database.
 */
export function mergeFindings(fromPorts: FoundDatabase[], fromDocker: FoundDatabase[]): FoundDatabase[] {
  const dockerLocalPorts = new Set(
    fromDocker.filter((d) => d.host === "127.0.0.1").map((d) => d.port),
  );
  const merged = [...fromDocker, ...fromPorts.filter((p) => !dockerLocalPorts.has(p.port))];
  return merged.sort((a, b) => a.port - b.port || a.label.localeCompare(b.label));
}
