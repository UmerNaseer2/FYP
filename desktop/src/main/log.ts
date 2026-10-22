/**
 * The app's log files, kept in ~/.local/state/schema-studio/logs:
 *
 *  - main.log: what the app did while starting, signing in and quitting, and
 *    anything that went wrong;
 *  - server.log: everything Schema Studio's server printed;
 *  - postgres.log: everything the database printed. PostgreSQL writes this
 *    one itself, through the file openPostgresLogFd opens for it.
 *
 * Help > Open Logs opens the folder, and Help > Copy Diagnostics copies the
 * last lines of all three. Every line the app writes goes through redact
 * first, with the app's secrets and the home folder, so a log can be shared
 * without giving away a key or the person's login name. PostgreSQL never sees
 * a secret, so postgres.log is redacted when the diagnostics read it instead.
 *
 * A log must never be the reason the app fails, so every write is wrapped: a
 * full disk loses log lines, not the app. Each file is moved to <name>.1 when
 * it reaches 5 MB, so the folder never holds much more than 30 MB.
 *
 * Lines logged before initLog (the first moments of startup) are kept in
 * memory and written when it runs. With echo on (a development run, or the
 * self-test) every line is also printed to stderr. stdout is left alone, so
 * the self-test can print its JSON result there and nothing else.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import util from "node:util";

import { ensurePrivateDir } from "../core/private-dir";
import { redact } from "../core/redact";

/** A log file is moved to <name>.1 when it reaches this size. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** Lines kept from before initLog. Startup logs a handful; this is only a cap. */
const MAX_EARLY_LINES = 200;
/** redact ignores secrets shorter than this, so remembering them would do nothing. */
const MIN_SECRET_LENGTH = 8;
/** A server line longer than this is written in pieces rather than held forever. */
const MAX_PARTIAL_LINE = 64 * 1024;
/** tailLines reads at most this much from the end of a file. */
const TAIL_BYTES = 256 * 1024;

type LogName = "main" | "server";

const home = os.homedir();
const secrets: string[] = [];
const sizes = new Map<string, number>();
/** Lines waiting for initLog; null once it has run. */
let early: { name: LogName; line: string }[] | null = [];
let folder: string | null = null;
let echo = false;

/**
 * An error as text for the log: its stack, then what caused it, up to three
 * levels down, because the useful part of a failure is often in the cause
 * (a startup step wraps the system error that stopped it).
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth <= 3 && current !== undefined && current !== null; depth++) {
    parts.push(depth === 0 ? describeOne(current) : `Caused by: ${describeOne(current)}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join("\n");
}

function describeOne(value: unknown): string {
  if (!(value instanceof Error)) {
    return typeof value === "string" ? value : util.inspect(value, { depth: 2, breakLength: Infinity });
  }
  const text = value.stack ?? `${value.name}: ${value.message}`;
  // System errors say ENOENT and the like in their message; others, such as a
  // database error's 42P01, only in their code.
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && !text.includes(code) ? `${text}\n(code ${code})` : text;
}

function entry(label: string, message: string): string {
  // Continuation lines (a stack trace, say) are indented, so every entry
  // starts with its time and is easy to tell apart from the next one.
  return `[${new Date().toISOString()}] ${label} ${message.replace(/\r?\n/g, "\n    ")}\n`;
}

function logFile(name: LogName | "postgres"): string | null {
  return folder === null ? null : path.join(folder, `${name}.log`);
}

function currentSize(file: string): number {
  let size = sizes.get(file);
  if (size === undefined) {
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    sizes.set(file, size);
  }
  return size;
}

function moveAside(file: string): void {
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Nothing there yet, or it cannot be moved: carry on writing either way.
  }
}

function write(name: LogName, text: string): void {
  const safe = redact(text, { secrets, home });
  if (echo || folder === null) {
    try {
      process.stderr.write(safe);
    } catch {
      // No terminal to print to.
    }
  }
  const file = logFile(name);
  if (file === null) return;
  const bytes = Buffer.byteLength(safe);
  try {
    if (currentSize(file) + bytes > MAX_LOG_BYTES) {
      moveAside(file);
      sizes.set(file, 0);
    }
    fs.appendFileSync(file, safe, { mode: 0o600 });
    sizes.set(file, currentSize(file) + bytes);
  } catch {
    // A full disk or a removed folder loses log lines, never the app.
  }
}

function record(name: LogName, label: string, message: string): void {
  const line = entry(label, message);
  if (early !== null) {
    if (early.length < MAX_EARLY_LINES) early.push({ name, line });
    return;
  }
  write(name, line);
}

/**
 * Starts writing to the log folder, and writes the lines logged so far. If
 * the folder cannot be used, the logs go to stderr only: the app still runs.
 */
