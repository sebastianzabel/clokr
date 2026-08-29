// Phase 114 (Issue #117) — the SINGLE source of every Urlaubs-Größe that
// `apps/web/src/routes/(app)/leave/+page.svelte` displays: the six numbers of the
// „Urlaubsjahr"-Leiste (Anspruch, Übertrag Vorjahr, Genommen, Beantragt, Übertrag-Rest,
// Verbleibend) plus the two the Urlaubskonto-Karte shows (its value and the total in its
// breakdown line).
//
// Pure and dependency-free (no `$api`, `$stores`, `svelte` or component import), same
// convention as its sibling `vacation-balance.ts`, so it is unit-testable without mounting a
// route page — which matters here because NO test in `apps/web` mounts one, and acceptance
// criterion RU-05 demands a test that pins these numbers.
//
// (a) These formulas are the single source. Before Phase 114 they were eight inline `$derived`
//     expressions scattered across a 2730-line route component; "Resturlaub" could therefore
//     mean three different things on one screen without anything noticing. Do not re-inline them.
//
// (b) THE ARITHMETIC IS A VERBATIM COPY of those pre-Phase-114 expressions and must never be
//     "improved". Phase 114 is explicitly a labelling fix: „Die Zahlen sind nachweislich
//     korrekt — dies ist ausdrücklich **kein** Rechenfehler" (114-CONTEXT.md, Umfangsgrenze).
//     `__tests__/vacation-summary.test.ts` re-implements the old formulas literally and asserts
//     this function deep-equals them over a table of cases. If you change a formula here, that
//     oracle is what will stop you — do not adjust the oracle to match.
//
// (c) `remaining` and `availableTotal` are `number | null` ON PURPOSE. `remaining === null` is
//     what makes the Urlaubskonto card render the en-dash placeholder instead of a fake „0",
//     and `availableTotal === null` is what makes it omit its breakdown line entirely for an
//     employee who has no vacation entitlement row at all. Normalising either to 0 would change
//     what the user sees and would break RU-05.

import type { VacationBalance } from "./vacation-balance";

export interface VacationSummary {
  /** Jahresanspruch. */
  total: number;
  /** Übertrag aus dem Vorjahr (brutto). */
  carryOver: number;
  /** Genommen — includes provisional days at full value (Phase 107 D-13). */
  used: number;
  /** Beantragt (PENDING), already year-scoped by the caller's fetch. */
  planned: number;
  /** Ungenutzter Rest des Vorjahresübertrags. Clamped at 0. */
  carryOverRemaining: number;
  /** Verbleibend nach Genommen UND Beantragt. NOT clamped — may be negative. */
  left: number;
  /** Resturlaub: verfügbar OHNE Abzug der beantragten Tage. `null` when no balance. */
  remaining: number | null;
  /** Anspruch + Übertrag. `null` when no balance. */
  availableTotal: number | null;
}

/**
 * Derives every Urlaubs-Größe the `/leave` page renders from the mapped balance plus the
 * caller's already year-scoped PENDING vacation day count.
 *
 * `pendingVacDays` is passed through untouched — not clamped, not rounded, and NOT year-filtered
 * here: `myRequests` is fetched as `/leave/requests?year=${calYear}`, so the scoping already
 * happened at the fetch. Adding a second filter would double-scope it.
 */
export function deriveVacationSummary(
  balance: VacationBalance | null,
  pendingVacDays: number,
): VacationSummary {
  // Verbatim from `leave/+page.svelte:992-999` (pre-Phase-114).
  const total = balance?.total ?? 0;
  const carryOver = balance?.carryOver ?? 0;
  const used = balance?.used ?? 0;
  const planned = pendingVacDays;
  const carryOverRemaining = Math.max(0, carryOver - used);
  const left = total + carryOver - used - planned;
  // Verbatim from `:919-923` — the `null` branch is load-bearing, see (c) above.
  const remaining = balance ? balance.total + balance.carryOver - balance.used : null;
  // Verbatim from the card's `delta` prop at `:1146-1147`, which interpolated
  // `${vacationBalance.total + vacationBalance.carryOver}` and rendered nothing without a balance.
  const availableTotal = balance ? balance.total + balance.carryOver : null;

  return { total, carryOver, used, planned, carryOverRemaining, left, remaining, availableTotal };
}
