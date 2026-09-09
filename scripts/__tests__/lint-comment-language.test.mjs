// Unit tests for scripts/lint-comment-language.mjs (Issue #131).
//
// Run via `pnpm test:scripts` at repo root (see vitest.config.mjs — a root-level config,
// not apps/api's or apps/web's, because this linter scans BOTH apps and neither existing
// vitest config can run a plain node-environment script test without borrowing the other
// app's setup). Never run under apps/api's vitest — that instance owns the shared test
// database and may be mid-run for another agent.
import { describe, expect, it } from "vitest";
import {
  classifyComment,
  extractComments,
  extractSvelteComments,
  findCommentLanguageViolations,
  STOPWORD_THRESHOLD,
  STOPWORDS,
} from "../lint-comment-language.mjs";

describe("STOPWORDS / STOPWORD_THRESHOLD", () => {
  it("requires at least two distinct stopwords", () => {
    expect(STOPWORD_THRESHOLD).toBe(2);
  });

  it("contains the core German function words used across CLAUDE.md examples", () => {
    for (const word of ["der", "die", "das", "und", "nicht", "ist", "wird"]) {
      expect(STOPWORDS.has(word)).toBe(true);
    }
  });
});

describe("classifyComment", () => {
  it("flags a comment with two distinct German function words", () => {
    const { isGerman, matchedWords } = classifyComment(
      " Diese Funktion prüft, ob der Monat gesperrt ist und wirft einen Fehler.",
    );
    expect(isGerman).toBe(true);
    expect(matchedWords).toContain("der");
    expect(matchedWords).toContain("und");
  });

  it("does not flag a single stray German-looking word", () => {
    // "es" alone (e.g. quoting `es.filter()` in prose) must not trip the detector.
    const { isGerman } = classifyComment(" call es.filter() on the result");
    expect(isGerman).toBe(false);
  });

  it("does not flag English prose naming a German domain noun", () => {
    const { isGerman } = classifyComment(
      " Recomputes the Monatsabschluss snapshot for this Saldo period.",
    );
    expect(isGerman).toBe(false);
  });

  it("excludes the capitalized domain-noun form (Ist) from stopword matching", () => {
    // "Ist" the noun (Ist-Zeit / actual value) must not count as the verb "ist".
    const { isGerman, matchedWords } = classifyComment(" the Ist value here, single word only");
    expect(matchedWords).not.toContain("ist");
    expect(isGerman).toBe(false);
  });

  describe("all-caps domain-noun bug fix (SOLL/IST false positive)", () => {
    it("does not flag English prose using the all-caps UI-label form of a domain noun", () => {
      // apps/web/src/routes/(app)/time-entries/+page.svelte:512 (real repro) — this is
      // English prose describing UI tiles, not German prose.
      const { isGerman, matchedWords } = classifyComment(
        " SOLL(BISHER)/IST/MONAT-SALDO tiles + the per-day cumulative cells. GESAMT-SALDO is NO LONGER",
      );
      expect(matchedWords).not.toContain("ist");
      expect(matchedWords).not.toContain("soll");
      expect(isGerman).toBe(false);
    });

    it("still flags genuine German prose that happens to use caps for emphasis", () => {
      // apps/api/src/__tests__/section9-invariants.test.ts:333 (real repro) — "KEINE" here
      // is caps-for-emphasis on a German sentence, not the all-caps form of a domain noun
      // (no domain noun lowercases to "keine"), so it must still count.
      const { isGerman, matchedWords } = classifyComment(
        " KEINE Urlaubstage gutschreiben — das wäre rechtswidrig. § 5 EFZG regelt die",
      );
      expect(matchedWords).toContain("keine");
      expect(matchedWords).toContain("das");
      expect(isGerman).toBe(true);
    });

    it("does not skip all-caps tokens wholesale (a non-domain all-caps German word still counts)", () => {
      // "UND" is not a domain noun, so its all-caps form must be treated exactly like "und".
      const { isGerman, matchedWords } = classifyComment(" Das UND das andere Feld sind Pflicht.");
      expect(matchedWords).toContain("und");
      expect(isGerman).toBe(true);
    });
  });
});

