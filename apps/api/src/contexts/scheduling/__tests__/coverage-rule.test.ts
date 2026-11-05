/**
 * Issue #647 (D-04/D-05) — `pickCoverageRule()` is the one place a day's coverage rule is chosen. The
 * specificity ladder is frozen against the pre-#647 picker (copied verbatim from
 * `git show 490f26cd:apps/api/src/contexts/scheduling/api/shifts.ts`, lines 236-279, renamed
 * `legacyPickRule`): for tenant-wide rules only, the new picker equals the old one for every rule
 * subset, template and weekday. A salon rule beats a tenant-wide rule within one rung, never across
 * rungs; another salon's rule never acts; no salon in view means tenant-wide rules only.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_COVERAGE_RULE,
  coverageSalonInView,
  pickCoverageRule,
  type CoverageRuleCandidate,
} from "../coverage-rule";

// ── frozen reference — never edited ──────────────────────────────────────────────────────────────
/**
 * Find the most specific CoverageRule for a (template, dayOfWeek) combination.
 * Match order:
 *   1. templateId match AND dayOfWeek match
 *   2. templateId null AND dayOfWeek match
 *   3. templateId match AND dayOfWeek = -1
 *   4. templateId null AND dayOfWeek = -1
 * If no rule matches, returns default { minStaff: 2, requiresNonSupervised: false }.
 */
function legacyPickRule(
  rules: Array<{
    templateId: string | null;
    dayOfWeek: number;
    minStaff: number;
    requiresNonSupervised: boolean;
  }>,
  templateId: string | null,
  dayOfWeek: number,
): { minStaff: number; requiresNonSupervised: boolean } {
  if (templateId) {
    const exact = rules.find((r) => r.templateId === templateId && r.dayOfWeek === dayOfWeek);
    if (exact)
      return { minStaff: exact.minStaff, requiresNonSupervised: exact.requiresNonSupervised };
  }
  const tplNullDow = rules.find((r) => r.templateId === null && r.dayOfWeek === dayOfWeek);
  if (tplNullDow)
    return {
      minStaff: tplNullDow.minStaff,
      requiresNonSupervised: tplNullDow.requiresNonSupervised,
    };
  if (templateId) {
    const tplAllDays = rules.find((r) => r.templateId === templateId && r.dayOfWeek === -1);
    if (tplAllDays)
      return {
        minStaff: tplAllDays.minStaff,
        requiresNonSupervised: tplAllDays.requiresNonSupervised,
      };
  }
  const fallback = rules.find((r) => r.templateId === null && r.dayOfWeek === -1);
  if (fallback)
    return { minStaff: fallback.minStaff, requiresNonSupervised: fallback.requiresNonSupervised };
  // Default — matches legacy hardcoded MIN_COVERAGE = 2
  return { minStaff: 2, requiresNonSupervised: false };
}
// ── end of frozen reference ──────────────────────────────────────────────────────────────────────

const TEMPLATE_X = "tpl-x";
const TEMPLATE_Y = "tpl-y";
const FRIDAY = 4;

/** The four rung shapes, each with its own distinct minStaff so a wrong rung is visible. */
const RUNG_SHAPES: Array<{ templateId: string | null; dayOfWeek: number }> = [
  { templateId: TEMPLATE_X, dayOfWeek: FRIDAY }, // 1 template + day
  { templateId: null, dayOfWeek: FRIDAY }, // 2 all templates + day
  { templateId: TEMPLATE_X, dayOfWeek: -1 }, // 3 template + all days
  { templateId: null, dayOfWeek: -1 }, // 4 all templates + all days
];

function rule(
  salonId: string | null,
  shape: { templateId: string | null; dayOfWeek: number },
  minStaff: number,
  requiresNonSupervised = false,
): CoverageRuleCandidate {
  return { salonId, ...shape, minStaff, requiresNonSupervised };
}

/** Every subset of the four rung shapes as tenant-wide rules, minStaff 10, 20, 30, 40 by rung. */
function tenantWideSubsets(): CoverageRuleCandidate[][] {
  const subsets: CoverageRuleCandidate[][] = [];
  for (let mask = 0; mask < 1 << RUNG_SHAPES.length; mask++) {
    subsets.push(
      RUNG_SHAPES.flatMap((shape, i) =>
        mask & (1 << i) ? [rule(null, shape, (i + 1) * 10, i % 2 === 0)] : [],
      ),
    );
  }
  return subsets;
}

const TEMPLATES: Array<string | null> = [TEMPLATE_X, TEMPLATE_Y, null];
const SALONS_IN_VIEW: Array<string | null> = [null, "s1"];

