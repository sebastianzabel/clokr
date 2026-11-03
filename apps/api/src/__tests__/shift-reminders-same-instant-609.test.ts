/**
 * Issue #609 (AC "exactly one reminder") - two shifts of the SAME person whose start (or end)
 * resolve to the identical instant give ONE start (or end) notice, not two. The dedupe key is the
 * person, the occasion and the instant in addition to the shift id; it holds inside one tick and
 * across ticks (the first notice is read back from the database).
 *
 * Every instant is built from an explicit tenant-local date and time (`localInstant`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import {
  TEST_DAY,
  addPerson,
  addSalon,
  createEntry,
  createShift,
  localInstant,
  remindersOf,
  seedReminderTenant,
  type ReminderTenant,
} from "./shift-reminder-fixtures-609";

const START = "REMINDER_SHIFT_START";
const END = "REMINDER_SHIFT_END";

let app: FastifyInstance;
let tenant: ReminderTenant;
let secondSalonId: string;

async function tick(hhmm: string): Promise<void> {
  await app.tryShiftReminders(localInstant(TEST_DAY, hhmm, tenant.tz));
  await app.settlePushDispatch();
}

beforeAll(async () => {
  app = await getTestApp();
  tenant = await seedReminderTenant(app, "sameinstant", { startEnabled: true, endEnabled: true });
  secondSalonId = await addSalon(app, tenant);
});

afterAll(async () => {
  await cleanupTestData(app, tenant.tenantId);
  await closeTestApp();
});

describe("two shifts at the identical instant give one notice (exactly one reminder)", () => {
  it("START: two shifts starting at 09:00 in one tick give one notice", async () => {
    const p = await addPerson(app, tenant);
    await createShift(app, tenant, p.employeeId, TEST_DAY, "09:00", "12:00");
    await createShift(app, tenant, p.employeeId, TEST_DAY, "09:00", "17:00", {
      salonId: secondSalonId,
    });
    await tick("09:15");
    expect(await remindersOf(app, p.userId, START)).toHaveLength(1);
    await tick("09:20");
    expect(await remindersOf(app, p.userId, START)).toHaveLength(1);
  });

  it("START: a second shift at the same instant created after the first notice gives no second one", async () => {
    const p = await addPerson(app, tenant);
    await createShift(app, tenant, p.employeeId, TEST_DAY, "09:00", "12:00");
    await tick("09:15");
    expect(await remindersOf(app, p.userId, START)).toHaveLength(1);
    await createShift(app, tenant, p.employeeId, TEST_DAY, "09:00", "17:00", {
      salonId: secondSalonId,
    });
    await tick("09:20");
    expect(await remindersOf(app, p.userId, START)).toHaveLength(1);
  });

  it("START: shifts at different instants each get their notice (control)", async () => {
    const p = await addPerson(app, tenant);
    await createShift(app, tenant, p.employeeId, TEST_DAY, "09:00", "12:00");
    await createShift(app, tenant, p.employeeId, TEST_DAY, "09:05", "17:00", {
      salonId: secondSalonId,
    });
    await tick("09:20");
    expect(await remindersOf(app, p.userId, START)).toHaveLength(2);
  });

  it("START: another person's shift at the same instant still gets its own notice (control)", async () => {
    const a = await addPerson(app, tenant);
    const b = await addPerson(app, tenant);
    await createShift(app, tenant, a.employeeId, TEST_DAY, "09:00", "12:00");
    await createShift(app, tenant, b.employeeId, TEST_DAY, "09:00", "12:00");
    await tick("09:15");
    expect(await remindersOf(app, a.userId, START)).toHaveLength(1);
    expect(await remindersOf(app, b.userId, START)).toHaveLength(1);
  });

  it("END: two shifts ending at 17:00 in one tick give one notice, also on the next tick", async () => {
    const p = await addPerson(app, tenant);
    await createShift(app, tenant, p.employeeId, TEST_DAY, "09:00", "17:00");
    await createShift(app, tenant, p.employeeId, TEST_DAY, "13:00", "17:00", {
      salonId: secondSalonId,
    });
    await createEntry(app, tenant, p.employeeId, localInstant(TEST_DAY, "09:00", tenant.tz), null);
    await tick("17:15");
    expect(await remindersOf(app, p.userId, END)).toHaveLength(1);
    await tick("17:20");
    expect(await remindersOf(app, p.userId, END)).toHaveLength(1);
  });

  it("END: a second shift at the same end instant created after the first notice gives no second one", async () => {
    const p = await addPerson(app, tenant);
    await createShift(app, tenant, p.employeeId, TEST_DAY, "09:00", "17:00");
    await createEntry(app, tenant, p.employeeId, localInstant(TEST_DAY, "09:00", tenant.tz), null);
    await tick("17:15");
    expect(await remindersOf(app, p.userId, END)).toHaveLength(1);
    await createShift(app, tenant, p.employeeId, TEST_DAY, "13:00", "17:00", {
      salonId: secondSalonId,
    });
    await tick("17:20");
    expect(await remindersOf(app, p.userId, END)).toHaveLength(1);
  });
});
