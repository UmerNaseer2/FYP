import ClientProvider from "./ClientProvider";
import "./globals.css";
import "./styles/atelier-system.css";
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
import { INTRO_HEAD_SCRIPT } from "@/lib/ui/intro";

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
 * Puts the saved theme on the page before it is first drawn.
 *
 * The server always sends `data-theme="dark"`, and hooks/useTheme only corrects
 * that once React has started. Without this a light-theme user saw every page
 * load dark and then flash to light. The saved choice is hooks/useTheme's
 * "ss-theme" in localStorage.
 */
const THEME_SCRIPT = `try {
  var saved = localStorage.getItem("ss-theme");
  if (saved === "light" || saved === "dark") {
    document.documentElement.setAttribute("data-theme", saved);
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
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* Marks the page as waiting for the logo reveal (lib/ui/intro.ts). */}
        <script dangerouslySetInnerHTML={{ __html: INTRO_HEAD_SCRIPT }} />
      </head>
      <body>
        <ClientProvider>{children}</ClientProvider>
      </body>
    </html>
  );
}