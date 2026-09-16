/**
 * Phase 100B Plan 11 (Wave 5) — Abwesenheiten's `EmployeeVocationalSchoolPattern` facade.
 *
 * ADR 0001 rule 3: every caller outside this context reaches `EmployeeVocationalSchoolPattern`
 * through one of the functions below, never through `prisma.employeeVocationalSchoolPattern`/
 * `tx.employeeVocationalSchoolPattern` directly. Added to `convertedModels` in
 * `apps/api/scripts/foreign-context-access-exceptions.json` in the same commit.
 *
 * D-07: every export's first parameter is `db: Prisma.TransactionClient`.
 *
 * `contexts/absence/jarbschg.ts`, `load-bs-slot-overrides.ts`, `vocational-school-generator.ts`
 * and `api/vocational-school-pattern.ts` keep their OWN direct access — they sit INSIDE this
 * context (`area === owner`, never foreign per `measure-foreign-context-access.ts`), so nothing
 * about their queries changes here.
 *
 * ── A20 — "the" active pattern for a date, Phase 103's determinism rule made an assertion ──────
 * `working-time-account/vocational-school-saldo.ts:208` (per-date BS-minutes resolution) and
 * `:331` (per-ISO-week Unterrichtszeit map) both took "the" active pattern via an UNORDERED
 * `findFirst` before Phase 103. Both sites' `where` shape (`isActive`, `validFrom`/`validUntil`
 * window) and `orderBy` (`BS_PATTERN_ORDER_BY`) are IDENTICAL — the only difference is which
 * reference date the caller passes (`dayStart` = midnight of the target day; `monday` = midnight
 * of that day's ISO week) — so this is genuinely ONE function, not two masquerading as one (unlike
 * A21 below). `at` is taken as an already-computed reference `Date` — the day-vs-Monday choice
 * stays where it always lived, in `vocational-school-saldo.ts`'s own two callers, unchanged.
 *
 * The two callers' `select` differ (`:208` wants the four `bsSlot*` minute overrides; `:331` wants
 * `unterrichtsMinutenByDow`) — a projection-width difference, not a `where` divergence (R-C), so
 * one function selects the union of both and each caller reads only the fields it needs, same
 * precedent as `leave-types.ts`'s A18 `listLeaveTypes`.
 *
 * `employee: { tenantId }` is added to the `where` — the two pre-move call sites carried NO tenant
 * constraint at all (a proven no-op strengthening: `employeeId` is already resolved from an
 * already-tenant-validated employee by both callers before this function is ever reached, same
 * reasoning as `entitlements.ts`'s A13 `getEntitlementsForEmployee`).
 *
 * ── A21 — the FastFinding: two call sites that look alike and are NOT the same question ────────
 * This plan's own call-site table names ONE function, `listActiveBsPatterns(db, tenantId, from,
 * to)`, for `scheduling/api/shifts.ts:958` and `platform/api/admin/school-holidays.ts:56`. Reading
 * both `where` clauses (not just their shape) shows they diverge:
 *   - `shifts.ts:958` wants patterns whose validity WINDOW overlaps a specific week
 *     (`validFrom: { lte: sunday }`, `OR: [{validUntil:null},{validUntil:{gte:monday}}]`) — no
 *     filter on `federalStateOverride`.
 *   - `school-holidays.ts:56` wants every `isActive` pattern with a non-null
 *     `federalStateOverride`, with NO date-window filter at all (it needs to know every federal
 *     state a Pendler-Azubi's pattern might ever require holiday data for, not which ones apply to
 *     one particular week).
 * These are two different questions sharing a coincidental resemblance — merging them the way the
 * plan's own table proposed would be exactly R-C's warning ("read the real where, not just the
 * shape of the call") and exactly the class of mistake Plan 08 made on 5 of 9 claimed-shared
 * sites. Per this plan's own H1 protocol for A20 (generalised here since the actual divergence
 * showed up on A21 instead): NOT merged. {@link listActiveBsPatternsForWeek} keeps the plan's
 * literal `(db, tenantId, from, to)` signature and shape for `shifts.ts`;
 * {@link listActiveBsPatternsWithFederalStateOverride} is `school-holidays.ts`'s own, separately
 * named function with no date parameters at all — not a fabricated no-op `from`/`to`. Recorded as
 * a decision (not a fix — D-13 forbids "improving" either query) in this plan's SUMMARY and as a
 * German comment on GitHub issue #100.
 */
