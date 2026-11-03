/**
 * Issue #609 (AC-5; D-05) - a reminder reaches only the shift's own person: never a manager, never a
 * deactivated tenant, never across tenants, and for END and DAY_CLOSE the same excluded persons as
 * for START (exited, anonymised, login-deactivated, exempt from time tracking).
 *
 * Every instant is built from an explicit tenant-local date and time (`localInstant`). Notice counts
 * are read per user with explicit lengths, never with `findFirst`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, cleanupTestData, grantSystemRole } from "./setup";
import {
  addPerson,
  createEntry,
  createShift,
  localInstant,
  remindersOf,
  seedReminderTenant,
  type PersonOverrides,
  type ReminderTenant,
} from "./shift-reminder-fixtures-609";

const START = "REMINDER_SHIFT_START";
const END = "REMINDER_SHIFT_END";
const DAY_CLOSE = "REMINDER_DAY_CLOSE";
const DAY_1 = "2026-11-10";
const DAY_2 = "2026-11-11";
const DAY_3 = "2026-11-12";
const ALL_ON = { startEnabled: true, endEnabled: true, dayCloseEnabled: true };

let app: FastifyInstance;
const tenantIds: string[] = [];

async function tick(t: ReminderTenant, day: string, hhmm: string): Promise<void> {
  await app.tryShiftReminders(localInstant(day, hhmm, t.tz));
  await app.settlePushDispatch();
}

/** Gives `employeeId` a due START (day 1), END (day 2, open entry) and DAY_CLOSE (day 3) situation. */
async function threeSituations(t: ReminderTenant, employeeId: string): Promise<void> {
  await createShift(app, t, employeeId, DAY_1, "09:00", "17:00");
  await createShift(app, t, employeeId, DAY_2, "09:00", "17:00");
  await createEntry(app, t, employeeId, localInstant(DAY_2, "09:00", t.tz), null);
  await createShift(app, t, employeeId, DAY_3, "09:00", "17:00");
}

async function fireAll(t: ReminderTenant): Promise<void> {
  await tick(t, DAY_1, "09:15");
  await tick(t, DAY_2, "17:15");
  // The person clocks out afterwards: an open entry of the day before would silence the evening notice (D-13).
  await app.prisma.timeEntry.updateMany({
    where: { employee: { tenantId: t.tenantId }, endTime: null },
    data: { endTime: localInstant(DAY_2, "17:30", t.tz) },
  });
  await tick(t, DAY_3, "20:00");
}

afterAll(async () => {
  for (const id of tenantIds) await cleanupTestData(app, id);
  await closeTestApp();
});

beforeAll(async () => {
  app = await getTestApp();
});

describe("only the shift's own person is notified (AC-5, D-05)", () => {
  it("a tenant admin and a manager without a shift get nothing about an employee's three situations", async () => {
    const t = await seedReminderTenant(app, "recipients", ALL_ON);
    tenantIds.push(t.tenantId);
    const manager = await addPerson(app, t);
    await grantSystemRole(app.prisma, {
      tenantId: t.tenantId,
      userId: manager.userId,
      role: "MANAGER",
    });
    const admin = await app.prisma.user.findFirstOrThrow({
      where: { email: { startsWith: "admin-rem609-recipients" } },
      select: { id: true },
    });
    await threeSituations(t, t.employeeId);
    await fireAll(t);

    expect(await remindersOf(app, t.userId, START)).toHaveLength(1);
    expect(await remindersOf(app, t.userId, END)).toHaveLength(1);
    expect(await remindersOf(app, t.userId, DAY_CLOSE)).toHaveLength(1);
    expect(await remindersOf(app, t.userId)).toHaveLength(3);
    expect(await remindersOf(app, admin.id)).toHaveLength(0);
    expect(await remindersOf(app, manager.userId)).toHaveLength(0);
  });

  it("a manager with a shift of his own gets exactly his own START notice and none about the employee", async () => {
    const t = await seedReminderTenant(app, "recipients-mgr", { startEnabled: true });
    tenantIds.push(t.tenantId);
    const manager = await addPerson(app, t);
    await grantSystemRole(app.prisma, {
      tenantId: t.tenantId,
      userId: manager.userId,
      role: "MANAGER",
    });
    const shiftOfEmployee = await createShift(app, t, t.employeeId, DAY_1, "09:00", "17:00");
    const shiftOfManager = await createShift(app, t, manager.employeeId, DAY_1, "09:00", "17:00");
    await tick(t, DAY_1, "09:15");

    const own = await remindersOf(app, manager.userId);
    expect(own).toHaveLength(1);
    expect(own[0]?.relatedId).toBe(shiftOfManager.id);
    const employeeNotices = await remindersOf(app, t.userId);
    expect(employeeNotices).toHaveLength(1);
    expect(employeeNotices[0]?.relatedId).toBe(shiftOfEmployee.id);
  });
});

