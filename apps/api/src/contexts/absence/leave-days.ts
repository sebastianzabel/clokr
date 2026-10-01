// Leave-day resolution, holiday mapping and vacation-day booking — lifted out of ./api/leave.ts in
// Phase 101B (Issue #101). These four functions are consumed by scheduling/api/shifts.ts and
// services/phorest/sync-shifts.ts; under ADR 0001 they must reach them through absence/index.ts,
// and an index.ts that re-exports a ROUTE module drags the whole route file's import set onto the
// public surface. The bodies are unchanged — this was a relocation, not a rewrite.
//
// resolveContractWorkDaysPerWeek() below remains the ONLY place the SHIFT_BASED contractual-count
// fallback chain lives (Phase 107, D-04). CLAUDE.md § Schedule Types cites this file for it.

import { FastifyInstance } from "fastify";
import { Prisma } from "@clokr/db";
import {
  calculateWorkDays,
  findDefaultSalon,
  holidaysAtWorkLocation,
  holidaysForSalon,
} from "../platform"; // Phase 71b (issue #71, D-04) — the engine/state map are gone from this file, see getHolidayMap()
import { getWorkedEntriesInRange } from "../time-tracking"; // Phase 71b (issue #71) — T2, the work-location rule's entry half
import { countShiftBasedLeaveDays, leaveDaysPerWeek } from "./vacation-calc"; // Phase 107 (D-04/D-09), Issue #417; leaveDaysPerWeek Issue #429 (D-01/D-02) — the shared per-week kernel, Phase 430-06
import { preserveCarryOverDeadline } from "./illness-carryover-guard"; // Phase 104, Issue #445 (D-17)
import { getApprovedLeaveOverlapping } from "./facade/leave-requests"; // Phase 430 (D-08) — this file is INSIDE contexts/absence, no boundary crossing
import type { LeaveEntitlement } from "@clokr/db";
import { computeRegularVacationDays } from "./vacation-calc";
import { ensureVacationEntitlementForYear } from "./facade/entitlements";
import { getLeaveTypeByCode } from "./facade/leave-types";
import { writeEntitlementAudit } from "./entitlement-audit"; // Issue #445
import { listConfirmedSection9CreditsByRequest } from "./section9-credit-days"; // Issue #445 (D-10)

// Prisma client shape shared by `app.prisma` (top-level) and the `tx` handle inside
// `$transaction(async (tx) => ...)` — mirrors ./api/leave.ts's own private DbClient alias.
type DbClient = FastifyInstance["prisma"] | Prisma.TransactionClient;

/**
 * Lädt das aktuell gültige workDays-Set für einen Mitarbeiter.
 *
 * Reihenfolge:
 * 1. Für FIXED_SCHEDULE: aus per-Tag-Soll abgeleitet (Stunden > 0 = Arbeitstag).
 *    Das erlaubt individuelle Verteilung wie Frisör Di-Sa ohne separate UI.
 * 2. Sonst: WorkSchedule.workDays (Pro-MA-Override aus /admin/vacation).
 * 3. Sonst: TenantConfig.defaultWorkDays.
 * 4. Sonst: Mo-Fr.
 */
export async function resolveWorkDays(
  prisma: DbClient,
  employeeId: string,
  tenantId: string,
): Promise<number[]> {
  const [ws, cfg] = await Promise.all([
    prisma.workSchedule.findFirst({
      where: { employeeId },
      orderBy: { validFrom: "desc" },
    }),
    prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { defaultWorkDays: true },
    }),
  ]);
  if (ws) {
    // FIXED_SCHEDULE: per-Tag-Soll ist die präziseste Quelle (Frisör Di-Sa wird hier sichtbar)
    if (ws.type === "FIXED_SCHEDULE") {
      const fields: Array<[number, number]> = [
        [0, Number(ws.sundayHours)],
        [1, Number(ws.mondayHours)],
        [2, Number(ws.tuesdayHours)],
        [3, Number(ws.wednesdayHours)],
        [4, Number(ws.thursdayHours)],
        [5, Number(ws.fridayHours)],
        [6, Number(ws.saturdayHours)],
      ];
      const derived = fields
        .filter(([, h]) => h > 0)
        .map(([d]) => d)
        .sort((a, b) => a - b);
      if (derived.length > 0) return derived;
    }
    if (ws.workDays && ws.workDays.length > 0) return ws.workDays;
  }
  if (cfg?.defaultWorkDays && cfg.defaultWorkDays.length > 0) return cfg.defaultWorkDays;
  return [1, 2, 3, 4, 5];
}

// ── Phase 107 (D-04/D-09): SHIFT_BASED-aware leave-day resolution ─────────────────────────

/**
 * The pure resolution chain behind `resolveContractWorkDaysPerWeek()` (Phase 107, D-04; extracted
 * Issue #429, D-03). This function IS the chain — `resolveContractWorkDaysPerWeek()` below is
 * just "fetch, then delegate" — and it is the ONLY place this chain may be written out: no other
 * reader (not `avgWorkMinutesCore`, not any route handler, not the saldo side of Issue #429) may
 * rebuild it inline; every caller either invokes this function (directly, or indirectly via
 * `resolveContractWorkDaysPerWeek()`) or receives its result as a parameter.
 *
 * Resolution chain, in this exact order:
 *   1. `schedule.contractWorkDaysPerWeek`, when non-null (the SHIFT_BASED contractual count,
 *      D-01 — populated by the write path settings.ts/employees.ts own once a SHIFT_BASED row
 *      is created or saved).
 *   2. `schedule.workDays.length`, when non-empty (pre-107 legacy rows, and every other
 *      schedule type).
 *   3. `tenantDefaultWorkDays.length`, when non-empty.
 *   4. 5.
 *
 * `schedule` is `null` when no `WorkSchedule` row exists yet (mirrors
 * `resolveContractWorkDaysPerWeek()`'s own `ws` being `null`).
 */
export function contractWorkDaysPerWeekFrom(
  schedule: { contractWorkDaysPerWeek?: number | null; workDays?: number[] | null } | null,
  tenantDefaultWorkDays?: number[] | null,
): number {
  if (schedule) {
    if (schedule.contractWorkDaysPerWeek != null) return schedule.contractWorkDaysPerWeek;
    if (schedule.workDays && schedule.workDays.length > 0) return schedule.workDays.length;
  }
  if (tenantDefaultWorkDays && tenantDefaultWorkDays.length > 0)
    return tenantDefaultWorkDays.length;
  return 5;
}

/**
 * Resolves an employee's contractual workday count (Phase 107, D-04).
 *
 * This is the DB-fetching side only — the actual resolution chain lives in
 * {@link contractWorkDaysPerWeekFrom} (Issue #429, D-03), which this function delegates to
 * verbatim after fetching the latest `WorkSchedule` row and the tenant's `defaultWorkDays`.
 *
 * Mirrors resolveWorkDays()'s shape verbatim (same Promise.all over the latest WorkSchedule and
 * the TenantConfig row) — the two resolvers are deliberately parallel, not merged, because they
 * answer different questions ("how many days" vs. "which days").
 */
