"use client";

import { useEffect, useState } from "react";

export type Theme = "dark" | "light";

const THEME_KEY = "ss-theme";

/**
 * Reads the saved theme on mount and toggles it, keeping `<html data-theme>`
 * and localStorage in sync. Shared by the Studio shell and the standalone
 * Login screen so theme behaviour stays identical across the app.
 *
 * The html element defaults to `dark` from the root layout; this hook applies
 * the saved choice after the client mounts (root `<html>` has
 * `suppressHydrationWarning`, so the attribute swap is safe).
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
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
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
  }

  return { theme, toggleTheme };
}
