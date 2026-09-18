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

describe("provedGuards() non-emptiness — the red proof must not itself go vacuous", () => {
  it("finds at least one proved guard in the real tree", () => {
    expect(provedGuards().length).toBeGreaterThan(0);
  });
});

describe.each(provedGuards())(
  "whole-set red proof: removing the input proof flips $file to vacuous",
  ({ file, text, classification }) => {
    it(`classifies input-proof:none after deleting inputProofSites line(s)`, () => {
      const lines = classification.inputProofSites.map((s) => s.line);
      expect(
        lines.length,
        `${file} has inputProof !== "none" but no inputProofSites`,
      ).toBeGreaterThan(0);
      const modified = deleteLines(text, lines);
      const result = classifyGuardFile(file, modified);
      expect(result.inputProof, `${file} still proves non-emptiness after deletion`).toBe("none");
    });
  },
);
