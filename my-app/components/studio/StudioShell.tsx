"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { useOrg, useOrgHref } from "@/hooks/useOrg";
import { useRequestCounts } from "@/hooks/useRequestCounts";
import { useTheme } from "@/hooks/useTheme";
import { signOutEverywhere } from "@/lib/sign-out";
import { Drawer } from "@/components/ui";
import { BellIcon, ClockIcon, MoonIcon, PhoneIcon, SunIcon } from "@/components/ui/icons";
import { ADMIN_ROLE, DEFAULT_ROLE, presetFor, readKeyOf } from "@/lib/permissions";
import { StudioSidebar, type StudioUser } from "./StudioSidebar";
import { HelpButton, HelpProvider, useHelp } from "@/components/help/HelpPanel";
import { StudioTopbar } from "./StudioTopbar";
import { SchemaChatButton } from "./SchemaChat";
import { OrgSwitcher } from "./OrgSwitcher";
import { ViewAsSwitcher } from "./ViewAsSwitcher";
import { AccountMenu } from "./AccountMenu";
import { CommandBar } from "./CommandBar";
import { useAiFeature } from "./AiPanel";
import LogoIntro from "./LogoIntro";
import { AppTour } from "./AppTour";
import { TrialBar } from "./TrialBar";
import { NAV_ITEMS, activeScreen, type NavItem } from "./nav";

// What the rail offers while it cannot ask what the role may do: what a new
// Viewer can read.
const VIEWER_READS: readonly string[] = presetFor(DEFAULT_ROLE) ?? [];

// Shown when no one is signed in.
const SIGNED_OUT_USER: StudioUser = {
  name: "Guest",
  email: "Not signed in",
  initials: "?",
};

/** Build a display identity from the NextAuth session. */
function toStudioUser(authUser: ReturnType<typeof useUser>["user"]): StudioUser {
  if (!authUser) return SIGNED_OUT_USER;
  const name = authUser.name || authUser.email || "Signed in";
  const email = authUser.email ?? "";
  const initials = name.slice(0, 2).toUpperCase();
  return { name, email, initials };
}

type StudioShellProps = {
  children: ReactNode;
  /** Optional explicit identity override; defaults to the live session. */
  user?: StudioUser;
};

/**
 * The frame every studio page lives inside: the floating rail on the left
 * (the drawer on a phone), the top bar with the search pill, Ask AI, Help,
 * Needs you, the theme and the account menu, the command bar (Ctrl K or
 * Cmd K) and the logo intro.
 */