describe("extractComments", () => {
  it("does not extract German text that lives inside a string literal", () => {
    const source = `const msg = "nicht löschen, das ist wichtig für den Monat";\n`;
    const comments = extractComments(source);
    expect(comments).toHaveLength(0);
  });

  it("extracts a line comment written in German", () => {
    const source = `// Diese Zeile ist auf Deutsch und muss erkannt werden\nconst x = 1;\n`;
    const comments = extractComments(source);
    expect(comments).toHaveLength(1);
    expect(comments[0].kind).toBe("line");
    expect(comments[0].text).toContain("Diese Zeile ist auf Deutsch");
  });

  it("extracts a JSDoc/block comment", () => {
    const source = `/**\n * Recomputes something.\n */\nfunction foo() {}\n`;
    const comments = extractComments(source);
    expect(comments).toHaveLength(1);
    expect(comments[0].kind).toBe("block");
  });

  it("does not misfire on a comment-like sequence inside a string (naive-regex trap)", () => {
    const source = `const s = "// nicht löschen";\nconst t = "/* das ist kein Kommentar */";\n`;
    expect(extractComments(source)).toHaveLength(0);
  });

  it("handles a comment inside a template literal's ${…} expression", () => {
    const source =
      "const s = `prefix ${\n  // Kommentar innerhalb der Template-Expression, nicht im String\n  value\n} suffix`;\n";
    const comments = extractComments(source);
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toContain("Kommentar innerhalb der Template-Expression");
  });

  it("does not extract the literal text of the template outside the ${…} expression", () => {
    // The "prefix"/"suffix" template text itself must never be treated as a comment,
    // even though it sits right next to a real comment inside the expression.
    const source = "const s = `prefix German-looking nicht ${ /* real comment */ 1 } suffix`;\n";
    const comments = extractComments(source);
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe("/* real comment */");
  });

  it("treats a division operator following an identifier as division, not a regex/comment start", () => {
    const source = `const result = a / b; // englische Rechnung\n`;
    const comments = extractComments(source);
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toContain("englische Rechnung");
  });

  it("does not treat a regex literal's internal slashes as comment delimiters", () => {
    const source = `const re = /\\/\\/ not a comment/; // aber das hier ist einer und zaehlt\n`;
    const comments = extractComments(source);
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toContain("aber das hier ist einer");
  });
});

describe("extractSvelteComments", () => {
  it("extracts comments from the <script> block only, ignoring markup and <style>", () => {
    const source = [
      "<script>",
      "  // Dieser Kommentar ist auf Deutsch und wird erkannt",
      "  let x = 1;",
      "</script>",
      "",
      "<!-- nicht das ist wird auf Deutsch im Markup, muss ignoriert werden -->",
      "<div>{x}</div>",
      "",
      "<style>",
      "  /* das ist ein CSS-Kommentar und wird ignoriert */",
      "  div { color: red; }",
      "</style>",
    ].join("\n");
    const comments = extractSvelteComments(source);
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toContain("Dieser Kommentar ist auf Deutsch");
  });

  it("extracts comments from a module-context script block too", () => {
    const source = [
      '<script context="module">',
      "  // Modul-Kommentar auf Deutsch und wird erkannt hier",
      "</script>",
      "<script>",
      "  let y = 2;",
      "</script>",
    ].join("\n");
    const comments = extractSvelteComments(source);
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toContain("Modul-Kommentar auf Deutsch");
  });
});

describe("findCommentLanguageViolations (full pipeline)", () => {
  it("flags a .ts file's German line comment but not its string literal", () => {
    const source = [
      'const label = "nicht löschen, das ist wichtig";',
      "// Diese Funktion ist auf Deutsch und wird erkannt hier",
      "function foo() {}",
    ].join("\n");
    const violations = findCommentLanguageViolations(source, "apps/api/src/foo.ts");
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
  });

  it("does not flag an English comment that names a German domain noun", () => {
    const source =
      "// Recomputes the Monatsabschluss snapshot for this Saldo period.\nfunction bar() {}\n";
    const violations = findCommentLanguageViolations(source, "apps/api/src/bar.ts");
    expect(violations).toHaveLength(0);
  });

  it("routes .svelte files through the script-block extractor", () => {
    const source = [
      "<script>",
      "  // Auf Deutsch geschrieben und wird hier klar erkannt",
      "  let z = 1;",
      "</script>",
    ].join("\n");
    const violations = findCommentLanguageViolations(
      source,
      "apps/web/src/routes/foo/+page.svelte",
    );
    expect(violations).toHaveLength(1);
  });
});
