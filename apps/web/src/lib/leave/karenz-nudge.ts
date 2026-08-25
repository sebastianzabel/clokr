/**
 * Phase 104 gap closure (D-21) — presentation helpers for the § 5 EFZG Karenztage hint.
 *
 * The RULE (how many days without an Attest are an overrun) lives server-side in
 * apps/api/src/utils/find-karenz-overrun-days.ts and is deliberately NOT duplicated here:
 * a client copy could drift from the legal reading. This module only counts, picks a deep-link
 * target and formats German copy.
 */

export interface KarenzOverrunRow {
  leaveRequestId: string;
  days: string[]; // ISO YYYY-MM-DD, tenant-local
}

export interface KarenzOverrunResponse {
  graceDays: number;
  overruns: KarenzOverrunRow[];
  totalDays: number;
}

export interface KarenzNudgeSummary {
  count: number;
  earliestDay: string | null;
  targetRequestId: string | null;
  label: string;
}

export const KARENZ_NUDGE_EMPTY: KarenzNudgeSummary = {
  count: 0,
  earliestDay: null,
  targetRequestId: null,
  label: "",
};

export function summarizeKarenzOverrun(
  res: KarenzOverrunResponse | null | undefined,
): KarenzNudgeSummary {
  const overruns = res?.overruns ?? [];
  const distinct = new Set<string>();
  for (const o of overruns) for (const d of o.days) distinct.add(d);
  const count = distinct.size;
  if (count === 0) return KARENZ_NUDGE_EMPTY;

  // ISO yyyy-MM-dd sorts lexicographically, so the smallest string is the oldest day.
  const earliestDay = [...distinct].reduce((a, b) => (a < b ? a : b));
  const owner = overruns.find((o) => o.days.includes(earliestDay));
  return {
    count,
    earliestDay,
    targetRequestId: owner?.leaveRequestId ?? null,
    label: count === 1 ? "1 Tag: Attest nachreichen" : `${count} Tage: Attest nachreichen`,
  };
}

export function karenzNudgeHref(summary: KarenzNudgeSummary): string {
  return summary.targetRequestId ? `/leave?request=${summary.targetRequestId}` : "/leave";
}

/**
 * Phase 104 gap closure (D-21, follow-up) — the dashboard's "Keine offenen Vorgänge" empty state
 * must only render when there is genuinely nothing to show. `openItems.total` comes from
 * `GET /dashboard/open-items` and has NO knowledge of either client-side nudge rendered below it
 * in the same list (this Karenz nudge, and the pre-existing Phase-92 unconfirmed-break-days
 * nudge) — an employee whose ONLY outstanding item is a Karenz overrun (or an unconfirmed break)
 * would otherwise see the empty state while a nudge silently rendered underneath it, in a branch
 * that never runs. Extracted here (rather than inlined in the page) so it stays unit-testable
 * without mounting the heavy dashboard page.
 */
export function hasNoOpenItems(
  openItemsTotal: number,
  karenzCount: number,
  unconfirmedBreakDays: number,
): boolean {
  return openItemsTotal === 0 && karenzCount === 0 && unconfirmedBreakDays === 0;
}
