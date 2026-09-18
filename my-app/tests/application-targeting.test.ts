// Restricting a migration to particular applications.
//
// Spec feature 11: "Apply scripts only to target databases by reading
// application_name from ApplicationTable; some scripts may be restricted to
// specific applications."
//
// Two things are being held here. The first is the check itself, where every
// wrong answer is expensive in one direction or the other: letting a billing
// migration run against the reporting database, or refusing one that should
// have run and stalling a deploy.
//
// The second is `addressedElsewhere`, which decides whether a refused script
// may be STEPPED OVER. A deploy runs a contiguous range of versions, so a
// script that can neither run nor be stepped over blocks every later version
// behind it — and the screen ends up telling the reader to pick a range
// without it when no such range exists. Exactly one of the three refusals may
// be stepped over, and the tests below are mostly about the two that may not.
import {
  APPLIES_TO_HEADER_KEY,
  applicationNamesSql,
  checkApplications,
  normalizeAppName,
  readAppliesToHeader,
  type TargetApplications,
} from "@/lib/application-targeting";

/** A target that was read and hosts these applications. */
function hosts(...names: string[]): TargetApplications {
  return { known: true, names, source: "public.applications" };
}

/** A target whose applications could not be read at all. */
const UNKNOWN: TargetApplications = { known: false, names: [], source: null };

describe("readAppliesToHeader", () => {
  it("reads the applications a script names", () => {
    expect(readAppliesToHeader(`-- ${APPLIES_TO_HEADER_KEY}: billing, reporting\nALTER TABLE x ...`)).toEqual([
      "billing",
      "reporting",
    ]);
  });

  it("is null for a script that says nothing about applications", () => {
    // Null is "no restriction", which is every script written before this
    // existed. It must never be confused with [].
    expect(readAppliesToHeader("ALTER TABLE orders ADD COLUMN note text;")).toBeNull();
    expect(readAppliesToHeader("")).toBeNull();
  });

  it("is [] for a header that names nothing, which is not the same as null", () => {
    // A header somebody got wrong. Reading it as "no restriction" is how a
    // script ends up running on every database at once.
    expect(readAppliesToHeader(`-- ${APPLIES_TO_HEADER_KEY}:\nSELECT 1;`)).toEqual([]);
    expect(readAppliesToHeader(`-- ${APPLIES_TO_HEADER_KEY}: , ,\nSELECT 1;`)).toEqual([]);
  });

  it("ignores a line of the same shape once the body has started", () => {
    // Otherwise a comment inside the SQL, or a string holding one, could
    // change which databases the script is allowed to run against.
    const sql = `CREATE TABLE t (id int);\n-- ${APPLIES_TO_HEADER_KEY}: billing\n`;
    expect(readAppliesToHeader(sql)).toBeNull();
  });

  it("looks past blank lines and other comments to find it", () => {
    const sql = `-- Change-type: additive\n\n-- ${APPLIES_TO_HEADER_KEY}: billing\nSELECT 1;`;
    expect(readAppliesToHeader(sql)).toEqual(["billing"]);
  });

  it("does not treat case or spacing as part of the name", () => {
    expect(normalizeAppName("  Billing ")).toBe("billing");
    // But everything else is part of it: guessing that these are the same
    // application would run a script against the wrong database.
    expect(normalizeAppName("pay_run")).not.toBe(normalizeAppName("pay-run"));
  });
});

describe("checkApplications", () => {
  it("lets an unrestricted script run anywhere, and says nothing about it", () => {
    const verdict = checkApplications(null, UNKNOWN);
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBeNull();
    expect(verdict.addressedElsewhere).toBe(false);
  });

  it("lets a restricted script run where one of its applications is hosted", () => {
    // One match is enough — a database hosting billing and reporting is a
    // billing database.
    const verdict = checkApplications(["billing"], hosts("reporting", "billing"));
    expect(verdict.allowed).toBe(true);
    // Said out loud even when allowed, so the screen is not silently letting
    // a restricted script through.
    expect(verdict.reason).toContain("billing");
  });

  it("matches the name however it was typed on either side", () => {
    expect(checkApplications([" Billing "], hosts("BILLING")).allowed).toBe(true);
  });

  it("refuses a script for applications this database is known not to host", () => {
    const verdict = checkApplications(["billing"], hosts("reporting"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("reporting");
  });
});

describe("which refusals may be stepped over", () => {
  it("steps over a script addressed to an application this database does not host", () => {
    // The one safe case, and the reason the flag exists: by its own header the
    // script touches another application's tables, which are not in this
    // database, so nothing after it here depends on what it did.
    expect(checkApplications(["billing"], hosts("reporting")).addressedElsewhere).toBe(true);
  });

  it("does NOT step over a script whose restriction could not be checked", () => {
    // "Not confirmed" is not "not for here". Nothing has said this database is
    // the wrong one, so skipping it would silently drop a migration that may
    // well belong here — and the deploy would report success having left it out.
    const verdict = checkApplications(["billing"], UNKNOWN);
    expect(verdict.allowed).toBe(false);
    expect(verdict.addressedElsewhere).toBe(false);
    // The reason has to name the fix, because this one blocks the whole run.
    expect(verdict.reason).toContain("Name the table on the connection");
  });

  it("does NOT step over a script whose own header is broken", () => {
    // An empty header is a mistake to fix, not a thing to route around.
    const verdict = checkApplications([], hosts("reporting"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.addressedElsewhere).toBe(false);
    expect(verdict.reason).toContain(APPLIES_TO_HEADER_KEY);
  });

  it("does NOT step over one when the application table is there but empty", () => {
    // An empty table is one nobody has filled in far more often than it is a
    // database that truly hosts nothing. Reading it as "definitely not
    // billing" would drop every restricted migration on a database whose only
    // real problem is an unpopulated table.
    const verdict = checkApplications(["billing"], { known: true, names: [], source: "public.applications" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.addressedElsewhere).toBe(false);
    expect(verdict.reason).toContain("empty");
  });

  it("never marks an allowed script as one to step over", () => {
    // Stepping over a script that is allowed to run would leave a migration
    // out of a deploy that reported success.
    for (const target of [UNKNOWN, hosts("billing"), hosts()]) {
      for (const restriction of [null, ["billing"], [], ["billing", "reporting"]]) {
        const verdict = checkApplications(restriction, target);
        if (verdict.allowed) expect(verdict.addressedElsewhere).toBe(false);
      }
    }
  });
});

describe("applicationNamesSql", () => {
  it("reads distinct names and leaves out the nulls", () => {
    const sql = applicationNamesSql('"ops"."applications"');
    expect(sql).toContain("DISTINCT application_name");
    expect(sql).toContain('FROM "ops"."applications"');
    expect(sql).toContain("IS NOT NULL");
  });

  it("does not quote the table itself", () => {
    // It cannot: it does not know the target's schema rules, and a
    // half-quoting helper is worse than none. The caller quotes.
    expect(applicationNamesSql("already.quoted")).toContain("FROM already.quoted");
  });
});
