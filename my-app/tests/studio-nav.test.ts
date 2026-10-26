/**
 * The rail's manifest: which screens exist, in which order, and which one the
 * address bar currently belongs to.
 *
 * NAV_ITEMS is the only list of screens in the app, so it decides what somebody
 * opening this for the first time sees and in what order they see it. The order
 * is not incidental — the comment above it says it is the order the work
 * happens in — and a list nobody checks drifts quietly: a route gets added
 * under app/ and never appears in the rail, or an href is renamed and the link
 * still looks right while leading to a 404.
 *
 * activeNavItem is read twice on every page load, once for the highlighted row
 * and once for the breadcrumb, so a wrong answer is wrong in two places at
 * once. Its fallback is the part worth pinning down: it never returns
 * undefined, which means an unknown path is quietly reported as the dashboard
 * rather than leaving the shell with nothing to render.
 *
 * No DOM here. This is the data behind the rail, not the rail.
 *
 * What is NOT here:
 *  - The rail that renders this list:
 *    tests/component-studio-sidebar.test.tsx.
 *  - Filtering the rows against what the session's role may read, and the
 *    wiring of activeNavItem into the breadcrumb. Both belong to the shell:
 *    tests/component-studio-shell.test.tsx. What is here is the data that
 *    filtering reads: which feature each row belongs to.
 *  - What each screen does once you are on it. Those are the
 *    tests/page-*.test.tsx suites, one per route.
 */

import path from "path";
import { existsSync } from "fs";

import { NAV_ITEMS, activeNavItem, type NavItem } from "@/components/studio/nav";
import {
  FEATURES,
  isAdminOnly,
  presetFor,
  readKeyOf,
  type FeatureKey,
} from "@/lib/permissions";

const ROOT = path.join(__dirname, "..");

/** A row's features as a list, the way the shell reads them. */
function featuresOf(item: NavItem): FeatureKey[] {
  return Array.isArray(item.feature) ? item.feature : [item.feature];
}

