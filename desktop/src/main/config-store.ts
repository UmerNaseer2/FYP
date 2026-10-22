/**
 * Keeps config.json: the server's port, the window's size and place, the
 * theme, and which GitHub repository holds the schema registry.
 *
 * Reading never stops the app: a missing file gives the defaults, and a
 * damaged one keeps what it can (see src/core/config.ts) and says so in the
 * log. Saving is atomic, so a crash or a power cut in the middle of a save
 * leaves the old file, never half of a new one, and the copy in memory only
 * changes once the file has.
 */
import path from "node:path";

import { readFileIfExists, removeStaleTempFiles, writeFileAtomic } from "../core/atomic-file";
import { parseConfig, serializeConfig, type AppConfig } from "../core/config";
import { logError, logWarn } from "./log";

export class ConfigStore {
  private readonly file: string | null;
  private config: AppConfig;

  /**
   * file is null when the settings folder cannot be used. The settings then
   * live in memory only, which is enough to show the start screen's error.
   */
  constructor(file: string | null) {
    this.file = file;
    let text: string | null = null;
    if (file !== null) {
      // Left behind by a save that was cut off; the real file is untouched.
      removeStaleTempFiles(path.dirname(file));
      try {
        text = readFileIfExists(file);
      } catch (error) {
        logWarn(`Could not read ${file}, so the default settings are used.`, error);
      }
    }
    const { config, damaged } = parseConfig(text);
    if (damaged) logWarn(`Part of ${file} could not be read, so those settings went back to their defaults.`);
    this.config = config;
  }

  /** The current settings. Change them with save, never in place. */
  get(): AppConfig {
    return this.config;
  }

  /** Saves new settings, and says whether that worked. A failure is logged. */
  save(next: AppConfig): boolean {
    if (this.file !== null) {
      try {
        writeFileAtomic(this.file, serializeConfig(next));
      } catch (error) {
        logError(`Could not save ${this.file}.`, error);
        return false;
      }
    }
    this.config = next;
    return true;
  }
}