export async function resolveContractWorkDaysPerWeek(
  prisma: DbClient,
  employeeId: string,
  tenantId: string,
): Promise<number> {
  const [ws, cfg] = await Promise.all([
    prisma.workSchedule.findFirst({
      where: { employeeId },
      orderBy: { validFrom: "desc" },
    }),
    prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { defaultWorkDays: true },
    }),
  ]);
  return contractWorkDaysPerWeekFrom(ws, cfg?.defaultWorkDays);
}

// German 2-letter weekday abbreviation, indexed by `Date.getUTCDay()` (0=So..6=Sa). Index 0
// (Sunday) is never read by getShiftBasedLeaveDaysForWeek() below — § 3 Abs. 2 BUrlG excludes it.
const GERMAN_WEEKDAY_ABBR = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"] as const;

/**
 * Approved leave days AND which weekdays they fall on, for exactly one employee's one ISO week
 * (Mon..Sun, `weekStart`/`weekEnd` as UTC-midnight Dates spanning that week).
 *
 * Phase 430-06 (follow-up to #437/#429 merging): this is now a thin DB-fetching wrapper around
 * `leaveDaysPerWeek()` (Issue #429, D-01/D-02 — the shared per-week kernel the saldo side
 * [`working-time-account`, plan 429-02] also uses) — it no longer re-implements the per-week
 * BUrlG day-counting itself (the prior version summed `countShiftBasedLeaveDays()` PER REQUEST,
 * which would double-count a calendar date covered by two overlapping requests; `leaveDaysPerWeek`
 * computes the UNION of dates across all rows instead, so this fold also closes that latent,
 * never-observed-in-practice edge case). `weekdays` is derived from the single matching
 * `LeaveWeek.dayShares` entry (any date with a non-zero share), not recomputed independently, so
 * the two can never disagree about what counts.
 *
 * Real holidays (via `getHolidayMap`) are passed in, NOT an empty set — unlike the saldo side's
 * own `leaveDaysPerWeek()` call (D-05: SHIFT_BASED contract Soll is deliberately not holiday-
 * reduced for payroll purposes). This function answers a DIFFERENT question — "how many vacation
 * days does this week cost, for display" — which IS holiday-aware by BUrlG practice (a public
 * holiday during approved leave is not itself a vacation day) and matches
 * `countShiftBasedLeaveDays()`'s own long-standing holiday handling that `resolveLeaveDays()`
 * (vacation-entitlement booking) already relies on. Two different callers of the SAME kernel with
 * two different, individually correct `holidays` arguments — not a second day-counting
 * implementation.
 *
 * Status scope: APPROVED only (via `getApprovedLeaveOverlapping`), matching the saldo side's own
 * leave-row scope — no PENDING-vs-APPROVED divergence to parameterise.
 *
 * Leave-type scope (Phase 430-06, decided per PR review): includes EVERY approved leave type —
 * VACATION, SICK, SICK_CHILD, SPECIAL, etc. — regardless of Issue #429's `leaveCreditBasisForCode()`
 * CONTRACT/ROSTER split. That split answers a PAYROLL question (does this type replace a
 * contractual workday's PAY irrespective of the roster, or only pay what was planned?) which this
 * function's two callers do not ask. Type-2 conflict detection and the Planungsbedarf view both
 * ask a SCHEDULING question — "does this person still need a shift this week?" — and a SICK or
 * SPECIAL day answers that exactly like a VACATION day: no, don't plan one. Including ROSTER-basis
 * types here is therefore deliberate, not an oversight; see the PR description for the full
 * reasoning.
 *
 * Consumed by the Type-2 week-capacity conflict check (`contexts/scheduling/shift-week-capacity.ts`)
 * and the Wochenübersicht "Planungsbedarf" view.
 */
export async function getShiftBasedLeaveDaysForWeek(
  prisma: DbClient,
  employeeId: string,
  tenantId: string,
  weekStart: Date,
  weekEnd: Date,
): Promise<{ days: number; weekdays: string[] }> {
  const [overlapping, contractWorkDaysPerWeek, holidays] = await Promise.all([
    getApprovedLeaveOverlapping(
      prisma,
      { kind: "employee", employeeId, tenantId },
      weekStart,
      weekEnd,
    ),
    resolveContractWorkDaysPerWeek(prisma, employeeId, tenantId),
    getHolidayMap(prisma, tenantId, employeeId, weekStart, weekEnd),
  ]);

  if (overlapping.length === 0) return { days: 0, weekdays: [] };

  const holidaySet = new Set(holidays.keys());
  const weeks = leaveDaysPerWeek(overlapping, contractWorkDaysPerWeek, holidaySet);
  const weekMondayStr = weekStart.toISOString().slice(0, 10);
  const match = weeks.find((w) => w.weekMonday === weekMondayStr);
  if (!match) return { days: 0, weekdays: [] };

  // Which weekdays: walk Mon..Sun, skip Sunday (never a Werktag, § 3 Abs. 2 BUrlG) — the
  // `dayShares` map already excludes holidays (a holiday date never gets a share > 0).
  const weekdays: string[] = [];
  for (
    const d = new Date(weekStart);
    d.getTime() <= weekEnd.getTime();
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const dow = d.getUTCDay(); // 0=So..6=Sa
    if (dow === 0) continue;
    const dateStr = d.toISOString().slice(0, 10);
    if ((match.dayShares.get(dateStr) ?? 0) > 0) weekdays.push(GERMAN_WEEKDAY_ABBR[dow]);
  }

  return { days: match.days, weekdays };
}

/**
 * Recalculates carry-over for a given year based on the previous year's current state.
 * Called after every booking/cancellation to keep projected carry-over accurate.
 *
 * Issue #445 (D-04): a missing current-year row used to be created here with a hard-coded
 * `totalDays: 0` — now `ensureRegularVacationEntitlement()` creates (or heals) it with the
 * regular yearly entitlement instead.
 *
 * Issue #445 (D-10): `options.createIfMissing: false` (self-heal's own next-year recompute)
 * returns BEFORE the wrapper call when the `year` row does not exist yet — a read-time
 * self-heal must never create a next-year row (scenario 5). Default (`undefined`/`true`,
 * every other caller) is unchanged: a missing row is created with the regular entitlement.
 */
