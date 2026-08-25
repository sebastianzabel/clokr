import { FastifyInstance } from "fastify";
import PDFDocument from "pdfkit";
import iconv from "iconv-lite";
import { formatInTimeZone } from "date-fns-tz";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  getTenantTimezone,
  monthRangeUtc,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
  iterateDaysInTz,
  dateStrInTz,
} from "../utils/timezone";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import {
  SECTION9_LEGEND,
  generateMonthlyReportPdf,
  generateVacationOverviewPdf,
  streamCompanyMonthlyReportPdf,
  streamLeaveListPdf,
  streamVacationOverviewPdf,
} from "../utils/pdf";
import { selfHealUsedDays, loadVacationTypeMeta } from "../utils/leave-self-heal";
import { computeMonthSaldo } from "../utils/month-saldo";

// ── Month name lookup ─────────────────────────────────────────────────────────
const MONTH_NAMES = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

// ── Schedule helper types ─────────────────────────────────────────────────────

type WorkSchedule = {
  validFrom: Date;
  type: string;
  monthlyHours?: number | null;
  [key: string]: unknown;
};

type LeaveRequestWithType = {
  id: string;
  startDate: Date;
  endDate: Date;
  status: string;
  deletedAt: Date | null;
  halfDay: boolean;
  attestPresent: boolean;
  attestValidFrom: Date | null;
  attestValidTo: Date | null;
  leaveType: { name: string };
};

// ── Phase 104 (D-15, Tier 2) — tagesbasierte Entdopplung ───────────────────────
// reports.ts hat EIGENE Soll-/Tage-Berechnungen (calcAbsenceMinutes, daysForTypeName,
// daysForName im DATEV-Export), die weder closeEmployeeMonth() (Tier 1, Plan 104-02)
// noch calcLeaveAbsenceMinutesTz aufrufen. Der dortige Fix erreicht diese Stellen
// deshalb NICHT — siehe RESEARCH.md "The D-15 Soll-Dedup Surface" (Tier 2). Seit R1
// (§ 9 BUrlG) ist die Überlappung zweier genehmigter Anträge (SICK vs. VACATION) der
// Normalfall, nicht die Ausnahme. Ohne diese Entdopplung würde der Monatsbericht ein
// anderes Soll ausweisen als Dashboard und Monatsabschluss.
//
// Reihenfolge identisch zu close-employee-month.ts sortForDedup(): Ganztags vor
// Halbtags, dann startDate, dann id. Nur so kommen beide Implementierungen bei einem
// halben Urlaubstag unter ganztägiger Krankheit auf denselben Wert.
function sortLeaveForDedup<
  T extends { id: string; startDate: Date; endDate: Date; halfDay: boolean },
>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (a.halfDay ? 1 : 0) - (b.halfDay ? 1 : 0) ||
      a.startDate.getTime() - b.startDate.getTime() ||
      a.id.localeCompare(b.id),
  );
}

type AbsenceRecord = {
  startDate: Date;
  endDate: Date;
  type: string;
};

type TimeEntryRecord = {
  date: Date;
  startTime: Date;
  endTime: Date | null;
  breakMinutes: number | bigint | null;
  [key: string]: unknown;
};

// Employee shape returned by findMany with all necessary includes
type EmployeeWithIncludes = {
  id: string;
  firstName: string;
  lastName: string;
  employeeNumber: string;
  hireDate: Date;
  exitDate: Date | null;
  workSchedules: WorkSchedule[];
  timeEntries: TimeEntryRecord[];
  absences: AbsenceRecord[];
  leaveRequests: LeaveRequestWithType[];
  user: { role: "ADMIN" | "MANAGER" | "EMPLOYEE" };
};

