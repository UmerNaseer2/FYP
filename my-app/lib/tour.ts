// The app tour: a short walk through the studio's pages, one card at a time,
// with the part of the page it talks about lit up. components/studio/AppTour
// draws it. This file holds what it says and the rules for when it is offered,
// with no React in it, so the tests can read it directly.
//
// When it is offered: right after someone arrives by one of three doors, each
// of which adds `?tour=` to the first studio address it opens.
//
//   - trial:  the landing page's "Try it" (app/api/trial/route.ts)
//   - new:    making a new organization (components/onboarding/OnboardingPage)
//   - member: joining one by invite (components/invite/InvitePage)
//
// It is offered once. Finishing it, or skipping it, is remembered in this
// browser, and "Take the tour" in the account menu starts it again any time.

import type { PermissionKey } from "@/lib/permissions";

/** Who the tour is for. It changes a few of the words and the last card. */
export type TourAudience = "trial" | "new" | "member";

/** The query parameter the three doors add: /acme/studio?tour=new. */
export const TOUR_PARAM = "tour";

/** The window event "Take the tour" sends. AppTour listens for it. */
export const START_TOUR_EVENT = "schema-studio:start-tour";

/** Starts the tour, from the account menu, the command bar or the trial bar. */
export function startTour(): void {
  window.dispatchEvent(new Event(START_TOUR_EVENT));
}

/** The audience a `?tour=` value names, or null when it names none. */
export function readTourParam(search: string): TourAudience | null {
  const value = new URLSearchParams(search).get(TOUR_PARAM);
  if (value === "trial" || value === "new" || value === "member") return value;
  return null;
}

/** The same query string with `tour` taken out, for history.replaceState. */
export function withoutTourParam(search: string): string {
  const query = new URLSearchParams(search);
  query.delete(TOUR_PARAM);
  const rest = query.toString();
  return rest ? `?${rest}` : "";
}

// ---------------------------------------------------------------- memory

/**
 * What this browser remembers about the tour, per organization and role, so
 * trying the trial as an Admin and then as a Viewer offers it to each.
 *
 *   - done:   finished or skipped, so it is not offered again
 *   - resume: the stop it was closed at, for "Resume the tour"; null for none
 */
export type TourMemory = { done: boolean; resume: number | null };

const NOTHING_REMEMBERED: TourMemory = { done: false, resume: null };

function memoryKey(orgSlug: string, role: string): string {
  return `schema-studio:tour:${orgSlug}:${role}`;
}

/** Reads what was remembered. Storage that is blocked or broken reads as nothing. */
export function readTourMemory(orgSlug: string, role: string): TourMemory {
  try {
    const saved = window.localStorage.getItem(memoryKey(orgSlug, role));
    if (!saved) return NOTHING_REMEMBERED;
    const parsed = JSON.parse(saved) as Partial<TourMemory>;
    return {
      done: parsed.done === true,
      resume: typeof parsed.resume === "number" && parsed.resume > 0 ? parsed.resume : null,
    };
  } catch {
    return NOTHING_REMEMBERED;
  }
}

/** Remembers it. When storage is blocked the tour still works, it is just offered again. */
export function writeTourMemory(orgSlug: string, role: string, memory: TourMemory): void {
  try {
    window.localStorage.setItem(memoryKey(orgSlug, role), JSON.stringify(memory));
  } catch {
    // Nothing to do: see above.
  }
}

// ---------------------------------------------------------------- the stops

/** The small drawing at the top of each card (AppTour has the shapes). */
export type TourIcon = "home" | "connect" | "compare" | "script" | "ship" | "sync" | "watch" | "ask" | "help";

export type TourStop = {
  id: string;
  /** The page it stands on, without the organization ("/compare"); null for the top bar. */
  page: string | null;
  icon: TourIcon;
  /** The one word beside the icon. */
  kicker: string;
  title: string;
  body: string;
  /** What to light up. The first one on screen wins, or all of them with `union`. */
  targets: string[];
  union?: boolean;
  /**
   * What the card says instead when the page shows its first-run card in place
   * of the real thing (an empty Dashboard: the trial tracks nothing at first).
   * `target` is that card, and it must also be in `targets`.
   */
  empty?: { target: string; body: string };
};

