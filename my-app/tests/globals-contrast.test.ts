// Text colours in app/globals.css against the backgrounds they sit on.
//
// jsdom applies no stylesheet, so nothing here can look at a screen. What it
// can do is read the colour tokens of both themes out of the file and work out
// the WCAG contrast ratio of each pair, the way a contrast checker does.
// Normal-size text needs 4.5:1 (WCAG 1.4.3). A reviewer measured the muted
// text, the dark theme's primary buttons and the light theme's green badges
// well under that.
//
// The last part reads the phone rules at the end of the file: text under 12px
// and tap targets under 24px are lifted on a narrow screen.
import { readFileSync } from "fs";
import path from "path";

const css = readFileSync(path.join(__dirname, "..", "app", "globals.css"), "utf8");

/** The colour tokens of one theme, such as { "--text-3": "#6b6b74" }. */
function tokens(theme: "light" | "dark"): Record<string, string> {
  const block = new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  const found: Record<string, string> = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    found[match[1]] = match[2];
  }
  return found;
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

/** Relative luminance, as WCAG defines it. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** A colour painted over a background at part strength, such as a 12% tint. */
function over(colour: string, background: string, strength: number): string {
  const top = channels(colour);
  const under = channels(background);
  return (
    "#" +
    top
      .map((value, i) => Math.round(value * strength + under[i] * (1 - strength)))
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** The declarations of the one rule whose selector starts its own line. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

const SURFACES = ["--bg", "--surface", "--surface-2", "--surface-3"];
const TINTS = [
  "--brand-soft",
  "--sync-soft",
  "--pending-soft",
  "--drift-soft",
  "--break-soft",
  "--diff-add-bg",
  "--diff-rem-bg",
  "--diff-chg-bg",
];

describe.each(["light", "dark"] as const)("text contrast in the %s theme", (theme) => {
  const t = tokens(theme);

  /** Every pair that is under 4.5:1, as "text on background = ratio". */
  function tooFaint(texts: string[], backgrounds: string[]): string[] {
    const failures: string[] = [];
    for (const text of texts) {
      for (const background of backgrounds) {
        const ratio = contrast(t[text], t[background]);
        if (ratio < 4.5) failures.push(`${text} on ${background} = ${ratio.toFixed(2)}`);
      }
    }
    return failures;
  }

  it("reads the tokens it is about to check", () => {
    for (const name of [...SURFACES, ...TINTS, "--text", "--text-2", "--text-3", "--text-inv"]) {
      expect(t[name]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("keeps body, secondary and muted text at 4.5:1 on every surface and tint", () => {
    expect(tooFaint(["--text", "--text-2", "--text-3"], [...SURFACES, ...TINTS])).toEqual([]);
  });

  it("keeps each status colour at 4.5:1 on the surfaces and on its own tint", () => {
    expect(tooFaint(["--brand"], [...SURFACES, "--brand-soft"])).toEqual([]);
    expect(tooFaint(["--sync"], [...SURFACES, "--sync-soft", "--diff-add-bg"])).toEqual([]);
    expect(tooFaint(["--pending"], [...SURFACES, "--pending-soft"])).toEqual([]);
    expect(tooFaint(["--drift"], [...SURFACES, "--drift-soft", "--diff-chg-bg"])).toEqual([]);
    expect(tooFaint(["--break"], [...SURFACES, "--break-soft", "--diff-rem-bg"])).toEqual([]);
  });

  it("keeps the + and - chips readable: a status colour on a 12% tint of itself", () => {
    // .delta-add, .delta-rem and .delta-chg paint the colour over the page at
    // 12% and write in the same colour.
    for (const name of ["--sync", "--break", "--drift"]) {
      for (const surface of ["--bg", "--surface", "--surface-2"]) {
        const chip = over(t[name], t[surface], 0.12);
        expect(contrast(t[name], chip)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps text on a coloured fill at 4.5:1 (buttons, step circles)", () => {
    for (const fill of ["--brand", "--sync", "--drift", "--break"]) {
      expect(contrast(t["--text-inv"], t[fill])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the dark ink on the orange go button at 4.5:1", () => {
    expect(t["--accent"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrast(t["--on-accent"], t["--accent"])).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the ink on a solid ink pill (the page you are on) at 4.5:1", () => {
    expect(contrast(t["--on-pill"], t["--pill"])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("rules that decide a text colour", () => {
  it("writes on a coloured button in a theme colour made for that fill, not a fixed white", () => {
    expect(rule(".btn-primary")).toMatch(/[;\s]color:var\(--on-accent\)/);
    expect(rule(".btn-destructive")).toMatch(/[;\s]color:var\(--text-inv\)/);
  });

  it("writes the nav badge's number in the status colour on its own tint", () => {
    const badge = rule(".nav-item .badge");
    expect(badge).toMatch(/background:var\(--drift-soft\)/);
    expect(badge).toMatch(/[;\s]color:var\(--drift\)/);
  });

  it("gives a field's placeholder the muted text colour at full strength", () => {
    const placeholder = rule(".input::placeholder");
    expect(placeholder).toMatch(/color:var\(--text-3\)/);
    expect(placeholder).toMatch(/opacity:1/);
  });

  it("does not fade the zeros or the sub-headings of the summary table", () => {
    expect(rule(".matrix .is-zero")).not.toMatch(/opacity/);
    expect(rule(".matrix th .sub")).not.toMatch(/opacity/);
  });
});

describe("the phone rules", () => {
  // The last block of the file that starts with this comment's first words.
  const start = css.indexOf("Phones: nothing too small to read or to tap");
  const phone = css.slice(start);

  it("are there, and only apply to a narrow screen", () => {
    expect(start).toBeGreaterThan(-1);
    expect(phone).toMatch(/@media \(max-width: 640px\)/);
  });

  it("lift the stylesheet's own small text, and the small Tailwind sizes, to 12px", () => {
    for (const selector of [".pill", ".help", ".section-title", ".picker .kind", ".matrix th"]) {
      expect(phone).toContain(selector);
    }
    expect(phone).toMatch(/\.plan-node-caption \{ font-size:12px; \}/);
    expect(phone).toMatch(
      /\.text-\\\[10px\\\], \.text-\\\[10\\\.5px\\\], \.text-\\\[11px\\\], \.text-\\\[11\\\.5px\\\] \{ font-size:12px; \}/
    );
  });

  it("make fields 16px, so iOS does not zoom the page on focus", () => {
    expect(phone).toMatch(/\.input \{ font-size:16px; \}/);
  });

  it("make the bare pickers, the text button and plain checkboxes big enough to tap", () => {
    expect(phone).toMatch(/\.ds-select__trigger \{ min-height:28px; \}/);
    expect(phone).toMatch(/input\[type="checkbox"\], input\[type="radio"\]\) \{ width:24px; height:24px; \}/);
  });
});