describe("pickCoverageRule (Issue #647)", () => {
  it("equals the frozen pre-#647 picker for every tenant-wide rule set, template, weekday and salon in view", () => {
    const subsets = tenantWideSubsets();
    expect(subsets.length).toBe(16);
    let compared = 0;
    for (const rules of subsets) {
      for (const templateId of TEMPLATES) {
        for (let dow = 0; dow <= 6; dow++) {
          for (const salon of SALONS_IN_VIEW) {
            expect(pickCoverageRule(rules, salon, templateId, dow)).toEqual(
              legacyPickRule(rules, templateId, dow),
            );
            compared++;
          }
        }
      }
    }
    expect(compared).toBe(16 * 3 * 7 * 2);
  });

  it("rules of another salon change no result for the salon in view or for no salon", () => {
    for (const rules of tenantWideSubsets()) {
      const withOther = [
        ...RUNG_SHAPES.map((shape, i) => rule("s2", shape, 90 + i, true)),
        ...rules,
      ];
      for (const templateId of TEMPLATES) {
        for (let dow = 0; dow <= 6; dow++) {
          for (const salon of SALONS_IN_VIEW) {
            expect(pickCoverageRule(withOther, salon, templateId, dow)).toEqual(
              pickCoverageRule(rules, salon, templateId, dow),
            );
          }
        }
      }
    }
  });

  it("with no salon in view every salon rule is ignored", () => {
    const rules = [rule("s1", RUNG_SHAPES[3]!, 1), rule(null, RUNG_SHAPES[3]!, 3)];
    expect(pickCoverageRule(rules, null, TEMPLATE_X, FRIDAY).minStaff).toBe(3);
    expect(pickCoverageRule([rule("s1", RUNG_SHAPES[3]!, 1)], null, null, 0)).toEqual(
      DEFAULT_COVERAGE_RULE,
    );
  });

  it.each([
    ["template + day", 0],
    ["all templates + day", 1],
    ["template + all days", 2],
    ["all templates + all days", 3],
  ])("on rung %s a rule of the salon in view beats a tenant-wide rule", (_title, index) => {
    const shape = RUNG_SHAPES[index]!;
    // The salon rule is listed AFTER the tenant-wide one: precedence, not array order, decides.
    const rules = [rule(null, shape, 5, true), rule("s1", shape, 1, false)];
    expect(pickCoverageRule(rules, "s1", TEMPLATE_X, FRIDAY)).toEqual({
      minStaff: 1,
      requiresNonSupervised: false,
    });
    expect(pickCoverageRule(rules, null, TEMPLATE_X, FRIDAY).minStaff).toBe(5);
  });

  it("a tenant-wide rule on a more specific rung beats a salon rule on a less specific rung", () => {
    const friday = { templateId: null, dayOfWeek: FRIDAY };
    const allDays = { templateId: null, dayOfWeek: -1 };
    const rules = [rule(null, friday, 5), rule("s1", allDays, 1)];
    expect(pickCoverageRule(rules, "s1", null, FRIDAY).minStaff).toBe(5);
    // On another weekday only the less specific rung matches, and there the salon rule wins.
    expect(pickCoverageRule(rules, "s1", null, 0).minStaff).toBe(1);
  });

  it("no candidate gives the default; a null template never matches a template rule", () => {
    expect(pickCoverageRule([], "s1", TEMPLATE_X, FRIDAY)).toEqual(DEFAULT_COVERAGE_RULE);
    expect(DEFAULT_COVERAGE_RULE).toEqual({ minStaff: 2, requiresNonSupervised: false });
    const templateRules = [
      rule("s1", { templateId: TEMPLATE_X, dayOfWeek: FRIDAY }, 7),
      rule("s1", { templateId: TEMPLATE_X, dayOfWeek: -1 }, 8),
    ];
    expect(pickCoverageRule(templateRules, "s1", null, FRIDAY)).toEqual(DEFAULT_COVERAGE_RULE);
    expect(pickCoverageRule(templateRules, "s1", TEMPLATE_Y, FRIDAY)).toEqual(
      DEFAULT_COVERAGE_RULE,
    );
  });
});

describe("coverageSalonInView — which salon is in view of the week coverage (D-03, D-03a)", () => {
  const WHOLE = { kind: "wholeTenant" } as const;
  const scoped = (salonIds: string[], employeeIds: string[] = []) =>
    ({ kind: "scoped", salonIds, employeeIds }) as const;

  it("the validated filter is always the salon in view", () => {
    expect(
      coverageSalonInView({ chosenSalonId: "a", activeSalonIds: ["a", "b"], reach: WHOLE }),
    ).toBe("a");
    expect(coverageSalonInView({ chosenSalonId: "a", activeSalonIds: ["a"], reach: WHOLE })).toBe(
      "a",
    );
    // the filter wins over a one-salon reach (D-03a)
    expect(
      coverageSalonInView({
        chosenSalonId: "b",
        activeSalonIds: ["a", "b"],
        reach: scoped(["a"]),
      }),
    ).toBe("b");
  });

  it("without a filter the tenant's only active salon is in view; with several or none, none", () => {
    expect(
      coverageSalonInView({ chosenSalonId: null, activeSalonIds: ["only"], reach: WHOLE }),
    ).toBe("only");
    expect(
      coverageSalonInView({ chosenSalonId: null, activeSalonIds: ["a", "b"], reach: WHOLE }),
    ).toBeNull();
    expect(
      coverageSalonInView({ chosenSalonId: null, activeSalonIds: [], reach: WHOLE }),
    ).toBeNull();
  });

  it("D-03a: a person-free reach of exactly one active salon puts that salon in view", () => {
    const active = ["a", "b"];
    expect(
      coverageSalonInView({ chosenSalonId: null, activeSalonIds: active, reach: scoped(["a"]) }),
    ).toBe("a");
    // person ids in the reach -> none
    expect(
      coverageSalonInView({
        chosenSalonId: null,
        activeSalonIds: active,
        reach: scoped(["a"], ["e1"]),
      }),
    ).toBeNull();
    // two salons -> none
    expect(
      coverageSalonInView({
        chosenSalonId: null,
        activeSalonIds: active,
        reach: scoped(["a", "b"]),
      }),
    ).toBeNull();
    // a reach salon that is not active -> none
    expect(
      coverageSalonInView({ chosenSalonId: null, activeSalonIds: active, reach: scoped(["c"]) }),
    ).toBeNull();
  });
});
