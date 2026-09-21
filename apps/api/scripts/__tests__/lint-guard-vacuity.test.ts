/**
 * Phase 235 Plan 02 (AC-1/AC-2/AC-4/AC-6/AC-8) — tests for the CLI/gate built on top of plan 01's
 * `classifyGuardFile`. GitHub issue #235, #240 (the third recurrence — a non-vacuity proof that
 * covers a convenient member instead of the whole set), #245 (the fourth).
 *
 * Three concerns, in order:
 *   1. `validateExceptionsDocument` — five hand-written cases a reader can check directly (short
 *      reason, missing `disappearsIn`, unknown key, stale entry, missing file).
 *   2. `evaluateCheck` — equality in BOTH directions, against a SYNTHETIC report (never the real,
 *      drifting repo count) so this test never needs updating as later waves fix guards.
 *   3. THE WHOLE-SET RED PROOF (D-07): `describe.each(provedGuards())`, where `provedGuards()`
 *      reads the REAL discovered guard set from the REAL repo tree — never a fixture, never a
 *      hand-picked file. For every guard whose `inputProof !== "none"`, this deletes the exact
 *      lines `inputProofSites` names from an IN-MEMORY COPY of that file's text and re-classifies
 *      the modified text, asserting the proof is gone. This is the literal shape #240 documents:
 *      99B-08's own non-vacuity proof picked `absence/…`, the one context that already worked: a
 *      red proof that does not cover the whole set proves nothing about the guards it skips. The
 *      `provedGuards()` non-emptiness assertion below exists so THIS red proof cannot recur that
 *      failure mode in the one file whose entire job is preventing it.
 *
 *      Plan 235-04 finding: a single FILE can carry more than one structurally independent
 *      walk-and-proof (`absence-vocabulary-guard.test.ts`'s G5 `scannedFiles()`/"contains" and G6
 *      `collectFiles()`/"length" after that plan's retrofit, two unrelated walked sets in the same
 *      file). `classifyGuardFile` reports only ONE winning shape per file (length checked before
 *      contains before empty-abort before flag — see its Part G priority chain), so a single-shot
 *      deletion of that winning shape's lines can uncover a SECOND, still-intact proof elsewhere in
 *      the same file and leave the guard correctly classified as still proved — which is not a
 *      vacuity, it is the file legitimately having two independent guards against two independent
 *      walks. `deleteEveryProofUntilVacuous` below re-classifies after each deletion and deletes
 *      whatever proof shape newly becomes the winner, repeating until either no proof remains
 *      (`"none"`) or a deletion makes no further progress (a safety bound against an infinite
 *      loop, never expected to trip on real files) — so the assertion this test makes is now "no
 *      combination of this file's own proof mechanisms is left standing", not "the one shape the
 *      classifier happened to report first is gone".
 *
 * DB-free, disk-write-free: every case here either uses synthetic in-memory data or reads real
 * files without ever writing to them — `git status --porcelain` stays clean after this suite runs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GuardClassification } from "../lint-guard-vacuity-detect";
import { classifyGuardFile } from "../lint-guard-vacuity-detect";
import {
  buildGuardReport,
  classifyDiscoveredFiles,
  discoverCandidateFiles,
  evaluateCheck,
  MIN_REASON_LENGTH,
  validateExceptionsDocument,
  type ExceptionsDocument,
  type GuardReport,
} from "../lint-guard-vacuity";

const LONG_REASON =
  "This is a long enough reason to pass the minimum length check, by design (Plan 235-02 test).";

function realRepoRoot(): string {
  // apps/api/scripts/__tests__/ -> scripts -> api -> apps -> repo root (4 levels up)
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
}

// ── 1. validateExceptionsDocument — five hand-written cases ─────────────────────────────────────

describe("validateExceptionsDocument", () => {
  const allFiles = ["some/vacuous/file.ts", "some/other/file.ts"];
  const vacuousFiles = ["some/vacuous/file.ts"];

  it("fails a reason shorter than MIN_REASON_LENGTH", () => {
    const raw = {
      registerSource: "test",
      exceptions: [
        { id: "e1", file: "some/vacuous/file.ts", reason: "weil", disappearsIn: "never" },
      ],
    };
    const result = validateExceptionsDocument(raw, vacuousFiles, allFiles);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/reason/i);
      expect(result.errors.join("\n")).toContain(String(MIN_REASON_LENGTH));
    }
  });

  it("fails an entry missing disappearsIn", () => {
    const raw = {
      registerSource: "test",
      exceptions: [{ id: "e1", file: "some/vacuous/file.ts", reason: LONG_REASON }],
    };
    const result = validateExceptionsDocument(raw, vacuousFiles, allFiles);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/disappearsIn/);
    }
  });

  it("fails an entry with an unknown key", () => {
    const raw = {
      registerSource: "test",
      exceptions: [
        {
          id: "e1",
          file: "some/vacuous/file.ts",
          reason: LONG_REASON,
          disappearsIn: "never",
          extra: "not allowed",
        },
      ],
    };
    const result = validateExceptionsDocument(raw, vacuousFiles, allFiles);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/unknown key/i);
    }
  });

  it("fails a STALE entry — file exists but is no longer vacuous", () => {
    const raw = {
      registerSource: "test",
      exceptions: [
        { id: "e1", file: "some/other/file.ts", reason: LONG_REASON, disappearsIn: "never" },
      ],
    };
    // "some/other/file.ts" is in allFiles but NOT in vacuousFiles.
    const result = validateExceptionsDocument(raw, vacuousFiles, allFiles);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/STALE/);
    }
  });

  it("fails an entry naming a file that does not exist", () => {
    const raw = {
      registerSource: "test",
      exceptions: [
        { id: "e1", file: "no/such/file.ts", reason: LONG_REASON, disappearsIn: "never" },
      ],
    };
    const result = validateExceptionsDocument(raw, vacuousFiles, allFiles);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/does not exist/);
    }
  });

  it("accepts a valid entry", () => {
    const raw = {
      registerSource: "test",
      exceptions: [
        { id: "e1", file: "some/vacuous/file.ts", reason: LONG_REASON, disappearsIn: "never" },
      ],
    };
    const result = validateExceptionsDocument(raw, vacuousFiles, allFiles);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.exceptions).toHaveLength(1);
    }
  });

  // ── scope filter (235-08) — an exception entry outside the CURRENT --scope must not fail a
  // scoped run just because that scope's own allFiles never contains a file from a different root
  // (the register's first entry, release-notes.ts under apps/api/src/utils, broke
  // `--scope apps/api/scripts --check <n>` outright the moment it landed, before this fix). ────

  it("skips an out-of-scope entry entirely when scope is given — no 'does not exist' error", () => {
    const raw = {
      registerSource: "test",
      exceptions: [
        {
          id: "e1",
          file: "other/root/file.ts", // NOT in allFiles at all — would normally fail existence
          reason: LONG_REASON,
          disappearsIn: "never",
        },
      ],
    };
    const result = validateExceptionsDocument(raw, vacuousFiles, allFiles, "some/vacuous");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.exceptions).toHaveLength(0);
    }
  });

  it("still validates an entry that IS inside the given scope", () => {
    const raw = {
      registerSource: "test",
      exceptions: [
        { id: "e1", file: "some/vacuous/file.ts", reason: LONG_REASON, disappearsIn: "never" },
      ],
    };
    const result = validateExceptionsDocument(raw, vacuousFiles, allFiles, "some/vacuous");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.exceptions).toHaveLength(1);
    }
  });

  it("without scope (undefined), an out-of-scope-shaped file still fails as before (no silent behavior change for the unscoped/standing run)", () => {
    const raw = {
      registerSource: "test",
      exceptions: [
        { id: "e1", file: "no/such/file.ts", reason: LONG_REASON, disappearsIn: "never" },
      ],
    };
    const result = validateExceptionsDocument(raw, vacuousFiles, allFiles);
    expect(result.ok).toBe(false);
  });
});

// ── 2. evaluateCheck — equality in BOTH directions, against a SYNTHETIC report ──────────────────

function classificationOf(
  file: string,
  overrides: Partial<GuardClassification> = {},
): GuardClassification {
  return {
    file,
    walks: true,
    walkSites: [{ line: 1, primitive: "readdirSync", binding: "test" }],
    asserts: true,
    assertSites: [{ line: 2, kind: "expect" }],
    inputProof: "none",
    inputProofSites: [],
    ...overrides,
  };
}

function syntheticReport(vacuousCount: number, provedCount: number): GuardReport {
  const doc: ExceptionsDocument = { registerSource: "test", exceptions: [] };
  const classifications: GuardClassification[] = [];
  for (let i = 0; i < vacuousCount; i++) {
    classifications.push(classificationOf(`synthetic/vacuous-${i}.ts`));
  }
  for (let i = 0; i < provedCount; i++) {
    classifications.push(
      classificationOf(`synthetic/proved-${i}.ts`, {
        inputProof: "length",
        inputProofSites: [{ line: 3, subject: "files" }],
      }),
    );
  }
  // one not-a-guard file, to prove the report distinguishes it from vacuous
  classifications.push(classificationOf(`synthetic/not-a-guard.ts`, { walks: false }));
  return buildGuardReport(classifications, doc);
}

describe("evaluateCheck — equality in both directions (D-08)", () => {
  const report = syntheticReport(3, 2);

  it("passes --check V when V equals the actual vacuous count", () => {
    expect(evaluateCheck(report, 3).ok).toBe(true);
  });

  it("FAILS --check V-1 (a decrease is a mismatch too)", () => {
    const result = evaluateCheck(report, 2);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/DECREASE/);
  });

  it("FAILS --check V+1", () => {
    const result = evaluateCheck(report, 4);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("-1");
  });

  it("failure message names every vacuous file, not only the delta", () => {
    const result = evaluateCheck(report, 999);
    expect(result.ok).toBe(false);
    for (let i = 0; i < 3; i++) {
      expect(result.message).toContain(`synthetic/vacuous-${i}.ts`);
    }
  });
});

// ── The empty-discovery abort: buildGuardReport over zero files is an ERROR ─────────────────────

describe("buildGuardReport — empty-discovery abort", () => {
  it("throws when given an empty classification list, never '0 vacuous, OK'", () => {
    expect(() => buildGuardReport([], { registerSource: "test", exceptions: [] })).toThrow();
  });
});

// ── 3. THE WHOLE-SET RED PROOF (D-07) — generated from the REAL discovered guard set ────────────

interface ProvedGuard {
  file: string;
  text: string;
  classification: GuardClassification;
}

/** Every guard in the REAL repo tree whose `inputProof !== "none"` — the whole set, generated,
 * never a hand-picked member (D-07). Reads from disk but never writes. */
