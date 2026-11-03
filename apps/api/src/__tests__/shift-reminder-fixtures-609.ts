/**
 * Issue #609 - shared fixture of the shift-reminder tests.
 *
 * A fixture tenant with its reminder switches, persons with an explicit hire date, planned shifts
 * and recorded entries, all built from tenant-local dates and times (`localInstant`), never from the
 * wall clock. Names are neutral labels, e-mails use the reserved `example.invalid` domain.
 */
import crypto from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import type { FastifyInstance } from "fastify";
import type { FederalState, LeaveRequestStatus } from "@clokr/db";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { createTestSalon, grantSystemRole, seedTestData } from "./setup";

export const DEFAULT_TZ = "Europe/Berlin";
/** Default test week: a Tuesday away from every DST change. */
export const TEST_DAY = "2026-11-10";

export interface ReminderConfig {
  startEnabled?: boolean;
  endEnabled?: boolean;
  dayCloseEnabled?: boolean;
  offsetMinutes?: number;
  dayCloseTime?: string;
  timezone?: string;
}

export interface ReminderTenant {
  tenantId: string;
  salonId: string;
  tz: string;
  /** The seeded employee (hire date 2025-01-01). */
  employeeId: string;
  userId: string;
}

export type PersonOverrides = {
  exitDate?: Date | null;
  anonymized?: boolean;
  userActive?: boolean;
  isTimeTrackingExempt?: boolean;
  reminderShiftStartOff?: boolean;
  reminderShiftEndOff?: boolean;
  reminderDayCloseOff?: boolean;
  hireDate?: Date;
};

/** The UTC instant of a tenant-local wall-clock time, e.g. `localInstant("2026-11-10", "09:15")`. */
export function localInstant(day: string, hhmm: string, tz: string = DEFAULT_TZ): Date {
  return fromZonedTime(`${day}T${hhmm}:00`, tz);
}

/** The calendar day after `day` ("YYYY-MM-DD"), by UTC calendar arithmetic. */
export function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Seeds a tenant with its salon, one employee and the reminder switches/offset/time/time zone. */
export async function seedReminderTenant(
  app: FastifyInstance,
  suffix: string,
  config: ReminderConfig = {},
): Promise<ReminderTenant> {
  const seed = await seedTestData(app, `rem609-${suffix}`);
  await app.prisma.employee.update({
    where: { id: seed.employee.id },
    data: { hireDate: new Date("2025-01-01T00:00:00Z") },
  });
  await setReminderConfig(app, seed.tenant.id, config);
  return {
    tenantId: seed.tenant.id,
    salonId: seed.salonId,
    tz: config.timezone ?? DEFAULT_TZ,
    employeeId: seed.employee.id,
    userId: seed.empUser.id,
  };
}

/** Writes the reminder switches of the tenant (only the given keys). */
export async function setReminderConfig(
  app: FastifyInstance,
  tenantId: string,
  config: ReminderConfig,
): Promise<void> {
  await app.prisma.tenantConfig.update({
    where: { tenantId },
    data: {
      ...(config.startEnabled !== undefined && { reminderShiftStartEnabled: config.startEnabled }),
      ...(config.endEnabled !== undefined && { reminderShiftEndEnabled: config.endEnabled }),
      ...(config.dayCloseEnabled !== undefined && {
        reminderDayCloseEnabled: config.dayCloseEnabled,
      }),
      ...(config.offsetMinutes !== undefined && { reminderOffsetMinutes: config.offsetMinutes }),
      ...(config.dayCloseTime !== undefined && { reminderDayCloseTime: config.dayCloseTime }),
      ...(config.timezone !== undefined && { timezone: config.timezone }),
    },
  });
}

