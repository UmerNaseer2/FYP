/** @jest-environment jsdom */

/**
 * The app tour's words and rules (lib/tour.ts): when it is offered, what it
 * remembers, which stops each role sees, and the choices on the last card.
 *
 * What is NOT here: drawing the cards and moving between pages. That is
 * components/studio/AppTour.tsx, checked in the browser.
 */

import { readFileSync, readdirSync } from "fs";
import path from "path";
import type { PermissionKey } from "@/lib/permissions";
import {
  START_TOUR_EVENT,
  readTourMemory,
  readTourParam,
  startTour,
  stopCountWords,
  tourPicks,
  tourStops,
  trialCompareHref,
  withoutTourParam,
  writeTourMemory,
  type TourAudience,
} from "@/lib/tour";

// Every page on the rail, as an Admin sees it.
const ALL_PAGES = ["/studio", "/connections", "/compare", "/script-editor", "/deploy", "/versionsync", "/drift", "/requests"];

const ADMIN: PermissionKey[] = ["connections:create", "deploy:run", "approvals:create", "approvals:approve"];
const EDITOR: PermissionKey[] = ["deploy:run", "approvals:create"];
const VIEWER: PermissionKey[] = [];

function allows(keys: PermissionKey[]) {
  return (key: PermissionKey) => keys.includes(key);
}

function stops(audience: TourAudience, keys: PermissionKey[], pages = ALL_PAGES, askAi = false) {
  return tourStops({ audience, can: allows(keys), pages, askAi });
}

const ids = (list: { id: string }[]) => list.map((item) => item.id);

afterEach(() => window.localStorage.clear());

describe("the ?tour= address", () => {
  test("names one of the three doors", () => {
    expect(readTourParam("?tour=trial")).toBe("trial");
    expect(readTourParam("?tour=new")).toBe("new");
    expect(readTourParam("?tour=member&x=1")).toBe("member");
  });

  test("anything else names none", () => {
    expect(readTourParam("")).toBeNull();
    expect(readTourParam("?tour=")).toBeNull();
    expect(readTourParam("?tour=admin")).toBeNull();
    expect(readTourParam("?other=trial")).toBeNull();
  });

  test("is taken out of the address, keeping the rest", () => {
    expect(withoutTourParam("?tour=trial")).toBe("");
    expect(withoutTourParam("?tour=new&connection=4")).toBe("?connection=4");
    expect(withoutTourParam("")).toBe("");
  });
});