function provedGuards(): ProvedGuard[] {
  const repoRoot = realRepoRoot();
  const files = discoverCandidateFiles(repoRoot);
  const classifications = classifyDiscoveredFiles(repoRoot, files);
  return classifications
    .filter((c) => c.inputProof !== "none")
    .map((c) => ({
      file: c.file,
      text: readFileSync(join(repoRoot, c.file), "utf8"),
      classification: c,
    }));
}

/** Removes the exact 1-based lines `lines` names from `text`, in memory only. A deletion that
 * leaves a syntactically broken remainder is fine and expected here — the assertion under test is
 * only ever "does the proof shape still classify as proved", and a broken remainder cannot. */
function deleteLines(text: string, lines: readonly number[]): string {
  const lineSet = new Set(lines);
  return text
    .split("\n")
    .filter((_, idx) => !lineSet.has(idx + 1))
    .join("\n");
}

/** Repeatedly deletes whichever proof shape `classifyGuardFile` currently reports for `file`,
 * re-classifying after each deletion, until either no proof remains (`"none"`) or a deletion makes
 * no further progress (Plan 235-04 finding: a file can carry more than one independent
 * walk-and-proof, so a single deletion can uncover a second, still-intact proof elsewhere in the
 * same file — see this file's own docblock, item 3). The 20-iteration bound is generous headroom
 * over any real file's proof count (every file measured so far carries at most two independent
 * proofs) and exists only so a genuine bug here fails loudly instead of hanging.
 *
 * Progress is measured on the REMAINING TEXT, never on the reported line numbers. Line numbers are
 * recomputed against a text that just got shorter, so two independent proofs can legitimately be
 * reported at the same 1-based line in consecutive rounds — the second one having slid up into the
 * position the first one vacated. Keying "no progress" on the line set therefore aborted the
 * deletion walk while a real, still-intact proof remained, and the caller then read that leftover
 * as "this file cannot be flipped to vacuous". Measured on
 * `apps/web/src/__tests__/client-logger-install-site.test.ts` (issue #149): round 0 reports
 * `length` at line 56, round 1 reports `contains` at line 56 again, round 2 reaches "none" — the
 * old key aborted after round 1 and failed a file that does flip. A deletion of a non-empty line
 * set always shortens the text, so comparing texts detects every real step and stops only when a
 * round removes nothing at all. This strictly widens the red proof: a file that genuinely cannot be
 * flipped still runs out of rounds and still fails. */
