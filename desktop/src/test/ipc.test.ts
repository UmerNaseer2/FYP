/**
 * The names of the messages between the app's windows and its main process
 * (src/shared/ipc.ts). Two channels with one name would mix up two different
 * requests.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { BRIDGE, SETTINGS, STARTUP } from "../shared/ipc";

test("every message channel has a name of its own", () => {
  const names = [...Object.values(BRIDGE), ...Object.values(STARTUP), ...Object.values(SETTINGS)];
  assert.equal(new Set(names).size, names.length);
});

test("each channel's name starts with the part of the app it belongs to", () => {
  for (const name of Object.values(BRIDGE)) assert.match(name, /^desktop:[a-z-]+$/);
  for (const name of Object.values(STARTUP)) assert.match(name, /^startup:[a-z-]+$/);
  for (const name of Object.values(SETTINGS)) assert.match(name, /^settings:[a-z-]+$/);
});