export function StudioShell({ children, user }: StudioShellProps) {
  const pathname = usePathname();
  const { user: authUser, role, roleLabel, bypass, loading, can, accessError, notMember } =
    useUser();
  const { theme, toggleTheme } = useTheme();
  const orgPath = useOrgHref();
  const org = useOrg();
  const orgName = org?.name ?? null;
  const [collapsed, setCollapsed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const waitingRequests = useRequestCounts(
    !notMember && !loading && !accessError && !!authUser,
    pathname
  );

  // Mobile: the sidebar leaves the grid and becomes an off-canvas drawer.
  // `matchMedia` (not a one-shot innerWidth read) so rotation/resize is handled,
  // and a mounted guard keeps SSR markup stable (always desktop on the server).
  const [isMobile, setIsMobile] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  // Close the drawer whenever the route changes (tapping a nav item navigates).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMobileNavOpen(false);
  }, [pathname]);

  // Ctrl K (Cmd K on a Mac) opens the command bar from anywhere, and closes
  // it again. The browser's own Ctrl K (search the web) is not wanted here.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      event.preventDefault();
      setCommandOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Real identity from the NextAuth session; honest signed-out state otherwise.
  const studioUser = useMemo(() => user ?? toStudioUser(authUser), [user, authUser]);

  // A screen is on the rail when the role may Read its feature, the same
  // question its AuthGuard asks, so nothing here opens onto "your role can't".
  // The screens and the API still check for themselves, so this is
  // presentation, not the security line.
  //
  // Until that is known (still loading, nobody signed in, or the database did
  // not answer) the rail shows the screens a new Viewer gets, which is every
  // screen but Admin, as it always did. An empty rail would look broken, and
  // each screen still says for itself whether it will open.
  //
  // Someone who is not a member gets an empty rail, on purpose: every screen
  // would only repeat the guard's "not a member", and the way out (Sign out)
  // is in the rail's footer, not among its rows.
  //
  // Each row then gets the organization on the front of its address, so the
  // rail never takes someone out of the organization they are working in.
  const navItems = useMemo(
    () =>
      NAV_ITEMS.filter((item) => {
        if (notMember) return false;
        if (item.feature === undefined) return true;
        const features = Array.isArray(item.feature) ? item.feature : [item.feature];
        const [first, ...rest] = features.map(readKeyOf);
        if (loading || accessError || !authUser) {
          return [first, ...rest].some((key) => VIEWER_READS.includes(key));
        }
        return can(first, ...rest);
      }).map((item) => ({
        ...item,
        href: orgPath(item.href),
        badge: item.href === "/requests" ? waitingRequests : undefined,
      })),
    [notMember, loading, accessError, authUser, can, orgPath, waitingRequests],
  );

  // Whether the account menu may name the role. See AccountMenu below.
  const roleKnown = authUser !== null && !loading && !accessError && !notMember;

  // The rail's pages without the organization ("/compare"), so the tour only
  // walks into pages this person's role can open.
  const tourPages = useMemo(
    () => NAV_ITEMS.map((item) => item.href).filter((href) => navItems.some((item) => item.href === orgPath(href))),
    [navItems, orgPath],
  );

  const active = activeScreen(pathname);

  const sidebar = (
    <StudioSidebar
      items={navItems}
      activeHref={orgPath(active.href)}
      // In the mobile drawer the sidebar is always expanded; its collapse chevron
      // closes the drawer instead (chevron-left = "tuck the panel away").
      collapsed={isMobile ? false : collapsed}
      onToggleCollapse={
        isMobile ? () => setMobileNavOpen(false) : () => setCollapsed((c) => !c)
      }
      bypass={bypass}
      // The View as picker, only while the bypass is on. With real sign-in a
      // person is their role and nothing else.
      viewAs={bypass ? <ViewAsSwitcher /> : undefined}
      // Which organization this is, and the others this person belongs to.
      // Drawn on every server; it hides itself when there is nothing to pick.
      orgSwitcher={<OrgSwitcher />}
      className={isMobile ? "side-in-drawer" : ""}
    />
  );

  // Where "Your requests" and the Needs you button go. Not for someone who is
  // not a member (there is nothing of theirs to see) or nobody signed in.
  const requestsHref = !notMember && authUser ? orgPath("/requests") : undefined;
  // The two pages only the account menu (and the command bar) lead to: what
  // you did lately (History) and your phone and desktop links (Devices).
  const activityHref = !notMember && authUser ? orgPath("/history") : undefined;
  const devicesHref = !notMember && authUser ? orgPath("/devices") : undefined;
  const commandPages: NavItem[] = [
    ...navItems,
    ...(activityHref
      ? [{ screen: "Your activity", label: "Your activity", href: activityHref, icon: <ClockIcon size={16} /> }]
      : []),
    ...(devicesHref
      ? [{ screen: "Phone and desktop", label: "Phone and desktop", href: devicesHref, icon: <PhoneIcon size={16} /> }]
      : []),
  ];
  const signOut = () => void signOutEverywhere();

  // The round buttons at the right end of the top bar. Ask AI first (it only
  // shows where AI is switched on), then Help, which every page has.
  const topActions = (
    <>
      <SchemaChatButton />
      <HelpButton className="tb" />
      {roleKnown && requestsHref && (
        <Link
          href={requestsHref}
          className={`tb ny ${waitingRequests > 0 ? "ny-hot" : ""}`}
          title={
            waitingRequests > 0
              ? `${waitingRequests} ${waitingRequests === 1 ? "request is" : "requests are"} waiting on you`
              : "Nothing is waiting on you"
          }
        >
          <BellIcon size={15} />
          <span className="ny-t">Needs you</span>
          <em>
            {waitingRequests}
            <span className="sr-only"> waiting</span>
          </em>
        </Link>
      )}
      <button
        type="button"
        className="tb"
        onClick={toggleTheme}
        aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      >
        {theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      </button>
      <AccountMenu
        user={studioUser}
        // Straight from useUser, never from the `user` override above: what
        // the server will actually allow is not something a display identity
        // gets to change.
        //
        // Withheld while nobody is signed in, while the role is still being
        // looked up, when the app could not look it up, and from someone who
        // is not a member. useUser reports DEFAULT_ROLE for all four. That is
        // a sensible floor for code asking "may I", and a lie on screen, where
        // a "Viewer" under "Not signed in" would read as a role somebody holds.
        role={roleKnown ? role : undefined}
        roleLabel={roleKnown ? roleLabel : undefined}
        orgName={orgName}
        requestsHref={requestsHref}
        activityHref={activityHref}
        devicesHref={devicesHref}
        onSignOut={signOut}
      />
    </>
  );

  return (
    // HelpProvider holds the Help panel, so the top bar's Help button and the
    // one in each page's header open the same panel.
    <HelpProvider>
    <div
      className="studio grid"
      style={{
        gridTemplateColumns: isMobile ? "1fr" : collapsed ? "64px 1fr" : "240px 1fr",
        height: isMobile ? "100dvh" : "100vh",
      }}
    >
      {/*
        The first thing Tab reaches. Without it a keyboard user presses Tab
        about fifteen times, through the whole sidebar, before the page itself,
        and again after every navigation. It is hidden until it has focus
        (.skip-link in globals.css); pressing it puts focus on <main>.
      */}
      <a
        href="#main-content"
        className="skip-link no-print"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>

      {/* Desktop: sidebar is the first grid column. Mobile: it lives in the drawer. */}
      {!isMobile && sidebar}

      {/*
        min-h-0 is what makes <main> the thing that scrolls. Without it this
        column grows to the height of the page inside it, the grid grows with
        it, and the whole window scrolls instead: the sidebar scrolls away
        with the page, and its footer (the organization, View as) ends up
        below the bottom of the screen on any long page.

        relative keeps absolutely placed things inside it, such as the text
        hidden for screen readers. Without it they are placed against the
        window, not this column, so one far down a long page makes the window
        taller and the whole shell can scroll up, leaving an empty band below.
      */}
      <div className="flex flex-col min-w-0 min-h-0">
        <StudioTopbar
          breadcrumbScreen={active.screen}
          showMenu={isMobile}
          onMenuClick={() => setMobileNavOpen(true)}
          onOpenCommand={() => setCommandOpen(true)}
          action={topActions}
        />
        {org?.trial && <TrialBar isAdmin={roleKnown && role === ADMIN_ROLE} />}
        {/* tabIndex -1: the skip link can put focus here, Tab never stops on it. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="relative flex-1 min-h-0 overflow-y-auto"
          style={{ background: "var(--bg)" }}
        >
          {children}
        </main>
      </div>

      {isMobile && (
        <Drawer
          open={mobileNavOpen}
          onClose={() => setMobileNavOpen(false)}
          side="left"
          bare
          label="Main navigation"
          width="min(280px, 85vw)"
        >
          {sidebar}
        </Drawer>
      )}
    </div>
    {commandOpen && (
      <ShellCommandBar
        onClose={() => setCommandOpen(false)}
        pages={commandPages}
        activeHref={orgPath(active.href)}
        waiting={roleKnown ? waitingRequests : 0}
        requestsHref={requestsHref}
        theme={theme}
        onToggleTheme={toggleTheme}
        onSignOut={signOut}
      />
    )}
    <LogoIntro />
    <AppTour
      pages={tourPages}
      roleKnown={roleKnown}
      role={role}
      roleLabel={roleLabel}
      can={can}
      isAdmin={roleKnown && role === ADMIN_ROLE}
    />
    </HelpProvider>
  );
}

type ShellCommandBarProps = {
  onClose: () => void;
  pages: NavItem[];
  activeHref: string;
  waiting: number;
  requestsHref?: string;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onSignOut: () => void;
};

/**
 * The command bar with the two things only the inside of HelpProvider can
 * know: how to open Help, and whether Ask AI is switched on. Drawn only while
 * the bar is open, so the AI check waits until someone opens it.
 */
function ShellCommandBar(props: ShellCommandBarProps) {
  const help = useHelp();
  const askAi = useAiFeature("schema-chat") === true;
  return <CommandBar open {...props} onHelp={help?.open} askAi={askAi} />;
}