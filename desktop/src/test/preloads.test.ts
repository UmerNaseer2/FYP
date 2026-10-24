/**
 * What each page gets from the two preload scripts
 * (src/preload/app-preload.ts and src/preload/settings-preload.ts). The
 * compiled scripts run here against a fake Electron, much as a sandboxed
 * window runs them: they may load nothing but "electron", and they see the
 * address of the page they were loaded for.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { BACKUP, BRIDGE, PHONE, SETTINGS, STARTUP } from "../shared/ipc";

type Message = { kind: "invoke" | "send"; channel: string; args: unknown[] };
type Api = Record<string, (...args: unknown[]) => unknown>;

/** Runs a compiled preload for the page at `href`, and records what it gave the page and every message it sent. */
function runPreload(file: "app-preload.js" | "settings-preload.js", href: string) {
  const code = fs.readFileSync(path.join(__dirname, "..", "preload", file), "utf8");
  const exposed = new Map<string, Api>();
  const messages: Message[] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const electron = {
    contextBridge: {
      exposeInMainWorld(name: string, api: Api) {
        exposed.set(name, api);
      },
    },
    ipcRenderer: {
      invoke(channel: string, ...args: unknown[]) {
        messages.push({ kind: "invoke", channel, args });
        return Promise.resolve();
      },
      send(channel: string, ...args: unknown[]) {
        messages.push({ kind: "send", channel, args });
      },
      on(channel: string, listener: (...args: unknown[]) => void) {
        listeners.set(channel, listener);
      },
    },
  };
  const sandboxedRequire = (name: string) => {
    if (name === "electron") return electron;
    throw new Error(`A sandboxed preload cannot load "${name}".`);
  };
  // A fresh context has no URL of its own, so it gets Node's, which follows the same standard as the browser's.
  vm.runInNewContext(code, { require: sandboxedRequire, location: { href }, URL });
  return { exposed, messages, listeners };
}

test("the splash gets the start-up messages and nothing else, and cannot add anything to them", async () => {
  const { exposed, messages, listeners } = runPreload("app-preload.js", "app://schema-studio/splash.html");
  assert.deepEqual([...exposed.keys()], ["schemaStudioStartup"]);
  const startup = exposed.get("schemaStudioStartup");
  assert.ok(startup);

  await startup.getState("extra");
  startup.retry("extra");
  startup.openLogs("extra");
  await startup.copyDetails("extra");
  startup.onStatus(() => {});

  assert.deepEqual(messages, [
    { kind: "invoke", channel: STARTUP.getState, args: [] },
    { kind: "send", channel: STARTUP.retry, args: [] },
    { kind: "send", channel: STARTUP.openLogs, args: [] },
    { kind: "invoke", channel: STARTUP.copyDetails, args: [] },
  ]);
  assert.deepEqual([...listeners.keys()], [STARTUP.status]);
});

test("the splash hears each change as the state alone, never with Electron's message event", () => {
  const { exposed, listeners } = runPreload("app-preload.js", "app://schema-studio/splash.html");
  const startup = exposed.get("schemaStudioStartup");
  assert.ok(startup);
  const heard: unknown[][] = [];
  startup.onStatus((...args: unknown[]) => heard.push(args));

  const deliver = listeners.get(STARTUP.status);
  assert.ok(deliver);
  const event = { sender: { send() {} }, ports: [] };
  const state = { phase: "starting", step: "database" };
  deliver(event, state);

  assert.deepEqual(heard, [[state]]);
});

test("Schema Studio's own pages get the desktop features and nothing else, with only the theme passed on", async () => {
  const { exposed, messages } = runPreload("app-preload.js", "http://127.0.0.1:4100/studio");
  assert.deepEqual([...exposed.keys()], ["schemaStudioDesktop"]);
  const desktop = exposed.get("schemaStudioDesktop");
  assert.ok(desktop);

  await desktop.signIn("extra");
  desktop.cancelSignIn("extra");
  await desktop.signOut("extra");
  await desktop.findLocalDatabases("extra");
  desktop.setTheme("dark", "extra");
  desktop.openSettings("extra");

  assert.deepEqual(messages, [
    { kind: "invoke", channel: BRIDGE.signIn, args: [] },
    { kind: "send", channel: BRIDGE.cancelSignIn, args: [] },
    { kind: "invoke", channel: BRIDGE.signOut, args: [] },
    { kind: "invoke", channel: BRIDGE.findLocalDatabases, args: [] },
    { kind: "send", channel: BRIDGE.setTheme, args: ["dark"] },
    { kind: "send", channel: BRIDGE.openSettings, args: [] },
  ]);
});

test("any other page in the main window gets nothing", () => {
  for (const href of [
    "https://example.com/",
    "http://localhost:4100/studio",
    "http://127.0.0.2:4100/studio",
    "https://127.0.0.1:4100/studio",
    "app://schema-studio/settings.html",
    "app://schema-studio/other.html",
    "app://elsewhere/splash.html",
    "file:///splash.html",
  ]) {
    const { exposed, messages, listeners } = runPreload("app-preload.js", href);
    assert.equal(exposed.size, 0, href);
    assert.equal(messages.length + listeners.size, 0, href);
  }
});

