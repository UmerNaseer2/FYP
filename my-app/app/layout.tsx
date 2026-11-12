import ClientProvider from "./ClientProvider";
import "./globals.css";
import type { ReactNode } from "react";
import { Bricolage_Grotesque, DM_Mono, Figtree } from "next/font/google";

// The three Atelier typefaces. app/globals.css reads them as --sans, --display
// and --mono, with plain system fonts behind them in case one fails to load.
const sans = Figtree({
  subsets: ["latin"],
  variable: "--ff-sans",
  display: "swap",
});

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--ff-display",
  display: "swap",
});

const mono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--ff-mono",
  display: "swap",
});

import type { Viewport } from "next";
import { INTRO_HEAD_SCRIPT } from "@/lib/intro";

export const metadata = {
  title: "Schema Studio",
  description: "Version control for your database schemas.",
};

// Render at real device width on phones (without this, mobile browsers assume a
// ~980px page and every responsive rule below is dead). Pinch-zoom left enabled
// for accessibility.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

/**
 * Inside the desktop app, puts the right theme on the page before it is first
 * drawn.
 *
 * The server always sends `data-theme="dark"`, and hooks/useTheme only corrects
 * that once React has started, so on a PC set to Ubuntu's light style every
 * window would open dark and then flick to light. The desktop app's preload
 * script has put its bridge on `window` before this runs, so this can tell it
 * is inside the app and read the app's theme from `prefers-color-scheme`, which
 * Electron answers from the app's own setting. In a browser it does nothing at
 * all: there the saved choice still comes from localStorage, as before.
 *
 * In a browser it puts the saved choice (hooks/useTheme's "ss-theme") on the
 * page just as early. Without it a light-theme user saw every page load dark
 * and then flash to light once React started.
 */
const DESKTOP_THEME_SCRIPT = `try {
  if (window.schemaStudioDesktop) {
    document.documentElement.setAttribute(
      "data-theme",
      window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
    );
  } else {
    var saved = localStorage.getItem("ss-theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  }
} catch (e) {}`;

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${sans.variable} ${display.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: DESKTOP_THEME_SCRIPT }} />
        {/* Marks the page as waiting for the logo reveal (lib/intro.ts). */}
        <script dangerouslySetInnerHTML={{ __html: INTRO_HEAD_SCRIPT }} />
      </head>
      <body>
        <ClientProvider>{children}</ClientProvider>
      </body>
    </html>
  );
}