// ── computeEmployeeSummary ────────────────────────────────────────────────────
// Pure helper — single source of truth for monthly summary calculation.
// Called by GET /monthly (JSON), GET /monthly/pdf (single-emp), GET /monthly/pdf/all (company).
function computeEmployeeSummary(
  emp: EmployeeWithIncludes,
  start: Date,
  end: Date,
  tz: string,
  holidayDeductionOpts?: { enabled: boolean; stateCode: string | null },
  // Phase 104 (D-30): confirmed § 9 credits overlapping the report month, bulk-fetched
  // ONCE by the caller (no per-employee query — T-104-09-N1) and pre-filtered to
  // pre-filtered to CONFIRMED-only (T-104-09-PENDING: an AU_PENDING credit changes nothing).
  section9Credits: Array<{ creditedStart: Date; creditedEnd: Date }> = [],
): {
  workedHours: number;
  targetHours: number;
  overtimeHours: number;
  sickDays: number;
  sickDaysWithAttest: number;
  sickDaysWithoutAttest: number;
  vacationDays: number;
  overtimeCompDays: number;
  specialLeaveDays: number;
  educationDays: number;
  unpaidDays: number;
  maternityDays: number;
  parentalDays: number;
  totalAbsenceDays: number;
  section9DaysThisMonth: number;
  entries: Array<{
    date: string;
    start: string;
    end: string;
    breakMin: number;
    netHours: number;
    note?: string;
  }>;
} {
  // ── Helper: pick schedule valid on a given date ───────────────────────────
  function getScheduleForDate(schedules: WorkSchedule[], date: Date): WorkSchedule | null {
    return (
      schedules
        .filter((s) => s.validFrom <= date)
        .sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime())[0] ?? null
    );
  }

  // ── Soll-Minuten (day-by-day, TZ-aware) ──────────────────────────────────
  function calcShouldMinutes(schedules: WorkSchedule[], hireDate?: Date): number {
    if (schedules.length === 0) return 0;
    const effectiveStart = hireDate && hireDate > start ? hireDate : start;
    const latestSchedule = getScheduleForDate(schedules, end);
    if (latestSchedule && String(latestSchedule.type) === "MONTHLY_HOURS") {
      const mh = Number(latestSchedule.monthlyHours ?? 0);
      if (mh <= 0) return 0;

      // Phase 15: apply holiday deduction when tenant toggle is enabled
      if (holidayDeductionOpts?.enabled && holidayDeductionOpts.stateCode !== undefined) {
        const DOW_KEYS_MH = [
          "sundayHours",
          "mondayHours",
          "tuesdayHours",
          "wednesdayHours",
          "thursdayHours",
          "fridayHours",
          "saturdayHours",
        ] as const;
        // Count working days in the full calendar month (denominator for dailySoll)
        let monthWorkdays = 0;
        iterateDaysInTz(start, end, tz, (dow) => {
          if (Number(latestSchedule[DOW_KEYS_MH[dow]] ?? 0) > 0) monthWorkdays++;
        });
        if (monthWorkdays > 0) {
          const dailySollMin = (mh * 60) / monthWorkdays;
          // Fetch holidays in the month and count those falling on configured workdays
          const startYear = start.getUTCFullYear();
          const endYear = end.getUTCFullYear();
          const holidays = getHolidays(
            startYear,
            holidayDeductionOpts.stateCode as Parameters<typeof getHolidays>[1],
          );
          if (endYear !== startYear)
            holidays.push(
              ...getHolidays(
                endYear,
                holidayDeductionOpts.stateCode as Parameters<typeof getHolidays>[1],
              ),
            );
          let holidayDeductionMin = 0;
          for (const h of holidays) {
            const hDate = new Date(h.date + "T12:00:00Z");
            if (hDate >= start && hDate <= end) {
              const dow = getDayOfWeekInTz(hDate, tz);
              if (Number(latestSchedule[DOW_KEYS_MH[dow]] ?? 0) > 0) {
                holidayDeductionMin += dailySollMin;
              }
            }
          }
          return Math.max(0, Math.round(mh * 60 - holidayDeductionMin));
        }
      }

      return mh * 60;
    }
    let totalMin = 0;
    const cur = new Date(effectiveStart);
    while (cur <= end) {
      const schedule = getScheduleForDate(schedules, cur);
      if (schedule) {
        const dow = getDayOfWeekInTz(cur, tz);
        totalMin += getDayHoursFromSchedule(schedule as Record<string, unknown>, dow) * 60;
      }
      cur.setDate(cur.getDate() + 1);
    }
    return totalMin;
  }

  // ── Abwesenheitsminuten (Schnittmenge mit Monat, TZ-aware) ───────────────
  // Phase 104 (D-15, Tier 2): `claimed` is a Set<string> of YYYY-MM-DD dates already
  // credited by an earlier-processed (per sortLeaveForDedup) leave request THIS
  // report is summing — shared across the whole absenceMin reduce below, so a
  // calendar day covered by two overlapping APPROVED requests reduces Soll exactly
  // once. Mirrors close-employee-month.ts's claimDays()/excludeHolidays reuse.
  // `halfDay` moves INSIDE the function (previously multiplied at the call site) so
  // the halving applies only to the days THIS request actually claimed.
  function calcAbsenceMinutes(
    schedules: WorkSchedule[],
    absStart: Date,
    absEnd: Date,
    claimed: Set<string>,
    halfDay: boolean,
  ): number {
    if (schedules.length === 0) return 0;
    const rangeStart = absStart < start ? start : absStart;
    const rangeEnd = absEnd > end ? end : absEnd;
    let min = 0;
    const cur = new Date(rangeStart);
    while (cur <= rangeEnd) {
      const key = dateStrInTz(cur, tz);
      if (!claimed.has(key)) {
        const schedule = getScheduleForDate(schedules, cur);
        if (schedule) {
          const dow = getDayOfWeekInTz(cur, tz);
          min += getDayHoursFromSchedule(schedule as Record<string, unknown>, dow) * 60;
        }
        claimed.add(key);
      }
      cur.setDate(cur.getDate() + 1);
    }
    return halfDay ? Math.round(min / 2) : min;
  }

  // ── Days in range clamped to [start, end] ────────────────────────────────
  function daysInRange(from: Date, to: Date): number {
    const s = from < start ? start : from;
    const e2 = to > end ? end : to;
    return Math.max(0, Math.round((e2.getTime() - s.getTime()) / 86400000) + 1);
  }

  // Phase 104 (D-15, Tier 2): day-iterating, dedup-aware day count. `dayClaimed` is
  // a FRESH Set for each call (own claim set per aggregation), so a day claimed for
  // one purpose (e.g. computing vacationDays) never silently zeroes out an unrelated
  // aggregation (e.g. totalAbsenceDays) that also needs to see that same day. Within
  // a single call, two overlapping rows in `rows` (same type, or the nonSickLeave
  // union) claim a shared day exactly once, in sortLeaveForDedup order.
  function countDedupedDays(rows: LeaveRequestWithType[]): number {
    const dayClaimed = new Set<string>();
    let total = 0;
    for (const lr of sortLeaveForDedup(rows)) {
      const s = lr.startDate < start ? start : lr.startDate;
      const e2 = lr.endDate > end ? end : lr.endDate;
      if (s > e2) continue;
      let dayCount = 0;
      const cur = new Date(s);
      while (cur <= e2) {
        const key = dateStrInTz(cur, tz);
        if (!dayClaimed.has(key)) {
          dayCount++;
          dayClaimed.add(key);
        }
        cur.setDate(cur.getDate() + 1);
      }
      total += lr.halfDay ? dayCount / 2 : dayCount;
    }
    return total;
  }

  function daysForTypeName(typeName: string): number {
    return countDedupedDays(emp.leaveRequests.filter((lr) => lr.leaveType.name === typeName));
  }

  // ── Worked hours ─────────────────────────────────────────────────────────
  const workedMin = emp.timeEntries.reduce((sum, e) => {
    const slotMin = e.endTime ? (e.endTime.getTime() - e.startTime.getTime()) / 60000 : 0;
    return sum + slotMin - Number(e.breakMinutes ?? 0);
  }, 0);

  // ── Target hours ─────────────────────────────────────────────────────────
  const rawShouldMin = calcShouldMinutes(emp.workSchedules, emp.hireDate);
  const latestSchedule = getScheduleForDate(emp.workSchedules, end);
  const isMonthlyHours = String(latestSchedule?.type ?? "") === "MONTHLY_HOURS";
  // Minijobber (MONTHLY_HOURS) arbeiten flexibel — Abwesenheiten reduzieren Soll nicht
  // Phase 104 (D-15, Tier 2): sollClaimed accumulates the calendar days already
  // credited by a processed leave request, shared across the whole reduce, so an
  // overlapping day (SICK vs. VACATION, R1) is deducted exactly once.
  const sollClaimed = new Set<string>();
  const absenceMin = isMonthlyHours
    ? 0
    : sortLeaveForDedup(emp.leaveRequests).reduce(
        (sum, lr) =>
          sum +
          calcAbsenceMinutes(
            emp.workSchedules,
            lr.startDate,
            lr.endDate,
            sollClaimed,
            Boolean(lr.halfDay),
          ),
        0,
      );
  const shouldMin = Math.max(0, rawShouldMin - absenceMin);

  // ── Sick days ────────────────────────────────────────────────────────────
  // Single source of truth: sick days are counted exclusively from LeaveRequest
  // records of type "Krankmeldung" / "Kinderkrank" (with attest metadata).
  // The Absence model (SICK / SICK_CHILD) is used for document tracking
  // (AU-Bescheinigung path) and must NOT contribute to these counters —
  // adding both would double-count days for the same sick event.
  // sickDaysAbsence is retained here as a reference for future use (e.g.,
  // cross-checking), but is intentionally excluded from sickDaysWithoutAttest.
  const _sickDaysAbsence = emp.absences
    .filter((a) => a.type === "SICK" || a.type === "SICK_CHILD")
    .reduce((sum, a) => {
      const s = a.startDate < start ? start : a.startDate;
      const e2 = a.endDate > end ? end : a.endDate;
      return sum + Math.max(0, Math.round((e2.getTime() - s.getTime()) / 86400000) + 1);
    }, 0);

  const sickLeaveRequests = emp.leaveRequests.filter(
    (lr) => lr.leaveType.name === "Krankmeldung" || lr.leaveType.name === "Kinderkrank",
  );

  let sickDaysWithAttest = 0;
  let sickDaysWithoutAttest = 0; // seeded from LeaveRequests only (not Absence) to avoid double-count

  for (const lr of sickLeaveRequests) {
    const factor = lr.halfDay ? 0.5 : 1;
    const totalDays = daysInRange(lr.startDate, lr.endDate) * factor;
    if (lr.attestPresent && lr.attestValidFrom && lr.attestValidTo) {
      const attestFrom = lr.attestValidFrom > lr.startDate ? lr.attestValidFrom : lr.startDate;
      const attestTo = lr.attestValidTo < lr.endDate ? lr.attestValidTo : lr.endDate;
      const attestDays = daysInRange(attestFrom, attestTo) * factor;
      sickDaysWithAttest += attestDays;
      sickDaysWithoutAttest += Math.max(0, totalDays - attestDays);
    } else if (lr.attestPresent) {
      sickDaysWithAttest += totalDays;
    } else {
      sickDaysWithoutAttest += totalDays;
    }
  }

  // ── Absence breakdown ────────────────────────────────────────────────────
  const SICK_NAMES = ["Krankmeldung", "Kinderkrank"];
  const nonSickLeave = emp.leaveRequests.filter((lr) => !SICK_NAMES.includes(lr.leaveType.name));
  // Phase 104 (D-15, Tier 2): countDedupedDays() gives totalAbsenceDays its OWN
  // claim set (separate from every daysForTypeName() call below) so a day covered by
  // two overlapping non-sick requests is counted once in the aggregate figure too —
  // independent from, not shared with, the per-type calls (which must not lose a
  // day just because an unrelated type's call already saw it).
  let totalAbsenceDays = countDedupedDays(nonSickLeave);
  let vacationDays = daysForTypeName("Urlaub");
  const overtimeCompDays = daysForTypeName("Überstundenausgleich");
  const specialLeaveDays = daysForTypeName("Sonderurlaub");
  const educationDays = daysForTypeName("Bildungsurlaub");
  const unpaidDays = daysForTypeName("Unbezahlter Urlaub");
  const maternityDays = daysForTypeName("Mutterschutz");
  const parentalDays = daysForTypeName("Elternzeit");

  // Phase 104 (D-30): gutgeschriebene § 9-Tage wandern von Urlaub nach Krank-mit-
  // Attest. Sie sind per Definition attestiert — ohne ärztliches Zeugnis gäbe es die
  // Gutschrift nicht (section9Credits is already CONFIRMED-only, filtered by the
  // caller). daysInRange() clips each credit to the report month, mirroring the day
  // rule the surrounding sick-day computation already uses (no third rule).
  //
  // [Rule 1 fix] D-02 keeps the underlying SICK LeaveRequest's own attestPresent flag
  // untouched by a § 9 confirm — a manager confirms via the dedicated "AU liegt vor"
  // flow, not the older PATCH /requests/:id/attest endpoint. Without shifting these
  // days OUT of sickDaysWithoutAttest first, a credited day would count TWICE in the
  // sick total (once from the sickLeaveRequests loop above, once here) and break the
  // "sickDays = sickDaysWithAttest + sickDaysWithoutAttest" invariant this file's own
  // tests assert.
  //
  // [Phase 104 review WR-02] The subtraction was clamped but the addition was not, so a
  // Krankmeldung that ALREADY carries attestPresent (set independently via
  // PATCH /requests/:id/attest, which D-02 keeps orthogonal to § 9) had its days counted
  // in sickDaysWithAttest by the loop above AND added again here — a 2-day sickness with a
  // full attest and both days § 9-confirmed reported sickDays = 4. Only days that were
  // actually IN the without-attest bucket may be shifted, so the two buckets move as one
  // transfer and their sum is invariant.
  const section9DaysThisMonth = section9Credits.reduce(
    (s, c) => s + daysInRange(c.creditedStart, c.creditedEnd),
    0,
  );
  const section9DaysShiftedToAttest = Math.min(sickDaysWithoutAttest, section9DaysThisMonth);
  sickDaysWithoutAttest -= section9DaysShiftedToAttest;
  sickDaysWithAttest += section9DaysShiftedToAttest;
  vacationDays = Math.max(0, vacationDays - section9DaysThisMonth);
  totalAbsenceDays = Math.max(0, totalAbsenceDays - section9DaysThisMonth);

  // ── Time entries (formatted) ─────────────────────────────────────────────
  const entries = emp.timeEntries.map((e) => ({
    date: formatInTimeZone(e.date, tz, "dd.MM.yyyy"),
    start: formatInTimeZone(e.startTime, tz, "HH:mm"),
    end: e.endTime ? formatInTimeZone(e.endTime, tz, "HH:mm") : "",
    breakMin: Number(e.breakMinutes ?? 0),
    netHours: e.endTime
      ? Math.round(
          (((e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes ?? 0)) /
            60) *
            100,
        ) / 100
      : 0,
    note: (e as Record<string, unknown>).note as string | undefined,
  }));

  const workedHours = Math.round((workedMin / 60) * 100) / 100;
  const targetHours = Math.round((shouldMin / 60) * 100) / 100;

  return {
    workedHours,
    targetHours,
    overtimeHours: Math.round((workedHours - targetHours) * 100) / 100,
    sickDays: sickDaysWithAttest + sickDaysWithoutAttest,
    sickDaysWithAttest,
    sickDaysWithoutAttest,
    vacationDays,
    section9DaysThisMonth,
    overtimeCompDays,
    specialLeaveDays,
    educationDays,
    unpaidDays,
    maternityDays,
    parentalDays,
    totalAbsenceDays,
    entries,
  };
}

