import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../contexts/platform";
import {
  holidaysAtWorkLocation,
  accessContextFromRequest,
  employeeScopeFor,
  reportPopulationWhere, // Issue #613 — the one period-population rule
  isEmployedInPeriod, // Issue #613 — the one period-population rule (in-memory twin)
  type WorkLocationEntry,
  type HolidaysByEmployee,
  hasPermission,
  resolveAccessReach, // Phase 91b Plan 06 (#91), D-09/D-10/D-13
  resolveStammsalonScopedEmployeeIds, // Phase 91b Plan 06 (#91), D-10/D-13
  resolveSalonInReach, // Issue #84 (D-16), Issue #85 (D-13) — salon filter validation
  homeSalonsForDays, // Issue #84 (D-13) — batched Stammsalon per day
  scopedTimeEntryIds, // Issue #85 (D-04) — the one per-entry scope resolver
  isShiftInScope, // Issue #548 — Phase 91b D-11, the one per-shift scope predicate
} from "../contexts/platform";
import { getShiftsInRange } from "../contexts/scheduling"; // Phase 100B Plan 05 — S1
import {
  distinctEmployeeIds,
  fullyCoveredPersons,
  outOfScopeValidCounts,
  personDayKey,
  presenceEntriesWithStandIns,
} from "./team-entry-scope"; // Issue #85 (D-04/D-05)
import {
  getWorkedEntriesInRange,
  getRecordedWorkEntriesInRange,
  getRecordedWorkEntriesByIds, // Issue #85 (D-04) — the in-scope rows by id
  getInvalidEntries,
  getEffectiveSchedule,
  resolvePresenceState,
  isObligatedWorkday,
  isDayDue,
  findUnconfirmedBreakDays, // Phase 126 — canonical unconfirmed-Pflichtpause detector (BREAK-05)
  entryDurations, // Phase 79 (Issue #79), D-03/D-05 — presence/working-time kernel
  addWorkingMinutes, // Phase 79 (Issue #79), D-12 — fold step
  type PresenceEntry,
  type PresenceLeave,
  type PresenceAbsence,
} from "../contexts/time-tracking"; // Phase 100B Plan 08 — T2/getRecordedWorkEntriesInRange/T4
import {
  getOvertimeAccount,
  listOvertimeAccountsForTenant,
  getBalances,
  getMonthlySnapshotsInRange,
  sumCarryOverByMonth,
  snapshotMonthOf, // Issue #595 (D-03) — the one place a stored snapshot gets a calendar month
  selectMonthlySnapshotPerMonth, // Issue #595 (P-01) — one record per month, the one the account reads
  getTenantTimezone,
  todayInTz,
  dateStrInTz,
  weekRangeUtc,
  monthRangeUtc,
  dayRangeUtc, // Issue #613 — tenant-local day as UTC instants
  monthDayBounds,
  weekDateRange, // Issue #493 (D-10)
  monthDateRange, // Issue #493 (D-10)
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
  timeStrInTz,
  getConfirmedCarryOver,
  getConfirmedCarryOverBulk,
  finalSaldoOpen, // Issue #613 (AC-613-5) — is an exited person's exit month still open
  findMissingWorkdays,
  resolveMissingEntriesDays,
  computeOvertimeBalanceBreakdown,
  monthlyHoursMonthSollMinutes, // Issue #433 (D-11)
  computeMonthReportFigures, // Issue #451 (D-03), Issue #84 (D-07) — the one Soll/Ist source
  computeWeekProgress, // Issue #451 (D-06) — whole-week Soll + to-date pair from the saldo core
  type OvertimeBalanceBreakdown,
} from "../contexts/working-time-account"; // Phase 100B Plan 06 — W8/W9/W10; Plan 07 — W5/W6; Phase 101B
import {
  getAbsencesOverlapping, // Phase 100B Plan 12 — A4
  getActiveLeaveOverlapping, // Phase 100B Plan 13 — A2 (Issue #446 D-02: A1 retired, merged into A2)
  getCalendarLeaveOverlapping, // Phase 100B Plan 13 — A3
  getOwnPendingLeaveRequests, // Phase 100B Plan 13 — A7a
  countPendingApprovals, // Phase 100B Plan 13 — A8
  vocationalSchoolDisplacesLeave, // Issue #448 (D-05) — composition applies, never redefines, the rule
  sickLeaveDayCounts, // Issue #84 (D-14) — the one sick-day counting rule
  getApprovedLeaveEndingOnOrAfter, // Issue #84 (D-08) — the team card's upcoming leave
  filterLeaveRowsToHomeSalon, // Issue #558 (D-02/D-08) — the one Stammsalon-per-day attribution of absences
} from "../contexts/absence";

// Issue #84 (D-07): 1..12 months, default 6 — the bound keeps the per-person saldo fan-out finite.
const teamTrendQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(12).default(6),
  salonId: z.string().uuid().optional(),
});

// Issue #84 (D-02): the optional salon filter of the team views. Unknown query keys (`date`) are
// stripped by zod, a malformed id answers 400 through the global handler.
const teamSalonQuerySchema = z.object({
  salonId: z.string().uuid().optional(),
});

/**
 * Issue #613 (AC-613-5, W4): the most exited persons the Überstunden-Übersicht lists with an open
 * final saldo; the total is reported separately as `exitedOpenFinalSaldoCount`. The per-person saldo
 * computation (a fan-out) runs for the listed persons only.
 */
export const EXITED_OPEN_SECTION_LIMIT = 50;

