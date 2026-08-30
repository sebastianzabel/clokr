import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseReleaseNote, loadReleaseNotes, RELEASE_NOTES_DIR } from "../release-notes";

describe("parseReleaseNote", () => {
  it("parses a bare headline with no body into empty intro/sections/footnote", () => {
    const note = parseReleaseNote("1.9.18", "## v1.9.18 — Titel\n");
    expect(note).toEqual({
      version: "1.9.18",
      title: "Titel",
      intro: [],
      sections: [],
      footnote: null,
    });
  });

  it("groups a heading followed by two bullets into one section with two bullets", () => {
    const md = [
      "## v1.9.18 — Titel",
      "",
      "### Neue Funktionen",
      "",
      "- Erste Zeile",
      "- Zweite Zeile",
    ].join("\n");
    const note = parseReleaseNote("1.9.18", md);
    expect(note.sections).toHaveLength(1);
    expect(note.sections[0].heading).toBe("Neue Funktionen");
    expect(note.sections[0].bullets).toHaveLength(2);
    expect(note.sections[0].bullets[0].spans).toEqual([{ text: "Erste Zeile", bold: false }]);
    expect(note.sections[0].bullets[1].spans).toEqual([{ text: "Zweite Zeile", bold: false }]);
  });

  it("splits a bullet with a bold span into three spans: plain, bold, plain", () => {
    const md = [
      "## v1.9.18 — Titel",
      "",
      "### Neue Funktionen",
      "",
      "- Ein **fetter** Begriff",
    ].join("\n");
    const note = parseReleaseNote("1.9.18", md);
    expect(note.sections[0].bullets[0].spans).toEqual([
      { text: "Ein ", bold: false },
      { text: "fetter", bold: true },
      { text: " Begriff", bold: false },
    ]);
  });

  it("collects paragraph text between the headline and the first heading into intro, one entry per paragraph", () => {
    const md = [
      "## v1.9.18 — Titel",
      "",
      "Erster Absatz, eine Zeile.",
      "",
      "Zweiter Absatz,",
      "über zwei Zeilen.",
      "",
      "### Neue Funktionen",
      "",
      "- Bullet",
    ].join("\n");
    const note = parseReleaseNote("1.9.18", md);
    expect(note.intro).toEqual(["Erster Absatz, eine Zeile.", "Zweiter Absatz, über zwei Zeilen."]);
  });

  it("extracts the footnote from a trailing --- rule and strips its underscores", () => {
    const md = ["## v1.9.18 — Titel", "", "---", "", "_Hinweis._"].join("\n");
    const note = parseReleaseNote("1.9.18", md);
    expect(note.footnote).toBe("Hinweis.");
  });

  it("returns null footnote when there is no trailing --- rule", () => {
    const md = ["## v1.9.18 — Titel", "", "### Neue Funktionen", "", "- Bullet"].join("\n");
    const note = parseReleaseNote("1.9.18", md);
    expect(note.footnote).toBeNull();
  });

  it("appends an indented bullet continuation line to the previous bullet, separated by one space", () => {
    const md = [
      "## v1.9.18 — Titel",
      "",
      "### Neue Funktionen",
      "",
      "- Erste Zeile",
      "  Fortsetzung der ersten Zeile.",
    ].join("\n");
    const note = parseReleaseNote("1.9.18", md);
    expect(note.sections[0].bullets).toHaveLength(1);
    const fullText = note.sections[0].bullets[0].spans.map((s) => s.text).join("");
    expect(fullText).toBe("Erste Zeile Fortsetzung der ersten Zeile.");
  });

  it("throws when the first non-empty line is not a valid headline", () => {
    expect(() => parseReleaseNote("1.9.18", "Kein Headline hier\n")).toThrow();
  });

  it("throws when the headline version disagrees with the version argument", () => {
    expect(() => parseReleaseNote("1.9.18", "## v1.9.17 — Titel\n")).toThrow();
  });

  it("carries a hostile bullet payload through as one literal-text span, never HTML", () => {
    const md = [
      "## v1.9.18 — Titel",
      "",
      "### Sicherheit",
      "",
      "- <img src=x onerror=alert(1)>",
    ].join("\n");
    const note = parseReleaseNote("1.9.18", md);
    expect(note.sections[0].bullets[0].spans).toEqual([
      { text: "<img src=x onerror=alert(1)>", bold: false },
    ]);
  });
});