/** A second (or further) person with a user of the tenant. */
export async function addPerson(
  app: FastifyInstance,
  tenant: ReminderTenant,
  overrides: PersonOverrides = {},
): Promise<{ employeeId: string; userId: string }> {
  const tag = crypto.randomUUID().slice(0, 8);
  const user = await app.prisma.user.create({
    data: {
      email: `rem609-${tag}@example.invalid`,
      passwordHash: "ANONYMIZED",
      isActive: overrides.userActive ?? true,
    },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId: tenant.tenantId,
      userId: user.id,
      employeeNumber: String(20_000_000 + Math.floor(Math.random() * 70_000_000)),
      firstName: overrides.anonymized ? "Gelöscht" : "Rem",
      lastName: overrides.anonymized ? `GELÖSCHT-${tag}` : `P609${tag}`,
      hireDate: overrides.hireDate ?? new Date("2025-01-01T00:00:00Z"),
      exitDate: overrides.exitDate ?? null,
      isTimeTrackingExempt: overrides.isTimeTrackingExempt ?? false,
      reminderShiftStartOff: overrides.reminderShiftStartOff ?? false,
      reminderShiftEndOff: overrides.reminderShiftEndOff ?? false,
      reminderDayCloseOff: overrides.reminderDayCloseOff ?? false,
    },
  });
  await grantSystemRole(app.prisma, {
    tenantId: tenant.tenantId,
    userId: user.id,
    role: "EMPLOYEE",
  });
  return { employeeId: employee.id, userId: user.id };
}

/** Applies the person-state overrides to the seeded employee (the first person of the tenant). */
export async function updatePerson(
  app: FastifyInstance,
  employeeId: string,
  userId: string,
  overrides: PersonOverrides,
): Promise<void> {
  await app.prisma.employee.update({
    where: { id: employeeId },
    data: {
      ...(overrides.exitDate !== undefined && { exitDate: overrides.exitDate }),
      ...(overrides.anonymized && {
        firstName: "Gelöscht",
        lastName: `GELÖSCHT-${employeeId.slice(0, 8)}`,
      }),
      ...(overrides.isTimeTrackingExempt !== undefined && {
        isTimeTrackingExempt: overrides.isTimeTrackingExempt,
      }),
      ...(overrides.reminderShiftStartOff !== undefined && {
        reminderShiftStartOff: overrides.reminderShiftStartOff,
      }),
      ...(overrides.reminderShiftEndOff !== undefined && {
        reminderShiftEndOff: overrides.reminderShiftEndOff,
      }),
      ...(overrides.reminderDayCloseOff !== undefined && {
        reminderDayCloseOff: overrides.reminderDayCloseOff,
      }),
    },
  });
  if (overrides.userActive !== undefined) {
    await app.prisma.user.update({
      where: { id: userId },
      data: { isActive: overrides.userActive },
    });
  }
}

/** A planned shift of `employeeId` on the tenant-local `day`; `startTime`/`endTime` are "HH:MM". */
export async function createShift(
  app: FastifyInstance,
  tenant: ReminderTenant,
  employeeId: string,
  day: string,
  startTime: string,
  endTime: string,
  options: { salonId?: string; conflictsWithLeave?: boolean } = {},
): Promise<{ id: string }> {
  return app.prisma.shift.create({
    data: {
      employeeId,
      salonId: options.salonId ?? tenant.salonId,
      date: new Date(`${day}T00:00:00Z`),
      startTime,
      endTime,
      conflictsWithLeave: options.conflictsWithLeave ?? false,
    },
    select: { id: true },
  });
}

