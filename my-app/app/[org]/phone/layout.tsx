import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

/**
 * The phone app's own head. It sits outside the (studio) group, so it has no
 * rail, and these are what let a phone install it on its Home Screen.
 */
export const metadata: Metadata = {
  title: "Schema Studio",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Schema Studio", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png", icon: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: "#f7f7f8",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function PhoneLayout({ children }: { children: ReactNode }) {
  return children;
}
