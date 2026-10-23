/**
 * The phone link's line in the top bar icon's menu (src/core/tray-status.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { trayStatus } from "../core/tray-status";
import type { PhoneStatus, PhoneView } from "../shared/ipc";

function viewWith(status: PhoneStatus): PhoneView {
  return {
    available: true,
    status,
    enabled: true,
    relayOrigin: "https://relay.example.com",
    sharedConnectionIds: [],
    phones: [],
    cannotPair: null,
  };
}

test("names each state the phone link can be in", () => {
  assert.equal(trayStatus(viewWith({ state: "off" })), "Phone link: off");
  assert.equal(trayStatus(viewWith({ state: "needs-relay" })), "Phone link: no relay set");
  assert.equal(trayStatus(viewWith({ state: "connecting" })), `Phone link: connecting${String.fromCharCode(0x2026)}`);
  assert.equal(trayStatus(viewWith({ state: "connected" })), "Phone link: connected");
  assert.equal(
    trayStatus(viewWith({ state: "waiting", retryAt: Date.now() + 5_000, reason: "The relay did not answer." })),
    "Phone link: waiting to reconnect",
  );
  assert.equal(trayStatus(viewWith({ state: "replaced" })), "Phone link: another copy took over");
});

test("says so when the phone link has not started, whatever the reason", () => {
  assert.equal(trayStatus({ available: false, message: "The phone link starts once Schema Studio has started." }), "Phone link: not running");
  assert.equal(trayStatus({ available: false, message: "Something else went wrong." }), "Phone link: not running");
});

test("every line is short enough for a menu and starts the same way", () => {
  const states: PhoneStatus[] = [
    { state: "off" },
    { state: "needs-relay" },
    { state: "connecting" },
    { state: "connected" },
    { state: "waiting", retryAt: 0, reason: "" },
    { state: "replaced" },
  ];
  const lines = states.map((status) => trayStatus(viewWith(status)));
  assert.equal(new Set(lines).size, states.length);
  for (const line of lines) {
    assert.ok(line.startsWith("Phone link: "), line);
    assert.ok(line.length <= 40, line);
  }
});
