import ClientProvider from "./ClientProvider";
import "./globals.css";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

import type { Viewport } from "next";

export const metadata = {
  title: "DB Schema Control",
  description: "Simple prototype for schema comparison and version control",
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
 */
const DESKTOP_THEME_SCRIPT = `try {
  if (window.schemaStudioDesktop) {
    document.documentElement.setAttribute(
      "data-theme",
      window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
    );
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
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: DESKTOP_THEME_SCRIPT }} />
      </head>
      <body>
        <ClientProvider>{children}</ClientProvider>
      </body>
    </html>
  );
}