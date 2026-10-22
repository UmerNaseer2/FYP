/**
 * What this copy of Schema Studio is: the Microsoft Entra IDs it signs in
 * with, and the commit it was built from. About and the diagnostics show it,
 * so a problem report says exactly which build it came from.
 *
 * Two files written by the build hold it:
 *  - out/build-config.json, inside app.asar, from scripts/write-build-config.mjs;
 *  - .schema-studio-build.json, beside the server, from scripts/build-server.mjs.
 * A development run may have neither, so both are optional: a missing or
 * damaged file only means sign-in is not set up, or the commit is unknown.
 */
import path from "node:path";
import { app } from "electron";

import { readFileIfExists } from "../core/atomic-file";
import { parseBuildConfig, type BuildConfig } from "../core/build-config";
import type { AppFiles } from "./app-files";
import { logWarn } from "./log";

export const BUILD_STAMP_FILE = ".schema-studio-build.json";

export type BuildInfo = BuildConfig & {
  /** The short commit the server was built from, or null when unknown. */
  commit: string | null;
  /** The build had changes that were not committed yet. */
  dirty: boolean;
  builtAt: string | null;
};

function readJson(file: string): unknown {
  try {
    const text = readFileIfExists(file);
    return text === null ? null : JSON.parse(text);
  } catch (error) {
    logWarn(`Could not read ${file}.`, error);
    return null;
  }
}

export function readBuildInfo(files: AppFiles): BuildInfo {
  const config = parseBuildConfig(readJson(files.buildConfig));
  const stamp = readJson(path.join(files.serverDir, BUILD_STAMP_FILE));
  const s = typeof stamp === "object" && stamp !== null ? (stamp as Record<string, unknown>) : {};
  const commit = typeof s.commit === "string" && /^[0-9a-f]{7,40}$/.test(s.commit) ? s.commit : null;
  const builtAt = typeof s.builtAt === "string" && !Number.isNaN(Date.parse(s.builtAt)) ? s.builtAt : null;
  return { ...config, commit, dirty: commit !== null && s.dirty === true, builtAt };
}

/** The version as About shows it: 2.0.0 (1a2b3c4), or (1a2b3c4, modified). */
export function versionLabel(info: BuildInfo): string {
  const version = app.getVersion();
  if (info.commit === null) return version;
  return info.dirty ? `${version} (${info.commit}, modified)` : `${version} (${info.commit})`;
}
