import { FastifyInstance } from "fastify";
import PDFDocument from "pdfkit";
import iconv from "iconv-lite";
import { formatInTimeZone } from "date-fns-tz";
import { requireAuth } from "../middleware/auth";
import {
  requirePermission,
  permissionReach,
  parseCompatRoleFilter,
  compatRoleUserWhere,
  type CompatRoleFilter,
  accessContextFromRequest, // Phase 91b Plan 07 (#91), D-10/D-14
  resolveAccessReach, // Phase 91b Plan 07 (#91), D-10/D-14
  resolveStammsalonScopedEmployeeIds, // Phase 91b Plan 07 (#91), D-10
  isStammsalonScopeMatch, // Phase 91b Plan 07 (#91), D-10/D-14
  employeeScopeFor, // Issue #448 (D-05, plan 03) — T-448-12 scoped BS-date reads
} from "../contexts/platform";
import {
  SECTION9_LEGEND,
  generateMonthlyReportPdf,
  generateVacationOverviewPdf,
  streamCompanyMonthlyReportPdf,
  streamLeaveListPdf,
  streamVacationOverviewPdf,
} from "./pdf";
import {
  getTenantTimezone,
  monthRangeUtc,
  computeMonthReportFigures, // Issue #451 (D-03)
} from "../contexts/working-time-account"; // Phase 101B
import {
  listEntitlementsForYear,
  getExpiringCarryOver,
  getEntitlementById,
  getConfirmedSection9Credits,
  getPendingLeaveDaysInYear, // Phase 100B Plan 13 — A7c
  selfHealUsedDays,
  loadVacationTypeMeta,
  isSickLeaveTypeCode,
  ensureRegularVacationEntitlement, // Issue #445 (D-05) — injected into selfHealUsedDays's ctx below
  REGULAR_ENTITLEMENT_REASON_SELF_HEAL, // Issue #445 (D-05)
  vacationEntitlementWarning, // Issue #445 — composition carries no business rule (CLAUDE.md); the warning string is built in the absence context
  healEntitlementUsedDays, // Issue #445 (D-10) — injected into selfHealUsedDays's ctx below
  EFFECTIVE_LEAVE_STATUSES, // Issue #446 (D-01/D-04)
  vocationalSchoolDatesForLeaveRequests, // Issue #448 (D-05, plan 03)
  BS_NO_LEAVE_LABEL, // Issue #448 (D-05, plan 03)
  leaveDaysByCodeWithin, // Issue #451 (D-01) — the DATEV export's VACATION Lohnart line
  type LeaveDaysForCode, // Issue #451 (D-01)
  leaveRequestDaysWithin, // Issue #451 (D-02) — the Urlaubsliste / Urlaubs-PDF list's per-period priced days
} from "../contexts/absence"; // Phase 100B Plan 10 — A12/A14/A15; Plan 11 — A22
import type { LeaveTypeCode } from "@clokr/db";

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
  leaveType: { name: string; code: LeaveTypeCode | null };
};

// ── Phase 104 (D-15, Tier 2) — day-based dedup; Issue #451 narrowed its scope twice ────────────
// Leave-DAY counts (vacationDays, totalAbsenceDays, and every other per-type count) come from the
// absence context's own priced, §9-netted leaveDaysByCodeWithin map (computeEmployeeSummary's
// required leaveDaysByCode parameter, Issue #451 D-02) — no local day-counting rule for THOSE
// lives in this file any more. Soll/Ist/Überstunden (Issue #451 D-03) likewise come from the
// working-time-account's own month result (`computeMonthReportFigures`) — this file computes no
// Soll of its own either. `sortLeaveForDedup` below now exists ONLY for the DATEV Krank-line's
// own per-type day dedup (`sickDaysForCode`, further down this file) — a calendar day covered by
// two overlapping APPROVED same-type requests must be counted exactly once.
//
// Order identical to close-employee-month.ts's sortForDedup(): full day before half day, then
// startDate, then id — so both implementations agree on the same value for a half vacation day
// under a full sick day.
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
  // Issue #433 (D-11): read by monthlyHoursMonthSollMinutes()'s absences mapper for a
  // MONTHLY_HOURS employee — present on every row because buildEmployeeInclude's `absences`
  // include has no `select` (full Absence row), unlike this type's pre-433 narrower shape.
  source: string;
  halfDay: boolean;
  unterrichtsMinutes: number | null;
};

