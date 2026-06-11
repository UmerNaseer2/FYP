import type { ReactNode } from "react";
import {
  DashboardIcon,
  CompareIcon,
  EditIcon,
  DeployIcon,
  ConnectionsIcon,
  DriftIcon,
  SchemaMapIcon,
  VersionSyncIcon,
} from "@/components/ui/icons";

export type NavItem = {
  /** Short name shown in the breadcrumb. */
  screen: string;
  /** Sidebar label (may differ subtly from `screen`). */
  label: string;
  href: string;
  icon: ReactNode;
  /** Optional count badge (drift / pending). */
  badge?: string;
};

// Phase 1 routes: Dashboard/Deploy/Drift live inside the new shell; Compare &
// Connections still point at the legacy pages until their migration phase lands.
export const NAV_ITEMS: NavItem[] = [
  {
    screen: "Dashboard",
    label: "Dashboard",
    href: "/studio",
    icon: <DashboardIcon className="ico" />,
    // No badge: real "pending" counts arrive with the Phase 6/7 tracked-schema
    // backend. A hardcoded number here would be fake data that looks real.
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
    screen: "Connections",
    label: "Connections",
    href: "/connections",
    icon: <ConnectionsIcon className="ico" />,
  },
  {
    screen: "Drift",
    label: "Drift",
    href: "/drift",
    icon: <DriftIcon className="ico" />,
    // No badge: real drift-event counts arrive with the Phase 6/9 drift backend.
  },
  {
    screen: "Visualizer",
    label: "Visualizer",
    href: "/visualizer",
    icon: <SchemaMapIcon className="ico" />,
  },
];

/** Pick the nav item whose route matches the current path (falls back to Dashboard). */
export function activeNavItem(pathname: string): NavItem {
  const match = NAV_ITEMS.find(
    (item) => pathname === item.href || pathname.startsWith(item.href + "/")
  );
  return match ?? NAV_ITEMS[0];
}
