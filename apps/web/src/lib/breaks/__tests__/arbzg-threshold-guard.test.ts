/**
 * Issue #511 D-18 / D-21 - the browser never re-implements the § 4 ArbZG / § 11 JArbSchG break
 * thresholds. The server kernel decides (`evaluateDayBreaks`, the preview route, the day checks);
 * a second rule in a page drifts from it the moment the law or the kernel changes - which is how
 * the former browser-side check came to disagree with the server (the Satz-2/3 placement rules
 * it never knew, the cross-salon day sum it could not see).
 *
 * The guard walks every non-test `.ts` / `.svelte` file under `apps/web/src` and counts the lines
 * that compare a duration against a § 4 threshold. Exceptions are counted PER FILE and must match
 * EXACTLY, so an exception that is removed (the follow-up lands) turns the guard red too, until
 * its entry is deleted - a register that tolerates dead entries stops being readable.
 *
 * How to clear an exception: move the value to the server (follow-up issue #525), delete the
 * entry below, and lower nothing else. How NOT to: widening a regex, adding an exception without
 * an issue number, or adding a file to the register to get a new threshold through - a new
 * occurrence is a finding to report, not an exception to add.
 *
 * Named blind spots: a threshold written without a numeric literal (a named constant, or minutes
 * computed elsewhere) is not seen; the three patterns catch the shapes that actually existed in
 * the removed check (`netMin > 6 * 60`, `gross <= 360`, `workedHours > 9`, `totalBreak < 30`).
 * The guard is a tripwire against re-growth, not a proof of absence.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// vitest runs with apps/web as the working directory (same convention as the other source-reading
// tests of this package). A different cwd makes the walked set empty, which the floor below turns
// into a red test rather than a silent pass.
const SRC_ROOT = resolve(process.cwd(), "src");

// Walked set measured on 2026-10-09 with this guard's own walk: 161 files. The floor (150, inline
// in the test below) keeps a margin for normal deletions and still turns red when the walk
// silently covers a fraction of the tree (a moved directory, a changed extension filter): a guard
// that checked nothing must never report success.

/** Duration in minutes or seconds-in-minutes compared to 6 h / 9 h / 4.5 h. */
const MINUTES_THRESHOLD = /[<>]=?\s*(?:360|540|270|[69]\s*\*\s*60)\b/;
/** A "...hours" variable compared to 4.5 / 6 / 9. */
const HOURS_THRESHOLD = /[Hh]ours\s*[<>]=?\s*(?:4\.5|6|9)\b/;
/** A "break..." variable compared to the 30 / 45 / 60 minute pause amounts. */
const BREAK_THRESHOLD = /[Bb]reak[A-Za-z]*\s*[<>]=?\s*(?:30|45|60)\b/;

const PATTERNS = [MINUTES_THRESHOLD, HOURS_THRESHOLD, BREAK_THRESHOLD];

/** One hit per line, whichever pattern matches. */
function thresholdLines(source: string): number[] {
  const hits: number[] = [];
  source.split("\n").forEach((line, i) => {
    if (PATTERNS.some((re) => re.test(line))) hits.push(i + 1);
  });
  return hits;
}

interface ThresholdException {
  /** Number of matching lines the file is allowed - exactly, not at most. */
  hits: number;
  reason: string;
  /** The follow-up issue that removes the exception. */
  issue: number;
}

/** Repo-relative from the `apps/web/src` root, forward slashes. */
const EXCEPTIONS: Record<string, ThresholdException> = {
  "routes/(app)/time-entries/+page.svelte": {
    hits: 2,
    reason:
      "suggestedBreakMinutes() prefills the break slot of a NEW entry (gross <= 6 h / <= 9 h). " +
      "It is a convenience default that the server re-derives authoritatively on save, not a " +
      "finding; moving it needs a server endpoint for the suggestion.",
    issue: 525,
  },
  "routes/(app)/dashboard/+page.svelte": {
    hits: 3,
    reason:
      "arbzgCallout shows a live hint for the running day (workedHours < 6, entryBreakMin < 30, " +
      "workedHours > 9 && entryBreakMin < 45) before any closed entry exists for the server to " +
      "evaluate; moving it needs a server-side live check.",
    issue: 525,
  },
};

