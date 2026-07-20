import { PrismaClient } from "@clokr/db";
import { fromZonedTime } from "date-fns-tz";
import { getTenantTimezone, dateStrInTz, getDayOfWeekInTz } from "./timezone";
import { BS_DAILY_DEFAULT_MIN } from "./vocational-school-constants";
import { countBsDaysInIsoWeek, getVocationalSchoolMinutesForDate } from "./vocational-school-saldo";

export interface ArbZGWarning {
  code:
    | "BREAK_TOO_SHORT"
    | "MAX_DAILY_EXCEEDED"
    | "MAX_DAILY_AVG_EXCEEDED"
    | "MAX_WEEKLY_EXCEEDED"
    | "MIN_REST_VIOLATED";
  severity: "warning" | "error";
  message: string;
}

/**
 * Prüft ArbZG-Konformität für einen Mitarbeiter nach einem geänderten Eintrag.
 * Gibt eine Liste von Warnungen zurück (blockiert NICHT das Speichern).
 *
 * Phase 63 — Berufsschule integration (D-05..D-08):
 *   - VOCATIONAL_SCHOOL Absences contribute their `vocationalSchoolMinutesPerDay`
 *     (per tenant, default 480) to every ArbZG branch:
 *       § 3 Tageshöchst (MAX_DAILY_EXCEEDED, mixed-day check)
 *       § 3 Wochensumme (MAX_WEEKLY_EXCEEDED)
 *       § 3 24-week avg (MAX_DAILY_AVG_EXCEEDED)
 *       § 5 Ruhezeit (MIN_REST_VIOLATED, BS-end = 18:00 single / 24:00 block)
 *   - NO new warning codes (D-08) — reuse existing 5 codes; ArbZG doesn't care WHY
 *     a day is over the limit.
 *   - All Absence queries include `deletedAt: null` per CLAUDE.md soft-delete rule.
 */
