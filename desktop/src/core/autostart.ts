/**
 * Starting Schema Studio when someone signs in to Ubuntu.
 *
 * At sign-in, Ubuntu starts every program that has a .desktop file in
 * ~/.config/autostart, as the XDG Autostart rules that every Linux desktop
 * follows say to. So the file is the setting: it is there while start at
 * sign-in is on and gone while it is off, and nothing else has to remember
 * it. Electron's own login item setting does nothing on Linux, which is why
 * the app writes the file itself.
 *
 * The file starts the app with --background. With Keep running on, a start
 * like that shows only the app's icon in the top bar, so paired phones can
 * reach it without a window opening at every sign-in. With Keep running off,
 * the window opens as usual. TryExec names the command the .deb installs, so
 * once the app is removed Ubuntu skips the file instead of failing to start
 * it.
 *
 * The file has the same name as the app grid entry the .deb installs (the
 * desktopName in package.json, which electron-builder names that entry
 * after). Tools that start an app at sign-in by copying its app grid entry
 * into the autostart folder give the copy that name too, so the app can never
 * end up with two files starting it.
 *
 * Tested in src/test/autostart.test.ts.
 */
import fs from "node:fs";
import path from "node:path";

import { readFileIfExists, writeFileAtomic } from "./atomic-file";

/** What the file adds to the command, and what src/main/main.ts looks for. */
export const BACKGROUND_FLAG = "--background";

/**
 * An app grid entry's file name: letters, digits, dots, dashes and
 * underscores, ending in .desktop. A slash can never be part of one, so the
 * name always points inside the autostart folder.
 */
const DESKTOP_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.desktop$/;

/**
 * What the file says. Exec and TryExec name the command the .deb puts in
 * /usr/bin, and Icon the icon it installs, the same ones the app grid entry
 * names.
 */
export const AUTOSTART_ENTRY = [
  "[Desktop Entry]",
  "Type=Application",
  "Name=Schema Studio",
  "Comment=Starts Schema Studio in the background, so paired phones can reach it",
  `Exec=schema-studio ${BACKGROUND_FLAG}`,
  "TryExec=schema-studio",
  "Icon=schema-studio",
  "Terminal=false",
  "X-GNOME-Autostart-enabled=true",
  "",
].join("\n");

/** The app grid entry's file name, from the text of package.json, or null when it names none that can be used. */
export function readDesktopFileName(packageJsonText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const name = (parsed as { desktopName?: unknown }).desktopName;
  return typeof name === "string" && DESKTOP_FILE_NAME.test(name) ? name : null;
}

/**
 * Where the start-at-sign-in file goes, or null when there is no package.json
 * or it names no app grid entry. Any other failure to read it is thrown.
 */
export function autostartFileFor(packageJsonFile: string, autostartDir: string): string | null {
  const text = readFileIfExists(packageJsonFile);
  const name = text === null ? null : readDesktopFileName(text);
  return name === null ? null : path.join(autostartDir, name);
}

/** A group line in a .desktop file: a name in square brackets, with no brackets in the name. */
const GROUP_LINE = /^\[[^[\]]+\]$/;

/** What a true-or-false value in a .desktop file says, as GLib reads it, or null when it says neither. */
function readBoolean(value: string): boolean | null {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return null;
}

/**
 * Whether a start-at-sign-in file, from its text, starts the app at sign-in.
 * No file means no. GNOME reads the file with GLib, which takes nothing from
 * a file whose first group is not [Desktop Entry] or that has a line that is
 * not a group, a key or a comment, counts a key given twice with its last
 * value, and reads 1 and 0 as true and false. GNOME then starts only an entry
 * that says Type=Application, and not one that says Hidden=true or
 * X-GNOME-Autostart-enabled=false, which other tools write to turn an entry
 * off without removing it.
 *
 * Either of those two keys saying something other than true or false counts
 * as off, the safe side to be wrong on: a box that says off is put right by
 * turning it on, which writes the file afresh, while one that says on for a
 * file Ubuntu skips gives no clue that anything is wrong.
 */
export function readAutostart(text: string | null): boolean {
  if (text === null) return false;
  const entry = new Map<string, string>();
  let group: string | null = null;
  for (const raw of text.split("\n")) {
    // trim() also takes off the \r of a file saved with Windows line endings.
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      // GLib cannot read a line that starts with [ but is not a group, such
      // as [Broken, so GNOME starts nothing from the file.
      if (!GROUP_LINE.test(line)) return false;
      if (group === null && line !== "[Desktop Entry]") return false;
      group = line;
      continue;
    }
    const equals = line.indexOf("=");
    // A key before the first group, or a line that is not a key, is something
    // GLib cannot read, so GNOME starts nothing from the file.
    if (group === null || equals <= 0) return false;
    // Keys in any other group, such as an extra action, say nothing about starting the app.
    if (group !== "[Desktop Entry]") continue;
    // The rules allow spaces on either side of the =.
    entry.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim());
  }
  const hidden = entry.get("Hidden");
  const enabled = entry.get("X-GNOME-Autostart-enabled");
  if (hidden !== undefined && readBoolean(hidden) !== false) return false;
  if (enabled !== undefined && readBoolean(enabled) !== true) return false;
  return entry.get("Type") === "Application";
}

/** Whether the file at `file` starts the app at sign-in. A failure to read it, other than its not being there, is thrown. */
export function isAutostartOn(file: string): boolean {
  return readAutostart(readFileIfExists(file));
}

/**
 * Turns start at sign-in on, by writing the file afresh, or off, by removing
 * it. Writing it afresh also turns back on an entry that another tool turned
 * off, and removing it leaves nothing behind once the setting is off.
 */
export function setAutostart(file: string, on: boolean): void {
  if (on) {
    // The folder belongs to Ubuntu and other programs keep files in it, so it
    // gets an ordinary folder's mode and the app never tidies it.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Nothing in the file is secret, so it gets the mode every .desktop file
    // has rather than the owner-only one of the app's own files. The
    // temporary file written first ends in .tmp, so Ubuntu never takes a
    // half-written one for an entry.
    writeFileAtomic(file, AUTOSTART_ENTRY, 0o644);
    return;
  }
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
