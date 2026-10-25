import type { FastifyInstance, FastifyRequest } from "fastify";
import iconv from "iconv-lite";
import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import {
  requirePermission,
  permissionReach,
  accessContextFromRequest, // Phase 91b Plan 07 (#91), D-10/D-14
  resolveAccessReach, // Phase 91b Plan 07 (#91), D-10/D-14
  resolveStammsalonScopedEmployeeIds, // Phase 91b Plan 07 (#91), D-10
  resolveSalonInReach, // Issue #542 (P-04) — the one validator of a chosen salon, against the endpoint's own reach
  salonOnlyReach, // Issue #542 (OD-2) — the one constructor of a salon-only reach (the export's person narrowing)
  findSalon, // Issue #542 (OD-2) — the chosen salon's name for the export's label line
  type AccessReach,
  homeSalonsForDays, // Issue #542 (P-02) — the Stammsalon per calendar day
  isStammsalonScopeMatch, // Phase 91b Plan 07 (#91), D-10/D-14
  reportPopulationWhere, // Issue #613 (D-01) — the one period population
  employedInPeriodWhere, // Issue #613 — its employment core, which DATEV reads alone (P-01)
  isAnonymizedEmployee, // Issue #617 (T-617-08) — the heal never writes an anonymised person's entitlement
  employeeScopeFor, // Issue #617 (P-06) — the Stundennachweis day list reads one person's work entries
  holidaysAtWorkLocation, // Issue #617 (P-06) — the one holiday resolution (work location, § 2 EFZG)
  type WorkLocationEntry,
} from "../contexts/platform";
import {
  SECTION9_LEGEND,
  generateMonthlyReportPdf,
  generateMonthlyExportPdf,
  type MonthlyExportRow,
  type MonthlyReportDayRow,
} from "./pdf";
import { resolveMonthReachIds, isMonthReachMatch } from "./reach-day"; // Issue #679 — the reach day of a person in a month
import { salonViewMemberIds, SALON_VIEW_NOT_FOUND } from "./salon-view"; // Issue #542 (P-01)
import {
  getTenantTimezone,
  monthRangeUtc,
  monthDateRange, // Issue #493 (D-10)
  dateStrInTz, // Issue #617 (P-03) — the tenant-local Stichtag
  dayRangeUtc, // Issue #617 (P-03) — end of the Stichtag as the facade's `now`
  todayInTz, // Issue #542 (P-02) — tenant-local today, so a salon Ist stops at yesterday (#438)
  computeMonthReportFigures, // Issue #451 (D-03)
} from "../contexts/working-time-account"; // Phase 101B
import {
  entryDurations,
  addWorkingMinutes,
  getWorkedEntriesInRange, // Issue #617 (P-06) — the closed work entries that decide the work location of a day
} from "../contexts/time-tracking"; // Phase 79 (Issue #79) — presence/working-time kernel (D-03/D-05)
import {
  listEntitlementsForYear,
  getVacationEntitlementsForYearByCode, // Issue #617 (P-03) — the export's per-year VACATION rows
  getExpiringCarryOver,
  getEntitlementById,
  getConfirmedSection9Credits,
  selfHealUsedDays,
  loadVacationTypeMeta,
  isSickLeaveTypeCode,
  ensureRegularVacationEntitlement, // Issue #445 (D-05) — injected into selfHealUsedDays's ctx below
  REGULAR_ENTITLEMENT_REASON_SELF_HEAL, // Issue #445 (D-05)
  vacationEntitlementWarning, // Issue #445 — composition carries no business rule (CLAUDE.md); the warning string is built in the absence context
  healEntitlementUsedDays, // Issue #445 (D-10) — injected into selfHealUsedDays's ctx below
  EFFECTIVE_LEAVE_STATUSES, // Issue #446 (D-01/D-04)
  leaveDaysByCodeWithin, // Issue #451 (D-01) — the DATEV export's VACATION Lohnart line
  type LeaveDaysForCode, // Issue #451 (D-01)
  sickLeaveDayCounts, // Issue #84 (D-14) — the one sick-day / § 9 counting rule
  type SickDaysByCode, // Issue #713 (D-02) — the kernel's per-code split
  vocationalSchoolDayCount, // Issue #713 (D-05) — the Berufsschultage of the period
  DISPLAY_NAME, // Issue #617 (P-06) — display text of a day row; the identity is the code
  withHalfDayMarker, // Issue #746 — the one half-day wording, owned by the absence context
} from "../contexts/absence"; // Phase 100B Plan 10 — A12/A14/A15; Plan 11 — A22
import type { LeaveEntitlement, LeaveRequestStatus, LeaveTypeCode } from "@clokr/db";

// Issue #542 (P-04): the optional salon filter of the report views. Unknown query keys are
// stripped by zod, a malformed id answers 400 through the global handler (like the dashboard's
// team views).
const reportSalonQuerySchema = z.object({
  salonId: z.string().uuid().optional(),
});

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
  status: LeaveRequestStatus;
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
export type EmployeeWithIncludes = {
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
};

// ── Stundennachweis day rows (Issue #617, D-617-5 / P-06) ─────────────────────
// The day list of the person's § 16 Abs. 2 ArbZG record explains the days without an entry: the
// periods of the month's EFFECTIVE leave requests (the include's own status filter - never a
// PENDING request) and imposed absences, and the holidays at the work location. Pure assembly of
// rows other modules already decided: no workday rule, no counting. A row's label is the display
// text of its CODE (`DISPLAY_NAME`) - never `leaveType.name`, which a tenant can rename. It is not
// `getCalendarLeaveOverlapping` on purpose: that read is display-only and includes PENDING requests.
function buildStundennachweisDayRows(
  emp: EmployeeWithIncludes,
  firstDay: Date,
  lastDay: Date,
  tz: string,
  holidays: Map<string, string>,
): MonthlyReportDayRow[] {
  // @db.Date values are UTC-midnight instants, so the ISO date is the calendar day (Issue #493).
  const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
  const first = dayOf(firstDay);
  const last = dayOf(lastDay);
  const labelOf = (code: string | null, halfDay: boolean): string => {
    const base = (code ? DISPLAY_NAME[code as LeaveTypeCode] : undefined) ?? DISPLAY_NAME.OTHER;
    return withHalfDayMarker(base, halfDay);
  };
  const rows: MonthlyReportDayRow[] = [];
  const addPeriod = (start: Date, end: Date, label: string): void => {
    // ISO dates compare correctly as strings; the period is clipped to the month.
    const from = dayOf(start) < first ? first : dayOf(start);
    const to = dayOf(end) > last ? last : dayOf(end);
    if (from <= to) rows.push({ from, to, label });
  };
  for (const lr of emp.leaveRequests) {
    addPeriod(lr.startDate, lr.endDate, labelOf(lr.leaveType.code, lr.halfDay));
  }
  for (const a of emp.absences) {
    addPeriod(a.startDate, a.endDate, labelOf(a.type, a.halfDay));
  }
  // A holiday before the hire day or after the exit day is no day of this person.
  const hireDay = dateStrInTz(emp.hireDate, tz);
  const exitDay = emp.exitDate ? dateStrInTz(emp.exitDate, tz) : null;
  for (const [day, name] of holidays) {
    if (day < hireDay || (exitDay !== null && day > exitDay)) continue;
    rows.push({ from: day, to: day, label: `Feiertag: ${name}` });
  }
  return rows.sort(
    (a, b) =>
      a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.label.localeCompare(b.label),
  );
}