describe("what the browser remembers", () => {
  test("nothing, at first", () => {
    expect(readTourMemory("acme", "admin")).toEqual({ done: false, resume: null });
  });

  test("reads back what was written, per organization and role", () => {
    writeTourMemory("trial", "editor", { done: false, resume: 4 });
    expect(readTourMemory("trial", "editor")).toEqual({ done: false, resume: 4 });
    expect(readTourMemory("trial", "viewer")).toEqual({ done: false, resume: null });
    expect(readTourMemory("acme", "editor")).toEqual({ done: false, resume: null });
  });

  test("reads broken or odd saved values as nothing", () => {
    window.localStorage.setItem("schema-studio:tour:acme:admin", "{not json");
    expect(readTourMemory("acme", "admin")).toEqual({ done: false, resume: null });
    window.localStorage.setItem("schema-studio:tour:acme:admin", JSON.stringify({ done: "yes", resume: -2 }));
    expect(readTourMemory("acme", "admin")).toEqual({ done: false, resume: null });
  });

  test("blocked storage reads as nothing and writing does not throw", () => {
    const get = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      expect(readTourMemory("acme", "admin")).toEqual({ done: false, resume: null });
      expect(() => writeTourMemory("acme", "admin", { done: true, resume: null })).not.toThrow();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});

test("startTour sends the event AppTour listens for", () => {
  const heard = jest.fn();
  window.addEventListener(START_TOUR_EVENT, heard);
  try {
    startTour();
    expect(heard).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener(START_TOUR_EVENT, heard);
  }
});

describe("the stops", () => {
  test("follow the work, with Catch up only in the trial", () => {
    expect(ids(stops("trial", EDITOR))).toEqual(["home", "connect", "compare", "script", "ship", "sync", "watch", "ask", "help"]);
    expect(ids(stops("new", ADMIN))).toEqual(["home", "connect", "compare", "script", "ship", "watch", "ask", "help"]);
    expect(ids(stops("member", VIEWER))).toEqual(["home", "connect", "compare", "script", "ship", "watch", "ask", "help"]);
  });

  test("say something true on an empty Dashboard and Drift page, like the trial's at first", () => {
    const list = stops("trial", EDITOR);
    const home = list.find((stop) => stop.id === "home")!;
    const watch = list.find((stop) => stop.id === "watch")!;
    expect(home.empty?.target).toBe(".sk-first");
    expect(home.empty?.body).toContain("Nothing is tracked yet");
    expect(watch.empty?.target).toBe(".dr-untracked .text-center");
    expect(watch.empty?.body).toContain("Nothing is tracked yet");
  });

  test("leave out a page the role cannot open, but keep the top bar", () => {
    const list = stops("member", VIEWER, ["/studio", "/compare", "/drift"]);
    expect(ids(list)).toEqual(["home", "compare", "watch", "help"]);
  });

  test("in the trial, name the demo's own schemas and say connections are locked", () => {
    const list = stops("trial", EDITOR);
    const text = (id: string) => list.find((stop) => stop.id === id)!.body;
    expect(text("connect")).toContain("University demo");
    expect(text("connect")).toContain("locked");
    expect(text("compare")).toContain("students_dev");
    expect(text("sync")).toContain("1.0.0");
    expect(text("sync")).toContain("1.2.0");
  });

  test("tell a role that may not run so, and one that may how it works", () => {
    const ship = (keys: PermissionKey[]) => stops("member", keys).find((stop) => stop.id === "ship")!.body;
    expect(ship(VIEWER)).toContain("not start one");
    expect(ship(EDITOR)).toContain("dry run");
    expect(ship(EDITOR)).not.toContain("not start one");
  });

  test("say who answers requests and who asks", () => {
    const ask = (keys: PermissionKey[]) => stops("member", keys).find((stop) => stop.id === "ask")!.title;
    expect(ask(ADMIN)).toBe("Your team asks, you answer");
    expect(ask(EDITOR)).toBe("When your role says no, ask");
    expect(ask(VIEWER)).toBe("Ask for the rest");
  });

  test("only mention Ask AI when it is switched on", () => {
    const help = (askAi: boolean) => stops("member", EDITOR, ALL_PAGES, askAi).find((stop) => stop.id === "help")!;
    expect(help(true).body).toContain("Ask AI");
    expect(help(false).body).not.toContain("Ask AI");
    expect(help(false).title).toBe("Stuck? Two ways out");
  });

  test("never talk about environment labels or a second person", () => {
    const every = [...stops("trial", ADMIN), ...stops("new", ADMIN), ...stops("member", VIEWER, ALL_PAGES, true)];
    for (const stop of every) {
      expect(`${stop.title} ${stop.body}`).not.toMatch(/two-person|second person|risk tick|Production label/i);
    }
  });

  test("light up parts that exist on the page they stand on", () => {
    // The first, most specific target of each stop, found in that page's
    // source; the top bar's in StudioTopbar. A renamed class fails here
    // instead of a card quietly pointing at nothing.
    const studio = path.join(__dirname, "..", "app", "[org]", "(studio)");
    const sources = (dir: string) =>
      readdirSync(dir)
        .filter((name) => name.endsWith(".tsx"))
        .map((name) => readFileSync(path.join(dir, name), "utf8"))
        .join("\n");
    for (const stop of stops("trial", ADMIN)) {
      const source =
        stop.page === null
          ? readFileSync(path.join(__dirname, "..", "components", "studio", "StudioTopbar.tsx"), "utf8")
          : sources(path.join(studio, stop.page.slice(1)));
      const classNames = [stop.targets[0], ...(stop.empty ? [stop.empty.target] : [])].map((target) => target.split(" ")[0].slice(1));
      for (const className of classNames) {
        expect(source).toMatch(new RegExp(`className=[^>]*?(?<![\\w-])${className}(?![\\w-])`));
      }
      if (stop.empty) expect(stop.targets).toContain(stop.empty.target);
    }
  });
});

describe("the last card", () => {
  test("in the trial, offers the demo compare and Version Sync", () => {
    expect(ids(tourPicks("trial", allows(EDITOR), ALL_PAGES))).toEqual(["compare", "sync", "look"]);
  });

  test("for a new organization, starts with adding a database", () => {
    expect(ids(tourPicks("new", allows(ADMIN), ALL_PAGES))).toEqual(["connect", "compare", "look"]);
  });

  test("for someone who joined, starts with a compare", () => {
    expect(ids(tourPicks("member", allows(ADMIN), ALL_PAGES))).toEqual(["compare", "connect", "look"]);
    expect(ids(tourPicks("member", allows(VIEWER), ALL_PAGES))).toEqual(["compare", "look"]);
  });

  test("leaves out a page the role cannot open", () => {
    expect(ids(tourPicks("trial", allows(VIEWER), ["/studio", "/compare"]))).toEqual(["compare", "look"]);
  });

  test("the trial compare runs students_dev against students_prod", () => {
    expect(trialCompareHref(null)).toBe("/compare");
    const query = new URLSearchParams(trialCompareHref(7).split("?")[1]);
    expect(query.get("sourceConnection")).toBe("7");
    expect(query.get("sourceSchema")).toBe("students_dev");
    expect(query.get("targetConnection")).toBe("7");
    expect(query.get("targetSchema")).toBe("students_prod");
    expect(query.get("run")).toBe("1");
  });
});

test("the stop count reads as words", () => {
  expect(stopCountWords(1)).toBe("One stop");
  expect(stopCountWords(8)).toBe("Eight stops");
  expect(stopCountWords(12)).toBe("12 stops");
});
