// Issue #647 (D-09, D-10) — presentation of a coverage rule's salon on /admin/shifts, kept out of
// the route page so every rule is unit-tested (a route page cannot be mounted: no `$app` alias).
//
// The API validates every `salonId` and answers one 404 for a foreign, unknown or inactive salon;
// nothing here is an access boundary. The name is display only and is never compared: the control
// value of the select is the salon id. The rules mirror the #541 terminal cell: the column shows
// while salon options are shown or a rule names a salon, and a deactivated current salon stays a
// choice, marked, so saving other fields never moves the rule.

/** The salon fields of a coverage-rule list row, as served by `GET /shifts/coverage-rules`. */
export interface CoverageRuleSalonFields {
  salonId: string | null;
  salonName: string | null;
  salonActive: boolean | null;
}

export const COVERAGE_RULE_ALL_SALONS_OPTION = "Alle Salons (mandantenweit)";
export const COVERAGE_RULE_ALL_SALONS_CELL = "Alle Salons";
export const COVERAGE_RULE_SALON_INACTIVE_BADGE = "Salon deaktiviert";

export interface CoverageRuleSalonCell {
  label: string;
  inactive: boolean;
}

export interface CoverageRuleSalonChoice {
  value: string;
  label: string;
}

/** The text of the salon cell of one rule row. */
export function coverageRuleSalonCell(rule: CoverageRuleSalonFields): CoverageRuleSalonCell {
  if (rule.salonId === null) return { label: COVERAGE_RULE_ALL_SALONS_CELL, inactive: false };
  return { label: rule.salonName ?? "Salon", inactive: rule.salonActive === false };
}

/** Whether the list shows a salon column: with salon options, or when any rule names a salon. */
export function showCoverageSalonColumn(
  salonOptionsShown: boolean,
  rules: readonly CoverageRuleSalonFields[],
): boolean {
  return salonOptionsShown || rules.some((rule) => rule.salonId !== null);
}

/**
 * The choices of the salon select: the tenant-wide choice first (empty value), then the given
 * (active) salons in the given order. A salon of the rule being edited that is not among them
 * (deactivated) is appended, marked, so it stays selected.
 */
export function coverageRuleSalonChoices(
  salons: readonly { id: string; name: string }[],
  editing: CoverageRuleSalonFields | null,
): CoverageRuleSalonChoice[] {
  const choices: CoverageRuleSalonChoice[] = [
    { value: "", label: COVERAGE_RULE_ALL_SALONS_OPTION },
    ...salons.map((salon) => ({ value: salon.id, label: salon.name })),
  ];
  if (editing && editing.salonId !== null && !salons.some((s) => s.id === editing.salonId)) {
    const name = editing.salonName ?? "Salon";
    choices.push({
      value: editing.salonId,
      label: editing.salonActive === false ? `${name} (deaktiviert)` : name,
    });
  }
  return choices;
}

/**
 * The salon part of the save payload. While the select is hidden the key is omitted, so a create
 * stays tenant-wide and an edit leaves the stored salon untouched; shown, "" means tenant-wide.
 */
export function coverageRuleSalonPayload(
  selectShown: boolean,
  value: string,
): { salonId?: string | null } {
  if (!selectShown) return {};
  return { salonId: value === "" ? null : value };
}