// ── resolveReportOvertimeHours ────────────────────────────────────────────────
// §615-consistent Überstunden figure for the monthly Stundennachweis PDF (the legal
// Arbeitszeitnachweis). computeEmployeeSummary computes overtime NAIVELY as worked − target, which is
// wrong for SHIFT_BASED (no §615, roster Soll lives in the Shift table). This resolver picks the
// correct source and also reports the labelling metadata the PDF needs (SALDO-DISP-05): `confirmed`
// is true only for the CLOSED-month branch (the one figure that is final), and `labelled` is false
// only for the MONTHLY_HOURS-no-budget branch, whose figure never moves and already has its own
// dedicated "Keine Soll-Vorgabe" state on screen — the PDF renderer omits the Bestätigt/Prognose
// label entirely for it rather than calling an unmoving figure a permanent "Prognose". The PDF
// payload SHAPE is otherwise unchanged beyond the new `overtimeConfirmed` field this resolver feeds:
//   - MONTHLY_HOURS(null/0) / no schedule → 0, confirmed:false, labelled:false (pure tracking, no
//     saldo target — this check fires BEFORE the snapshot check below, for every month, open or
//     closed).
//   - CLOSED month (non-superseded MONTHLY SaldoSnapshot for the exact period) → snapshot.balanceMinutes,
//     confirmed:true, labelled:true, for ALL remaining schedule types (immutable —
//     Revisionssicherheit; never recompute a closed month).
//   - OPEN month + SHIFT_BASED → computeMonthSaldo(...).balanceMinutes (§615 two-clause; same source of
//     truth as the live calendar header / dashboard / overtime-overview), confirmed:false,
//     labelled:true.
//   - OPEN month + non-SHIFT (FIXED_*/FLEXTIME/MONTHLY_HOURS target>0) → keep the naive worked − target
//     (unchanged: preserves the working absence-deduction + whole-month Stundennachweis model),
//     confirmed:false, labelled:true.
// Fail-safe: on any error, fall back to the provided naive value (confirmed:false, labelled:true) so
// the PDF never fails to generate.
async function resolveReportOvertimeHours(
  app: FastifyInstance,
  emp: EmployeeWithIncludes,
  year: number,
  month: number,
  monthStart: Date,
  naiveOvertimeHours: number,
): Promise<{ hours: number; confirmed: boolean; labelled: boolean }> {
  try {
    // Effective schedule for the reported month (latest validFrom ≤ month end already resolved by
    // the caller's include ordering; use the last row as the effective one).
    const latest =
      emp.workSchedules.length > 0 ? emp.workSchedules[emp.workSchedules.length - 1] : null;
    const scheduleType = String(latest?.type ?? "");

    // MONTHLY_HOURS pure-tracking (null/0 budget) → no saldo target.
    if (scheduleType === "MONTHLY_HOURS" && !(Number(latest?.monthlyHours ?? 0) > 0)) {
      // labelled:false — see the resolver's leading comment. The PDF renderer omits the
      // Bestätigt/Prognose label entirely for this population instead of mislabelling it.
      return { hours: 0, confirmed: false, labelled: false };
    }

    // CLOSED month → immutable snapshot balance (all types).
    const snapshot = await app.prisma.saldoSnapshot.findFirst({
      where: {
        employeeId: emp.id,
        periodType: "MONTHLY",
        periodStart: monthStart,
        superseded: false,
      },
      select: { balanceMinutes: true },
    });
    if (snapshot) {
      return {
        hours: Math.round((snapshot.balanceMinutes / 60) * 100) / 100,
        confirmed: true,
        labelled: true,
      };
    }

    // OPEN month + SHIFT_BASED → §615 core (computeMonthSaldo). Non-SHIFT keeps the naive value.
    if (scheduleType === "SHIFT_BASED") {
      const ms = await computeMonthSaldo(app, emp.id, year, month);
      return {
        hours: Math.round((ms.balanceMinutes / 60) * 100) / 100,
        confirmed: false,
        labelled: true,
      };
    }

    return { hours: naiveOvertimeHours, confirmed: false, labelled: true };
  } catch (err) {
    app.log.warn(
      { err, employeeId: emp.id, year, month },
      "resolveReportOvertimeHours failed, using naive worked−target",
    );
    return { hours: naiveOvertimeHours, confirmed: false, labelled: true };
  }
}

// ── buildDatevLodas ───────────────────────────────────────────────────────────
// Shared utility — produces a CP1252-encoded Buffer containing a valid DATEV LODAS
// TXT file (three INI sections: [Allgemein], [Satzbeschreibung], [Bewegungsdaten]).
// Used by both the company-wide GET /datev and the per-employee GET /datev/employee.
type DatevEmployee = {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  timeEntries: Array<{
    startTime: Date;
    endTime: Date | null;
    breakMinutes: number | bigint | null;
  }>;
  absences: Array<{ startDate: Date; endDate: Date; type: string; halfDay?: boolean | null }>;
  leaveRequests: Array<{ startDate: Date; endDate: Date; leaveType: { name: string } }>;
};

