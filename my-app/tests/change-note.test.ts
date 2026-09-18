// The change log a script carries.
//
// Spec feature 7: "Include change logs with user notes (or auto generated)."
//
// The note used to go only into the GitHub commit message, which is the one
// place it could not be read back from — the registry is read through the
// contents API, which returns files and not history. So a pulled script came
// back with no note, Deploy had nothing to send, and script_patch.description
// was NULL on every version deployed the ordinary way.
//
// Putting the note in the file is what fixes that, and the round trip is the
// thing worth pinning: what comes back has to be what went in, a restamp must
// not pile up blank lines, and a line that merely looks like the header must
// not be able to become the change log.
import {
  CHANGE_NOTE_HEADER_KEY,
  MAX_CHANGE_NOTE_LENGTH,
  changeNoteSummary,
  readChangeNote,
  stampChangeNote,
} from "@/lib/change-note";
import { readChangeTypeHeader, stampChangeType } from "@/lib/change-type";
import { readAppliesToHeader } from "@/lib/application-targeting";

const SQL = "ALTER TABLE orders ADD COLUMN invoice_no text;";

describe("the round trip", () => {
  it("reads back exactly what was stamped", () => {
    const note = "Adds the invoice number finance reconcile against.";
    expect(readChangeNote(stampChangeNote(SQL, note))).toBe(note);
  });

  it("keeps a note's own line breaks, including the blank ones", () => {
    // A note is written in paragraphs often enough that collapsing it to one
    // line would quietly rewrite what somebody typed.
    const note = "Adds invoice_no.\n\nFinance asked for it in ticket 412.";
    expect(readChangeNote(stampChangeNote(SQL, note))).toBe(note);
  });

  it("does not mistake a comment for the note, or the note for SQL", () => {
    const stamped = stampChangeNote(SQL, "Adds invoice_no.");
    // Every added line is a comment, so the file is still the same SQL.
    for (const line of stamped.split("\n")) {
      if (line.includes(CHANGE_NOTE_HEADER_KEY)) expect(line.trim().startsWith("--")).toBe(true);
    }
    expect(stamped).toContain(SQL);
  });

  it("is null for a script that carries no note", () => {
    expect(readChangeNote(SQL)).toBeNull();
    expect(readChangeNote("")).toBeNull();
    // A header key with nothing after it is not a note either — an author who
    // typed nothing and a file that says nothing are the same fact.
    expect(readChangeNote(`-- ${CHANGE_NOTE_HEADER_KEY}:\n${SQL}`)).toBeNull();
  });

  it("ignores a line of the same shape once the SQL has started", () => {
    // Otherwise a comment inside the body — or one inside a string literal —
    // could rewrite the change log of a version that is already deployed.
    const sql = `${SQL}\n-- ${CHANGE_NOTE_HEADER_KEY}: not the change log`;
    expect(readChangeNote(sql)).toBeNull();
  });
});

describe("restamping", () => {
  it("replaces the old note instead of leaving both", () => {
    const once = stampChangeNote(SQL, "First try.");
    const twice = stampChangeNote(once, "What it actually does.");
    expect(readChangeNote(twice)).toBe("What it actually does.");
    expect(twice).not.toContain("First try.");
  });

  it("does not grow the file every time it is stamped", () => {
    // The blank line a note sits in is added on every stamp and has to be
    // taken off again, or a family pushed five times carries five blank lines
    // above its SQL.
    const once = stampChangeNote(SQL, "A note.");
    expect(stampChangeNote(once, "A note.")).toBe(once);
    expect(stampChangeNote(stampChangeNote(once, "Other."), "A note.")).toBe(once);
  });

  it("takes the note out when the field was cleared", () => {
    // "No note means leave what is there" would make deleting a note do
    // nothing at all, so a note somebody removed on purpose would keep
    // travelling with the file.
    const cleared = stampChangeNote(stampChangeNote(SQL, "Wrong note."), null);
    expect(readChangeNote(cleared)).toBeNull();
    expect(cleared).not.toContain("Wrong note.");
    expect(cleared.trim()).toBe(SQL);
  });

  it("never lets a note run longer than the push screens allow", () => {
    // The screens cap what can be typed, but a file can arrive from anywhere.
    const long = "x".repeat(MAX_CHANGE_NOTE_LENGTH + 500);
    const back = readChangeNote(stampChangeNote(SQL, long)) ?? "";
    expect(back.length).toBe(MAX_CHANGE_NOTE_LENGTH);
  });
});

describe("living beside the other headers", () => {
  it("leaves the stamps the app reads by machine alone", () => {
    // A note is prose and the other two headers are decisions. Burying
    // Change-type under three lines of prose, or worse displacing it, would
    // change which version bump a script gets.
    const withHeaders = `-- ${"Change-type"}: additive\n-- Applies-to: billing\n${SQL}`;
    const stamped = stampChangeNote(withHeaders, "Adds invoice_no.");
    expect(readChangeTypeHeader(stamped)).toBe("additive");
    expect(readAppliesToHeader(stamped)).toEqual(["billing"]);
    expect(readChangeNote(stamped)).toBe("Adds invoice_no.");
  });

  it("survives the order the push route stamps in", () => {
    // The route stamps the level first and the note second, which is the only
    // order that leaves the level on the first line where a reader expects it.
    const stamped = stampChangeNote(stampChangeType(SQL, "breaking"), "Drops the old column.");
    expect(stamped.split("\n")[0]).toContain("Change-type: breaking");
    expect(readChangeNote(stamped)).toBe("Drops the old column.");
  });

  it("does not start the file on an empty line when there is no header", () => {
    expect(stampChangeNote(SQL, "A note.").startsWith("--")).toBe(true);
  });
});

describe("changeNoteSummary", () => {
  it("is the note itself when it is one line", () => {
    expect(changeNoteSummary("Adds invoice_no.")).toBe("Adds invoice_no.");
  });

  it("says out loud that a longer note has more to it", () => {
    // A row that quietly showed the first sentence of three would read as the
    // whole change log.
    const summary = changeNoteSummary("Adds invoice_no.\nFinance asked for it.") ?? "";
    expect(summary).toContain("Adds invoice_no.");
    expect(summary).not.toContain("Finance asked for it.");
    expect(summary).toContain("…");
  });

  it("is null rather than an empty row for a note that says nothing", () => {
    expect(changeNoteSummary(null)).toBeNull();
    expect(changeNoteSummary("")).toBeNull();
    expect(changeNoteSummary("\n  \n")).toBeNull();
  });
});