// ── computeEmployeeSummary ────────────────────────────────────────────────────
// Pure helper — single source of truth for the monthly report's sick/leave/§9 fields.
// Called by GET /monthly (JSON), GET /monthly/pdf (single-emp).
//
// Issue #451 (D-03): this function computes NO Soll/Ist/Überstunden any more — all three GET
// handlers below call `computeMonthReportFigures` (the working-time-account's own month result)
// directly for those. Issue #84 (D-14): the sick-day / § 9 day counts (calendar-day spans, not Soll
// minutes) come from the absence context's `sickLeaveDayCounts` — this function carries no
// day-counting rule of its own any more.
// Bounds are UTC-midnight calendar days (monthDateRange) because they reach @db.Date columns / date
// clipping — never a monthRangeUtc instant (Issue #493, D-01).
export function computeEmployeeSummary(
  emp: EmployeeWithIncludes,
  firstDay: Date,
  lastDay: Date,
  tz: string,
  // Issue #451 (D-02): facade-fetched input — the absence context's own priced, §9-netted
  // leave-day map for this employee's report window (leaveDaysByCodeWithin, prefetched ONCE per
  // request by the caller). No business rule lives here; this function only reads it.
  leaveDaysByCode: Map<LeaveTypeCode, LeaveDaysForCode>,
  // Phase 104 (D-30): confirmed § 9 credits overlapping the report month, bulk-fetched
  // ONCE by the caller (no per-employee query — T-104-09-N1) and pre-filtered to
  // pre-filtered to CONFIRMED-only (T-104-09-PENDING: an AU_PENDING credit changes nothing).
  section9Credits: Array<{ creditedStart: Date; creditedEnd: Date }> = [],
  // Issue #542 (P-02): under a salon filter only the days whose Stammsalon is that salon count
  // (#84 D-04/D-13). Absent for every unfiltered caller - the result is then unchanged.
  countsDay?: (day: string) => boolean,
): {
  sickDays: number;
  sickDaysByCode: SickDaysByCode;
  vocationalSchoolDays: number;
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
    netMinutes: number;
    note?: string;
  }>;
} {
  // ── Sick days and § 9 shift (Issue #84, D-14) ─────────────────────────────
  // The absence context's one counting rule (calendar days, half day, clip, attest split, § 9
  // shift). Absence rows (the AU document path) deliberately never contribute — see the kernel's
  // own docblock.
  const {
    sickDays,
    sickDaysByCode,
    sickDaysWithAttest,
    sickDaysWithoutAttest,
    section9DaysThisMonth,
  } = sickLeaveDayCounts(emp.leaveRequests, firstDay, lastDay, {
    section9Credits,
    ...(countsDay ? { countsDay } : {}),
  });

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
  // WR-02 (451-REVIEW.md): this sum has no cross-type same-day dedup (451-02-SUMMARY.md,
  // Deviation #2) — each non-sick code's own netDays is added independently. Verified
  // (reports-total-absence-days-wr02.test.ts) that this cannot double-count a day shared
  // between an APPROVED VACATION request and an overlapping APPROVED SICK request — the one
  // combination § 9 BUrlG makes "the normal case, not the exception" (sortLeaveForDedup's own
  // doc comment above): every sick code is excluded from this loop by isSickLeaveTypeCode, so a
  // SICK day never adds to the sum regardless of whether its underlying § 9 Section9Credit is
  // still AU_PENDING (VACATION's netDays not yet netted — the shared day is counted once, via
  // VACATION, full price) or CONFIRMED (VACATION's netDays already subtracts the credited day —
  // still counted once, via VACATION, at the reduced price). The ONE overlap that WOULD
  // double-count this sum — two DIFFERENT non-sick codes claiming the same calendar day — is
  // structurally unreachable through the real API: leave.ts's create-time overlap guard
  // (`blockingOverlap`, `if (!isSickRequest) return true`) rejects every non-sick request that
  // overlaps ANY existing PENDING/APPROVED request, sick or not. No cross-type dedup pass is
  // reinstated here.
  let totalAbsenceDays = 0;
  for (const [code, days] of leaveDaysByCode) {
    if (!isSickLeaveTypeCode(code)) totalAbsenceDays += days.netDays;
  }
  totalAbsenceDays = Math.round(totalAbsenceDays * 100) / 100;

  // Issue #451 (D-02): vacationDays/totalAbsenceDays are already §9-netted by leaveDaysByCode
  // (the absence context's own netDays) — no second subtraction here.

  // ── Time entries (formatted) ─────────────────────────────────────────────
  const entries = emp.timeEntries.map((e) => ({
    date: formatInTimeZone(e.date, tz, "dd.MM.yyyy"),
    start: formatInTimeZone(e.startTime, tz, "HH:mm"),
    end: e.endTime ? formatInTimeZone(e.endTime, tz, "HH:mm") : "",
    breakMin: Number(e.breakMinutes ?? 0),
    // Issue #617 (D-617-3): exact working minutes of the one shared kernel; the PDF formatter
    // rounds, nothing is rounded to hours here.
    netMinutes: e.endTime ? entryDurations(e).workingMinutes : 0,
    note: (e as Record<string, unknown>).note as string | undefined,
  }));

  return {
    sickDays,
    // Issue #713 (D-02): the kernel's split, handed on unchanged; the /monthly handler picks its
    // fields one by one, so its JSON is unchanged.
    sickDaysByCode,
    // Issue #713 (D-05): days with a Berufsschule Absence of the month; the /monthly handler does
    // not read it.
    vocationalSchoolDays: vocationalSchoolDayCount(emp.absences, firstDay, lastDay),
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

// Issue #210: same UTC walk and clipping workDaysInMonthRange() always did, now also
// exposed as day keys — internal identity only, never rendered — so the sickness /
// § 9 / non-sick set operations below all derive from the ONE day rule this export
// has always used. workDaysInMonthRange() is unchanged in behaviour, only in
// implementation (its length). Issue #617: module-level so `datevPersonFigures` can use it.
function workdayKeysInMonthRange(from: Date, to: Date, firstDay: Date, lastDay: Date): string[] {
  const s = from < firstDay ? firstDay : from;
  const e2 = to > lastDay ? lastDay : to;
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
function priceDaysFor(
  leaveDaysByEmployee: Map<string, Map<LeaveTypeCode, LeaveDaysForCode>>,
  emp: { id: string },
  code: LeaveTypeCode,
): number {
  return leaveDaysByEmployee.get(emp.id)?.get(code)?.netDays ?? 0;
}

/**
 * Issue #617 - the per-person figures of the DATEV export: the worked minutes the Normalstunden line
 * is built from and the nine absence day counts (Arbeitstage) of the Lohnart lines. It is the ONLY
 * place those numbers are derived: `buildDatevLodas` maps the result to LODAS lines and the
 * Monatsexport PDF prints the very same object, so the human-readable document cannot differ from the
 * payroll file (no second computation). Behaviour-preserving extraction of the former loop body.
 */
type DatevPersonFigures = {
  /** Sum of the person's closed, valid entries of the month (every entry type, as DATEV has always summed). */
  workedMinutes: number;
  /** Krank (Lohnart `lna.krank`): sick days incl. the § 9 union and the orphan § 9 days. */
  sickDays: number;
  sickChildDays: number;
  vacationDays: number;
  overtimeCompDays: number;
  specialDays: number;
  educationDays: number;
  unpaidDays: number;
  maternityDays: number;
  parentalDays: number;
};

function datevPersonFigures(
  emp: DatevEmployee,
  ctx: {
    firstDay: Date;
    lastDay: Date;
    section9ByEmp?: Map<string, Array<{ creditedStart: Date; creditedEnd: Date }>>;
    leaveDaysByEmployee: Map<string, Map<LeaveTypeCode, LeaveDaysForCode>>;
  },
): DatevPersonFigures {
  // Working hours
  const workedMinutes = emp.timeEntries.reduce((sum, e) => addWorkingMinutes(sum, e), 0);

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
    for (const key of workdayKeysInMonthRange(
      lr.startDate,
      lr.endDate,
      ctx.firstDay,
      ctx.lastDay,
    )) {
      nonSickClaimed.add(key);
    }
  }
  const section9Keys = new Set<string>();
  for (const c of ctx.section9ByEmp?.get(emp.id) ?? []) {
    for (const key of workdayKeysInMonthRange(
      c.creditedStart,
      c.creditedEnd,
      ctx.firstDay,
      ctx.lastDay,
    )) {
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
      for (const key of workdayKeysInMonthRange(
        lr.startDate,
        lr.endDate,
        ctx.firstDay,
        ctx.lastDay,
      )) {
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
  const vacationDaysDatev = priceDaysFor(ctx.leaveDaysByEmployee, emp, "VACATION");
  const overtimeCompDays = priceDaysFor(ctx.leaveDaysByEmployee, emp, "OVERTIME_COMP");
  const specialDays = priceDaysFor(ctx.leaveDaysByEmployee, emp, "SPECIAL");
  const educationDays = priceDaysFor(ctx.leaveDaysByEmployee, emp, "EDUCATION");
  const unpaidDays = priceDaysFor(ctx.leaveDaysByEmployee, emp, "UNPAID");
  const maternityDays = priceDaysFor(ctx.leaveDaysByEmployee, emp, "MATERNITY");
  const parentalDays = priceDaysFor(ctx.leaveDaysByEmployee, emp, "PARENTAL");

  // Issue #210: the Krank side is no longer `+ section9WorkDays` — that was only
  // correct while the base was the always-empty Absence source. sickDaysBase already
  // includes every § 9-credited day whose sickness request is readable (the union
  // above), so only the unreadable ("orphan") § 9 days are added on top.
  const sickDaysDatev = sickDaysBase + section9OrphanDays;

  return {
    workedMinutes,
    sickDays: sickDaysDatev,
    sickChildDays,
    vacationDays: vacationDaysDatev,
    overtimeCompDays,
    specialDays,
    educationDays,
    unpaidDays,
    maternityDays,
    parentalDays,
  };
}

// Issue #493 (F-04): `firstDay`/`lastDay` are UTC-midnight calendar days (monthDateRange) because the
// walk below keys days by UTC date and weekday — an instant start shifted every key of a leave that
// began before the month by one day.
function buildDatevLodas(params: {
  employees: DatevEmployee[];
  year: number;
  month: number;
  firstDay: Date;
  lastDay: Date;
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
    firstDay,
    lastDay,
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
    const lastDayOfMonth = new Date(y, m, 0).getDate();
    const datum = `${String(lastDayOfMonth).padStart(2, "0")}${String(m).padStart(2, "0")}${y}`;

    // Issue #617: the per-person numbers come from the one shared function.
    const figures = datevPersonFigures(emp, {
      firstDay,
      lastDay,
      section9ByEmp,
      leaveDaysByEmployee,
    });
    const workedHours = figures.workedMinutes / 60;
    const sickDaysDatev = figures.sickDays;
    const sickChildDays = figures.sickChildDays;
    const vacationDaysDatev = figures.vacationDays;
    const overtimeCompDays = figures.overtimeCompDays;
    const specialDays = figures.specialDays;
    const educationDays = figures.educationDays;
    const unpaidDays = figures.unpaidDays;
    const maternityDays = figures.maternityDays;
    const parentalDays = figures.parentalDays;

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
// Bounds are UTC-midnight calendar days (monthDateRange) because they reach @db.Date columns / date
// clipping — never a monthRangeUtc instant (Issue #493, D-01).
export function buildEmployeeInclude(firstDay: Date, lastDay: Date) {
  // Issue #617 (P-06): several entries per day (#70) are listed in start-time order; without the
  // second key the order of one day's rows is whatever the planner returns. A mutable array (not
  // a readonly tuple) because Prisma's orderBy type is mutable.
  const timeEntryOrder: Array<{ date: "asc" } | { startTime: "asc" }> = [
    { date: "asc" },
    { startTime: "asc" },
  ];
  return {
    workSchedules: { orderBy: { validFrom: "asc" } },
    timeEntries: {
      where: {
        deletedAt: null,
        date: { gte: firstDay, lte: lastDay },
        type: "WORK",
        endTime: { not: null },
        isInvalid: false,
      },
      orderBy: timeEntryOrder,
    },
    absences: {
      where: { deletedAt: null, startDate: { lte: lastDay }, endDate: { gte: firstDay } },
    },
    leaveRequests: {
      where: {
        deletedAt: null,
        status: { in: Array.from(EFFECTIVE_LEAVE_STATUSES) }, // Issue #446 (D-04) — Array.from (not a spread) yields a mutable array despite this function's own `as const`
        startDate: { lte: lastDay },
        endDate: { gte: firstDay },
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
// Bounds are UTC-midnight calendar days (monthDateRange) because they reach @db.Date columns / date
// clipping — never a monthRangeUtc instant (Issue #493, D-01).
export async function fetchConfirmedSection9CreditsByEmp(
  app: FastifyInstance,
  tenantId: string,
  firstDay: Date,
  lastDay: Date,
): Promise<Map<string, Array<{ creditedStart: Date; creditedEnd: Date }>>> {
  const credits = await getConfirmedSection9Credits(app.prisma, tenantId, firstDay, lastDay);
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

// ── loadDatevMonth / selectMonthlyExportPersons (Issue #617) ──────────────────
// The ONE spelling of the DATEV population and of the inputs of the per-person figures: who counts
// (`employedInPeriodWhere`, the employment core WITHOUT the anonymisation clause - § 41 EStG keeps the
// Lohnkonto of a month of employment complete - plus the Stammsalon scope of `report:export`), their
// entries and leave requests of the month, the confirmed § 9 credits and the priced leave days.
// `GET /datev` and the Monatsexport both read it, so the human-readable document names exactly the
// persons the payroll file transmits. `opts.orderBy` is passed only by the export: DATEV keeps its
// query without an `orderBy`, so the order of its lines stays byte-identical. Issue #542: `opts.reach`
// (the already resolved `report:export` reach) and `opts.onlyEmployeeIds` (the export's salon
// narrowing) are passed only by `selectMonthlyExportPersons`; `GET /datev` passes neither and is
// therefore never narrowed - the narrowing is an intersection with the real reach, never a widening.
async function loadDatevMonth(
  app: FastifyInstance,
  req: FastifyRequest,
  y: number,
  m: number,
  opts: {
    orderBy?: typeof REPORT_PERSON_ORDER;
    reach?: AccessReach;
    onlyEmployeeIds?: readonly string[];
  } = {},
) {
  const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
  const { start, end } = monthRangeUtc(y, m, tz);
  // Issue #493 (D-01/D-10): @db.Date columns (time-entry date, leave dates, § 9 credits) get
  // calendar-day bounds; the instants above stay for the Timestamptz payroll predicate
  // (Employee.hireDate/exitDate), the skipped counts and the Stichtag.
  const { firstDay, lastDay } = monthDateRange(y, m, tz);

  // Phase 91b Plan 07 (Issue #91), D-10/D-13 — narrow to Stammsalon-scoped employees BEFORE
  // building the export. Stichtag (Issue #679): the person's exit day when it lies in the month, else the
  // month's last calendar day, always a calendar day (`resolveMonthReachIds`).
  const datevAccess = accessContextFromRequest(req);
  const datevScopeReach =
    opts.reach ?? (await resolveAccessReach(app.prisma, datevAccess, "report:export:ZUGEWIESEN"));
  const datevScopedIds =
    datevScopeReach.kind === "wholeTenant"
      ? "all"
      : await resolveMonthReachIds(app.prisma, req.user.tenantId, datevScopeReach, y, m, tz);

  // Issue #542: the export's salon narrowing only ever intersects the caller's reach.
  const onlyIds = opts.onlyEmployeeIds;
  const idFilter: readonly string[] | null =
    datevScopedIds === "all"
      ? (onlyIds ?? null)
      : onlyIds === undefined
        ? datevScopedIds
        : datevScopedIds.filter((id) => onlyIds.includes(id));

  // Issue #256 (Befund 2): employed DURING the Abrechnungszeitraum, not employed today.
  // Issue #613: the one employment rule, from the Unterbau. DATEV deliberately reads the core
  // WITHOUT the anonymisation clause (§ 41 EStG: the Lohnkonto of a month of employment stays
  // complete).
  const employees = await app.prisma.employee.findMany({
    ...(opts.orderBy ? { orderBy: opts.orderBy } : {}),
    where: {
      tenantId: req.user.tenantId,
      ...employedInPeriodWhere(start, end),
      ...(idFilter !== null ? { id: { in: [...idFilter] } } : {}),
    },
    include: {
      workSchedules: { orderBy: { validFrom: "asc" } },
      timeEntries: {
        where: {
          deletedAt: null,
          date: { gte: firstDay, lte: lastDay },
          endTime: { not: null },
          isInvalid: false,
        },
      },
      leaveRequests: {
        where: {
          deletedAt: null,
          status: { in: [...EFFECTIVE_LEAVE_STATUSES] }, // Issue #446 (D-04)
          startDate: { lte: lastDay },
          endDate: { gte: firstDay },
        },
        include: { leaveType: true },
      },
    },
  });

  const section9ByEmp = await fetchConfirmedSection9CreditsByEmp(
    app,
    req.user.tenantId,
    firstDay,
    lastDay,
  );
  // Issue #451 (D-01): UTC-midnight calendar-day bounds for the facade call - NOT `start`/`end`
  // above, which are monthRangeUtc()'s tenant-tz instants (see fetchLeaveDaysByEmployeeForDatev's
  // own docblock).
  const leaveDaysByEmployee = await fetchLeaveDaysByEmployeeForDatev(
    app,
    req.user.tenantId,
    employees,
    y,
    m,
  );
  return { tz, start, end, firstDay, lastDay, employees, section9ByEmp, leaveDaysByEmployee };
}

/**
 * Issue #617 (owner addendum 17.10.2026) - the Monatsexport's ONE person selection: the DATEV
 * population in last name / first name / id order. Issue #542 (OD-2, owner decision 17.10.2026): an
 * optional chosen salon narrows WHICH persons are listed - those whose Stammsalon is the salon on the
 * person's Stichtag - and never a figure: every remaining person keeps the full row. The salon is
 * validated against the `report:export` reach before any person is read (`{ ok: false }` = the one
 * 404 of the caller); the narrowing is an intersection with that reach inside `loadDatevMonth`, so a
 * salon filter can only narrow. Stichtag (P-05): the person's exit day when it lies inside the
 * exported month, else the last calendar day of the month, always passed as a calendar day (HOME
 * validity is `@db.Date`, never compared with an instant, #493) - a salon change at the month boundary
 * keeps the person in the old salon's export, a leaver stays where it left. A person without a
 * Stammsalon on that day appears only in the unfiltered export. `GET /datev` calls `loadDatevMonth`
 * directly, without a salon, and is never narrowed.
 */
async function selectMonthlyExportPersons(
  app: FastifyInstance,
  req: FastifyRequest,
  y: number,
  m: number,
  salonId?: string,
) {
  const tenantId = req.user.tenantId;
  const reach = await resolveAccessReach(
    app.prisma,
    accessContextFromRequest(req),
    "report:export:ZUGEWIESEN",
  );
  const filter = await resolveSalonInReach(app.prisma, tenantId, reach, salonId);
  if (!filter.ok) return { ok: false as const };

  let salon: { id: string; name: string } | null = null;
  let onlyEmployeeIds: string[] | undefined;
  if (filter.salonId !== null) {
    const chosen = await findSalon(app.prisma, tenantId, filter.salonId);
    if (!chosen) return { ok: false as const };
    salon = { id: chosen.id, name: chosen.name };
    onlyEmployeeIds = await salonPersonsAtStichtag(app, tenantId, chosen.id, y, m);
  }

  const loaded = await loadDatevMonth(app, req, y, m, {
    orderBy: REPORT_PERSON_ORDER,
    reach,
    ...(onlyEmployeeIds ? { onlyEmployeeIds } : {}),
  });
  return { ok: true as const, salon, ...loaded };
}

/**
 * Issue #542 (OD-2, P-05) - the ids whose Stammsalon is `salonId` on their own Stichtag for the
 * export of month `y`/`m`: the person's tenant-local exit day when it lies inside the month, else the
 * month's last calendar day. One Stammsalon resolution (the endpoint's own scope resolver evaluated
 * for a salon-only reach, #558) per distinct Stichtag, each as a UTC-midnight calendar day.
 */
export async function salonPersonsAtStichtag(
  app: FastifyInstance,
  tenantId: string,
  salonId: string,
  y: number,
  m: number,
): Promise<string[]> {
  const tz = await getTenantTimezone(app.prisma, tenantId);
  const ids = await resolveMonthReachIds(app.prisma, tenantId, salonOnlyReach(salonId), y, m, tz);
  // A salon-only reach never resolves to "all"; the empty set is the fail-closed reading.
  return ids === "all" ? [] : ids;
}

// Issue #451 (D-02): one leaveDaysByCodeWithin call per employee with at least one leave request
// in the report month — feeds computeEmployeeSummary's required leaveDaysByCode parameter for
// the two Monatsbericht handlers (JSON, single PDF). Same UTC-midnight
// calendar-month bounds as fetchLeaveDaysByEmployeeForDatev above (not monthRangeUtc's tenant-tz
// instants), for the identical reason: leaveDaysByCodeWithin/countedLeaveDaysWithin normalise
// with utcDay(), so a tenant-tz instant would silently shift the window by one day. Sequential
// awaits (no unbounded Promise.all) — mirrors the DATEV helper's own shape. Unlike that helper,
// the skip condition here is "no leave request at all" (not "no NON-SICK leave request"):
// computeEmployeeSummary also needs to tell a genuinely leave-free employee (empty map, every
// per-type count 0) from one whose only requests are sick leave — an employee with only SICK
// leave still gets a Map (populated with the SICK code, which computeEmployeeSummary simply
// never reads a non-sick count from).
export async function fetchLeaveDaysByCodeForMonthlyReport(
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

// Issue #613 — the report year as tenant-local INSTANTS (1 January 00:00 to 31 December 23:59:59.999
// in the tenant time zone), the bounds `reportPopulationWhere` expects. Deliberately named
// `population*` at the call sites: the UTC-naive `yearStart`/`yearEnd` of the PDF handlers bound
// `@db.Date` leave columns and are a different thing (CLAUDE.md #493).
export async function yearPopulationPeriod(
  app: FastifyInstance,
  tenantId: string,
  year: number,
): Promise<{ start: Date; end: Date }> {
  const tz = await getTenantTimezone(app.prisma, tenantId);
  return { start: monthRangeUtc(year, 1, tz).start, end: monthRangeUtc(year, 12, tz).end };
}

// Issue #613 (AC-3) — the one order of every person list in a leave or vacation document: last name,
// first name, id (the id makes two identical names deterministic).
const REPORT_PERSON_ORDER = [
  { lastName: "asc" as const },
  { firstName: "asc" as const },
  { id: "asc" as const },
];

// ── vacationYearFigures (Issue #617) ──────────────────────────────────────────
// The ONE assembly of the Resturlaub figures of a set of VACATION entitlement rows, shared by
// `GET /leave-overview` (request time, default split day = yesterday) and the Monatsexport (its
// Stichtag). It heals `usedDays` first - the same audited self-heal the overview has always run, so
// `usedDays = genommen + genehmigt` holds - but never for an anonymised person (Issue #613: reading a
// report must not write that person's entitlement; the export lists such a person for months of
// employment). For such a row the facade still gets a stored `usedDays` consistent with its own
// split, so Resturlaub = Verfuegbar - Genommen - Genehmigt holds on the printed row too. Assembly
// only: every figure comes from `app.vacationBalanceForRow`, this layer carries no rule.
export type VacationYearRow = LeaveEntitlement & {
  leaveType: { id: string; code: LeaveTypeCode | null };
  employee: { firstName: string; lastName: string };
  needsReview?: boolean;
};

export async function vacationYearFigures(
  app: FastifyInstance,
  tenantId: string,
  rows: VacationYearRow[],
  now: Date,
  asOf?: string,
) {
  // healZeroPlaceholder (Issue #445, D-05) and healUsedDays (Issue #445, D-10) are injected rather
  // than imported statically by leave-self-heal.ts itself - see that file's module docblock.
  const vacMeta = {
    ...(await loadVacationTypeMeta(app.prisma, tenantId)),
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
  const healable = rows.filter((e) => !isAnonymizedEmployee(e.employee));
  await selfHealUsedDays(app.prisma, healable, vacMeta);

  // Issue #451 (D-07) - ONE bulk AuditLog query for the Hinweis flag, no N+1 inside the loop below.
  const warnedIds = new Set(
    (
      await app.prisma.auditLog.findMany({
        where: {
          action: "CARRYOVER_WARNED",
          entity: "LeaveEntitlement",
          entityId: { in: rows.map((e) => e.id) },
        },
        select: { entityId: true },
        distinct: ["entityId"],
      })
    ).map((al) => al.entityId!),
  );

  const byEntitlement = new Map<string, Awaited<ReturnType<typeof app.vacationBalanceForRow>>>();
  const healableIds = new Set(healable.map((e) => e.id));
  for (const e of rows) {
    const opts = { hinweisIssued: warnedIds.has(e.id), ...(asOf ? { asOf } : {}) };
    let balance = await app.vacationBalanceForRow(e, tenantId, now, opts);
    if (!healableIds.has(e.id)) {
      // Not healed (anonymised): align the stored figure the facade subtracts with its own split.
      const aligned = Math.round((balance.takenDays + balance.approvedUpcomingDays) * 100) / 100;
      balance = await app.vacationBalanceForRow(
        { ...e, usedDays: aligned as unknown as typeof e.usedDays },
        tenantId,
        now,
        opts,
      );
    }
    byEntitlement.set(e.id, balance);
  }
  return byEntitlement;
}

/** Every calendar day (`YYYY-MM-DD`) from `first` to `last`, both UTC-midnight dates. */
export function calendarDaysBetween(first: Date, last: Date): string[] {
  const days: string[] = [];
  for (let t = first.getTime(); t <= last.getTime(); t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** `YYYY-MM-DD` of the day before `day` (calendar arithmetic on the string). */
export function dayBeforeStr(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

export async function reportRoutes(app: FastifyInstance) {
  // GET /api/v1/reports/monthly?employeeId=&year=&month=&salonId=
  app.get("/monthly", {
    schema: {
      tags: ["Reporting"],
      security: [{ bearerAuth: [] }],
      description:
        "Monthly report per person. The optional salonId (Issue #542) narrows the list to the persons who recorded time in that salon or are homed there on at least one day of the month; working time then counts the salon's entries only and sick days follow the Stammsalon per day, while Soll, saldo and the priced leave counts are withheld (null) with a reason.",
    },
    preHandler: requirePermission("report:read:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { employeeId, year, month } = req.query as {
        employeeId?: string;
        year: string;
        month: string;
      };
      // Issue #542 (P-04): parsed first - a malformed id answers 400 before anything is read.
      const { salonId } = reportSalonQuerySchema.parse(req.query);

      const y = parseInt(year);
      const m = parseInt(month);
      if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
        return reply.code(400).send({ error: "Ungültige Jahr- oder Monatsangabe" });
      }
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const { start, end } = monthRangeUtc(y, m, tz);
      // Issue #493 (D-10): @db.Date columns and the day clip take calendar-day bounds; the
      // instant `end` above stays for the Stichtag lookup only.
      const { firstDay, lastDay } = monthDateRange(y, m, tz);

      // Phase 91b Plan 07 (Issue #91), D-10/D-13 — narrow to Stammsalon-scoped employees BEFORE
      // building the report body. Stichtag (Issue #679): the person's exit day when it lies in the
      // month, else the month's last calendar day (`resolveMonthReachIds`). This is the template every other list route in this file follows.
      const access = accessContextFromRequest(req);
      const scopeReach = await resolveAccessReach(app.prisma, access, "report:read:ZUGEWIESEN");

      // Issue #542 (CTX-1, P-04): the chosen salon is validated against the reach of THIS
      // endpoint's permission BEFORE any person or figure is read; every rejection is the one
      // 404 body (#85 D-13). The filter is presentation: it only intersects the reach below.
      const salonFilter = await resolveSalonInReach(
        app.prisma,
        req.user.tenantId,
        scopeReach,
        salonId,
      );
      if (!salonFilter.ok) return reply.code(404).send(SALON_VIEW_NOT_FOUND);
      const filterSalonId = salonFilter.salonId;

      const scopedEmployeeIds =
        scopeReach.kind === "wholeTenant"
          ? "all"
          : await resolveMonthReachIds(app.prisma, req.user.tenantId, scopeReach, y, m, tz);

      // Alle Mitarbeiter des Tenants (oder nur einen)
      const populationEmployees = (await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          // Issue #613 (D-01): the period population (employed in the month, never anonymised)
          // replaces "employed today with an active login". The login state never decides.
          // All constraints combine in ONE AND array, also when a manager supplies an explicit
          // employeeId (same idiom as leave.ts's GET /requests, Plan 91b-04 Task 1): an
          // out-of-scope named employeeId must yield zero rows, not bypass the scope filter.
          AND: [
            reportPopulationWhere(start, end),
            ...(employeeId ? [{ id: employeeId }] : []),
            ...(scopedEmployeeIds !== "all" ? [{ id: { in: scopedEmployeeIds } }] : []),
          ],
        },
        include: buildEmployeeInclude(firstDay, lastDay),
        orderBy: { lastName: "asc" },
      })) as unknown as EmployeeWithIncludes[];

      // Issue #542 (P-01, P-02, P-10): under a filter the population above (period population,
      // Stammsalon scope at month end, optional employeeId) is intersected with the one membership
      // rule - an entry in the salon this month OR the Stammsalon on at least one calendar day of
      // it. The filter can only narrow. `homeByPerson` doubles as the per-day attribution of the
      // sick days below (#84 D-04/D-13).
      let employees = populationEmployees;
      let homeByPerson: Map<string, Map<string, string | null>> | null = null;
      if (filterSalonId !== null) {
        const monthDays = calendarDaysBetween(firstDay, lastDay);
        homeByPerson = await homeSalonsForDays(
          app.prisma,
          req.user.tenantId,
          populationEmployees.map((e) => e.id),
          monthDays[0],
          monthDays[monthDays.length - 1],
        );
        const members = salonViewMemberIds({
          salonId: filterSalonId,
          candidateIds: populationEmployees.map((e) => e.id),
          entries: populationEmployees.flatMap((e) =>
            e.timeEntries.map((t) => ({ employeeId: e.id, salonId: t.salonId })),
          ),
          homeByPerson,
          days: monthDays,
        });
        employees = populationEmployees.filter((e) => members.has(e.id));
      }

      // Phase 104 (D-30): bulk-fetched once, keyed by employeeId — see the function's
      // own doc block above for the tenant/status/N1 rationale.
      const section9ByEmp = await fetchConfirmedSection9CreditsByEmp(
        app,
        req.user.tenantId,
        firstDay,
        lastDay,
      );

      // Issue #451 (D-02): the absence context's own priced leave-day map, one
      // leaveDaysByCodeWithin call per employee with at least one leave request this month —
      // see the helper's own doc block for the UTC-midnight bounds rationale.
      // Issue #542 (D-542-1): not fetched under a filter - the priced counts follow a
      // chronological prefix rule per period and are withheld (a per-day variant would be a second
      // counting rule, #451).
      const leaveDaysByCodeByEmp =
        filterSalonId === null
          ? await fetchLeaveDaysByCodeForMonthlyReport(app, req.user.tenantId, employees, y, m)
          : new Map<string, Map<LeaveTypeCode, LeaveDaysForCode>>();

      // Issue #542 (P-02): tenant-local yesterday as a calendar-day date - today never counts (#438).
      const yesterday = new Date(todayInTz(tz).getTime() - 86_400_000);

      // Issue #451 (D-03): one Soll/Ist/Überstunden result per employee, sequentially — the
      // working-time-account's own month result (snapshot / fullMonth / to-date header), never a
      // composition-layer Soll. See computeMonthReportFigures's own doc block for the basis rules.
      // Issue #542 (P-03): the figures that are contract figures of the person are `null` under a
      // salon filter; the row keys stay the same.
      const rows: Array<{
        employeeId: string;
        employeeName: string;
        employeeNumber: string;
        workedHours: number;
        shouldHours: number | null;
        overtimeHours: number | null;
        overtimeConfirmed: boolean | null;
        balanceAdjustmentHours: number | null;
        sickDays: number;
        sickDaysWithAttest: number;
        sickDaysWithoutAttest: number;
        vacationDays: number | null;
        overtimeCompDays: number | null;
        specialLeaveDays: number | null;
        educationDays: number | null;
        unpaidDays: number | null;
        maternityDays: number | null;
        parentalDays: number | null;
        totalAbsenceDays: number | null;
        section9DaysThisMonth: number;
      }> = [];
      for (const emp of employees) {
        const personHome = homeByPerson?.get(emp.id);
        const summary = computeEmployeeSummary(
          emp,
          firstDay,
          lastDay,
          tz,
          leaveDaysByCodeByEmp.get(emp.id) ?? new Map(),
          section9ByEmp.get(emp.id) ?? [],
          filterSalonId === null ? undefined : (day) => personHome?.get(day) === filterSalonId,
        );
        if (filterSalonId !== null) {
          // Issue #542 (P-02): Ist = the closed, valid WORK entries recorded in this salon through
          // tenant-local yesterday (a travel row counts for its departure salon, #92); the
          // Berufsschule credit belongs to no salon. Soll, saldo and the priced leave counts are
          // contract figures of the person and are withheld (#84).
          const salonMinutes = emp.timeEntries
            .filter((t) => t.salonId === filterSalonId && t.date <= yesterday)
            .reduce((sum, t) => addWorkingMinutes(sum, t), 0);
          rows.push({
            employeeId: emp.id,
            employeeName: `${emp.firstName} ${emp.lastName}`,
            employeeNumber: emp.employeeNumber,
            workedHours: Math.round((salonMinutes / 60) * 100) / 100,
            shouldHours: null,
            overtimeHours: null,
            overtimeConfirmed: null,
            balanceAdjustmentHours: null,
            sickDays: summary.sickDays,
            sickDaysWithAttest: summary.sickDaysWithAttest,
            sickDaysWithoutAttest: summary.sickDaysWithoutAttest,
            vacationDays: null,
            overtimeCompDays: null,
            specialLeaveDays: null,
            educationDays: null,
            unpaidDays: null,
            maternityDays: null,
            parentalDays: null,
            totalAbsenceDays: null,
            section9DaysThisMonth: summary.section9DaysThisMonth,
          });
          continue;
        }
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

      return {
        month: parseInt(month),
        year: y,
        rows,
        ...(section9Note ? { section9Note } : {}),
        // Issue #542 (P-03): additive keys, ONLY under a filter - the unfiltered shape is frozen.
        ...(filterSalonId !== null
          ? {
              salonId: filterSalonId,
              workedBasis: "SALON_ENTRIES" as const,
              sollUnavailableReason: "SALON_FILTER" as const,
              leaveDaysUnavailableReason: "SALON_FILTER" as const,
            }
          : {}),
      };
    },
  });

  // GET /api/v1/reports/leave-overview?year=
  app.get("/leave-overview", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("report:read:ZUGEWIESEN"),
    handler: async (req) => {
      const now = new Date();
      const { year } = req.query as { year: string };
      const y = parseInt(year ?? now.getFullYear().toString());

      // Issue #613 — the year's persons come from the shared population rule (exited during the
      // year: listed; left before it or anonymised: not; a deactivated login does not matter).
      const populationPeriod = await yearPopulationPeriod(app, req.user.tenantId, y);
      const allEntitlements = await listEntitlementsForYear(
        app.prisma,
        req.user.tenantId,
        y,
        populationPeriod,
      );

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
              new Date(`${y}-12-31T00:00:00Z`), // Issue #679: the calendar day, not an instant
            );
      // Issue #617 (D-617-1, T-617-06) - the Urlaubsuebersicht names only Urlaub: an allow-list BY
      // CODE (never by name, never a deny-list), so no other entitlement type - sick-related or not -
      // can appear in a report:read answer.
      const entitlements = (
        leaveOverviewScopedIds === "all"
          ? allEntitlements
          : allEntitlements.filter((e) => leaveOverviewScopedIds.includes(e.employeeId))
      ).filter((e) => e.leaveType.code === "VACATION");

      // Self-heal usedDays from the counted VACATION days BEFORE we shape the response, then read the
      // Resturlaub facade (Issue #451 D-07) - both inside the one shared helper (Issue #617).
      // Issue #613 - `entitlements` holds population rows only, so viewing the report never
      // writes the entitlement of an anonymised or long-departed person.
      // Mirrors the heal that GET /entitlements/:employeeId has done since v1.4.
      // Fixes the report-vs-leave-page divergence (a-tenant incident 2026-05-27).
      const balances = await vacationYearFigures(app, req.user.tenantId, entitlements, now);

      const realRows = [];
      for (const e of entitlements) {
        const balance = balances.get(e.id)!;
        realRows.push({
          employee: e.employee,
          leaveType: e.leaveType,
          year: e.year,
          totalDays: Number(e.totalDays),
          carriedOverDays: Number(e.carriedOverDays),
          usedDays: Number(e.usedDays),
          remainingDays: balance.remainingDays,
          pendingDays: balance.pendingDays,
          carriedOverEffectiveDays: balance.carriedOverEffectiveDays,
          carriedOverExpiredDays: balance.carriedOverExpiredDays,
          exitReductionDays: balance.exitReductionDays,
          atRiskDays: balance.atRiskDays,
          // Issue #617 (D-617-2) - per-person yearly day counts from the facade, no day list.
          availableDays: balance.availableDays,
          takenDays: balance.takenDays,
          approvedUpcomingDays: balance.approvedUpcomingDays,
          missingEntitlement: false as const,
          // Issue #445 (coordinator deviation from CONTEXT D-05) - the heal sets needsReview on a
          // VACATION row whose zero placeholder was left unhealed because it was ambiguous (see
          // isAmbiguousRegularEntitlement in contexts/absence/leave-days.ts). The flag AND the
          // warning string are both computed in the absence context - this composition layer
          // carries no business rule (CLAUDE.md, ADR 0002 Entscheidung 9).
          entitlementWarning: vacationEntitlementWarning({
            leaveTypeCode: e.leaveType.code,
            year: e.year,
            needsReview: (e as { needsReview?: boolean }).needsReview,
          }),
        });
      }

      // Issue #416 (AC-3/AC-4): active tenant employees (same Stammsalon scope as the
      // entitlements query above) with NO VACATION-coded entitlement row for `y` are surfaced as
      // placeholder rows — this is the overview's own contribution to visibility, it must
      // NOT call ensureVacationEntitlementForYear here (display only, never create — otherwise
      // the gap this AC requires visible would already be gone by the time it's rendered).
      // Issue #613 — the Monatsexport shows the same placeholder note for a person without a
      // VACATION row, from the same population.
      const vacationEmployeeIds = new Set(
        entitlements.filter((e) => e.leaveType.code === "VACATION").map((e) => e.employeeId),
      );
      // Issue #613 — "active" means the year's population (shared rule), not `exitDate: null`.
      const activeEmployees = await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          AND: [reportPopulationWhere(populationPeriod.start, populationPeriod.end)],
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
          availableDays: null,
          takenDays: null,
          approvedUpcomingDays: null,
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
              todayInTz(await getTenantTimezone(app.prisma, req.user.tenantId)), // Issue #679
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

      // Issue #451 (D-07/D-08) — the ONE Resturlaub facade's FIFO-adjusted atRiskDays, not the
      // raw carriedOverDays (a fully-consumed carry is no longer "gefährdet"). `lastWarningMap`
      // above already carries the Hinweis flag per entitlement — no second AuditLog query.
      const rowsWithRisk = [];
      for (const e of entitlements) {
        const deadline = e.carryOverDeadline as Date;
        const daysUntilDeadline = Math.ceil(
          (deadline.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
        );
        const balance = await app.vacationBalanceForRow(e, req.user.tenantId, now, {
          hinweisIssued: lastWarningMap.has(e.id),
        });
        if (balance.atRiskDays <= 0) continue; // already fully consumed via FIFO — not at risk
        rowsWithRisk.push({
          entitlementId: e.id,
          employee: e.employee,
          leaveType: e.leaveType,
          year: e.year,
          carriedOverDays: Number(e.carriedOverDays),
          atRiskDays: balance.atRiskDays,
          deadline: deadline.toISOString(),
          daysUntilDeadline,
          lastWarningSentAt: lastWarningMap.get(e.id)?.toISOString() ?? null,
        });
      }
      const rows = rowsWithRisk.sort((a, b) => a.daysUntilDeadline - b.daysUntilDeadline);

      const totalDaysAtRisk = rows.reduce((sum, r) => sum + r.atRiskDays, 0);

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
            todayInTz(await getTenantTimezone(app.prisma, req.user.tenantId)), // Issue #679
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
      // Issue #617: the population, its figures' inputs and the § 9 / leave-day prefetch come from the
      // ONE loader the Monatsexport reads too, so the two documents cannot select different persons.
      const {
        start,
        end,
        firstDay,
        lastDay,
        employees,
        section9ByEmp: section9ByEmpDatev,
        leaveDaysByEmployee: leaveDaysByEmployeeDatev,
      } = await loadDatevMonth(app, req, y, m);

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

      const buf = buildDatevLodas({
        employees,
        year: y,
        month: m,
        firstDay,
        lastDay,
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
      // Issue #493 (D-01/D-10): @db.Date columns get calendar-day bounds; the instants above stay
      // for the Timestamptz payroll predicate and the Stichtag.
      const { firstDay, lastDay } = monthDateRange(y, m, tz);

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
          // Issue #613: it lives in the Unterbau (employment core, no anonymisation clause, § 41 EStG).
          ...employedInPeriodWhere(start, end),
        },
        include: {
          timeEntries: {
            where: {
              deletedAt: null,
              date: { gte: firstDay, lte: lastDay },
              endTime: { not: null },
              isInvalid: false,
            },
          },
          leaveRequests: {
            where: {
              deletedAt: null,
              status: { in: [...EFFECTIVE_LEAVE_STATUSES] }, // Issue #446 (D-04)
              startDate: { lte: lastDay },
              endDate: { gte: firstDay },
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
      // boolean scope check. Stichtag (Issue #679): exit day inside the month, else its last day.
      {
        const datevEmpAccess = accessContextFromRequest(req);
        const datevEmpScopeReach = await resolveAccessReach(
          app.prisma,
          datevEmpAccess,
          "report:export:ZUGEWIESEN",
        );
        if (
          !(await isMonthReachMatch(
            app.prisma,
            req.user.tenantId,
            datevEmpScopeReach,
            employeeId,
            y,
            m,
            tz,
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
        firstDay,
        lastDay,
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
        firstDay,
        lastDay,
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

  // GET /api/v1/reports/monthly-export/pdf?year=&month=&salonId=  - Monatsexport (Issue #617, #542)
  // The human-readable twin of the DATEV export: one row per person of the DATEV population, no day
  // rows (the § 16 Abs. 2 ArbZG records stay in the Stundennachweis). Issue #542 (OD-2): an optional
  // `salonId` narrows WHICH persons are listed (Stammsalon on the person's Stichtag, see
  // `selectMonthlyExportPersons`), never a figure, and the document says so; DATEV is never narrowed.
  // Every figure is READ, never computed here: time figures from `computeMonthReportFigures` (#451
  // D-03), absence counts from `datevPersonFigures` (the function that also builds the DATEV lines).
  // Purpose and audience are those of the DATEV file - payroll preparation, `report:export` - which
  // is what makes the health-related day counts lawful here (Art. 9 Abs. 2 lit. b DSGVO).
  app.get("/monthly-export/pdf", {
    schema: {
      tags: ["Reporting"],
      security: [{ bearerAuth: [] }],
      description:
        "Monatsexport PDF. The optional salonId (Issue #542) narrows the export to the persons whose Stammsalon is that salon on the person's Stichtag (exit day inside the month, else the last day of the month); every listed row is the person's whole row. A salon outside the caller's report:export reach answers 404.",
    },
    preHandler: requirePermission("report:export:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { year, month } = req.query as { year: string; month: string };
      const y = parseInt(year);
      const m = parseInt(month);
      if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
        return reply.code(400).send({ error: "Ungültige Jahr- oder Monatsangabe" });
      }
      const { salonId } = reportSalonQuerySchema.parse(req.query);

      const selection = await selectMonthlyExportPersons(app, req, y, m, salonId);
      if (!selection.ok) return reply.code(404).send(SALON_VIEW_NOT_FOUND);
      const { tz, firstDay, lastDay, employees, section9ByEmp, leaveDaysByEmployee, salon } =
        selection;
      const tenant = await app.prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { name: true },
      });

      // Issue #617 (P-03, orchestrator decision 17.10.2026) - the section "Urlaubsjahr" describes a
      // Stichtag so a re-export of the month prints the same figures: the last day of the exported
      // month, or the tenant-local yesterday if that is earlier (running month). Statuses are
      // today's - no status history is reconstructed (stated in the ADR Nachtrag).
      const lastDayOfMonth = lastDay.toISOString().slice(0, 10);
      const yesterday = dayBeforeStr(dateStrInTz(new Date(), tz));
      const stichtag = lastDayOfMonth < yesterday ? lastDayOfMonth : yesterday;
      const exportedIds = new Set(employees.map((e) => e.id));
      const vacationRows = (
        await getVacationEntitlementsForYearByCode(app.prisma, req.user.tenantId, y)
      )
        .filter((e) => exportedIds.has(e.employeeId))
        .map((e) => {
          const emp = employees.find((p) => p.id === e.employeeId)!;
          return {
            ...e,
            leaveType: { id: e.leaveTypeId, code: "VACATION" as const },
            employee: { firstName: emp.firstName, lastName: emp.lastName },
          };
        });
      const vacationBalances = await vacationYearFigures(
        app,
        req.user.tenantId,
        vacationRows,
        dayRangeUtc(stichtag, tz).end,
        stichtag,
      );
      const vacationRowByEmployee = new Map(vacationRows.map((r) => [r.employeeId, r]));

      const rows: MonthlyExportRow[] = [];
      // Sequential, never Promise.all: one account computation per person.
      for (const emp of employees) {
        const figures = await computeMonthReportFigures(app, emp.id, y, m);
        const datev = datevPersonFigures(emp, {
          firstDay,
          lastDay,
          section9ByEmp,
          leaveDaysByEmployee,
        });
        rows.push({
          employeeName: `${emp.lastName}, ${emp.firstName}`,
          employeeNumber: emp.employeeNumber,
          status: !figures.labelled ? "UNLABELLED" : figures.confirmed ? "CONFIRMED" : "FORECAST",
          workedMinutes: figures.workedMinutes,
          expectedMinutes: figures.expectedMinutes,
          balanceMinutes: figures.balanceMinutes,
          balanceAdjustmentMinutes: figures.balanceAdjustmentMinutes,
          closingBalanceMinutes: figures.closingBalanceMinutes,
          datevWorkedMinutes: datev.workedMinutes,
          absenceDays: {
            vacation: datev.vacationDays,
            sick: datev.sickDays,
            sickChild: datev.sickChildDays,
            overtimeComp: datev.overtimeCompDays,
            special: datev.specialDays,
            education: datev.educationDays,
            unpaid: datev.unpaidDays,
            maternity: datev.maternityDays,
            parental: datev.parentalDays,
          },
          section9: (section9ByEmp.get(emp.id)?.length ?? 0) > 0,
          vacation: (() => {
            const entitlement = vacationRowByEmployee.get(emp.id);
            const balance = entitlement ? vacationBalances.get(entitlement.id) : undefined;
            if (!balance) return null;
            return {
              entitlementDays: balance.entitlementDays,
              carriedOverEffectiveDays: balance.carriedOverEffectiveDays,
              availableDays: balance.availableDays,
              takenDays: balance.takenDays,
              approvedUpcomingDays: balance.approvedUpcomingDays,
              pendingDays: balance.pendingCreatedByAsOfDays,
              remainingDays: balance.remainingDays,
            };
          })(),
        });
      }

      const [stichtagYear, stichtagMonth, stichtagDay] = stichtag.split("-");
      const pdfBuffer = await generateMonthlyExportPdf({
        tenantName: tenant?.name ?? "",
        monthLabel: `${MONTH_NAMES[m - 1]} ${y}`,
        year: y,
        month: m,
        generatedAt: formatInTimeZone(new Date(), tz, "dd.MM.yyyy, HH:mm"),
        vacationYear: { year: y, asOf: `${stichtagDay}.${stichtagMonth}.${stichtagYear}` },
        rows,
        ...(salon ? { salonScope: { salonName: salon.name } } : {}),
      });

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: {
          type: "MONTHLY_EXPORT_PDF",
          year: y,
          month: m,
          employeesIncluded: rows.length,
          // Issue #542 (P-07): the salon id (never a name) only under a filter.
          ...(salon ? { salonId: salon.id } : {}),
        },
      });

      reply.header("Content-Type", "application/pdf");
      reply.header(
        "Content-Disposition",
        `attachment; filename="monatsexport-${y}-${String(m).padStart(2, "0")}.pdf"`,
      );
      return reply.send(pdfBuffer);
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
      // Issue #493 (D-10): @db.Date columns and the day clip take calendar-day bounds; the
      // instant `end` above stays for the Stichtag lookup only.
      const { firstDay, lastDay } = monthDateRange(y, m, tz);

      const tenant = await app.prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { name: true },
      });

      const emp = (await app.prisma.employee.findFirst({
        where: {
          id: employeeId,
          tenantId: req.user.tenantId,
          // Issue #613 (P-05): the single Stundennachweis follows the same population as the
          // monthly report JSON; outside it the answer below cannot be told apart from an unknown id.
          AND: [reportPopulationWhere(start, end)],
        },
        include: buildEmployeeInclude(firstDay, lastDay),
      })) as unknown as EmployeeWithIncludes | null;

      if (!emp) {
        reply.code(404);
        return { error: "Mitarbeiter nicht gefunden" };
      }

      // Phase 91b Plan 07 (Issue #91), D-10/D-14 — a ZUGEWIESEN reach may still be scoped to
      // salons/persons (Plan 91b-01's D-05 gate change). Only runs for the "someone else" branch
      // — the EIGENE self-download path above is untouched. Stichtag = the report period's own
      // last day, or the exit day when it lies inside the month (Issue #679). Runs BEFORE the holiday computation below, so an out-of-scope employee's
      // data is never touched at all.
      if (reach === "ZUGEWIESEN" && req.user.employeeId !== employeeId) {
        const monthlyPdfAccess = accessContextFromRequest(req);
        const monthlyPdfScopeReach = await resolveAccessReach(
          app.prisma,
          monthlyPdfAccess,
          "report:export:ZUGEWIESEN",
        );
        if (
          !(await isMonthReachMatch(
            app.prisma,
            req.user.tenantId,
            monthlyPdfScopeReach,
            employeeId,
            y,
            m,
            tz,
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
        firstDay,
        lastDay,
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
        firstDay,
        lastDay,
        tz,
        leaveDaysByCodePdf.get(emp.id) ?? new Map(),
        section9ByEmpPdf.get(emp.id) ?? [],
      );
      // Issue #451 (D-03): the legal Stundennachweis prints the SAME working-time-account result
      // as the JSON Monatsbericht — never a composition-layer Soll. `overtimeConfirmed` is null
      // (not a boolean) when unlabelled, so the PDF renderer can omit the Bestätigt/Prognose label
      // entirely instead of mislabelling it (SALDO-DISP-05).
      const figures = await computeMonthReportFigures(app, emp.id, y, m);
      // Issue #617 (D-617-5, P-06): the day rows - absence periods and the holidays at the work
      // location of each day, fed with the closed work entries of the month the way the dashboard
      // feeds the same resolver. Shown to the person themself and to every export holder alike.
      const monthWorkEntries = await getWorkedEntriesInRange(
        app.prisma,
        employeeScopeFor(accessContextFromRequest(req), { employeeId: emp.id }),
        firstDay,
        lastDay,
      );
      const workLocationEntries: WorkLocationEntry[] = monthWorkEntries.map((e) => ({
        employeeId: e.employeeId,
        date: e.date,
        startTime: e.startTime,
        salonId: e.salonId,
      }));
      const holidaysByEmployee = await holidaysAtWorkLocation(
        app.prisma,
        req.user.tenantId,
        [emp.id],
        firstDay.toISOString().slice(0, 10),
        lastDay.toISOString().slice(0, 10),
        workLocationEntries,
      );
      const dayRows = buildStundennachweisDayRows(
        emp,
        firstDay,
        lastDay,
        tz,
        holidaysByEmployee.get(emp.id) ?? new Map<string, string>(),
      );

      const pdfBuffer = await generateMonthlyReportPdf({
        tenantName: tenant?.name ?? "",
        employeeName: `${emp.firstName} ${emp.lastName}`,
        employeeNumber: emp.employeeNumber,
        month: `${MONTH_NAMES[m - 1]} ${y}`,
        generatedAt: formatInTimeZone(new Date(), tz, "dd.MM.yyyy, HH:mm"),
        // Issue #617 (D-617-3): minutes straight from the account's month figures; the renderer
        // formats them. Issue #451 (D-03): the reconciliation item is 0 when the row is unlabelled.
        workedMinutes: figures.workedMinutes,
        targetMinutes: figures.expectedMinutes,
        overtimeMinutes: figures.balanceMinutes,
        overtimeConfirmed: figures.labelled ? figures.confirmed : null,
        balanceAdjustmentMinutes: figures.labelled ? figures.balanceAdjustmentMinutes : 0,
        sickDays: summary.sickDays,
        sickDaysWithAttest: summary.sickDaysWithAttest,
        vacationDays: summary.vacationDays,
        otherAbsenceDays: summary.totalAbsenceDays - summary.vacationDays,
        // D-30: drives the § 9 legend in the PDF. Same source as the JSON report's section9Note.
        section9Days: summary.section9DaysThisMonth,
        entries: summary.entries,
        dayRows,
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
}