function buildDatevLodas(params: {
  employees: DatevEmployee[];
  year: number;
  month: number;
  start: Date;
  end: Date;
  lna: { normal: number; urlaub: number; krank: number; sonderurlaub: number };
  // Phase 104 (D-30): bestätigte § 9-Gutschriften je Mitarbeiter, bereits bulk-fetched
  // und CONFIRMED-only gefiltert vom Aufrufer (T-104-09-N1/PENDING).
  section9ByEmp?: Map<string, Array<{ creditedStart: Date; creditedEnd: Date }>>;
}): Buffer {
  const { employees, year: y, month: m, start, end, lna, section9ByEmp } = params;
  const CRLF = "\r\n";
  const lines: string[] = [];

  /** Dezimal mit Komma formatieren */
  function dec(n: number, digits = 2): string {
    return n.toFixed(digits).replace(".", ",");
  }

  /** Arbeitstage (Mo-Fr) im Schnittmenge aus [from,to] ∩ [start,end] zählen */
  function workDaysInMonthRange(from: Date, to: Date): number {
    const s = from < start ? start : from;
    const e2 = to > end ? end : to;
    let count = 0;
    const cur = new Date(s);
    while (cur <= e2) {
      const dow = cur.getUTCDay();
      if (dow !== 0 && dow !== 6) count++;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return count;
  }

  function daysForName(emp: DatevEmployee, name: string): number {
    return emp.leaveRequests
      .filter((lr) => lr.leaveType.name === name)
      .reduce((sum, lr) => sum + workDaysInMonthRange(lr.startDate, lr.endDate), 0);
  }

  /** DATEV-Zeile: 12 Felder, leere Felder = Semikolon */
  function datevLine(
    pn: string,
    name: string,
    datum: string,
    ausfall: string,
    lohnart: number,
    stunden: number,
    tage: number,
  ): string {
    return `${pn};${name};${datum};${ausfall};${lohnart};${stunden > 0 ? dec(stunden) : ""};${tage > 0 ? dec(tage, 1) : ""};;;;;`;
  }

  for (const emp of employees) {
    const pn = emp.employeeNumber;
    // Employee name for DATEV identification
    const name = `${emp.lastName} ${emp.firstName}`;
    // Kalendertag = letzter Tag des Monats im DDMMJJJJ-Format (DATEV-Konvention)
    const lastDay = new Date(y, m, 0).getDate();
    const datum = `${String(lastDay).padStart(2, "0")}${String(m).padStart(2, "0")}${y}`;

    // Arbeitsstunden
    const workedMinutes = emp.timeEntries.reduce((sum, e) => {
      if (!e.endTime) return sum;
      return (
        sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes ?? 0)
      );
    }, 0);
    const workedHours = workedMinutes / 60;

    // Krankheit aus Absence-Modell
    // Phase 76.32.1 (Wave 4): a.halfDay → count 0.5 instead of full workDaysInMonthRange.
    const sickDays = emp.absences
      .filter((a) => a.type === "SICK")
      .reduce(
        (sum, a) => sum + (a.halfDay ? 0.5 : workDaysInMonthRange(a.startDate, a.endDate)),
        0,
      );
    const sickChildDays = emp.absences
      .filter((a) => a.type === "SICK_CHILD")
      .reduce(
        (sum, a) => sum + (a.halfDay ? 0.5 : workDaysInMonthRange(a.startDate, a.endDate)),
        0,
      );

    // Abwesenheiten aus LeaveRequest (nur Arbeitstage)
    const vacationDays = daysForName(emp, "Urlaub");
    const overtimeCompDays = daysForName(emp, "Überstundenausgleich");
    const specialDays = daysForName(emp, "Sonderurlaub");
    const educationDays = daysForName(emp, "Bildungsurlaub");
    const unpaidDays = daysForName(emp, "Unbezahlter Urlaub");
    const maternityDays = daysForName(emp, "Mutterschutz");
    const parentalDays = daysForName(emp, "Elternzeit");

    // Phase 104 (D-30): § 9-Tage aus der Urlaubs-Lohnart heraus- und in die Krank-
    // Lohnart hineinrechnen. Die Summe über beide Zeilen bleibt unverändert — es wird
    // nichts erfunden und nichts verloren, nur richtig zugeordnet. Ohne diese
    // Korrektur meldet der Export denselben Ausfalltag doppelt (T-104-09-PAYROLL).
    const section9WorkDays = (section9ByEmp?.get(emp.id) ?? []).reduce(
      (s, c) => s + workDaysInMonthRange(c.creditedStart, c.creditedEnd),
      0,
    );
    const vacationDaysDatev = Math.max(0, vacationDays - section9WorkDays);
    const sickDaysDatev = sickDays + section9WorkDays;

    // DATEV-Zeilen (Format: 12 Felder, Semikolon-getrennt) — datevLine()'s own body is
    // untouched by Phase 104; only the values fed into the Urlaub/Krank calls changed.
    lines.push(datevLine(pn, name, datum, "", lna.normal, workedHours, 0));
    if (sickDaysDatev > 0) lines.push(datevLine(pn, name, datum, "K", lna.krank, 0, sickDaysDatev));
    if (sickChildDays > 0) lines.push(datevLine(pn, name, datum, "K", 201, 0, sickChildDays));
    if (vacationDaysDatev > 0)
      lines.push(datevLine(pn, name, datum, "U", lna.urlaub, 0, vacationDaysDatev));
    if (overtimeCompDays > 0) lines.push(datevLine(pn, name, datum, "U", 301, 0, overtimeCompDays));
    if (specialDays > 0)
      lines.push(datevLine(pn, name, datum, "S", lna.sonderurlaub, 0, specialDays));
    if (educationDays > 0) lines.push(datevLine(pn, name, datum, "S", 303, 0, educationDays));
    if (unpaidDays > 0) lines.push(datevLine(pn, name, datum, "", 304, 0, unpaidDays));
    if (maternityDays > 0) lines.push(datevLine(pn, name, datum, "", 310, 0, maternityDays));
    if (parentalDays > 0) lines.push(datevLine(pn, name, datum, "", 320, 0, parentalDays));
  }

  // ── DATEV LODAS ASCII-Import Format ──────────────────────────────────────
  // Produces a CP1252-encoded .txt file with three INI sections:
  //   [Allgemein]        – Ziel=LODAS, Version_SST=1.0, BeraterNr=0, MandantenNr=0, Datumsangaben=DDMMJJJJ
  //   [Satzbeschreibung] – describes the 12-field semicolon format of Bewegungsdaten rows
  //   [Bewegungsdaten]   – actual employee rows
  //
  // 12 Felder pro Datenzeile, Semikolon-getrennt, Dezimal-Komma, CRLF line endings.
  // Ausfallschlüssel: U=Urlaub, K=Krank, S=Sonderurlaub, (leer)=Arbeit
  const iniHeader = [
    "[Allgemein]",
    "Ziel=LODAS",
    "Version_SST=1.0",
    "BeraterNr=0",
    "MandantenNr=0",
    "Datumsangaben=DDMMJJJJ",
    `Abrechnungszeitraum=${String(m).padStart(2, "0")}${y}`,
    "",
    "[Satzbeschreibung]",
    "20;u_lod_bwd_buchung_kst;pnr#bwd;name#bwd;datum#bwd;ausfallkennzeichen#bwd;u_lod_lna_nr#bwd;stunden#bwd;tage#bwd;betrag#bwd;faktor#bwd;kuerzung#bwd;kostenstelle#bwd;kostentraeger#bwd",
    "",
    "[Bewegungsdaten]",
  ].join(CRLF);

  const bodyText = iniHeader + CRLF + lines.join(CRLF) + CRLF;
  return iconv.encode(bodyText, "win1252") as Buffer;
}

// ── Common employee include shape ─────────────────────────────────────────────
function buildEmployeeInclude(start: Date, end: Date) {
  return {
    user: { select: { role: true } },
    workSchedules: { orderBy: { validFrom: "asc" } },
    timeEntries: {
      where: {
        deletedAt: null,
        date: { gte: start, lte: end },
        type: "WORK",
        endTime: { not: null },
        isInvalid: false,
      },
      orderBy: { date: "asc" },
    },
    absences: {
      where: { deletedAt: null, startDate: { lte: end }, endDate: { gte: start } },
    },
    leaveRequests: {
      where: {
        deletedAt: null,
        status: "APPROVED",
        startDate: { lte: end },
        endDate: { gte: start },
      },
      include: { leaveType: true },
    },
  } as const;
}

