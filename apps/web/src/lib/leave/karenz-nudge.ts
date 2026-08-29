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
    // Phase 113 (issue #116): deliberately NOT imperative. There is no employee-side
    // submission path anywhere in Clokr — PATCH /leave/requests/:id/attest is
    // requireRole("ADMIN","MANAGER") (apps/api/src/routes/leave.ts:2037-2040), LeaveRequest
    // has no documentPath, and no type="file" input for an Attest exists in the web app.
    // The previous label used the imperative »nachreichen« and so demanded an action the
    // product does not offer anywhere. State the finding instead.
    label: count === 1 ? "1 Tag ohne Attest" : `${count} Tage ohne Attest`,
  };
}

export function karenzNudgeHref(summary: KarenzNudgeSummary): string {
  return summary.targetRequestId ? `/leave?request=${summary.targetRequestId}` : "/leave";
}

// ── Phase 113 (issue #116) — the single German source for the Attest copy ──────────────
//
// Umfangsgrenze: only Stufe 1 (honest copy/IA). A tenant-configurable submission route
// would need a new TenantConfig column, i.e. a migration, which the issue forbids. So the
// wording asserts only facts about CLOKR (verifiable in code) and offers the org route as
// a non-binding example — a hardcoded "bei der Personalabteilung einreichen" would be a
// false process claim for any tenant that does not have one.

/** Tooltip on the dashboard "Offene Vorgänge" row. */
export const KARENZ_NUDGE_TOOLTIP =
  "Krankheitstage über die Karenzzeit hinaus ohne Attest (§ 5 EFZG). Unter „Urlaub & Abwesenheit“ steht, wie du das Attest einreichst.";

/**
 * The answer to "wohin gehört das Attest?". Claim 1 is a fact about Clokr (no upload path
 * exists). Claim 2 is a fact about Clokr's data model: the finding is cleared solely by
 * `attestPresent`, which only PATCH /leave/requests/:id/attest (ADMIN/MANAGER) sets — see
 * apps/api/src/utils/find-karenz-overrun-days.ts:96-104. Neither claim guesses the tenant's
 * internal process.
 */
export const KARENZ_SUBMISSION_HINT =
  "Clokr nimmt keine Atteste entgegen – hier gibt es keinen Upload. Reiche dein Attest auf dem in deinem Betrieb üblichen Weg ein, zum Beispiel bei deiner Führungskraft oder der Personalabteilung. Sobald es dort eingetragen ist, verschwindet dieser Hinweis.";

/** Phase 104 D-21, restated for the person it concerns: the finding is a hint, not a block. */
export const KARENZ_NO_BLOCK_HINT =
  "Dieser Hinweis blockiert nichts – Krankmeldung, Zeiterfassung und Monatsabschluss laufen normal weiter.";

/** Short form for the „Kein Attest" row badge on /leave, where only a title fits. */
export const KARENZ_BADGE_TOOLTIP =
  "Kein Attest in Clokr hinterlegt. Clokr nimmt keine Atteste entgegen – reiche es auf dem in deinem Betrieb üblichen Weg ein (z. B. Führungskraft oder Personalabteilung).";

/**
 * Every distinct affected day across all overruns, ascending. The nudge only needs the
 * count; the destination panel (plan 02) needs the days themselves, and it must not
 * re-derive them from the year-scoped /leave list — see the phase's deferred-items.md.
 */
export function karenzOverrunDays(res: KarenzOverrunResponse | null | undefined): string[] {
  const distinct = new Set<string>();
  for (const o of res?.overruns ?? []) for (const d of o.days) distinct.add(d);
  return [...distinct].sort();
}

/** "2026-08-05" → "05.08.2026". Returns the input unchanged if it is not an ISO day. */
export function formatKarenzDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
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