describe("loadReleaseNotes", () => {
  it("returns [] and does not throw for a nonexistent directory", () => {
    expect(loadReleaseNotes("/nonexistent-clokr-release-notes-dir")).toEqual([]);
  });

  it("returns only the valid file when a directory has one valid and one malformed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "clokr-rn-"));
    try {
      writeFileSync(join(dir, "v1.0.0.md"), "## v1.0.0 — Gültig\n");
      writeFileSync(join(dir, "v2.0.0.md"), "Kein Headline hier -- kaputte Datei\n");
      const notes = loadReleaseNotes(dir);
      expect(notes).toHaveLength(1);
      expect(notes[0].version).toBe("1.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sorts newest-first by numeric semver, not lexically (1.10.0 above 1.9.18)", () => {
    const dir = mkdtempSync(join(tmpdir(), "clokr-rn-"));
    try {
      writeFileSync(join(dir, "v1.9.18.md"), "## v1.9.18 — Alt\n");
      writeFileSync(join(dir, "v1.10.0.md"), "## v1.10.0 — Neu\n");
      const notes = loadReleaseNotes(dir);
      expect(notes.map((n) => n.version)).toEqual(["1.10.0", "1.9.18"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Corpus sweep (AK-16 backfill) ───────────────────────────────────────────
// A malformed note file degrades to "skipped" at runtime by design (loadReleaseNotes' fail-silent
// contract, AK-06) -- which means production would silently drop an entry with nothing turning
// red. This sweep is the counterweight: it runs the THROWING variant, parseReleaseNote, against
// every real file in docs/release-notes/ so malformed content fails CI before it can ever ship
// silently. Both halves are needed; neither is sufficient alone.
//
// Read the real directory via the exported RELEASE_NOTES_DIR, not a hand-built path -- this is
// also the dev-side proof that the constant resolves correctly (the Docker gate in Plan 04 proves
// the image side).
const corpusFiles = readdirSync(RELEASE_NOTES_DIR).filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f));

describe("release-notes corpus (AK-16 backfill)", () => {
  it("finds at least 22 real corpus files to sweep", () => {
    expect(corpusFiles.length).toBeGreaterThanOrEqual(22);
  });

  it.each(corpusFiles)("%s parses and is renderable", (file) => {
    const version = file.slice(1, -3);
    const markdown = readFileSync(join(RELEASE_NOTES_DIR, file), "utf-8");

    const note = parseReleaseNote(version, markdown);

    expect(note.title.length).toBeGreaterThan(0);
    expect(note.sections.length > 0 || note.intro.length > 0).toBe(true);

    // AK-13 canary on real content: no bullet span looks like it could be markup. Complements
    // the hostile-payload unit test above, which proves the render path treats such text as
    // literal -- this proves no shipped note accidentally contains any in the first place.
    for (const section of note.sections) {
      for (const bullet of section.bullets) {
        for (const span of bullet.spans) {
          expect(span.text).not.toMatch(/<[a-zA-Z]/);
        }
      }
    }
  });

  it("loadReleaseNotes() with no argument returns >= 22 notes sorted newest-first, real corpus", () => {
    const notes = loadReleaseNotes();
    expect(notes.length).toBeGreaterThanOrEqual(22);
    const tupleOf = (version: string) => {
      const [major, minor, patch] = version.split(".").map(Number);
      return major * 1_000_000 + minor * 1_000 + patch;
    };
    for (let i = 1; i < notes.length; i++) {
      expect(tupleOf(notes[i - 1].version)).toBeGreaterThanOrEqual(tupleOf(notes[i].version));
    }
  });
});