export async function recalculateCarryOver(
  prisma: DbClient,
  tenantId: string,
  employeeId: string,
  leaveTypeId: string,
  year: number,
  options: { createIfMissing?: boolean } = {},
): Promise<void> {
  const prevYear = year - 1;
  const prev = await prisma.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: prevYear } },
  });
  if (!prev) return;

  // Issue #445 (D-14): the effective (FIFO) remainder — an expired, untaken carry never
  // returns the following year.
  const remaining = await carryOverRemainder(prisma, prev, tenantId);

  if (options.createIfMissing === false) {
    const existing = await prisma.leaveEntitlement.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
    });
    if (!existing) return;
  }

  const config = await prisma.tenantConfig.findUnique({ where: { tenantId } });
  const deadlineDay = config?.carryOverDeadlineDay ?? 31;
  const deadlineMonth = config?.carryOverDeadlineMonth ?? 3;
  const deadline = new Date(year, deadlineMonth - 1, deadlineDay, 23, 59, 59);

  const { entitlement: cur } = await ensureRegularVacationEntitlement(
    prisma,
    employeeId,
    tenantId,
    year,
    leaveTypeId,
    REGULAR_ENTITLEMENT_REASON_ROLLOVER,
  );

  // Phase 104 (D-19 / R9), generalised by Issue #445 (D-16/D-17): a row with ANY documented
  // carry-over reason (ILLNESS's extended EuGH KHS C-214/10 deadline, MATERNITY, PARENTAL_LEAVE,
  // OTHER, or the legacy OPERATIONAL value) carries a deadline that is not the tenant's standard
  // Stichtag. This function runs after EVERY booking and cancellation, so an unconditional
  // deadline write would silently revert that documented extension on the next unrelated leave
  // request. Only the DEADLINE is protected: carriedOverDays is still recomputed, because D-20
  // relies on the existing expiry-warning mechanism reading an accurate, raised remaining
  // entitlement.
  const deadlineProtected = preserveCarryOverDeadline(cur);
  await prisma.leaveEntitlement.update({
    where: { id: cur.id },
    data: deadlineProtected
      ? { carriedOverDays: remaining }
      : { carriedOverDays: remaining, carryOverDeadline: deadline },
  });
  if (daysDiffer(Number(cur.carriedOverDays), remaining)) {
    await writeEntitlementAudit(prisma, {
      action: "UPDATE",
      entityId: cur.id,
      oldValue: { carriedOverDays: Number(cur.carriedOverDays) },
      newValue: { carriedOverDays: remaining, reason: CARRY_OVER_RECALC_REASON },
    });
  }
}

/**
 * Returns a Map<dateStr, holidayName> for the given period.
 *
 * Phase 71b (issue #71, D-04): resolves by WORK LOCATION (§ 2 EFZG) through the Unterbau's
 * central resolver — not a single tenant-wide federal state. With an `employeeId`, the entry
 * half of the work-location rule is that employee's own closed work entries in the range (T2,
 * `getWorkedEntriesInRange`); the fallback for a day without one comes from the resolver itself
 * (salon assignment, then the tenant's default salon). `employeeId: null` means a display with
 * no single employee (GET /leave/calendar's tenant-wide view) — the tenant's default salon
 * stands in for every day, an interim choice until Block D (#82 ff.) designs a salon-aware
 * calendar. The result stays a day → name map, so every caller's `new Set(map.keys())` is
 * unchanged.
 *
 * Exported + widened to `DbClient` (Phase 107, D-14): the shift-leave-recalc resolver calls
 * this through the SAME `tx` as its shift mutation (D-15), so the parameter type was widened
 * from the stricter `FastifyInstance["prisma"]` to the `DbClient` union already used
 * throughout this file — every existing call site (all pass `app.prisma`, one arm of the
 * union) is behaviour-identical.
 */
export async function getHolidayMap(
  prisma: DbClient,
  tenantId: string,
  employeeId: string | null,
  start: Date,
  end: Date,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!tenantId) return map;

  const fromDay = start.toISOString().split("T")[0];
  const toDay = end.toISOString().split("T")[0];

  if (employeeId) {
    const entries = await getWorkedEntriesInRange(
      prisma,
      { kind: "employee", employeeId, tenantId },
      start,
      end,
    );
    const byEmployee = await holidaysAtWorkLocation(
      prisma,
      tenantId,
      [employeeId],
      fromDay,
      toDay,
      entries,
    );
    return byEmployee.get(employeeId) ?? map;
  }

  const defaultSalon = await findDefaultSalon(prisma, tenantId);
  if (!defaultSalon) {
    throw new Error(
      `getHolidayMap: tenant ${tenantId} has no active salon — every tenant must have one (Phase 64b D-18)`,
    );
  }
  const holidays = await holidaysForSalon(prisma, tenantId, defaultSalon.id, fromDay, toDay);
  for (const h of holidays) map.set(h.date, h.name);

  return map;
}

/**
 * Deducts vacation days from the entitlement, cross-year aware.
 *
 * Exported (Phase 107, D-14): the shift-leave-recalc resolver
 * (`apps/api/src/utils/shift-leave-recalc-resolver.ts`) reuses this verbatim for its own
 * VACATION-entitlement delta correction rather than reinventing the year/type resolution —
 * `shifts.ts` imports it and passes it in as part of the resolver's `RecalcDeps`. Behaviour
 * unchanged for every existing call site in this file.
 *
 * Issue #445 (D-08/D-09): the cross-year branch now books `totalDays` chronologically through
 * {@link splitLeaveDaysByYear} — the SAME day count the request itself was priced with
 * (`resolveLeaveDays`: SHIFT_BASED by contract #417/#425, every other type by `workDays`) —
 * instead of re-deriving a (possibly different) count per year from the placeholder `workDays`
 * array via `splitDaysAcrossYears`. This also resolves ADR 0001-abweichungen Eintrag E point 1
 * (SHIFT_BASED cross-year booking by placeholder `workDays`).
 */
export async function deductVacationDays(
  prisma: DbClient,
  employeeId: string,
  leaveTypeId: string,
  startDate: Date,
  endDate: Date,
  totalDays: number,
  holidays: Set<string>,
  tenantId: string,
): Promise<void> {
  // Phase 104 review (WR-09): UTC year attribution. LeaveRequest.startDate/endDate are
  // @db.Date (UTC midnight) and the entitlement endpoint reads years with getUTCFullYear();
  // the local accessors put a 1 January booking on the previous year's entitlement row on any
  // host with a negative UTC offset. Changed together with reverseVacationDays() below so the
  // two stay exactly symmetric — booking and un-booking must never disagree on the year.
  const year1 = startDate.getUTCFullYear();
  const year2 = endDate.getUTCFullYear();
  const isCrossYear = year1 !== year2;

  if (isCrossYear) {
    // Issue #445 (D-09): chronological attribution, the request's own day count.
    const split = await splitLeaveDaysByYear(
      prisma,
      employeeId,
      tenantId,
      startDate,
      endDate,
      totalDays,
      holidays,
    );

    // Deduct from year 1
    if (split.year1Days > 0) {
      await prisma.leaveEntitlement.updateMany({
        where: { employeeId, leaveTypeId, year: year1 },
        data: { usedDays: { increment: split.year1Days } },
      });
    }

    // Deduct from year 2
    if (split.year2Days > 0) {
      await prisma.leaveEntitlement.updateMany({
        where: { employeeId, leaveTypeId, year: year2 },
        data: { usedDays: { increment: split.year2Days } },
      });
    }

    // Recalculate carry-over for year 2 (year 1 remaining changed)
    await recalculateCarryOver(prisma, tenantId, employeeId, leaveTypeId, year2);
  } else {
    // Single year: increment usedDays
    await prisma.leaveEntitlement.updateMany({
      where: { employeeId, leaveTypeId, year: year1 },
      data: { usedDays: { increment: totalDays } },
    });

    // Recalculate next year's carry-over (current year usage changed)
    await recalculateCarryOver(prisma, tenantId, employeeId, leaveTypeId, year1 + 1);
  }
}

