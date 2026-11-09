import { HIDDEN_SQL_TEXT, hasHiddenCharacters, showHiddenCharacters } from "@/lib/hidden-characters";

describe("hidden characters in SQL", () => {
  test("SQL as people write it has none", () => {
    for (const sql of ["SELECT 1;", "SELECT 1;\nSELECT 2;", "SELECT 1;\r\nSELECT 2;", "SELECT\t1;", "SELECT 'é ✓';", ""]) {
      expect(hasHiddenCharacters(sql)).toBe(false);
      expect(showHiddenCharacters(sql)).toBe(sql);
    }
  });

  test("a lone carriage return ends a comment, so it shows as the line break it is", () => {
    const sql = "-- adds an index\rDROP TABLE accounts;";
    expect(hasHiddenCharacters(sql)).toBe(true);
    expect(showHiddenCharacters(sql)).toBe("-- adds an index\u{240D}\nDROP TABLE accounts;");
  });

  test("zero-width, direction and other unseen characters show as their code", () => {
    expect(showHiddenCharacters("a​b")).toBe("a\u{27E6}U+200B\u{27E7}b");
    expect(showHiddenCharacters("﻿SELECT")).toBe("\u{27E6}U+FEFF\u{27E7}SELECT");
    expect(showHiddenCharacters("x‮y")).toBe("x\u{27E6}U+202E\u{27E7}y");
    expect(showHiddenCharacters("\x00")).toBe("\u{27E6}U+0000\u{27E7}");
    expect(hasHiddenCharacters("a⁦b")).toBe(true);
  });

  test("every one is marked, and asking twice gives the same answer", () => {
    const sql = "a\rb\rc​";
    expect(showHiddenCharacters(sql)).toBe("a\u{240D}\nb\u{240D}\nc\u{27E6}U+200B\u{27E7}");
    expect(hasHiddenCharacters(sql)).toBe(true);
    expect(hasHiddenCharacters(sql)).toBe(true);
  });

  test("the refusal names both marks", () => {
    expect(HIDDEN_SQL_TEXT).toContain("\u{240D}");
    expect(HIDDEN_SQL_TEXT).toContain("\u{27E6}");
  });
});
