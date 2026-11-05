/**
 * Issue #647 (D-04/D-05) — the ONE place a day's coverage rule is chosen.
 *
 * Candidates are the tenant-wide rules (`salonId` null) plus the rules of the salon in view. The
 * pre-#647 specificity ladder is unchanged:
 *   1. template + day   2. all templates + day   3. template + all days   4. all templates + all days
 *   5. DEFAULT_COVERAGE_RULE
 * Within each rung a rule of the salon in view beats a tenant-wide one, never across rungs: a
 * tenant-wide rule on a more specific rung still beats a salon rule on a less specific rung. With no
 * salon in view only the tenant-wide rules decide, which is exactly the behaviour before #647.
 *
 * Pure: no imports, no model access. Rule rows of other salons may be passed in and are ignored.
 */

export interface CoverageRuleCandidate {
  /** null = tenant-wide */
  salonId: string | null;
  templateId: string | null;
  /** 0=Mo..6=So; -1 = all days */
  dayOfWeek: number;
  minStaff: number;
  requiresNonSupervised: boolean;
}

export interface PickedCoverageRule {
  minStaff: number;
  requiresNonSupervised: boolean;
}

/** No rule matches — matches the legacy hardcoded MIN_COVERAGE = 2. */
export const DEFAULT_COVERAGE_RULE: Readonly<PickedCoverageRule> = Object.freeze({
  minStaff: 2,
  requiresNonSupervised: false,
});

export function pickCoverageRule(
  rules: readonly CoverageRuleCandidate[],
  salonInView: string | null,
  templateId: string | null,
  dayOfWeek: number,
): PickedCoverageRule {
  // Candidate set: tenant-wide rules, plus the salon in view's own. Another salon's rule never acts.
  const candidates = rules.filter(
    (r) => r.salonId === null || (salonInView !== null && r.salonId === salonInView),
  );
  const rung = (matches: (r: CoverageRuleCandidate) => boolean): PickedCoverageRule | undefined => {
    const hit =
      candidates.find((r) => r.salonId !== null && matches(r)) ??
      candidates.find((r) => r.salonId === null && matches(r));
    return hit
      ? { minStaff: hit.minStaff, requiresNonSupervised: hit.requiresNonSupervised }
      : undefined;
  };

  if (templateId) {
    const exact = rung((r) => r.templateId === templateId && r.dayOfWeek === dayOfWeek);
    if (exact) return exact;
  }
  const allTemplatesDay = rung((r) => r.templateId === null && r.dayOfWeek === dayOfWeek);
  if (allTemplatesDay) return allTemplatesDay;
  if (templateId) {
    const templateAllDays = rung((r) => r.templateId === templateId && r.dayOfWeek === -1);
    if (templateAllDays) return templateAllDays;
  }
  const allTemplatesAllDays = rung((r) => r.templateId === null && r.dayOfWeek === -1);
  if (allTemplatesAllDays) return allTemplatesAllDays;
  return { ...DEFAULT_COVERAGE_RULE };
}