export type ReverseVacationResult = {
  /** Years whose LeaveEntitlement row does not exist, so the decrement booked nothing (IN-05). */
  missingYears: number[];
};

/**
 * Symmetric counterpart to deductVacationDays (Phase 94-02): books vacation days back when an
 * approved leave correction reverses a prior booking. DECREMENTS usedDays per year and
 * recomputes the next year's carry-over — NOT the naive single-year decrement, so a cross-year
 * leave period is reversed correctly (T-94-07).
 *
 * Issue #445 (D-08/D-09): the cross-year branch now splits via {@link splitLeaveDaysByYear} —
 * see deductVacationDays()'s own docblock for the full rationale; booking and un-booking stay
 * symmetric by construction (both call the same helper).
 */
// Exported (Phase 107, D-14): reused verbatim by the shift-leave-recalc resolver for the
// downward half of its VACATION-entitlement delta correction — see deductVacationDays()'s
// export note above.
export async function reverseVacationDays(
  prisma: DbClient,
  employeeId: string,
  leaveTypeId: string,
  startDate: Date,
  endDate: Date,
  totalDays: number,
  holidays: Set<string>,
  tenantId: string,
): Promise<ReverseVacationResult> {
  // WR-09: UTC year attribution, symmetric with deductVacationDays() above.
  const year1 = startDate.getUTCFullYear();
  const year2 = endDate.getUTCFullYear();
  const isCrossYear = year1 !== year2;
  // Phase 104 review (IN-05): updateMany silently affects 0 rows when no entitlement exists
  // for that year (e.g. a credit whose origin year predates the employee's first row), and
  // selfHealUsedDays never creates a missing row either. Report the years that booked
  // nothing so the caller can decide — the § 9 confirm path refuses rather than reporting
  // "+N Tage gutgeschrieben" for a credit that landed nowhere.
  const missingYears: number[] = [];

  if (isCrossYear) {
    // Issue #445 (D-09): chronological attribution, the request's own day count.
    const split = await splitLeaveDaysByYear(
      prisma,
      employeeId,
      tenantId,
      startDate,
      endDate,
      totalDays,
      holidays,
    );

    if (split.year1Days > 0) {
      const { count } = await prisma.leaveEntitlement.updateMany({
        where: { employeeId, leaveTypeId, year: year1 },
        data: { usedDays: { decrement: split.year1Days } },
      });
      if (count === 0) missingYears.push(year1);
    }
    if (split.year2Days > 0) {
      const { count } = await prisma.leaveEntitlement.updateMany({
        where: { employeeId, leaveTypeId, year: year2 },
        data: { usedDays: { decrement: split.year2Days } },
      });
      if (count === 0) missingYears.push(year2);
    }

    // Year 1 remaining changed → recompute year 2 carry-over
    await recalculateCarryOver(prisma, tenantId, employeeId, leaveTypeId, year2);
  } else {
    const { count } = await prisma.leaveEntitlement.updateMany({
      where: { employeeId, leaveTypeId, year: year1 },
      data: { usedDays: { decrement: totalDays } },
    });
    if (count === 0) missingYears.push(year1);

    // Current year usage changed → recompute next year's carry-over
    await recalculateCarryOver(prisma, tenantId, employeeId, leaveTypeId, year1 + 1);
  }

  return { missingYears };
}

/**
 * Resolves how many leave days a period costs an employee (Phase 107, D-09's DB-fetching
 * side). Branch-first dispatch, mirroring getScheduledHours()'s shape: SHIFT_BASED resolves the
 * roster-aware calc and RETURNS EARLY; every other schedule type falls through to the existing
 * calculateWorkDays() wrapper below, behaviour-identical to every current call site (AC-REG-02)
 * — this function is a wrapper around that call, not a rewrite of it.
 *
 * `holidays` is the caller's already-computed Set (`getHolidayMap(...).keys()`, the same value
 * every existing calculateWorkDays() call site already builds) — this function does not fetch
 * holidays itself.
 *
 * Exported (Phase 107, D-14): this is the D-04 resolution chain's DB-fetching wrapper. The
 * shift-leave-recalc resolver (`apps/api/src/utils/shift-leave-recalc-resolver.ts`) calls this
 * SAME function (via `shifts.ts`, which imports it and passes it in as part of `RecalcDeps`) to
 * recompute a provisional request's days after a roster change — no second implementation of
 * the count/day resolution chain is allowed to exist (D-04).
 */
export async function resolveLeaveDays(
  prisma: DbClient,
  employeeId: string,
  tenantId: string,
  start: Date,
  end: Date,
  halfDay: boolean,
  holidays: Set<string>,
): Promise<{ days: number; provisional: boolean }> {
  const ws = await prisma.workSchedule.findFirst({
    where: { employeeId },
    orderBy: { validFrom: "desc" },
  });

  if (ws?.type === "SHIFT_BASED") {
    // Issue #417 (2026-09-29 owner decision, supersedes Phase 107 D-06): counted BY CONTRACT,
    // never by roster — the roster is not queried here any more (no getShiftsInRange call).
    const contractWorkDaysPerWeek = await resolveContractWorkDaysPerWeek(
      prisma,
      employeeId,
      tenantId,
    );

    return countShiftBasedLeaveDays(start, end, halfDay, contractWorkDaysPerWeek, holidays);
  }

  // Every other schedule type: byte-identical to today's five call sites (AC-REG-02).
  const workDays = await resolveWorkDays(prisma, employeeId, tenantId);
  const days = calculateWorkDays(start, end, halfDay, workDays, holidays);
  return { days, provisional: false };
}

// ── Issue #445 — the regular yearly vacation entitlement (D-01..D-06) ──────────────────────────

/** D-06 — audit reason for recalculateCarryOver()/autoCarryOver() ensuring a missing row exists
 * at year rollover. */
export const REGULAR_ENTITLEMENT_REASON_ROLLOVER = "Jahreswechsel: regulärer Jahresanspruch";
/** D-04 — audit reason for a row the POST /leave/requests VACATION branch had to create before
 * it could even check availability. */
export const REGULAR_ENTITLEMENT_REASON_LEAVE_REQUEST = "Urlaubsantrag: regulärer Jahresanspruch";
/** D-05 — audit reason for a zero placeholder healed on read (selfHealUsedDays, GET
 * /settings/vacation). */
