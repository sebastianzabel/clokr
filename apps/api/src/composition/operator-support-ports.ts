/**
 * Issue #93 (Phase 93b-02, D-05, D-24) — composition seam of the operator's support reads.
 *
 * The operator support routes live in the Unterbau and must not import a business context or read a
 * person model themselves (ADR 0002, Entscheidung 9; the operator source scan). The reads they open
 * under a support access come in through this port, which the composition root hands to the route
 * plugin. It owns no model and carries no rule: it assembles explicit-key DTOs from public exports.
 *
 * Data minimisation (D-05, Art. 5 (1) (c) DSGVO): the employee list selects id, Personalnummer, names
 * and the entry and exit dates only, never the e-mail, birth date, NFC card id, WLAN addresses or
 * avatar. An anonymised employee is listed with its stored (anonymised) values (D-13).
 *
 * Every query below carries the tenant in its `where` (directly, or through `employee: { tenantId }`):
 * the tenant-scoping gate cannot see a composition module that has no request, so the foreign-tenant
 * case of `support-access-grant-93.test.ts` and the source scan of the later support tests are the
 * proof that a read never leaves the tenant of the grant.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import {
  accessContextForJob,
  countActiveSalons,
  employeeScopeFor,
  homeSalonsForDays,
  listSalons,
  redactSupportAuditValue,
  supportEmployeeStatus,
  type OperatorSupportPorts,
  type SupportAbsenceDto,
  type SupportAuditPageDto,
  type SupportContractDto,
  type SupportDayBreakDto,
  type SupportEmployeeDto,
  type SupportEmployeeMonthDto,
  type SupportLeaveRequestDto,
  type SupportMonthEntryDto,
} from "../contexts/platform";
import {
  computeMonthReportFigures,
  dateStrInTz,
  getTenantTimezone,
  monthDateRange,
  todayInTz,
} from "../contexts/working-time-account";
import { getDayBreaksForSupportMonth, getEntriesForSupportMonth } from "../contexts/time-tracking";
import { getAbsencesOverlapping, getLeaveRequestsForSupportMonth } from "../contexts/absence";

async function employeeExists(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
): Promise<boolean> {
  const row = await db.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: { id: true },
  });
  return row !== null;
}

async function listEmployees(
  app: FastifyInstance,
  tenantId: string,
): Promise<SupportEmployeeDto[]> {
  const tz = await getTenantTimezone(app.prisma, tenantId);
  const today = todayInTz(tz);
  const todayDay = today.toISOString().slice(0, 10);
  const now = new Date();

  const employees = await app.prisma.employee.findMany({
    where: { tenantId },
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      hireDate: true,
      exitDate: true,
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
  });
  if (employees.length === 0) return [];
  const ids = employees.map((employee) => employee.id);

  // Current contract type: the newest row that is already valid. A person whose first contract starts
  // in the future has none yet.
  const schedules = await app.prisma.workSchedule.findMany({
    where: { employee: { tenantId }, employeeId: { in: ids }, validFrom: { lte: now } },
    orderBy: [{ validFrom: "desc" }, { id: "asc" }],
    select: { employeeId: true, type: true },
  });
  const scheduleTypeByEmployee = new Map<string, string>();
  for (const schedule of schedules) {
    if (!scheduleTypeByEmployee.has(schedule.employeeId)) {
      scheduleTypeByEmployee.set(schedule.employeeId, schedule.type);
    }
  }

  // Stammsalon of today; inactive salons stay in the lookup (a person may still belong to one).
  const homeByEmployee = await homeSalonsForDays(app.prisma, tenantId, ids, todayDay, todayDay);
  const salons = await listSalons(app.prisma, tenantId, { includeInactive: true });
  const salonNameById = new Map(salons.map((salon) => [salon.id, salon.name]));

  return employees.map((employee) => {
    const homeSalonId = homeByEmployee.get(employee.id)?.get(todayDay) ?? null;
    const homeSalonName = homeSalonId === null ? undefined : salonNameById.get(homeSalonId);
    return {
      id: employee.id,
      employeeNumber: employee.employeeNumber,
      firstName: employee.firstName,
      lastName: employee.lastName,
      hireDate: dateStrInTz(employee.hireDate, tz),
      exitDate: employee.exitDate ? dateStrInTz(employee.exitDate, tz) : null,
      status: supportEmployeeStatus(employee, today),
      homeSalon:
        homeSalonId !== null && homeSalonName !== undefined
          ? { id: homeSalonId, name: homeSalonName }
          : null,
      scheduleType: scheduleTypeByEmployee.get(employee.id) ?? null,
    };
  });
}

/** A `@db.Date` value (stored as UTC midnight) as its calendar day, `YYYY-MM-DD`. */
function calendarDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * The month of one employee (D-05(2)). The caller (`runSupportRead`) has already resolved the employee
 * inside the tenant in the audit transaction; every read below still carries the tenant itself.
 *
 * Calendar-day bounds (`monthDateRange`, Issue #493) feed every `@db.Date` column — never the month
 * instants. Every DTO is built from explicit keys: the facade `select`s already exclude the free text,
 * and this mapping is the second layer, so a column added to a `select` later does not reach the wire.
 */
async function employeeMonth(
  app: FastifyInstance,
  input: { tenantId: string; employeeId: string; year: number; month: number },
): Promise<SupportEmployeeMonthDto> {
  const { tenantId, employeeId, year, month } = input;
  const tz = await getTenantTimezone(app.prisma, tenantId);
  const { firstDay, lastDay } = monthDateRange(year, month, tz);

  const employee = await app.prisma.employee.findFirstOrThrow({
    where: { id: employeeId, tenantId },
    select: { id: true, employeeNumber: true, firstName: true, lastName: true, exitDate: true },
  });

  const [entries, dayBreaks, leaveRequests, absences] = await Promise.all([
    getEntriesForSupportMonth(app.prisma, tenantId, employeeId, firstDay, lastDay),
    getDayBreaksForSupportMonth(app.prisma, tenantId, employeeId, firstDay, lastDay),
    getLeaveRequestsForSupportMonth(app.prisma, tenantId, employeeId, firstDay, lastDay),
    getAbsencesOverlapping(
      app.prisma,
      employeeScopeFor(accessContextForJob(tenantId, "operator-support"), { employeeId }),
      firstDay,
      lastDay,
    ),
  ]);

  // The figures resolve holidays per salon and throw for a tenant without an active salon — checked
  // up front, never by catching the error message.
  let figures: SupportEmployeeMonthDto["figures"] = null;
  let snapshot: SupportEmployeeMonthDto["snapshot"] = null;
  let figuresUnavailableReason: SupportEmployeeMonthDto["figuresUnavailableReason"] =
    "NO_ACTIVE_SALON";
  if ((await countActiveSalons(app.prisma, tenantId)) > 0) {
    const computed = await computeMonthReportFigures(app, employeeId, year, month);
    figures = {
      workedMinutes: computed.workedMinutes,
      expectedMinutes: computed.expectedMinutes,
      balanceMinutes: computed.balanceMinutes,
      balanceAdjustmentMinutes: computed.balanceAdjustmentMinutes,
      basis: computed.basis,
    };
    snapshot = { confirmed: computed.confirmed, basis: computed.basis };
    figuresUnavailableReason = null;
  }

  const entryDtos: SupportMonthEntryDto[] = entries.map((row) => ({
    id: row.id,
    date: calendarDay(row.date),
    startTime: row.startTime.toISOString(),
    endTime: row.endTime ? row.endTime.toISOString() : null,
    breakMinutes: row.breakMinutes,
    breaks: row.breaks.map((b) => ({
      startTime: b.startTime.toISOString(),
      endTime: b.endTime.toISOString(),
    })),
    breakStatus: row.breakStatus,
    salon: { id: row.salon.id, name: row.salon.name },
    type: row.type,
    source: row.source,
    isInvalid: row.isInvalid,
    invalidReasonCode: row.invalidReasonCode,
    deleted: row.deletedAt !== null,
    isLocked: row.isLocked,
  }));
  const dayBreakDtos: SupportDayBreakDto[] = dayBreaks.map((row) => ({
    id: row.id,
    date: calendarDay(row.date),
    startTime: row.startTime.toISOString(),
    endTime: row.endTime.toISOString(),
  }));
  const leaveDtos: SupportLeaveRequestDto[] = leaveRequests.map((row) => ({
    id: row.id,
    typeCode: row.leaveType.code,
    typeName: row.leaveType.name,
    status: row.status,
    startDate: calendarDay(row.startDate),
    endDate: calendarDay(row.endDate),
    halfDay: row.halfDay,
    days: Number(row.days),
    daysProvisional: row.daysProvisional,
  }));
  const absenceDtos: SupportAbsenceDto[] = absences.map((row) => ({
    id: row.id,
    type: row.type,
    source: row.source,
    startDate: calendarDay(row.startDate),
    endDate: calendarDay(row.endDate),
    halfDay: row.halfDay,
  }));

  return {
    employee: {
      id: employee.id,
      employeeNumber: employee.employeeNumber,
      firstName: employee.firstName,
      lastName: employee.lastName,
      status: supportEmployeeStatus(employee, todayInTz(tz)),
    },
    month: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`,
    timezone: tz,
    entries: entryDtos,
    dayBreaks: dayBreakDtos,
    leaveRequests: leaveDtos,
    absences: absenceDtos,
    figures,
    figuresUnavailableReason,
    snapshot,
  };
}

/**
 * The contract history of one employee, newest `validFrom` first (D-05(3)). The hour columns are
 * passed through as stored: `{day}Hours` is authoritative only for FIXED_SCHEDULE and a divergent legacy
 * row is never "corrected" (CLAUDE.md Phase 95b, D-01).
 */
async function employeeContracts(
  app: FastifyInstance,
  input: { tenantId: string; employeeId: string },
): Promise<SupportContractDto[]> {
  const rows = await app.prisma.workSchedule.findMany({
    where: { employeeId: input.employeeId, employee: { tenantId: input.tenantId } },
    orderBy: [{ validFrom: "desc" }, { id: "asc" }],
    select: {
      id: true,
      type: true,
      validFrom: true,
      weeklyHours: true,
      monthlyHours: true,
      mondayHours: true,
      tuesdayHours: true,
      wednesdayHours: true,
      thursdayHours: true,
      fridayHours: true,
      saturdayHours: true,
      sundayHours: true,
      workDays: true,
      contractWorkDaysPerWeek: true,
      usualWorkDays: true,
      overtimeMode: true,
      overtimeThreshold: true,
      allowOvertimePayout: true,
      maxNegativeBalanceMinutes: true,
      coreStart: true,
      coreEnd: true,
      coreDays: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    validFrom: row.validFrom.toISOString(),
    weeklyHours: row.weeklyHours === null ? null : Number(row.weeklyHours),
    monthlyHours: row.monthlyHours === null ? null : Number(row.monthlyHours),
    dayHours: {
      monday: Number(row.mondayHours),
      tuesday: Number(row.tuesdayHours),
      wednesday: Number(row.wednesdayHours),
      thursday: Number(row.thursdayHours),
      friday: Number(row.fridayHours),
      saturday: Number(row.saturdayHours),
      sunday: Number(row.sundayHours),
    },
    workDays: row.workDays,
    contractWorkDaysPerWeek: row.contractWorkDaysPerWeek,
    usualWorkDays: row.usualWorkDays,
    overtimeMode: row.overtimeMode,
    overtimeThreshold: Number(row.overtimeThreshold),
    allowOvertimePayout: row.allowOvertimePayout,
    maxNegativeBalanceMinutes: row.maxNegativeBalanceMinutes,
    coreStart: row.coreStart,
    coreEnd: row.coreEnd,
    coreDays: row.coreDays,
  }));
}

/** Rows per page of the support audit-log read (Phase 93b-05 discretion; the page size is not client-controlled). */
const AUDIT_PAGE_SIZE = 50;

const MS_PER_DAY = 86_400_000;

/**
 * One page of the tenant's own change log (D-05(4), D-17, D-26). Same tenant scope as the tenant
 * `GET /audit-logs` (`contexts/platform/api/audit-logs.ts`), spelled inline in its own `AND` member so no
 * filter can widen it: rows written by a tenant user, and rows written by the operator principal, which
 * have no user and carry the tenant in their `newValue.actor` stamp. The window is the UTC calendar days
 * `[from 00:00Z, to + 1 day 00:00Z)`; it is a filter, not a legal figure.
 *
 * `employeeId` (D-26) matches a row about the employee (`entityId`) or a row whose old or new value
 * carries `employeeId` — no inference beyond that. Every `oldValue`/`newValue` leaves through
 * `redactSupportAuditValue`; the acting user's e-mail is never selected.
 */
async function auditPage(
  app: FastifyInstance,
  input: { tenantId: string; employeeId?: string; from: string; to: string; page: number },
): Promise<SupportAuditPageDto> {
  const { tenantId, employeeId, from, to, page } = input;
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + MS_PER_DAY);

  // D-26: only present with an employee filter. A plain array member, so the tenant scope below stays
  // spelled inline in both queries (the tenant-scoping gate does not follow helpers).
  const employeeClause: Prisma.AuditLogWhereInput[] =
    employeeId === undefined
      ? []
      : [
          {
            OR: [
              { entityId: employeeId },
              { newValue: { path: ["employeeId"], equals: employeeId } },
              { oldValue: { path: ["employeeId"], equals: employeeId } },
            ],
          },
        ];

  const [rows, total] = await Promise.all([
    app.prisma.auditLog.findMany({
      where: {
        AND: [
          {
            OR: [
              { user: { employee: { tenantId } } },
              { userId: null, newValue: { path: ["actor", "tenantId"], equals: tenantId } },
            ],
          },
          { createdAt: { gte: start, lt: end } },
          ...employeeClause,
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: AUDIT_PAGE_SIZE,
      skip: (page - 1) * AUDIT_PAGE_SIZE,
      select: {
        id: true,
        createdAt: true,
        action: true,
        entity: true,
        entityId: true,
        userId: true,
        oldValue: true,
        newValue: true,
      },
    }),
    app.prisma.auditLog.count({
      where: {
        AND: [
          {
            OR: [
              { user: { employee: { tenantId } } },
              { userId: null, newValue: { path: ["actor", "tenantId"], equals: tenantId } },
            ],
          },
          { createdAt: { gte: start, lt: end } },
          ...employeeClause,
        ],
      },
    }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      userId: row.userId,
      oldValue: redactSupportAuditValue(row.oldValue),
      newValue: redactSupportAuditValue(row.newValue),
    })),
    total,
    page,
    pageSize: AUDIT_PAGE_SIZE,
    from,
    to,
  };
}

export const operatorSupportPorts = {
  employeeExists,
  listEmployees,
  employeeMonth,
  employeeContracts,
  auditPage,
} satisfies OperatorSupportPorts;
