/**
 * Phase 275 Plan 04 (Issue #275, D-07) — table-driven, DB-free unit coverage of the pure module
 * `../lint-e2e-spec-registry-validate.ts`. Every case here drives the module from in-memory
 * register objects, a fixed discovered-file list, and small config-text snippets — this file must
 * NEVER read the real `apps/e2e/tests` directory or the real `playwright.config.ts`, or it becomes
 * a tree-walking asserter itself and inherits the same empty-set obligation the gate under test
 * exists to enforce (see `lint-e2e-spec-registry.ts`'s own module docblock).
 */
import { describe, it, expect } from "vitest";
import {
  CATEGORIES,
  MIN_REASON_LENGTH,
  validateRegisterDocument,
  diffRegisterAgainstFiles,
  extractE2eCiTestMatch,
  diffInCiAgainstTestMatch,
  type RegisterEntry,
} from "../lint-e2e-spec-registry-validate";

const REASON = "x".repeat(MIN_REASON_LENGTH);
const SHORT_REASON = "too short";

const DISCOVERED = [
  "apps/e2e/tests/a.spec.ts",
  "apps/e2e/tests/b.spec.ts",
  "apps/e2e/tests/c.spec.ts",
];

function entry(
  file: string,
  category: RegisterEntry["category"] = "später-datum",
  reason = REASON,
): RegisterEntry {
  return { file, category, reason };
}

function doc(entries: unknown[]): unknown {
  return { registerSource: "test source", entries };
}

describe("CATEGORIES", () => {
  it("is exactly the three D-07 literal values, kept verbatim (German words are data, not code)", () => {
    expect(CATEGORIES).toEqual(["in-ci", "später-datum", "später-seed"]);
  });
});

describe("validateRegisterDocument", () => {
  it("fails when the document is not an object", () => {
    const result = validateRegisterDocument(null, DISCOVERED);
    expect(result.ok).toBe(false);
  });

  it("fails when the document is an array", () => {
    const result = validateRegisterDocument([], DISCOVERED);
    expect(result.ok).toBe(false);
  });

  it("fails when registerSource is empty", () => {
    const result = validateRegisterDocument({ registerSource: "  ", entries: [] }, DISCOVERED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("registerSource"))).toBe(true);
  });

  it("fails when entries is not an array", () => {
    const result = validateRegisterDocument({ registerSource: "x", entries: "nope" }, DISCOVERED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("'entries'"))).toBe(true);
  });

  it("fails on an entry whose category is not one of the three literal values", () => {
    const result = validateRegisterDocument(
      doc([entry(DISCOVERED[0], "not-a-real-category" as never)]),
      DISCOVERED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("category"))).toBe(true);
  });

  it("fails on an entry whose reason is shorter than MIN_REASON_LENGTH, with the sentence-not-label message", () => {
    const result = validateRegisterDocument(
      doc([entry(DISCOVERED[0], "in-ci", SHORT_REASON)]),
      DISCOVERED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("sentence, not a label"))).toBe(true);
    }
  });

  it("fails on two entries naming the same file as a duplicate", () => {
    const result = validateRegisterDocument(
      doc([entry(DISCOVERED[0]), entry(DISCOVERED[0])]),
      DISCOVERED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("fails on an entry whose file is not among the discovered files, naming it as STALE", () => {
    const result = validateRegisterDocument(
      doc([entry("apps/e2e/tests/ghost.spec.ts")]),
      DISCOVERED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("STALE") && e.includes("ghost.spec.ts"))).toBe(
        true,
      );
    }
  });

  it("fails on a non-object entry", () => {
    const result = validateRegisterDocument(doc(["not-an-object"]), DISCOVERED);
    expect(result.ok).toBe(false);
  });

  it("validates a clean, consistent register (every discovered file, valid category, long reason)", () => {
    const result = validateRegisterDocument(doc(DISCOVERED.map((f) => entry(f))), DISCOVERED);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.doc.entries).toHaveLength(3);
  });
});

