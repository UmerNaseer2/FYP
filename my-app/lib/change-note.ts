// The change log a script carries: the author's note about why the version
// exists, kept in the script's own header.
//
// Spec feature 7: "Include change logs with user notes (or auto generated)."
//
// The note used to be typed on the push screens and sent to GitHub as the
// commit message, and that was the end of it. A commit message is the one place
// the note could NOT be read back from: the registry is read through the
// contents API, which returns files, not history, so a pulled script came back
// without it. Deploy therefore had nothing to record, and script_patch's
// description column — which exists precisely for this — was NULL on every
// version that was deployed the ordinary way. The note was written by a person,
// shown to nobody, and stored nowhere.
//
// So the note is stamped into the file, exactly the way lib/change-type.ts
// stamps the level and for the same reasons: it is inert SQL wherever the file
// ends up, it travels with the file through GitHub, and reading it never
// depends on the prose around it. The commit message is still written — it is
// what makes a GitHub history readable — but it is no longer the only copy.
//
// One key per line rather than one line holding the whole note. A note is a
// sentence or three, and a 1000-character comment on a single line is unusable
// in every editor that opens it. Repeating the key keeps every line a valid
// comment, keeps the round trip exact including blank lines, and means nothing
// has to escape a newline into a form that survives base64 and back.
//
// Pure on purpose — no DB, no fetch, no React — because the push routes, the
// deploy screen and the Script Editor all need the same answer and cannot
// share a runtime.

/**
 * The header key a script carries its change log under.
 *
 * "Note" rather than "Description" because that is what the thing is: a line
 * written for the next person who opens the file.
 */
export const CHANGE_NOTE_HEADER_KEY = "Note";

const HEADER_PATTERN = new RegExp(`^\\s*--\\s*${CHANGE_NOTE_HEADER_KEY}\\s*:(.*)$`, "i");

/**
 * How much of a note is kept in the file. The same limit the push routes
 * enforce on what is typed, named here as well so a note that was somehow
 * stored longer — by an older build, or by hand — cannot make a header run for
 * pages.
 */
export const MAX_CHANGE_NOTE_LENGTH = 1000;

/**
 * The note read back out of a script, or null when it carries none.
 *
 * Only the header is read — the lines before the first statement — so a line of
 * the same shape inside the SQL cannot become the change log. The lines are
 * joined back with newlines, so what comes out is what went in.
 *
 * A header whose lines are all empty gives null, not "": an author who typed
 * nothing and a file that says nothing are the same fact, and every caller
 * treats null as "no note".
 */
export function readChangeNote(sql: string): string | null {
  const collected: string[] = [];
  for (const line of (sql ?? "").split(/\r?\n/)) {
    const match = line.match(HEADER_PATTERN);
    if (match) {
      // One leading space is the separator this module writes, not part of the
      // note. Any further indentation the author added is theirs and is kept.
      collected.push(match[1].replace(/^ /, "").trimEnd());
      continue;
    }
    // Past the header: anything that is neither blank nor a comment is body.
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("--")) break;
  }
  const note = collected.join("\n").trim();
  return note === "" ? null : note;
}

/**
 * The one line of a note that fits on a timeline row, or null when there is
 * nothing to show.
 *
 * A note is allowed several lines and a screen row is one, so the rest is not
 * dropped — it stays in the script's header, which the same screens show when
 * the row is opened. The ellipsis is what says so: a row that quietly showed
 * the first sentence of three would read as the whole note.
 */
export function changeNoteSummary(note: string | null | undefined): string | null {
  const lines = (note ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return null;
  return lines.length > 1 ? `${lines[0]} …` : lines[0];
}

/** The header lines a note becomes. Exported for the tests and for stamping. */
export function changeNoteHeaderLines(note: string): string[] {
  return note
    .slice(0, MAX_CHANGE_NOTE_LENGTH)
    .split(/\r?\n/)
    .map((line) => `-- ${CHANGE_NOTE_HEADER_KEY}:${line.trimEnd() === "" ? "" : ` ${line.trimEnd()}`}`);
}

/**
 * Put the author's note into the script's header, replacing any note already
 * there so a stale one can never sit next to the new one.
 *
 * Stamping a null or blank note TAKES THE NOTE OUT rather than leaving what was
 * there. The alternative — "no note means leave it alone" — would make a
 * cleared field do nothing at all, so a note somebody deliberately deleted
 * would keep travelling with the file.
 *
 * The note goes after the other header comments, not at the very top: a reader
 * opening the file wants the machine-read stamps (Change-type, Applies-to) in
 * the same place every time, and a three-line note in front of them buries
 * them. Anything below the header is body and is never moved.
 */
export function stampChangeNote(sql: string, note: string | null): string {
  const lines = (sql ?? "").split("\n");

  // Take out every note line that is already in the header. Walking it once
  // and rebuilding is simpler to follow than splicing indexes as they shift.
  const header: string[] = [];
  let bodyFrom = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("--")) {
      bodyFrom = index;
      break;
    }
    if (!HEADER_PATTERN.test(line)) header.push(line);
  }
  const body = lines.slice(bodyFrom);

  // Blank lines at the end of the header are put back deliberately below.
  // Dropping them first is what makes this idempotent: without it, restamping
  // would keep the blank line the old note sat in AND add a new one, so a file
  // pushed five times would carry five blank lines above its SQL.
  const hadGap = header.length > 0 && header[header.length - 1].trim() === "";
  while (header.length > 0 && header[header.length - 1].trim() === "") header.pop();

  const clean = (note ?? "").trim();
  if (clean === "") {
    // No note to add, so this only takes one out — and it must change NOTHING
    // else. A file with no note at all is the common case (every script pushed
    // without one), and a stamp that quietly added a blank line to it would
    // make this function rewrite files it has no business touching. The gap is
    // put back only when the header already had one.
    const keepGap = hadGap && header.length > 0 && body.length > 0 ? [""] : [];
    return [...header, ...keepGap, ...body].join("\n");
  }

  const noteLines = changeNoteHeaderLines(clean);
  // A blank line between the stamps and the note, and another before the SQL —
  // a comment butted straight against a statement reads as part of it. Neither
  // is added when there is nothing on the other side of it to separate, so a
  // file never opens on an empty line.
  const beforeNote = header.length > 0 ? [""] : [];
  const beforeBody = body.length > 0 && body[0].trim() !== "" ? [""] : [];
  return [...header, ...beforeNote, ...noteLines, ...beforeBody, ...body].join("\n");
}
