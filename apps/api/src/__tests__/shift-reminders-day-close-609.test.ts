/**
 * Issue #609 (AC-3; D-04, D-13, D-15) - the evening DAY_CLOSE reminder, end to end on the production
 * job path. The leave, absence and holiday exclusions are plan 03's; this file proves the core rule:
 * a shift day without recorded time, once per person and day.
 *
 * Every instant is built from an explicit tenant-local date and time (`localInstant`). Each case uses
 * its own person, so the once-per-day dedupe cannot mask a rule.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, cleanupTestData, soleNotification } from "./setup";
import { resolveEmailPolicy } from "../contexts/platform/notification-email-policy";
import { resolvePushPolicy } from "../contexts/platform/notification-push-policy";
import {
  TEST_DAY,
  nextDay,
  addPerson,
  createEntry,
  createShift,
  localInstant,
  remindersOf,
  seedReminderTenant,
  setReminderConfig,
  type ReminderTenant,
} from "./shift-reminder-fixtures-609";

const DAY_CLOSE = "REMINDER_DAY_CLOSE";

let app: FastifyInstance;
const tenantIds: string[] = [];
let tenant: ReminderTenant;

async function tick(day: string, hhmm: string, t: ReminderTenant = tenant): Promise<void> {
  await app.tryShiftReminders(localInstant(day, hhmm, t.tz));
  await app.settlePushDispatch();
}

/** A fresh person of the shared tenant with the given shifts on the test day. */
async function personWithShifts(shifts: [string, string][], day = TEST_DAY) {
  const person = await addPerson(app, tenant);
  for (const [start, end] of shifts) {
    await createShift(app, tenant, person.employeeId, day, start, end);
  }
  return person;
}

beforeAll(async () => {
  app = await getTestApp();
  tenant = await seedReminderTenant(app, "dayclose", { dayCloseEnabled: true });
  tenantIds.push(tenant.tenantId);
});

afterAll(async () => {
  for (const id of tenantIds) await cleanupTestData(app, id);
  await closeTestApp();
});

describe("day-close reminder - the rule (AC-3, D-04)", () => {
  it("sends exactly one notice at 20:00 with the day link and the relation, and stays at one", async () => {
    const p = await personWithShifts([["09:00", "17:00"]]);
    await tick(TEST_DAY, "20:00");
    const first = await soleNotification(app.prisma, {
      where: { userId: p.userId, type: DAY_CLOSE },
    });
    expect(first.link).toBe(`/time-entries?view=list&date=${TEST_DAY}`);
    expect(first.relatedType).toBe("EmployeeDay");
    expect(first.relatedId).toBe(`${p.employeeId}:${TEST_DAY}`);
    expect(first.title).toBe("Zeit fehlt");
    expect(first.message).toBe("Heute fehlt noch deine Zeit. Trag sie jetzt ein.");

    await tick(TEST_DAY, "20:05");
    await app.prisma.notification.update({
      where: { id: first.id },
      data: { dismissedAt: localInstant(TEST_DAY, "20:06") },
    });
    await tick(TEST_DAY, "20:25");
    const again = await soleNotification(app.prisma, {
      where: { userId: p.userId, type: DAY_CLOSE },
    });
    expect(again.id).toBe(first.id);
  });

  it("sends nothing at 19:59 and nothing at 20:30", async () => {
    const early = await personWithShifts([["09:00", "17:00"]]);
    await tick(TEST_DAY, "19:59");
    expect(await remindersOf(app, early.userId)).toHaveLength(0);

    const late = await personWithShifts([["09:00", "17:00"]]);
    await tick(TEST_DAY, "20:30");
    expect(await remindersOf(app, late.userId)).toHaveLength(0);
  });

  it("sends one notice, not two, for two shifts of the day", async () => {
    const p = await personWithShifts([
      ["09:00", "12:00"],
      ["13:00", "17:00"],
    ]);
    await tick(TEST_DAY, "20:00");
    await soleNotification(app.prisma, { where: { userId: p.userId, type: DAY_CLOSE } });
  });

  it("sends one notice for an early and a late shift without entries (08-12 and 18-22)", async () => {
    const p = await personWithShifts([
      ["08:00", "12:00"],
      ["18:00", "22:00"],
    ]);
    await tick(TEST_DAY, "20:00");
    await soleNotification(app.prisma, { where: { userId: p.userId, type: DAY_CLOSE } });
  });

  it("sends nothing to a person without a shift", async () => {
    const q = await addPerson(app, tenant);
    await tick(TEST_DAY, "20:00");
    expect(await remindersOf(app, q.userId)).toHaveLength(0);
  });
});

