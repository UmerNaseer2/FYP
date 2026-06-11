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
      <body>
        <ClientProvider>{children}</ClientProvider>
      </body>
    </html>
  );
}