describe("tenants (AC-5)", () => {
  it("a deactivated tenant gets nothing; after reactivation the same tick sends exactly one", async () => {
    const t = await seedReminderTenant(app, "recipients-off", { startEnabled: true });
    tenantIds.push(t.tenantId);
    await createShift(app, t, t.employeeId, DAY_1, "09:00", "17:00");
    await app.prisma.tenant.update({
      where: { id: t.tenantId },
      data: { deactivatedAt: new Date() },
    });
    await tick(t, DAY_1, "09:15");
    expect(await remindersOf(app, t.userId)).toHaveLength(0);

    await app.prisma.tenant.update({ where: { id: t.tenantId }, data: { deactivatedAt: null } });
    await tick(t, DAY_1, "09:15");
    expect(await remindersOf(app, t.userId)).toHaveLength(1);
  });

  it("a due start in tenant B notifies only B's person, none of tenant A", async () => {
    const a = await seedReminderTenant(app, "recipients-a", { startEnabled: true });
    const b = await seedReminderTenant(app, "recipients-b", { startEnabled: true });
    tenantIds.push(a.tenantId, b.tenantId);
    const aSecond = await addPerson(app, a);
    await createShift(app, a, a.employeeId, DAY_1, "15:00", "20:00"); // not due at 09:15
    await createShift(app, a, aSecond.employeeId, DAY_1, "15:00", "20:00");
    await createShift(app, b, b.employeeId, DAY_1, "09:00", "17:00");
    await tick(b, DAY_1, "09:15");

    expect(await remindersOf(app, b.userId)).toHaveLength(1);
    expect(await remindersOf(app, a.userId)).toHaveLength(0);
    expect(await remindersOf(app, aSecond.userId)).toHaveLength(0);
  });

  it("due shifts in both tenants: each person gets only the own notice", async () => {
    const a = await seedReminderTenant(app, "recipients-a2", { startEnabled: true });
    const b = await seedReminderTenant(app, "recipients-b2", { startEnabled: true });
    tenantIds.push(a.tenantId, b.tenantId);
    const sa = await createShift(app, a, a.employeeId, DAY_1, "09:00", "17:00");
    const sb = await createShift(app, b, b.employeeId, DAY_1, "09:00", "17:00");
    await tick(a, DAY_1, "09:15");

    const noticesA = await remindersOf(app, a.userId);
    const noticesB = await remindersOf(app, b.userId);
    expect(noticesA).toHaveLength(1);
    expect(noticesB).toHaveLength(1);
    expect(noticesA[0]?.relatedId).toBe(sa.id);
    expect(noticesB[0]?.relatedId).toBe(sb.id);
  });
});

const PERSON_KINDS: [string, PersonOverrides][] = [
  ["an exited person (exit day before the shift)", { exitDate: new Date("2026-11-01T00:00:00Z") }],
  ["an anonymised person", { anonymized: true }],
  ["a login-deactivated person", { userActive: false }],
  ["a person exempt from time tracking", { isTimeTrackingExempt: true }],
];

describe.each([
  ["END", END, "17:15", true],
  ["DAY_CLOSE", DAY_CLOSE, "20:00", false],
] as const)("excluded persons - %s", (_name, type, tickAt, openEntry) => {
  let t: ReminderTenant;

  beforeAll(async () => {
    t = await seedReminderTenant(app, `recipients-${_name.toLowerCase()}`, ALL_ON);
    tenantIds.push(t.tenantId);
  });

  async function situation(overrides: PersonOverrides) {
    const p = await addPerson(app, t, overrides);
    await createShift(app, t, p.employeeId, DAY_1, "09:00", "17:00");
    if (openEntry) {
      await createEntry(app, t, p.employeeId, localInstant(DAY_1, "09:00", t.tz), null);
    }
    return p;
  }

  it("an ordinary person gets one notice (control)", async () => {
    const p = await situation({});
    await tick(t, DAY_1, tickAt);
    expect(await remindersOf(app, p.userId, type)).toHaveLength(1);
  });

  it.each(PERSON_KINDS)("%s gets none", async (_kind, overrides) => {
    const p = await situation(overrides);
    await tick(t, DAY_1, tickAt);
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
  });
});
