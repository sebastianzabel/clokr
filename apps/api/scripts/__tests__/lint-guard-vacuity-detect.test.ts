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
 *
 * Two rows added in Plan 235-02, during baseline verification against the REAL tree (not
 * hypothetical — both fixtures reproduce a real file's exact idiom that this classifier
 * originally misclassified as vacuous): `guarded-contains-assert.ts` pins the `"contains"`
 * proof kind (`expect([...x]).toContain(y)`, `absence-vocabulary-guard.test.ts`'s real shape) and
 * `chained-call-on-walk-containing-fn.ts` pins that `isWalkDerivedExpr`'s chain-method branch
 * recurses into a receiver that is a direct call to a walk-CONTAINING function, not only a raw
 * walk-primitive call (`section9-model.test.ts`'s real `walk(dir).filter(...)` shape). Both were
 * found by running the built tool over the real tree and manually verifying real files the tool
 * reported as vacuous — never invented against a hypothetical.
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
  { file: "guarded-contains-assert.ts", walks: true, asserts: true, inputProof: "contains" },
  {
    file: "chained-call-on-walk-containing-fn.ts",
    walks: true,
    asserts: true,
    inputProof: "length",
  },
  {
    file: "execsync-find-template-literal-walk.mjs",
    walks: true,
    asserts: true,
    inputProof: "empty-abort",
  },
];

function loadFixture(file: string): { path: string; text: string } {
  const abs = join(FIXTURES_DIR, file);
  return { path: abs, text: readFileSync(abs, "utf8") };
}

describe("FIXTURE_MATRIX completeness (D-07: red proof over the WHOLE set)", () => {
  it("has exactly 16 rows", () => {
    expect(FIXTURE_MATRIX.length).toBe(16);
  });

  it("matches the fixture directory exactly — both directions, no orphan, no missing", () => {
    const onDisk = readdirSync(FIXTURES_DIR).sort();
    // Phase 235 (D-02/AC-4, this plan's own Group A sweep — see 235-BASELINE.md's note that this
    // file is part of Group A): without this, the equality below could pass on two empty sets if
    // fixtures/guard-vacuity/ ever moved or emptied at the same time FIXTURE_MATRIX did.
    expect(
      onDisk.length,
      "no guard-vacuity fixture found — fixtures/guard-vacuity/ moved or emptied",
    ).toBeGreaterThan(0);
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

// ── Task 3: the INPUT-set-vs-OUTPUT-set distinction (RESEARCH.md §2), pinned inline ─────────────
//
// These three cases are written directly here, not as fixtures, because they are a MINIMAL PAIR:
// the only difference between the first two is one extra line, and the third is the real shape
// of this repo's own check-import-targets.ts -- read from disk, not reproduced as a fixture, so a
// future refactor of that file cannot silently stop being covered by this pin.

describe("input-set vs output-set (D-02's load-bearing distinction)", () => {
  it('a walk whose ONLY assertion targets the OUTPUT set (`expect(violations).toEqual([])`) is inputProof "none"', () => {
    const src = `
      import { readdirSync } from "node:fs";
      export function check(dir) {
        const files = readdirSync(dir);
        const violations = files.filter((f) => f.includes("bad"));
        expect(violations).toEqual([]);
      }
    `;
    const result = classifyGuardFile("inline-output-only.ts", src);
    expect(result.walks).toBe(true);
    expect(result.asserts).toBe(true);
    expect(result.inputProof).toBe("none");
  });

  it('the SAME file plus `expect(files.length).toBeGreaterThan(0)` becomes inputProof "length"', () => {
    const src = `
      import { readdirSync } from "node:fs";
      export function check(dir) {
        const files = readdirSync(dir);
        const violations = files.filter((f) => f.includes("bad"));
        expect(files.length).toBeGreaterThan(0);
        expect(violations).toEqual([]);
      }
    `;
    const result = classifyGuardFile("inline-output-and-input.ts", src);
    expect(result.inputProof).toBe("length");
  });

  it(
    "check-import-targets.ts's OUTPUT-only success line (`if (unresolved.length === 0)`) is " +
      "still not itself an input proof -- but 235-05 (D-02) added a genuine one on the walked " +
      "FILE set (`discoverCheckedFiles(apiRoot).length === 0`), so the file's OVERALL " +
      'classification is now "empty-abort", not "none". This test used to pin this real file as ' +
      "a live example of an output-only success line with no input proof at all (see git " +
      "history before 235-05 for that shape) -- it now pins the FIXED shape, so a future " +
      "regression that silently drops the empty-abort is still caught.",
    () => {
      const path = join(__dirname, "../check-import-targets.ts");
      const result = classifyGuardFile(path, readFileSync(path, "utf8"));
      expect(result.walks).toBe(true);
      expect(result.asserts).toBe(true);
      expect(result.inputProof).toBe("empty-abort");
    },
  );
});

// ── Task 3: the two REAL files this module must classify correctly, not only fixture copies ─────

describe("real-file classification (not a fixture stand-in)", () => {
  it("section9-credit.test.ts's scannedAtLeastOne idiom classifies as flag-inner in its ORIGINAL file", () => {
    const path = join(__dirname, "../../src/__tests__/section9-credit.test.ts");
    const result = classifyGuardFile(path, readFileSync(path, "utf8"));
    expect(result.walks).toBe(true);
    expect(result.asserts).toBe(true);
    expect(result.inputProof).toBe("flag-inner");
  });

  it(
    "check-import-targets.ts classifies walks=true, asserts=true, inputProof=empty-abort " +
      "(235-05/D-02 added the empty-abort; this file used to be a real vacuous example before " +
      "that plan closed it)",
    () => {
      const path = join(__dirname, "../check-import-targets.ts");
      const result = classifyGuardFile(path, readFileSync(path, "utf8"));
      expect(result.walks).toBe(true);
      expect(result.asserts).toBe(true);
      expect(result.inputProof).toBe("empty-abort");
    },
  );
});