export const REGULAR_ENTITLEMENT_REASON_SELF_HEAL =
  "Self-Heal: Urlaubsanspruch 0 ohne manuelle Setzung";
/** D-06 — audit reason for a carriedOverDays change written by recalculateCarryOver() /
 * autoCarryOver(). */
export const CARRY_OVER_RECALC_REASON = "Übertrag neu berechnet";

/**
 * Compares two day counts on 2-decimal rounding — the same precision `LeaveEntitlement.
 * carriedOverDays`/`totalDays` are stored at (`Decimal(5,2)`) — so a write that only moves a
 * value within float noise is not audited as a change (D-06).
 */
export function daysDiffer(a: number, b: number): boolean {
  return Math.round(a * 100) !== Math.round(b * 100);
}

/**
 * Issue #445 — the ONE base-value resolver for the regular vacation entitlement. Today:
 * `TenantConfig.defaultVacationDays`, falling back to 30 when unset. Issue #435 changes only
 * this function's body to "person value ?? tenant default" — every caller of
 * {@link resolveRegularVacationDays} / {@link ensureRegularVacationEntitlement} keeps working
 * unchanged.
 */
export async function resolveVacationBaseDays(
  db: DbClient,
  employeeId: string,
  tenantId: string,
): Promise<number> {
  const config = await db.tenantConfig.findUnique({
    where: { tenantId },
    select: { defaultVacationDays: true },
  });
  return Number(config?.defaultVacationDays ?? 30);
}

/**
 * Issue #445 — internal: the shared inputs {@link resolveRegularVacationDays} and
 * {@link ensureRegularVacationEntitlement} both need to compute a regular entitlement for
 * `employeeId`/`year` (D-02, D-03). Not exported — every external caller goes through one of
 * those two.
 */
async function loadRegularVacationInputs(
  db: DbClient,
  employeeId: string,
  tenantId: string,
  year: number,
): Promise<{ hireDate: Date; workDaysPerWeek: number; baseDays: number }> {
  const employee = await db.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: { hireDate: true, exitDate: true },
  });
  if (!employee) {
    throw new Error(
      `ensureRegularVacationEntitlement: employee ${employeeId} not found in tenant ${tenantId}`,
    );
  }
  // D-03/P-02: employed in `year` means hired on or before its start AND, if the employee has
  // since exited, that the exit happened in `year` or later — both compared on UTC calendar
  // years so the check is independent of server timezone.
  const employedInYear =
    employee.hireDate.getUTCFullYear() <= year &&
    (employee.exitDate === null || employee.exitDate.getUTCFullYear() >= year);

  const workDaysPerWeek = await resolveContractWorkDaysPerWeek(db, employeeId, tenantId);
  const baseDays = employedInYear ? await resolveVacationBaseDays(db, employeeId, tenantId) : 0;

  return { hireDate: employee.hireDate, workDaysPerWeek, baseDays };
}

/**
 * Issue #445 (D-03) — the regular yearly VACATION entitlement for `employeeId` in `year`,
 * read-only (no row is created or changed). Delegates the actual formula to
 * {@link computeRegularVacationDays}.
 */
export async function resolveRegularVacationDays(
  db: DbClient,
  employeeId: string,
  tenantId: string,
  year: number,
): Promise<number> {
  const inputs = await loadRegularVacationInputs(db, employeeId, tenantId, year);
  return computeRegularVacationDays({ year, ...inputs });
}

/**
 * Issue #445 (D-05) — a VACATION `LeaveEntitlement` row is a *zero placeholder* when `totalDays`
 * is 0, it was never auto-calculated, AND no human/API write ever set `totalDays` on it: no
 * AuditLog row of action CREATE or UPDATE for this entity/id has a `newValue` whose `totalDays`
 * is set while its `isAutoCalculated` is not `true` (PUT /settings/vacation always audits `newValue: body`
 * with `totalDays` — see leave-settings.ts). Idempotent precondition for
 * {@link ensureRegularVacationEntitlement}'s heal branch.
 */
export async function isZeroVacationPlaceholder(
  db: DbClient,
  row: { id: string; totalDays: unknown; isAutoCalculated: boolean },
): Promise<boolean> {
  if (Number(row.totalDays) !== 0 || row.isAutoCalculated) return false;

  const audits = await db.auditLog.findMany({
    where: { entity: "LeaveEntitlement", entityId: row.id, action: { in: ["CREATE", "UPDATE"] } },
    select: { newValue: true },
  });
  const hasHumanWrite = audits.some((a) => {
    const value = a.newValue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return (
      record.totalDays !== undefined &&
      record.totalDays !== null &&
      record.isAutoCalculated !== true
    );
  });
  return !hasHumanWrite;
}

export type RegularEntitlementResult = {
  entitlement: LeaveEntitlement;
  created: boolean;
  healed: boolean;
  /**
   * Issue #445 (coordinator deviation from CONTEXT D-05, Plan 01) — `true` when an existing
   * zero placeholder was left UNHEALED because {@link isAmbiguousRegularEntitlement} found it
   * ambiguous (a full prior year on record with a DIFFERENT totalDays, e.g. an Azubi/individual
   * 20-day contract the #416 tenant-default formula would otherwise silently raise to 30). The
   * row stays at 0 — no write, no audit — until a human resolves it (PUT /settings/vacation) or
   * an operator runs `repair-zero-vacation-entitlements.ts --include-flagged`. Always `false`
   * on a create path or a non-ambiguous heal.
   */
  needsReview: boolean;
};

/**
 * Issue #445 (D-07, generalised to a shared predicate per the coordinator deviation above) — a
 * computed regular entitlement is *ambiguous* when the employee had a FULL prior year on
 * record (hired before 1 January of `year - 1`) whose VACATION row is itself not a zero
 * placeholder and whose `totalDays` differs from `target`. This is the exact PRUEFEN condition
 * `repair-zero-vacation-entitlements.ts` already used inline — lifted out here so the script and
 * `ensureRegularVacationEntitlement`'s heal branch share ONE implementation, never two copies.
 * Only meaningful for the VACATION type; callers only invoke it once they know `leaveTypeId` is
 * the tenant's VACATION type.
 */
export async function isAmbiguousRegularEntitlement(
  db: DbClient,
  employeeId: string,
  leaveTypeId: string,
  year: number,
  hireDate: Date,
  target: number,
): Promise<boolean> {
  if (hireDate.getTime() >= Date.UTC(year - 1, 0, 1)) return false; // no full prior year on record
  const priorRow = await db.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: year - 1 } },
  });
  if (!priorRow) return false;
  if (await isZeroVacationPlaceholder(db, priorRow)) return false; // prior row itself unreliable
  return daysDiffer(Number(priorRow.totalDays), target);
}

