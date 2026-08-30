/**
 * Parser for the German release-note corpus at `docs/release-notes/`.
 *
 * This module NEVER produces or transports HTML (AK-13/N-08). The XSS surface this feature
 * would otherwise have (release-note text ends up in every user's browser, for every role) is
 * removed BY CONSTRUCTION, not by filtering untrusted input after the fact: `parseReleaseNote`
 * turns the project's fixed, hand-written Markdown grammar into plain structured data (headings,
 * bullets, and bold spans as strings), and it is the caller's job (the Svelte side, Plan 06) to
 * render those strings through normal, auto-escaping text bindings. No Markdown-to-HTML rendering
 * library and no HTML-cleaning library are used or needed here — a hostile string in a bullet
 * (e.g. `<img src=x onerror=alert(1)>`) is carried through as one literal-text span and nothing
 * more; there is nowhere in this pipeline an HTML string could even form.
 *
 * The grammar implemented here is documented in `docs/release-notes/README.md` and is
 * intentionally NOT general CommonMark — it supports exactly four STRUCTURAL constructs: one
 * `## vX.Y.Z — <title>` headline, `### <heading>` sections, `- <text>` bullets (with optional
 * indented continuation lines), and `**bold**` spans inside a bullet that become a `bold: true`
 * span. Everything else in a release body (links, blockquote callouts, …) is carried as literal
 * text, unrecognised and unprocessed.
 *
 * Separately (Plan 07 checkpoint fix), inline COSMETIC emphasis markers that carry no structural
 * meaning here — `**bold**` outside a bullet, single-`*` italic, and inline code delimited by a
 * backtick pair — are stripped down to their plain content wherever they appear (intro, footnote,
 * and inside bullets alongside the structural `**`), by {@link stripInlineMarkers}, so their raw
 * punctuation never reaches the rendered drawer. This is textual cleanup, not Markdown rendering:
 * it removes delimiter characters, never adds a tag or a new span type.
 */
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

export interface ReleaseNoteSpan {
  text: string;
  bold: boolean;
}

export interface ReleaseNoteBullet {
  spans: ReleaseNoteSpan[];
}

export interface ReleaseNoteSection {
  heading: string; // e.g. "Neue Funktionen"
  bullets: ReleaseNoteBullet[];
}

export interface ReleaseNote {
  version: string; // "1.9.18" -- no leading "v"
  title: string; // "Krank im Urlaub & Saldo-Korrekturen"
  intro: string[]; // plain paragraphs between the H2 and the first H3
  sections: ReleaseNoteSection[];
  footnote: string | null; // trailing "_..._" line after the "---" rule, underscores stripped
}

// Phase 69 (DEVOPS-V8-02) precedent: bake the corpus location the same way app.ts bakes the
// version from package.json (apps/api/src/app.ts:59-67) -- resolve(__dirname, ...) at module
// init, never an env var.
//
// Path arithmetic: apps/api/tsconfig.json has rootDir "./src", outDir "./dist", so
// src/utils/x.ts compiles to dist/utils/x.js -- the same depth below apps/api on both sides.
//   dev  : <repo>/apps/api/src/utils   + "../../../../docs/release-notes" -> <repo>/docs/release-notes
//   image: /app/apps/api/dist/utils    + "../../../../docs/release-notes" -> /app/docs/release-notes
// If that depth ever changes, this constant breaks silently -- the Dockerfile gate in Plan 04
// is what catches it.
export const RELEASE_NOTES_DIR = resolve(__dirname, "../../../../docs/release-notes");

const HEADLINE_RE = /^## v(\d+\.\d+\.\d+) — (.+)$/;
const HEADING_RE = /^### (.+)$/;
const BULLET_RE = /^- (.+)$/;
const FOOTNOTE_RE = /^_(.+)_$/;
const CORPUS_FILENAME_RE = /^v\d+\.\d+\.\d+\.md$/;

