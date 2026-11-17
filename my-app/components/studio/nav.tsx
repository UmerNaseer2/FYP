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
  InboxIcon,
  ClockIcon,
} from "@/components/ui/icons";
import type { FeatureKey } from "@/lib/permissions";
import { orgSlugFromPath } from "@/lib/org-slug";

/**
 * The menu's group headings, in the order they are drawn. The first five are
 * the five words the app tour uses for the work: connect, compare, script,
 * ship, watch. People holds the pages about who may do what.
 */
export const NAV_GROUPS = ["Connect", "Compare", "Script", "Ship", "Watch", "People"] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

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
   * which is the same question the screen's own AuthGuard asks. Left out for a
   * screen that every member may open.
   */
  feature?: FeatureKey | FeatureKey[];
  /** The heading this screen sits under. Left out for Dashboard, which stands alone on top. */
  group?: NavGroup;
  /** How many things are waiting on this screen, shown beside its label. */
  badge?: number;
};

// The menu reads top to bottom in the order the work happens, under the same
// five words the app tour uses. Somebody who has never used this app can read
// it as a working answer to "what do I do next": look at the dashboard,
// connect a database, compare two of them, edit the script that made, ship
// it, then watch for drift.
//
// Visualizer sits under Compare because it explains a schema rather than
// changing one. History (what happened, and who did it) sits under Watch.
// People comes last: Requests, which anyone can use whatever their role, and
// Admin.
export const NAV_ITEMS: NavItem[] = [
  {
    screen: "Dashboard",
    label: "Dashboard",
    href: "/studio",
    icon: <DashboardIcon className="ico" />,
    feature: "dashboard",
  },
  {
    screen: "Connections",
    label: "Connections",
    href: "/connections",
    icon: <ConnectionsIcon className="ico" />,
    feature: "connections",
    group: "Connect",
  },
  {
    screen: "Compare & Author",
    label: "Compare & Author",
    href: "/compare",
    icon: <CompareIcon className="ico" />,
    feature: "compare",
    group: "Compare",
  },
  {
    screen: "Visualizer",
    label: "Visualizer",
    href: "/visualizer",
    icon: <SchemaMapIcon className="ico" />,
    feature: "visualizer",
    group: "Compare",
  },
  {
    screen: "Script Editor",
    label: "Script Editor",
    href: "/script-editor",
    icon: <EditIcon className="ico" />,
    feature: "scripts",
    group: "Script",
  },
  {
    screen: "Deploy",
    label: "Deploy",
    href: "/deploy",
    icon: <DeployIcon className="ico" />,
    feature: "deploy",
    group: "Ship",
  },
  {
    screen: "Version Sync",
    label: "Version Sync",
    href: "/versionsync",
    icon: <VersionSyncIcon className="ico" />,
    feature: "version_sync",
    group: "Ship",
  },
  {
    screen: "Drift",
    label: "Drift",
    href: "/drift",
    icon: <DriftIcon className="ico" />,
    feature: "drift",
    group: "Watch",
  },
  {
    screen: "Performance",
    label: "Performance",
    href: "/performance",
    icon: <GaugeIcon className="ico" />,
    feature: "performance",
    group: "Watch",
  },
  {
    // The History page asks for drift:read itself, so the menu asks the same.
    screen: "History",
    label: "History",
    href: "/history",
    icon: <ClockIcon className="ico" />,
    feature: "drift",
    group: "Watch",
  },
  {
    screen: "Requests",
    label: "Requests",
    href: "/requests",
    icon: <InboxIcon className="ico" />,
    group: "People",
  },
  {
    screen: "Admin",
    label: "Admin",
    href: "/admin",
    icon: <UsersIcon className="ico" />,
    feature: ["users", "roles", "organization", "github"],
    group: "People",
  },
];

export type NavSection<T extends NavItem = NavItem> = {
  /** The heading over these rows, or null for the rows that stand alone on top. */
  group: NavGroup | null;
  items: T[];
};

/**
 * The menu's rows under their headings, in NAV_GROUPS order. A group with no
 * rows left (the role can open none of them) is dropped, heading and all.
 */
export function groupNavItems<T extends NavItem>(items: T[]): NavSection<T>[] {
  const sections: NavSection<T>[] = [];
  const alone = items.filter((item) => item.group === undefined);
  if (alone.length > 0) sections.push({ group: null, items: alone });
  for (const group of NAV_GROUPS) {
    const rows = items.filter((item) => item.group === group);
    if (rows.length > 0) sections.push({ group, items: rows });
  }
  return sections;
}

/**
 * Pick the nav item whose route matches the current path (falls back to
 * Dashboard). The organization at the front of the path is set aside first,
 * so "/acme/drift" is Drift, the same as the old address "/drift".
 */
export function activeNavItem(pathname: string): NavItem {
  const route = routeOf(pathname);
  const match = NAV_ITEMS.find(
    (item) => route === item.href || route.startsWith(item.href + "/")
  );
  return match ?? NAV_ITEMS[0];
}

/** The path with the organization at its front set aside: "/acme/drift" is "/drift". */
function routeOf(pathname: string): string {
  const slug = orgSlugFromPath(pathname);
  return slug === null ? pathname : pathname.slice(slug.length + 1);
}

/** What the shell shows for the current path. */
export type ActiveScreen = {
  /** The page's name, the last part of the breadcrumb. */
  screen: string;
  /** The address of the rail row to light up. */
  href: string;
  /** The page's menu group, the first part of the breadcrumb ("Watch › Drift"). */
  group?: NavGroup;
};

/**
 * What the shell shows for the current path: the names in the breadcrumb and
 * the address of the rail row to light up.
 */
export function activeScreen(pathname: string): ActiveScreen {
  const item = activeNavItem(pathname);
  return { screen: item.screen, href: item.href, group: item.group };
}

/**
 * Whether the path really is one of the app's named pages. activeScreen falls
 * back to Dashboard for an address it does not know; this says when it did
 * not have to.
 */
export function isKnownScreen(pathname: string): boolean {
  const route = routeOf(pathname);
  const { href } = activeScreen(pathname);
  return route === href || route.startsWith(href + "/");
}