export async function dashboardRoutes(app: FastifyInstance) {
  // GET /api/v1/dashboard — persönliche Stats
  app.get("/", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const employeeId = req.user.employeeId;
      if (!employeeId) {
        // API-only users (no employee record) receive empty stats rather than a Prisma crash
        return reply.code(200).send({
          today: { workedHours: 0, entries: 0 },
          week: { workedHours: 0, targetHours: 0 },
          overtime: { balanceHours: 0 },
          vacation: { remaining: 0, total: 0, used: 0 },
          periodType: "week" as const,
          scheduleType: null,
        });
      }
      // Phase 77b (Issue #77, D-08): the tenant frame is checked before the first query. It sits
      // after the early return above on purpose — that branch answers a constant, DB-free body for
      // users without an employee record (whose JWT carries tenantId "", auth.ts), so it returns
      // no tenant data and moving the guard above it would turn a documented 200 into a 500.
      const access = accessContextFromRequest(req);
      const tenantId = req.user.tenantId;
      // Phase 76b (Issue #76), CR-01/WR-01 (code review): before this fix the route was gated
      // only by requireAuth and unconditionally returned the caller's own overtime saldo and
      // vacation-entitlement numbers. Salonmanager/Ausbilder (D-05/D-08) deliberately hold no
      // EIGENE permission of any kind, so a bare holder of either template saw their own
      // "Überstundenkonto"/"Urlaubstage" card on first login — the same leak D-06/D-15 close on
      // the team-overview and overtime-trend routes. The route itself stays reachable for every
      // authenticated user (today/week worked-hours remain legitimately visible to everyone);
      // only the overtime/vacation sections are gated, degrading to `null` (never a fabricated
      // zero) so the web dashboard can hide the corresponding card without a 403 for the whole
      // route.
      const canReadOwnOvertime = await hasPermission(req, "overtime:read:EIGENE");
      const canReadOwnVacation = await hasPermission(req, "leave-entitlement:read:EIGENE");
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const now = new Date();
      const today = todayInTz(tz);

      // Issue #493 (D-10): the worked-entry read below is a `@db.Date` filter, so it takes
      // calendar-day bounds; the Soll inputs (monthStart/monthEnd) keep their instants on purpose.
      const { firstDay: weekFirstDay, lastDay: weekLastDay } = weekDateRange(now, tz);

      // ── Heute: gearbeitete Stunden ────────────────────────────────────
      // Phase 100B Plan 08 (T2) — the loop below only ever sums a row when `e.endTime` is
      // truthy, so T2's `endTime: { not: null }` DB-level filter is a proven no-op here.
      const todayEntries = await getWorkedEntriesInRange(
        app.prisma,
        employeeScopeFor(access, { employeeId }),
        today,
        today,
      );

      let todayMinutes = 0;
      for (const e of todayEntries) {
        if (e.endTime) {
          todayMinutes += entryDurations(e).workingMinutes;
        }
      }

      // ── Aktueller Arbeitsplan ─────────────────────────────────────────
      const schedule = await getEffectiveSchedule(app, employeeId);
      const isMonthlyHoursSchedule = String(schedule.type ?? "") === "MONTHLY_HOURS";

      // Issue #433 (D-11): the composition layer carries no Soll rule of its own for
      // MONTHLY_HOURS — the retired per-tenant holiday-deduction switch (Issue #433, D-04) is
      // no longer read here or anywhere else in the saldo pipeline. `defaultWorkDays` only
      // feeds the D-05 workday tier inside the saldo core (`monthlyHoursMonthSollMinutes`
      // below), the SAME function Monatsabschluss and the monthly report call.
      const tenantConfig = isMonthlyHoursSchedule
        ? await app.prisma.tenantConfig.findUnique({
            where: { tenantId },
            select: { defaultWorkDays: true },
          })
        : null;

      // ── Diese Woche / Dieser Monat: gearbeitete Stunden ──────────────

      // For MONTHLY_HOURS: fetch hours worked this month (monthStart..today).
      // For FIXED_SCHEDULE / FLEXTIME / SHIFT_BASED: fetch hours worked this week (weekFirstDay..weekLastDay).
      let workedQueryStart: Date;
      let workedQueryEnd: Date;
      let monthStart: Date | null = null;
      let monthEnd: Date | null = null;

      if (isMonthlyHoursSchedule) {
        const todayZoned = today;
        const y = parseInt(dateStrInTz(todayZoned, tz).slice(0, 4));
        const m = parseInt(dateStrInTz(todayZoned, tz).slice(5, 7));
        const range = monthRangeUtc(y, m, tz);
        monthStart = range.start;
        monthEnd = range.end;
        workedQueryStart = monthDateRange(y, m, tz).firstDay;
        workedQueryEnd = today; // Ist = hours worked so far this month
      } else {
        workedQueryStart = weekFirstDay;
        workedQueryEnd = weekLastDay;
      }

      const periodEntries = await getWorkedEntriesInRange(
        app.prisma,
        employeeScopeFor(access, { employeeId }),
        workedQueryStart,
        workedQueryEnd,
      );

      let periodWorkedMinutes = 0;
      for (const e of periodEntries) {
        if (e.endTime) {
          periodWorkedMinutes += entryDurations(e).workingMinutes;
        }
      }

      // Keep weekMinutes for backwards-compat (used as week.workedHours for FIXED_SCHEDULE / FLEXTIME / SHIFT_BASED)
      const weekMinutes = isMonthlyHoursSchedule ? 0 : periodWorkedMinutes;

      // ── Holidays by work location (Phase 71b, issue #71) ─────────────────
      // Issue #451 (D-06): resolved HERE only for the MONTHLY_HOURS month case now — its only
      // remaining consumer. The non-MONTHLY_HOURS week Soll comes from computeWeekProgress
      // below, which resolves its own per-piece work-location holidays from the saldo core —
      // fed with the SAME T2 rows already loaded above (`periodEntries`), per § 2 EFZG (work
      // location, not a single tenant-wide federal state).
      let holidayDates = new Map<string, string>();
      if (isMonthlyHoursSchedule && monthStart && monthEnd) {
        const workLocationEntries: WorkLocationEntry[] = periodEntries.map((e) => ({
          employeeId,
          date: e.date,
          startTime: e.startTime,
          salonId: e.salonId,
        }));
        const employeeHolidaysMap = await holidaysAtWorkLocation(
          app.prisma,
          tenantId,
          [employeeId],
          dateStrInTz(monthStart, tz),
          dateStrInTz(monthEnd, tz),
          workLocationEntries,
        );
        holidayDates = employeeHolidaysMap.get(employeeId) ?? new Map<string, string>();
      }

      // ── Soll-Stunden ──────────────────────────────────────────────────

      let weekSollMinutes = 0;
      let monthSollMinutes = 0;
      // Issue #451 (D-06) — the to-date Soll/Ist pair (through yesterday, issue #438); stays
      // undefined (never a fabricated 0) for MONTHLY_HOURS and for a null computeWeekProgress
      // result — the response omits both fields in that case (an older cached client degrades
      // to the previous workedHours − targetHours delta).
      let weekWorkedToDateHours: number | undefined;
      let weekTargetToDateHours: number | undefined;

      if (isMonthlyHoursSchedule) {
        // Issue #433 (D-11): the composition layer carries no Soll rule of its own — the full
        // month's net Soll (holiday/leave/absence already folded in) comes from the saldo
        // core, the SAME function Monatsabschluss and the monthly report call, so this tile
        // can never diverge from them.
        const mh = Number(schedule.monthlyHours ?? 0);
        if (mh > 0 && monthStart && monthEnd) {
          const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
            monthStart,
            monthEnd,
            tz,
          );
          const meEmployee = await app.prisma.employee.findUnique({
            where: { id: employeeId },
            select: { hireDate: true, exitDate: true },
          });
          // WR-01 (Issue #433 review): mirror the established "employee row vanished"
          // convention elsewhere in this file (dashboard.ts: `meEmployee?.hireDate ?? null`,
          // see the open-items block below) — never fabricate `today` as a stand-in hireDate.
          // A missing employee row (deleted mid-request, DB inconsistency) means there is no
          // Soll to compute at all; skip the call and leave `monthSollMinutes` at its 0 default
          // rather than silently rendering a too-small "hired today" Soll.
          if (meEmployee) {
            const [monthLeave, monthAbsences] = await Promise.all([
              getActiveLeaveOverlapping(
                app.prisma,
                employeeScopeFor(access, { employeeId }),
                monthStart,
                monthEnd,
              ),
              getAbsencesOverlapping(
                app.prisma,
                employeeScopeFor(access, { employeeId }),
                monthStart,
                monthEnd,
              ),
            ]);
            monthSollMinutes =
              monthlyHoursMonthSollMinutes({
                employeeId,
                schedule: schedule as Record<string, unknown>,
                monthStart,
                monthEnd,
                monthFirstDay,
                monthLastDay,
                tz,
                hireDate: meEmployee.hireDate,
                exitDate: meEmployee.exitDate ?? null,
                leave: monthLeave,
                absences: monthAbsences,
                holidayDateStrings: new Set(holidayDates.keys()),
                defaultWorkDays: tenantConfig?.defaultWorkDays,
              }) ?? 0;
          }
        }
      } else {
        // FIXED_SCHEDULE / FLEXTIME / SHIFT_BASED: Issue #451 (D-06) — the whole week's net
        // Soll (after leave, absence, Berufsschule and holiday reduction) and the to-date
        // Soll/Ist pair, both from the saldo core (closeEmployeeMonth) — never a composition
        // {day}Hours walk. `null` (missing/exempt employee, or any part of the week under a
        // MONTHLY_HOURS contract) degrades to targetHours 0 with the to-date fields omitted.
        const weekProgress = await computeWeekProgress(app, employeeId, now);
        if (weekProgress) {
          weekSollMinutes = weekProgress.weekSollMinutes;
          weekWorkedToDateHours = round(weekProgress.toDateWorkedMinutes / 60);
          weekTargetToDateHours = round(weekProgress.toDateSollMinutes / 60);
        }
      }

      // ── Überstunden ───────────────────────────────────────────────────
      // LIVE lifetime saldo through windowEnd (today only if today has completed entries, else
      // yesterday), from the SAME source of truth updateOvertimeAccount persists — so the KPI
      // reflects "as of yesterday" while the current day is incomplete, instead of the stale
      // event-driven OvertimeAccount.balanceHours. computeOvertimeBalanceBreakdown returns null
      // for §18-exempt employees. Fail-safe: on any error, fall back to the stored value so the
      // dashboard never 500s on the saldo tile.
      //
      // Phase 97-04 (SALDO-DISP-01/02/04) — the SAME call additively yields confirmedMinutes /
      // openMonthMinutes / hasClosedMonth / rosterIncomplete, mirroring the fail-safe shape
      // 97-01 established on GET /overtime/:employeeId. Both non-happy branches (exempt →
      // breakdown null, or the catch) fall back identically: read confirmedMinutes/hasClosedMonth
      // from the independent getConfirmedCarryOver query and report openMonthMinutes: null so the
      // forecast renders as unavailable — a fabricated 0 there would be indistinguishable from a
      // genuine zero forecast. That fallback query is itself never-500 (own try/catch): a failure
      // of getConfirmedCarryOver still yields the stored balanceHours.
      // CR-01: computed only when the caller holds overtime:read:EIGENE — a bare
      // Salonmanager/Ausbilder never triggers any of the live-saldo queries below, mirroring
      // D-15's "no overtime:read, no saldo work" precedent.
      let overtimeResult: {
        balanceHours: number;
        confirmedMinutes: number;
        openMonthMinutes: number | null;
        hasClosedMonth: boolean;
        rosterIncomplete?: boolean;
      } | null = null;

      if (canReadOwnOvertime) {
        let overtimeBalance: number;
        let confirmedMinutes: number;
        let openMonthMinutes: number | null;
        let hasClosedMonth: boolean;
        let rosterIncomplete: boolean | undefined;

        let breakdown: OvertimeBalanceBreakdown | null = null;
        try {
          breakdown = await computeOvertimeBalanceBreakdown(app, employeeId);
        } catch (err) {
          app.log.warn({ err, employeeId }, "dashboard: live overtime saldo failed, using stored");
          // breakdown stays null (its declared initial value) — never reassigned here.
        }

        if (breakdown !== null) {
          overtimeBalance = breakdown.totalHours;
          confirmedMinutes = breakdown.confirmedMinutes;
          openMonthMinutes = breakdown.openMonthMinutes;
          hasClosedMonth = breakdown.hasClosedMonth;
          rosterIncomplete = breakdown.rosterIncomplete;
        } else {
          const acct = await getOvertimeAccount(app.prisma, employeeId, tenantId);
          overtimeBalance = Number(acct?.balanceHours ?? 0);
          try {
            const confirmed = await getConfirmedCarryOver(app.prisma, employeeId, tenantId);
            confirmedMinutes = confirmed.minutes;
            hasClosedMonth = confirmed.hasClosedMonth;
          } catch (fallbackErr) {
            app.log.warn(
              { err: fallbackErr, employeeId },
              "dashboard: confirmed carry-over fallback failed",
            );
            confirmedMinutes = 0;
            hasClosedMonth = false;
          }
          openMonthMinutes = null;
          rosterIncomplete = undefined;
        }

        overtimeResult = {
          balanceHours: round(overtimeBalance),
          // Phase 97-04 (SALDO-DISP-01/02/04) — additive split fields. rosterIncomplete only
          // present when defined (SHIFT_BASED open partial month) — never a fabricated `false`.
          confirmedMinutes,
          openMonthMinutes,
          hasClosedMonth,
          ...(rosterIncomplete !== undefined ? { rosterIncomplete } : {}),
        };
      }

      // ── Resturlaub ────────────────────────────────────────────────────
      // WR-01: computed only when the caller holds leave-entitlement:read:EIGENE — Ausbilder
      // (D-08) holds no leave-entitlement permission at all.
      let vacationResult: { remaining: number; total: number; used: number } | null = null;

      if (canReadOwnVacation) {
        // Issue #451 (D-07) — the ONE Resturlaub facade in contexts/absence/facade/vacation-balance.ts,
        // reached via the Fastify decoration below (not an index.ts re-export — see
        // plugins/vacation-balance-decorate.ts's module header, 451-08 cycle fix) so every
        // reader of "how much vacation does this employee have left" agrees. No VACATION row for
        // the year → null, same `{ remaining: 0, total: 0, used: 0 }` shape as before.
        const yearNow = parseInt(dateStrInTz(now, tz).slice(0, 4));
        const balance = await app.getVacationBalance(employeeId, tenantId, yearNow, now);

        vacationResult = balance
          ? {
              remaining: balance.remainingDays,
              total: balance.entitlementDays + balance.carriedOverEffectiveDays,
              used: balance.usedDays,
            }
          : { remaining: 0, total: 0, used: 0 };
      }

      return {
        today: { workedHours: round(todayMinutes / 60), entries: todayEntries.length },
        week: {
          workedHours: round(weekMinutes / 60),
          targetHours: round(weekSollMinutes / 60),
          // Issue #451 (D-06) — additive, omitted (never a fabricated 0) when
          // computeWeekProgress returned null (MONTHLY_HOURS or a missing/exempt employee).
          ...(weekWorkedToDateHours !== undefined
            ? { workedToDateHours: weekWorkedToDateHours }
            : {}),
          ...(weekTargetToDateHours !== undefined
            ? { targetToDateHours: weekTargetToDateHours }
            : {}),
        },
        // For MONTHLY_HOURS employees the dashboard widget shows a monthly view instead of weekly.
        // periodType tells the frontend which widget to render.
        periodType: isMonthlyHoursSchedule ? "month" : "week",
        // Phase 49.1 — expose schedule type so frontend can branch widgets per model.
        // Returns null when no schedule exists (transient state for freshly created employees);
        // frontend treats null as "no daily/weekly target to display".
        scheduleType: (schedule.type ?? null) as
          "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED" | null,
        month: isMonthlyHoursSchedule
          ? {
              workedHours: round(periodWorkedMinutes / 60),
              targetHours: round(monthSollMinutes / 60),
            }
          : undefined,
        // CR-01/WR-01: `null` (not a fabricated zero) when the caller lacks the corresponding
        // EIGENE permission — the web dashboard hides the card instead of showing a zero saldo.
        overtime: overtimeResult,
        vacation: vacationResult,
      };
    },
  });

  // GET /api/v1/dashboard/team-week — Wochenübersicht für Admins/Manager
  app.get("/team-week", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("team-overview:read:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const access = accessContextFromRequest(req);
      const tenantId = req.user.tenantId;
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const query = req.query as { date?: string };
      const { salonId } = teamSalonQuerySchema.parse(req.query);
      const refDate = query.date ? new Date(query.date) : new Date();

      // Stichtag + `validFrom` (Timestamptz) keep the instant `weekEnd`; the `@db.Date` facade
      // reads below take calendar-day bounds (Issue #493).
      const { start: weekStart, end: weekEnd, days: weekDays } = weekRangeUtc(refDate, tz);
      const { firstDay: weekFirstDay, lastDay: weekLastDay } = weekDateRange(refDate, tz);

      // Phase 91b Plan 06 (Issue #91), D-09/D-10/D-13 — narrow to in-scope employees BEFORE any of
      // the per-employee facade calls below (D-13: aggregate only over visible rows). Resolver
      // choice, justified: `employeeScopeFor`'s target shape only ever accepts an
      // employeeId/employeeIds set — it has no concept of a raw TimeEntry-row id set — so
      // `scopedTimeEntryIds`/`isTimeEntryInScope` (D-09's per-row-Stichtag resolver) cannot compose
      // with any of the 4 `employeeScopeFor(access)` call sites below, all of which take the SAME
      // `EmployeeScope`. `resolveStammsalonScopedEmployeeIds` (D-10, employee-level, Stichtag =
      // weekEnd) is therefore the only resolver that composes with this handler's actual API
      // surface, a deliberate simplification for a short, RECENT window (this week), not a
      // historical audit where an employee's Stammsalon-at-entry-date could plausibly differ from
      // their Stammsalon-at-weekEnd.
      const scopeReach = await resolveAccessReach(
        app.prisma,
        access,
        "team-overview:read:ZUGEWIESEN",
      );
      // D-02/D-16: validated before any data read; one body for every rejection cause.
      const salonFilter = await resolveSalonInReach(app.prisma, tenantId, scopeReach, salonId);
      if (!salonFilter.ok) return reply.code(404).send(TEAM_SALON_NOT_FOUND);
      const filterSalonId = salonFilter.salonId;
      const scopedAccess = { ...access, reach: scopeReach };
      const teamWeekScopedIds =
        scopeReach.kind === "wholeTenant"
          ? "all"
          : await resolveStammsalonScopedEmployeeIds(app.prisma, tenantId, scopeReach, weekEnd);

      // Issue #85 (D-04): for a scoped caller the entry decides. The Unterbau names the in-scope
      // entries of the week; the population is the Stammsalon persons (as before) PLUS every
      // person with at least one of those entries, and the hours of every row come from them.
      let inScopeRows: Awaited<ReturnType<typeof getRecordedWorkEntriesByIds>> | null = null;
      if (scopeReach.kind === "scoped") {
        const inScopeIds = await scopedTimeEntryIds(
          app.prisma,
          tenantId,
          scopeReach,
          weekFirstDay,
          weekLastDay,
        );
        // "all" is whole-tenant only; for a scoped reach it cannot occur, and fails closed.
        inScopeRows = await getRecordedWorkEntriesByIds(
          app.prisma,
          tenantId,
          inScopeIds === "all" ? [] : inScopeIds,
        );
      }
      const populationIds =
        teamWeekScopedIds === "all"
          ? "all"
          : [...teamWeekScopedIds, ...distinctEmployeeIds(inScopeRows ?? [])];

      // The persons employed at some point during the week (Issue #613, D-613-1): never anonymised,
      // a login state never decides, a notice exit date keeps the person listed until the exit day.
      const employees = await app.prisma.employee.findMany({
        where: {
          tenantId,
          AND: [
            reportPopulationWhere(weekStart, weekEnd),
            ...(populationIds !== "all" ? [{ id: { in: populationIds } }] : []),
          ],
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          employeeNumber: true,
          hireDate: true,
          exitDate: true,
        },
        orderBy: { lastName: "asc" },
      });
      // Contracts, holidays, leave and absences belong to the Stammsalon persons only: a person
      // listed purely by an in-scope entry carries none of it (Pitfall 3). Shifts are read for
      // every listed person and narrowed per shift below (Issue #548).
      const stammSet = new Set(teamWeekScopedIds === "all" ? [] : teamWeekScopedIds);
      const stammEmployees =
        teamWeekScopedIds === "all" ? employees : employees.filter((e) => stammSet.has(e.id));
      const teamWeekEmployeeIds = stammEmployees.map((e) => e.id);

      // Holidays by work location (Phase 71b, issue #71) — resolved ONCE per employee for the
      // whole week, fed with a dedicated T2 (closed WORK entries, carries salonId) read. This is
      // deliberately SEPARATE from `timeEntries` below (`getRecordedWorkEntriesInRange`, T2's
      // OPEN/INVALID-inclusive sibling) — that read has no `salonId` column and widening it is
      // out of scope for this plan.
      //
      // Phase 91b Plan 06/11 (Issue #91), D-13 merge note: this call is fed `scopedAccess` +
      // `teamWeekEmployeeIds` (already narrowed above), not raw `access` — Phase 71b's own commit
      // predates this phase's scope narrowing and used the unscoped `access`, which the merge
      // corrects to keep D-13's "aggregate only over visible rows" rule intact for this read too.
      const weekWorkEntries = await getWorkedEntriesInRange(
        app.prisma,
        employeeScopeFor(scopedAccess, { employeeIds: teamWeekEmployeeIds }),
        weekFirstDay,
        weekLastDay,
      );
      const weekWorkLocationEntries: WorkLocationEntry[] = weekWorkEntries.map((e) => ({
        employeeId: e.employeeId,
        date: e.date,
        startTime: e.startTime,
        salonId: e.salonId,
      }));
      const holidaysByEmployee = await holidaysAtWorkLocation(
        app.prisma,
        tenantId,
        teamWeekEmployeeIds,
        weekDays[0],
        weekDays[6],
        weekWorkLocationEntries,
      );

      // Zeiteinträge der Woche — OPEN (still clocked in) and INVALID rows included on purpose
      // (Phase 100B Plan 08 — getRecordedWorkEntriesInRange, not T2): the per-day loop below
      // needs the open row present to compute `workedMinutes` correctly (it checks `e.endTime`
      // itself) and other call sites of this same function need `isClockedIn` detection.
      const timeEntries = await getRecordedWorkEntriesInRange(
        app.prisma,
        employeeScopeFor(scopedAccess, { employeeIds: teamWeekEmployeeIds }),
        weekFirstDay,
        weekLastDay,
      );

      // Genehmigte Abwesenheiten (inkl. Urlaubsstornierungen) + offene Anträge (PENDING).
      // Phase 95 SHIFT-01: PENDING leave surfaces as "beantragt" instead of "–".
      // Phase 100B Plan 13 — A3, contexts/absence facade.
      const leaveRequests = await getCalendarLeaveOverlapping(
        app.prisma,
        employeeScopeFor(scopedAccess, { employeeIds: teamWeekEmployeeIds }),
        weekFirstDay,
        weekLastDay,
      );

      // Krankheiten
      // Phase 100B Plan 12 — A4, contexts/absence facade.
      const absences = await getAbsencesOverlapping(
        app.prisma,
        employeeScopeFor(scopedAccess, { employeeIds: teamWeekEmployeeIds }),
        weekFirstDay,
        weekLastDay,
      );

      // Shifts of the week (S1, contexts/scheduling facade), read for every listed person.
      // Issue #548 / Phase 91b D-11: a shift counts only through its own salon or a person in the
      // reach, never through the Stammsalon. A dropped shift leaves the day exactly like a day
      // without a shift. `employeeScopeFor` does not re-check its targets, so this per-row filter
      // is the scope proof for the ids of entry-only persons. A whole-tenant reach keeps every
      // shift and reads the same ids as before (`employees` is then the Stammsalon list).
      const shiftReadEmployeeIds = employees.map((e) => e.id);
      const shifts = (
        await getShiftsInRange(
          app.prisma,
          employeeScopeFor(scopedAccess, { employeeIds: shiftReadEmployeeIds }),
          weekFirstDay,
          weekLastDay,
        )
      ).filter((s) => isShiftInScope(scopeReach, { salonId: s.salonId, employeeId: s.employeeId }));

      // Aktuelle Schedules aller MA (bulk, latest per employee)
      const allSchedules = await app.prisma.workSchedule.findMany({
        where: {
          employeeId: { in: teamWeekEmployeeIds },
          validFrom: { lte: weekEnd },
        },
        orderBy: { validFrom: "desc" },
      });

      // Issue #84 (D-03/D-06/D-15), Issue #85 (D-04/D-05): under a salon filter, MEMBERSHIP follows
      // the entry or the Stammsalon (a person is listed when they recorded time in the salon this
      // week or are homed there on at least one week day) and HOURS follow the entry's salon.
      // For a WHOLE-TENANT caller presence, holidays, leave, absences and shifts keep using ALL of
      // a person's data — a Springer working in another salon is never shown as missing — and the
      // filter only removes rows. For a SCOPED caller the entries come from the Unterbau's
      // in-scope set only (the entry-based population is already part of `employees`), so the
      // filter narrows that population further and never reveals an entry outside the reach.
      let shownEmployees = employees;
      if (filterSalonId !== null) {
        const homeByPerson = await homeSalonsForDays(
          app.prisma,
          tenantId,
          teamWeekEmployeeIds,
          weekDays[0],
          weekDays[6],
        );
        const enteredInSalon = new Set(
          (inScopeRows ?? timeEntries)
            .filter((e) => e.salonId === filterSalonId)
            .map((e) => e.employeeId),
        );
        shownEmployees = employees.filter((emp) => {
          if (enteredInSalon.has(emp.id)) return true;
          const dayMap = homeByPerson.get(emp.id);
          return dayMap ? weekDays.some((d) => dayMap.get(d) === filterSalonId) : false;
        });
      }

      // Scoped callers: the in-scope rows by person-day (Issue #85, D-04).
      const inScopeByPersonDay = new Map<string, typeof timeEntries>();
      for (const row of inScopeRows ?? []) {
        const key = personDayKey(row.employeeId, dateStrInTz(row.date, tz));
        const list = inScopeByPersonDay.get(key);
        if (list) list.push(row);
        else inScopeByPersonDay.set(key, [row]);
      }

      // Issue #85 (D-05): per person-day, how many valid entries of a Stammsalon person lie
      // outside the caller's reach. They are never shown as hours, times or a live clock-in; they
      // only mark the day as worked elsewhere and keep the person from reading as absent. A
      // population-only person has no row in `timeEntries`, so its count is always 0.
      const hiddenCounts =
        inScopeRows !== null
          ? outOfScopeValidCounts(timeEntries, inScopeRows, (e) => dateStrInTz(e.date, tz))
          : new Map<string, number>();

      // Pro Mitarbeiter die Woche aufbereiten
      const team = shownEmployees.map((emp) => {
        const days = weekDays.map((dayStr) => {
          const hiddenValid = hiddenCounts.get(personDayKey(emp.id, dayStr)) ?? 0;
          const dayEntries =
            inScopeRows !== null
              ? (inScopeByPersonDay.get(personDayKey(emp.id, dayStr)) ?? [])
              : timeEntries.filter(
                  (e) => e.employeeId === emp.id && dateStrInTz(e.date, tz) === dayStr,
                );
          // workedMinutes: only valid (non-invalid) entries count; under a salon filter only the
          // entries of that salon, and `workedElsewhere` marks a day with valid time elsewhere.
          let workedMinutes = 0;
          let workedElsewhere = false;
          for (const e of dayEntries) {
            if (e.isInvalid) continue;
            if (filterSalonId !== null && e.salonId !== filterSalonId) {
              workedElsewhere = true;
              continue;
            }
            if (e.endTime) {
              workedMinutes += entryDurations(e).workingMinutes;
            }
          }

          // Phase 95 SHIFT-01 (Pitfall 2): an employee can have both an APPROVED and a
          // PENDING leave overlapping one day (rare, via corrections). Prefer the
          // non-PENDING (real) leave so APPROVED "Urlaub" wins over "beantragt".
          const leaveMatches = (lr: (typeof leaveRequests)[number]) =>
            lr.employeeId === emp.id &&
            dateStrInTz(lr.startDate, tz) <= dayStr &&
            dateStrInTz(lr.endDate, tz) >= dayStr;
          const leave =
            leaveRequests.find((lr) => leaveMatches(lr) && lr.status !== "PENDING") ??
            leaveRequests.find(leaveMatches);

          const absence = absences.find(
            (a) =>
              a.employeeId === emp.id &&
              dateStrInTz(a.startDate, tz) <= dayStr &&
              dateStrInTz(a.endDate, tz) >= dayStr,
          );

          // Issue #448 (D-05): a Berufsschultag displaces the vacation classification for that
          // day — composition only APPLIES vocationalSchoolDisplacesLeave(), the rule itself is
          // owned by Abwesenheiten (contexts/absence/bs-leave-days.ts).
          const bsDisplacesLeave =
            absence?.type === "VOCATIONAL_SCHOOL" &&
            vocationalSchoolDisplacesLeave(leave?.leaveType.code ?? null);
          const effectiveLeave = bsDisplacesLeave ? null : leave;

          // Find shift for this employee + day
          const dayShifts = shifts.filter(
            (s) => s.employeeId === emp.id && dateStrInTz(s.date, tz) === dayStr,
          );
          const shift =
            dayShifts.length > 0
              ? {
                  startTime: dayShifts[0].startTime,
                  endTime: dayShifts[0].endTime,
                  label: dayShifts[0].label ?? dayShifts[0].template?.name ?? null,
                  color: dayShifts[0].template?.color ?? null,
                }
              : null;

          // Check if this is a workday from the schedule.
          // v1.7.3: source of truth is `WorkSchedule.workDays` (Int[] of weekday indices),
          // NOT just `{day}Hours > 0`. Legacy rows can diverge (Phase 61 audit), and
          // SHIFT_BASED employees often keep default per-day hours but rely on the
          // actual planned shift — for them, "workday" means a shift exists.
          // Without this, the Wochenübersicht falsely reports "Fehlt" on a Monday
          // when the employee's contract has Mo off (workDays=[2,3,4,5]).
          const empSchedule = allSchedules.find((s) => s.employeeId === emp.id);
          const dayDate = new Date(dayStr + "T12:00:00Z");
          const dow = getDayOfWeekInTz(dayDate, tz);
          const expectedHours = empSchedule
            ? getDayHoursFromSchedule(empSchedule as Record<string, unknown>, dow)
            : 0;
          const schedType =
            empSchedule && "type" in empSchedule ? (empSchedule.type as string) : null;
          const scheduleWorkDays = (
            empSchedule && "workDays" in empSchedule
              ? ((empSchedule as { workDays: number[] }).workDays ?? [])
              : []
          ) as number[];
          // Schedule-type-aware obligation: SHIFT_BASED → only a planned shift
          // makes the day a workday; FLEXTIME/MONTHLY_HOURS → never per-day
          // (free daily distribution → no "Fehlt"); FIXED/unknown → workDays
          // array or expectedHours fallback.
          //
          // Issue #613 (P-02): a day outside the person's employment (after the exit day, before
          // the hire day) is not a day the person owes, so it is never a workday and can never be
          // "Fehlt". Nothing else in the status chain changes here.
          const dayRange = dayRangeUtc(dayStr, tz);
          const employedThisDay = isEmployedInPeriod(emp, dayRange.start, dayRange.end);
          const isWorkday =
            employedThisDay &&
            isObligatedWorkday({
              scheduleType: schedType,
              workDays: scheduleWorkDays,
              dow,
              expectedHours,
              hasShift: shift !== null,
            });

          const todayStr = dateStrInTz(new Date(), tz);
          const nowHHMM = timeStrInTz(new Date(), tz);
          // "Due" = late enough that an absence counts as "Fehlt": past days
          // always; today only after the shift start time has passed (or never
          // for schedules without a known start time). A not-yet-due obligated
          // day must render "scheduled", not "missing" → pass isFuture: !isDue.
          const isDue = isDayDue({
            dayStr,
            todayStr,
            nowHHMM,
            shiftStartTime: shift?.startTime ?? null,
          });
          const isFuture = !isDue;

          // Build typed inputs for the presence resolver
          // Scoped callers: hidden valid time enters as CLOSED stand-ins, so an out-of-scope open
          // entry never reads as "clocked_in" (Issue #85, D-05).
          const presenceEntries: PresenceEntry[] = presenceEntriesWithStandIns(
            dayEntries,
            hiddenValid,
          );

          const presenceLeave: PresenceLeave | null = effectiveLeave
            ? {
                status: effectiveLeave.status as "APPROVED" | "CANCELLATION_REQUESTED" | "PENDING",
                leaveTypeName: effectiveLeave.leaveType.name,
              }
            : null;

          const presenceAbsence: PresenceAbsence | null = absence ? { type: absence.type } : null;

          const empHolidayName = holidaysByEmployee.get(emp.id)?.get(dayStr) ?? null;

          // A row listed only by an in-scope entry is never "missing": its absence reasons (leave,
          // sickness, Berufsschule, work in another salon) are held by the Stammsalon and
          // withheld, so "Fehlt" would be a claim the response cannot back (Issue #548). An
          // in-scope shift that is not yet due still reads "scheduled".
          const entryOnlyRow = inScopeRows !== null && !stammSet.has(emp.id);
          const { status, reason } = resolvePresenceState({
            entries: presenceEntries,
            leave: presenceLeave,
            absence: presenceAbsence,
            isWorkday,
            isFuture,
            hasShift: entryOnlyRow ? shift !== null && !isDue : shift !== null,
            isHoliday: empHolidayName !== null,
            holidayName: empHolidayName,
          });

          // Issue #205 finding 3: `reason` has TWO sources — a tenant-renamable
          // `LeaveType.name` on the leave path (resolvePresenceState reads
          // `leave.leaveTypeName` above) and the stable `DISPLAY_NAME` table on the absence
          // path — so a single control field can't represent both without lying for one of
          // them. `leaveTypeCode`/`absenceType` are additive, rename-stable companions to
          // `reason`; mirrors `/my-week`'s already-shipped `leaveType`/`absenceType` pair.
          return {
            date: dayStr,
            status,
            workedHours: round(workedMinutes / 60),
            reason,
            leaveTypeCode: effectiveLeave?.leaveType.code ?? null,
            absenceType: absence?.type ?? null,
            shift,
            isWorkday,
            expectedHours,
            ...(filterSalonId !== null || inScopeRows !== null
              ? { workedElsewhere: workedElsewhere || hiddenValid > 0 }
              : {}),
          };
        });

        return {
          id: emp.id,
          name: `${emp.firstName} ${emp.lastName}`,
          // A person listed only by an in-scope entry is not a Stammsalon person: no number.
          employeeNumber:
            teamWeekScopedIds === "all" || stammSet.has(emp.id) ? emp.employeeNumber : null,
          days,
        };
      });

      return {
        weekStart: weekDays[0],
        weekEnd: weekDays[6],
        weekDays,
        ...(filterSalonId !== null ? { salonId: filterSalonId } : {}),
        team,
      };
    },
  });
  // GET /api/v1/dashboard/today-attendance — Tages-Anwesenheitsübersicht (RPT-03)
  app.get("/today-attendance", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("team-overview:read:ZUGEWIESEN"),
    handler: async (req) => {
      const access = accessContextFromRequest(req);
      const tenantId = req.user.tenantId;
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const today = todayInTz(tz);
      const todayStr = dateStrInTz(today, tz);

      // Phase 91b Plan 06 (Issue #91), D-09/D-10/D-13, Issue #85 (D-04) — the Stammsalon persons
      // (employee-level `resolveStammsalonScopedEmployeeIds`, Stichtag = today) feed every
      // planning read below, because `employeeScopeFor` only accepts an employeeId/employeeIds
      // target. The per-entry rule is layered on top: persons with an in-scope entry today join
      // the population, and what a scoped caller sees of a person's day is the in-scope entries.
      const attendanceScopeReach = await resolveAccessReach(
        app.prisma,
        access,
        "team-overview:read:ZUGEWIESEN",
      );
      const attendanceScopedAccess = { ...access, reach: attendanceScopeReach };
      const attendanceScopedIds =
        attendanceScopeReach.kind === "wholeTenant"
          ? "all"
          : await resolveStammsalonScopedEmployeeIds(
              app.prisma,
              tenantId,
              attendanceScopeReach,
              today,
            );

      // Issue #85 (D-04): for a scoped caller the entry decides. The Unterbau names today's
      // in-scope entries; the population is the Stammsalon persons (as before) PLUS every person
      // with at least one of those entries, and the status of such a person comes from them only.
      let inScopeRows: Awaited<ReturnType<typeof getRecordedWorkEntriesByIds>> | null = null;
      if (attendanceScopeReach.kind === "scoped") {
        const inScopeIds = await scopedTimeEntryIds(
          app.prisma,
          tenantId,
          attendanceScopeReach,
          today,
          today,
        );
        // "all" is whole-tenant only; for a scoped reach it cannot occur, and fails closed.
        inScopeRows = await getRecordedWorkEntriesByIds(
          app.prisma,
          tenantId,
          inScopeIds === "all" ? [] : inScopeIds,
        );
      }
      const attendancePopulationIds =
        attendanceScopedIds === "all"
          ? "all"
          : [...attendanceScopedIds, ...distinctEmployeeIds(inScopeRows ?? [])];

      // Bulk fetch 1 — the persons employed today. Issue #613 (P-02): the Stichtag form of the
      // period population (the tenant-local day as period); a notice exit date no longer hides a
      // person before the exit day, a login state never decides, an anonymised person never shows.
      const attendanceDay = dayRangeUtc(todayStr, tz);
      const employees = await app.prisma.employee.findMany({
        where: {
          tenantId,
          AND: [
            reportPopulationWhere(attendanceDay.start, attendanceDay.end),
            ...(attendancePopulationIds !== "all" ? [{ id: { in: attendancePopulationIds } }] : []),
          ],
        },
        select: { id: true, firstName: true, lastName: true, employeeNumber: true },
        orderBy: { lastName: "asc" },
      });

      // Planning data (holidays, leave, absences, contracts) belongs to the Stammsalon persons
      // only: a person listed purely by an in-scope entry carries none of it.
      const attendanceStammSet = new Set(attendanceScopedIds === "all" ? [] : attendanceScopedIds);
      const employeeIds = (
        attendanceScopedIds === "all"
          ? employees
          : employees.filter((e) => attendanceStammSet.has(e.id))
      ).map((e) => e.id);

      // Holidays by work location, for today (Phase 71b, issue #71) — per employee, fed with a
      // dedicated T2 read (see the team-week handler above for why this is separate from
      // `getRecordedWorkEntriesInRange` below, which has no `salonId` column).
      //
      // Phase 91b Plan 06/11 (Issue #91), D-13 merge note: same fix as the team-week handler above
      // — fed `attendanceScopedAccess` + `employeeIds`, not raw `access`.
      const todayWorkEntries = await getWorkedEntriesInRange(
        app.prisma,
        employeeScopeFor(attendanceScopedAccess, { employeeIds }),
        today,
        today,
      );
      const todayWorkLocationEntries: WorkLocationEntry[] = todayWorkEntries.map((e) => ({
        employeeId: e.employeeId,
        date: e.date,
        startTime: e.startTime,
        salonId: e.salonId,
      }));
      const holidaysByEmployee = await holidaysAtWorkLocation(
        app.prisma,
        tenantId,
        employeeIds,
        todayStr,
        todayStr,
        todayWorkLocationEntries,
      );

      // Bulk fetch 2 — WORK time entries for today, OPEN and INVALID included (Phase 100B Plan
      // 08 — getRecordedWorkEntriesInRange, not T2): `isClockedIn` below needs the open row.
      const timeEntries = await getRecordedWorkEntriesInRange(
        app.prisma,
        employeeScopeFor(attendanceScopedAccess, { employeeIds }),
        today,
        today,
      );

      // Bulk fetch 3 — leave requests covering today (APPROVED + CANCELLATION_REQUESTED)
      // Phase 100B Plan 13 — A2, contexts/absence facade.
      const leaveRequests = await getActiveLeaveOverlapping(
        app.prisma,
        employeeScopeFor(attendanceScopedAccess, { employeeIds }),
        today,
        today,
      );

      // Bulk fetch 4 — absences covering today (deletedAt: null, tenant-scoped)
      // Phase 100B Plan 12 — A4, contexts/absence facade.
      const absences = await getAbsencesOverlapping(
        app.prisma,
        employeeScopeFor(attendanceScopedAccess, { employeeIds }),
        today,
        today,
      );

      // Bulk fetch 5 — latest work schedule per employee (validFrom <= today, ordered desc)
      const allSchedules = await app.prisma.workSchedule.findMany({
        where: {
          employeeId: { in: employeeIds },
          validFrom: { lte: today },
        },
        orderBy: { validFrom: "desc" },
      });

      // Build lookup maps (employeeId → first match)
      // Scoped callers: the status of every person is built from the in-scope rows (Issue #85).
      const entriesByEmp = new Map<string, typeof timeEntries>();
      for (const e of inScopeRows ?? timeEntries) {
        const list = entriesByEmp.get(e.employeeId) ?? [];
        list.push(e);
        entriesByEmp.set(e.employeeId, list);
      }

      const leaveByEmp = new Map<string, (typeof leaveRequests)[0]>();
      for (const lr of leaveRequests) {
        if (!leaveByEmp.has(lr.employeeId)) {
          leaveByEmp.set(lr.employeeId, lr);
        }
      }

      const absenceByEmp = new Map<string, (typeof absences)[0]>();
      for (const a of absences) {
        if (!absenceByEmp.has(a.employeeId)) {
          absenceByEmp.set(a.employeeId, a);
        }
      }

      // DOW for today (needed once — all employees share the same day)
      const dow = getDayOfWeekInTz(today, tz);

      // Issue #85 (D-05): valid entries of a Stammsalon person today that lie outside the reach.
      // For today this is empty by construction (the Stichtag is the entry date), but the generic
      // path is used rather than a special case. A population-only person has no row in
      // `timeEntries`, so its count is always 0.
      const attendanceHiddenCounts =
        inScopeRows !== null
          ? outOfScopeValidCounts(timeEntries, inScopeRows, () => todayStr)
          : new Map<string, number>();

      // Summary counters
      let present = 0;
      let absent = 0;
      let clockedIn = 0;
      let missing = 0;
      let holiday = 0;

      const employeeRows = employees.map((emp) => {
        const empSchedule = allSchedules.find((s) => s.employeeId === emp.id) ?? null;
        const expectedHours = empSchedule
          ? getDayHoursFromSchedule(empSchedule as Record<string, unknown>, dow)
          : 0;
        // v1.7.3: workDays is the canonical source of truth (see /team-week).
        const schedType =
          empSchedule && "type" in empSchedule ? (empSchedule.type as string) : null;
        const scheduleWorkDays = (
          empSchedule && "workDays" in empSchedule
            ? ((empSchedule as { workDays: number[] }).workDays ?? [])
            : []
        ) as number[];
        // No shift data fetched here → hasShift:false, so SHIFT_BASED resolves
        // to "not a workday" (avoids false "Fehlt"). FLEXTIME/MONTHLY_HOURS also
        // resolve to false (free daily distribution) so they no longer inflate
        // the "missing" count. FIXED/unknown → workDays or expectedHours.
        const isWorkday = isObligatedWorkday({
          scheduleType: schedType,
          workDays: scheduleWorkDays,
          dow,
          expectedHours,
          hasShift: false,
        });

        const rawEntries = entriesByEmp.get(emp.id) ?? [];
        // Hidden valid time of a Stammsalon person enters as a CLOSED stand-in: the day reads as
        // present, and an out-of-scope open entry never reads as "clocked_in" (D-05).
        const presenceEntries: PresenceEntry[] = presenceEntriesWithStandIns(
          rawEntries,
          attendanceHiddenCounts.get(personDayKey(emp.id, todayStr)) ?? 0,
        );

        const rawLeave = leaveByEmp.get(emp.id) ?? null;
        const presenceLeave: PresenceLeave | null = rawLeave
          ? {
              status: rawLeave.status as "APPROVED" | "CANCELLATION_REQUESTED",
              leaveTypeName: rawLeave.leaveType.name,
            }
          : null;

        const rawAbsence = absenceByEmp.get(emp.id) ?? null;
        const presenceAbsence: PresenceAbsence | null = rawAbsence
          ? { type: rawAbsence.type }
          : null;

        const empHolidayName = holidaysByEmployee.get(emp.id)?.get(todayStr) ?? null;

        const { status, reason } = resolvePresenceState({
          entries: presenceEntries,
          leave: presenceLeave,
          absence: presenceAbsence,
          isWorkday,
          isFuture: false, // today is never future
          hasShift: false,
          isHoliday: empHolidayName !== null,
          holidayName: empHolidayName,
        });

        // Accumulate summary counters
        if (status === "present") present++;
        else if (status === "absent") absent++;
        else if (status === "clocked_in") clockedIn++;
        else if (status === "missing") missing++;
        else if (status === "holiday") holiday++;

        return {
          id: emp.id,
          name: `${emp.firstName} ${emp.lastName}`,
          // A person listed only by an in-scope entry is not a Stammsalon person: no number.
          employeeNumber:
            attendanceScopedIds === "all" || attendanceStammSet.has(emp.id)
              ? emp.employeeNumber
              : null,
          status,
          reason,
        };
      });

      return {
        date: todayStr,
        employees: employeeRows,
        summary: { present, absent, clockedIn, missing, holiday },
      };
    },
  });

  // GET /api/v1/dashboard/overtime-overview — Überstunden-Übersicht (RPT-01 + SALDO-03)
  // Issue #613 (AC-613-5): besides the persons employed today the answer lists the persons who have
  // left and whose exit month is not closed yet. Most of them are the result of
  // `PATCH /employees/:id/deactivate` (exit date AND login off) meeting the auto-close cron, which
  // selects by active login - the exit month is therefore never closed automatically. That cause is
  // tracked in its own follow-up issue (Phase 613 plan 06); this view only makes the open saldo visible.
  app.get("/overtime-overview", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: [
      requirePermission("team-overview:read:ZUGEWIESEN"),
      // Phase 76b (Issue #76), D-06: saldo IS the overtime resource — a team-overview:read
      // holder alone (e.g. a Salonmanager template) must not see it. No new catalog permission;
      // reuses the existing overtime:read:ZUGEWIESEN key as a SECOND, required preHandler.
      // Fastify runs a preHandler array in order; the first hook that calls reply.code(403).send()
      // sets reply.sent, and every later hook (incl. requirePermission's own requireAuth() call)
      // short-circuits on it — this IS an AND, not an OR (request-permissions.ts's `if
      // (reply.sent) return;` idiom).
      requirePermission("overtime:read:ZUGEWIESEN"),
    ],
    handler: async (req) => {
      const tenantId = req.user.tenantId;

      // Query 1: the OvertimeAccount rows of every person employed at some point up to today
      // (tenant-scoped, never anonymised, login state irrelevant - Issue #613), joined with the
      // employee. The rows shown as the team are the ones employed TODAY.
      const snapshotTz = await getTenantTimezone(app.prisma, tenantId);
      const today = dayRangeUtc(dateStrInTz(new Date(), snapshotTz), snapshotTz);
      const candidateAccounts = await listOvertimeAccountsForTenant(app.prisma, tenantId, {
        start: new Date(0),
        end: today.end,
      });
      const allAccounts = candidateAccounts.filter((a) =>
        isEmployedInPeriod(a.employee, today.start, today.end),
      );

      // Phase 91b Plan 06 (Issue #91), D-10/D-13 — a NEW finding: this route had ZERO scope
      // narrowing of any kind before this plan (confirmed: no `employeeScopeFor` call anywhere in
      // this handler). `listOvertimeAccountsForTenant` does not accept an employeeIds filter (its
      // only other caller, `getBalances` below, is unrelated), so this filters the CHEAP initial
      // list immediately, BEFORE `employeeIds` is computed and BEFORE the expensive per-employee
      // `computeOvertimeBalanceBreakdown` fan-out below ever runs for an out-of-scope employee —
      // the property D-13 actually cares about (cost, not just the response shape). Stichtag =
      // today (tenant-local): a live saldo overview, same precedent as GET /overtime/:employeeId.
      const overviewAccess = accessContextFromRequest(req);
      const overviewScopeReach = await resolveAccessReach(
        app.prisma,
        overviewAccess,
        "team-overview:read:ZUGEWIESEN",
      );
      const overviewScopedIds =
        overviewScopeReach.kind === "wholeTenant"
          ? "all"
          : await resolveStammsalonScopedEmployeeIds(
              app.prisma,
              tenantId,
              overviewScopeReach,
              new Date(),
            );

      // Phase 76b (Issue #76), D-06/P-04 — a SECOND, INDEPENDENT reach for the overtime:read
      // permission this route now also requires. An account is kept only if it passes BOTH the
      // team-overview reach above AND this overtime reach (intersection), so a caller whose
      // team-overview:read scope is WIDER than their overtime:read scope (e.g. TENANT
      // team-overview:read + SALONS-only overtime:read) can never see more saldo than their
      // overtime:read grants — a narrower scope on either permission can only ever narrow the
      // result, never widen it through the other.
      const overtimeScopeReach = await resolveAccessReach(
        app.prisma,
        overviewAccess,
        "overtime:read:ZUGEWIESEN",
      );
      const overtimeScopedIds =
        overtimeScopeReach.kind === "wholeTenant"
          ? "all"
          : await resolveStammsalonScopedEmployeeIds(
              app.prisma,
              tenantId,
              overtimeScopeReach,
              new Date(),
            );

      const activeAccounts = allAccounts.filter((a) => {
        const inOverviewScope =
          overviewScopedIds === "all" || overviewScopedIds.includes(a.employeeId);
        const inOvertimeScope =
          overtimeScopedIds === "all" || overtimeScopedIds.includes(a.employeeId);
        return inOverviewScope && inOvertimeScope;
      });

      // Issue #613 (AC-613-5), D-01/P-03/W4 - the final saldo of a person who has left stays in
      // this overview until the month of the exit is closed. Order of the steps matters for cost:
      // every step before the per-person fan-out is a cheap read or an in-memory decision.
      //
      // (d) ONE bulk read of the latest closed month for the in-scope active persons AND the exited
      // candidates (the same `getConfirmedCarryOverBulk` the page always used, so no additional
      // saldoSnapshot read). It is the only read that touches an exited person outside the caller's
      // reach: two numbers per person (carry-over, period end) are consulted to decide "exit month
      // still open"; nothing of it leaves the handler for a person outside the reach.
      const exitedCandidates = candidateAccounts.filter(
        (a) => !isEmployedInPeriod(a.employee, today.start, today.end),
      );
      const confirmedByEmp = await getConfirmedCarryOverBulk(
        app.prisma,
        [...activeAccounts, ...exitedCandidates].map((a) => a.employeeId),
        tenantId,
      );
      const exitedOpenCandidates = exitedCandidates.filter(
        (a) =>
          a.employee.exitDate !== null &&
          finalSaldoOpen({
            exitDate: a.employee.exitDate,
            latestClosedPeriodEnd: confirmedByEmp.get(a.employeeId)?.periodEnd ?? null,
            tz: snapshotTz,
          }),
      );

      // (e) Reach of an exited person is judged at the EXIT DAY (the last day they belonged to a
      // salon), not today: both reaches, one resolution per distinct exit day and reach, none for a
      // whole-tenant reach.
      const exitDayScopes = new Map<
        string,
        { overview: "all" | string[]; overtime: "all" | string[] }
      >();
      for (const a of exitedOpenCandidates) {
        const day = dateStrInTz(a.employee.exitDate as Date, snapshotTz);
        if (exitDayScopes.has(day)) continue;
        const stichtag = dayRangeUtc(day, snapshotTz).end;
        exitDayScopes.set(day, {
          overview:
            overviewScopeReach.kind === "wholeTenant"
              ? "all"
              : await resolveStammsalonScopedEmployeeIds(
                  app.prisma,
                  tenantId,
                  overviewScopeReach,
                  stichtag,
                ),
          overtime:
            overtimeScopeReach.kind === "wholeTenant"
              ? "all"
              : await resolveStammsalonScopedEmployeeIds(
                  app.prisma,
                  tenantId,
                  overtimeScopeReach,
                  stichtag,
                ),
        });
      }
      const exitedOpenInReach = exitedOpenCandidates.filter((a) => {
        const scopes = exitDayScopes.get(dateStrInTz(a.employee.exitDate as Date, snapshotTz));
        if (scopes === undefined) return false;
        return (
          (scopes.overview === "all" || scopes.overview.includes(a.employeeId)) &&
          (scopes.overtime === "all" || scopes.overtime.includes(a.employeeId))
        );
      });

      // (f) The section is bounded: the total is reported, only the newest exits are listed (exit
      // date descending, then id) and only they get the per-person saldo computation below.
      const exitedOpenFinalSaldoCount = exitedOpenInReach.length;
      const exitedAccounts = [...exitedOpenInReach]
        .sort((x, y) => {
          const byExit =
            (y.employee.exitDate as Date).getTime() - (x.employee.exitDate as Date).getTime();
          if (byExit !== 0) return byExit;
          return x.employeeId < y.employeeId ? -1 : x.employeeId > y.employeeId ? 1 : 0;
        })
        .slice(0, EXITED_OPEN_SECTION_LIMIT);
      const exitedOpenIds = new Set(exitedAccounts.map((a) => a.employeeId));

      const accounts = [...activeAccounts, ...exitedAccounts];
      const employeeIds = accounts.map((a) => a.employeeId);

      // Query 2: last 6 months of MONTHLY SaldoSnapshots for these employees
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
      // Issue #595 (D-03): day 0 = the last day of the month BEFORE the window's first month. A
      // TZ-converted row of that first month is stored on exactly that day, so a bound on the 1st
      // would list only the legacy row of the month.
      sixMonthsAgo.setUTCDate(0);
      sixMonthsAgo.setUTCHours(0, 0, 0, 0);

      const snapshots = await getMonthlySnapshotsInRange(
        app.prisma,
        employeeIds,
        tenantId,
        sixMonthsAgo,
      );

      // Group snapshots by employeeId
      const snapshotsByEmp = new Map<string, typeof snapshots>();
      for (const snap of snapshots) {
        const list = snapshotsByEmp.get(snap.employeeId) ?? [];
        list.push(snap);
        snapshotsByEmp.set(snap.employeeId, list);
      }

      // Phase 97-04 (SALDO-DISP-01/02) - the "Bestätigt" carry-over comes from the ONE bulk lookup
      // `confirmedByEmp` above (never a per-employee query inside the Promise.all below, see
      // confirmed-saldo.ts and 97-CONTEXT's "Known N+1 risk" note). Deliberately NOT the
      // six-month-bounded `snapshots` query: an employee whose last close predates that window
      // would falsely read as having no closed month at all.

      // Per-employee LIVE lifetime saldo through windowEnd (today only if today has completed
      // entries, else yesterday) — SAME source of truth as the dashboard KPI + calendar header
      // (computeOvertimeBalanceBreakdown), replacing the stale event-driven
      // OvertimeAccount.balanceHours. One compute per employee per request (no redundant
      // recompute) — this pre-existing per-employee fan-out (one saldoSnapshot.findFirst per
      // employee, inside the shared helper) is NOT changed by this phase; see
      // dashboard-overtime-overview-n1.test.ts's header for the scope note. TRACK_ONLY → 0
      // (handled inside). Fail-safe: any per-employee error falls back to the stored value so
      // one employee never 500s the whole team overview.
      //
      // Phase 97-04 (SALDO-DISP-01/02/04) — the SAME call additively yields confirmedMinutes /
      // openMonthMinutes / hasClosedMonth / rosterIncomplete for the happy path (no extra
      // query — the value it decomposes was already being computed). The per-employee
      // fail-safe branch and the exempt branch (breakdown null) read confirmedMinutes/
      // hasClosedMonth from the pre-fetched bulk Map above instead (defaulting to zero/false
      // for an employee absent from it) and report openMonthMinutes: null.
      const employees = await Promise.all(
        accounts.map(async (a) => {
          let balanceHours: number;
          let confirmedMinutes: number;
          let openMonthMinutes: number | null;
          let hasClosedMonth: boolean;
          let rosterIncomplete: boolean | undefined;

          let breakdown: OvertimeBalanceBreakdown | null = null;
          try {
            breakdown = await computeOvertimeBalanceBreakdown(app, a.employeeId);
          } catch (err) {
            app.log.warn(
              { err, employeeId: a.employeeId },
              "overtime-overview: live saldo failed, using stored",
            );
            // breakdown stays null (its declared initial value) — never reassigned here.
          }

          if (breakdown !== null) {
            balanceHours = round(breakdown.totalHours);
            confirmedMinutes = breakdown.confirmedMinutes;
            openMonthMinutes = breakdown.openMonthMinutes;
            hasClosedMonth = breakdown.hasClosedMonth;
            rosterIncomplete = breakdown.rosterIncomplete;
          } else {
            balanceHours = Number(a.balanceHours);
            const confirmed = confirmedByEmp.get(a.employeeId) ?? {
              minutes: 0,
              hasClosedMonth: false,
            };
            confirmedMinutes = confirmed.minutes;
            hasClosedMonth = confirmed.hasClosedMonth;
            openMonthMinutes = null;
            rosterIncomplete = undefined;
          }

          return {
            id: a.employeeId,
            name: `${a.employee.firstName} ${a.employee.lastName}`,
            employeeNumber: a.employee.employeeNumber,
            // Issue #613 (AC-613-5): the exit day (tenant-local) and whether this row is an exited
            // person whose final saldo is still open. Additive; the web only displays them.
            exitDate:
              a.employee.exitDate === null ? null : dateStrInTz(a.employee.exitDate, snapshotTz),
            exitedWithOpenFinalSaldo: exitedOpenIds.has(a.employeeId),
            balanceHours,
            status: classifyOvertimeBalance(balanceHours),
            // Phase 97-04 (SALDO-DISP-01/02/04) — additive split fields, same shape as
            // GET /dashboard and GET /overtime/:employeeId.
            confirmedMinutes,
            openMonthMinutes,
            hasClosedMonth,
            ...(rosterIncomplete !== undefined ? { rosterIncomplete } : {}),
            // Issue #595 (D-03/P-01): one item per month (the record the account reads), each
            // named by the server - `month` ("YYYY-MM", null when unnameable) is what the page
            // labels the sparkline with; `periodStart` stays for existing readers.
            snapshots: selectMonthlySnapshotPerMonth(
              snapshotsByEmp.get(a.employeeId) ?? [],
              snapshotTz,
            ).map((s) => {
              const named = snapshotMonthOf(s.periodStart, snapshotTz);
              return {
                periodStart: s.periodStart.toISOString().slice(0, 10),
                month:
                  named === null ? null : `${named.year}-${String(named.month).padStart(2, "0")}`,
                balanceMinutes: s.balanceMinutes,
                carryOver: s.carryOver,
              };
            }),
          };
        }),
      );

      return { employees, exitedOpenFinalSaldoCount };
    },
  });

  // GET /api/v1/dashboard/my-week — persönliche Wochenübersicht (für alle MA)
  app.get("/my-week", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const access = accessContextFromRequest(req);
      const employeeId = req.user.employeeId!;
      const tenantId = req.user.tenantId;
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const { date } = req.query as { date?: string };
      const refDate = date ? new Date(date) : new Date();
      // Issue #493 (D-10): the five facade reads below hit `@db.Date` columns — calendar-day bounds.
      const { days: weekDays } = weekRangeUtc(refDate, tz);
      const { firstDay, lastDay } = weekDateRange(refDate, tz);

      const schedule = await getEffectiveSchedule(app, employeeId);

      // Holidays by work location, for the week (Phase 71b, issue #71) — a dedicated T2 read
      // feeds the resolver (carries salonId); `entries` below (getRecordedWorkEntriesInRange)
      // stays as-is for OPEN/INVALID detection, mirroring the team-week/today-attendance sites.
      const myWeekWorkEntries = await getWorkedEntriesInRange(
        app.prisma,
        employeeScopeFor(access, { employeeId }),
        firstDay,
        lastDay,
      );
      const myWeekWorkLocationEntries: WorkLocationEntry[] = myWeekWorkEntries.map((e) => ({
        employeeId,
        date: e.date,
        startTime: e.startTime,
        salonId: e.salonId,
      }));
      // An API-key actor has no backing employee (req.user.employeeId is undefined despite the
      // `!` assertion above) — skip the resolver rather than pass it a one-element array holding
      // `undefined`, which failed the underlying Prisma query with a 500.
      const myWeekHolidaysByEmployee = employeeId
        ? await holidaysAtWorkLocation(
            app.prisma,
            tenantId,
            [employeeId],
            weekDays[0],
            weekDays[6],
            myWeekWorkLocationEntries,
          )
        : (new Map() as HolidaysByEmployee);
      const myWeekHolidayMap =
        myWeekHolidaysByEmployee.get(employeeId) ?? new Map<string, string>();

      // OPEN and INVALID rows included on purpose (Phase 100B Plan 08 —
      // getRecordedWorkEntriesInRange, not T2): `isClockedIn` below needs the open row present.
      const entries = await getRecordedWorkEntriesInRange(
        app.prisma,
        employeeScopeFor(access, { employeeId }),
        firstDay,
        lastDay,
      );

      // Phase 49.4: leave + absence overlay for the user week-view
      // Phase 95 SHIFT-01: include PENDING so an open request shows "beantragt".
      // Phase 100B Plan 13 — A3, contexts/absence facade.
      const myWeekLeaves = await getCalendarLeaveOverlapping(
        app.prisma,
        employeeScopeFor(access, { employeeId }),
        firstDay,
        lastDay,
      );
      // Phase 100B Plan 12 — A4, contexts/absence facade.
      const myWeekAbsences = await getAbsencesOverlapping(
        app.prisma,
        employeeScopeFor(access, { employeeId }),
        firstDay,
        lastDay,
      );
      // Phase 49.4 (fix): own shifts for this week so SHIFT_BASED users see the planned shift
      // time on scheduled days instead of a generic "Geplant" label.
      // Phase 100B Plan 05 — S1, contexts/scheduling facade.
      const myWeekShifts = await getShiftsInRange(
        app.prisma,
        employeeScopeFor(access, { employeeId }),
        firstDay,
        lastDay,
      );
      const scheduleType = (schedule as { type?: string } | null)?.type ?? null;

      const days = weekDays.map((dateStr: string) => {
        const dayEntries = entries.filter((e) => dateStrInTz(e.date, tz) === dateStr);
        const workedMin = dayEntries.reduce((sum: number, e) => addWorkingMinutes(sum, e), 0);

        const dow = getDayOfWeekInTz(new Date(dateStr + "T12:00:00Z"), tz);
        const holidayName = myWeekHolidayMap.get(dateStr) ?? null;
        // Feiertage reduzieren das Soll auf 0
        const expectedMin =
          schedule && !holidayName ? getDayHoursFromSchedule(schedule, dow) * 60 : 0;
        const hasEntry = dayEntries.length > 0;
        const isClockedIn = dayEntries.some((e) => !e.endTime);
        const isWeekend = dow === 0 || dow === 6;

        // Phase 95 SHIFT-01 (Pitfall 2): prefer a non-PENDING leave so a real
        // APPROVED "Urlaub" wins over a coincident PENDING "beantragt" on the same day.
        const myLeaveMatches = (lr: (typeof myWeekLeaves)[number]) =>
          dateStrInTz(lr.startDate, tz) <= dateStr && dateStrInTz(lr.endDate, tz) >= dateStr;
        const leave =
          myWeekLeaves.find((lr) => myLeaveMatches(lr) && lr.status !== "PENDING") ??
          myWeekLeaves.find(myLeaveMatches);
        const absence = myWeekAbsences.find(
          (a) => dateStrInTz(a.startDate, tz) <= dateStr && dateStrInTz(a.endDate, tz) >= dateStr,
        );
        // Issue #448 (D-05): same BS-displaces-leave application as /team-week above —
        // composition applies the absence-context rule, never redefines it.
        const bsDisplacesLeave =
          absence?.type === "VOCATIONAL_SCHOOL" &&
          vocationalSchoolDisplacesLeave(leave?.leaveType.code ?? null);
        const effectiveLeave = bsDisplacesLeave ? null : leave;
        const dayShifts = myWeekShifts.filter((s) => dateStrInTz(s.date, tz) === dateStr);
        const shift =
          dayShifts.length > 0
            ? {
                startTime: dayShifts[0].startTime,
                endTime: dayShifts[0].endTime,
                label: dayShifts[0].label ?? dayShifts[0].template?.name ?? null,
                color: dayShifts[0].template?.color ?? null,
              }
            : null;
        const hasShift = shift !== null;

        // Schedule-type-aware obligation (fixes flexible schedules never being
        // "Fehlt" and SHIFT_BASED-without-shift no longer being "Fehlt").
        const isWorkday = isObligatedWorkday({
          scheduleType,
          workDays: (schedule as { workDays?: number[] } | null)?.workDays ?? [],
          dow,
          expectedHours: expectedMin / 60,
          hasShift,
        });
        // Due-aware timing: past days always due; today only after the shift
        // start time has passed (or never for a schedule without a start time).
        // Replaces the isPast-only branch so a today shift whose start has passed
        // renders "missing", while flexible/before-shift days render "scheduled".
        const isDue = isDayDue({
          dayStr: dateStr,
          todayStr: dateStrInTz(new Date(), tz),
          nowHHMM: timeStrInTz(new Date(), tz),
          shiftStartTime: shift?.startTime ?? null,
        });

        let status = "none";
        if (isClockedIn) status = "clocked_in";
        else if (hasEntry) status = workedMin >= expectedMin ? "complete" : "partial";
        // Phase 95 SHIFT-01: a PENDING leave surfaces as "requested" ("beantragt"),
        // an APPROVED/CANCELLATION_REQUESTED one stays green "leave".
        else if (effectiveLeave)
          status = effectiveLeave.status === "PENDING" ? "requested" : "leave";
        else if (absence) {
          status = absence.type === "SICK" || absence.type === "SICK_CHILD" ? "sick" : "absent";
        } else if (holidayName) status = "holiday";
        else if (isWeekend && !hasShift) status = "weekend";
        else if (isDue && (isWorkday || hasShift)) status = "missing";
        else if (isWorkday || hasShift) status = "scheduled";

        return {
          date: dateStr,
          workedHours: round(workedMin / 60),
          expectedHours: round(expectedMin / 60),
          status,
          isWorkday,
          isWeekend,
          holidayName,
          leaveType: effectiveLeave?.leaveType.name ?? null,
          absenceType: absence?.type ?? null,
          shift,
        };
      });

      return { weekDays, scheduleType, days };
    },
  });

  // GET /api/v1/dashboard/open-items — offene Vorgänge für den MA (+ pending approvals für Manager)
  app.get("/open-items", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const access = accessContextFromRequest(req);
      const employeeId = req.user.employeeId;
      const tenantId = req.user.tenantId;
      const isManager = await hasPermission(req, "team-overview:read:ZUGEWIESEN");
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const today = todayInTz(tz);
      // GitHub issue #141: hoisted here (rather than fetched separately below) so the Karte and
      // the Cron (attendance-checker.ts, Feature 2) read missingEntriesDays through the SAME
      // resolveMissingEntriesDays() function and cannot drift apart. No card-specific upper bound
      // exists here on purpose — the write path's z.number().int().min(1).max(90) in settings.ts
      // is the only bound (a second one would recreate the exact divergence this issue closes).
      // Also carries enforceBreakConfirmation, folding in the second TenantConfig read this
      // handler used to do further down (see D-09 below) — net query count is unchanged.
      const openItemsConfig = await app.prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: { missingEntriesDays: true, enforceBreakConfirmation: true },
      });
      const missingEntriesDays = resolveMissingEntriesDays(openItemsConfig);
      const windowStart = new Date(today);
      windowStart.setDate(windowStart.getDate() - missingEntriesDays);
      // findMissingWorkdays' effectiveEnd is INCLUSIVE; the replaced loop ran `cursor < today`,
      // so the last day of the window is yesterday. The window's SIZE is now configured
      // (missingEntriesDays); its bounds (windowStart..yesterday, inclusive) are unchanged.
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      // Personal open items (only when the user has an employee record)
      const missingDays: string[] = [];
      let pendingRequestsCount = 0;
      let invalidEntriesCount = 0;
      let unconfirmedBreakDays: string[] = [];

      if (employeeId) {
        // Phase 126: hoisted out of the §18-exemption short-circuit because the break-confirmation
        // derivation below needs scheduleType too, and an exempt employee is still subject to
        // break confirmation — the client-side counter this replaces never checked exemption either.
        const schedule = await getEffectiveSchedule(app, employeeId);

        // Phase 76.7 (D-08, UI-V19-04 supporting backend) — exempt employees never
        // get "missing dates" surfaced on their personal dashboard. The Stempeluhr
        // CTA is also hidden client-side (Plan 03), but we short-circuit here so the
        // open-items query stays cheap. BUrlG signals (pendingRequests +
        // invalidEntries) stay outside this guard — vacation tracking still applies.
        const meEmployee = await app.prisma.employee.findUnique({
          where: { id: employeeId },
          select: { isTimeTrackingExempt: true, hireDate: true, exitDate: true },
        });
        if (!meEmployee?.isTimeTrackingExempt) {
          // 1. Missing time entries (workdays without entries in the configured window).
          // OPEN entries included on purpose (Phase 100B Plan 08 — getRecordedWorkEntriesInRange,
          // not T2): a day whose entry is still open (unclosed clock-in) already has a claimed
          // entry and must NOT ALSO be flagged missing — `lt: today` (exclusive) is exactly
          // `lte: yesterday` (inclusive) for a @db.Date column, so the window is unchanged.
          const recentEntries = await getRecordedWorkEntriesInRange(
            app.prisma,
            employeeScopeFor(access, { employeeId }),
            windowStart,
            yesterday,
          );
          const entryDates = new Set(recentEntries.map((e) => dateStrInTz(e.date, tz)));

          // Holidays by work location, for the configured window (Phase 71b, issue #71) — a
          // dedicated T2 read feeds the resolver (carries salonId); `recentEntries` above
          // (getRecordedWorkEntriesInRange) stays as-is for the entry-date detection.
          const openItemsWorkEntries = await getWorkedEntriesInRange(
            app.prisma,
            employeeScopeFor(access, { employeeId }),
            windowStart,
            today,
          );
          const openItemsWorkLocationEntries: WorkLocationEntry[] = openItemsWorkEntries.map(
            (e) => ({
              employeeId,
              date: e.date,
              startTime: e.startTime,
              salonId: e.salonId,
            }),
          );
          const openItemsHolidaysByEmployee = await holidaysAtWorkLocation(
            app.prisma,
            tenantId,
            [employeeId],
            dateStrInTz(windowStart, tz),
            dateStrInTz(today, tz),
            openItemsWorkLocationEntries,
          );
          const openItemsHolidaySet = new Set(
            (openItemsHolidaysByEmployee.get(employeeId) ?? new Map<string, string>()).keys(),
          );

          // Effective leave (APPROVED or CANCELLATION_REQUESTED, Issue #446) + Absences in the
          // configured window cover the day too (mirrors overtime.ts close-month/status logic — a
          // day is only "missing" if no entry, no holiday, no leave, no absence covers it)
          // Phase 100B Plan 13 — A2, contexts/absence facade.
          const approvedLeaveInWindow = await getActiveLeaveOverlapping(
            app.prisma,
            employeeScopeFor(access, { employeeId }),
            windowStart,
            today,
          );
          // Phase 100B Plan 12 — A4, contexts/absence facade.
          const absencesInWindow = await getAbsencesOverlapping(
            app.prisma,
            employeeScopeFor(access, { employeeId }),
            windowStart,
            today,
          );

          // Phase 111 (issue #114) — the inline `{day}Hours > 0` predicate that used to live here
          // read {day}Hours for EVERY schedule type. For SHIFT_BASED/FLEXTIME/MONTHLY_HOURS those
          // columns are a legacy 1/0 flag, not hours, so a free day with thursdayHours=1 was
          // reported as missing forever. Commit 523d7042 (v1.9.5) fixed the three sibling sites in
          // this file and missed this one. Route through the canonical detector instead — the same
          // one the Monatsabschluss and GET /overtime/close-month/status use, so card and
          // Monatsabschluss cannot drift apart.
          const openItemsScheduleType = String(schedule?.type ?? "");

          // SHIFT_BASED obligation comes from the roster, never from {day}Hours (pitfall A4).
          // Tenant-scoped via the employee relation + soft-delete filtered (CLAUDE.md).
          // Phase 100B Plan 05 — S1, contexts/scheduling facade.
          let openItemsRosterDates: Set<string> | undefined;
          if (openItemsScheduleType === "SHIFT_BASED") {
            const openItemsShifts = await getShiftsInRange(
              app.prisma,
              employeeScopeFor(access, { employeeId }),
              windowStart,
              yesterday,
            );
            openItemsRosterDates = new Set(openItemsShifts.map((sh) => dateStrInTz(sh.date, tz)));
          }

          // Clamp to the employment span, mirroring GET /overtime/close-month/status — a day
          // before hire or after exit carries no obligation.
          const hireDate = meEmployee?.hireDate ?? null;
          const exitDate = meEmployee?.exitDate ?? null;
          const openItemsStart = hireDate && hireDate > windowStart ? hireDate : windowStart;
          const openItemsEnd = exitDate && exitDate < yesterday ? exitDate : yesterday;

          const openItemsGapResult = findMissingWorkdays({
            // Phase 128 (D-01/D-02): the detector's FIXED branch is workDays-primary itself now, so
            // the Phase 111 workDaysPrimarySchedule() projection that used to sit here is gone -
            // this card and the Monatsabschluss read one rule from one place.
            schedule: (schedule ?? {}) as Record<string, unknown>,
            effectiveStart: openItemsStart,
            effectiveEnd: openItemsEnd,
            tz,
            entryDates,
            approvedLeave: approvedLeaveInWindow.map((lr) => ({
              startDate: lr.startDate,
              endDate: lr.endDate,
              halfDay: Boolean(lr.halfDay),
            })),
            absences: absencesInWindow.map((ab) => ({
              startDate: ab.startDate,
              endDate: ab.endDate,
              halfDay: Boolean(ab.halfDay),
            })),
            holidayDateStrings: openItemsHolidaySet,
            rosterDates: openItemsRosterDates,
          });

          // partial:true gaps come from half-day leave/absence days without an entry. This card
          // renders a nagging "Nachtragen" CTA and has never nagged about a leave-covered day;
          // surfacing them here would trade one false positive for a new one. Full gaps only.
          missingDays.push(...openItemsGapResult.gaps.filter((g) => !g.partial).map((g) => g.date));
        }

        // 2. Own pending leave requests — BUrlG still applies for exempt employees
        // Phase 100B Plan 13 — A7a, contexts/absence facade.
        const pendingRequests = await getOwnPendingLeaveRequests(app.prisma, employeeId, tenantId);
        pendingRequestsCount = pendingRequests.length;

        // 3. Invalidated time entries — leave signal also applies for exempt employees
        const invalidEntries = await getInvalidEntries(app.prisma, employeeId, tenantId);
        invalidEntriesCount = invalidEntries.length;

        // 3b. Unbestätigte Pflichtpausen (§ 4 ArbZG, BREAK-05) — Phase 126, GitHub issue #126.
        //
        // D-02: the number is produced HERE, by the canonical detector, and never again by a
        // client-side predicate. Before this, dashboard/+page.svelte counted AUTO days itself over a
        // 12-MONTH window with none of the detector's filters (no type:"WORK", no
        // MONTHLY_HOURS/FLEXTIME exclusion), so the card demanded action on days the backend does not
        // know about. Same error class as the inline {day}Hours predicate Phase 111 removed above.
        //
        // D-01: the window is the CURRENT MONTH — deliberately NOT widened to match the old client
        // counter. Days outside the current month trigger no notification and block no
        // Monatsabschluss; a hint demanding an unenforced action IS the defect (Phase 113 / #116
        // removed exactly such a promise rather than building it). Making older months actionable
        // also opens the question of whether they should block month close — its own domain ticket.
        //
        // D-09: no explicit enforceBreakConfirmation branch here. findUnconfirmedBreakDays returns []
        // for an un-opted tenant as its FIRST check (BREAK-05 Gesamt-Opt-in), so the gate is inherited.
        // GitHub issue #141: reuses the openItemsConfig read hoisted above instead of a second
        // TenantConfig fetch — net query count for the handler is unchanged.
        const breakMonthRef = todayInTz(tz);
        const { start: breakMonthStart, end: breakMonthEnd } = monthRangeUtc(
          breakMonthRef.getUTCFullYear(),
          breakMonthRef.getUTCMonth() + 1,
          tz,
        );
        const { firstDay: breakMonthFirstDay, lastDay: breakMonthLastDay } = monthDayBounds(
          breakMonthStart,
          breakMonthEnd,
          tz,
        );
        unconfirmedBreakDays = await findUnconfirmedBreakDays(app.prisma, {
          employeeId,
          monthFirstDay: breakMonthFirstDay,
          monthLastDay: breakMonthLastDay,
          tz,
          scheduleType: String(schedule?.type ?? ""),
          enforceBreakConfirmation: openItemsConfig?.enforceBreakConfirmation ?? false,
        });
      }

      // 4. Team-wide pending approvals (only for managers/admins)
      let pendingApprovalsCount = 0;
      if (isManager) {
        // Phase 100B Plan 13 — A8, contexts/absence facade. Exclude own requests so they don't
        // double-count with pendingRequests.
        pendingApprovalsCount = await countPendingApprovals(
          app.prisma,
          tenantId,
          employeeId ?? undefined,
        );
      }

      // unconfirmedBreakDays is deliberately NOT summed into `total`. `total` is the Phase-111
      // contract the client feeds into hasNoOpenItems($lib/leave/karenz-nudge.ts) as a value
      // SEPARATE from the break and Karenz counts; folding it in here would double-count it there.
      const total =
        missingDays.length + pendingRequestsCount + invalidEntriesCount + pendingApprovalsCount;

      return {
        missingDays,
        pendingRequests: pendingRequestsCount,
        invalidEntries: invalidEntriesCount,
        pendingApprovals: pendingApprovalsCount,
        unconfirmedBreakDays,
        total,
      };
    },
  });

  // GET /api/v1/dashboard/overtime-trend — Team overtime saldo trend (last 6 months)
  //
  // Phase 76b (Issue #76), D-15: before this change the route had NO permission gate at all
  // (`preHandler: requireAuth`) — a pre-existing finding already documented and deliberately
  // deferred from Phase 91b Plan 06 (docs/adr/0001-abweichungen.md, "GET
  // /dashboard/overtime-trend fehlendes Permission-Gate"). Every signed-in user, including a
  // plain Mitarbeiter or any new Phase 76b template holder without overtime:read, could see the
  // tenant-wide aggregate saldo. This closes that gap: the route now requires
  // overtime:read:ZUGEWIESEN and aggregates only over the caller's in-scope employees, mirroring
  // GET /overtime-overview's resolveAccessReach/resolveStammsalonScopedEmployeeIds pattern below,
  // keyed on THIS route's own gate permission (not team-overview:read).
  app.get("/overtime-trend", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("overtime:read:ZUGEWIESEN"),
    handler: async (req) => {
      const tenantId = req.user.tenantId;

      // 6-month window (inclusive of current month)
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 5);
      // Issue #595 (D-03): day 0 = the last day of the month before the window's first month,
      // where the TZ-converted row of that first month is stored.
      sixMonthsAgo.setUTCDate(0);
      sixMonthsAgo.setUTCHours(0, 0, 0, 0);

      // First fetch the employee IDs of the trend window's population.
      // Prisma groupBy does not support relation filters in `where`, so we resolve
      // tenant scoping via a separate employee query. Issue #613: the population is the persons
      // employed at some point in the window and never anonymised (`reportPopulationWhere`), so a
      // person who left inside the window still counts in the months they were employed; a login
      // state never decides.
      const employees = await app.prisma.employee.findMany({
        where: { tenantId, ...reportPopulationWhere(sixMonthsAgo, new Date()) },
        select: { id: true },
      });

      // D-15 — narrow to the caller's scope BEFORE both aggregation queries below (same
      // precedent as GET /overtime-overview), Stichtag = today.
      const trendAccess = accessContextFromRequest(req);
      const trendScopeReach = await resolveAccessReach(
        app.prisma,
        trendAccess,
        "overtime:read:ZUGEWIESEN",
      );
      const trendScopedIds =
        trendScopeReach.kind === "wholeTenant"
          ? "all"
          : await resolveStammsalonScopedEmployeeIds(
              app.prisma,
              tenantId,
              trendScopeReach,
              new Date(),
            );
      const scopedEmployees =
        trendScopedIds === "all"
          ? employees
          : employees.filter((e) => trendScopedIds.includes(e.id));
      const employeeIds = scopedEmployees.map((e) => e.id);

      // Query 1: SUM(carryOver) grouped by periodStart, MONTHLY only, within 6-month window.
      const grouped = await sumCarryOverByMonth(app.prisma, employeeIds, tenantId, sixMonthsAgo);

      // Issue #595 (D-03): the groups are keyed by the STORED date, so a month with a legacy and a
      // TZ-converted row formed two groups, one under the wrong month. Every group is named by
      // snapshotMonthOf and groups of one month are summed, so `month` honours its documented
      // "always day 01" contract for both storage conventions.
      const trendTz = await getTenantTimezone(app.prisma, tenantId);
      const carryByMonth = new Map<string, number>();
      let unnamedGroups = 0;
      for (const g of grouped) {
        const named = snapshotMonthOf(g.periodStart, trendTz);
        if (named === null) {
          unnamedGroups += 1;
          continue;
        }
        const key = `${named.year}-${String(named.month).padStart(2, "0")}-01`;
        carryByMonth.set(key, (carryByMonth.get(key) ?? 0) + g.carryOver);
      }
      if (unnamedGroups > 0) {
        app.log.warn(
          { tenantId, unnamedGroups },
          "overtime-trend: snapshot groups with no nameable month left out",
        );
      }
      const snapshots = [...carryByMonth.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([month, teamCarryOverMinutes]) => ({ month, teamCarryOverMinutes }));

      // Query 2: SUM(balanceHours * 60) across all active employees' OvertimeAccounts.
      const accounts = await getBalances(app.prisma, employeeIds, tenantId);
      const currentTeamBalanceMinutes = Math.round(
        accounts.reduce((sum, a) => sum + Number(a.balanceHours) * 60, 0),
      );

      return { snapshots, currentTeamBalanceMinutes };
    },
  });

  // GET /api/v1/dashboard/team-trend — the team charts' six-month series, aggregated on the server
  // (Issue #84, D-07). Replaces the browser's six /reports/monthly calls; the figures come from
  // the owning contexts only.
  //
  // Unfiltered, every figure is the one the monthly report prints (Ist/Soll from the
  // working-time account, sick days from the absence kernel). With `salonId` (D-02..D-05, D-12,
  // D-13): Ist is the recorded working time of closed, valid entries in that salon through the
  // tenant-local yesterday, sick days follow the Stammsalon of each counted day, and Soll is never
  // computed — it is a contract figure of a person, not divisible by salon.
  //
  // Issue #85 (D-04/D-06): a SCOPED caller's figures never contain an out-of-scope minute. The
  // account Ist (`computeMonthReportFigures`) covers every salon of a person, so it is used for a
  // person-month only when every non-deleted WORK entry of that person in that month is in scope;
  // otherwise — and always for a person who is listed only by an in-scope entry — Ist is the sum
  // of the person's in-scope, valid, closed entries through tenant-local yesterday. The response
  // names the basis (`SCOPE_ENTRIES`) and withholds Soll then, because Ist and Soll must never
  // come from different populations. Sick days stay over the Stammsalon persons: leave belongs to
  // the Stammsalon, a person listed only by an entry never adds one.
  app.get("/team-trend", {
    schema: {
      tags: ["Dashboard"],
      security: [{ bearerAuth: [] }],
      summary: "Team trend of worked time, target time and sick days per month",
      description:
        "Per month of the window: the worked minutes and the target minutes from the working-time " +
        "account and the sick days from the absence context, over the persons in the caller's " +
        "team-overview reach. For a caller with a partial reach the worked minutes of a person " +
        "come from the account only if every entry of the person in that month is in the reach, " +
        "otherwise they are the sum of the visible entries (workedBasis SCOPE_ENTRIES). Target " +
        "minutes only with overtime:read covering every shown person, never together with a salon " +
        "filter and never when part of the worked minutes came from visible entries.",
    },
    preHandler: requirePermission("team-overview:read:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { months, salonId } = teamTrendQuerySchema.parse(req.query);
      const tenantId = req.user.tenantId;
      const access = accessContextFromRequest(req);
      const tz = await getTenantTimezone(app.prisma, tenantId);

      const reach = await resolveAccessReach(app.prisma, access, "team-overview:read:ZUGEWIESEN");
      // D-02/D-16: validated before any data read; one body for every rejection cause.
      const filter = await resolveSalonInReach(app.prisma, tenantId, reach, salonId);
      if (!filter.ok) return reply.code(404).send(TEAM_SALON_NOT_FOUND);
      const filterSalonId = filter.salonId;
      const scopedAccess = { ...access, reach };

      // Soll is a contract figure: only with overtime:read, and only when that reach covers
      // every person shown (D-17); a narrower reach on either permission only ever narrows.
      const canSeeSoll = await hasPermission(req, "overtime:read:ZUGEWIESEN");
      const overtimeReach = canSeeSoll
        ? await resolveAccessReach(app.prisma, access, "overtime:read:ZUGEWIESEN")
        : null;
      let sollCovered = canSeeSoll;

      // The window: the `months` calendar months ending with the tenant-local current month.
      const today = todayInTz(tz);
      const dayString = (d: Date) => d.toISOString().slice(0, 10);

      // Issue #85 (D-04): for a scoped caller the Unterbau names the in-scope entries of the whole
      // window once; they are bucketed by month and decide the population beyond the Stammsalon
      // persons and every Ist that does not come from the account.
      const scopedRowsByMonth = new Map<
        string,
        Awaited<ReturnType<typeof getRecordedWorkEntriesByIds>>
      >();
      // Issue #613: the persons listed by an in-scope entry, with their employment, so each month
      // can ask `isEmployedInPeriod` for that month (the same population as /reports/monthly).
      const scopedActivePersons = new Map<string, { hireDate: Date; exitDate: Date | null }>();
      if (reach.kind === "scoped") {
        const first = new Date(
          Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (months - 1), 1),
        );
        const windowFirstDay = monthDateRange(
          first.getUTCFullYear(),
          first.getUTCMonth() + 1,
          tz,
        ).firstDay;
        const windowLastDay = monthDateRange(
          today.getUTCFullYear(),
          today.getUTCMonth() + 1,
          tz,
        ).lastDay;
        const inScopeIds = await scopedTimeEntryIds(
          app.prisma,
          tenantId,
          reach,
          windowFirstDay,
          windowLastDay,
        );
        // "all" is whole-tenant only; for a scoped reach it cannot occur, and fails closed.
        const rows = await getRecordedWorkEntriesByIds(
          app.prisma,
          tenantId,
          inScopeIds === "all" ? [] : inScopeIds,
        );
        for (const row of rows) {
          const monthKey = dayString(row.date).slice(0, 7);
          const list = scopedRowsByMonth.get(monthKey);
          if (list) list.push(row);
          else scopedRowsByMonth.set(monthKey, [row]);
        }
        const windowStartInstant = monthRangeUtc(
          first.getUTCFullYear(),
          first.getUTCMonth() + 1,
          tz,
        ).start;
        const windowEndInstant = monthRangeUtc(
          today.getUTCFullYear(),
          today.getUTCMonth() + 1,
          tz,
        ).end;
        const active = await app.prisma.employee.findMany({
          where: {
            tenantId,
            ...reportPopulationWhere(windowStartInstant, windowEndInstant),
            id: { in: distinctEmployeeIds(rows) },
          },
          select: { id: true, hireDate: true, exitDate: true },
        });
        for (const p of active)
          scopedActivePersons.set(p.id, { hireDate: p.hireDate, exitDate: p.exitDate });
      }

      const window: Array<{
        year: number;
        month: number;
        key: string;
        firstDay: Date;
        lastDay: Date;
        ids: string[];
        /** Active persons listed only by an in-scope entry of the month (scoped callers). */
        entryOnlyIds: string[];
      }> = [];
      for (let back = months - 1; back >= 0; back--) {
        const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 1));
        const year = d.getUTCFullYear();
        const month = d.getUTCMonth() + 1;
        // Same population as GET /reports/monthly for this month (Issue #613) and the same Stichtag
        // (month end) for the reach.
        const { start, end } = monthRangeUtc(year, month, tz);
        const { firstDay, lastDay } = monthDateRange(year, month, tz);
        const scopedIds =
          reach.kind === "wholeTenant"
            ? "all"
            : await resolveStammsalonScopedEmployeeIds(app.prisma, tenantId, reach, end);
        const people = await app.prisma.employee.findMany({
          where: {
            tenantId,
            AND: [
              reportPopulationWhere(start, end),
              ...(scopedIds === "all" ? [] : [{ id: { in: scopedIds } }]),
            ],
          },
          select: { id: true },
        });
        const ids = people.map((p) => p.id).sort((a, b) => a.localeCompare(b));
        const key = `${year}-${String(month).padStart(2, "0")}`;
        const stammIds = new Set(ids);
        const entryOnlyIds = distinctEmployeeIds(scopedRowsByMonth.get(key) ?? []).filter((id) => {
          const person = scopedActivePersons.get(id);
          return (
            person !== undefined && isEmployedInPeriod(person, start, end) && !stammIds.has(id)
          );
        });

        if (overtimeReach && overtimeReach.kind === "scoped") {
          const covered = await resolveStammsalonScopedEmployeeIds(
            app.prisma,
            tenantId,
            overtimeReach,
            end,
          );
          if (covered !== "all" && ![...ids, ...entryOnlyIds].every((id) => covered.includes(id))) {
            sollCovered = false;
          }
        }
        window.push({
          year,
          month,
          key,
          firstDay,
          lastDay,
          ids,
          entryOnlyIds,
        });
      }

      // D-13: exact per-day Stammsalon of every shown person, one Unterbau call for the window.
      const homeByPerson =
        filterSalonId === null
          ? null
          : await homeSalonsForDays(
              app.prisma,
              tenantId,
              Array.from(new Set(window.flatMap((w) => w.ids))),
              dayString(window[0].firstDay),
              dayString(window[window.length - 1].lastDay),
            );
      const yesterday = new Date(today.getTime() - 86_400_000);

      const series: Array<{
        month: string;
        workedMinutes: number;
        shouldMinutes: number | null;
        sickDays: number;
      }> = [];
      let usedScopeEntries = false;
      for (const { year, month, key, firstDay, lastDay, ids, entryOnlyIds } of window) {
        let worked = 0;
        let should = 0;
        if (reach.kind === "scoped") {
          // Issue #85 (D-04/D-06): only visible entries, valid and closed, through tenant-local
          // yesterday (today never counts, #438). The fold step is the #79 kernel's.
          const monthRows = scopedRowsByMonth.get(key) ?? [];
          const scopeSum = (personIds: ReadonlySet<string>) =>
            monthRows
              .filter(
                (e) =>
                  personIds.has(e.employeeId) &&
                  !e.isInvalid &&
                  e.endTime !== null &&
                  e.date.getTime() <= yesterday.getTime() &&
                  (filterSalonId === null || e.salonId === filterSalonId),
              )
              .reduce((sum: number, e) => addWorkingMinutes(sum, e), 0);

          if (filterSalonId !== null) {
            worked = scopeSum(new Set([...ids, ...entryOnlyIds]));
          } else {
            // The account Ist only for a person whose every entry of the month is in scope.
            const stammRows =
              ids.length > 0
                ? await getRecordedWorkEntriesInRange(
                    app.prisma,
                    employeeScopeFor(scopedAccess, { employeeIds: ids }),
                    firstDay,
                    lastDay,
                  )
                : [];
            const idSet = new Set(ids);
            const covered = fullyCoveredPersons(
              stammRows,
              monthRows.filter((e) => idSet.has(e.employeeId)),
              ids,
            );
            const sumOver = new Set<string>(entryOnlyIds);
            for (const id of ids) {
              if (covered.has(id)) {
                const figures = await computeMonthReportFigures(app, id, year, month);
                worked += figures.workedMinutes;
                should += figures.expectedMinutes;
              } else {
                sumOver.add(id);
              }
            }
            if (sumOver.size > 0) {
              usedScopeEntries = true;
              worked += scopeSum(sumOver);
            }
          }
        } else if (filterSalonId === null) {
          for (const id of ids) {
            const figures = await computeMonthReportFigures(app, id, year, month);
            worked += figures.workedMinutes;
            should += figures.expectedMinutes;
          }
        } else {
          // D-03/D-12: recorded working time in this salon only, through tenant-local yesterday
          // (today never counts, #438); the Berufsschule credit is attributed to no salon and
          // there is no Soll under a filter (D-05).
          const upper = lastDay < yesterday ? lastDay : yesterday;
          if (ids.length > 0 && upper >= firstDay) {
            const entries = await getRecordedWorkEntriesInRange(
              app.prisma,
              employeeScopeFor(scopedAccess, { employeeIds: ids }),
              firstDay,
              upper,
            );
            worked = entries
              .filter((e) => !e.isInvalid && e.endTime !== null && e.salonId === filterSalonId)
              .reduce((sum: number, e) => addWorkingMinutes(sum, e), 0);
          }
        }

        let sickDays = 0;
        if (ids.length > 0) {
          const rows = await getActiveLeaveOverlapping(
            app.prisma,
            employeeScopeFor(scopedAccess, { employeeIds: ids }),
            firstDay,
            lastDay,
          );
          const byPerson = new Map<string, typeof rows>();
          for (const row of rows) {
            const list = byPerson.get(row.employeeId);
            if (list) list.push(row);
            else byPerson.set(row.employeeId, [row]);
          }
          for (const [personId, personRows] of byPerson) {
            // D-04/D-13: an absence follows the Stammsalon of each counted day.
            const personHome = homeByPerson?.get(personId);
            sickDays += sickLeaveDayCounts(
              personRows,
              firstDay,
              lastDay,
              filterSalonId === null
                ? {}
                : { countsDay: (day: string) => personHome?.get(day) === filterSalonId },
            ).sickDays;
          }
        }

        series.push({
          month: key,
          workedMinutes: Math.round(worked),
          shouldMinutes: Math.round(should),
          sickDays,
        });
      }

      // D-05: under a filter Soll is never shown, whatever the caller may otherwise see. Issue #85
      // (D-06): nor when part of the Ist came from visible entries — Ist and Soll must not mix.
      const workedBasis =
        filterSalonId !== null
          ? ("SALON_ENTRIES" as const)
          : usedScopeEntries
            ? ("SCOPE_ENTRIES" as const)
            : ("ACCOUNT" as const);
      const sollVisible =
        canSeeSoll && sollCovered && filterSalonId === null && workedBasis === "ACCOUNT";
      return {
        salonId: filterSalonId,
        workedBasis,
        sollUnavailableReason: sollVisible
          ? null
          : !canSeeSoll || !sollCovered
            ? ("NO_PERMISSION" as const)
            : filterSalonId !== null
              ? ("SALON_FILTER" as const)
              : ("SCOPE_ENTRIES" as const),
        months: series.map((m) => ({ ...m, shouldMinutes: sollVisible ? m.shouldMinutes : null })),
      };
    },
  });

  // GET /api/v1/dashboard/team-upcoming-leave — the team's next approved leave for the dashboard
  // card (Issue #84, D-08); replaces the card's use of /leave/requests, which stays unchanged.
  //
  // "Upcoming" means the request ends on or after the tenant-local today as a calendar-day bound
  // (D-18, #493): a leave that ends today is still listed. Under a salon filter an absence follows
  // the Stammsalon of its remaining days (D-04): a request is kept when the person is homed in the
  // salon on at least one day from the later of its start and today to its end, so a request that
  // spans a Stammsalon change appears under both salons. The rule itself is
  // `filterLeaveRowsToHomeSalon()` of the Abwesenheiten context (Issue #558). The limit applies
  // after the filter.
  app.get("/team-upcoming-leave", {
    schema: {
      tags: ["Dashboard"],
      security: [{ bearerAuth: [] }],
      summary: "Upcoming approved leave of the team",
      description:
        "The next approved leave requests of the persons in the caller's team-overview reach, " +
        "ending today or later, ordered by start date, at most eight. With salonId only requests " +
        "of persons whose Stammsalon is that salon on at least one remaining day.",
    },
    preHandler: requirePermission("team-overview:read:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { salonId } = teamSalonQuerySchema.parse(req.query);
      const tenantId = req.user.tenantId;
      const access = accessContextFromRequest(req);
      const tz = await getTenantTimezone(app.prisma, tenantId);

      const reach = await resolveAccessReach(app.prisma, access, "team-overview:read:ZUGEWIESEN");
      // D-02/D-16: validated before any data read; one body for every rejection cause.
      const filter = await resolveSalonInReach(app.prisma, tenantId, reach, salonId);
      if (!filter.ok) return reply.code(404).send(TEAM_SALON_NOT_FOUND);
      const filterSalonId = filter.salonId;
      const scopedAccess = { ...access, reach };

      const today = todayInTz(tz);
      const dayString = (d: Date) => d.toISOString().slice(0, 10);
      const todayDay = dayString(today);

      // A scoped reach names an explicit person set (Stammsalon today); a whole-tenant reach is
      // the tenant scope. An empty set answers without a read.
      const scopedIds = await resolveStammsalonScopedEmployeeIds(
        app.prisma,
        tenantId,
        reach,
        today,
      );
      if (scopedIds !== "all" && scopedIds.length === 0) {
        return { salonId: filterSalonId, items: [] };
      }
      const scope =
        scopedIds === "all"
          ? employeeScopeFor(scopedAccess)
          : employeeScopeFor(scopedAccess, { employeeIds: scopedIds });

      let rows = await getApprovedLeaveEndingOnOrAfter(app.prisma, scope, today);
      if (filterSalonId !== null && rows.length > 0) {
        // Issue #558: the Stammsalon-per-day rule (#84 D-04) lives in the Abwesenheiten context;
        // the window starts today, so past days of a running request never attribute it.
        rows = await filterLeaveRowsToHomeSalon(app.prisma, tenantId, rows, filterSalonId, {
          fromDay: todayDay,
        });
      }

      return {
        salonId: filterSalonId,
        items: rows.slice(0, 8).map((r) => ({
          id: r.id,
          employeeId: r.employeeId,
          employeeName: `${r.employee.firstName} ${r.employee.lastName}`,
          startDate: dayString(r.startDate),
          endDate: dayString(r.endDate),
          days: Number(r.days),
          leaveTypeName: r.leaveType.name,
          leaveTypeCode: r.leaveType.code,
        })),
      };
    },
  });
}

// Issue #84 (D-02/D-16): one body for every rejection cause of a salon filter — a foreign
// tenant's salon, an unknown id, an inactive salon and a salon outside the caller's reach are
// indistinguishable (T-100-09).
const TEAM_SALON_NOT_FOUND = { error: "Salon nicht gefunden" } as const;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Keep in sync with overtime.ts status logic
function classifyOvertimeBalance(balanceHours: number): "NORMAL" | "ELEVATED" | "CRITICAL" {
  const abs = Math.abs(balanceHours);
  if (abs <= 20) return "NORMAL";
  if (abs <= 40) return "ELEVATED";
  return "CRITICAL";
}
