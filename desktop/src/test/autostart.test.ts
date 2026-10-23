/**
 * Starting the app when someone signs in (src/core/autostart.ts), tried on
 * real files in a fresh temporary folder, never the real ~/.config/autostart.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTOSTART_ENTRY,
  autostartFileFor,
  BACKGROUND_FLAG,
  isAutostartOn,
  readAutostart,
  readDesktopFileName,
  setAutostart,
} from "../core/autostart";

/** A new empty folder for one test, removed when the test ends. */
function tempDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-studio-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function packageJson(desktopName: unknown): string {
  return JSON.stringify({ name: "schema-studio", desktopName });
}

/** The entry with GNOME's own switch turned off, the way other tools turn an entry off without removing it. */
const TURNED_OFF = AUTOSTART_ENTRY.replace("X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-enabled=false");

test("reads the app grid entry's name from package.json", () => {
  assert.equal(readDesktopFileName(packageJson("org.example.App.desktop")), "org.example.App.desktop");
  assert.equal(readDesktopFileName(packageJson("schema_studio-2.desktop")), "schema_studio-2.desktop");
  assert.equal(readDesktopFileName(packageJson("x.desktop")), "x.desktop");
});

test("the app's own package.json names an entry the autostart folder can hold", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8");
  const name = readDesktopFileName(text);
  assert.ok(name !== null, "package.json has no usable desktopName");
  assert.equal(path.basename(name), name);
});

test("refuses a name that is missing, not text, or not a .desktop file name", () => {
  for (const text of [
    "{}",
    "null",
    "[]",
    "42",
    "not JSON",
    packageJson(42),
    packageJson(["app.desktop"]),
    packageJson(""),
    packageJson("schema-studio"),
    packageJson(".desktop"),
    packageJson(".hidden.desktop"),
    packageJson("app.desktop.tmp"),
    packageJson("app.desktop\n"),
    packageJson("app .desktop"),
  ]) {
    assert.equal(readDesktopFileName(text), null, text);
  }
});

test("refuses a name that would put the file outside the autostart folder", () => {
  for (const name of ["../app.desktop", "a/b.desktop", "/etc/xdg/autostart/app.desktop", "..\\app.desktop"]) {
    assert.equal(readDesktopFileName(packageJson(name)), null, name);
  }
});

test("finds where the file goes, and nowhere when package.json is missing or names no entry", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "package.json");
  assert.equal(autostartFileFor(file, "/home/sam/.config/autostart"), null);
  fs.writeFileSync(file, packageJson("org.example.App.desktop"));
  assert.equal(autostartFileFor(file, "/home/sam/.config/autostart"), "/home/sam/.config/autostart/org.example.App.desktop");
  fs.writeFileSync(file, "{}");
  assert.equal(autostartFileFor(file, "/home/sam/.config/autostart"), null);
});

test("does not hide a package.json that cannot be read", (t) => {
  // A folder where the file should be cannot be read as one, and that is not the same as no file.
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "package.json"));
  assert.throws(() => autostartFileFor(path.join(dir, "package.json"), "/home/sam/.config/autostart"));
});

test("the entry starts the installed command in the background, and only while it is installed", () => {
  const lines = AUTOSTART_ENTRY.split("\n");
  assert.equal(lines[0], "[Desktop Entry]");
  assert.equal(BACKGROUND_FLAG, "--background");
  assert.ok(lines.includes("Type=Application"));
  assert.ok(lines.includes("Name=Schema Studio"));
  assert.ok(lines.includes("Exec=schema-studio --background"));
  assert.ok(lines.includes("TryExec=schema-studio"));
  assert.ok(lines.includes("Icon=schema-studio"));
  assert.ok(lines.includes("X-GNOME-Autostart-enabled=true"));
  assert.ok(AUTOSTART_ENTRY.endsWith("\n"));
  assert.equal(readAutostart(AUTOSTART_ENTRY), true);
});

test("reads no file, or an empty one, as off", () => {
  assert.equal(readAutostart(null), false);
  assert.equal(readAutostart(""), false);
  assert.equal(readAutostart("\n# Only a comment\n"), false);
});