/** A recorded WORK entry; open when `end` is null. Its `date` is the tenant-local day of `start`. */
export async function createEntry(
  app: FastifyInstance,
  tenant: ReminderTenant,
  employeeId: string,
  start: Date,
  end: Date | null,
  options: { isInvalid?: boolean; dayOverride?: string; updatedAt?: Date } = {},
): Promise<{ id: string }> {
  const day =
    options.dayOverride ?? new Intl.DateTimeFormat("en-CA", { timeZone: tenant.tz }).format(start); // YYYY-MM-DD
  return app.prisma.timeEntry.create({
    data: {
      employeeId,
      salonId: tenant.salonId,
      date: new Date(`${day}T00:00:00Z`),
      startTime: start,
      endTime: end,
      type: "WORK",
      source: "MANUAL",
      isInvalid: options.isInvalid ?? false,
      // An untouched open entry carries its creation instant; tests that fix the clock pass it.
      ...(options.updatedAt !== undefined && { updatedAt: options.updatedAt }),
    },
    select: { id: true },
  });
}

/** The reminder notices of a user, oldest first (creation time, then id). */
export async function remindersOf(app: FastifyInstance, userId: string, type?: string) {
  return app.prisma.notification.findMany({
    where: { userId, type: type ?? { startsWith: "REMINDER_" } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

type RequestableCode = Parameters<typeof leaveTypeFields>[0];

/** The tenant's leave type of `code` (created on first use). */
async function leaveTypeOf(app: FastifyInstance, tenantId: string, code: RequestableCode) {
  const existing = await app.prisma.leaveType.findFirst({
    where: { tenantId, code },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await app.prisma.leaveType.create({
    data: { tenantId, ...leaveTypeFields(code) },
    select: { id: true },
  });
  return created.id;
}

/** A leave request of `employeeId` for the inclusive tenant-local days `from`..`to`. */
export async function createLeave(
  app: FastifyInstance,
  tenant: ReminderTenant,
  employeeId: string,
  from: string,
  to: string,
  options: { status?: LeaveRequestStatus; code?: RequestableCode; halfDay?: boolean } = {},
): Promise<{ id: string }> {
  return app.prisma.leaveRequest.create({
    data: {
      employeeId,
      leaveTypeId: await leaveTypeOf(app, tenant.tenantId, options.code ?? "VACATION"),
      startDate: new Date(`${from}T00:00:00Z`),
      endDate: new Date(`${to}T00:00:00Z`),
      days: options.halfDay ? 0.5 : 1,
      halfDay: options.halfDay ?? false,
      status: options.status ?? "APPROVED",
    },
    select: { id: true },
  });
}

/** An imposed absence (Berufsschule by default) covering the inclusive days `from`..`to`. */
export async function createAbsence(
  app: FastifyInstance,
  employeeId: string,
  from: string,
  to: string,
  type: "VOCATIONAL_SCHOOL" | "MATERNITY" | "PARENTAL" = "VOCATIONAL_SCHOOL",
): Promise<{ id: string }> {
  return app.prisma.absence.create({
    data: {
      employeeId,
      type,
      startDate: new Date(`${from}T00:00:00Z`),
      endDate: new Date(`${to}T00:00:00Z`),
      days: 1,
      createdBy: "rem609-fixture",
    },
    select: { id: true },
  });
}

/** A manual holiday row of ONE salon on `day`. */
export async function createManualHoliday(
  app: FastifyInstance,
  tenant: ReminderTenant,
  salonId: string,
  day: string,
): Promise<{ id: string }> {
  const salon = await app.prisma.salon.findUniqueOrThrow({
    where: { id: salonId },
    select: { federalState: true },
  });
  return app.prisma.publicHoliday.create({
    data: {
      tenantId: tenant.tenantId,
      salonId,
      date: new Date(`${day}T00:00:00Z`),
      name: "Betriebsfeiertag",
      federalState: salon.federalState,
      year: Number(day.slice(0, 4)),
    },
    select: { id: true },
  });
}

/** A second active salon of the tenant; returns its id. */
export async function addSalon(
  app: FastifyInstance,
  tenant: ReminderTenant,
  federalState?: FederalState,
): Promise<string> {
  const salon = await createTestSalon(app.prisma, tenant.tenantId, {
    name: "Zweiter Salon",
    ...(federalState !== undefined && { federalState }),
  });
  return salon.id;
}