/**
 * Strip inline Markdown emphasis markers down to their plain content wherever the grammar does
 * not give them structural meaning: inline code (`` `x` ``) and single-asterisk italic (`*x*`)
 * are NOT among the four documented rules in `docs/release-notes/README.md`, so they were
 * previously carried through completely unprocessed -- including the delimiter punctuation
 * itself. Found in the Plan 07 checkpoint: the running drawer showed literal backtick characters
 * around inline identifiers like `` `SHIFT_BASED` `` and literal `**` around a bold aside that
 * sits in intro text rather than inside a bullet (the one place `**` WAS already handled).
 *
 * This only removes delimiter characters -- it never produces HTML, a tag, or a new span type,
 * so it does not touch the AK-13/N-08 guarantee that this module never forms markup: a hostile
 * payload with no backtick/asterisk pairs (e.g. `<img src=x onerror=alert(1)>`) passes through
 * unchanged, exactly as the existing hostile-payload test already pins.
 *
 * Order matters: `**bold**` is stripped before single-`*` italic, otherwise "**x**" would first
 * be read as an "*"-wrapped "*x*" pair and leave stray asterisks behind.
 */
function stripInlineMarkers(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}

/**
 * Split bullet text on `**` into alternating plain/bold spans.
 *
 * Even-indexed fragments are plain, odd-indexed are bold; empty fragments (adjacent `**` or a
 * leading/trailing `**`) are dropped. A trailing UNMATCHED `**` (an odd total delimiter count)
 * must not turn the remainder of the bullet bold -- a stray asterisk pair in a shipped note must
 * not corrupt everything after it, so the last fragment always stays plain in that case.
 *
 * `**` still marks bold as before (it is one of the four documented grammar rules); each
 * resulting fragment is additionally run through {@link stripInlineMarkers} so a backtick or
 * single-asterisk marker inside either a bold or a plain fragment does not surface its raw
 * punctuation (Plan 07 checkpoint fix). `**` itself never survives into a fragment here (it was
 * just used as the split delimiter), so re-running that half of `stripInlineMarkers` is a no-op.
 */
function splitSpans(text: string): ReleaseNoteSpan[] {
  const parts = text.split("**");
  const delimiterCount = parts.length - 1;
  const unmatchedTrailing = delimiterCount % 2 === 1;
  const spans: ReleaseNoteSpan[] = [];
  for (let idx = 0; idx < parts.length; idx++) {
    const part = parts[idx];
    if (part === "") continue;
    const isLast = idx === parts.length - 1;
    const bold = unmatchedTrailing ? !isLast && idx % 2 === 1 : idx % 2 === 1;
    spans.push({ text: stripInlineMarkers(part), bold });
  }
  return spans;
}

/**
 * Throws on a malformed file. Used by tests and by the corpus sweep (Task 3) -- a malformed
 * note file must fail CI loudly here rather than silently vanish at runtime via
 * {@link loadReleaseNotes}'s fail-silent contract.
 */