test("reads an entry turned off with Hidden or with GNOME's own switch as off", () => {
  assert.equal(readAutostart(`${AUTOSTART_ENTRY}Hidden=true\n`), false);
  assert.equal(readAutostart(TURNED_OFF), false);
  assert.equal(readAutostart(`${AUTOSTART_ENTRY}Hidden=false\n`), true);
  assert.equal(readAutostart("[Desktop Entry]\nType=Application\n"), true);
});

test("reads an entry that is not an application as off, because GNOME starts only applications", () => {
  assert.equal(readAutostart("[Desktop Entry]\n"), false);
  assert.equal(readAutostart("[Desktop Entry]\nExec=schema-studio\n"), false);
  assert.equal(readAutostart("[Desktop Entry]\nType=Link\nURL=https://example.com\n"), false);
});

test("reads 1 and 0 as true and false, and anything else in either switch as off", () => {
  assert.equal(readAutostart(`${AUTOSTART_ENTRY}Hidden=1\n`), false);
  assert.equal(readAutostart(`${AUTOSTART_ENTRY}Hidden=0\n`), true);
  assert.equal(readAutostart(AUTOSTART_ENTRY.replace("enabled=true", "enabled=1")), true);
  assert.equal(readAutostart(TURNED_OFF.replace("enabled=false", "enabled=0")), false);
  for (const value of ["yes", "no", "True", "FALSE", ""]) {
    assert.equal(readAutostart(`${AUTOSTART_ENTRY}Hidden=${value}\n`), false, `Hidden=${value}`);
    assert.equal(readAutostart(AUTOSTART_ENTRY.replace("enabled=true", `enabled=${value}`)), false, `enabled=${value}`);
  }
});

test("a key given twice counts with its last value, as GLib reads it", () => {
  assert.equal(readAutostart(`${AUTOSTART_ENTRY}Hidden=true\nHidden=false\n`), true);
  assert.equal(readAutostart(`${TURNED_OFF}X-GNOME-Autostart-enabled=true\n`), true);
  assert.equal(readAutostart(`${AUTOSTART_ENTRY}Type=Link\n`), false);
  // The key ends at the first =, so a later one is part of the value.
  assert.equal(readAutostart(`${AUTOSTART_ENTRY}Type=Application=x\n`), false);
  // A group given a second time adds to the first.
  assert.equal(readAutostart(`${AUTOSTART_ENTRY}[Desktop Action quit]\nName=Quit\n[Desktop Entry]\nHidden=true\n`), false);
  assert.equal(readAutostart(`${AUTOSTART_ENTRY}[Desktop Action quit]\nName=Quit\n[Desktop Entry]\nHidden=false\n`), true);
});

test("allows spaces before a line, after a group and around the =, and Windows line endings, as GLib does", () => {
  assert.equal(readAutostart("  [Desktop Entry]\n\tType=Application\n"), true);
  assert.equal(readAutostart("[Desktop Entry] \t\nType=Application\n"), true);
  assert.equal(readAutostart("[Desktop Entry]\nType=Application\n  Hidden=true\n"), false);
  assert.equal(readAutostart("[Desktop Entry]\nType = Application\n"), true);
  assert.equal(readAutostart("[Desktop Entry]\nType=Application\nHidden = true\n"), false);
  assert.equal(readAutostart("[Desktop Entry]\nType=Application\nX-GNOME-Autostart-enabled =false\n"), false);
  assert.equal(readAutostart("[Desktop Entry]\r\nType=Application\r\nHidden=true\r\n"), false);
  assert.equal(readAutostart("[Desktop Entry]\r\nType=Application\r\n"), true);
});

test("only the [Desktop Entry] group counts, and comments say nothing", () => {
  assert.equal(readAutostart("[Something Else]\nType=Application\n"), false);
  assert.equal(readAutostart(`${AUTOSTART_ENTRY}\n[Desktop Action quit]\nHidden=true\n`), true);
  assert.equal(readAutostart("# A comment\n[Desktop Entry]\n# Hidden=true\n#X-GNOME-Autostart-enabled=false\nType=Application\n"), true);
});

