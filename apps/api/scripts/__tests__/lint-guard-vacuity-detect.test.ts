/**
 * Phase 235 Plan 01 (AC-1/AC-2/AC-6) — tests for the AST classifier that answers, for one source
 * file, the three questions D-02 makes mechanical: does it walk the source tree, does it assert
 * on the result, and does it prove the WALKED set was non-empty.
 *
 * DB-free: fixtures under fixtures/guard-vacuity/ are parsed with `ts.createSourceFile` inside
 * `classifyGuardFile`, never executed — same discipline as lint-tenant-scoping-facade.test.ts's
 * fixture corpus. The fixture matrix IS the specification (235-01-PLAN.md's own table); every row
 * pins one classification class, including both D-03 directions (a comment that describes a walk
 * primitive; a string literal containing "//" that hides a real one on the next line) and the
 * `walkChain(rows)` false-friend that produced 3 of the phase's starting 29 -> 26 correction.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { classifyGuardFile, type InputProofKind } from "../lint-guard-vacuity-detect";

const FIXTURES_DIR = join(__dirname, "fixtures/guard-vacuity");

interface MatrixRow {
  file: string;
  walks: boolean;
  asserts: boolean;
  inputProof: InputProofKind;
}

const FIXTURE_MATRIX: MatrixRow[] = [
  { file: "vacuous-readdir-walk.ts", walks: true, asserts: true, inputProof: "none" },
  { file: "guarded-length-assert.ts", walks: true, asserts: true, inputProof: "length" },
  { file: "guarded-scanned-flag.mjs", walks: true, asserts: true, inputProof: "flag-inner" },
  { file: "guarded-flag-outer.ts", walks: true, asserts: true, inputProof: "flag-outer" },
  { file: "guarded-empty-abort.ts", walks: true, asserts: true, inputProof: "empty-abort" },
  { file: "false-friend-walk-name.ts", walks: false, asserts: true, inputProof: "none" },
  { file: "comment-describes-walk.ts", walks: false, asserts: false, inputProof: "none" },
  { file: "commentish-string-hides-code.ts", walks: true, asserts: true, inputProof: "none" },
  { file: "execsync-git-not-a-walk.ts", walks: false, asserts: true, inputProof: "none" },
  { file: "execsync-find-walk.mjs", walks: true, asserts: true, inputProof: "none" },
  { file: "walker-without-assertion.ts", walks: true, asserts: false, inputProof: "none" },
  { file: "shadowed-readdir-binding.ts", walks: false, asserts: true, inputProof: "none" },
  { file: "namespace-import-walk.ts", walks: true, asserts: true, inputProof: "length" },
];

function loadFixture(file: string): { path: string; text: string } {
  const abs = join(FIXTURES_DIR, file);
  return { path: abs, text: readFileSync(abs, "utf8") };
}

describe("FIXTURE_MATRIX completeness (D-07: red proof over the WHOLE set)", () => {
  it("has exactly 13 rows", () => {
    expect(FIXTURE_MATRIX.length).toBe(13);
  });

  it("matches the fixture directory exactly — both directions, no orphan, no missing", () => {
    const onDisk = readdirSync(FIXTURES_DIR).sort();
    const inMatrix = FIXTURE_MATRIX.map((r) => r.file).sort();
    expect(onDisk).toEqual(inMatrix);
  });
});

describe.each(FIXTURE_MATRIX)(
  "classifyGuardFile($file)",
  ({ file, walks, asserts, inputProof }) => {
    it(`walks=${walks}, asserts=${asserts}, inputProof=${inputProof}`, () => {
      const { path, text } = loadFixture(file);
      const result = classifyGuardFile(path, text);
      expect(result.walks, `walks mismatch for ${file}`).toBe(walks);
      expect(result.asserts, `asserts mismatch for ${file}`).toBe(asserts);
      expect(result.inputProof, `inputProof mismatch for ${file}`).toBe(inputProof);
    });
  },
);