export type TourInput = {
  audience: TourAudience;
  /** useUser's can, so a custom role gets the words its permissions call for. */
  can: (key: PermissionKey) => boolean;
  /** The pages on this person's rail, without the organization ("/compare"). */
  pages: readonly string[];
  /** Whether Ask AI is switched on, so the last stop only names what is there. */
  askAi: boolean;
};

/**
 * The stops, in the order the work happens: look, connect, compare, write,
 * ship, catch up, watch, ask. A stop whose page this person's role cannot open
 * is left out, so the tour never walks into "your role can't".
 *
 * The words follow the help notes (lib/help), so the tour and the Help panel
 * never disagree. In the trial they name the demo's own schemas.
 */
export function tourStops({ audience, can, pages, askAi }: TourInput): TourStop[] {
  const trial = audience === "trial";
  const mayAddDatabases = can("connections:create");
  const mayRun = can("deploy:run");
  const stops: TourStop[] = [];

  stops.push({
    id: "home",
    page: "/studio",
    icon: "home",
    kicker: "Home",
    title: "Start here, every time",
    body:
      "Every schema your team tracks is drawn here as a building, and its roof colour is how its last drift check went. Press a building to read about it.",
    targets: [".sk-stage", ".sk-first", ".sk-page .page-header"],
    empty: {
      target: ".sk-first",
      body:
        "Nothing is tracked yet, so for now it shows the first steps. Once a schema is tracked it is drawn here as a building, and its roof colour is how its last drift check went.",
    },
  });

  stops.push({
    id: "connect",
    page: "/connections",
    icon: "connect",
    kicker: "Connect",
    title: trial ? "Already connected for you" : audience === "new" ? "Add your databases once" : "Your team's databases",
    body: trial
      ? "University demo is set up with three students schemas and two courses schemas. Connections are locked in the trial, so the demo stays the same for everyone."
      : mayAddDatabases
        ? "Save a database here once and everyone in the organization can use it. The password is stored encrypted and never sent back to the browser."
        : "Every database your team has saved is listed here, ready to compare. Passwords are stored encrypted and never shown to anyone.",
    targets: [".cn-group-block", ".cn-page .page-header"],
  });

  stops.push({
    id: "compare",
    page: "/compare",
    icon: "compare",
    kicker: "Compare",
    title: "See exactly what differs",
    body: trial
      ? "Pick the schema that looks right, then the one to update. Here, students_dev has a grades table and two student columns that students_prod lacks. Comparing changes nothing, and you get the script that closes the gap."
      : "Pick the schema that looks right, then the one to update. Comparing changes nothing: you get every difference and a script that closes the gap, ready to edit.",
    targets: [".cp-form", ".cp-page .page-header"],
  });

  stops.push({
    id: "script",
    page: "/script-editor",
    icon: "script",
    kicker: "Script",
    title: "Save it as a numbered version",
    body:
      "Or write a migration by hand, with the rollback that undoes it, and save it as the next version. Nothing runs from this page.",
    targets: [".se-line", ".se-card", ".se-page .page-header"],
  });

  stops.push({
    id: "ship",
    page: "/deploy",
    icon: "ship",
    kicker: "Ship",
    title: "Rehearse first, then ship",
    body: mayRun
      ? "A dry run rehearses a saved version and keeps nothing. A real run is one transaction, so every migration in it lands or none do, and you can undo it after."
      : "Runs happen here: a dry run first, then the real one, all or nothing, with undo after. Your role can see every run but not start one.",
    targets: [".dp-stage", ".dp-card", ".dp-page .page-header"],
  });

  // Only in the trial, where the demo has a schema behind on purpose.
  if (trial) {
    stops.push({
      id: "sync",
      page: "/versionsync",
      icon: "sync",
      kicker: "Catch up",
      title: "Bring a schema up to date",
      body:
        "students_prod is at version 1.0.0 and students_dev at 1.2.0. Version Sync shows the two versions prod is missing and replays them in order, with a dry run first.",
      targets: [".vs-pick", ".vs-page .page-header"],
    });
  }

  stops.push({
    id: "watch",
    page: "/drift",
    icon: "watch",
    kicker: "Watch",
    title: "Catch changes nobody told you about",
    body:
      "If someone changes a database by hand, outside this app, it shows up here. For each change you decide: put it back, or accept it.",
    targets: [".dr-watch", ".dr-untracked .text-center", ".dr-page .page-header"],
    empty: {
      // The words in the middle of the empty card, so this card can sit beside them.
      target: ".dr-untracked .text-center",
      body:
        "Nothing is tracked yet, so this page waits for now. Once a schema is tracked, any change made to it by hand, outside this app, shows up here, and you decide: put it back, or accept it.",
    },
  });

  stops.push(askStop(can, mayRun));

  stops.push({
    id: "help",
    page: null,
    icon: "help",
    kicker: "Help",
    title: askAi ? "Stuck? Three ways out" : "Stuck? Two ways out",
    body: askAi
      ? "Search jumps to any page. Ask AI answers questions about your schemas in plain words. Help explains the page you are on."
      : "Search jumps to any page, and Help explains the page you are on.",
    targets: [".ck-b", ".top-actions"],
    union: true,
  });

  return stops.filter((stop) => stop.page === null || pages.includes(stop.page));
}