function walkSources(absDir: string, out: string[] = []): string[] {
  for (const name of readdirSync(absDir)) {
    if (name === "__tests__" || name === "node_modules" || name === ".svelte-kit") continue;
    const abs = join(absDir, name);
    if (statSync(abs).isDirectory()) {
      walkSources(abs, out);
    } else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(abs);
    }
  }
  return out;
}

function srcRel(abs: string): string {
  return relative(SRC_ROOT, abs).split("\\").join("/");
}

const FILES = walkSources(SRC_ROOT);

describe("matcher (positive control)", () => {
  it("flags the shapes of the removed browser-side check", () => {
    expect(thresholdLines("if (netMin > 6 * 60 && totalBreak < 30) {")).toEqual([1]);
    expect(thresholdLines("if (netMin > 9 * 60 && totalBreak < 45)")).toEqual([1]);
    expect(thresholdLines("if (gross <= 360) return 0;")).toEqual([1]);
    expect(thresholdLines("if (gross <= 540) return a;")).toEqual([1]);
    expect(thresholdLines("if (workedHours > 9) {")).toEqual([1]);
    expect(thresholdLines("if (entryBreakMin < 45)")).toEqual([1]);
  });

  it("does not flag an unrelated 360 (an animation offset) or ordinary comparisons", () => {
    expect(thresholdLines("x: reducedMotion ? 0 : 360,")).toEqual([]);
    expect(thresholdLines("if (items.length > 6) {")).toEqual([]);
    expect(thresholdLines("const hours = minutes / 60;")).toEqual([]);
  });

  it("counts one hit per line, not per pattern", () => {
    expect(thresholdLines("a\nif (workedHours < 6 && breakMin < 30) {\nb")).toEqual([2]);
  });
});

describe("no client-side § 4 / § 11 threshold arithmetic (Issue #511 D-18, D-21)", () => {
  it("walks a non-empty source set (anti-vacuity)", () => {
    // The literal is the floor (the vacuity gate only reads a numeric literal as proof).
    expect(FILES.length).toBeGreaterThanOrEqual(150);
    // The two exception files and a known page must be inside the walked set, else the exact
    // counts below would pass on a tree that the walk no longer reaches.
    const walked = new Set(FILES.map(srcRel));
    for (const file of Object.keys(EXCEPTIONS)) expect(walked.has(file)).toBe(true);
    expect(walked.has("routes/(app)/team/time-entries/+page.svelte")).toBe(true);
  });

  it("every exception names a reason and an issue number", () => {
    for (const [file, entry] of Object.entries(EXCEPTIONS)) {
      expect(entry.reason.length, file).toBeGreaterThan(40);
      expect(Number.isInteger(entry.issue) && entry.issue > 0, file).toBe(true);
      expect(entry.hits, file).toBeGreaterThan(0);
    }
  });

  it("the former browser-side check and its merge helper exist nowhere", () => {
    // Assembled from parts so that this file does not contain the names it forbids.
    const removed = [
      ["check", "ArbZGFrontend"],
      ["mergeDayChecksInto", "ArbzgMap"],
    ].map((p) => p.join(""));
    for (const abs of FILES) {
      const source = readFileSync(abs, "utf8");
      for (const name of removed)
        expect(source.includes(name), `${srcRel(abs)} ${name}`).toBe(false);
    }
  });

  it("every file carries exactly its excepted number of threshold lines", () => {
    const mismatches: string[] = [];
    for (const abs of FILES) {
      const rel = srcRel(abs);
      const lines = thresholdLines(readFileSync(abs, "utf8"));
      const allowed = EXCEPTIONS[rel]?.hits ?? 0;
      if (lines.length !== allowed) {
        mismatches.push(
          `${rel}: ${lines.length} threshold line(s) at ${lines.join(", ")}, expected ${allowed}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });
});