export function initLog(dir: string, options: { echo: boolean }): void {
  if (early === null) return;
  echo = options.echo;
  // A terminal closed under a running app makes writes to stderr fail. That
  // must not become an uncaught error.
  process.stderr.on("error", () => {});
  try {
    ensurePrivateDir(dir);
    folder = dir;
  } catch (error) {
    folder = null;
    try {
      process.stderr.write(`Schema Studio cannot keep its logs in ${dir}, so they go here only.\n${describeError(error)}\n`);
    } catch {
      // No terminal either.
    }
  }
  const pending = early;
  early = null;
  for (const { name, line } of pending) write(name, line);
}

export function logInfo(message: string): void {
  record("main", "info", message);
}

export function logWarn(message: string, error?: unknown): void {
  record("main", "warn", error === undefined ? message : `${message}\n${describeError(error)}`);
}

export function logError(message: string, error?: unknown): void {
  record("main", "error", error === undefined ? message : `${message}\n${describeError(error)}`);
}

/** Adds a value that must never appear in a log or in the diagnostics. */
export function addLogSecret(value: string | null | undefined): void {
  if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH && !secrets.includes(value)) {
    secrets.push(value);
  }
}

/** Every secret added so far, for redacting the diagnostics. */
export function logSecrets(): string[] {
  return [...secrets];
}

export type LineWriter = {
  write(chunk: Buffer | string): void;
  /** Writes a last line that never got its line break, when the stream ends. */
  flush(): void;
};

/**
 * Turns what the server prints on one of its streams into server.log lines,
 * each with the time it arrived. Output arrives in chunks that can end in the
 * middle of a line, or of a character, so both are held back until complete.
 */
export function serverLogWriter(stream: "stdout" | "stderr"): LineWriter {
  const decoder = new StringDecoder("utf8");
  const label = stream === "stderr" ? "err" : "out";
  let partial = "";
  return {
    write(chunk) {
      partial += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let end = partial.indexOf("\n");
      while (end !== -1) {
        record("server", label, partial.slice(0, end).replace(/\r$/, ""));
        partial = partial.slice(end + 1);
        end = partial.indexOf("\n");
      }
      if (partial.length > MAX_PARTIAL_LINE) {
        record("server", label, partial);
        partial = "";
      }
    },
    flush() {
      partial += decoder.end();
      if (partial !== "") record("server", label, partial);
      partial = "";
    },
  };
}

/**
 * Opens postgres.log for PostgreSQL to write to directly, after moving an
 * old one aside if it has grown past 5 MB. Gives null when there is no log
 * folder, and PostgreSQL's output is then dropped.
 */
export function openPostgresLogFd(): number | null {
  const file = logFile("postgres");
  if (file === null) return null;
  try {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // No log yet.
    }
    if (size > MAX_LOG_BYTES) moveAside(file);
    return fs.openSync(file, "a", 0o600);
  } catch {
    return null;
  }
}

/**
 * The last lines of a log file, read from at most its last 256 KB. The first
 * line read is usually cut in half by that limit, so it is dropped. A missing
 * or unreadable file gives no lines.
 */
export function tailLines(file: string, count: number): string[] {
  if (count <= 0) return [];
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, read).toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-count);
  } catch {
    return [];
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed.
    }
  }
}

/** The folder the logs are written to, or null when they go to stderr only. */
export function logFolder(): string | null {
  return folder;
}

export function logFilePaths(): { main: string; server: string; postgres: string } | null {
  if (folder === null) return null;
  return {
    main: path.join(folder, "main.log"),
    server: path.join(folder, "server.log"),
    postgres: path.join(folder, "postgres.log"),
  };
}
