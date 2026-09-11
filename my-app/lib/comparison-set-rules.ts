// ---------------------------------------------------------------------------
// comparison-set-rules.ts
// The rules for saved comparison sets that need no database: what a save
// request may carry, when it is valid, whether the screen still matches the
// set it was opened from, and how a set is named in the picker.
//
// Split out of lib/comparison-sets.ts, which opens the metadata pool, so these
// can be unit-tested and so the Compare screen's browser code uses the same
// functions as the server.
// ---------------------------------------------------------------------------

/**
 * How many targets one set (and one comparison) may hold.
 *
 * Here rather than on the Compare page because the API validates against it
 * too, and a limit the screen enforces but the endpoint does not is not a limit.
 */
export const MAX_COMPARISON_TARGETS = 6;

/** Longest set name we store. Long enough to be descriptive, short enough to fit a dropdown. */
export const MAX_NAME_LENGTH = 60;

/** Longest connection label kept with a set — a name, not an essay. */
const MAX_LABEL_LENGTH = 200;

/** One save request, after parseSaveBody has made it safe to read. */
export type SaveComparisonSetInput = {
  /**
   * The set that was open when Save was pressed, or null. Saving under a name
   * that belongs to a DIFFERENT set is a conflict the user has to confirm;
   * saving over the set that is open is simply an update.
   */
  id: number | null;
  /** True once the user has confirmed replacing that other set. */
  overwrite: boolean;
  name: string;
  /** Null when the source has no saved connection — validation refuses it. */
  sourceConnectionId: number | null;
  sourceConnectionLabel: string;
  sourceSchema: string;
  allowDataLoss: boolean;
  compareData: boolean;
  targets: { connectionId: number | null; connectionLabel: string; schema: string }[];
};