// Phase 104 (D-30): bestätigte § 9-Gutschriften für den Berichtsmonat, EINE Abfrage über
// alle sichtbaren Mitarbeiter (T-104-09-N1 — kein Query pro Mitarbeiter), tenant-gescoped
// (T-104-09-TENANT) und CONFIRMED-only gefiltert (T-104-09-PENDING — ein
// AU_PENDING-Vorgang verändert keine gemeldete Zahl). Ein solcher Tag IST fachlich ein
// Kranktag — der Urlaubsantrag bleibt zwar unverändert bestehen (D-05), aber angerechnet
// wird er nicht mehr. Ohne diese Zuordnung würde derselbe Tag zweimal auftauchen: einmal
// unter Urlaub (aus dem unveränderten LeaveRequest) und einmal unter Krankheit.
//
// Phase 104 review (IN-01): the DATEV handlers used to call a byte-identical copy of this
// function (fetchConfirmedSection9CreditsForDatev). The copy was justified by "a different
// Employee shape at the call sites", but neither function ever touched the Employee shape —
// both take (app, tenantId, start, end) and return the same Map. Two copies of a
// payroll-relevant filter (status CONFIRMED + tenant scope) can drift, so there is one.
async function fetchConfirmedSection9CreditsByEmp(
  app: FastifyInstance,
  tenantId: string,
  start: Date,
  end: Date,
): Promise<Map<string, Array<{ creditedStart: Date; creditedEnd: Date }>>> {
  const credits = await app.prisma.section9Credit.findMany({
    where: {
      status: "CONFIRMED",
      employee: { tenantId },
      creditedStart: { lte: end },
      creditedEnd: { gte: start },
    },
    select: { employeeId: true, creditedStart: true, creditedEnd: true },
  });
  const byEmp = new Map<string, Array<{ creditedStart: Date; creditedEnd: Date }>>();
  for (const c of credits) {
    if (c.creditedStart === null || c.creditedEnd === null) continue;
    const arr = byEmp.get(c.employeeId) ?? [];
    arr.push({ creditedStart: c.creditedStart, creditedEnd: c.creditedEnd });
    byEmp.set(c.employeeId, arr);
  }
  return byEmp;
}

