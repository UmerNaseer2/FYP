/**
 * Works out where the main window opens: the size and place it had last time
 * if that still fits the screens this computer has now, otherwise a sensible
 * default in the middle of the main screen.
 *
 * "Still fits" matters because screens change: a laptop that was last used
 * with a big monitor attached must not open its window on a monitor that is
 * no longer there. The window counts as reachable when enough of the strip
 * along its top (where the title bar is, so it can be dragged) is on a screen.
 *
 * On Wayland, Ubuntu's default desktop, apps are not allowed to choose where
 * their windows go, so the saved place is simply ignored there and only the
 * size and the maximized state come back.
 *
 * Pure: the main process passes in the screens' work areas from Electron.
 */
import type { SavedWindow } from "./config";

export type Rect = { x: number; y: number; width: number; height: number };

export const DEFAULT_SIZE = { width: 1280, height: 820 };
export const MIN_SIZE = { width: 900, height: 600 };

/** How much of the title bar strip must be on a screen: enough to grab. */
const GRAB_WIDTH = 120;
const GRAB_HEIGHT = 20;
const TITLE_STRIP_HEIGHT = 40;

export type WindowPlacement = {
  bounds: { x: number; y: number; width: number; height: number };
  minWidth: number;
  minHeight: number;
  maximized: boolean;
};

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

function centered(size: { width: number; height: number }, area: Rect): { x: number; y: number } {
  return {
    x: Math.round(area.x + (area.width - size.width) / 2),
    y: Math.round(area.y + (area.height - size.height) / 2),
  };
}

export function placeWindow(saved: SavedWindow | null, workAreas: Rect[], primary: Rect): WindowPlacement {
  // A screen smaller than the usual minimum still gets a window that fits it.
  const minWidth = Math.min(MIN_SIZE.width, primary.width);
  const minHeight = Math.min(MIN_SIZE.height, primary.height);

  const fit = (wanted: { width: number; height: number }, area: Rect) => ({
    width: Math.max(Math.min(wanted.width, area.width), Math.min(minWidth, area.width)),
    height: Math.max(Math.min(wanted.height, area.height), Math.min(minHeight, area.height)),
  });

  if (saved && saved.x !== null && saved.y !== null) {
    const { x: savedX, y: savedY } = saved;
    const titleStrip: Rect = { x: savedX, y: savedY, width: saved.width, height: TITLE_STRIP_HEIGHT };
    const home = workAreas.find((area) => {
      const o = overlap(titleStrip, area);
      return o.width >= Math.min(GRAB_WIDTH, saved.width) && o.height >= GRAB_HEIGHT;
    });
    if (home) {
      const size = fit(saved, home);
      // Pull the window fully back inside the screen its title bar is on.
      const x = Math.min(Math.max(savedX, home.x), home.x + home.width - size.width);
      const y = Math.min(Math.max(savedY, home.y), home.y + home.height - size.height);
      return { bounds: { x, y, ...size }, minWidth, minHeight, maximized: saved.maximized };
    }
  }

  // No usable place: the saved size (or the default) in the middle of the
  // main screen.
  const size = fit(saved ?? DEFAULT_SIZE, primary);
  return {
    bounds: { ...centered(size, primary), ...size },
    minWidth,
    minHeight,
    maximized: saved?.maximized ?? false,
  };
}