export function parseReleaseNote(version: string, markdown: string): ReleaseNote {
  const lines = markdown.split(/\r?\n/);

  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) {
    throw new Error(`Release note ${version}: file is empty`);
  }

  const headlineMatch = lines[i].match(HEADLINE_RE);
  if (!headlineMatch) {
    throw new Error(
      `Release note ${version}: first line is not a valid "## vX.Y.Z — Titel" headline: "${lines[i]}"`,
    );
  }
  const [, headlineVersion, title] = headlineMatch;
  if (headlineVersion !== version) {
    throw new Error(
      `Release note ${version}: headline version "${headlineVersion}" does not match "${version}"`,
    );
  }
  i++;

  const intro: string[] = [];
  const sections: ReleaseNoteSection[] = [];
  let footnote: string | null = null;
  let currentSection: ReleaseNoteSection | null = null;
  let currentParagraph: string[] = [];
  let sawFirstHeading = false;

  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      // Intro paragraphs stay plain strings (not spans) -- unlike bullets, this text never
      // needed a `bold`/`code` render distinction, so stripping is enough (Plan 07 checkpoint
      // fix: intro previously carried its `**`/backtick markers through completely raw).
      intro.push(stripInlineMarkers(currentParagraph.join(" ")));
      currentParagraph = [];
    }
  };

  for (; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (line === "---") {
      flushParagraph();
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length) {
        const footnoteMatch = lines[j].trim().match(FOOTNOTE_RE);
        if (footnoteMatch) footnote = stripInlineMarkers(footnoteMatch[1]);
      }
      break; // nothing beyond the rule matters other than the optional footnote
    }

    if (line === "") {
      flushParagraph();
      continue;
    }

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      flushParagraph();
      sawFirstHeading = true;
      currentSection = { heading: headingMatch[1], bullets: [] };
      sections.push(currentSection);
      continue;
    }

    const bulletMatch = line.match(BULLET_RE);
    if (bulletMatch) {
      const bullet: ReleaseNoteBullet = { spans: splitSpans(bulletMatch[1]) };
      if (currentSection) {
        currentSection.bullets.push(bullet);
      } else {
        // A bullet outside any section is not part of the documented grammar; carry it as
        // literal intro text rather than throwing -- a shipped note with an odd list before its
        // first heading must not take the API down. Same marker stripping as every other intro
        // paragraph (Plan 07 checkpoint fix).
        intro.push(stripInlineMarkers(bulletMatch[1]));
      }
      continue;
    }

    // A bullet continuation line: indented in the source, not itself a "- " bullet, and there is
    // a bullet to attach it to. Joined with exactly one literal space span.
    const isIndentedContinuation = /^\s+/.test(rawLine) && !!currentSection?.bullets.length;
    if (isIndentedContinuation && currentSection) {
      const lastBullet = currentSection.bullets[currentSection.bullets.length - 1];
      lastBullet.spans.push({ text: " ", bold: false }, ...splitSpans(line));
      continue;
    }

    if (!sawFirstHeading) {
      currentParagraph.push(line);
    }
    // Stray unindented text after a heading that is neither a bullet nor a continuation falls
    // outside the grammar and is intentionally dropped -- the four documented constructs are the
    // only ones this parser gives meaning to (see docs/release-notes/README.md).
  }
  flushParagraph();

  return { version, title, intro, sections, footnote };
}

function compareVersionsDescending(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let idx = 0; idx < 3; idx++) {
    if (partsA[idx] !== partsB[idx]) return partsB[idx] - partsA[idx];
  }
  return 0;
}

/**
 * Never throws. Returns [] on any failure. Skips individual unparseable files. Sorted
 * newest-first by numeric semver comparison (never lexical -- "1.10.0" < "1.9.18" as strings).
 *
 * This is called at API module init (Plan 04): it must be impossible for this function to
 * throw, because a throw there means the API process does not start at all. That mirrors the
 * fail-silent contract of `apps/web/src/lib/stores/version.ts` (Phase 69, D-08), restated here
 * on the server side by AK-06. Deliberately does not log -- a malformed file degrading silently
 * to "skipped" is the documented tradeoff; Task 3's corpus sweep is the counterweight that keeps
 * it from shipping unnoticed.
 */
export function loadReleaseNotes(dir: string = RELEASE_NOTES_DIR): ReleaseNote[] {
  try {
    const files = readdirSync(dir).filter((f) => CORPUS_FILENAME_RE.test(f));
    const notes: ReleaseNote[] = [];
    for (const file of files) {
      try {
        const version = file.slice(1, -3); // strip leading "v" and trailing ".md"
        const markdown = readFileSync(join(dir, file), "utf-8");
        notes.push(parseReleaseNote(version, markdown));
      } catch {
        continue; // skip this one file; T-110-07
      }
    }
    notes.sort((a, b) => compareVersionsDescending(a.version, b.version));
    return notes;
  } catch {
    return [];
  }
}
