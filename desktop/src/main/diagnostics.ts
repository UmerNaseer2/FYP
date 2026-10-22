/**
 * What Help > Copy Diagnostics puts on the clipboard, for the person to
 * paste into an email or a message when something goes wrong.
 *
 * It says which version this is, what it runs on, how far the app got and
 * where its files are, then gives the end of each log. All of it goes
 * through the same redaction as the logs: the app's keys and tokens,
 * passwords inside database addresses and email addresses are taken out,
 * and the home folder is written as "~". PostgreSQL writes the database's
 * log itself, so this is where its lines are redacted.
 *
 * It does not use Electron, so it can be tested on its own. That is why the
 * caller works out the version label.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { displayPath, type AppPaths } from "../core/paths";
import { redact } from "../core/redact";
import type { BuildInfo } from "./build-info";
import { logFilePaths, logFolder, logSecrets, tailLines } from "./log";

export type DiagnosticsInput = {
  build: BuildInfo;
  /** versionLabel(build). */
  version: string;
  /** Whether this is an installed copy, rather than one started from the source code. */
  packaged: boolean;
  paths: AppPaths;
  /** Where the app's keys are kept, or null when they were not opened. */
  secretsKeptIn: "keyring" | "file" | null;
  /** The keyring Chromium chose, in Chromium's words, or null when not known. */
  keyringBackend: string | null;
  /** How far the app got, as pairs of a label and a value. */
  status: [string, string][];
};

/** Lines from the end of each log: enough to show what led up to a problem. */
const LOG_LINES = 100;

/** The system's name for itself, such as "Ubuntu 24.04.1 LTS". */
function systemName(): string {
  if (process.platform !== "linux") return `${os.type()} ${os.release()}`;
  for (const file of ["/etc/os-release", "/usr/lib/os-release"]) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const value = /^PRETTY_NAME=(.*)$/m.exec(text)?.[1]?.trim();
    if (value !== undefined && value !== "") return value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return "Linux, version not known";
}

/** The desktop and the kind of session: GNOME on Wayland behaves differently from X11. */
function desktopSession(): string {
  const env = process.env;
  const displays = [env.WAYLAND_DISPLAY ? "WAYLAND_DISPLAY" : null, env.DISPLAY ? "DISPLAY" : null].filter(
    (name): name is string => name !== null,
  );
  const desktop = env.XDG_CURRENT_DESKTOP ?? "not known";
  const kind = env.XDG_SESSION_TYPE ?? "not known";
  return `${desktop}, ${kind} session, ${displays.length === 0 ? "no display set" : `${displays.join(" and ")} set`}`;
}

function keysPlace(input: DiagnosticsInput): string {
  const backend = input.keyringBackend ?? "not known";
  if (input.secretsKeptIn === "keyring") return `the keyring (${backend})`;
  if (input.secretsKeptIn === "file") return `a file only this account can read, as no keyring could be used (${backend})`;
  return "not opened yet";
}

export function makeDiagnostics(input: DiagnosticsInput): string {
  const home = os.homedir();
  const { build, paths } = input;
  const versions: Record<string, string | undefined> = process.versions;
  const runtime =
    versions.electron === undefined
      ? `Node.js ${versions.node ?? "not known"}`
      : `Electron ${versions.electron}, Chromium ${versions.chrome ?? "not known"}, Node.js ${versions.node ?? "not known"}`;
  const lines: string[] = [
    "Schema Studio diagnostics",
    `Made: ${new Date().toISOString()}`,
    "",
    `Version: ${input.version}`,
    `Built: ${build.builtAt ?? "not known"}`,
    `Copy: ${input.packaged ? "installed" : "started from the source code"}`,
    `Microsoft sign-in: ${build.clientId !== null && build.tenantId !== null ? "set up in this build" : "not set up in this build"}`,
    `Runs on: ${runtime}`,
    `System: ${systemName()}, kernel ${os.release()}, ${process.arch}`,
    `Desktop: ${desktopSession()}`,
    `Keys kept in: ${keysPlace(input)}`,
    "",
    "Status",
    ...input.status.map(([label, value]) => `  ${label}: ${value}`),
    "",
    "Folders",
    `  Settings: ${displayPath(paths.config, home)}`,
    `  Data: ${displayPath(paths.data, home)}`,
    `  Logs: ${displayPath(logFolder() ?? paths.logs, home)}`,
  ];

  const files = logFilePaths();
  if (files === null) {
    lines.push("", "The logs could not be kept in a folder, so there are none to add.");
  } else {
    for (const file of [files.main, files.server, files.postgres]) {
      const tail = tailLines(file, LOG_LINES);
      lines.push("", `The end of ${path.basename(file)}`, ...(tail.length === 0 ? ["  (empty, or not written yet)"] : tail));
    }
  }
  return redact(`${lines.join("\n")}\n`, { secrets: logSecrets(), home });
}
