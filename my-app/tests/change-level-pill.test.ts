// One change level, one colour, on every screen.
//
// Version Sync, Deploy, the schema page and the Script Editor each coloured a
// change level their own way: patch was green on the schema page, blue in the
// Script Editor and grey on Deploy, and additive was green in the Script
// Editor. None of that matched the version timeline's dots, which sit on the
// same screens. Now every screen draws ChangeLevelPill, or takes its tone from
// CHANGE_LEVEL_PILL, and this file pins that pill's colour to the timeline
// dot's, both read from app/globals.css itself.
import { readFileSync } from "fs";
import path from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangeLevelPill } from "@/components/studio/ChangeLevelPill";
import { CHANGE_LEVEL_PILL, changeLevelWord, type ChangeLevel } from "@/lib/change-level";

const ROOT = path.join(__dirname, "..");
const css = readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");

/**
 * The colour variable one CSS rule gives one property, such as "--break" for
 * `.pill-break { color:var(--break) }`. Null when the rule or the property is
 * not there, or the property is not a var().
 */
function cssVar(selector: string, property: "background" | "color"): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The rule has to start its own line, so ".x .pill-break {" is not read as ".pill-break {".
  const rule = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!rule) return null;
  // [;\s] before the name, so "border-color" is not read as "color".
  const value = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*var\\((--[\\w-]+)\\)`).exec(rule[1]);
  return value ? value[1] : null;
}

function render(level: ChangeLevel): string {
  return renderToStaticMarkup(createElement(ChangeLevelPill, { level }));
}

/** The colour variable a rendered pill's dot is painted with, or null when it has no dot. */
function dotVar(level: ChangeLevel): string | null {
  const html = render(level);
  const dot = /<span class="dot"(?: style="([^"]*)")?/.exec(html);
  if (!dot) return null;
  // An inline background wins over the class rule. Pill gives neutral dots one.
  const inline = dot[1] ? /background:\s*var\((--[\w-]+)\)/.exec(dot[1]) : null;
  if (inline) return inline[1];
  // Otherwise the dot is currentColor (checked below): the pill's own colour.
  const tone = /class="pill pill-([\w-]+)/.exec(html);
  return tone ? cssVar(`.pill-${tone[1]}`, "color") : null;
}

describe("ChangeLevelPill", () => {
  it("paints a dot in its pill's own colour unless told otherwise", () => {
    // dotVar relies on this rule for every tone without an inline dot colour.
    expect(css).toMatch(/\n\.pill \.dot\s*\{[^}]*background:\s*currentColor/);
  });

  it.each(["breaking", "additive", "patch"] as const)("gives %s the colour of its timeline dot", (level) => {
    const timeline = cssVar(`.vtl__dot.lvl-${level}`, "background");
    expect(timeline).not.toBeNull();
    expect(dotVar(level)).toBe(timeline);
  });

  it("uses red for breaking, blue for additive and grey for patch", () => {
    // Pinned by name too, so a change to the timeline cannot quietly move both.
    expect(dotVar("breaking")).toBe("--break");
    expect(dotVar("additive")).toBe("--pending");
    expect(dotVar("patch")).toBe("--text-3");
  });

  it("never colours a level green, the colour of applied and in sync", () => {
    for (const level of Object.keys(CHANGE_LEVEL_PILL) as ChangeLevel[]) {
      expect(CHANGE_LEVEL_PILL[level].tone).not.toBe("sync");
    }
  });

  it("prints each level's word", () => {
    expect(render("breaking")).toContain(">breaking</span>");
    expect(render("additive")).toContain(">additive</span>");
    expect(render("patch")).toContain(">patch</span>");
  });

  it("says a level nobody recorded is not recorded, with no dot to mistake for patch", () => {
    const html = render("unknown");
    expect(html).toContain(">level not recorded</span>");
    expect(dotVar("unknown")).toBeNull();
    // The timeline draws that one's dot in the plain border colour: no level rule.
    expect(cssVar(".vtl__dot.lvl-unknown", "background")).toBeNull();
  });
});

describe("changeLevelWord", () => {
  it("reads a stored change type the way the pill and the timeline dot do", () => {
    // Old ledger rows say major / minor; the lists print the level, not the raw text.
    expect(changeLevelWord("major")).toBe("breaking");
    expect(changeLevelWord("minor")).toBe("additive");
    expect(changeLevelWord("patch")).toBe("patch");
    expect(changeLevelWord("Breaking")).toBe("breaking");
    expect(changeLevelWord("")).toBe("level not recorded");
    expect(changeLevelWord(null)).toBe("level not recorded");
  });
});

describe("the screens that show a change level", () => {
  // These are client pages with data fetching, which do not render under
  // jest's node environment, so this reads their source: each one takes the
  // level's colour from the one table rather than a map of its own.
  it.each([
    "app/(studio)/versionsync/page.tsx",
    "app/(studio)/deploy/page.tsx",
    "app/(studio)/schemas/[id]/page.tsx",
    "app/(studio)/script-editor/page.tsx",
    "components/studio/DiffReport.tsx",
  ])("%s draws levels from CHANGE_LEVEL_PILL", (file) => {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    // A real use, not just the import: an import left behind by a screen
    // that went back to its own colours would satisfy a plain name match.
    const body = source.replace(/^import[^;]*;/gm, "");
    expect(body).toMatch(/<ChangeLevelPill\b|CHANGE_LEVEL_PILL\[/);
    // No colour picked from a level word on the spot (a ternary such as
    // `level === "breaking" ? "pill-break" : …`), and none of the maps the
    // screens used to keep, in any form.
    expect(source).not.toMatch(
      /(===|!==)\s*"(breaking|additive|patch|major|minor)"[^;]{0,120}?pill-(sync|pending|break|neutral)/
    );
    expect(source).not.toMatch(/\b(kindPill|levelMeta|changeTone)\b/);
  });
});