test("reads a file GLib cannot read as off, because GNOME starts nothing from it", () => {
  // A key before the first group.
  assert.equal(readAutostart("Type=Application\nExec=schema-studio\n"), false);
  assert.equal(readAutostart(`Type=Application\n${AUTOSTART_ENTRY}`), false);
  // A first group that is not [Desktop Entry], even with one after it.
  assert.equal(readAutostart(`[Something Else]\nName=Other\n${AUTOSTART_ENTRY}`), false);
  // A line that is not a group, a key or a comment, in any group.
  assert.equal(readAutostart(`${AUTOSTART_ENTRY}NoEquals\n`), false);
  assert.equal(readAutostart(`${AUTOSTART_ENTRY}=Application\n`), false);
  assert.equal(readAutostart(`${AUTOSTART_ENTRY}[Desktop Action quit]\nNoEquals\n`), false);
  // A line that starts with [ but is not a group.
  for (const line of ["[Broken", "[Broken=x", "[]", "[Desktop Action [quit]", "[Desktop Action quit] x"]) {
    assert.equal(readAutostart(`${AUTOSTART_ENTRY}${line}\n`), false, line);
  }
});

test("turning it on makes the folder and writes the entry, readable by everyone", (t) => {
  const file = path.join(tempDir(t), "config", "autostart", "org.example.App.desktop");
  assert.equal(isAutostartOn(file), false);
  setAutostart(file, true);
  assert.equal(fs.readFileSync(file, "utf8"), AUTOSTART_ENTRY);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.equal(isAutostartOn(file), true);
  // No temporary file is left beside it.
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["org.example.App.desktop"]);
});

test("turning it on again, or off while it is off, changes nothing", (t) => {
  const file = path.join(tempDir(t), "org.example.App.desktop");
  setAutostart(file, true);
  setAutostart(file, true);
  assert.equal(fs.readFileSync(file, "utf8"), AUTOSTART_ENTRY);
  setAutostart(file, false);
  assert.equal(fs.existsSync(file), false);
  setAutostart(file, false);
  assert.equal(isAutostartOn(file), false);
});

test("turning it on writes afresh an entry that another tool turned off", (t) => {
  const file = path.join(tempDir(t), "org.example.App.desktop");
  fs.writeFileSync(file, TURNED_OFF);
  assert.equal(isAutostartOn(file), false);
  setAutostart(file, true);
  assert.equal(fs.readFileSync(file, "utf8"), AUTOSTART_ENTRY);
  assert.equal(isAutostartOn(file), true);
});

test("turning it off removes only the app's own file", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "org.example.App.desktop");
  fs.writeFileSync(path.join(dir, "other.desktop"), "[Desktop Entry]\nType=Application\nName=Other\nExec=other\n");
  setAutostart(file, true);
  setAutostart(file, false);
  assert.deepEqual(fs.readdirSync(dir), ["other.desktop"]);
});

test("does not hide a file that cannot be read, written or removed", (t) => {
  // A folder in the file's place cannot be read, replaced or removed as a file.
  const file = path.join(tempDir(t), "org.example.App.desktop");
  fs.mkdirSync(file);
  assert.throws(() => isAutostartOn(file));
  assert.throws(() => setAutostart(file, true));
  assert.throws(() => setAutostart(file, false));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["org.example.App.desktop"]);
});

test("the entry passes desktop-file-validate with no error or warning", (t) => {
  const file = path.join(tempDir(t), "org.example.SchemaStudioTest.desktop");
  fs.writeFileSync(file, AUTOSTART_ENTRY);
  const run = spawnSync("desktop-file-validate", [file], { encoding: "utf8" });
  if ((run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    // The desktop workflow installs the tool and sets this, so there the check can never be skipped by accident.
    assert.notEqual(process.env.REQUIRE_DESKTOP_FILE_VALIDATE, "1", "desktop-file-validate is not installed");
    t.skip("desktop-file-validate is not installed (Ubuntu has it in desktop-file-utils)");
    return;
  }
  assert.equal(run.error, undefined);
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, output);
  assert.deepEqual(
    output.split("\n").filter((line) => /: (error|warning): /.test(line)),
    [],
  );
});