/**
 * Issue #445 (D-02) — ensures a VACATION `LeaveEntitlement` row for `employeeId`/`year` carries
 * the regular yearly entitlement, creating it or healing a zero placeholder as needed:
 *   - missing row, VACATION type → created through {@link ensureVacationEntitlementForYear}
 *     (reuses its P2002 race handling and CREATE audit), `healed: false`. Creation is NEVER
 *     gated by {@link isAmbiguousRegularEntitlement} — the coordinator decision explicitly keeps
 *     D-04's "create with the regular entitlement" path as planned; only the heal of an
 *     EXISTING zero row (below) is gated.
 *   - missing row, any other leave type → today's behaviour: a 0 row with one CREATE audit
 *     (D-02 — only VACATION gets the regular-entitlement treatment).
 *   - existing row, zero placeholder (D-05), target > 0 (P-03), NOT ambiguous → healed:
 *     `totalDays` + `isAutoCalculated: true`, one UPDATE audit.
 *   - existing row, zero placeholder, target > 0, AMBIGUOUS (coordinator deviation) → left at 0,
 *     no write, no audit, `needsReview: true` — unless `options.allowAmbiguousHeal` is set (the
 *     correction script's `--include-flagged`, the only automated way to write such a row).
 *   - existing row, not a placeholder (a human zero, a non-zero value, or already
 *     auto-calculated) → returned unchanged, `healed: false`.
 *
 * `reason` is the audit `newValue.reason` for whichever branch runs (create or heal) — see the
 * `REGULAR_ENTITLEMENT_REASON_*` constants above for the call-site reasons in use today.
 */
export async function ensureRegularVacationEntitlement(
  db: DbClient,
  employeeId: string,
  tenantId: string,
  year: number,
  leaveTypeId: string,
  reason: string,
  options?: { allowAmbiguousHeal?: boolean },
): Promise<RegularEntitlementResult> {
  const vacationType = await getLeaveTypeByCode(db, tenantId, "VACATION");
  const existing = await db.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
  });

  // D-02: only the tenant's VACATION type gets the regular-entitlement treatment — any other
  // type keeps today's pre-#445 behaviour (a 0 row, audited CREATE, no heal).
  if (!vacationType || vacationType.id !== leaveTypeId) {
    if (existing)
      return { entitlement: existing, created: false, healed: false, needsReview: false };

    let created: LeaveEntitlement;
    try {
      created = await db.leaveEntitlement.create({
        data: { employeeId, leaveTypeId, year, totalDays: 0, usedDays: 0, carriedOverDays: 0 },
      });
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && err.code === "P2002") {
        const refetched = await db.leaveEntitlement.findUniqueOrThrow({
          where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
        });
        return { entitlement: refetched, created: false, healed: false, needsReview: false };
      }
      throw err;
    }
    await writeEntitlementAudit(db, {
      action: "CREATE",
      entityId: created.id,
      newValue: { totalDays: 0, reason },
    });
    return { entitlement: created, created: true, healed: false, needsReview: false };
  }

  if (existing) {
    if (await isZeroVacationPlaceholder(db, existing)) {
      const inputs = await loadRegularVacationInputs(db, employeeId, tenantId, year);
      const target = computeRegularVacationDays({ year, ...inputs });
      if (target > 0) {
        const ambiguous = await isAmbiguousRegularEntitlement(
          db,
          employeeId,
          leaveTypeId,
          year,
          inputs.hireDate,
          target,
        );
        if (ambiguous && !options?.allowAmbiguousHeal) {
          return { entitlement: existing, created: false, healed: false, needsReview: true };
        }
        const { count } = await db.leaveEntitlement.updateMany({
          where: { id: existing.id, totalDays: 0, isAutoCalculated: false },
          data: { totalDays: target, isAutoCalculated: true },
        });
        if (count === 1) {
          await writeEntitlementAudit(db, {
            action: "UPDATE",
            entityId: existing.id,
            oldValue: { totalDays: 0 },
            newValue: { totalDays: target, isAutoCalculated: true, reason },
          });
        }
        const entitlement = await db.leaveEntitlement.findUniqueOrThrow({
          where: { id: existing.id },
        });
        return { entitlement, created: false, healed: count === 1, needsReview: false };
      }
    }
    return { entitlement: existing, created: false, healed: false, needsReview: false };
  }

  const inputs = await loadRegularVacationInputs(db, employeeId, tenantId, year);
  const result = await ensureVacationEntitlementForYear(
    db,
    employeeId,
    tenantId,
    year,
    inputs.hireDate,
    inputs.workDaysPerWeek,
    inputs.baseDays,
    reason,
    (entry) =>
      writeEntitlementAudit(db, {
        action: entry.action,
        entityId: entry.entityId,
        newValue: entry.newValue,
      }),
  );
  if (!result) {
    throw new Error(
      `ensureRegularVacationEntitlement: no VACATION LeaveType configured for tenant ${tenantId}`,
    );
  }
  return {
    entitlement: result.entitlement,
    created: result.created,
    healed: false,
    needsReview: false,
  };
}

/**
 * Issue #445 — the ONE place the German "Urlaubsanspruch fehlt" warning string is built.
 *
 * `composition/reports.ts` (GET /reports/leave-overview) and `api/leave.ts` (GET
 * /leave/entitlements) both surfaced an ambiguous, unhealed zero placeholder (see
 * {@link isAmbiguousRegularEntitlement}) with their own copy of this string. The composition
 * layer carries no business rule (CLAUDE.md, ADR 0002 Entscheidung 9) — deciding WHETHER a row
 * warns and WHAT the warning says is a rule of this context, not a display detail. Both callers
 * now call this function instead of building the string themselves.
 */
export function vacationEntitlementWarning(row: {
  leaveTypeCode: string | null | undefined;
  year: number;
  needsReview?: boolean;
}): string | null {
  return row.leaveTypeCode === "VACATION" && row.needsReview === true
    ? `Urlaubsanspruch für ${row.year} fehlt – bitte prüfen`
    : null;
}

// ── Issue #445 — chronological cross-year attribution (D-08/D-09) ──────────────────────────────

/** Normalises a Date to UTC midnight of its own UTC calendar day (P-12). */
function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Adds (or subtracts, for a negative `n`) whole UTC days to a UTC-midnight Date. */
function addUtcDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}

/** Rounds to 2 decimals — the precision `LeaveRequest.days`/`LeaveEntitlement.*Days` are stored
 * at (`Decimal(5,2)`), matching {@link daysDiffer}'s own rounding. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The chronological-prefix rule (D-08): `P(t)` is 0 before the request starts, `request.days`
 * on/after it ends, and `min(request.days, counted(start, t))` in between — `counted` being the
 * SAME dispatch {@link resolveLeaveDays} uses to price the request itself (SHIFT_BASED by
 * contract #417/#425, every other type by `workDays`). Not exported — every external caller
 * goes through {@link splitLeaveDaysByYear} or {@link leaveDaysWithin} below.
 */
