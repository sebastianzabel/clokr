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
  // Phase 107-07 (D-12/D-13): the portion of `used` that is still provisional (SHIFT_BASED,
  // no roster yet for at least one day of the request — see GET /entitlements/:employeeId's
  // own provisionalUsedDays doc comment). `used` itself is intentionally UNCHANGED by this
  // field — it already counts provisional days at full value (D-13) and every existing reader
  // of `used` (e.g. the page's own `Verfügbar`/`vacRemaining` formula) keeps working exactly
  // as before. The page derives "Verbraucht (bestätigt)" as `used - provisionalUsed`.
  provisionalUsed: number;
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
  // Phase 107-07: absent on any pre-107-07 response shape (older cached fixtures, other
  // leave types) — defaulted to 0 below, never left undefined.
  provisionalUsedDays?: number;
}

/**
 * The ONE place that turns an entitlement API row into the page's `vacationBalance`
 * view model. Every call site must go through this function — do not re-implement
 * the mapping inline again (that is exactly how this bug happened).
 *
 * `section9Movements` defaults to `[]` (not left `undefined`) so the template's
 * `.length` access can never throw, even if a future caller forgets to check.
 * `provisionalUsed` defaults to `0` the same way, for the same reason (Phase 107-07).
 */
export function mapVacationBalance(
  vac: VacationEntitlementRow | undefined,
): VacationBalance | null {
  if (!vac) return null;
  return {
    total: Number(vac.totalDays),
    used: Number(vac.usedDays),
    provisionalUsed: Number(vac.provisionalUsedDays ?? 0),
    carryOver: Number(vac.effectiveCarryOverDays ?? vac.carriedOverDays),
    carryOverDeadline: vac.carryOverDeadline,
    section9Movements: vac.section9Movements ?? [],
  };
}

// ── Phase 107-07 (D-19/D-21): the request-row "Angepasst" badge ────────────────────────────
// Same "pure, dependency-free module" convention as the mapper above — no svelte/store import,
// unit-testable without mounting either `leave/+page.svelte` or `team/leave/+page.svelte`, and
// shared by BOTH of those pages so the up/down badge decision is not implemented twice.

/** Shape of `lastDaysAdjustment` on a `GET /leave/requests` row, or `null` if never adjusted. */
export interface LastDaysAdjustment {
  oldDays: number;
  newDays: number;
  direction: "up" | "down";
  /** ISO datetime string (`AuditLog.createdAt.toISOString()`), NOT date-only. */
  at: string;
}

/** Pre-resolved view model for the "Angepasst" badge — the template only renders this. */
export interface AdjustmentBadge {
  direction: "up" | "down";
  /** `badge badge-yellow` (up, D-21 prominent) or `badge badge-gray` (down, quiet). */
  badgeClass: string;
  icon: "▲" | "▼";
  /** D-21: only the upward delta is rendered bold. */
  bold: boolean;
  /** Always positive — the template prefixes the sign matching `direction`. */
  delta: number;
  /** Fixed-shape sentence, UI-SPEC §3, exactly 3 interpolated values — cannot overflow. */
  tooltip: string;
}

/** `"2026-08-27T14:36:00.000Z"` -> `"27.08.2026"` — same DD.MM.YYYY shape as the page's own
 * `fmtDate()`, but slices the date portion first so a full ISO datetime string (what
 * `AuditLog.createdAt.toISOString()` produces) works too, not just a date-only string. */
function formatGermanDate(isoDateTime: string): string {
  const [y, m, d] = isoDateTime.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

/**
 * Resolves a `lastDaysAdjustment` API value into the badge the request row renders — `null`
 * input (never adjusted) returns `null` (render nothing). The up/down copy, tone and bold-ness
 * are UI-SPEC §3's asymmetric pair (D-21); this is the ONE place that decision is made, reused
 * by both `leave/+page.svelte` and `team/leave/+page.svelte`.
 */
export function resolveAdjustmentBadge(
  adjustment: LastDaysAdjustment | null | undefined,
): AdjustmentBadge | null {
  if (!adjustment) return null;
  const isUp = adjustment.direction === "up";
  const delta = Math.abs(adjustment.newDays - adjustment.oldDays);
  return {
    direction: adjustment.direction,
    badgeClass: isUp ? "badge badge-yellow" : "badge badge-gray",
    icon: isUp ? "▲" : "▼",
    bold: isUp,
    delta,
    tooltip:
      `Alt: ${adjustment.oldDays} Tage → Neu: ${adjustment.newDays} Tage · ` +
      `Auslöser: Roster-Planung · ${formatGermanDate(adjustment.at)}`,
  };
}
