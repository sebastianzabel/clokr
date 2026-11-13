// Issue #854 (D-854-03) - the pure half of the Sonderurlaub tab of Verwalten › Regeln › Abwesenheiten: the shape
// of a rule as `GET /special-leave/rules` serves it and the bound of its day count. No runes and no `$app`
// imports on purpose; `SonderurlaubPanel.svelte` owns the list, the dialog and the requests. The server stays
// the authority (`createRuleSchema` / `updateRuleSchema` of apps/api/src/contexts/absence/api/special-leave.ts).

// A type alias, not an interface: DataTable rows must satisfy `Record<string, unknown>`.
export type SpecialLeaveRule = {
  id: string;
  name: string;
  reason: string | null;
  // Prisma serialises a Decimal as a string, so the days may arrive as "1.00".
  defaultDays: number | string;
  isStatutory: boolean;
  requiresProof: boolean;
  isActive: boolean;
};

export const RULE_DAYS_MIN = 0.5;
export const RULE_DAYS_MAX = 30;

/** The message for a day count the API would refuse (0.5 to 30), or null when it is fine. */
export function ruleDaysMessage(days: number | null | undefined): string | null {
  if (
    days === null ||
    days === undefined ||
    !Number.isFinite(days) ||
    days < RULE_DAYS_MIN ||
    days > RULE_DAYS_MAX
  ) {
    return `Gib die Tage von ${String(RULE_DAYS_MIN).replace(".", ",")} bis ${RULE_DAYS_MAX} an.`;
  }
  return null;
}
