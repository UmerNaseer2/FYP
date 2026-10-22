/**
 * Finding the databases already running on this computer, so the
 * Connections page can offer them instead of asking for every detail.
 *
 * Two places are looked at, side by side:
 *
 * - The ports PostgreSQL usually uses, 5432 to 5439, on this computer only.
 *   Each one is sent the first message of PostgreSQL's own protocol, which
 *   asks whether the database would like an encrypted connection.
 *   PostgreSQL answers with a single letter, S or N, which no other program
 *   would send back, so a port used by something else is never mistaken for
 *   a database. Nothing signs in and no password is sent.
 * - Docker, when it is installed and this account may use it. A container
 *   made from the official postgres image says which port, user and
 *   database it was started with, so more of the form can be filled in.
 *
 * What is found is only a suggestion: the person checks it and types the
 * password themselves.
 */
import { execFile, type ExecFileException } from "node:child_process";
import net from "node:net";

import {
  dockerFindings,
  isPostgresReply,
  mergeFindings,
  parseDockerInspect,
  portFinding,
  PROBE_PORTS,
  SSL_REQUEST,
} from "../core/finder";
import type { FoundDatabase } from "../shared/ipc";
import { logInfo } from "./log";

/** How long a port has to answer. A database on this computer answers at once, so this only matters for a stuck program. */
const PROBE_TIMEOUT_MS = 800;
/** How long Docker has to answer. It can be slow just after its service starts. */
const DOCKER_TIMEOUT_MS = 4_000;
const DOCKER_MAX_BUFFER = 1024 * 1024;
/** More containers than anyone runs on a laptop. The limit keeps a very long list from slowing the search. */
const MAX_CONTAINERS = 50;
/** What `docker ps --no-trunc --quiet` prints for each container. */
const CONTAINER_ID = /^[0-9a-f]{64}$/;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

/** Whether PostgreSQL answers on this port of this computer. */
function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (answered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answered);
    };
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
    socket.once("connect", () => socket.write(SSL_REQUEST));
    socket.once("data", (chunk: Buffer) => done(isPostgresReply(chunk)));
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
  });
}

/** Why Docker could not be asked, in words for the log. */
function dockerProblem(error: ExecFileException, stderr: string): string {
  const code = errorCode(error);
  if (code === "ENOENT") return "it is not installed";
  // Checked before the next line: a reply that is too long also stops Docker.
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "its answer was too long";
  if (error.killed === true || Boolean(error.signal)) return "it did not answer in time";
  // Such as "Cannot connect to the Docker daemon" or "permission denied".
  const said = stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  return said === undefined ? error.message : `it said: ${said}`;
}

/**
 * Runs the docker command and gives back what it printed. With `partial`,
 * what it printed is kept even when it then failed: `docker inspect` still
 * describes the other containers when one of them stopped in the moment
 * since `docker ps`, but exits with an error.
 */
function docker(args: string[], partial = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      args,
      { timeout: DOCKER_TIMEOUT_MS, maxBuffer: DOCKER_MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else if (partial && typeof error.code === "number" && stdout.trimStart().startsWith("[")) resolve(stdout);
        else reject(new Error(dockerProblem(error, stderr)));
      },
    );
  });
}

/** The databases Docker is running. None when Docker is not installed, not running, or not open to this account. */
async function fromDocker(): Promise<FoundDatabase[]> {
  try {
    const ids = (await docker(["ps", "--no-trunc", "--quiet"]))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => CONTAINER_ID.test(line))
      .slice(0, MAX_CONTAINERS);
    if (ids.length === 0) return [];
    return dockerFindings(parseDockerInspect(await docker(["inspect", "--type", "container", ...ids], true)));
  } catch (error) {
    logInfo(`Docker was not checked for databases (${error instanceof Error ? error.message : String(error)}).`);
    return [];
  }
}

async function search(): Promise<FoundDatabase[]> {
  const [answered, inDocker] = await Promise.all([
    Promise.all(PROBE_PORTS.map(async (port) => ((await probe(port)) ? port : null))),
    fromDocker(),
  ]);
  const onPorts = answered.filter((port): port is number => port !== null).map((port) => portFinding(port));
  const found = mergeFindings(onPorts, inDocker);
  logInfo(`Found ${found.length} database(s) on this computer.`);
  return found;
}

/** A search already under way. Asking again while it runs shares it rather than starting another. */
let running: Promise<FoundDatabase[]> | null = null;

/** The databases on this computer, from its ports and from Docker, with the same database found twice listed once. */
export function findLocalDatabases(): Promise<FoundDatabase[]> {
  return (running ??= search().finally(() => {
    running = null;
  }));
}
