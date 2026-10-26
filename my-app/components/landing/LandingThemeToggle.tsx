"use client";

import { MoonIcon, SunIcon } from "@/components/ui/icons";
import { useTheme } from "@/hooks/useTheme";

/**
 * The landing page's light and dark switch, which the onboarding page's
 * header uses too.
 *
 * The one part of the landing page that runs in the browser: the rest is a
 * Server Component, and a theme switch needs a click handler and the saved
 * choice in localStorage. It is the same button as the sign-in page's, and it
 * goes through the same hook, so a visitor who picks light here still has
 * light after pressing "Log in", and on the onboarding page after that.
 */
export function LandingThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button type="button" className="btn btn-secondary btn-sm" onClick={toggleTheme} title="Toggle theme">
      {theme === "dark" ? <SunIcon size={14} /> : <MoonIcon size={14} />}
      <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
    </button>
  );
}