describe("diffRegisterAgainstFiles", () => {
  it("fails and names a discovered file with no register entry", () => {
    const result = diffRegisterAgainstFiles(
      [entry(DISCOVERED[0]), entry(DISCOVERED[1])],
      DISCOVERED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes(DISCOVERED[2]))).toBe(true);
    }
  });

  it("fails and names a stale entry pointing at a file that no longer exists", () => {
    const result = diffRegisterAgainstFiles(
      [...DISCOVERED.map((f) => entry(f)), entry("apps/e2e/tests/ghost.spec.ts")],
      DISCOVERED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("ghost.spec.ts") && e.includes("STALE"))).toBe(
        true,
      );
    }
  });

  it("passes when entries and discovered files match exactly, both directions", () => {
    const result = diffRegisterAgainstFiles(
      DISCOVERED.map((f) => entry(f)),
      DISCOVERED,
    );
    expect(result.ok).toBe(true);
  });

  it("reports every offending file, not only the first", () => {
    const result = diffRegisterAgainstFiles([entry(DISCOVERED[0])], DISCOVERED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.filter((e) => e.includes("no register entry"))).toHaveLength(2);
    }
  });
});

describe("extractE2eCiTestMatch", () => {
  const validConfigText = `
    projects: [
      { name: "setup", testMatch: /auth\\.setup\\.ts/ },
      {
        name: "axe-scan",
        testMatch: /axe-scan\\.spec\\.ts/,
        use: { foo: true },
      },
      {
        name: "visual",
        testMatch: /visual\\.spec\\.ts/,
        use: { foo: true },
      },
      {
        name: "e2e-ci",
        testMatch: [
          /functional\\.spec\\.ts/,
          /bs-pattern-retroactive\\.spec\\.ts/,
          /leave-flow\\.spec\\.ts/,
        ],
        use: { foo: true },
      },
    ],
  `;

  it("returns the union of basenames from the e2e-ci, axe-scan and visual project blocks", () => {
    const result = extractE2eCiTestMatch(validConfigText);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.sort()).toEqual(
        [
          "axe-scan.spec.ts",
          "bs-pattern-retroactive.spec.ts",
          "functional.spec.ts",
          "leave-flow.spec.ts",
          "visual.spec.ts",
        ].sort(),
      );
    }
  });

  it("signals failure, not an empty list, when the e2e-ci block is absent", () => {
    const withoutE2eCi = validConfigText.replace(/\{\s*name: "e2e-ci",[\s\S]*?\},\n/, "");
    const result = extractE2eCiTestMatch(withoutE2eCi);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("e2e-ci"))).toBe(true);
    }
  });

  it("signals failure when a named block's testMatch matches nothing", () => {
    const emptyTestMatch = validConfigText.replace(
      /testMatch: \/axe-scan\\\.spec\\\.ts\//,
      "testMatch: /nothing-here/",
    );
    const result = extractE2eCiTestMatch(emptyTestMatch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("axe-scan") && e.includes("matched no"))).toBe(
        true,
      );
    }
  });

  it("signals failure when the config text is empty", () => {
    const result = extractE2eCiTestMatch("");
    expect(result.ok).toBe(false);
  });
});

describe("diffInCiAgainstTestMatch", () => {
  it("fails when an in-ci entry names a file no CI-invoked project runs", () => {
    const entries = [entry("apps/e2e/tests/functional.spec.ts", "in-ci")];
    const result = diffInCiAgainstTestMatch(entries, ["other.spec.ts"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("functional.spec.ts"))).toBe(true);
    }
  });

  it("fails (the reverse) when a testMatch file has no matching in-ci register entry — the T-275-14 drift case", () => {
    const entries = [entry("apps/e2e/tests/locked-month.spec.ts", "später-datum")];
    const result = diffInCiAgainstTestMatch(entries, ["locked-month.spec.ts"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.includes("locked-month.spec.ts") && e.includes("not categorised"),
        ),
      ).toBe(true);
    }
  });

  it("passes when in-ci entries and the testMatch set match exactly", () => {
    const entries = [
      entry("apps/e2e/tests/functional.spec.ts", "in-ci"),
      entry("apps/e2e/tests/axe-scan.spec.ts", "in-ci"),
      entry("apps/e2e/tests/other.spec.ts", "später-datum"),
    ];
    const result = diffInCiAgainstTestMatch(entries, ["functional.spec.ts", "axe-scan.spec.ts"]);
    expect(result.ok).toBe(true);
  });
});
