import type { ReactNode } from "react";
import {
  DashboardIcon,
  CompareIcon,
  EditIcon,
  DeployIcon,
  ConnectionsIcon,
  DriftIcon,
  GaugeIcon,
  SchemaMapIcon,
  VersionSyncIcon,
  UsersIcon,
} from "@/components/ui/icons";

export type NavItem = {
  /** Short name shown in the breadcrumb. */
  screen: string;
  /** Sidebar label (may differ subtly from `screen`). */
  label: string;
  href: string;
  icon: ReactNode;
  /** Only shown to admins — the shell filters these on the live session role. */
  adminOnly?: boolean;
};

// The order is the order the work happens in, not alphabetical and not by how
// often a screen is opened. Somebody who has never used this app should be able
// to read the rail top to bottom and get a working answer to "what do I do
// next": look at the dashboard, compare two databases, edit what that
// generated, deploy it, record the version, then watch for drift and for
// performance. Visualizer sits after those because it explains a schema rather
// than changing one.
//
// Connections and Admin are last together, away from that sequence. They are
// both setup — things you do once and come back to rarely — and Connections
// used to sit in the middle of the pipeline, which made the rail stop reading
// as a sequence exactly where somebody new needed it to.
export const NAV_ITEMS: NavItem[] = [
  {
    screen: "Dashboard",
    label: "Dashboard",
    href: "/studio",
    icon: <DashboardIcon className="ico" />,
  },
  {
    screen: "Compare & Author",
    label: "Compare & Author",
    href: "/compare",
    icon: <CompareIcon className="ico" />,
  },
  {
    screen: "Script Editor",
    label: "Script Editor",
    href: "/script-editor",
    icon: <EditIcon className="ico" />,
  },
  {
    screen: "Deploy",
    label: "Deploy",
    href: "/deploy",
    icon: <DeployIcon className="ico" />,
  },
  {
    screen: "Version Sync",
    label: "Version Sync",
    href: "/versionsync",
    icon: <VersionSyncIcon className="ico" />,
  },
  {
    screen: "Drift",
    label: "Drift",
    href: "/drift",
    icon: <DriftIcon className="ico" />,
  },
  {
    screen: "Performance",
    label: "Performance",
    href: "/performance",
    icon: <GaugeIcon className="ico" />,
  },
  {
    screen: "Visualizer",
    label: "Visualizer",
    href: "/visualizer",
    icon: <SchemaMapIcon className="ico" />,
  },
  {
    screen: "Connections",
    label: "Connections",
    href: "/connections",
    icon: <ConnectionsIcon className="ico" />,
  },
  {
    screen: "Admin",
    label: "Admin",
    href: "/admin",
    icon: <UsersIcon className="ico" />,
    adminOnly: true,
  },
];

/** Pick the nav item whose route matches the current path (falls back to Dashboard). */
export function activeNavItem(pathname: string): NavItem {
  const match = NAV_ITEMS.find(
    (item) => pathname === item.href || pathname.startsWith(item.href + "/")
  );
  return match ?? NAV_ITEMS[0];
}