import type { FederalState, Prisma } from "@clokr/db";
import { BS_PATTERN_ORDER_BY } from "../vocational-school-pattern-order";

// ── A20 — the active pattern for a reference date ────────────────────────────────────────────

export interface ActiveBsPatternSlots {
  bsSlotFirstLongDayMinutes: number | null;
  bsSlotSecondLongDayMinutes: number | null;
  bsSlotShortDayMinutes: number | null;
  bsSlotBlockWeekMinutes: number | null;
  unterrichtsMinutenByDow: Prisma.JsonValue;
}

/**
 * A20 — the `isActive` `EmployeeVocationalSchoolPattern` covering `at` (`validFrom <= at` AND
 * (`validUntil` is null OR `validUntil >= at`)), ordered by {@link BS_PATTERN_ORDER_BY} (Phase 103
 * — deterministic across repeated calls even when two rows share `validFrom`). `null` when no such
 * pattern exists (both callers treat that as "delegate to the TenantConfig layer" — unchanged).
 * Sites: `vocational-school-saldo.ts`'s `getVocationalSchoolMinutesForDate` (`at` = midnight of the
 * target day) and `bsUnterrichtsMinutesByDateForIsoWeek` (`at` = midnight of that week's Monday).
 */
export async function getActiveBsPattern(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  at: Date,
): Promise<ActiveBsPatternSlots | null> {
  return db.employeeVocationalSchoolPattern.findFirst({
    where: {
      employeeId,
      employee: { tenantId },
      isActive: true,
      validFrom: { lte: at },
      OR: [{ validUntil: null }, { validUntil: { gte: at } }],
    },
    orderBy: BS_PATTERN_ORDER_BY,
    select: {
      bsSlotFirstLongDayMinutes: true,
      bsSlotSecondLongDayMinutes: true,
      bsSlotShortDayMinutes: true,
      bsSlotBlockWeekMinutes: true,
      unterrichtsMinutenByDow: true,
    },
  });
}

// ── A21a — active patterns overlapping a week (shifts.ts) ────────────────────────────────────

export interface WeekBsPattern {
  employeeId: string;
  federalStateOverride: FederalState | null;
}

/**
 * A21a — every `isActive` pattern for `tenantId` whose validity window overlaps `[from, to]`,
 * ordered by {@link BS_PATTERN_ORDER_BY} (Phase 103, so a per-employee "first wins" merge downstream
 * is deterministic). Site: `scheduling/api/shifts.ts`'s `/shifts/week` federal-state resolution.
 * See the module header for why this is NOT the same function as
 * {@link listActiveBsPatternsWithFederalStateOverride}.
 */
export async function listActiveBsPatternsForWeek(
  db: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<WeekBsPattern[]> {
  return db.employeeVocationalSchoolPattern.findMany({
    where: {
      employee: { tenantId },
      isActive: true,
      validFrom: { lte: to },
      OR: [{ validUntil: null }, { validUntil: { gte: from } }],
    },
    orderBy: BS_PATTERN_ORDER_BY,
    select: { employeeId: true, federalStateOverride: true },
  });
}

// ── A21b — active patterns with a federal-state override (school-holidays.ts) ────────────────

/**
 * A21b — every `isActive` pattern for `tenantId` with a non-null `federalStateOverride`, with NO
 * date-window filter (see the module header — this answers "which federal states might this
 * tenant's Pendler-Azubis ever need holiday data for", not "which patterns apply to one week").
 * Site: `platform/api/admin/school-holidays.ts`'s `POST /refresh`.
 */
export async function listActiveBsPatternsWithFederalStateOverride(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<Array<{ federalStateOverride: FederalState | null }>> {
  return db.employeeVocationalSchoolPattern.findMany({
    where: {
      isActive: true,
      employee: { tenantId },
      federalStateOverride: { not: null },
    },
    select: { federalStateOverride: true },
  });
}
