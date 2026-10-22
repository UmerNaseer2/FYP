/**
 * Where the app keeps its files (src/core/paths.ts).
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { displayPath, resolveAppPaths } from "../core/paths";

test("puts everything in the usual Ubuntu folders when no XDG folder is set", () => {
  assert.deepEqual(resolveAppPaths({}, "/home/sam"), {
    config: "/home/sam/.config/schema-studio",
    data: "/home/sam/.local/share/schema-studio",
    postgres: "/home/sam/.local/share/schema-studio/postgres",
    logs: "/home/sam/.local/state/schema-studio/logs",
    configFile: "/home/sam/.config/schema-studio/config.json",
    authFile: "/home/sam/.config/schema-studio/auth.json",
    secretsFile: "/home/sam/.local/share/schema-studio/secrets.json",
  });
});

test("follows XDG_CONFIG_HOME, XDG_DATA_HOME and XDG_STATE_HOME", () => {
  const paths = resolveAppPaths(
    { XDG_CONFIG_HOME: "/xdg/config", XDG_DATA_HOME: "/xdg/data", XDG_STATE_HOME: "/xdg/state" },
    "/home/sam",
  );
  assert.deepEqual(paths, {
    config: "/xdg/config/schema-studio",
    data: "/xdg/data/schema-studio",
    postgres: "/xdg/data/schema-studio/postgres",
    logs: "/xdg/state/schema-studio/logs",
    configFile: "/xdg/config/schema-studio/config.json",
    authFile: "/xdg/config/schema-studio/auth.json",
    secretsFile: "/xdg/data/schema-studio/secrets.json",
  });
});

test("ignores an XDG folder that is relative or empty, as the XDG rules say to", () => {
  const paths = resolveAppPaths(
    { XDG_CONFIG_HOME: "relative/config", XDG_DATA_HOME: "", XDG_STATE_HOME: "./state" },
    "/home/sam",
  );
  assert.equal(paths.config, "/home/sam/.config/schema-studio");
  assert.equal(paths.data, "/home/sam/.local/share/schema-studio");
  assert.equal(paths.logs, "/home/sam/.local/state/schema-studio/logs");
});

test("keeps the database in the same folder as the keys that protect it", () => {
  const paths = resolveAppPaths({}, "/home/sam");
  assert.equal(path.dirname(paths.postgres), paths.data);
  assert.equal(path.dirname(paths.secretsFile), paths.data);
});

test("shows the home folder as ~, the way a terminal does", () => {
  assert.equal(displayPath("/home/sam/.local/share/schema-studio", "/home/sam"), "~/.local/share/schema-studio");
  assert.equal(displayPath("/home/sam", "/home/sam"), "~");
  assert.equal(displayPath("/home/sam/notes", "/home/sam/"), "~/notes");
});

test("only treats a whole folder name as the home folder", () => {
  assert.equal(displayPath("/home/sam2/notes", "/home/sam"), "/home/sam2/notes");
  assert.equal(displayPath("/srv/data", "/home/sam"), "/srv/data");
  // A home folder of / would turn every path into ~, so it is left alone.
  assert.equal(displayPath("/srv/data", "/"), "/srv/data");
});