/** A positive whole number, or null for anything else — 0, "", true and 3.5 included. */
function toId(value: unknown): number | null {
  const id =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

function toText(value: unknown, max = Infinity): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Read a save request's JSON body without trusting any of it.
 *
 * Never fails: anything missing or of the wrong type becomes "", null or
 * false, and validateSaveInput then says which part is missing in words the
 * person who pressed Save can act on. Rejecting here instead answered a
 * target with no connection with a generic "Bad request".
 */
export function parseSaveBody(body: unknown): SaveComparisonSetInput {
  const raw = toRecord(body);
  const targets = Array.isArray(raw.targets) ? raw.targets : [];
  return {
    id: toId(raw.id),
    overwrite: raw.overwrite === true,
    name: toText(raw.name),
    sourceConnectionId: toId(raw.sourceConnectionId),
    sourceConnectionLabel: toText(raw.sourceConnectionLabel, MAX_LABEL_LENGTH),
    sourceSchema: toText(raw.sourceSchema),
    allowDataLoss: raw.allowDataLoss === true,
    compareData: raw.compareData === true,
    targets: targets.map((value) => {
      const target = toRecord(value);
      return {
        connectionId: toId(target.connectionId),
        connectionLabel: toText(target.connectionLabel, MAX_LABEL_LENGTH),
        schema: toText(target.schema),
      };
    }),
  };
}

/**
 * Why this set cannot be saved, as a sentence naming the part to fix — or null
 * when it can.
 *
 * Checked before anything is written, so the person gets "Target 2 has no
 * connection" rather than a constraint violation. The last two rules stop a
 * set that could never produce a useful result: a target that IS the source
 * compares a schema with itself, and a repeated target is compared once and
 * then skipped on every run.
 */
export function validateSaveInput(input: SaveComparisonSetInput): string | null {
  const name = input.name.trim();
  if (name.length === 0) return "Give the set a name so you can find it again.";
  if (name.length > MAX_NAME_LENGTH) {
    return `Set names are limited to ${MAX_NAME_LENGTH} characters.`;
  }
  if (input.sourceConnectionId === null) {
    return "The source has no connection — pick one before saving.";
  }
  const sourceSchema = input.sourceSchema.trim();
  if (sourceSchema.length === 0) return "The source schema is missing.";
  if (input.targets.length === 0) return "A set needs at least one target.";
  if (input.targets.length > MAX_COMPARISON_TARGETS) {
    return `A set can hold at most ${MAX_COMPARISON_TARGETS} targets.`;
  }

  const firstSeen = new Map<string, number>();
  for (const [index, target] of input.targets.entries()) {
    const number = index + 1;
    if (target.connectionId === null) {
      return `Target ${number} has no connection — pick one before saving.`;
    }
    const schema = target.schema.trim();
    if (schema.length === 0) return `Target ${number} has no schema selected.`;
    if (target.connectionId === input.sourceConnectionId && schema === sourceSchema) {
      return `Target ${number} is the same connection and schema as the source.`;
    }
    const key = `${target.connectionId}|${schema}`;
    const earlier = firstSeen.get(key);
    if (earlier !== undefined) {
      return `Targets ${earlier + 1} and ${number} are the same connection and schema.`;
    }
    firstSeen.set(key, index);
  }
  return null;
}

/** The parts of a selection that decide what a comparison reads and writes. */
type SelectionShape = {
  sourceConnectionId: number | null;
  sourceSchema: string;
  allowDataLoss: boolean;
  compareData: boolean;
  targets: { connectionId: number | null; schema: string }[];
};

/**
 * Does the selection on screen still match the set it was opened from?
 *
 * Decides whether to say "changed since it was saved", and whether a run
 * counts as running the set — only then is its "last run" time stamped. Order
 * matters: a set is an ordered list, and swapping two targets swaps which
 * migration appears first. Both run options count too, because the same
 * schemas compared with row data are a different comparison.
 */
export function matchesSet(set: SelectionShape, selection: SelectionShape): boolean {
  return (
    set.sourceConnectionId === selection.sourceConnectionId &&
    set.sourceSchema === selection.sourceSchema &&
    set.allowDataLoss === selection.allowDataLoss &&
    set.compareData === selection.compareData &&
    set.targets.length === selection.targets.length &&
    set.targets.every(
      (target, index) =>
        target.connectionId === selection.targets[index].connectionId &&
        target.schema === selection.targets[index].schema,
    )
  );
}

/**
 * What the Save button says, so it matches what pressing it will do.
 *
 * With a set open, the same name (ignoring case and spaces, as the database
 * does) updates that set, and a different name saves a new one beside it.
 */
export function saveButtonLabel(
  activeName: string | null,
  typedName: string,
): "Save" | "Update" | "Save as new" {
  const typed = typedName.trim().toLowerCase();
  if (activeName === null || typed.length === 0) return "Save";
  return activeName.trim().toLowerCase() === typed ? "Update" : "Save as new";
}

/**
 * Would this save replace a set the user did not have open?
 *
 * `existingId` is the set that already has the name, if any. Replacing the
 * set that is open is an ordinary update; replacing any other needs the
 * user's say-so first.
 */
export function isNameConflict(
  existingId: number | null,
  inputId: number | null,
  overwrite: boolean,
): boolean {
  return existingId !== null && existingId !== inputId && !overwrite;
}

/**
 * A set's line in the "Open a saved set" picker.
 *
 * Everything worth knowing before opening it: how many targets, whether one is
 * production, whether it reads row data, whether a connection it used is gone,
 * and when it last ran. `ranAgoText` is passed in because it depends on the
 * current time, which keeps this function testable.
 */
export function setOptionLabel(
  option: {
    name: string;
    targetCount: number;
    hasProduction: boolean;
    compareData: boolean;
    hasMissingConnection: boolean;
  },
  ranAgoText: string,
): string {
  const parts = [
    option.name,
    `${option.targetCount} target${option.targetCount === 1 ? "" : "s"}`,
  ];
  if (option.hasProduction) parts.push("prod");
  if (option.compareData) parts.push("row data");
  if (option.hasMissingConnection) parts.push("connection deleted");
  parts.push(ranAgoText);
  return parts.join(" · ");
}
