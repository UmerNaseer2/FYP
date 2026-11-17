/**
 * The one status system. A tracked schema is always in one of four states,
 * and each state has its own word, its own shape and its own colour, so it
 * reads the same on the Dashboard, on Drift, in History and in the pickers.
 *
 * Rules (from the design review):
 * 1. Orange means act. It is for buttons and focus only, never a state.
 * 2. Never colour alone. Every state has a shape and a word as well.
 * 3. One status line per card: the state, who found it, when, how often.
 * 4. Same state, same look. Use StatusChip (components/ui/StatusChip) or the
 *    CSS classes in app/styles/atelier-system.css, never a one-off colour.
 *
 * The colours are CSS variables, set per theme in atelier-system.css:
 *   --st-<tone>-ink   text and glyph colour
 *   --st-<tone>-bg    chip fill
 *   --st-<tone>-roof  the fill of a building roof on the Dashboard city
 */

export type StatusKey = "in_sync" | "drifted" | "unreachable" | "unchecked";

export type StatusLook = {
  key: StatusKey;
  /** The word shown on chips, rows and legends. */
  label: string;
  /** The CSS tone name used in the --st-<tone>-* variables and .st--<tone>. */
  tone: "sync" | "drift" | "down" | "new";
  /** One line saying when the state applies, for legends and help. */
  meaning: string;
  /** The glyph's SVG children, drawn on a 24 by 24 grid with a stroke. */
  glyph: "check" | "wave" | "alert" | "dashed";
};

export const STATUS_LOOK: Record<StatusKey, StatusLook> = {
  in_sync: {
    key: "in_sync",
    label: "In sync",
    tone: "sync",
    meaning: "The live schema matches its last saved version.",
    glyph: "check",
  },
  drifted: {
    key: "drifted",
    label: "Drifted",
    tone: "drift",
    meaning: "Someone changed the schema outside a deploy.",
    glyph: "wave",
  },
  unreachable: {
    key: "unreachable",
    label: "Can't be reached",
    tone: "down",
    meaning: "The last check could not connect.",
    glyph: "alert",
  },
  unchecked: {
    key: "unchecked",
    label: "Not checked yet",
    tone: "new",
    meaning: "Tracked, but no check has run yet.",
    glyph: "dashed",
  },
};

/** The four states in the order legends list them. */
export const STATUS_ORDER: StatusKey[] = ["in_sync", "drifted", "unreachable", "unchecked"];

/**
 * Turn whatever a screen holds into one of the four states. The drift tables
 * use "in_sync" | "drifted" | "unreachable"; no check yet is null or undefined.
 * A few older screens say "error", "failed" or "never"; those map here too.
 */
export function statusKeyOf(raw: string | null | undefined): StatusKey {
  switch ((raw ?? "").toLowerCase()) {
    case "in_sync":
    case "insync":
    case "in-sync":
    case "synced":
    case "ok":
      return "in_sync";
    case "drifted":
    case "drift":
      return "drifted";
    case "unreachable":
    case "error":
    case "failed":
    case "down":
      return "unreachable";
    default:
      return "unchecked";
  }
}

export function statusLook(raw: string | null | undefined): StatusLook {
  return STATUS_LOOK[statusKeyOf(raw)];
}

/** The CSS variable for a state's colour, for SVG fills: statusVar("drifted", "roof"). */
export function statusVar(raw: string | null | undefined, part: "ink" | "bg" | "roof"): string {
  return `var(--st-${statusLook(raw).tone}-${part})`;
}