/** The Requests stop, which says something different to whoever answers and whoever asks. */
function askStop(can: TourInput["can"], mayRun: boolean): TourStop {
  const base = { id: "ask", page: "/requests", icon: "ask" as const, kicker: "Ask", targets: [".rq-main", ".rq-page .page-header"] };
  if (can("approvals:approve")) {
    return {
      ...base,
      title: "Your team asks, you answer",
      body: "When someone needs something their role does not allow, the request lands here. Read what they asked for, then say yes or no.",
    };
  }
  if (can("approvals:create")) {
    return {
      ...base,
      title: "When your role says no, ask",
      body: "If your role does not allow something, ask for it here. An Admin answers, and you see the answer on this page.",
    };
  }
  return {
    ...base,
    title: "Ask for the rest",
    body: mayRun
      ? "Anything you ask for, and anything waiting on you, shows up here."
      : "Your role lets you look around without changing anything. Anything you ask for, and anything waiting on you, shows up here.",
  };
}

/** "Eight stops", for the welcome card. */
export function stopCountWords(count: number): string {
  const words = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  const word = words[count] ?? String(count);
  return `${word} ${count === 1 ? "stop" : "stops"}`;
}

// ---------------------------------------------------------------- the last card

export type TourPick = {
  id: string;
  title: string;
  hint: string;
  /** Where it goes, without the organization; null to stay on the Dashboard. */
  page: string | null;
};

/** The trial's demo connection, by the name lib/trial-sandbox.ts gives it. */
export const TRIAL_CONNECTION_NAME = "University demo";

/**
 * The address of a compare of students_dev (the one that looks right) with
 * students_prod (the one to update), run straight away. Without the
 * connection's ID it is plain Compare.
 */
export function trialCompareHref(connectionId: number | null): string {
  if (connectionId === null) return "/compare";
  const query = new URLSearchParams({
    sourceConnection: String(connectionId),
    sourceSchema: "students_dev",
    targetConnection: String(connectionId),
    targetSchema: "students_prod",
    run: "1",
  });
  return `/compare?${query.toString()}`;
}

/** The choices on the last card, best first. */
export function tourPicks(audience: TourAudience, can: TourInput["can"], pages: readonly string[]): TourPick[] {
  const compare: TourPick = { id: "compare", title: "Run your first compare", hint: "Pick two schemas and see what differs.", page: "/compare" };
  const addDatabase: TourPick = {
    id: "connect",
    title: audience === "new" ? "Add your first database" : "Add a database",
    hint: "Connect one of your own.",
    page: "/connections",
  };
  const lookAround: TourPick = { id: "look", title: "Just look around", hint: "Stay on the Dashboard.", page: null };

  let picks: TourPick[];
  if (audience === "trial") {
    picks = [
      { ...compare, hint: "students_dev against students_prod, ready to go." },
      { id: "sync", title: "See what students_prod is missing", hint: "Version Sync, from 1.0.0 up to 1.2.0.", page: "/versionsync" },
      lookAround,
    ];
  } else {
    const mayAdd = can("connections:create");
    picks = audience === "new" && mayAdd ? [addDatabase, compare, lookAround] : [compare, ...(mayAdd ? [addDatabase] : []), lookAround];
  }
  return picks.filter((pick) => pick.page === null || pages.includes(pick.page));
}