function deleteEveryProofUntilVacuous(
  file: string,
  text: string,
  classification: GuardClassification,
): GuardClassification {
  let currentText = text;
  let current = classification;
  for (let i = 0; i < 20 && current.inputProof !== "none"; i++) {
    const lines = current.inputProofSites.map((s) => s.line);
    if (lines.length === 0) break;
    const nextText = deleteLines(currentText, lines);
    if (nextText === currentText) break; // no progress — stop rather than loop forever
    currentText = nextText;
    current = classifyGuardFile(file, currentText);
  }
  return current;
}

describe("provedGuards() non-emptiness — the red proof must not itself go vacuous", () => {
  it("finds at least one proved guard in the real tree", () => {
    expect(provedGuards().length).toBeGreaterThan(0);
  });
});

describe.each(provedGuards())(
  "whole-set red proof: removing the input proof flips $file to vacuous",
  ({ file, text, classification }) => {
    it(`classifies input-proof:none after deleting every independent inputProofSites shape`, () => {
      const lines = classification.inputProofSites.map((s) => s.line);
      expect(
        lines.length,
        `${file} has inputProof !== "none" but no inputProofSites`,
      ).toBeGreaterThan(0);
      const result = deleteEveryProofUntilVacuous(file, text, classification);
      expect(
        result.inputProof,
        `${file} still proves non-emptiness after deleting every independent proof shape found`,
      ).toBe("none");
    });
  },
);
