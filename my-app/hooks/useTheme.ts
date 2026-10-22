"use client";

import { useEffect, useState } from "react";
import { getDesktopBridge } from "@/lib/desktop-bridge";

export type Theme = "dark" | "light";

const THEME_KEY = "ss-theme";

/**
 * True when the window asks for light. Inside the desktop app this answer
 * comes from the app, not the page: Electron answers `prefers-color-scheme`
 * with whatever its theme setting says, which is the Ubuntu light or dark
 * setting until the person picks one of their own.
 */
const LIGHT_QUERY = "(prefers-color-scheme: light)";

/**
 * Reads the saved theme on mount and toggles it, keeping `<html data-theme>`
 * and localStorage in sync. Shared by the Studio shell and the standalone
 * Login screen so theme behaviour stays identical across the app.
 *
 * The html element defaults to `dark` from the root layout; this hook applies
 * the saved choice after the client mounts (root `<html>` has
 * `suppressHydrationWarning`, so the attribute swap is safe).
 *
 * Inside the desktop app (see lib/desktop-bridge.ts) the theme is the app's to
 * keep instead of localStorage's. It follows Ubuntu's light or dark setting,
 * live, until the toggle pins one; the toggle hands that choice to the app,
 * which remembers it for every window and every later start. The app's View
 * menu is where "follow Ubuntu" comes back from.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    if (getDesktopBridge()) {
      const query = window.matchMedia(LIGHT_QUERY);
      const apply = () => {
        const next: Theme = query.matches ? "light" : "dark";
        setTheme(next);
        document.documentElement.setAttribute("data-theme", next);
      };
      // Same post-mount sync as below. The root layout's head script has
      // usually set the attribute already, before the first paint; this
      // brings the toggle's own state in line with it.
      apply();
      // Fires when Ubuntu switches between light and dark, and when the
      // app's theme setting changes, including from the toggle below.
      query.addEventListener("change", apply);
      return () => query.removeEventListener("change", apply);
    }

    try {
      const saved = localStorage.getItem(THEME_KEY) as Theme | null;
      if (saved === "light" || saved === "dark") {
        // Intentional post-mount sync: reading localStorage during render would
        // mismatch the server's "dark" default and break hydration. The mount
        // effect reconciles instead (html has suppressHydrationWarning).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setTheme(saved);
        document.documentElement.setAttribute("data-theme", saved);
      }
    } catch {
      /* localStorage unavailable — keep the default */
    }
  }, []);

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);

    const desktop = getDesktopBridge();
    if (desktop) {
      desktop.setTheme(next);
      return;
    }
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
  }

  return { theme, toggleTheme };
}
