/**
 * Phase 101B Plan 02 (AC-6, D-07) — the whole-set red proof for eslint.boundaries.mjs's
 * `no-restricted-imports` blocks.
 *
 * Runs the REAL `ESLint` class against the REAL blocks this file imports (never rebuilds the
 * patterns itself — a test that rebuilds them proves nothing about the rule that actually lints
 * this repo). Lives at the repo root, not under `apps/api/scripts/__tests__/`, because `eslint`
 * is not resolvable from `apps/api` under this repo's isolated pnpm node-linker (RESEARCH.md
 * interface 7) — it IS resolvable from the repo root, and the root `vitest.config.mjs`
 * (`include: ["scripts/**\/*.test.mjs"]`) already collects and runs files here as
 * `pnpm run test:scripts` (`.github/workflows/ci.yml`'s existing "Lint API"-adjacent step).
 *
 * Severity used in THIS test's own baseConfig is always `"error"`, even though the severity
 * shipped in `eslint.config.js` at this point in the phase is `"warn"` (D-12). This test asserts
 * the RULE's matching behaviour — which specifiers get caught, which stay silent, what the
 * message says — not the current phase-wide severity. Plan 09's `"warn"` -> `"error"` flip must
 * not be able to make this file pass for a new, accidental reason.
 *
 * D-07 (the reason this file is this shape, not a smaller one): "context-area-map.test.ts"'s own
 * red-proof once picked `absence/...`, the one context WITHOUT a hyphen, and thereby proved only
 * the case that already worked. This file runs EVERY one of the five context names (including
 * BOTH hyphenated ones — `time-tracking`, `working-time-account`), BOTH directions (all 20
 * ordered pairs, generated — plus four hand-written pairs a reader can check directly against
 * CONTEXT.md D-07's own wording), every import form `check-import-targets.ts` knows, and the two
 * structural traps named in RESEARCH.md: the "no literal path segment" glob shape, and flat
 * config's per-file REPLACE-not-merge semantics.
 */
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import {
  BOUNDARY_CONTEXTS,
  boundaryConfigs,
  boundaryMessage,
  deepPattern,
} from "../../eslint.boundaries.mjs";

// Always "error" here — see file header. `eslint.config.js` itself decides the shipped severity.
const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfigFile: true,
  baseConfig: [
    { files: ["**/*.ts"], languageOptions: { parser: tseslint.parser } },
    ...boundaryConfigs("error"),
  ],
});

/** Lints `code` as if it were `filePath` and returns only this rule's messages. A parse error on
 * an unrelated rule must never make a "silence" assertion pass by accident, so every assertion
 * below filters on `ruleId` rather than trusting the whole `messages` array's length. */
async function lintBoundary(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === "no-restricted-imports");
}

function orderedPairs() {
  const pairs = [];
  for (const from of BOUNDARY_CONTEXTS) {
    for (const to of BOUNDARY_CONTEXTS) {
      if (from !== to) pairs.push([from, to]);
    }
  }
  return pairs;
}

describe("BOUNDARY_CONTEXTS — the literal five-item array itself", () => {
  it("contains exactly the five ADR 0001 contexts, both hyphenated ones included", () => {
    expect(BOUNDARY_CONTEXTS).toEqual([
      "platform",
      "time-tracking",
      "absence",
      "scheduling",
      "working-time-account",
    ]);
  });

  it("produces exactly 20 ordered cross-context pairs", () => {
    expect(orderedPairs()).toHaveLength(20);
  });
});

describe.each(orderedPairs())(
  "whole-set red proof: %s -> %s (D-07, every context, both directions)",
  (from, to) => {
    it(`a deep import from ${from} into ${to} is reported exactly once, with the legal-way-in message`, async () => {
      const messages = await lintBoundary(
        `import { x } from "../../${to}/some-module";\n`,
        `apps/api/src/contexts/${from}/foo.ts`,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0].message).toContain(boundaryMessage(to));
    });
  },
);

