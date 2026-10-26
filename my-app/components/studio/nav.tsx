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
import type { FeatureKey } from "@/lib/permissions";
import { orgSlugFromPath } from "@/lib/org-slug";

export type NavItem = {
  /** Short name shown in the breadcrumb. */
  screen: string;
  /** Sidebar label (may differ subtly from `screen`). */
  label: string;
  /**
   * The screen's address without the organization ("/drift"). The shell puts
   * the organization the page is open in on the front ("/acme/drift").
   */
  href: string;
  icon: ReactNode;
  /**
   * The feature this screen belongs to (lib/permissions). The rail shows it
   * only when the role may Read that feature, or any one of them for a list,
   * which is the same question the screen's own AuthGuard asks.
   */
  feature: FeatureKey | FeatureKey[];
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
    feature: "dashboard",
  },
  {
    screen: "Compare & Author",
    label: "Compare & Author",
    href: "/compare",
    icon: <CompareIcon className="ico" />,
    feature: "compare",
  },
  {
    screen: "Script Editor",
    label: "Script Editor",
    href: "/script-editor",
    icon: <EditIcon className="ico" />,
    feature: "scripts",
  },
  {
    screen: "Deploy",
    label: "Deploy",
    href: "/deploy",
    icon: <DeployIcon className="ico" />,
    feature: "deploy",
  },
  {
    screen: "Version Sync",
    label: "Version Sync",
    href: "/versionsync",
    icon: <VersionSyncIcon className="ico" />,
    feature: "version_sync",
  },
  {
    screen: "Drift",
    label: "Drift",
    href: "/drift",
    icon: <DriftIcon className="ico" />,
    feature: "drift",
  },
  {
    screen: "Performance",
    label: "Performance",
    href: "/performance",
    icon: <GaugeIcon className="ico" />,
    feature: "performance",
  },
  {
    screen: "Visualizer",
    label: "Visualizer",
    href: "/visualizer",
    icon: <SchemaMapIcon className="ico" />,
    feature: "visualizer",
  },
  {
    screen: "Connections",
    label: "Connections",
    href: "/connections",
    icon: <ConnectionsIcon className="ico" />,
    feature: "connections",
  },
  {
    screen: "Admin",
    label: "Admin",
    href: "/admin",
    icon: <UsersIcon className="ico" />,
    feature: ["users", "roles"],
  },
];

/**
 * Pick the nav item whose route matches the current path (falls back to
 * Dashboard). The organization at the front of the path is set aside first,
 * so "/acme/drift" is Drift, the same as the old address "/drift".
 */
export function activeNavItem(pathname: string): NavItem {
  const slug = orgSlugFromPath(pathname);
  const route = slug === null ? pathname : pathname.slice(slug.length + 1);
  const match = NAV_ITEMS.find(
    (item) => route === item.href || route.startsWith(item.href + "/")
  );
  return match ?? NAV_ITEMS[0];
}