export async function reportRoutes(app: FastifyInstance) {
  // GET /api/v1/reports/monthly?employeeId=&year=&month=
  app.get("/monthly", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { employeeId, year, month } = req.query as {
        employeeId?: string;
        year: string;
        month: string;
      };

      const y = parseInt(year);
      const m = parseInt(month);
      if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
        return reply.code(400).send({ error: "Ungültige Jahr- oder Monatsangabe" });
      }
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const { start, end } = monthRangeUtc(y, m, tz);

      // Phase 15: fetch tenant config for MONTHLY_HOURS holiday deduction
      const [tenantCfg, tenantRow] = await Promise.all([
        app.prisma.tenantConfig.findUnique({
          where: { tenantId: req.user.tenantId },
          select: { monthlyHoursHolidayDeduction: true },
        }),
        app.prisma.tenant.findUnique({
          where: { id: req.user.tenantId },
          select: { federalState: true },
        }),
      ]);
      const monthlyHolidayDeductionOpts = {
        enabled: tenantCfg?.monthlyHoursHolidayDeduction === true,
        stateCode: tenantRow?.federalState ? (STATE_MAP[tenantRow.federalState] ?? null) : null,
      };

      // Alle Mitarbeiter des Tenants (oder nur einen)
      const employees = (await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          ...(employeeId ? { id: employeeId } : {}),
          exitDate: null,
          user: { isActive: true },
        },
        include: buildEmployeeInclude(start, end),
        orderBy: { lastName: "asc" },
      })) as unknown as EmployeeWithIncludes[];

      // Phase 104 (D-30): bulk-fetched once, keyed by employeeId — see the function's
      // own doc block above for the tenant/status/N1 rationale.
      const section9ByEmp = await fetchConfirmedSection9CreditsByEmp(
        app,
        req.user.tenantId,
        start,
        end,
      );

      const rows = employees.map((emp) => {
        const summary = computeEmployeeSummary(
          emp,
          start,
          end,
          tz,
          monthlyHolidayDeductionOpts,
          section9ByEmp.get(emp.id) ?? [],
        );
        return {
          employeeId: emp.id,
          employeeName: `${emp.firstName} ${emp.lastName}`,
          employeeNumber: emp.employeeNumber,
          workedHours: summary.workedHours,
          shouldHours: summary.targetHours,
          // Krankheit
          sickDays: summary.sickDays,
          sickDaysWithAttest: summary.sickDaysWithAttest,
          sickDaysWithoutAttest: summary.sickDaysWithoutAttest,
          // Abwesenheiten nach Grund
          vacationDays: summary.vacationDays,
          overtimeCompDays: summary.overtimeCompDays,
          specialLeaveDays: summary.specialLeaveDays,
          educationDays: summary.educationDays,
          unpaidDays: summary.unpaidDays,
          maternityDays: summary.maternityDays,
          parentalDays: summary.parentalDays,
          totalAbsenceDays: summary.totalAbsenceDays,
          section9DaysThisMonth: summary.section9DaysThisMonth,
        };
      });

      // D-30's "erklärender Hinweis in der Legende": emitted only when at least one
      // employee's figures were actually touched, so unaffected reports are unchanged.
      // Wording lives in utils/pdf.ts so JSON and both PDFs cannot drift (Phase 104 gap closure).
      const section9Note = rows.some((r) => r.section9DaysThisMonth > 0)
        ? SECTION9_LEGEND
        : undefined;

      return { month: parseInt(month), year: y, rows, ...(section9Note ? { section9Note } : {}) };
    },
  });

  // GET /api/v1/reports/leave-overview?year=
  app.get("/leave-overview", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req) => {
      const { year } = req.query as { year: string };
      const y = parseInt(year ?? new Date().getFullYear().toString());

      const entitlements = await app.prisma.leaveEntitlement.findMany({
        where: {
          year: y,
          employee: { tenantId: req.user.tenantId },
        },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
          leaveType: true,
        },
      });

      // Self-heal usedDays from Σ approved LeaveRequest.days BEFORE we shape the response.
      // Mirrors the heal that GET /entitlements/:employeeId has done since v1.4.
      // Fixes the report-vs-leave-page divergence (a-tenant incident 2026-05-27).
      const vacMeta = await loadVacationTypeMeta(app.prisma, req.user.tenantId);
      await selfHealUsedDays(app.prisma, entitlements, vacMeta);

      // Bulk fetch PENDING leave requests for the same year + tenant (NO per-entitlement loop)
      const pending = await app.prisma.leaveRequest.findMany({
        where: {
          employee: { tenantId: req.user.tenantId },
          status: "PENDING",
          deletedAt: null,
          // Filter by year: only requests whose startDate falls within year y
          startDate: {
            gte: new Date(Date.UTC(y, 0, 1)),
            lt: new Date(Date.UTC(y + 1, 0, 1)),
          },
        },
        select: { employeeId: true, leaveTypeId: true, days: true },
      });

      // Build a lookup map keyed by "employeeId:leaveTypeId" → summed pending days
      const pendingMap = new Map<string, number>();
      for (const row of pending) {
        const key = `${row.employeeId}:${row.leaveTypeId}`;
        pendingMap.set(key, (pendingMap.get(key) ?? 0) + Number(row.days));
      }

      return entitlements.map((e) => ({
        employee: e.employee,
        leaveType: e.leaveType,
        year: e.year,
        totalDays: Number(e.totalDays),
        carriedOverDays: Number(e.carriedOverDays),
        usedDays: Number(e.usedDays),
        remainingDays: Number(e.totalDays) + Number(e.carriedOverDays) - Number(e.usedDays),
        pendingDays: pendingMap.get(`${e.employeeId}:${e.leaveTypeId}`) ?? 0,
      }));
    },
  });

  // GET /api/v1/reports/carryover-at-risk?days=60
  //
  // Returns entitlements whose carry-over deadline falls within the next
  // ?days days (default 60) AND that still have non-zero carried-over days.
  // Used by the /reports "Verfall-Warnungen" widget so managers see at-risk
  // employees before the EuGH C-684/16 deadline triggers.
  app.get("/carryover-at-risk", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req) => {
      const { days } = req.query as { days?: string };
      const horizon = Math.max(1, Math.min(365, parseInt(days ?? "60", 10) || 60));

      const now = new Date();
      const cutoff = new Date(now.getTime() + horizon * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const entitlements = await app.prisma.leaveEntitlement.findMany({
        where: {
          employee: { tenantId: req.user.tenantId, exitDate: null },
          carriedOverDays: { gt: 0 },
          carryOverDeadline: { gt: now, lte: cutoff },
        },
        include: {
          employee: {
            select: { id: true, firstName: true, lastName: true, employeeNumber: true },
          },
          leaveType: { select: { id: true, name: true } },
        },
      });

      // Look up the most recent CARRYOVER_WARNED audit log per entitlement,
      // so the UI can show "Letzter Hinweis" without N+1 queries.
      const entitlementIds = entitlements.map((e) => e.id);
      const recentWarnings = entitlementIds.length
        ? await app.prisma.auditLog.findMany({
            where: {
              action: "CARRYOVER_WARNED",
              entity: "LeaveEntitlement",
              entityId: { in: entitlementIds },
            },
            orderBy: { createdAt: "desc" },
            select: { entityId: true, createdAt: true },
          })
        : [];

      const lastWarningMap = new Map<string, Date>();
      for (const w of recentWarnings) {
        if (w.entityId && !lastWarningMap.has(w.entityId)) {
          lastWarningMap.set(w.entityId, w.createdAt);
        }
      }

      // Count of warnings sent in the last 30 days (KPI)
      const warnedLast30 = await app.prisma.auditLog.count({
        where: {
          action: "CARRYOVER_WARNED",
          entity: "LeaveEntitlement",
          entityId: { in: entitlementIds },
          createdAt: { gte: thirtyDaysAgo },
        },
      });

      const rows = entitlements
        .map((e) => {
          const deadline = e.carryOverDeadline as Date;
          const daysUntilDeadline = Math.ceil(
            (deadline.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
          );
          return {
            entitlementId: e.id,
            employee: e.employee,
            leaveType: e.leaveType,
            year: e.year,
            carriedOverDays: Number(e.carriedOverDays),
            deadline: deadline.toISOString(),
            daysUntilDeadline,
            lastWarningSentAt: lastWarningMap.get(e.id)?.toISOString() ?? null,
          };
        })
        .sort((a, b) => a.daysUntilDeadline - b.daysUntilDeadline);

      const totalDaysAtRisk = rows.reduce((sum, r) => sum + r.carriedOverDays, 0);

      return {
        horizonDays: horizon,
        summary: {
          employeesAtRisk: rows.length,
          totalDaysAtRisk,
          warnedLast30,
        },
        rows,
      };
    },
  });

  // POST /api/v1/reports/carryover-warn
  //
  // Manual trigger for BUrlG § 7 Hinweispflicht. Same logic as the daily
  // cron — including AuditLog dedup, audit-before-action ordering, employee
  // notification, and manager CC — but scoped to a single entitlement.
  app.post("/carryover-warn", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { entitlementId } = (req.body ?? {}) as { entitlementId?: string };
      if (!entitlementId) {
        return reply.code(400).send({ error: "entitlementId fehlt" });
      }

      // Tenant scope check
      const ent = await app.prisma.leaveEntitlement.findUnique({
        where: { id: entitlementId },
        include: { employee: { select: { tenantId: true } } },
      });
      if (!ent || ent.employee.tenantId !== req.user.tenantId) {
        return reply.code(404).send({ error: "Anspruch nicht gefunden" });
      }

      const { runCarryoverWarningOnce } = await import("../plugins/carryover-warning");
      const result = await runCarryoverWarningOnce(app, { onlyEntitlementId: entitlementId });

      // Audit the manual trigger separately so we can distinguish operator
      // action from the cron-driven warnings in the audit log.
      await app.audit({
        userId: req.user.sub,
        action: "CARRYOVER_WARN_TRIGGERED",
        entity: "LeaveEntitlement",
        entityId: entitlementId,
        newValue: {
          source: "manual",
          ...result,
        },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return {
        ok: true,
        warned: result.warned,
        skippedDedup: result.skippedDedup,
      };
    },
  });

  // GET /api/v1/reports/datev?year=&month=  – DATEV LODAS Export
  app.get("/datev", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { year, month } = req.query as { year: string; month: string };
      const y = parseInt(year);
      const m = parseInt(month);
      if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
        return reply.code(400).send({ error: "Ungültige Jahr- oder Monatsangabe" });
      }
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const { start, end } = monthRangeUtc(y, m, tz);

      const employees = await app.prisma.employee.findMany({
        where: { tenantId: req.user.tenantId, exitDate: null, user: { isActive: true } },
        include: {
          workSchedules: { orderBy: { validFrom: "asc" } },
          timeEntries: {
            where: {
              deletedAt: null,
              date: { gte: start, lte: end },
              endTime: { not: null },
              isInvalid: false,
            },
          },
          absences: {
            where: { deletedAt: null, startDate: { lte: end }, endDate: { gte: start } },
          },
          leaveRequests: {
            where: {
              deletedAt: null,
              status: "APPROVED",
              startDate: { lte: end },
              endDate: { gte: start },
            },
            include: { leaveType: true },
          },
        },
      });

      // Read configurable Lohnartennummern from TenantConfig
      // Lohnarten (4 konfigurierbar via TenantConfig, 6 hardcoded):
      //   CONFIGURABLE:
      //     datevNormalstundenNr (default 100) = Normalstunden
      //     datevKrankNr         (default 200) = Krankheit (AU)
      //     datevUrlaubNr        (default 300) = Urlaub
      //     datevSonderurlaubNr  (default 302) = Sonderurlaub
      //   HARDCODED:
      //     201 = Krankheit Kind         | 301 = Überstundenausgleich
      //     303 = Bildungsurlaub         | 304 = Unbezahlter Urlaub
      //     310 = Mutterschutz           | 320 = Elternzeit
      const datevConfig = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: req.user.tenantId },
        select: {
          datevNormalstundenNr: true,
          datevUrlaubNr: true,
          datevKrankNr: true,
          datevSonderurlaubNr: true,
        },
      });
      const lna = {
        normal: datevConfig?.datevNormalstundenNr ?? 100,
        urlaub: datevConfig?.datevUrlaubNr ?? 300,
        krank: datevConfig?.datevKrankNr ?? 200,
        sonderurlaub: datevConfig?.datevSonderurlaubNr ?? 302,
      };

      const section9ByEmpDatev = await fetchConfirmedSection9CreditsByEmp(
        app,
        req.user.tenantId,
        start,
        end,
      );

      const buf = buildDatevLodas({
        employees,
        year: y,
        month: m,
        start,
        end,
        lna,
        section9ByEmp: section9ByEmpDatev,
      });

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: { type: "DATEV", year, month },
      });

      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Disposition", `attachment; filename="datev-${year}-${month}.txt"`);
      return reply.send(buf);
    },
  });

  // GET /api/v1/reports/datev/employee?employeeId=&year=&month=  – Per-Employee DATEV LODAS Export (RPT-03)
  app.get("/datev/employee", {
    schema: { tags: ["Berichte"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { employeeId, year, month } = req.query as {
        employeeId?: string;
        year: string;
        month: string;
      };

      if (!employeeId || employeeId.trim() === "") {
        return reply.code(400).send({ error: "Ungültige Parameter" });
      }
      const y = parseInt(year);
      const m = parseInt(month);
      if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
        return reply.code(400).send({ error: "Ungültige Parameter" });
      }

      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const { start, end } = monthRangeUtc(y, m, tz);

      const datevConfig = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: req.user.tenantId },
        select: {
          datevNormalstundenNr: true,
          datevUrlaubNr: true,
          datevKrankNr: true,
          datevSonderurlaubNr: true,
        },
      });
      const lna = {
        normal: datevConfig?.datevNormalstundenNr ?? 100,
        urlaub: datevConfig?.datevUrlaubNr ?? 300,
        krank: datevConfig?.datevKrankNr ?? 200,
        sonderurlaub: datevConfig?.datevSonderurlaubNr ?? 302,
      };

      const emp = await app.prisma.employee.findFirst({
        where: {
          id: employeeId,
          tenantId: req.user.tenantId, // tenant isolation — mandatory
          exitDate: null,
          user: { isActive: true },
        },
        include: {
          timeEntries: {
            where: {
              deletedAt: null,
              date: { gte: start, lte: end },
              endTime: { not: null },
              isInvalid: false,
            },
          },
          absences: {
            where: { deletedAt: null, startDate: { lte: end }, endDate: { gte: start } },
          },
          leaveRequests: {
            where: {
              deletedAt: null,
              status: "APPROVED",
              startDate: { lte: end },
              endDate: { gte: start },
            },
            include: { leaveType: true },
          },
        },
      });

      if (!emp) {
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }

      const section9ByEmpDatevSingle = await fetchConfirmedSection9CreditsByEmp(
        app,
        req.user.tenantId,
        start,
        end,
      );

      const buf = buildDatevLodas({
        employees: [emp],
        year: y,
        month: m,
        start,
        end,
        lna,
        section9ByEmp: section9ByEmpDatevSingle,
      });

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: { type: "DATEV_EMPLOYEE", year, month, employeeId },
      });

      reply.header("Content-Type", "application/octet-stream");
      reply.header(
        "Content-Disposition",
        `attachment; filename="datev-${y}-${String(m).padStart(2, "0")}-${emp.employeeNumber}.txt"`,
      );
      return reply.send(buf);
    },
  });

  // GET /api/v1/reports/monthly/pdf?employeeId=&year=&month=
  app.get("/monthly/pdf", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { employeeId, year, month } = req.query as {
        employeeId: string;
        year: string;
        month: string;
      };

      // Authorization: ADMIN/MANAGER may download any employee's PDF;
      // EMPLOYEE may only download their OWN PDF (self-employee check).
      const isManager = ["ADMIN", "MANAGER"].includes(req.user.role);
      if (!isManager && req.user.employeeId !== employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      const y = parseInt(year);
      const m = parseInt(month);
      if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
        return reply.code(400).send({ error: "Ungültige Jahr- oder Monatsangabe" });
      }
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const { start, end } = monthRangeUtc(y, m, tz);

      const [tenant, pdfTenantCfg] = await Promise.all([
        app.prisma.tenant.findUnique({
          where: { id: req.user.tenantId },
          select: { name: true, federalState: true },
        }),
        app.prisma.tenantConfig.findUnique({
          where: { tenantId: req.user.tenantId },
          select: { monthlyHoursHolidayDeduction: true },
        }),
      ]);

      const pdfHolidayDeductionOpts = {
        enabled: pdfTenantCfg?.monthlyHoursHolidayDeduction === true,
        stateCode: tenant?.federalState ? (STATE_MAP[tenant.federalState] ?? null) : null,
      };

      const emp = (await app.prisma.employee.findFirst({
        where: {
          id: employeeId,
          tenantId: req.user.tenantId,
        },
        include: buildEmployeeInclude(start, end),
      })) as unknown as EmployeeWithIncludes | null;

      if (!emp) {
        reply.code(404);
        return { error: "Mitarbeiter nicht gefunden" };
      }

      // Phase 104 (D-30): the PDF (Arbeitszeitnachweis handed to the employee/auditor)
      // must show the identical § 9 attribution as the JSON Monatsbericht.
      const section9ByEmpPdf = await fetchConfirmedSection9CreditsByEmp(
        app,
        req.user.tenantId,
        start,
        end,
      );
      const summary = computeEmployeeSummary(
        emp,
        start,
        end,
        tz,
        pdfHolidayDeductionOpts,
        section9ByEmpPdf.get(emp.id) ?? [],
      );
      // §615-correct Überstunden for the legal Stundennachweis (SHIFT_BASED / closed-month snapshot);
      // non-SHIFT open months keep summary.overtimeHours. Shape unchanged — only the number's source.
      // overtimeConfirmed is null (not a boolean) when labelled is false, so the PDF renderer can
      // omit the Bestätigt/Prognose label entirely instead of mislabelling it (SALDO-DISP-05).
      const {
        hours: reportOvertimeHours,
        confirmed: reportOvertimeConfirmed,
        labelled: reportOvertimeLabelled,
      } = await resolveReportOvertimeHours(app, emp, y, m, start, summary.overtimeHours);

      const pdfBuffer = await generateMonthlyReportPdf({
        tenantName: tenant?.name ?? "",
        employeeName: `${emp.firstName} ${emp.lastName}`,
        employeeNumber: emp.employeeNumber,
        month: `${MONTH_NAMES[m - 1]} ${y}`,
        workedHours: summary.workedHours,
        targetHours: summary.targetHours,
        overtimeHours: reportOvertimeHours,
        overtimeConfirmed: reportOvertimeLabelled ? reportOvertimeConfirmed : null,
        sickDays: summary.sickDays,
        sickDaysWithAttest: summary.sickDaysWithAttest,
        vacationDays: summary.vacationDays,
        otherAbsenceDays: summary.totalAbsenceDays - summary.vacationDays,
        // D-30: drives the § 9 legend in the PDF. Same source as the JSON report's section9Note.
        section9Days: summary.section9DaysThisMonth,
        entries: summary.entries,
      });

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: { type: "MONTHLY_PDF", year, month, employeeId },
      });

      reply.header("Content-Type", "application/pdf");
      reply.header(
        "Content-Disposition",
        `attachment; filename="monatsbericht-${y}-${String(m).padStart(2, "0")}-${emp.employeeNumber}.pdf"`,
      );
      return reply.send(pdfBuffer);
    },
  });

  // GET /api/v1/reports/monthly/pdf/all?year=&month=&role=  — PDF-01/PDF-03/PDF-05
  app.get("/monthly/pdf/all", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { year, month, role } = req.query as {
        year: string;
        month: string;
        role?: string;
      };
      const y = parseInt(year);
      const m = parseInt(month);
      if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
        return reply.code(400).send({ error: "Ungültige Jahr- oder Monatsangabe" });
      }

      // ALLOWLIST validation — never pass untrusted string to Prisma enum
      const roleFilter: "EMPLOYEE" | "MANAGER" | undefined =
        role === "MANAGER" ? "MANAGER" : role === "EMPLOYEE" ? "EMPLOYEE" : undefined;

      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const { start, end } = monthRangeUtc(y, m, tz);

      const [tenant, allPdfTenantCfg] = await Promise.all([
        app.prisma.tenant.findUnique({
          where: { id: req.user.tenantId },
          select: { name: true, federalState: true },
        }),
        app.prisma.tenantConfig.findUnique({
          where: { tenantId: req.user.tenantId },
          select: { monthlyHoursHolidayDeduction: true },
        }),
      ]);

      const allPdfHolidayDeductionOpts = {
        enabled: allPdfTenantCfg?.monthlyHoursHolidayDeduction === true,
        stateCode: tenant?.federalState ? (STATE_MAP[tenant.federalState] ?? null) : null,
      };

      const employees = (await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          exitDate: null,
          user: { isActive: true, ...(roleFilter ? { role: roleFilter } : {}) },
        },
        include: buildEmployeeInclude(start, end),
        orderBy: { lastName: "asc" },
      })) as unknown as EmployeeWithIncludes[];

      if (employees.length === 0) {
        reply.code(404);
        return { error: "Keine Mitarbeiter gefunden" };
      }

      // Phase 104 (D-30): one bulk fetch for the whole company PDF, not per employee.
      const section9ByEmpAll = await fetchConfirmedSection9CreditsByEmp(
        app,
        req.user.tenantId,
        start,
        end,
      );

      const rows = await Promise.all(
        employees.map(async (emp) => {
          const summary = computeEmployeeSummary(
            emp,
            start,
            end,
            tz,
            allPdfHolidayDeductionOpts,
            section9ByEmpAll.get(emp.id) ?? [],
          );
          // §615-correct Überstunden (SHIFT_BASED / closed-month snapshot); non-SHIFT open months
          // keep summary.overtimeHours. Override AFTER the spread so the shape stays identical.
          // overtimeConfirmed is null when labelled is false (PDF omits the label for this row).
          const {
            hours: overtimeHours,
            confirmed: overtimeConfirmedResolved,
            labelled: overtimeLabelled,
          } = await resolveReportOvertimeHours(app, emp, y, m, start, summary.overtimeHours);
          return {
            employeeName: `${emp.firstName} ${emp.lastName}`,
            employeeNumber: emp.employeeNumber,
            role: emp.user.role,
            ...summary,
            overtimeHours,
            overtimeConfirmed: overtimeLabelled ? overtimeConfirmedResolved : null,
          };
        }),
      );

      const doc = new PDFDocument({ size: "A4", margin: 50 });
      reply.header("Content-Type", "application/pdf");
      reply.header(
        "Content-Disposition",
        `attachment; filename="monatsbericht-alle-${y}-${String(m).padStart(2, "0")}.pdf"`,
      );

      streamCompanyMonthlyReportPdf(doc, {
        tenantName: tenant?.name ?? "",
        month: `${MONTH_NAMES[m - 1]} ${y}`,
        year: y,
        monthNumber: m,
        roleFilter: roleFilter ?? "all",
        rows,
      });
      doc.end(); // CRITICAL: end() BEFORE reply.send() per RESEARCH.md Pitfall 1

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: { type: "COMPANY_MONTHLY_PDF", year, month, role: roleFilter ?? "all" },
      });

      return reply.send(doc);
    },
  });

  // GET /api/v1/reports/leave-list/pdf?year=  — PDF-02/PDF-05
  app.get("/leave-list/pdf", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { year } = req.query as { year: string };
      const y = parseInt(year ?? new Date().getFullYear().toString());
      const yearStart = new Date(`${y}-01-01T00:00:00.000Z`);
      const yearEnd = new Date(`${y}-12-31T23:59:59.999Z`);
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);

      const tenant = await app.prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { name: true },
      });

      const employees = await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          exitDate: null,
          user: { isActive: true },
        },
        include: {
          leaveRequests: {
            where: {
              deletedAt: null,
              status: "APPROVED",
              startDate: { lte: yearEnd },
              endDate: { gte: yearStart },
            },
            include: { leaveType: true },
            orderBy: { startDate: "asc" },
          },
        },
        orderBy: { lastName: "asc" },
      });

      // Build leave list data (include all employees, even those with no leave — show empty periods)
      const leaveListData = {
        tenantName: tenant?.name ?? "",
        year: y,
        employees: employees.map((emp) => {
          const periods = emp.leaveRequests.map((lr) => {
            // Clamp to year boundaries
            const s = lr.startDate < yearStart ? yearStart : lr.startDate;
            const e2 = lr.endDate > yearEnd ? yearEnd : lr.endDate;
            const days = Math.max(0, Math.round((e2.getTime() - s.getTime()) / 86400000) + 1);
            return {
              startDate: formatInTimeZone(lr.startDate, tz, "dd.MM.yyyy"),
              endDate: formatInTimeZone(lr.endDate, tz, "dd.MM.yyyy"),
              leaveTypeName: lr.leaveType.name,
              days,
            };
          });
          return {
            employeeName: `${emp.firstName} ${emp.lastName}`,
            employeeNumber: emp.employeeNumber,
            periods,
            totalDays: periods.reduce((sum, p) => sum + p.days, 0),
          };
        }),
      };

      const doc = new PDFDocument({ size: "A4", margin: 50 });
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", `attachment; filename="urlaubsliste-${y}.pdf"`);

      streamLeaveListPdf(doc, leaveListData);
      doc.end(); // CRITICAL: before reply.send

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: { type: "LEAVE_LIST_PDF", year },
      });

      return reply.send(doc);
    },
  });

  // GET /api/v1/reports/vacation/pdf?year=  — combined: leave list + overview
  app.get("/vacation/pdf", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { year } = req.query as { year: string };
      const y = parseInt(year ?? new Date().getFullYear().toString());
      const yearStart = new Date(`${y}-01-01T00:00:00.000Z`);
      const yearEnd = new Date(`${y}-12-31T23:59:59.999Z`);
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);

      const tenant = await app.prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { name: true },
      });

      // Fetch both datasets in parallel
      const [employees, entitlements] = await Promise.all([
        app.prisma.employee.findMany({
          where: {
            tenantId: req.user.tenantId,
            exitDate: null,
            user: { isActive: true },
          },
          include: {
            leaveRequests: {
              where: {
                deletedAt: null,
                status: "APPROVED",
                startDate: { lte: yearEnd },
                endDate: { gte: yearStart },
              },
              include: { leaveType: true },
              orderBy: { startDate: "asc" },
            },
          },
          orderBy: { lastName: "asc" },
        }),
        app.prisma.leaveEntitlement.findMany({
          where: {
            year: y,
            employee: { tenantId: req.user.tenantId },
          },
          include: {
            employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
            leaveType: true,
          },
        }),
      ]);

      // Build leave list data
      const leaveListData = {
        tenantName: tenant?.name ?? "",
        year: y,
        employees: employees.map((emp) => {
          const periods = emp.leaveRequests.map((lr) => {
            const s = lr.startDate < yearStart ? yearStart : lr.startDate;
            const e2 = lr.endDate > yearEnd ? yearEnd : lr.endDate;
            const days = Math.max(0, Math.round((e2.getTime() - s.getTime()) / 86400000) + 1);
            return {
              startDate: formatInTimeZone(lr.startDate, tz, "dd.MM.yyyy"),
              endDate: formatInTimeZone(lr.endDate, tz, "dd.MM.yyyy"),
              leaveTypeName: lr.leaveType.name,
              days,
            };
          });
          return {
            employeeName: `${emp.firstName} ${emp.lastName}`,
            employeeNumber: emp.employeeNumber,
            periods,
            totalDays: periods.reduce((sum, p) => sum + p.days, 0),
          };
        }),
      };

      // Build overview data
      const empMap = new Map<
        string,
        {
          name: string;
          employeeNumber: string;
          totalDays: number;
          usedDays: number;
          remainingDays: number;
          carriedOver: number;
        }
      >();
      for (const e of entitlements) {
        if (!e.leaveType.name.toLowerCase().includes("urlaub")) continue;
        const key = e.employee.employeeNumber;
        const existing = empMap.get(key);
        const total = Number(e.totalDays);
        const carried = Number(e.carriedOverDays);
        const used = Number(e.usedDays);
        const remaining = total + carried - used;
        if (existing) {
          existing.totalDays += total;
          existing.carriedOver += carried;
          existing.usedDays += used;
          existing.remainingDays += remaining;
        } else {
          empMap.set(key, {
            name: `${e.employee.firstName} ${e.employee.lastName}`,
            employeeNumber: e.employee.employeeNumber,
            totalDays: total,
            carriedOver: carried,
            usedDays: used,
            remainingDays: remaining,
          });
        }
      }
      const overviewData = {
        tenantName: tenant?.name ?? "",
        year: y,
        employees: [...empMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
      };

      const doc = new PDFDocument({ size: "A4", margin: 50 });
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", `attachment; filename="urlaubsbericht-${y}.pdf"`);

      streamLeaveListPdf(doc, leaveListData);
      streamVacationOverviewPdf(doc, overviewData);
      doc.end();

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: { type: "VACATION_PDF", year },
      });

      return reply.send(doc);
    },
  });

  // GET /api/v1/reports/leave-overview/pdf?year=
  app.get("/leave-overview/pdf", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { year } = req.query as { year: string };
      const y = parseInt(year ?? new Date().getFullYear().toString());

      const tenant = await app.prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { name: true },
      });

      const entitlements = await app.prisma.leaveEntitlement.findMany({
        where: {
          year: y,
          employee: { tenantId: req.user.tenantId },
        },
        include: {
          employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
          leaveType: true,
        },
      });

      // Group by employee and aggregate (only "Urlaub" type)
      const empMap = new Map<
        string,
        {
          name: string;
          employeeNumber: string;
          totalDays: number;
          usedDays: number;
          remainingDays: number;
          carriedOver: number;
        }
      >();

      for (const e of entitlements) {
        if (!e.leaveType.name.toLowerCase().includes("urlaub")) continue;
        const key = e.employee.employeeNumber;
        const existing = empMap.get(key);
        const total = Number(e.totalDays);
        const carried = Number(e.carriedOverDays);
        const used = Number(e.usedDays);
        const remaining = total + carried - used;

        if (existing) {
          existing.totalDays += total;
          existing.carriedOver += carried;
          existing.usedDays += used;
          existing.remainingDays += remaining;
        } else {
          empMap.set(key, {
            name: `${e.employee.firstName} ${e.employee.lastName}`,
            employeeNumber: e.employee.employeeNumber,
            totalDays: total,
            carriedOver: carried,
            usedDays: used,
            remainingDays: remaining,
          });
        }
      }

      const pdfBuffer = await generateVacationOverviewPdf({
        tenantName: tenant?.name ?? "",
        year: y,
        employees: [...empMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
      });

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: { type: "LEAVE_OVERVIEW_PDF", year },
      });

      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", `attachment; filename="urlaubsuebersicht-${y}.pdf"`);
      return reply.send(pdfBuffer);
    },
  });
}