test("the Settings page gets its own messages, and no other page gets them", async () => {
  const { exposed, messages } = runPreload("settings-preload.js", "app://schema-studio/settings.html");
  assert.deepEqual([...exposed.keys()], ["schemaStudioSettings", "schemaStudioPhone", "schemaStudioBackup"]);
  const settings = exposed.get("schemaStudioSettings");
  assert.ok(settings);

  const input = { owner: "octocat", repo: "schema-registry", token: { action: "keep" } };
  await settings.get("extra");
  await settings.saveGithub(input, "extra");
  settings.setTheme("light", "extra");
  settings.setKeepRunning(true, "extra");
  await settings.setStartAtLogin(true, "extra");
  settings.openLogs("extra");
  settings.close("extra");

  assert.deepEqual(messages, [
    { kind: "invoke", channel: SETTINGS.get, args: [] },
    { kind: "invoke", channel: SETTINGS.saveGithub, args: [input] },
    { kind: "send", channel: SETTINGS.setTheme, args: ["light"] },
    { kind: "send", channel: SETTINGS.setKeepRunning, args: [true] },
    { kind: "invoke", channel: SETTINGS.setStartAtLogin, args: [true] },
    { kind: "send", channel: SETTINGS.openLogs, args: [] },
    { kind: "send", channel: SETTINGS.close, args: [] },
  ]);

  for (const href of ["app://schema-studio/splash.html", "http://127.0.0.1:4100/studio", "https://example.com/settings.html"]) {
    assert.equal(runPreload("settings-preload.js", href).exposed.size, 0, href);
  }
});

test("the Settings page's Phone section gets the phone link's messages, and cannot add anything to them", async () => {
  const { exposed, messages, listeners } = runPreload("settings-preload.js", "app://schema-studio/settings.html");
  const phone = exposed.get("schemaStudioPhone");
  assert.ok(phone);

  await phone.get("extra");
  phone.setEnabled(true, "extra");
  await phone.setRelay("https://relay.example.com", "extra");
  phone.setShared([1, 2], "extra");
  phone.forget("key", "extra");
  await phone.pair("extra");
  phone.cancelPairing("extra");
  phone.connectNow("extra");
  await phone.connections("extra");
  phone.onChange(() => {});
  phone.onPaired(() => {});

  assert.deepEqual(messages, [
    { kind: "invoke", channel: PHONE.get, args: [] },
    { kind: "send", channel: PHONE.setEnabled, args: [true] },
    { kind: "invoke", channel: PHONE.setRelay, args: ["https://relay.example.com"] },
    { kind: "send", channel: PHONE.setShared, args: [[1, 2]] },
    { kind: "send", channel: PHONE.forget, args: ["key"] },
    { kind: "invoke", channel: PHONE.pair, args: [] },
    { kind: "send", channel: PHONE.cancelPairing, args: [] },
    { kind: "send", channel: PHONE.connectNow, args: [] },
    { kind: "invoke", channel: PHONE.connections, args: [] },
  ]);
  assert.deepEqual([...listeners.keys()], [PHONE.changed, PHONE.paired]);
});

test("the Phone section hears each change and each pairing as the news alone, never with Electron's message event", () => {
  const { exposed, listeners } = runPreload("settings-preload.js", "app://schema-studio/settings.html");
  const phone = exposed.get("schemaStudioPhone");
  assert.ok(phone);
  const views: unknown[][] = [];
  const names: unknown[][] = [];
  phone.onChange((...args: unknown[]) => views.push(args));
  phone.onPaired((...args: unknown[]) => names.push(args));

  const changed = listeners.get(PHONE.changed);
  const paired = listeners.get(PHONE.paired);
  assert.ok(changed && paired);
  const event = { sender: { send() {} }, ports: [] };
  const view = { available: false, message: "The phone link starts once Schema Studio has started." };
  changed(event, view);
  paired(event, "Pixel 9", "extra");

  assert.deepEqual(views, [[view]]);
  assert.deepEqual(names, [["Pixel 9"]]);
});

test("the Settings page's Backup section gets the backup messages, and cannot add anything to them", async () => {
  const { exposed, messages, listeners } = runPreload("settings-preload.js", "app://schema-studio/settings.html");
  const backup = exposed.get("schemaStudioBackup");
  assert.ok(backup);
  // Made up here, in place of what a person would type.
  const passphrase = ["not", "a", "real", "passphrase"].join("-");
  const repeat = ["not", "the", "same", "one"].join("-");

  await backup.save(passphrase, repeat, "extra");
  await backup.choose("extra");
  await backup.restore(passphrase, "extra");

  assert.deepEqual(messages, [
    { kind: "invoke", channel: BACKUP.save, args: [passphrase, repeat] },
    { kind: "invoke", channel: BACKUP.choose, args: [] },
    { kind: "invoke", channel: BACKUP.restore, args: [passphrase] },
  ]);
  // The main process announces nothing to this section: it only answers.
  assert.equal(listeners.size, 0);
});