async function prefixLeaveDays(
  db: DbClient,
  employeeId: string,
  tenantId: string,
  request: { startDate: Date; endDate: Date; days: unknown },
  t: Date,
  holidays: Set<string>,
): Promise<number> {
  const start = utcDay(request.startDate);
  const end = utcDay(request.endDate);
  const total = Number(request.days);
  const tt = utcDay(t);
  if (tt.getTime() < start.getTime()) return 0;
  if (tt.getTime() >= end.getTime()) return total;
  const counted = await resolveLeaveDays(db, employeeId, tenantId, start, tt, false, holidays);
  return Math.min(total, counted.days);
}

/**
 * Issue #445 (D-08/D-09) — splits a (possibly cross-year) leave request's `totalDays` between
 * the two calendar years it spans, chronologically: `year1Days = P(31 Dec of year1)`,
 * `year2Days = totalDays − year1Days`. Always sums exactly to `totalDays` (P-11) — unlike the
 * former `splitDaysAcrossYears()` (still exported from `./vacation-calc`, unchanged, for its
 * other readers), which re-derived each year's count independently from the placeholder
 * `workDays` array and could over- or under-count a SHIFT_BASED boundary week. Same-year
 * requests short-circuit without a DB round-trip.
 */
export async function splitLeaveDaysByYear(
  db: DbClient,
  employeeId: string,
  tenantId: string,
  start: Date,
  end: Date,
  totalDays: number,
  holidays: Set<string>,
): Promise<{ year1: number; year2: number; year1Days: number; year2Days: number }> {
  const year1 = start.getUTCFullYear();
  const year2 = end.getUTCFullYear();
  if (year1 === year2) {
    return { year1, year2, year1Days: round2(totalDays), year2Days: 0 };
  }
  const request = { startDate: start, endDate: end, days: totalDays };
  const year1Days = await prefixLeaveDays(
    db,
    employeeId,
    tenantId,
    request,
    new Date(Date.UTC(year1, 11, 31)),
    holidays,
  );
  return {
    year1,
    year2,
    year1Days: round2(year1Days),
    year2Days: round2(totalDays - year1Days),
  };
}

/**
 * Issue #445 (D-08/D-09/D-10) — the portion of `request`'s days that falls inside `[from, to]`,
 * by the same chronological-prefix rule: `max(0, P(to) − P(from − 1 day))`. Returns 0 when
 * `to < from`. Used by self-heal (D-10) to attribute a cross-year or partially-overlapping
 * request's days to one entitlement year's window.
 *
 * P-17: for a SHIFT_BASED request the prefix is not strictly monotone across a holiday (adding a
 * holiday can reduce an already-capped fragment's count), so the result is clamped at 0; a
 * year-window sum (`P(Dec 31)` minus the previous window's) never goes negative because
 * `P(Dec 31) <= request.days` always holds.
 */
export async function leaveDaysWithin(
  db: DbClient,
  employeeId: string,
  tenantId: string,
  request: { startDate: Date; endDate: Date; days: unknown },
  from: Date,
  to: Date,
  holidays: Set<string>,
): Promise<number> {
  if (to.getTime() < from.getTime()) return 0;
  const pTo = await prefixLeaveDays(db, employeeId, tenantId, request, to, holidays);
  const pFromMinus1 = await prefixLeaveDays(
    db,
    employeeId,
    tenantId,
    request,
    addUtcDays(utcDay(from), -1),
    holidays,
  );
  return Math.max(0, round2(pTo - pFromMinus1));
}

/**
 * Issue #445 (D-10) — the days this employee's (vacation-aware) type set counts within
 * `[from, to]`, split into the raw request sum and the § 9 credit that reduces it. Counts every
 * non-deleted request with status APPROVED or CANCELLATION_REQUESTED (CLAUDE.md: leave stays
 * active until a cancellation is approved) overlapping the window: a request fully inside
 * `[from, to]` contributes its own `days`; any other contributes its chronological-prefix
 * portion via {@link leaveDaysWithin} (the same rule gives the identical result for a
 * fully-inside request too, without the holiday-map round-trip — see that function's own
 * docblock). § 9 credits ({@link listConfirmedSection9CreditsByRequest}) are attributed the same
 * way over `creditedStart..creditedEnd`, or — when that range is null (a legacy credit, P-13) —
 * to the window containing the originating request's own start date.
 */
export async function countedLeaveDaysWithin(
  db: DbClient,
  args: { employeeId: string; tenantId: string; leaveTypeIds: string[]; from: Date; to: Date },
): Promise<{ requestDays: number; section9CreditDays: number }> {
  const { employeeId, tenantId, leaveTypeIds, from, to } = args;
  const fromDay = utcDay(from);
  const toDay = utcDay(to);

  const requests = await db.leaveRequest.findMany({
    where: {
      employeeId,
      deletedAt: null,
      employee: { tenantId },
      leaveTypeId: { in: leaveTypeIds },
      status: { in: ["APPROVED", "CANCELLATION_REQUESTED"] },
      startDate: { lte: to },
      endDate: { gte: from },
    },
    select: { id: true, startDate: true, endDate: true, days: true },
  });

  let requestDays = 0;
  for (const r of requests) {
    if (
      utcDay(r.startDate).getTime() >= fromDay.getTime() &&
      utcDay(r.endDate).getTime() <= toDay.getTime()
    ) {
      requestDays += Number(r.days);
    } else {
      const holidayMap = await getHolidayMap(db, tenantId, employeeId, r.startDate, r.endDate);
      requestDays += await leaveDaysWithin(
        db,
        employeeId,
        tenantId,
        r,
        from,
        to,
        new Set(holidayMap.keys()),
      );
    }
  }

  const requestsById = new Map(requests.map((r) => [r.id, r]));
  const credits = await listConfirmedSection9CreditsByRequest(
    db,
    requests.map((r) => r.id),
    tenantId,
  );

  let section9CreditDays = 0;
  for (const credit of credits) {
    if (credit.creditedStart && credit.creditedEnd) {
      if (
        utcDay(credit.creditedStart).getTime() >= fromDay.getTime() &&
        utcDay(credit.creditedEnd).getTime() <= toDay.getTime()
      ) {
        section9CreditDays += credit.creditedDays;
      } else {
        const holidayMap = await getHolidayMap(
          db,
          tenantId,
          employeeId,
          credit.creditedStart,
          credit.creditedEnd,
        );
        section9CreditDays += await leaveDaysWithin(
          db,
          employeeId,
          tenantId,
          {
            startDate: credit.creditedStart,
            endDate: credit.creditedEnd,
            days: credit.creditedDays,
          },
          from,
          to,
          new Set(holidayMap.keys()),
        );
      }
    } else {
      // P-13: legacy credit without a credited range — attribute to the window containing the
      // originating vacation request's own start date.
      const originalRequest = requestsById.get(credit.vacationRequestId);
      if (originalRequest) {
        const start = utcDay(originalRequest.startDate);
        if (start.getTime() >= fromDay.getTime() && start.getTime() <= toDay.getTime()) {
          section9CreditDays += credit.creditedDays;
        }
      }
    }
  }

  return { requestDays: round2(requestDays), section9CreditDays: round2(section9CreditDays) };
}

