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
import { splitDaysAcrossYears, countShiftBasedLeaveDays } from "./vacation-calc"; // Phase 107 (D-04/D-09), Issue #417
import { preserveIllnessDeadline } from "./illness-carryover-guard"; // Phase 104
import { getApprovedLeaveOverlapping } from "./facade/leave-requests"; // Phase 430 (D-08) — this file is INSIDE contexts/absence, no boundary crossing

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
 * (Mon..Sun, `weekStart`/`weekEnd` as UTC-midnight Dates spanning that week). Reuses
 * `countShiftBasedLeaveDays` (via the SAME `resolveContractWorkDaysPerWeek` chain
 * `resolveLeaveDays()` already uses) — this is NOT a second implementation of the BUrlG
 * day-counting rule (Phase 430, D-08). `weekdays` independently derives which days are covered by
 * an approved leave request (excluding Sunday, mirroring the formula's own § 3 Abs. 2 BUrlG
 * exclusion, and excluding public holidays via the same `holidays` set the day-count call uses) so
 * the two never disagree about what counts.
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

  // Day COUNT: clip each overlapping request to [weekStart, weekEnd] and sum
  // countShiftBasedLeaveDays's own result per request — never re-derived independently.
  let days = 0;
  const clips: Array<{ start: Date; end: Date }> = [];
  for (const req of overlapping) {
    const clipStart = req.startDate > weekStart ? req.startDate : weekStart;
    const clipEnd = req.endDate < weekEnd ? req.endDate : weekEnd;
    if (clipStart > clipEnd) continue;
    clips.push({ start: clipStart, end: clipEnd });
    days += countShiftBasedLeaveDays(
      clipStart,
      clipEnd,
      req.halfDay,
      contractWorkDaysPerWeek,
      holidaySet,
    ).days;
  }

  // Which weekdays: walk Mon..Sun, skip Sunday (never a Werktag) and any holiday, collect the
  // German abbreviation of every day covered by at least one clipped overlapping request.
  const weekdays: string[] = [];
  for (
    const d = new Date(weekStart);
    d.getTime() <= weekEnd.getTime();
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const dow = d.getUTCDay(); // 0=So..6=Sa
    if (dow === 0) continue; // Sunday never a Werktag (§ 3 Abs. 2 BUrlG)
    const dateStr = d.toISOString().slice(0, 10);
    if (holidaySet.has(dateStr)) continue;
    const covered = clips.some(
      (c) => d.getTime() >= c.start.getTime() && d.getTime() <= c.end.getTime(),
    );
    if (covered) weekdays.push(GERMAN_WEEKDAY_ABBR[dow]);
  }

  return { days, weekdays };
}

/**
 * Recalculates carry-over for a given year based on the previous year's current state.
 * Called after every booking/cancellation to keep projected carry-over accurate.
 */
export async function recalculateCarryOver(
  prisma: DbClient,
  tenantId: string,
  employeeId: string,
  leaveTypeId: string,
  year: number,
): Promise<void> {
  const prevYear = year - 1;
  const prev = await prisma.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: prevYear } },
  });
  if (!prev) return;

  const remaining = Math.max(
    0,
    Number(prev.totalDays) + Number(prev.carriedOverDays) - Number(prev.usedDays),
  );

  const config = await prisma.tenantConfig.findUnique({ where: { tenantId } });
  const deadlineDay = config?.carryOverDeadlineDay ?? 31;
  const deadlineMonth = config?.carryOverDeadlineMonth ?? 3;
  const deadline = new Date(year, deadlineMonth - 1, deadlineDay, 23, 59, 59);

  const cur = await prisma.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
  });

  if (cur) {
    // Phase 104 (D-19 / R9): an ILLNESS carry-over carries the extended EuGH KHS C-214/10
    // deadline (15 months after the end of the accrual year), not the tenant's standard
    // Stichtag. This function runs after EVERY booking and cancellation, so an unconditional
    // deadline write would silently revert that extension on the next unrelated leave
    // request — the days would then appear to lapse on a date the ECJ forbids. Only the
    // DEADLINE is protected: carriedOverDays is still recomputed, because D-20 relies on the
    // existing expiry-warning mechanism reading an accurate, raised remaining entitlement.
    const illnessProtected = preserveIllnessDeadline(cur);
    await prisma.leaveEntitlement.update({
      where: { id: cur.id },
      data: illnessProtected
        ? { carriedOverDays: remaining }
        : { carriedOverDays: remaining, carryOverDeadline: deadline },
    });
  } else {
    await prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId,
        year,
        totalDays: 0,
        usedDays: 0,
        carriedOverDays: remaining,
        carryOverDeadline: deadline,
      },
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
 * Zieht Urlaubstage vom Entitlement ab: Resturlaub (sofern nicht verfallen) zuerst,
 * danach reguläre Tage.
 *
 * Exported (Phase 107, D-14): the shift-leave-recalc resolver
 * (`apps/api/src/utils/shift-leave-recalc-resolver.ts`) reuses this verbatim for its own
 * VACATION-entitlement delta correction rather than reinventing the year/type resolution —
 * `shifts.ts` imports it and passes it in as part of the resolver's `RecalcDeps`. Behaviour
 * unchanged for every existing call site in this file.
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
    // Split days across years — using the employee's own workDays
    const workDays = await resolveWorkDays(prisma, employeeId, tenantId);
    const split = splitDaysAcrossYears(startDate, endDate, false, workDays, holidays);

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
 * Symmetrischer Gegenpart zu deductVacationDays (Phase 94-02): bucht Urlaubstage
 * wieder ZURÜCK, wenn eine genehmigte Urlaubskorrektur den alten Buchungsstand
 * rückgängig macht. DECREMENTIERT usedDays pro Jahr (cross-year via
 * splitDaysAcrossYears) und rechnet den Folgejahres-Übertrag neu — NICHT der naive
 * Single-Year-Decrement, damit ein jahresübergreifender Urlaub korrekt zurückgebucht
 * wird (T-94-07).
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
    const workDays = await resolveWorkDays(prisma, employeeId, tenantId);
    const split = splitDaysAcrossYears(startDate, endDate, false, workDays, holidays);

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
