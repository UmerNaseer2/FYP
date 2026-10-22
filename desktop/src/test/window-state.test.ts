/**
 * Where the main window opens (src/core/window-state.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { SavedWindow } from "../core/config";
import { placeWindow, type Rect } from "../core/window-state";

/** A 1080p screen, the main and only one unless a test adds another. */
const SCREEN: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

function saved(x: number | null, y: number | null, width: number, height: number, maximized = false): SavedWindow {
  return { x, y, width, height, maximized };
}

test("a first run opens the usual size in the middle of the main screen", () => {
  assert.deepEqual(placeWindow(null, [SCREEN], SCREEN), {
    bounds: { x: 320, y: 130, width: 1280, height: 820 },
    minWidth: 900,
    minHeight: 600,
    maximized: false,
  });
});

test("a screen smaller than the usual minimum still gets a window that fits it", () => {
  const small: Rect = { x: 0, y: 0, width: 800, height: 500 };
  assert.deepEqual(placeWindow(null, [small], small), {
    bounds: { x: 0, y: 0, width: 800, height: 500 },
    minWidth: 800,
    minHeight: 500,
    maximized: false,
  });
});

test("a window that is still on the screen opens where it was", () => {
  assert.deepEqual(placeWindow(saved(100, 80, 1000, 700), [SCREEN], SCREEN).bounds, {
    x: 100,
    y: 80,
    width: 1000,
    height: 700,
  });
});

test("a window hanging off the edge is pulled back onto the screen", () => {
  assert.deepEqual(placeWindow(saved(1700, 100, 1000, 700), [SCREEN], SCREEN).bounds, {
    x: 920,
    y: 100,
    width: 1000,
    height: 700,
  });
  assert.deepEqual(placeWindow(saved(-200, 100, 1000, 700), [SCREEN], SCREEN).bounds, {
    x: 0,
    y: 100,
    width: 1000,
    height: 700,
  });
});

test("a window bigger than the screen is shrunk to fit it", () => {
  assert.deepEqual(placeWindow(saved(0, 0, 3000, 2000), [SCREEN], SCREEN).bounds, {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  });
});

test("a window last seen on a screen that is gone opens in the middle, keeping its size and maximized state", () => {
  assert.deepEqual(placeWindow(saved(2500, 100, 1000, 700, true), [SCREEN], SCREEN), {
    bounds: { x: 460, y: 190, width: 1000, height: 700 },
    minWidth: 900,
    minHeight: 600,
    maximized: true,
  });
});

test("a window on a second screen that is still there opens on that screen", () => {
  const second: Rect = { x: 1920, y: 0, width: 2560, height: 1400 };
  assert.deepEqual(placeWindow(saved(2000, 50, 1200, 800), [SCREEN, second], SCREEN), {
    bounds: { x: 2000, y: 50, width: 1200, height: 800 },
    minWidth: 900,
    minHeight: 600,
    maximized: false,
  });
});

test("a window whose title bar is mostly above the screen cannot be grabbed, so it opens in the middle", () => {
  // Only 10 pixels of the title bar's height would be on the screen.
  assert.deepEqual(placeWindow(saved(100, -30, 1000, 700), [SCREEN], SCREEN).bounds, {
    x: 460,
    y: 190,
    width: 1000,
    height: 700,
  });
});

test("a window saved without a place (Wayland) opens its saved size in the middle", () => {
  assert.deepEqual(placeWindow(saved(null, null, 1400, 900), [SCREEN], SCREEN).bounds, {
    x: 260,
    y: 90,
    width: 1400,
    height: 900,
  });
});