describe("the list of screens", () => {
  test("reads top to bottom as the order the work happens in", () => {
    expect(NAV_ITEMS.map((item) => item.screen)).toEqual([
      "Dashboard",
      "Compare & Author",
      "Script Editor",
      "Deploy",
      "Version Sync",
      "Drift",
      "Performance",
      "Visualizer",
      "Connections",
      "Admin",
    ]);
  });

  test("gives every screen a route of its own", () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  test("gives every screen a name of its own", () => {
    const screens = NAV_ITEMS.map((item) => item.screen);
    expect(new Set(screens).size).toBe(screens.length);
  });

  test("names and illustrates every row, so none renders as a bare icon", () => {
    for (const item of NAV_ITEMS) {
      expect({ href: item.href, labelled: item.label.length > 0 }).toEqual({
        href: item.href,
        labelled: true,
      });
      expect({ href: item.href, named: item.screen.length > 0 }).toEqual({
        href: item.href,
        named: true,
      });
      expect({ href: item.href, drawn: Boolean(item.icon) }).toEqual({
        href: item.href,
        drawn: true,
      });
    }
  });

  test("points every row at a page that exists", () => {
    // A row in the rail is the main way into a screen, so an href with no page
    // behind it is a 404 that looks like a working button. The routes live
    // under app/[org]/(studio): the organization's slug goes in front of the
    // href when the rail draws it, and the (studio) group is a layout folder
    // that is not part of the URL.
    for (const item of NAV_ITEMS) {
      const page = path.join(ROOT, "app", "[org]", "(studio)", item.href, "page.tsx");
      expect({ href: item.href, hasPage: existsSync(page) }).toEqual({
        href: item.href,
        hasPage: true,
      });
    }
  });

  test("writes every route without a trailing slash", () => {
    // activeNavItem builds its child-route test by appending "/" to the href.
    // A trailing slash already in the list would make that "//" and stop every
    // page below that screen from matching it.
    for (const item of NAV_ITEMS) {
      expect({ href: item.href, clean: !item.href.endsWith("/") }).toEqual({
        href: item.href,
        clean: true,
      });
    }
  });

  test("gives every row a feature the permission catalogue knows", () => {
    // A row is shown when the role may Read its feature. A feature missing
    // from lib/permissions has no Read box anywhere, so its row would be
    // hidden from every role, admin included, and nothing would say why.
    const known = new Set<string>(FEATURES.map((feature) => feature.key));
    for (const item of NAV_ITEMS) {
      for (const feature of featuresOf(item)) {
        expect({ href: item.href, feature, known: known.has(feature) }).toEqual({
          href: item.href,
          feature,
          known: true,
        });
      }
    }
  });

  test("keeps Admin the only row with anything admin-only on it", () => {
    // Roles & permissions and Organization are admin-only, and both live on
    // the Admin screen. Another role reaches that screen only through a
    // Users box an Admin ticked for it.
    const withAdminOnly = NAV_ITEMS.filter((item) =>
      featuresOf(item).some((feature) => isAdminOnly(readKeyOf(feature)))
    );
    expect(withAdminOnly.map((item) => item.screen)).toEqual(["Admin"]);
    expect(featuresOf(NAV_ITEMS.find((item) => item.screen === "Admin")!)).toEqual([
      "users",
      "roles",
      "organization",
    ]);
  });

  test("shows a new install's viewer every row except Admin", () => {
    // What the Viewer role's description promises on the Admin screen, and
    // what the rail showed a viewer before roles became editable.
    const viewer = presetFor("viewer") ?? [];
    const shown = NAV_ITEMS.filter((item) =>
      featuresOf(item).some((feature) => viewer.includes(readKeyOf(feature)))
    );
    expect(shown.map((item) => item.screen)).toEqual(
      NAV_ITEMS.map((item) => item.screen).filter((screen) => screen !== "Admin")
    );
  });
});

describe("deciding which screen you are on", () => {
  test("matches a screen's own route", () => {
    expect(activeNavItem("/drift").screen).toBe("Drift");
  });

  test("keeps the section lit on a page underneath it", () => {
    expect(activeNavItem("/compare/142").screen).toBe("Compare & Author");
  });

  test("keeps it lit however deep that page is", () => {
    expect(activeNavItem("/performance/targets/7/queries").screen).toBe("Performance");
  });

  test("needs a whole segment, not merely a matching prefix", () => {
    // "/deployments" begins with "/deploy" as text but is not a page under it.
    // Counting that as a match would light the wrong row for any future route
    // whose name happens to start with the name of an existing one — which is
    // why the test is here before such a route exists rather than after.
    expect(activeNavItem("/deployments").screen).toBe("Dashboard");
  });

  test("falls back to the dashboard for a page with no row of its own", () => {
    // /schemas/12 is a real screen, reached from the dashboard, and it has no
    // rail entry — so the breadcrumb above it reads Dashboard rather than
    // blank. Recorded here because it is a visible consequence of the
    // fallback rather than an accident of it.
    expect(activeNavItem("/schemas/12").screen).toBe("Dashboard");
  });

  test("falls back for the site root, which is not a screen", () => {
    expect(activeNavItem("/").screen).toBe("Dashboard");
  });

  test("still answers when the path is empty, so the breadcrumb is never blank", () => {
    expect(activeNavItem("").screen).toBe("Dashboard");
  });

  test("reads past the organization at the front of the address", () => {
    expect(activeNavItem("/acme/drift").screen).toBe("Drift");
    expect(activeNavItem("/acme/compare/142").screen).toBe("Compare & Author");
    // The organization's own address forwards to its dashboard, so for the
    // moment before it does, Dashboard is the right row.
    expect(activeNavItem("/acme").screen).toBe("Dashboard");
  });

  test("never takes a screen's name for an organization", () => {
    // The screens' names are kept back from organizations (lib/org-slug.ts),
    // so "/drift/..." is the drift screen and not an organization named drift.
    expect(activeNavItem("/drift/acme").screen).toBe("Drift");
  });

  test("answers with a row out of the list, not a copy of one", () => {
    // The shell holds the answer next to its own filtered copy of the list.
    // An object rebuilt here would satisfy every check above and break that.
    expect(NAV_ITEMS).toContain(activeNavItem("/deploy"));
  });
});