describe("day-close reminder - recorded time of the day (D-13, D-15)", () => {
  it("sends nothing when a valid closed entry of the day exists", async () => {
    const p = await personWithShifts([["09:00", "17:00"]]);
    await createEntry(
      app,
      tenant,
      p.employeeId,
      localInstant(TEST_DAY, "09:00"),
      localInstant(TEST_DAY, "12:00"),
    );
    await tick(TEST_DAY, "20:00");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
  });

  it("sends nothing when the only closed entry of the day is invalid", async () => {
    const p = await personWithShifts([["09:00", "17:00"]]);
    await createEntry(
      app,
      tenant,
      p.employeeId,
      localInstant(TEST_DAY, "09:00"),
      localInstant(TEST_DAY, "12:00"),
      { isInvalid: true },
    );
    await tick(TEST_DAY, "20:00");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
  });

  it("sends nothing to a person still clocked in (open entry since 13:00)", async () => {
    const p = await personWithShifts([["09:00", "17:00"]]);
    await createEntry(app, tenant, p.employeeId, localInstant(TEST_DAY, "13:00"), null);
    await tick(TEST_DAY, "20:00");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
  });

  it("sends when the only recorded time belongs to the previous day", async () => {
    const p = await personWithShifts([["09:00", "17:00"]]);
    const prev = "2026-11-09";
    await createEntry(
      app,
      tenant,
      p.employeeId,
      localInstant(prev, "09:00"),
      localInstant(prev, "17:00"),
    );
    await tick(TEST_DAY, "20:00");
    expect(await remindersOf(app, p.userId, DAY_CLOSE)).toHaveLength(1);
  });

  it("sends nothing when the only shift ends after the evening time (14:00-21:00)", async () => {
    const p = await personWithShifts([["14:00", "21:00"]]);
    await tick(TEST_DAY, "20:00");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
  });
});

describe("day-close reminder - a window across midnight", () => {
  it("with the evening time 23:50 the notice for the shift day comes at 00:05 of the next day, and none for the new day", async () => {
    const t = await seedReminderTenant(app, "dayclose-late", {
      dayCloseEnabled: true,
      dayCloseTime: "23:50",
    });
    tenantIds.push(t.tenantId);
    const other = await addPerson(app, t);
    await createShift(app, t, t.employeeId, TEST_DAY, "09:00", "17:00");
    await createShift(app, t, other.employeeId, nextDay(TEST_DAY), "09:00", "17:00");
    await tick(nextDay(TEST_DAY), "00:05", t);
    const notice = await soleNotification(app.prisma, {
      where: { userId: t.userId, type: DAY_CLOSE },
    });
    expect(notice.relatedId).toBe(`${t.employeeId}:${TEST_DAY}`);
    expect(notice.link).toBe(`/time-entries?view=list&date=${TEST_DAY}`);
    expect(await remindersOf(app, other.userId)).toHaveLength(0);
  });
});

describe("day-close reminder - switches and opt-out (D-01, D-05)", () => {
  it("a person who switched the evening reminder off gets nothing while a colleague still does", async () => {
    const off = await addPerson(app, tenant, { reminderDayCloseOff: true });
    await createShift(app, tenant, off.employeeId, TEST_DAY, "09:00", "17:00");
    const on = await personWithShifts([["09:00", "17:00"]]);
    await tick(TEST_DAY, "20:00");
    expect(await remindersOf(app, off.userId)).toHaveLength(0);
    expect(await remindersOf(app, on.userId, DAY_CLOSE)).toHaveLength(1);
  });

  it("the start and end opt-outs do not stop the evening reminder", async () => {
    const p = await addPerson(app, tenant, {
      reminderShiftStartOff: true,
      reminderShiftEndOff: true,
    });
    await createShift(app, tenant, p.employeeId, TEST_DAY, "09:00", "17:00");
    await tick(TEST_DAY, "20:00");
    expect(await remindersOf(app, p.userId, DAY_CLOSE)).toHaveLength(1);
  });

  it("sends nothing while the DAY_CLOSE switch is off, even with START and END on", async () => {
    const t = await seedReminderTenant(app, "dayclose-off", {
      startEnabled: true,
      endEnabled: true,
      dayCloseEnabled: false,
    });
    tenantIds.push(t.tenantId);
    await createShift(app, t, t.employeeId, TEST_DAY, "09:00", "17:00");
    await tick(TEST_DAY, "20:00", t);
    expect(await remindersOf(app, t.userId)).toHaveLength(0);
    await setReminderConfig(app, t.tenantId, { dayCloseEnabled: true });
    await tick(TEST_DAY, "20:00", t);
    expect(await remindersOf(app, t.userId, DAY_CLOSE)).toHaveLength(1);
  });
});

describe("day-close reminder - the registries (D-08)", () => {
  it("is never e-mailed and pushed with the neutral one-hour constant", () => {
    expect(resolveEmailPolicy(DAY_CLOSE)?.email).toBe("never");
    expect(resolvePushPolicy(DAY_CLOSE)).toEqual({
      push: "send",
      body: "Heute fehlt noch deine Zeit.",
      ttlSeconds: 3600,
    });
  });
});