type TimeEntryRecord = {
  date: Date;
  startTime: Date;
  endTime: Date | null;
  breakMinutes: number | bigint | null;
  // Phase 71b (issue #71): carried so the caller can hand these rows to the Unterbau's central
  // holiday resolver (`holidaysAtWorkLocation`) as the per-day work location.
  employeeId: string;
  salonId: string;
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
// Pure helper — single source of truth for the monthly report's sick/leave/§9 fields.
// Called by GET /monthly (JSON), GET /monthly/pdf (single-emp), GET /monthly/pdf/all (company).
//
// Issue #451 (D-03): this function computes NO Soll/Ist/Überstunden any more — all three GET
// handlers below call `computeMonthReportFigures` (the working-time-account's own month result)
// directly for those. The day-iterating helper left here (`daysInRange`) exists ONLY for the
// sick-day / § 9 day counts, which are calendar-day spans, not Soll minutes.
function computeEmployeeSummary(
  emp: EmployeeWithIncludes,
  start: Date,
  end: Date,
  tz: string,
  // Issue #451 (D-02): facade-fetched input — the absence context's own priced, §9-netted
  // leave-day map for this employee's report window (leaveDaysByCodeWithin, prefetched ONCE per
  // request by the caller). No business rule lives here; this function only reads it.
  leaveDaysByCode: Map<LeaveTypeCode, LeaveDaysForCode>,
  // Phase 104 (D-30): confirmed § 9 credits overlapping the report month, bulk-fetched
  // ONCE by the caller (no per-employee query — T-104-09-N1) and pre-filtered to
  // pre-filtered to CONFIRMED-only (T-104-09-PENDING: an AU_PENDING credit changes nothing).
  section9Credits: Array<{ creditedStart: Date; creditedEnd: Date }> = [],
): {
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
  // ── Days in range clamped to [start, end] ────────────────────────────────
  function daysInRange(from: Date, to: Date): number {
    const s = from < start ? start : from;
    const e2 = to > end ? end : to;
    return Math.max(0, Math.round((e2.getTime() - s.getTime()) / 86400000) + 1);
  }

  // ── Sick days ────────────────────────────────────────────────────────────
  // Single source of truth: sick days are counted exclusively from LeaveRequest
  // records whose LeaveType.code is one of the two sickness codes (with attest metadata).
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

  const sickLeaveRequests = emp.leaveRequests.filter((lr) =>
    isSickLeaveTypeCode(lr.leaveType.code),
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

  // ── Absence breakdown (Issue #451, D-02) ─────────────────────────────────
  // Every per-type leave count, and totalAbsenceDays, comes from the absence context's own
  // priced, §9-netted leave-day map (leaveDaysByCode, prefetched by the caller via
  // leaveDaysByCodeWithin) — no local day-counting rule lives in this file any more. A code
  // absent from the map (no counted request that month) reads as 0.
  const vacationDays = leaveDaysByCode.get("VACATION")?.netDays ?? 0;
  const overtimeCompDays = leaveDaysByCode.get("OVERTIME_COMP")?.netDays ?? 0;
  const specialLeaveDays = leaveDaysByCode.get("SPECIAL")?.netDays ?? 0;
  const educationDays = leaveDaysByCode.get("EDUCATION")?.netDays ?? 0;
  const unpaidDays = leaveDaysByCode.get("UNPAID")?.netDays ?? 0;
  const maternityDays = leaveDaysByCode.get("MATERNITY")?.netDays ?? 0;
  const parentalDays = leaveDaysByCode.get("PARENTAL")?.netDays ?? 0;
  let totalAbsenceDays = 0;
  for (const [code, days] of leaveDaysByCode) {
    if (!isSickLeaveTypeCode(code)) totalAbsenceDays += days.netDays;
  }
  totalAbsenceDays = Math.round(totalAbsenceDays * 100) / 100;

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
  // Issue #451 (D-02): vacationDays/totalAbsenceDays are already §9-netted by leaveDaysByCode
  // (the absence context's own netDays) — no second subtraction here.

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

  return {
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

// ── DATEV payroll period person set ───────────────────────────────────────────
/**
 * Issue #256 (Befund 2): who belongs in a payroll export for [start, end]?
 *
 * The answer is "whoever was employed at some point DURING that period" — never
 * "whoever is employed today". The previous predicate (`exitDate: null` plus
 * `user.isActive`) answered the second question, so a correction run for July, made
 * after a September exit, silently dropped that person and every one of their hours
 * from the file. Nothing in the file said so.
 *
 * Both date bounds are INCLUSIVE:
 *   - `hireDate` is the first working day, so `hireDate <= end` means at least one day
 *     of the period falls inside the employment.
 *   - `exitDate` is the last working day (close-employee-month.ts, D-03), so
 *     `exitDate >= start` means the employment still reached into the period.
 *     `exitDate: null` = still employed, which always overlaps.
 *
 * `user.isActive` is deliberately NOT part of this predicate. It is a LOGIN state —
 * flipped by deactivation, by lockout and by DSGVO anonymisation — and says nothing
 * about whether a person was employed in the payroll period. The measured case was an
 * employee on Elternzeit whose login had been switched off: 31 days of Elternzeit that
 * the Lohnbüro must see, withheld because they could not sign in.
 */
export function datevPayrollPeriodEmployeeFilter(start: Date, end: Date) {
  return {
    hireDate: { lte: end },
    OR: [{ exitDate: null }, { exitDate: { gte: start } }],
  };
}

// ── DATEV Berater-/Mandantennummer ───────────────────────────────────────────
/**
 * Issue #256 (Befund 3): the [Allgemein] header's BeraterNr/MandantenNr identify the
 * tax office and the client the file belongs to. Both were literal `0`, and the schema
 * had no field to put anything else in — so every export named client 0 of advisor 0.
 *
 * They are configured per tenant (TenantConfig.datevBeraterNr / .datevMandantenNr) and
 * are nullable, because neither has a defensible default. This resolver returns null when
 * either is missing; the callers turn that into an HTTP 409 with DATEV_KANZLEI_MISSING_ERROR
 * rather than shipping the old placeholder, which looked like a value and was not one.
 */
export const DATEV_KANZLEI_MISSING_ERROR =
  "Berater- und Mandantennummer sind nicht hinterlegt. Bitte unter Administration → Export → Konfiguration eintragen — ohne sie kann DATEV die Datei keinem Mandanten zuordnen.";

export function resolveDatevKanzlei(
  config: { datevBeraterNr: number | null; datevMandantenNr: number | null } | null,
): { beraterNr: number; mandantenNr: number } | null {
  if (config?.datevBeraterNr == null || config?.datevMandantenNr == null) return null;
  return { beraterNr: config.datevBeraterNr, mandantenNr: config.datevMandantenNr };
}

// ── buildDatevLodas ───────────────────────────────────────────────────────────
// Issue #256 (Befund 1): the LODAS record id of the Bewegungsdaten record type. It is
// declared once in [Satzbeschreibung] and repeated as the FIRST field of every data row
// that belongs to that record type — a LODAS data row starts with the id of its record,
// not with its first payload value. Exported here for the regression test that pins the
// declaration and the data rows to the same value.
export const DATEV_BWD_SATZ_ID = 20;

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
  leaveRequests: Array<{
    id: string;
    startDate: Date;
    endDate: Date;
    halfDay: boolean;
    leaveType: { name: string; code: LeaveTypeCode | null };
  }>;
};

function buildDatevLodas(params: {
  employees: DatevEmployee[];
  year: number;
  month: number;
  start: Date;
  end: Date;
  lna: { normal: number; urlaub: number; krank: number; sonderurlaub: number };
  // Issue #256 (Befund 3): the BeraterNr/MandantenNr pair of the [Allgemein] header.
  // Required, not optional: a `0` here is what made the file unassignable to a Mandant,
  // so the caller has to have resolved a real pair before it gets this far.
  kanzlei: { beraterNr: number; mandantenNr: number };
  // Phase 104 (D-30): bestätigte § 9-Gutschriften je Mitarbeiter, bereits bulk-fetched
  // und CONFIRMED-only gefiltert vom Aufrufer (T-104-09-N1/PENDING).
  section9ByEmp?: Map<string, Array<{ creditedStart: Date; creditedEnd: Date }>>;
  // Issue #451 (D-01): per-employee, per-LeaveTypeCode priced leave days, bulk-fetched by the
  // caller via leaveDaysByCodeWithin (fetchLeaveDaysByEmployeeForDatev) — the absence context's
  // OWN counted days, § 9-netted. Required, not optional: both call sites always provide it, and
  // every non-sick Lohnart line below has no other source of its value any more. Replaces the
  // old `bsDatesByRequestId` parameter (Issue #448, D-05) entirely — Berufsschultage are already
  // excluded from the priced days this map carries, so the DATEV builder no longer needs its own
  // batch read of Berufsschultage at all (the module-private async helper that used to supply it
  // is gone).
  leaveDaysByEmployee: Map<string, Map<LeaveTypeCode, LeaveDaysForCode>>;
}): Buffer {
  const {
    employees,
    year: y,
    month: m,
    start,
    end,
    lna,
    kanzlei,
    section9ByEmp,
    leaveDaysByEmployee,
  } = params;
  const CRLF = "\r\n";
  const lines: string[] = [];

  /** Dezimal mit Komma formatieren */
  function dec(n: number, digits = 2): string {
    return n.toFixed(digits).replace(".", ",");
  }

  // Issue #210: same UTC walk and clipping workDaysInMonthRange() always did, now also
  // exposed as day keys — internal identity only, never rendered — so the sickness /
  // § 9 / non-sick set operations below all derive from the ONE day rule this export
  // has always used. workDaysInMonthRange() is unchanged in behaviour, only in
  // implementation (its length).
  function workdayKeysInMonthRange(from: Date, to: Date): string[] {
    const s = from < start ? start : from;
    const e2 = to > end ? end : to;
    const keys: string[] = [];
    const cur = new Date(s);
    while (cur <= e2) {
      const dow = cur.getUTCDay();
      if (dow !== 0 && dow !== 6) keys.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return keys;
  }

  // Issue #451 (D-01): the ONE accessor for a priced, § 9-netted leave-day count — no counting
  // happens here, it reads what leaveDaysByEmployee (fetchLeaveDaysByEmployeeForDatev,
  // leaveDaysByCodeWithin) already computed. A code absent from the employee's map (no counted
  // request that month) reads as 0.
  function priceDaysFor(emp: DatevEmployee, code: LeaveTypeCode): number {
    return leaveDaysByEmployee.get(emp.id)?.get(code)?.netDays ?? 0;
  }

  /**
   * DATEV-Zeile: Satz-ID + 12 Werte, leere Felder = Semikolon.
   *
   * Issue #256 (Befund 1): the leading Satz-ID is what binds a data row to its record
   * declaration in [Satzbeschreibung]. Without it the row still carried the right NUMBER
   * of values (12 names / 12 values), so nothing ever complained -- the values were simply
   * anchored one field too far left, which only becomes visible when the file is opened as
   * a table next to its own header. Declaration and data rows are now emitted from the ONE
   * DATEV_BWD_SATZ_ID constant, so the two cannot drift apart again.
   */
  function datevLine(
    pn: string,
    name: string,
    datum: string,
    ausfall: string,
    lohnart: number,
    stunden: number,
    tage: number,
  ): string {
    return `${DATEV_BWD_SATZ_ID};${pn};${name};${datum};${ausfall};${lohnart};${stunden > 0 ? dec(stunden) : ""};${tage > 0 ? dec(tage, 1) : ""};;;;;`;
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

    // ── Krankheit aus LeaveRequest (Issue #210) ────────────────────────────
    // Sickness lives in LeaveRequest; Absence.SICK/SICK_CHILD has no production writer
    // (measured zero rows on the pseudonymised production copy, 2026-08-30) and no
    // longer contributes here. A § 9-credited day is UNIONED into the sick day set
    // rather than added on top of it: Section9Credit.sickRequestId is a non-null FK to
    // the sickness LeaveRequest that produced the credit, so once the base is sourced
    // from that same LeaveRequest, the credited day is already inside it — adding
    // section9WorkDays again would double-count it, the exact T-104-09-PAYROLL class
    // of defect this time on the Krank side of the ledger. An un-credited sick day that
    // overlaps a non-sick Lohnart day (e.g. planned vacation) stays on the non-sick
    // line: § 9 BUrlG returns the vacation day only on presentation of an ärztliches
    // Zeugnis, so without a CONFIRMED credit the day is legally still Urlaub and must
    // not be reported twice (would inflate total Ausfalltage beyond the workdays in
    // the period).
    const nonSickClaimed = new Set<string>();
    for (const lr of emp.leaveRequests) {
      if (lr.leaveType.code === null || isSickLeaveTypeCode(lr.leaveType.code)) continue;
      for (const key of workdayKeysInMonthRange(lr.startDate, lr.endDate)) {
        nonSickClaimed.add(key);
      }
    }
    const section9Keys = new Set<string>();
    for (const c of section9ByEmp?.get(emp.id) ?? []) {
      for (const key of workdayKeysInMonthRange(c.creditedStart, c.creditedEnd)) {
        section9Keys.add(key);
      }
    }
    // A day already booked on a non-sick line blocks a sick claim — UNLESS § 9 already
    // took it off that line, in which case the credit is the authority that moved it.
    const blockedForSick = new Set([...nonSickClaimed].filter((key) => !section9Keys.has(key)));

    // One Set shared by both sickness lines, so a day claimed by both a SICK and a
    // contradictory SICK_CHILD row lands on exactly one line (SICK is evaluated first).
    const sickClaimed = new Set<string>();
    function sickDaysForCode(code: LeaveTypeCode): number {
      let total = 0;
      for (const lr of sortLeaveForDedup(
        emp.leaveRequests.filter((r) => r.leaveType.code === code),
      )) {
        let n = 0;
        for (const key of workdayKeysInMonthRange(lr.startDate, lr.endDate)) {
          if (blockedForSick.has(key) || sickClaimed.has(key)) continue;
          sickClaimed.add(key);
          n++;
        }
        total += lr.halfDay ? n / 2 : n;
      }
      return total;
    }
    const sickDaysBase = sickDaysForCode("SICK");
    const sickChildDays = sickDaysForCode("SICK_CHILD");
    // A CONFIRMED § 9 day whose sickness request could not be read as a typed sickness
    // row (soft-deleted, moved off APPROVED, or a pre-Phase-97 row whose code is still
    // null) has nevertheless already been subtracted from the Urlaub line — add it back
    // here so a day that left Urlaub can never vanish from the file. Deliberately
    // attributed to Krank (200), not Kinderkrank (201): the sub-type is unresolvable
    // once the sickness request itself is unreadable, and § 9 BUrlG concerns the
    // employee's own illness, which makes Krank the correct default.
    const section9OrphanDays = [...section9Keys].filter((key) => !sickClaimed.has(key)).length;

    // Abwesenheiten aus LeaveRequest (nur Arbeitstage)
    //
    // Issue #451 (D-01): the Urlaub line now reads leaveDaysByEmployee's own § 9-netted
    // `netDays` — the absence context's priced VACATION count for this month, already clipped,
    // workDay-aware (incl. SHIFT_BASED contract days and Tue-Sat-style contracts), holiday-aware
    // and Berufsschultag-excluded (#448), and already net of the SAME confirmed § 9 credit the
    // old `section9WorkDays` subtraction below used to compute by hand. No local counting left.
    const vacationDaysDatev = priceDaysFor(emp, "VACATION");
    const overtimeCompDays = priceDaysFor(emp, "OVERTIME_COMP");
    const specialDays = priceDaysFor(emp, "SPECIAL");
    const educationDays = priceDaysFor(emp, "EDUCATION");
    const unpaidDays = priceDaysFor(emp, "UNPAID");
    const maternityDays = priceDaysFor(emp, "MATERNITY");
    const parentalDays = priceDaysFor(emp, "PARENTAL");

    // Issue #210: the Krank side is no longer `+ section9WorkDays` — that was only
    // correct while the base was the always-empty Absence source. sickDaysBase already
    // includes every § 9-credited day whose sickness request is readable (the union
    // above), so only the unreadable ("orphan") § 9 days are added on top.
    const sickDaysDatev = sickDaysBase + section9OrphanDays;

    // DATEV-Zeilen (Format: Satz-ID + 12 Werte, Semikolon-getrennt) — datevLine()'s own body is
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
  //   [Allgemein]        – Ziel=LODAS, Version_SST=1.0, BeraterNr/MandantenNr (TenantConfig,
  //                          Issue #256), Datumsangaben=DDMMJJJJ
  //   [Satzbeschreibung] – declares the Satz-ID and the 12 fields of a Bewegungsdaten row
  //   [Bewegungsdaten]   – actual employee rows
  //
  // Each data row: the Satz-ID (Issue #256) followed by 12 values, semicolon-separated,
  // decimal comma, CRLF line endings.
  // Ausfallschlüssel: U=Urlaub, K=Krank, S=Sonderurlaub, (leer)=Arbeit
  const iniHeader = [
    "[Allgemein]",
    "Ziel=LODAS",
    "Version_SST=1.0",
    `BeraterNr=${kanzlei.beraterNr}`,
    `MandantenNr=${kanzlei.mandantenNr}`,
    "Datumsangaben=DDMMJJJJ",
    `Abrechnungszeitraum=${String(m).padStart(2, "0")}${y}`,
    "",
    "[Satzbeschreibung]",
    `${DATEV_BWD_SATZ_ID};u_lod_bwd_buchung_kst;pnr#bwd;name#bwd;datum#bwd;ausfallkennzeichen#bwd;u_lod_lna_nr#bwd;stunden#bwd;tage#bwd;betrag#bwd;faktor#bwd;kuerzung#bwd;kostenstelle#bwd;kostentraeger#bwd`,
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
        status: { in: Array.from(EFFECTIVE_LEAVE_STATUSES) }, // Issue #446 (D-04) — Array.from (not a spread) yields a mutable array despite this function's own `as const`
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
  const credits = await getConfirmedSection9Credits(app.prisma, tenantId, start, end);
  const byEmp = new Map<string, Array<{ creditedStart: Date; creditedEnd: Date }>>();
  for (const c of credits) {
    if (c.creditedStart === null || c.creditedEnd === null) continue;
    const arr = byEmp.get(c.employeeId) ?? [];
    arr.push({ creditedStart: c.creditedStart, creditedEnd: c.creditedEnd });
    byEmp.set(c.employeeId, arr);
  }
  return byEmp;
}

// Issue #451 (D-01): one leaveDaysByCodeWithin call per employee with at least one non-sick
// leave request in the exported month — the absence context's OWN priced leave-day count, read
// through its index (never a composition-layer day walk). The payroll-month bounds passed to it
// are UTC-midnight CALENDAR days (new Date(Date.UTC(y, m-1, 1)) / new Date(Date.UTC(y, m, 0))),
// deliberately NOT monthRangeUtc()'s tenant-tz instants: leaveDaysByCodeWithin/
// countedLeaveDaysWithin normalise with utcDay(), so a tenant-tz instant (e.g. a `start` of
// 2026-11-30T23:00Z for a December period) would silently shift the window by one day — see that
// function's own docblock. An employee with only sick leave in the month is skipped entirely
// (the Krank/§9 lines read section9ByEmp and the UTC-weekday-key walk below, unchanged by this
// plan) — no facade call is wasted on a population this map is never read for.
async function fetchLeaveDaysByEmployeeForDatev(
  app: FastifyInstance,
  tenantId: string,
  employees: Array<{
    id: string;
    leaveRequests: Array<{ leaveType: { code: LeaveTypeCode | null } }>;
  }>,
  year: number,
  month: number,
): Promise<Map<string, Map<LeaveTypeCode, LeaveDaysForCode>>> {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0));
  const result = new Map<string, Map<LeaveTypeCode, LeaveDaysForCode>>();
  for (const emp of employees) {
    const hasNonSickLeave = emp.leaveRequests.some(
      (lr) => lr.leaveType.code !== null && !isSickLeaveTypeCode(lr.leaveType.code),
    );
    if (!hasNonSickLeave) continue;
    result.set(
      emp.id,
      await leaveDaysByCodeWithin(app.prisma, { employeeId: emp.id, tenantId, from, to }),
    );
  }
  return result;
}

// Issue #451 (D-02): one leaveDaysByCodeWithin call per employee with at least one leave request
// in the report month — feeds computeEmployeeSummary's required leaveDaysByCode parameter for
// the three Monatsbericht handlers (JSON, single PDF, company PDF). Same UTC-midnight
// calendar-month bounds as fetchLeaveDaysByEmployeeForDatev above (not monthRangeUtc's tenant-tz
// instants), for the identical reason: leaveDaysByCodeWithin/countedLeaveDaysWithin normalise
// with utcDay(), so a tenant-tz instant would silently shift the window by one day. Sequential
// awaits (no unbounded Promise.all) — mirrors the DATEV helper's own shape. Unlike that helper,
// the skip condition here is "no leave request at all" (not "no NON-SICK leave request"):
// computeEmployeeSummary also needs to tell a genuinely leave-free employee (empty map, every
// per-type count 0) from one whose only requests are sick leave — an employee with only SICK
// leave still gets a Map (populated with the SICK code, which computeEmployeeSummary simply
// never reads a non-sick count from).
async function fetchLeaveDaysByCodeForMonthlyReport(
  app: FastifyInstance,
  tenantId: string,
  employees: Array<{ id: string; leaveRequests: Array<unknown> }>,
  year: number,
  month: number,
): Promise<Map<string, Map<LeaveTypeCode, LeaveDaysForCode>>> {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0));
  const result = new Map<string, Map<LeaveTypeCode, LeaveDaysForCode>>();
  for (const emp of employees) {
    if (emp.leaveRequests.length === 0) continue;
    result.set(
      emp.id,
      await leaveDaysByCodeWithin(app.prisma, { employeeId: emp.id, tenantId, from, to }),
    );
  }
  return result;
}

// Issue #448 (D-05, plan 03)'s DATEV-only BS batch reader (the module-private async helper that
// used to live here) was removed by Issue #451 (D-01, Task 2): Berufsschultage are already
// excluded from the priced
// `days` leaveDaysByEmployee carries (the same #448 exclusion, now reached once, inside the
// absence context, instead of being re-derived a second time here). The Urlaubsliste PDF's own
// BS-note reader below (vocationalSchoolDatesForLeaveRequests via buildLeaveListPeriods) is
// untouched — that is a display-only BS note, not a payroll day count, and out of this plan's
// scope (451-02).

// Issue #448 (D-05, plan 03): the ONE `periods` builder for both `/leave-list/pdf` and the list
// part of `/vacation/pdf` — both built this identically before this plan. `bsDatesByRequestId`
// comes from ONE vocationalSchoolDatesForLeaveRequests call per route (never per period); a BS
// date outside the year-clamped `[s, e2]` window is neither named in `note` nor affects `days` —
// it was never counted in the unclamped period either.
//
// Issue #451 (D-02): `days` is read from `pricedDaysByRequestId` (the absence context's own
// year-clipped leaveRequestDaysWithin result, prefetched once per route) — the local
// calendar-day count this function used to compute itself, and its BS-date subtraction, are
// gone; the absence context's own pricing already excludes a Berufsschultag from a VACATION
// request's count (#448). The BS note itself stays exactly as built before — it explains WHY the
// priced days are lower, independent of how those days were priced.
//
// Module-private — the test suite inspects its output the same way reports.test.ts already does
// for the vacation-overview PDF: a `vi.mock("../pdf")` spy on `streamLeaveListPdf` captures the
// `LeaveListData` argument before it reaches PDFKit's Flate-compressed streams (see that file's
// own header comment on why a byte-content substring search on the PDF payload is proven
// vacuous).
function buildLeaveListPeriods(
  leaveRequests: Array<{
    id: string;
    startDate: Date;
    endDate: Date;
    leaveType: { code: LeaveTypeCode | null; name: string };
  }>,
  yearStart: Date,
  yearEnd: Date,
  tz: string,
  bsDatesByRequestId: Map<string, string[]>,
  pricedDaysByRequestId: Map<string, number>,
): Array<{
  startDate: string;
  endDate: string;
  leaveTypeName: string;
  days: number;
  note?: string;
}> {
  return leaveRequests.map((lr) => {
    const s = lr.startDate < yearStart ? yearStart : lr.startDate;
    const e2 = lr.endDate > yearEnd ? yearEnd : lr.endDate;
    const bsDatesInRange = (bsDatesByRequestId.get(lr.id) ?? []).filter((d) => {
      const dt = new Date(`${d}T00:00:00.000Z`);
      return dt >= s && dt <= e2;
    });
    const days = pricedDaysByRequestId.get(lr.id) ?? 0;
    const note = bsDatesInRange.length
      ? `${BS_NO_LEAVE_LABEL}: ${bsDatesInRange
          .map((d) => formatInTimeZone(new Date(`${d}T00:00:00.000Z`), tz, "dd.MM."))
          .join(", ")}`
      : undefined;
    return {
      startDate: formatInTimeZone(lr.startDate, tz, "dd.MM.yyyy"),
      endDate: formatInTimeZone(lr.endDate, tz, "dd.MM.yyyy"),
      leaveTypeName: lr.leaveType.name,
      days,
      ...(note ? { note } : {}),
    };
  });
}

// Issue #451 (D-02): one leaveRequestDaysWithin call per leave request in the year — feeds
// buildLeaveListPeriods's required pricedDaysByRequestId parameter with the absence context's
// own priced, year-clipped day count, replacing the unclamped-at-year-boundary calendar-day count
// buildLeaveListPeriods used to compute itself. `yearFrom`/`yearTo` MUST be UTC-midnight calendar
// days (not `yearStart`/`yearEnd`'s own `23:59:59.999Z` end-of-day instant) — see
// leaveRequestDaysWithin's own docblock. Sequential awaits (no unbounded Promise.all), same shape
// as fetchLeaveDaysByCodeForMonthlyReport above.
async function fetchPricedDaysByRequestId(
  app: FastifyInstance,
  tenantId: string,
  employees: Array<{
    id: string;
    leaveRequests: Array<{ id: string; startDate: Date; endDate: Date; days: unknown }>;
  }>,
  yearFrom: Date,
  yearTo: Date,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (const emp of employees) {
    for (const lr of emp.leaveRequests) {
      result.set(
        lr.id,
        await leaveRequestDaysWithin(app.prisma, {
          employeeId: emp.id,
          tenantId,
          request: lr,
          from: yearFrom,
          to: yearTo,
        }),
      );
    }
  }
  return result;
}

export async function reportRoutes(app: FastifyInstance) {
  // GET /api/v1/reports/monthly?employeeId=&year=&month=
  app.get("/monthly", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("report:read:ZUGEWIESEN"),
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

      // Phase 91b Plan 07 (Issue #91), D-10/D-13 — narrow to Stammsalon-scoped employees BEFORE
      // building the report body. Stichtag = the report period's own last day (`end`, already
      // computed above). This is the template every other list route in this file follows.
      const access = accessContextFromRequest(req);
      const scopeReach = await resolveAccessReach(app.prisma, access, "report:read:ZUGEWIESEN");
      const scopedEmployeeIds =
        scopeReach.kind === "wholeTenant"
          ? "all"
          : await resolveStammsalonScopedEmployeeIds(
              app.prisma,
              req.user.tenantId,
              scopeReach,
              end,
            );

      // Alle Mitarbeiter des Tenants (oder nur einen)
      const employees = (await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          exitDate: null,
          user: { isActive: true },
          // Both constraints must combine when a manager ALSO supplies an explicit employeeId
          // (same AND-array idiom as leave.ts's GET /requests, Plan 91b-04 Task 1): an
          // out-of-scope named employeeId must yield zero rows, not bypass the scope filter.
          ...(employeeId || scopedEmployeeIds !== "all"
            ? {
                AND: [
                  ...(employeeId ? [{ id: employeeId }] : []),
                  ...(scopedEmployeeIds !== "all" ? [{ id: { in: scopedEmployeeIds } }] : []),
                ],
              }
            : {}),
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

      // Issue #451 (D-02): the absence context's own priced leave-day map, one
      // leaveDaysByCodeWithin call per employee with at least one leave request this month —
      // see the helper's own doc block for the UTC-midnight bounds rationale.
      const leaveDaysByCodeByEmp = await fetchLeaveDaysByCodeForMonthlyReport(
        app,
        req.user.tenantId,
        employees,
        y,
        m,
      );

      // Issue #451 (D-03): one Soll/Ist/Überstunden result per employee, sequentially — the
      // working-time-account's own month result (snapshot / fullMonth / to-date header), never a
      // composition-layer Soll. See computeMonthReportFigures's own doc block for the basis rules.
      const rows: Array<{
        employeeId: string;
        employeeName: string;
        employeeNumber: string;
        workedHours: number;
        shouldHours: number;
        overtimeHours: number;
        overtimeConfirmed: boolean | null;
        balanceAdjustmentHours: number;
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
      }> = [];
      for (const emp of employees) {
        const summary = computeEmployeeSummary(
          emp,
          start,
          end,
          tz,
          leaveDaysByCodeByEmp.get(emp.id) ?? new Map(),
          section9ByEmp.get(emp.id) ?? [],
        );
        const figures = await computeMonthReportFigures(app, emp.id, y, m);
        rows.push({
          employeeId: emp.id,
          employeeName: `${emp.firstName} ${emp.lastName}`,
          employeeNumber: emp.employeeNumber,
          workedHours: Math.round((figures.workedMinutes / 60) * 100) / 100,
          shouldHours: Math.round((figures.expectedMinutes / 60) * 100) / 100,
          overtimeHours: Math.round((figures.balanceMinutes / 60) * 100) / 100,
          overtimeConfirmed: figures.labelled ? figures.confirmed : null,
          balanceAdjustmentHours: Math.round((figures.balanceAdjustmentMinutes / 60) * 100) / 100,
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
        });
      }

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
    preHandler: requirePermission("report:read:ZUGEWIESEN"),
    handler: async (req) => {
      const { year } = req.query as { year: string };
      const y = parseInt(year ?? new Date().getFullYear().toString());

      const allEntitlements = await listEntitlementsForYear(app.prisma, req.user.tenantId, y);

      // Phase 91b Plan 07 (Issue #91), D-10/D-13 — narrow to Stammsalon-scoped employees BEFORE
      // self-healing (an out-of-scope employee's usedDays must not even be WRITTEN by this route,
      // let alone returned). `listEntitlementsForYear` has no employeeIds parameter, so this
      // filters immediately after the fetch — same pattern Plan 91b-06 used for
      // listOvertimeAccountsForTenant. Stichtag = Dec 31 of the requested year (the period's own
      // last day, same as every period-bound list route in this file).
      const leaveOverviewAccess = accessContextFromRequest(req);
      const leaveOverviewScopeReach = await resolveAccessReach(
        app.prisma,
        leaveOverviewAccess,
        "report:read:ZUGEWIESEN",
      );
      const leaveOverviewScopedIds =
        leaveOverviewScopeReach.kind === "wholeTenant"
          ? "all"
          : await resolveStammsalonScopedEmployeeIds(
              app.prisma,
              req.user.tenantId,
              leaveOverviewScopeReach,
              new Date(`${y}-12-31T23:59:59.999Z`),
            );
      const entitlements =
        leaveOverviewScopedIds === "all"
          ? allEntitlements
          : allEntitlements.filter((e) => leaveOverviewScopedIds.includes(e.employeeId));

      // Self-heal usedDays from Σ approved LeaveRequest.days BEFORE we shape the response.
      // Mirrors the heal that GET /entitlements/:employeeId has done since v1.4.
      // Fixes the report-vs-leave-page divergence (a-tenant incident 2026-05-27).
      // healZeroPlaceholder (Issue #445, D-05) and healUsedDays (Issue #445, D-10) are injected
      // rather than imported statically by leave-self-heal.ts itself — see that file's module
      // docblock for why.
      const vacMeta = {
        ...(await loadVacationTypeMeta(app.prisma, req.user.tenantId)),
        healZeroPlaceholder: (
          prisma: typeof app.prisma,
          employeeId: string,
          empTenantId: string,
          year: number,
          leaveTypeId: string,
        ) =>
          ensureRegularVacationEntitlement(
            prisma,
            employeeId,
            empTenantId,
            year,
            leaveTypeId,
            REGULAR_ENTITLEMENT_REASON_SELF_HEAL,
          ),
        healUsedDays: (
          prisma: typeof app.prisma,
          row: {
            id: string;
            employeeId: string;
            leaveTypeId: string;
            year: number;
            usedDays: unknown;
          },
          leaveTypeIds: string[],
          empTenantId: string,
        ) => healEntitlementUsedDays(prisma, row, leaveTypeIds, empTenantId),
      };
      await selfHealUsedDays(app.prisma, entitlements, vacMeta);

      // Bulk fetch PENDING leave requests for the same year + tenant (NO per-entitlement loop)
      // Phase 100B Plan 13 — A7c, contexts/absence facade.
      const pending = await getPendingLeaveDaysInYear(app.prisma, req.user.tenantId, y);

      // Build a lookup map keyed by "employeeId:leaveTypeId" → summed pending days
      const pendingMap = new Map<string, number>();
      for (const row of pending) {
        const key = `${row.employeeId}:${row.leaveTypeId}`;
        pendingMap.set(key, (pendingMap.get(key) ?? 0) + Number(row.days));
      }

      const realRows = entitlements.map((e) => ({
        employee: e.employee,
        leaveType: e.leaveType,
        year: e.year,
        totalDays: Number(e.totalDays),
        carriedOverDays: Number(e.carriedOverDays),
        usedDays: Number(e.usedDays),
        remainingDays: Number(e.totalDays) + Number(e.carriedOverDays) - Number(e.usedDays),
        pendingDays: pendingMap.get(`${e.employeeId}:${e.leaveTypeId}`) ?? 0,
        missingEntitlement: false as const,
        // Issue #445 (coordinator deviation from CONTEXT D-05) — selfHealUsedDays above sets
        // needsReview on a VACATION row whose zero placeholder was left unhealed because it
        // was ambiguous (see isAmbiguousRegularEntitlement in contexts/absence/leave-days.ts).
        // The flag AND the warning string are both computed in the absence context — this
        // composition layer carries no business rule (CLAUDE.md, ADR 0002 Entscheidung 9).
        entitlementWarning: vacationEntitlementWarning({
          leaveTypeCode: e.leaveType.code,
          year: e.year,
          needsReview: (e as { needsReview?: boolean }).needsReview,
        }),
      }));

      // Issue #416 (AC-3/AC-4): active tenant employees (same Stammsalon scope as the
      // entitlements query above) with NO VACATION-coded entitlement row for `y` are surfaced as
      // placeholder rows — this is the Urlaubsbericht's own contribution to visibility, it must
      // NOT call ensureVacationEntitlementForYear here (display only, never create — otherwise
      // the gap this AC requires visible would already be gone by the time it's rendered).
      // GET /vacation/pdf and /leave-overview/pdf (below, ~2080/~2215) build their OWN
      // listEntitlementsForYear query independently rather than sharing this handler's — they do
      // NOT inherit this fix and are deliberately out of scope for this phase (issue #416's AC
      // names the JSON leave-overview endpoint only).
      const vacationEmployeeIds = new Set(
        entitlements.filter((e) => e.leaveType.code === "VACATION").map((e) => e.employeeId),
      );
      const activeEmployees = await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          exitDate: null,
          ...(leaveOverviewScopedIds !== "all" ? { id: { in: leaveOverviewScopedIds } } : {}),
        },
        select: { id: true, firstName: true, lastName: true, employeeNumber: true },
      });
      const missingEntitlementRows = activeEmployees
        .filter((emp) => !vacationEmployeeIds.has(emp.id))
        .map((emp) => ({
          employee: emp,
          leaveType: null,
          year: y,
          totalDays: null,
          carriedOverDays: null,
          usedDays: null,
          remainingDays: null,
          pendingDays: null,
          missingEntitlement: true as const,
          entitlementWarning: null,
        }));

      return [...realRows, ...missingEntitlementRows];
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
    preHandler: requirePermission("report:read:ZUGEWIESEN"),
    handler: async (req) => {
      const { days } = req.query as { days?: string };
      const horizon = Math.max(1, Math.min(365, parseInt(days ?? "60", 10) || 60));

      const now = new Date();
      const cutoff = new Date(now.getTime() + horizon * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const allExpiringEntitlements = await getExpiringCarryOver(
        app.prisma,
        req.user.tenantId,
        now,
        cutoff,
      );

      // Phase 91b Plan 07 (Issue #91), D-10/D-13 — narrow to Stammsalon-scoped employees BEFORE
      // the audit-log lookups below. `getExpiringCarryOver` has no employeeIds parameter, so this
      // filters immediately after the fetch. Stichtag = today (tenant-local) — this route has no
      // period of its own, only a forward-looking deadline window, same "no natural period"
      // precedent as the sibling plans.
      const carryoverAccess = accessContextFromRequest(req);
      const carryoverScopeReach = await resolveAccessReach(
        app.prisma,
        carryoverAccess,
        "report:read:ZUGEWIESEN",
      );
      const carryoverScopedIds =
        carryoverScopeReach.kind === "wholeTenant"
          ? "all"
          : await resolveStammsalonScopedEmployeeIds(
              app.prisma,
              req.user.tenantId,
              carryoverScopeReach,
              now,
            );
      const entitlements =
        carryoverScopedIds === "all"
          ? allExpiringEntitlements
          : allExpiringEntitlements.filter((e) => carryoverScopedIds.includes(e.employeeId));

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
    preHandler: requirePermission("report:notify:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { entitlementId } = (req.body ?? {}) as { entitlementId?: string };
      if (!entitlementId) {
        return reply.code(400).send({ error: "entitlementId fehlt" });
      }

      // Tenant scope check (T-100B-43: constrained IN the query, not fetch-then-compare)
      const ent = await getEntitlementById(app.prisma, req.user.tenantId, entitlementId);
      if (!ent) {
        return reply.code(404).send({ error: "Anspruch nicht gefunden" });
      }

      // Phase 91b Plan 07 (Issue #91), D-10/D-14 — this is a NEW finding: the plan's own text
      // groups this route among "list/bulk" routes, but it acts on ONE entitlement (by id), the
      // same single-target shape every other plan in this phase gives a boolean scope check, not
      // the list resolver. Stichtag = today (tenant-local) — triggering a reminder is a NOW
      // action, not tied to the entitlement's own year boundaries.
      {
        const carryoverWarnAccess = accessContextFromRequest(req);
        const carryoverWarnScopeReach = await resolveAccessReach(
          app.prisma,
          carryoverWarnAccess,
          "report:notify:ZUGEWIESEN",
        );
        if (
          !(await isStammsalonScopeMatch(
            app.prisma,
            req.user.tenantId,
            carryoverWarnScopeReach,
            ent.employeeId,
            new Date(),
          ))
        ) {
          await app.audit({
            userId: req.user.sub,
            action: "SCOPE_ACCESS_DENIED",
            entity: "LeaveEntitlement",
            entityId: entitlementId,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          return reply.code(404).send({ error: "Anspruch nicht gefunden" });
        }
      }

      // Issue #451 (D-08, 451-08 cycle fix) — reached via the Fastify decoration
      // `plugins/carryover-warning.ts` registers, not an index.ts re-export (see that file's
      // module header for why).
      const result = await app.runCarryoverWarningOnce({ onlyEntitlementId: entitlementId });

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
    preHandler: requirePermission("report:export:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { year, month } = req.query as { year: string; month: string };
      const y = parseInt(year);
      const m = parseInt(month);
      if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
        return reply.code(400).send({ error: "Ungültige Jahr- oder Monatsangabe" });
      }
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const { start, end } = monthRangeUtc(y, m, tz);

      // Phase 91b Plan 07 (Issue #91), D-10/D-13 — narrow to Stammsalon-scoped employees BEFORE
      // building the export. Stichtag = the payroll period's own last day (`end`).
      const datevAccess = accessContextFromRequest(req);
      const datevScopeReach = await resolveAccessReach(
        app.prisma,
        datevAccess,
        "report:export:ZUGEWIESEN",
      );
      const datevScopedIds =
        datevScopeReach.kind === "wholeTenant"
          ? "all"
          : await resolveStammsalonScopedEmployeeIds(
              app.prisma,
              req.user.tenantId,
              datevScopeReach,
              end,
            );

      // Issue #256 (Befund 2): employed DURING the Abrechnungszeitraum, not employed today.
      const employees = await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          ...datevPayrollPeriodEmployeeFilter(start, end),
          ...(datevScopedIds !== "all" ? { id: { in: datevScopedIds } } : {}),
        },
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
          leaveRequests: {
            where: {
              deletedAt: null,
              status: { in: [...EFFECTIVE_LEAVE_STATUSES] }, // Issue #446 (D-04)
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
          datevBeraterNr: true,
          datevMandantenNr: true,
        },
      });
      const lna = {
        normal: datevConfig?.datevNormalstundenNr ?? 100,
        urlaub: datevConfig?.datevUrlaubNr ?? 300,
        krank: datevConfig?.datevKrankNr ?? 200,
        sonderurlaub: datevConfig?.datevSonderurlaubNr ?? 302,
      };

      // Issue #256 (Befund 3): Berater- und Mandantennummer were hardcoded zeros — a file
      // that no Lohnbüro can assign to a Mandant, handed over as if it were finished.
      // There is no defensible default for either, so an unconfigured tenant gets a refusal
      // with a German message instead of a plausible-looking but unimportable file.
      const kanzlei = resolveDatevKanzlei(datevConfig);
      if (!kanzlei) {
        return reply.code(409).send({ error: DATEV_KANZLEI_MISSING_ERROR });
      }

      const section9ByEmpDatev = await fetchConfirmedSection9CreditsByEmp(
        app,
        req.user.tenantId,
        start,
        end,
      );
      // Issue #451 (D-01): UTC-midnight calendar-day bounds for the facade call — NOT `start`/
      // `end` above, which are monthRangeUtc()'s tenant-tz instants (see
      // fetchLeaveDaysByEmployeeForDatev's own docblock).
      const leaveDaysByEmployeeDatev = await fetchLeaveDaysByEmployeeForDatev(
        app,
        req.user.tenantId,
        employees,
        y,
        m,
      );

      const buf = buildDatevLodas({
        employees,
        year: y,
        month: m,
        start,
        end,
        lna,
        kanzlei,
        section9ByEmp: section9ByEmpDatev,
        leaveDaysByEmployee: leaveDaysByEmployeeDatev,
      });

      // Issue #256, acceptance criterion "the export reports whom it leaves out": count
      // who the period predicate excluded, and why. The file's own sections are LODAS's
      // format and are still under review in part 2 of #256, so the count goes where it
      // is durable, tenant-scoped and already read during an audit: the EXPORT row.
      const [skippedNotYetHired, skippedAlreadyLeft] = await Promise.all([
        app.prisma.employee.count({
          where: { tenantId: req.user.tenantId, hireDate: { gt: end } },
        }),
        app.prisma.employee.count({
          where: { tenantId: req.user.tenantId, exitDate: { lt: start } },
        }),
      ]);

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: {
          type: "DATEV",
          year,
          month,
          employeesIncluded: employees.length,
          skippedNotYetHired,
          skippedAlreadyLeft,
        },
      });

      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Disposition", `attachment; filename="datev-${year}-${month}.txt"`);
      return reply.send(buf);
    },
  });

  // GET /api/v1/reports/datev/employee?employeeId=&year=&month=  – Per-Employee DATEV LODAS Export (RPT-03)
  app.get("/datev/employee", {
    schema: { tags: ["Berichte"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("report:export:ZUGEWIESEN"),
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
          datevBeraterNr: true,
          datevMandantenNr: true,
        },
      });
      const lna = {
        normal: datevConfig?.datevNormalstundenNr ?? 100,
        urlaub: datevConfig?.datevUrlaubNr ?? 300,
        krank: datevConfig?.datevKrankNr ?? 200,
        sonderurlaub: datevConfig?.datevSonderurlaubNr ?? 302,
      };

      // Issue #256 (Befund 3): Berater- und Mandantennummer were hardcoded zeros — a file
      // that no Lohnbüro can assign to a Mandant, handed over as if it were finished.
      // There is no defensible default for either, so an unconfigured tenant gets a refusal
      // with a German message instead of a plausible-looking but unimportable file.
      const kanzlei = resolveDatevKanzlei(datevConfig);
      if (!kanzlei) {
        return reply.code(409).send({ error: DATEV_KANZLEI_MISSING_ERROR });
      }

      const emp = await app.prisma.employee.findFirst({
        where: {
          id: employeeId,
          tenantId: req.user.tenantId, // tenant isolation — mandatory
          // Issue #256 (Befund 2): the SAME period predicate the company-wide export uses,
          // from the same function, so the two cannot answer "who counts" differently.
          ...datevPayrollPeriodEmployeeFilter(start, end),
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
          leaveRequests: {
            where: {
              deletedAt: null,
              status: { in: [...EFFECTIVE_LEAVE_STATUSES] }, // Issue #446 (D-04)
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

      // Phase 91b Plan 07 (Issue #91), D-10/D-14 — a NEW finding: the plan groups this route among
      // "list/bulk" routes, but it acts on ONE named employeeId — a single-target route needing a
      // boolean scope check. Stichtag = the payroll period's own last day (`end`).
      {
        const datevEmpAccess = accessContextFromRequest(req);
        const datevEmpScopeReach = await resolveAccessReach(
          app.prisma,
          datevEmpAccess,
          "report:export:ZUGEWIESEN",
        );
        if (
          !(await isStammsalonScopeMatch(
            app.prisma,
            req.user.tenantId,
            datevEmpScopeReach,
            employeeId,
            end,
          ))
        ) {
          await app.audit({
            userId: req.user.sub,
            action: "SCOPE_ACCESS_DENIED",
            entity: "Employee",
            entityId: employeeId,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
        }
      }

      const section9ByEmpDatevSingle = await fetchConfirmedSection9CreditsByEmp(
        app,
        req.user.tenantId,
        start,
        end,
      );
      const leaveDaysByEmployeeDatevSingle = await fetchLeaveDaysByEmployeeForDatev(
        app,
        req.user.tenantId,
        [emp],
        y,
        m,
      );

      const buf = buildDatevLodas({
        employees: [emp],
        year: y,
        month: m,
        start,
        end,
        lna,
        kanzlei,
        section9ByEmp: section9ByEmpDatevSingle,
        leaveDaysByEmployee: leaveDaysByEmployeeDatevSingle,
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
      const reach = await permissionReach(req, "report:export");
      if (reach !== "ZUGEWIESEN" && req.user.employeeId !== employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }
      if (reach === null) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      const y = parseInt(year);
      const m = parseInt(month);
      if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
        return reply.code(400).send({ error: "Ungültige Jahr- oder Monatsangabe" });
      }
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const { start, end } = monthRangeUtc(y, m, tz);

      const tenant = await app.prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { name: true },
      });

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

      // Phase 91b Plan 07 (Issue #91), D-10/D-14 — a ZUGEWIESEN reach may still be scoped to
      // salons/persons (Plan 91b-01's D-05 gate change). Only runs for the "someone else" branch
      // — the EIGENE self-download path above is untouched. Stichtag = the report period's own
      // last day (`end`). Runs BEFORE the holiday computation below, so an out-of-scope employee's
      // data is never touched at all.
      if (reach === "ZUGEWIESEN" && req.user.employeeId !== employeeId) {
        const monthlyPdfAccess = accessContextFromRequest(req);
        const monthlyPdfScopeReach = await resolveAccessReach(
          app.prisma,
          monthlyPdfAccess,
          "report:export:ZUGEWIESEN",
        );
        if (
          !(await isStammsalonScopeMatch(
            app.prisma,
            req.user.tenantId,
            monthlyPdfScopeReach,
            employeeId,
            end,
          ))
        ) {
          await app.audit({
            userId: req.user.sub,
            action: "SCOPE_ACCESS_DENIED",
            entity: "Employee",
            entityId: employeeId,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          reply.code(404);
          return { error: "Mitarbeiter nicht gefunden" };
        }
      }

      // Phase 104 (D-30): the PDF (Arbeitszeitnachweis handed to the employee/auditor)
      // must show the identical § 9 attribution as the JSON Monatsbericht.
      const section9ByEmpPdf = await fetchConfirmedSection9CreditsByEmp(
        app,
        req.user.tenantId,
        start,
        end,
      );
      // Issue #451 (D-02): same priced leave-day map as GET /monthly, for this one employee.
      const leaveDaysByCodePdf = await fetchLeaveDaysByCodeForMonthlyReport(
        app,
        req.user.tenantId,
        [emp],
        y,
        m,
      );
      const summary = computeEmployeeSummary(
        emp,
        start,
        end,
        tz,
        leaveDaysByCodePdf.get(emp.id) ?? new Map(),
        section9ByEmpPdf.get(emp.id) ?? [],
      );
      // Issue #451 (D-03): the legal Stundennachweis prints the SAME working-time-account result
      // as the JSON Monatsbericht — never a composition-layer Soll. `overtimeConfirmed` is null
      // (not a boolean) when unlabelled, so the PDF renderer can omit the Bestätigt/Prognose label
      // entirely instead of mislabelling it (SALDO-DISP-05).
      const figures = await computeMonthReportFigures(app, emp.id, y, m);
      const workedHours = Math.round((figures.workedMinutes / 60) * 100) / 100;
      const targetHours = Math.round((figures.expectedMinutes / 60) * 100) / 100;
      const overtimeHours = Math.round((figures.balanceMinutes / 60) * 100) / 100;
      // Issue #451 (D-03): same WTA reconciliation item as GET /monthly's balanceAdjustmentHours.
      const balanceAdjustmentHours = figures.labelled
        ? Math.round((figures.balanceAdjustmentMinutes / 60) * 100) / 100
        : 0;

      const pdfBuffer = await generateMonthlyReportPdf({
        tenantName: tenant?.name ?? "",
        employeeName: `${emp.firstName} ${emp.lastName}`,
        employeeNumber: emp.employeeNumber,
        month: `${MONTH_NAMES[m - 1]} ${y}`,
        workedHours,
        targetHours,
        overtimeHours,
        overtimeConfirmed: figures.labelled ? figures.confirmed : null,
        balanceAdjustmentHours,
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
    preHandler: requirePermission("report:export:ZUGEWIESEN"),
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

      // ALLOWLIST validation — never pass untrusted string to Prisma enum. The parse and the
      // where-fragment live in contexts/platform/compat-role.ts, the one module that compares role
      // values (Phase 75b, Issue #75, D-19): this filters the LISTED employees, it decides nothing
      // about the caller.
      const roleFilter: CompatRoleFilter | undefined = parseCompatRoleFilter(role);

      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const { start, end } = monthRangeUtc(y, m, tz);

      const tenant = await app.prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { name: true },
      });

      // Phase 91b Plan 07 (Issue #91), D-10/D-13 — narrow to Stammsalon-scoped employees BEFORE
      // building the company-wide PDF. Stichtag = the report period's own last day (`end`).
      const pdfAllAccess = accessContextFromRequest(req);
      const pdfAllScopeReach = await resolveAccessReach(
        app.prisma,
        pdfAllAccess,
        "report:export:ZUGEWIESEN",
      );
      const pdfAllScopedIds =
        pdfAllScopeReach.kind === "wholeTenant"
          ? "all"
          : await resolveStammsalonScopedEmployeeIds(
              app.prisma,
              req.user.tenantId,
              pdfAllScopeReach,
              end,
            );

      const employees = (await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          exitDate: null,
          user: { isActive: true, ...compatRoleUserWhere(roleFilter) },
          ...(pdfAllScopedIds !== "all" ? { id: { in: pdfAllScopedIds } } : {}),
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

      // Issue #451 (D-02): the absence context's own priced leave-day map, prefetched
      // SEQUENTIALLY for the whole company PDF (never inside the per-employee Promise.all
      // below) — same helper, same bounds as GET /monthly above.
      const leaveDaysByCodeAll = await fetchLeaveDaysByCodeForMonthlyReport(
        app,
        req.user.tenantId,
        employees,
        y,
        m,
      );

      // Issue #451 (D-03): sequential — one computeMonthReportFigures call per employee, never
      // inside a Promise.all (the plan's own requirement for the company PDF).
      const rows: Array<{
        employeeName: string;
        employeeNumber: string;
        role: "ADMIN" | "MANAGER" | "EMPLOYEE";
        workedHours: number;
        targetHours: number;
        overtimeHours: number;
        overtimeConfirmed: boolean | null;
        balanceAdjustmentHours: number;
        sickDaysWithAttest: number;
        sickDaysWithoutAttest: number;
        vacationDays: number;
        totalAbsenceDays: number;
        section9DaysThisMonth: number;
        entries: ReturnType<typeof computeEmployeeSummary>["entries"];
      }> = [];
      for (const emp of employees) {
        const summary = computeEmployeeSummary(
          emp,
          start,
          end,
          tz,
          leaveDaysByCodeAll.get(emp.id) ?? new Map(),
          section9ByEmpAll.get(emp.id) ?? [],
        );
        const figures = await computeMonthReportFigures(app, emp.id, y, m);
        rows.push({
          employeeName: `${emp.firstName} ${emp.lastName}`,
          employeeNumber: emp.employeeNumber,
          role: emp.user.role,
          workedHours: Math.round((figures.workedMinutes / 60) * 100) / 100,
          targetHours: Math.round((figures.expectedMinutes / 60) * 100) / 100,
          overtimeHours: Math.round((figures.balanceMinutes / 60) * 100) / 100,
          overtimeConfirmed: figures.labelled ? figures.confirmed : null,
          // Issue #451 (D-03): same WTA reconciliation item as GET /monthly's balanceAdjustmentHours.
          balanceAdjustmentHours: figures.labelled
            ? Math.round((figures.balanceAdjustmentMinutes / 60) * 100) / 100
            : 0,
          sickDaysWithAttest: summary.sickDaysWithAttest,
          sickDaysWithoutAttest: summary.sickDaysWithoutAttest,
          vacationDays: summary.vacationDays,
          totalAbsenceDays: summary.totalAbsenceDays,
          section9DaysThisMonth: summary.section9DaysThisMonth,
          entries: summary.entries,
        });
      }

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
    preHandler: requirePermission("report:export:ZUGEWIESEN"),
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

      // Phase 91b Plan 07 (Issue #91), D-10/D-13 — narrow to Stammsalon-scoped employees BEFORE
      // building the PDF. Stichtag = Dec 31 of the requested year (`yearEnd`).
      const leaveListPdfAccess = accessContextFromRequest(req);
      const leaveListPdfScopeReach = await resolveAccessReach(
        app.prisma,
        leaveListPdfAccess,
        "report:export:ZUGEWIESEN",
      );
      const leaveListPdfScopedIds =
        leaveListPdfScopeReach.kind === "wholeTenant"
          ? "all"
          : await resolveStammsalonScopedEmployeeIds(
              app.prisma,
              req.user.tenantId,
              leaveListPdfScopeReach,
              yearEnd,
            );

      const employees = await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          exitDate: null,
          user: { isActive: true },
          ...(leaveListPdfScopedIds !== "all" ? { id: { in: leaveListPdfScopedIds } } : {}),
        },
        include: {
          leaveRequests: {
            where: {
              deletedAt: null,
              status: { in: [...EFFECTIVE_LEAVE_STATUSES] }, // Issue #446 (D-04)
              startDate: { lte: yearEnd },
              endDate: { gte: yearStart },
            },
            include: { leaveType: true },
            orderBy: { startDate: "asc" },
          },
        },
        orderBy: { lastName: "asc" },
      });

      // Issue #448 (D-05, plan 03): ONE batch BS-date read for every employee's requests in this
      // PDF, scoped via employeeScopeFor(accessContextFromRequest(req), …) over exactly the
      // employees already loaded above (T-448-12).
      const leaveListBsRequests = employees.flatMap((emp) =>
        emp.leaveRequests.map((lr) => ({
          id: lr.id,
          employeeId: emp.id,
          startDate: lr.startDate,
          endDate: lr.endDate,
          leaveTypeCode: lr.leaveType.code,
        })),
      );
      const leaveListBsDates = leaveListBsRequests.length
        ? await vocationalSchoolDatesForLeaveRequests(
            app.prisma,
            employeeScopeFor(accessContextFromRequest(req), {
              employeeIds: employees.map((e) => e.id),
            }),
            leaveListBsRequests,
          )
        : new Map<string, string[]>();

      // Issue #451 (D-02): the absence context's own priced, year-clipped day count for every
      // listed request — UTC-midnight bounds, never yearStart/yearEnd's own end-of-day instant.
      const leaveListPricedDays = await fetchPricedDaysByRequestId(
        app,
        req.user.tenantId,
        employees,
        new Date(Date.UTC(y, 0, 1)),
        new Date(Date.UTC(y, 11, 31)),
      );

      // Build leave list data (include all employees, even those with no leave — show empty periods)
      const leaveListData = {
        tenantName: tenant?.name ?? "",
        year: y,
        employees: employees.map((emp) => {
          const periods = buildLeaveListPeriods(
            emp.leaveRequests,
            yearStart,
            yearEnd,
            tz,
            leaveListBsDates,
            leaveListPricedDays,
          );
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
    preHandler: requirePermission("report:export:ZUGEWIESEN"),
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

      // Phase 91b Plan 07 (Issue #91), D-10/D-13 — narrow to Stammsalon-scoped employees BEFORE
      // building the PDF, applied to BOTH datasets below. Stichtag = Dec 31 of the requested year.
      const vacationPdfAccess = accessContextFromRequest(req);
      const vacationPdfScopeReach = await resolveAccessReach(
        app.prisma,
        vacationPdfAccess,
        "report:export:ZUGEWIESEN",
      );
      const vacationPdfScopedIds =
        vacationPdfScopeReach.kind === "wholeTenant"
          ? "all"
          : await resolveStammsalonScopedEmployeeIds(
              app.prisma,
              req.user.tenantId,
              vacationPdfScopeReach,
              yearEnd,
            );

      // Fetch both datasets in parallel
      const [employees, allVacationEntitlements] = await Promise.all([
        app.prisma.employee.findMany({
          where: {
            tenantId: req.user.tenantId,
            exitDate: null,
            user: { isActive: true },
            ...(vacationPdfScopedIds !== "all" ? { id: { in: vacationPdfScopedIds } } : {}),
          },
          include: {
            leaveRequests: {
              where: {
                deletedAt: null,
                status: { in: [...EFFECTIVE_LEAVE_STATUSES] }, // Issue #446 (D-04)
                startDate: { lte: yearEnd },
                endDate: { gte: yearStart },
              },
              include: { leaveType: true },
              orderBy: { startDate: "asc" },
            },
          },
          orderBy: { lastName: "asc" },
        }),
        listEntitlementsForYear(app.prisma, req.user.tenantId, y),
      ]);
      const entitlements =
        vacationPdfScopedIds === "all"
          ? allVacationEntitlements
          : allVacationEntitlements.filter((e) => vacationPdfScopedIds.includes(e.employeeId));

      // Issue #448 (D-05, plan 03): same ONE batch BS-date read as /leave-list/pdf above.
      const vacationPdfBsRequests = employees.flatMap((emp) =>
        emp.leaveRequests.map((lr) => ({
          id: lr.id,
          employeeId: emp.id,
          startDate: lr.startDate,
          endDate: lr.endDate,
          leaveTypeCode: lr.leaveType.code,
        })),
      );
      const vacationPdfBsDates = vacationPdfBsRequests.length
        ? await vocationalSchoolDatesForLeaveRequests(
            app.prisma,
            employeeScopeFor(accessContextFromRequest(req), {
              employeeIds: employees.map((e) => e.id),
            }),
            vacationPdfBsRequests,
          )
        : new Map<string, string[]>();

      // Issue #451 (D-02): same ONE batch priced-days read as /leave-list/pdf above.
      const vacationPdfPricedDays = await fetchPricedDaysByRequestId(
        app,
        req.user.tenantId,
        employees,
        new Date(Date.UTC(y, 0, 1)),
        new Date(Date.UTC(y, 11, 31)),
      );

      // Build leave list data
      const leaveListData = {
        tenantName: tenant?.name ?? "",
        year: y,
        employees: employees.map((emp) => {
          const periods = buildLeaveListPeriods(
            emp.leaveRequests,
            yearStart,
            yearEnd,
            tz,
            vacationPdfBsDates,
            vacationPdfPricedDays,
          );
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
        // Phase 97 (D-11): the annual-leave overview is the VACATION entitlement, selected by
        // code. The previous version lower-cased the display name and matched a substring of it,
        // which caught four of the nine canonical names — annual leave plus the special, unpaid
        // and further-education types, all of which end in the same German word — and summed all
        // four into a single annual-leave figure. Behaviour change, deliberate and tested.
        if (e.leaveType.code !== "VACATION") continue;
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
    preHandler: requirePermission("report:export:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { year } = req.query as { year: string };
      const y = parseInt(year ?? new Date().getFullYear().toString());

      const tenant = await app.prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { name: true },
      });

      const allLeaveOverviewPdfEntitlements = await listEntitlementsForYear(
        app.prisma,
        req.user.tenantId,
        y,
      );

      // Phase 91b Plan 07 (Issue #91), D-10/D-13 — narrow to Stammsalon-scoped employees BEFORE
      // building the PDF. Stichtag = Dec 31 of the requested year.
      const leaveOverviewPdfAccess = accessContextFromRequest(req);
      const leaveOverviewPdfScopeReach = await resolveAccessReach(
        app.prisma,
        leaveOverviewPdfAccess,
        "report:export:ZUGEWIESEN",
      );
      const leaveOverviewPdfScopedIds =
        leaveOverviewPdfScopeReach.kind === "wholeTenant"
          ? "all"
          : await resolveStammsalonScopedEmployeeIds(
              app.prisma,
              req.user.tenantId,
              leaveOverviewPdfScopeReach,
              new Date(`${y}-12-31T23:59:59.999Z`),
            );
      const entitlements =
        leaveOverviewPdfScopedIds === "all"
          ? allLeaveOverviewPdfEntitlements
          : allLeaveOverviewPdfEntitlements.filter((e) =>
              leaveOverviewPdfScopedIds.includes(e.employeeId),
            );

      // Group by employee and aggregate (VACATION entitlement only, selected by code)
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
        // Phase 97 (D-11): the annual-leave overview is the VACATION entitlement, selected by
        // code. The previous version lower-cased the display name and matched a substring of it,
        // which caught four of the nine canonical names — annual leave plus the special, unpaid
        // and further-education types, all of which end in the same German word — and summed all
        // four into a single annual-leave figure. Behaviour change, deliberate and tested.
        if (e.leaveType.code !== "VACATION") continue;
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