describe("D-07 hand-written blind-spot cases (checkable directly against CONTEXT.md's own wording)", () => {
  // These four are not redundant with the generated 20 above — they are the literal cases named
  // in CONTEXT.md D-07 as the ones a naive, non-hyphen-safe scanner would drop. Writing them out
  // by hand means a reader can verify the claim without re-deriving the pair-generation logic.
  it("time-tracking -> working-time-account is reported", async () => {
    const messages = await lintBoundary(
      'import { timeStrInTz } from "../../working-time-account/timezone";\n',
      "apps/api/src/contexts/time-tracking/foo.ts",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain(boundaryMessage("working-time-account"));
  });

  it("working-time-account -> time-tracking is reported", async () => {
    const messages = await lintBoundary(
      'import { getEffectiveSchedule } from "../../time-tracking/api/time-entries";\n',
      "apps/api/src/contexts/working-time-account/foo.ts",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain(boundaryMessage("time-tracking"));
  });

  it("absence -> time-tracking is reported", async () => {
    const messages = await lintBoundary(
      'import { checkJArbSchG } from "../../time-tracking/jarbschg";\n',
      "apps/api/src/contexts/absence/foo.ts",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain(boundaryMessage("time-tracking"));
  });

  it("time-tracking -> absence is reported", async () => {
    const messages = await lintBoundary(
      'import { DISPLAY_NAME } from "../../absence/leave-type";\n',
      "apps/api/src/contexts/time-tracking/foo.ts",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain(boundaryMessage("absence"));
  });
});

describe.each(BOUNDARY_CONTEXTS)(
  "%s: the public surface stays legal from a foreign importer",
  (target) => {
    // Importer is a neutral, non-`contexts/*` file (matches only the BASE block, which carries
    // all five patterns) — this isolates the negation (`!**/<name>/index`) itself, rather than
    // conflating it with "own-context imports are never checked at all" (a different mechanism,
    // covered separately below for services/clock and services/phorest).
    it(`"../${target}/index" (explicit index specifier) is NOT reported`, async () => {
      const messages = await lintBoundary(
        `import { x } from "../${target}/index";\n`,
        "apps/api/src/composition/foo.ts",
      );
      expect(messages).toHaveLength(0);
    });

    it(`"../${target}" (implicit index specifier) is NOT reported`, async () => {
      const messages = await lintBoundary(
        `import { x } from "../${target}";\n`,
        "apps/api/src/composition/foo.ts",
      );
      expect(messages).toHaveLength(0);
    });
  },
);

describe("specifier-shape coverage (AC-6 blind-spot inventory)", () => {
  it("a .js-suffixed deep specifier is reported (NodeNext-style specifier)", async () => {
    const messages = await lintBoundary(
      'import { getVocationalSchoolMinutesForDate } from "../working-time-account/vocational-school-saldo.js";\n',
      "apps/api/src/contexts/absence/foo.ts",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain(boundaryMessage("working-time-account"));
  });

  it("a specifier that DOES repeat the literal contexts/ path segment is still reported (the app.ts-shaped form)", async () => {
    const messages = await lintBoundary(
      'import { getTenantTimezone } from "../../contexts/working-time-account/timezone";\n',
      "apps/api/src/contexts/absence/foo.ts",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain(boundaryMessage("working-time-account"));
  });

  it("depth independence: a single ../ deep specifier is reported", async () => {
    const messages = await lintBoundary(
      'import { getTenantTimezone } from "../working-time-account/timezone";\n',
      "apps/api/src/contexts/absence/foo.ts",
    );
    expect(messages).toHaveLength(1);
  });

  it("depth independence: a triple ../../../ deep specifier is reported", async () => {
    const messages = await lintBoundary(
      'import { getTenantTimezone } from "../../../working-time-account/timezone";\n',
      "apps/api/src/contexts/absence/nested/deeper/foo.ts",
    );
    expect(messages).toHaveLength(1);
  });

  it('"export { x } from ..." (static re-export) is reported', async () => {
    const messages = await lintBoundary(
      'export { DISPLAY_NAME } from "../../absence/leave-type";\n',
      "apps/api/src/contexts/working-time-account/foo.ts",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain(boundaryMessage("absence"));
  });

  it('"import type { X } from ..." is reported', async () => {
    const messages = await lintBoundary(
      'import type { AdjustmentRecord } from "../working-time-account/timezone";\n',
      "apps/api/src/contexts/absence/foo.ts",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain(boundaryMessage("working-time-account"));
  });

  it("dynamic import() into a foreign context is NOT reported — the NAMED gap (D-02/RESEARCH.md), asserted as fact so nobody later claims the rule covers it", async () => {
    const messages = await lintBoundary(
      'const m = await import("../contexts/absence/plugins/carryover-warning");\n',
      "apps/api/src/composition/foo.ts",
    );
    expect(messages).toHaveLength(0);
  });
});

describe("app.ts composition-root exception (D-01/Form C) — silent for every one of the 20 pairs", () => {
  // app.ts is a single fixed file, so only the TARGET dimension of a pair can vary here (the
  // "from" side is always app.ts itself) — looping the generated pairs' target contexts covers
  // every context this exception must stay silent for, which is the part of "all 20 pairs" that
  // is actually meaningful for a single, non-context-owned importer file.
  for (const target of BOUNDARY_CONTEXTS) {
    it(`importing ${target}'s internals from app.ts reports nothing`, async () => {
      const messages = await lintBoundary(
        `import { x } from "../contexts/${target}/some-module";\n`,
        "apps/api/src/app.ts",
      );
      expect(messages).toHaveLength(0);
    });
  }
});

describe("ADR 0001 Eintrag F — services/clock is time-tracking, services/phorest is scheduling", () => {
  it("services/clock/resolver.ts importing its OWN context (time-tracking) via a contexts/ path is NOT reported", async () => {
    const messages = await lintBoundary(
      'import { INVALID_REASON } from "../../contexts/time-tracking/invalid-reason";\n',
      "apps/api/src/services/clock/resolver.ts",
    );
    expect(messages).toHaveLength(0);
  });

  it("services/clock/resolver.ts importing a FOREIGN context (absence) IS reported", async () => {
    const messages = await lintBoundary(
      'import { resolveLeaveDays } from "../../contexts/absence/api/leave";\n',
      "apps/api/src/services/clock/resolver.ts",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain(boundaryMessage("absence"));
  });

  it("services/phorest/sync-shifts.ts importing its OWN context (scheduling) via a contexts/ path is NOT reported", async () => {
    const messages = await lintBoundary(
      'import { shiftNettoMinutes } from "../../contexts/scheduling/time-arithmetic";\n',
      "apps/api/src/services/phorest/sync-shifts.ts",
    );
    expect(messages).toHaveLength(0);
  });

  it("services/phorest/sync-shifts.ts importing a FOREIGN context (working-time-account) IS reported", async () => {
    const messages = await lintBoundary(
      'import { getTenantTimezone } from "../../contexts/working-time-account/timezone";\n',
      "apps/api/src/services/phorest/sync-shifts.ts",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain(boundaryMessage("working-time-account"));
  });
});

describe("__tests__ scope exclusion (Owner decision #246 — accepted risk, out of this rule's scope)", () => {
  it("a foreign deep import inside a __tests__ directory reports nothing", async () => {
    const messages = await lintBoundary(
      'import { getTenantTimezone } from "../../../working-time-account/timezone";\n',
      "apps/api/src/contexts/absence/__tests__/foo.test.ts",
    );
    expect(messages).toHaveLength(0);
  });

  it("a *.test.ts file outside a __tests__ directory also reports nothing", async () => {
    const messages = await lintBoundary(
      'import { getTenantTimezone } from "../working-time-account/timezone";\n',
      "apps/api/src/contexts/absence/foo.test.ts",
    );
    expect(messages).toHaveLength(0);
  });
});

describe("the flat-config replacement trap (RESEARCH.md interface 5)", () => {
  it("absence importing working-time-account is reported — would silently pass if block 3 were a one-pattern delta instead of the complete four-pattern set", async () => {
    const messages = await lintBoundary(
      'import { getTenantTimezone } from "../../working-time-account/timezone";\n',
      "apps/api/src/contexts/absence/deep/nested/foo.ts",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain(boundaryMessage("working-time-account"));
  });
});

describe("anti-tidy pin: the glob shape itself (RESEARCH.md finding 6 / non-negotiable #5)", () => {
  it.each(BOUNDARY_CONTEXTS)(
    "deepPattern(%s).group[0] is the segment-free glob, never the contexts/-segment form",
    (context) => {
      expect(deepPattern(context).group[0]).toBe(`**/${context}/**`);
      expect(deepPattern(context).group[0]).not.toBe(`**/contexts/${context}/**`);
    },
  );

  it("deepPattern('absence').group[0] specifically is NOT '**/contexts/absence/**' (the exact anti-pattern named in RESEARCH.md)", () => {
    expect(deepPattern("absence").group[0]).not.toBe("**/contexts/absence/**");
    expect(deepPattern("absence").group[0]).toBe("**/absence/**");
  });
});
