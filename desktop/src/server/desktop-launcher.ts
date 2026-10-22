/**
 * The first code the app's own server runs.
 *
 * The app starts the web app's Next.js server as an Electron "utility
 * process": a separate Node.js program that belongs to the app and ends with
 * it (src/main/server.ts). This file is where that program starts. It waits
 * for the app to send the secrets, puts the gate in front of the server
 * (desktop-gate.ts), starts Next.js, and tells the app once it is listening.
 *
 * The secrets come by message rather than in the environment the process
 * starts with, because the system keeps a copy of that starting environment
 * for every process, and ordinary tools (`ps e`) print it. The web app reads
 * them from process.env, so they are put there once they arrive.
 *
 * In the package, this file sits beside Next.js's server.js in
 * resources/server. While developing, it runs from out/server and Next.js
 * from build/server. Either way, the app says where server.js is.
 */
import http from "node:http";
import path from "node:path";

import { installGate } from "./desktop-gate";

/** Sent by the app once, right after it starts this process. */
export type LauncherStart = {
  type: "start";
  /** The folder that holds Next.js's server.js. */
  serverDir: string;
  gateToken: string;
  nextauthSecret: string;
  appEncryptionKey: string;
  githubToken: string | null;
};

/** Sent by the app whenever the GitHub settings change, so they apply without a restart. */
export type LauncherGithub = {
  type: "github";
  owner: string;
  repo: string;
  token: string | null;
};

export type ToLauncher = LauncherStart | LauncherGithub;

export type FromLauncher = { type: "listening" } | { type: "fatal"; message: string };

// Electron gives a utility process `process.parentPort` for talking to the
// app. Node.js's own types do not know about it.
type ParentPort = {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

let started = false;
let listening = false;
let failed = false;

function post(message: FromLauncher): void {
  parentPort?.postMessage(message);
}

/** Tells the app the server could not start, then stops. The full error goes to the server's log. */
function fail(error: unknown): void {
  if (failed) return;
  failed = true;
  console.error(error);
  post({ type: "fatal", message: error instanceof Error ? error.message : String(error) });
  // A moment for the message to reach the app before the process ends.
  setTimeout(() => process.exit(1), 200);
}

process.on("uncaughtException", (error) => {
  if (!listening) {
    fail(error);
    return;
  }
  // Once the server is listening, Next.js has its own handler, which logs the
  // error and carries on serving. This one only speaks when it is alone.
  if (process.listenerCount("uncaughtException") === 1) console.error(error);
});

function setOrRemove(name: string, value: string | null): void {
  if (value) process.env[name] = value;
  else delete process.env[name];
}

function start(message: LauncherStart): void {
  if (started) return;
  started = true;

  process.env.NEXTAUTH_SECRET = message.nextauthSecret;
  process.env.APP_ENCRYPTION_KEY = message.appEncryptionKey;
  setOrRemove("GITHUB_PAT", message.githubToken);

  installGate(http, {
    token: message.gateToken,
    port: Number(process.env.PORT),
    onListening: () => {
      listening = true;
      post({ type: "listening" });
    },
  });

  try {
    // Next.js's own starting file. It reads PORT and HOSTNAME from the
    // environment the app gave this process, and starts listening.
    require(path.join(message.serverDir, "server.js"));
  } catch (error) {
    fail(error);
  }
}

// The web app reads these each time it talks to GitHub, so a change applies
// to the next request.
function applyGithub(message: LauncherGithub): void {
  setOrRemove("GITHUB_REPO_OWNER", message.owner);
  setOrRemove("GITHUB_REPO_NAME", message.repo);
  setOrRemove("GITHUB_PAT", message.token);
}

if (parentPort) {
  parentPort.on("message", (event) => {
    const message = event.data as ToLauncher | null;
    if (message?.type === "start") start(message);
    else if (message?.type === "github") applyGithub(message);
  });
} else {
  console.error("This file is started by the Schema Studio app and cannot run on its own.");
  process.exit(1);
}