/**
 * Issue #445 (D-10) — heals one `LeaveEntitlement.usedDays` row in place: recomputes
 * `requestDays - section9CreditDays` for the row's calendar year via
 * {@link countedLeaveDaysWithin}, writes the new value plus an audited UPDATE (reason
 * "Self-Heal", `userId: null`) when it differs, and recomputes the NEXT year's carry-over with
 * `recalculateCarryOver(..., { createIfMissing: false })` — a read must never create a
 * next-year row. Bundled into ONE function (rather than leaving the steps in
 * `leave-self-heal.ts`) so that file needs no static import of this module — see its own
 * docblock for the import-cycle reason — and is injected via `VacationTypeMeta.healUsedDays`.
 */
export async function healEntitlementUsedDays(
  db: DbClient,
  row: { id: string; employeeId: string; leaveTypeId: string; year: number; usedDays: unknown },
  leaveTypeIds: string[],
  tenantId: string,
): Promise<{ usedDays: number; changed: boolean }> {
  const { requestDays, section9CreditDays } = await countedLeaveDaysWithin(db, {
    employeeId: row.employeeId,
    tenantId,
    leaveTypeIds,
    from: new Date(Date.UTC(row.year, 0, 1)),
    to: new Date(Date.UTC(row.year, 11, 31)),
  });
  const actualUsed = Math.max(0, round2(requestDays - section9CreditDays));
  const currentUsed = Number(row.usedDays);
  if (!daysDiffer(currentUsed, actualUsed)) {
    return { usedDays: currentUsed, changed: false };
  }
  await db.leaveEntitlement.update({ where: { id: row.id }, data: { usedDays: actualUsed } });
  await writeEntitlementAudit(db, {
    action: "UPDATE",
    entityId: row.id,
    oldValue: { usedDays: currentUsed },
    newValue: { usedDays: actualUsed, reason: "Self-Heal" },
  });
  await recalculateCarryOver(db, tenantId, row.employeeId, row.leaveTypeId, row.year + 1, {
    createIfMissing: false,
  });
  return { usedDays: actualUsed, changed: true };
}

// ── Issue #445 — carry-over FIFO and expiry (D-12..D-15) ────────────────────────────────────────

/**
 * Issue #445 (D-12/D-13) — the portion of a `LeaveEntitlement` row's carried-over (prior-year)
 * days that still counts towards the balance as of `referenceDate`.
 *
 * Legal basis: BUrlG § 7 Abs. 3 — carried-over days must be granted AND taken by the deadline;
 * EuGH C-684/16 (Hinweispflicht) — they lapse only when the employer has documented a warning
 * (`CARRYOVER_WARNED` AuditLog row, `hinweisIssued`); KHS C-214/10, Schultz-Hoff C-350/06. Days
 * taken before the deadline are consumed from the carry-over FIRST (FIFO, Tilgung der älteren
 * Schuld analog § 366 Abs. 2 BGB — see docs/burlg-carryover.md "Carry-over priority") — only the
 * part NOT taken by the deadline lapses:
 *   - `carry <= 0` → 0 (nothing to protect).
 *   - no deadline configured, OR `referenceDate` is on/before the deadline, OR no Hinweis was
 *     issued → the full carry (not yet due, or not lawfully forfeitable).
 *   - otherwise → `min(carry, takenUpToDeadline)`, where `takenUpToDeadline` is this row's
 *     counted (vacation-aware) days inside `[1 Jan of row.year, min(deadline, 31 Dec of
 *     row.year)]` (P-18 — a day taken in the FOLLOWING year belongs to that year's own row and
 *     never consumes THIS row's carry), via {@link countedLeaveDaysWithin} — the same dispatch
 *     used throughout this file.
 *
 * Example (Issue #445): totalDays 10, carry 5, 5 days taken in February, deadline 31 March,
 * warned — a request starting 19 April sees `10` available days (not `5`): the 5 already-taken
 * February days are charged against the carry, which is then fully consumed and causes no further
 * reduction of `totalDays`.
 */
export async function effectiveCarryOverDays(
  db: DbClient,
  row: {
    employeeId: string;
    leaveTypeId: string;
    year: number;
    carriedOverDays: unknown;
    carryOverDeadline: Date | null;
    tenantId: string;
  },
  referenceDate: Date,
  hinweisIssued: boolean,
): Promise<number> {
  const carry = Number(row.carriedOverDays);
  if (carry <= 0) return 0;
  if (!row.carryOverDeadline) return carry; // no expiry configured
  if (referenceDate <= row.carryOverDeadline) return carry; // deadline not yet reached
  if (!hinweisIssued) return carry; // EuGH C-684/16: no lapse without a documented warning

  const yearEnd = Date.UTC(row.year, 11, 31, 23, 59, 59);
  const windowEnd = new Date(Math.min(row.carryOverDeadline.getTime(), yearEnd));
  const { requestDays, section9CreditDays } = await countedLeaveDaysWithin(db, {
    employeeId: row.employeeId,
    tenantId: row.tenantId,
    leaveTypeIds: [row.leaveTypeId],
    from: new Date(Date.UTC(row.year, 0, 1)),
    to: windowEnd,
  });
  const takenUpToDeadline = Math.max(0, round2(requestDays - section9CreditDays));
  return Math.min(carry, takenUpToDeadline);
}

/**
 * Issue #445 (D-14, P-19) — the previous year's remainder to carry forward into `year`:
 * `prev.totalDays + effectiveCarryOverDays(prev, 31 Dec of prev.year) − prev.usedDays`, clamped
 * at 0. Unlike the pre-#445 formula (`totalDays + carriedOverDays - usedDays`), this uses the
 * EFFECTIVE carry — so an expired, untaken carry never comes back the following year (D-14's own
 * issue example: 30 + 5 carry lapsed, 10 used → remainder 20, not 25). The Hinweis flag is read
 * from the PREVIOUS row's own `CARRYOVER_WARNED` AuditLog entry — the warning is always issued
 * against the row whose carry-over is at risk of expiring.
 */
export async function carryOverRemainder(
  db: DbClient,
  prev: {
    id: string;
    employeeId: string;
    leaveTypeId: string;
    year: number;
    totalDays: unknown;
    usedDays: unknown;
    carriedOverDays: unknown;
    carryOverDeadline: Date | null;
  },
  tenantId: string,
): Promise<number> {
  const hinweisIssued =
    (await db.auditLog.count({
      where: { action: "CARRYOVER_WARNED", entity: "LeaveEntitlement", entityId: prev.id },
    })) > 0;
  const effectiveCarry = await effectiveCarryOverDays(
    db,
    { ...prev, tenantId },
    new Date(Date.UTC(prev.year, 11, 31, 23, 59, 59)),
    hinweisIssued,
  );
  return Math.max(0, round2(Number(prev.totalDays) + effectiveCarry - Number(prev.usedDays)));
}
