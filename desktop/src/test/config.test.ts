/**
 * Reading and writing config.json (src/core/config.ts). The rule under test:
 * one bad value falls back to its default, and everything else is kept.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultConfig,
  isThemeChoice,
  isUsablePort,
  parseConfig,
  serializeConfig,
  type AppConfig,
  type SavedWindow,
} from "../core/config";

const WINDOW: SavedWindow = { x: 10, y: 20, width: 1280, height: 820, maximized: true };

const FULL: AppConfig = {
  version: 1,
  port: 23456,
  window: WINDOW,
  theme: "dark",
  github: { owner: "octocat", repo: "schema-registry" },
};

function parseWith(changes: Record<string, unknown>) {
  return parseConfig(JSON.stringify({ ...FULL, ...changes }));
}

test("the defaults are: no port yet, no saved window, follow Ubuntu's theme, no registry", () => {
  assert.deepEqual(defaultConfig(), {
    version: 1,
    port: null,
    window: null,
    theme: "system",
    github: { owner: "", repo: "" },
  });
});

test("no file yet gives the defaults, and is nothing to complain about", () => {
  assert.deepEqual(parseConfig(null), { config: defaultConfig(), damaged: false });
});

test("text that is not a settings object gives the defaults and counts as damaged", () => {
  for (const text of ["{bad", "", "[]", "null", "5", '"text"']) {
    assert.deepEqual(parseConfig(text), { config: defaultConfig(), damaged: true }, text);
  }
});

test("a complete, valid file comes back exactly as it was written", () => {
  assert.deepEqual(parseConfig(JSON.stringify(FULL)), { config: FULL, damaged: false });
});

test("a file with only the version in it gives the defaults, and is not damaged", () => {
  assert.deepEqual(parseConfig('{"version":1}'), { config: defaultConfig(), damaged: false });
});

test("a port the app may not use is dropped, the rest is kept, and the file counts as damaged", () => {
  for (const port of [80, 23456.5, "23456", 70000]) {
    assert.deepEqual(parseWith({ port }), { config: { ...FULL, port: null }, damaged: true }, String(port));
  }
});

test("a port of null only means none has been picked yet", () => {
  assert.deepEqual(parseWith({ port: null }), { config: { ...FULL, port: null }, damaged: false });
});

test("a window too small to be real is dropped, and the file counts as damaged", () => {
  assert.deepEqual(parseWith({ window: { ...WINDOW, width: 100 } }), {
    config: { ...FULL, window: null },
    damaged: true,
  });
  assert.deepEqual(parseWith({ window: { ...WINDOW, height: 30000 } }), {
    config: { ...FULL, window: null },
    damaged: true,
  });
});

test("a window without a usable place keeps its size and forgets the place", () => {
  const result = parseWith({ window: { ...WINDOW, x: "a" } });
  assert.deepEqual(result.config.window, { x: null, y: null, width: 1280, height: 820, maximized: true });
  assert.equal(result.damaged, false);
});

test("a window saved without a place, as on Wayland, comes back without one", () => {
  const window = { x: null, y: null, width: 1400, height: 900, maximized: false };
  assert.deepEqual(parseWith({ window }), { config: { ...FULL, window }, damaged: false });
});

test("maximized is only true when it says exactly true", () => {
  assert.equal(parseWith({ window: { ...WINDOW, maximized: "yes" } }).config.window?.maximized, false);
});

test("an unknown theme goes back to following Ubuntu, and the file counts as damaged", () => {
  assert.deepEqual(parseWith({ theme: "blue" }), { config: { ...FULL, theme: "system" }, damaged: true });
});

test("a registry GitHub would refuse is forgotten, and the file counts as damaged", () => {
  assert.deepEqual(parseWith({ github: { owner: "-bad", repo: "schema-registry" } }), {
    config: { ...FULL, github: { owner: "", repo: "" } },
    damaged: true,
  });
  assert.deepEqual(parseWith({ github: "octocat/schema-registry" }), {
    config: { ...FULL, github: { owner: "", repo: "" } },
    damaged: true,
  });
});

test("the registry's two names are read whatever order they were saved in", () => {
  assert.deepEqual(parseWith({ github: { repo: "schema-registry", owner: "octocat" } }), {
    config: FULL,
    damaged: false,
  });
});

test("a file from another version counts as damaged, but keeps what it can", () => {
  assert.deepEqual(parseWith({ version: 2 }), { config: FULL, damaged: true });
});

test("only unprivileged whole-number ports are usable", () => {
  assert.equal(isUsablePort(1023), false);
  assert.equal(isUsablePort(1024), true);
  assert.equal(isUsablePort(65535), true);
  assert.equal(isUsablePort(65536), false);
  assert.equal(isUsablePort(1024.5), false);
  assert.equal(isUsablePort(Number.NaN), false);
  assert.equal(isUsablePort("2000"), false);
  assert.equal(isUsablePort(null), false);
});

test("what is written reads back the same, and ends with a line break", () => {
  const text = serializeConfig(FULL);
  assert.ok(text.endsWith("}\n"));
  assert.deepEqual(parseConfig(text), { config: FULL, damaged: false });
});

test("only the three theme choices the app knows count as one", () => {
  for (const choice of ["system", "light", "dark"]) assert.equal(isThemeChoice(choice), true, choice);
  for (const value of ["Dark", "blue", "", null, undefined, 1, { theme: "dark" }]) {
    assert.equal(isThemeChoice(value), false, String(value));
  }
});