export async function checkArbZG(
  prisma: PrismaClient,
  employeeId: string,
  changedDate: Date,
): Promise<ArbZGWarning[]> {
  const warnings: ArbZGWarning[] = [];

  // Look up tenant timezone and current schedule type for this employee
  const employee = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: {
      tenantId: true,
      isTimeTrackingExempt: true, // Phase 76.7 (D-05, ARBZG-V19-01)
      workSchedules: {
        orderBy: { validFrom: "desc" },
        take: 1,
        // Phase 76.31-05: full schedule needed so the slot resolver can compute
        // the individual daily Soll (FIRST_LONG_DAY fallback → weeklyHours/workDays).
        select: {
          type: true,
          weeklyHours: true,
          mondayHours: true,
          tuesdayHours: true,
          wednesdayHours: true,
          thursdayHours: true,
          fridayHours: true,
          saturdayHours: true,
          sundayHours: true,
        },
      },
    },
  });

  // Phase 76.7 (D-05) — § 18 ArbZG-exempt employees skip every ArbZG check
  // (§ 3 daily max, § 4 breaks, § 5 rest period). BUrlG (vacation) still applies.
  if (employee.isTimeTrackingExempt) return warnings; // already []

  const tz = await getTenantTimezone(prisma, employee.tenantId);
  const schedule = employee.workSchedules[0] ?? null;
  const scheduleType = schedule?.type ?? "FIXED_SCHEDULE";

  // Phase 63 — load tenant config for BS-minutes-per-day; fall back to default
  // so a missing TenantConfig row never throws (mirrors saldo helper semantics).
  // Phase 76.31-05 — also read the bsSlot* override columns so the slot resolver
  // walks the full D-06 4-layer hierarchy (Employee ?? Pattern ?? TenantConfig ?? legacy ?? daily-Soll).
  const tenantConfig = await prisma.tenantConfig.findUnique({
    where: { tenantId: employee.tenantId },
    select: {
      vocationalSchoolMinutesPerDay: true,
      vocationalSchoolBlockMinutesPerWeek: true,
      bsSlotFirstLongDayMinutes: true,
      bsSlotSecondLongDayMinutes: true,
      bsSlotShortDayMinutes: true,
      bsSlotBlockWeekMinutes: true,
    },
  });
  const bsDailyMin = tenantConfig?.vocationalSchoolMinutesPerDay ?? BS_DAILY_DEFAULT_MIN;

  const dateStr = dateStrInTz(changedDate, tz);

  // Phase 63 — Is the changed date itself a BS day? Looked up once and reused by
  // the §3 daily mixed-day branch + §5 rest-period BS-end heuristic.
  const dayRangeStart = new Date(dateStr + "T00:00:00.000Z");
  const dayRangeEnd = new Date(dateStr + "T23:59:59.999Z");
  const bsAbsenceToday = await prisma.absence.findFirst({
    where: {
      employeeId,
      deletedAt: null, // CLAUDE.md soft-delete rule
      type: "VOCATIONAL_SCHOOL",
      startDate: { lte: dayRangeEnd },
      endDate: { gte: dayRangeStart },
    },
    select: { id: true, startDate: true },
  });
  // Phase 76.31-05 (D-08 FULL) — the §3 daily 10h check must count the REAL slot-
  // resolved BS minutes, not a flat 480. A LONG day is 9.5h (570 min); counting it
  // as 480 under-warns on the 10h cap (RESEARCH R5). The resolver returns 0 when no
  // BS absence exists for the date, so the branch stays a no-op on non-BS days.
  const bsMinutesToday = bsAbsenceToday
    ? await getVocationalSchoolMinutesForDate(prisma, employeeId, changedDate, tenantConfig, {
        schedule,
        scheduleType,
      })
    : 0;

  // ── 1. Tagessicht: alle abgeschlossenen Slots des Tages ────────────────────
  const daySlots = await prisma.timeEntry.findMany({
    where: {
      employeeId,
      deletedAt: null,
      date: { gte: new Date(dateStr), lte: new Date(dateStr + "T23:59:59.999Z") },
      endTime: { not: null },
      type: "WORK",
    },
    orderBy: { startTime: "asc" },
  });

  if (daySlots.length > 0) {
    // Netto-Arbeitszeit + explizite Pausen
    let netWorkedMin = 0;
    let explicitBreakMin = 0;

    for (const slot of daySlots) {
      const slotMin = (slot.endTime!.getTime() - slot.startTime.getTime()) / 60000;
      explicitBreakMin += Number(slot.breakMinutes ?? 0);
      netWorkedMin += slotMin - Number(slot.breakMinutes ?? 0);
    }

    // Lücken zwischen Slots zählen als Pausen
    let gapBreakMin = 0;
    for (let i = 1; i < daySlots.length; i++) {
      const gap = (daySlots[i].startTime.getTime() - daySlots[i - 1].endTime!.getTime()) / 60000;
      if (gap > 0 && gap <= 120) gapBreakMin += gap; // Lücken > 2h sind separate Schichten, keine Pausen
    }

    const totalBreakMin = explicitBreakMin + gapBreakMin;

    // § 4 ArbZG – Ruhepausenvorschrift
    if (netWorkedMin > 9 * 60 && totalBreakMin < 45) {
      warnings.push({
        code: "BREAK_TOO_SHORT",
        severity: "error",
        message: `§ 4 ArbZG: Bei über 9 Stunden Arbeitszeit sind mindestens 45 Minuten Pause vorgeschrieben. Erfasst: ${Math.round(totalBreakMin)} Min.`,
      });
    } else if (netWorkedMin > 6 * 60 && totalBreakMin < 30) {
      warnings.push({
        code: "BREAK_TOO_SHORT",
        severity: "warning",
        message: `§ 4 ArbZG: Bei über 6 Stunden Arbeitszeit sind mindestens 30 Minuten Pause vorgeschrieben. Erfasst: ${Math.round(totalBreakMin)} Min.`,
      });
    }

    // § 3 ArbZG – Tägliche Höchstarbeitszeit (10h absolut, 8h nur als 24-Wochen-Schnitt relevant)
    // Phase 63 D-06: mixed-day rule — BS-Zeit + WORK-Zeit > 10h → MAX_DAILY_EXCEEDED.
    const dailyTotalMin = netWorkedMin + bsMinutesToday;
    if (dailyTotalMin > 10 * 60) {
      warnings.push({
        code: "MAX_DAILY_EXCEEDED",
        severity: "error",
        message: `§ 3 ArbZG: Tägliche Höchstarbeitszeit von 10 Stunden überschritten. Erfasst: ${(dailyTotalMin / 60).toFixed(1)} h.`,
      });
    }

    // § 5 ArbZG – Mindestruhezeit (11h zwischen Arbeitstagen)
    // Vortag prüfen: letzter Slot des Vortages
    const prevDate = new Date(changedDate);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDateStr = dateStrInTz(prevDate, tz);

    const prevLastSlot = await prisma.timeEntry.findFirst({
      where: {
        employeeId,
        deletedAt: null,
        date: { gte: new Date(prevDateStr), lte: new Date(prevDateStr + "T23:59:59.999Z") },
        endTime: { not: null },
      },
      orderBy: { endTime: "desc" },
    });

    if (prevLastSlot?.endTime && daySlots.length > 0) {
      const restMin = (daySlots[0].startTime.getTime() - prevLastSlot.endTime.getTime()) / 60000;
      if (restMin < 11 * 60) {
        const restH = (restMin / 60).toFixed(1);
        warnings.push({
          code: "MIN_REST_VIOLATED",
          severity: "warning",
          message: `§ 5 ArbZG: Mindestruhezeit von 11 Stunden zwischen Arbeitstagen unterschritten. Ruhezeit: ${restH} h.`,
        });
      }
    }

    // Folgetag prüfen: erster Slot des Folgetages
    const nextDate = new Date(changedDate);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = dateStrInTz(nextDate, tz);

    const nextFirstSlot = await prisma.timeEntry.findFirst({
      where: {
        employeeId,
        deletedAt: null,
        date: { gte: new Date(nextDateStr), lte: new Date(nextDateStr + "T23:59:59.999Z") },
        endTime: { not: null },
      },
      orderBy: { startTime: "asc" },
    });

    const lastSlotToday = daySlots[daySlots.length - 1];
    if (nextFirstSlot && lastSlotToday.endTime) {
      const restMin = (nextFirstSlot.startTime.getTime() - lastSlotToday.endTime.getTime()) / 60000;
      if (restMin < 11 * 60) {
        const restH = (restMin / 60).toFixed(1);
        warnings.push({
          code: "MIN_REST_VIOLATED",
          severity: "warning",
          message: `§ 5 ArbZG: Mindestruhezeit zum Folgetag unterschritten. Ruhezeit: ${restH} h.`,
        });
      }
    }
  }

  // Phase 63 D-07 — §5 Mindestruhezeit on a BS-day.
  // The day-view branch above only fires when daySlots.length > 0. A BS-only day
  // (no regular work) also needs to be checked: 11h gap from BS-end → next-day
  // work, and 11h gap from prev-day work → BS-start (we treat BS start as 08:00
  // tenant-TZ by symmetry to the 18:00 end; this is the most conservative).
  // For the next-day check we use 18:00 tenant-TZ as BS-end on single days and
  // 24:00 on block-week days (≥5 BS days in the same ISO week, D-07).
  if (bsAbsenceToday) {
    const nextDate = new Date(changedDate);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = dateStrInTz(nextDate, tz);

    const nextFirstSlot = await prisma.timeEntry.findFirst({
      where: {
        employeeId,
        deletedAt: null,
        date: { gte: new Date(nextDateStr), lte: new Date(nextDateStr + "T23:59:59.999Z") },
        endTime: { not: null },
      },
      orderBy: { startTime: "asc" },
    });

    if (nextFirstSlot) {
      // Detect block-week: ≥5 BS days in the same ISO week as `changedDate`.
      const bsDaysThisWeek = await countBsDaysInIsoWeek(prisma, employeeId, changedDate);
      const isBlockWeek = bsDaysThisWeek >= 5;
      // Synthetic BS-end timestamp in tenant TZ:
      //   single day  → 18:00 of `changedDate`
      //   block week  → 24:00 (= next day 00:00) of `changedDate`
      const bsEndLocal = isBlockWeek ? `${nextDateStr}T00:00:00` : `${dateStr}T18:00:00`;
      const bsEndUtc = fromZonedTime(bsEndLocal, tz);
      const restMin = (nextFirstSlot.startTime.getTime() - bsEndUtc.getTime()) / 60000;
      if (restMin < 11 * 60) {
        const restH = (restMin / 60).toFixed(1);
        warnings.push({
          code: "MIN_REST_VIOLATED",
          severity: "warning",
          message: `§ 5 ArbZG: Mindestruhezeit zum Folgetag unterschritten. Ruhezeit: ${restH} h.`,
        });
      }
    }
  }

  // ── 2. Wochensicht: § 3 ArbZG – max. 48h / Woche ─────────────────────────
  // Derive week boundaries in tenant timezone to avoid UTC vs. local mismatch.
  // changedDate is UTC; dateStrInTz gives the calendar date in tenant TZ.
  const dayOfWeek = getDayOfWeekInTz(changedDate, tz); // 0=So, 1=Mo, ...
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  // Compute the date string for Monday in the tenant timezone
  const changedDateStr = dateStrInTz(changedDate, tz);
  const changedMs = new Date(changedDateStr + "T00:00:00Z").getTime();
  const mondayMs = changedMs - daysFromMonday * 86400000;
  const monday = new Date(mondayMs);
  const sunday = new Date(mondayMs + 6 * 86400000 + 86399999);

  const weekSlots = await prisma.timeEntry.findMany({
    where: {
      employeeId,
      deletedAt: null,
      startTime: { gte: monday, lte: sunday },
      endTime: { not: null },
      type: "WORK",
    },
  });

  const weeklyNetMin = weekSlots.reduce((sum, e) => {
    const slotMin = (e.endTime!.getTime() - e.startTime.getTime()) / 60000;
    return sum + slotMin - Number(e.breakMinutes ?? 0);
  }, 0);

  // Phase 76.31-05 (D-08 FULL) — sum the slot-resolved BS minutes for every
  // VOCATIONAL_SCHOOL day in this ISO week, instead of a flat bsDailyMin × N (or
  // the weekly-cap shortcut). getVocationalSchoolMinutesForDate returns the same
  // per-date amount used by the §3 daily check AND the saldo math — so a LONG day
  // counts 570 min (9.5h), a block week auto-caps via blockWeekMinutes/N, and the
  // 48h weekly cap reflects the real credited load (RESEARCH R5). Soft-delete-aware.
  const bsWeekRows = await prisma.absence.findMany({
    where: {
      employeeId,
      deletedAt: null, // CLAUDE.md soft-delete rule
      type: "VOCATIONAL_SCHOOL",
      startDate: { gte: monday, lte: sunday },
    },
    select: { startDate: true },
    orderBy: { startDate: "asc" },
  });
  const bsWeekDateStrs = Array.from(
    new Set(bsWeekRows.map((r) => r.startDate.toISOString().slice(0, 10))),
  );
  let bsMinutesThisWeek = 0;
  for (const ds of bsWeekDateStrs) {
    bsMinutesThisWeek += await getVocationalSchoolMinutesForDate(
      prisma,
      employeeId,
      new Date(`${ds}T00:00:00.000Z`),
      tenantConfig,
      { schedule, scheduleType },
    );
  }
  const weeklyTotalMin = weeklyNetMin + bsMinutesThisWeek;

  if (weeklyTotalMin > 48 * 60) {
    warnings.push({
      code: "MAX_WEEKLY_EXCEEDED",
      severity: "error",
      message: `§ 3 ArbZG: Wöchentliche Höchstarbeitszeit von 48 Stunden überschritten. Diese Woche: ${(weeklyTotalMin / 60).toFixed(1)} h.`,
    });
  }

  // ── 3. 24-Wochen-Durchschnitt: § 3 ArbZG – max. 8h/Werktag im Durchschnitt ─
  // The 8h/day rule in § 3 ArbZG is NOT a daily limit — it is a 24-week rolling average.
  // A 4-day/39h week (9.75h/day, 4 days) is perfectly legal because:
  //   936h total / 144 Werktage (24 × 6) = 6.5h/Werktag < 8h → no warning.
  // Denominator is always 144 Werktage (Mon–Sat × 24 weeks), regardless of how many
  // days the employee actually worked.
  // MONTHLY_HOURS employees (Minijobber, pure tracking) have no daily target — skip this check.
  if (scheduleType !== "MONTHLY_HOURS") {
    const windowStart = new Date(changedDate);
    windowStart.setDate(windowStart.getDate() - 167); // 168 days = 24 weeks × 7
    windowStart.setHours(0, 0, 0, 0);

    const avgEntries = await prisma.timeEntry.findMany({
      where: {
        employeeId,
        deletedAt: null,
        startTime: { gte: windowStart, lte: changedDate },
        endTime: { not: null },
        type: "WORK",
      },
      select: { startTime: true, endTime: true, breakMinutes: true },
    });

    const totalNetMin = avgEntries.reduce((sum, e) => {
      const slotMin = (e.endTime!.getTime() - e.startTime.getTime()) / 60000;
      return sum + slotMin - Number(e.breakMinutes ?? 0);
    }, 0);

    // Phase 63 D-05 — Count VOCATIONAL_SCHOOL absence days in the same 168-day
    // window and multiply by bsDailyMin. We use a simple `count × daily` even on
    // block weeks here because the 24-week denominator (144 Werktage) is so
    // large that block-week capping vs. uncapped contribution makes a
    // negligible difference (max delta over 24 weeks ≈ a few minutes/Werktag).
    const bsAvgAbsences = await prisma.absence.findMany({
      where: {
        employeeId,
        deletedAt: null, // CLAUDE.md soft-delete rule
        type: "VOCATIONAL_SCHOOL",
        startDate: { gte: windowStart, lte: changedDate },
      },
      select: { startDate: true },
    });
    const bsDistinctDaysInWindow = new Set(
      bsAvgAbsences.map((a) => a.startDate.toISOString().slice(0, 10)),
    ).size;
    const totalWithBsMin = totalNetMin + bsDistinctDaysInWindow * bsDailyMin;

    // 24 weeks × 6 Werktage (Mon–Sat) = 144 Werktage
    const WERKTAGE_IN_24_WEEKS = 144;
    const avgPerWerktag = totalWithBsMin / WERKTAGE_IN_24_WEEKS;

    if (avgPerWerktag > 8 * 60) {
      const avgH = (avgPerWerktag / 60).toFixed(1);
      warnings.push({
        code: "MAX_DAILY_AVG_EXCEEDED",
        severity: "warning",
        message: `§ 3 ArbZG: 24-Wochen-Durchschnitt von 8 Stunden überschritten. Aktueller Schnitt: ${avgH} h/Tag.`,
      });
    }
  }

  return warnings;
}
