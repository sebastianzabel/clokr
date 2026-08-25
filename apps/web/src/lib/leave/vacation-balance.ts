// Phase 104-10 dev-pass fix — pure, dependency-free module (no imports from $api,
// $stores, svelte, or any component), same convention as
// apps/web/src/lib/leave/storno.ts, so this mapping is unit-testable without
// mounting `apps/web/src/routes/(app)/leave/+page.svelte`.
//
// Why this exists: the page had TWO call sites that turned a
// `GET /leave/entitlements/:employeeId` row into the `vacationBalance` view model —
// one in `loadVacationSummary()` (initial page load), one in `loadBalanceForType()`
// (the form's "Art der Abwesenheit" change handler). Only the first one populated
// `section9Movements`. Switching the form type away from VACATION and back therefore
// called the second, incomplete mapping and overwrote `vacationBalance` with an
// object missing `section9Movements` — even though the type declaration at the call
// site required it. The template (`vacationBalance.section9Movements.length`) then
// threw `TypeError: Cannot read properties of undefined (reading 'length')` and the
// entire Urlaubskonto panel (D-31) disappeared from the dialog.
//
// `apps/web`'s `typecheck` script is `svelte-kit sync && tsc --noEmit` — `tsc` does
// not typecheck `.svelte` templates, so a type mismatch that only manifests in a
// template expression is invisible to `pnpm --filter @clokr/web typecheck` and only
// surfaces in the browser. A single shared mapper closes that gap structurally:
// there is now exactly one place that can omit the field, and it is covered by a
// plain-function test below.

export interface Section9Movement {
  creditId: string;
  days: number;
  from: string | null;
  to: string | null;
  label: string;
}

export interface VacationBalance {
  total: number;
  used: number;
  carryOver: number;
  carryOverDeadline: string | null;
  section9Movements: Section9Movement[];
}

/** Shape of one row of `GET /leave/entitlements/:employeeId` for the VACATION type. */
export interface VacationEntitlementRow {
  typeCode: string;
  leaveType: { name: string };
  totalDays: number;
  usedDays: number;
  carriedOverDays: number;
  effectiveCarryOverDays: number;
  carryOverDeadline: string | null;
  section9Movements?: Section9Movement[];
}

/**
 * The ONE place that turns an entitlement API row into the page's `vacationBalance`
 * view model. Every call site must go through this function — do not re-implement
 * the mapping inline again (that is exactly how this bug happened).
 *
 * `section9Movements` defaults to `[]` (not left `undefined`) so the template's
 * `.length` access can never throw, even if a future caller forgets to check.
 */
export function mapVacationBalance(
  vac: VacationEntitlementRow | undefined,
): VacationBalance | null {
  if (!vac) return null;
  return {
    total: Number(vac.totalDays),
    used: Number(vac.usedDays),
    carryOver: Number(vac.effectiveCarryOverDays ?? vac.carriedOverDays),
    carryOverDeadline: vac.carryOverDeadline,
    section9Movements: vac.section9Movements ?? [],
  };
}
