/**
 * Issue #609 (AC-2; D-04, D-06, D-07) - the shift END reminder, end to end on the production job path.
 *
 * Every instant is built from an explicit tenant-local date and time (`localInstant`); the job takes
 * its "now" as a parameter through the `tryShiftReminders` decorator. Each case uses its own person
 * (and shift), so the once-per-shift dedupe cannot mask a rule.
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

const END = "REMINDER_SHIFT_END";
const START = "REMINDER_SHIFT_START";

let app: FastifyInstance;
const tenantIds: string[] = [];
let tenant: ReminderTenant;

async function tick(day: string, hhmm: string, tz?: string): Promise<void> {
  await app.tryShiftReminders(localInstant(day, hhmm, tz ?? tenant.tz));
  await app.settlePushDispatch();
}

/** A fresh person of the shared tenant with a 09:00-17:00 shift on the test day. */
async function personWithShift(start = "09:00", end = "17:00", day = TEST_DAY) {
  const person = await addPerson(app, tenant);
  const shift = await createShift(app, tenant, person.employeeId, day, start, end);
  return { ...person, shiftId: shift.id };
}

beforeAll(async () => {
  app = await getTestApp();
  tenant = await seedReminderTenant(app, "end", { endEnabled: true, offsetMinutes: 15 });
  tenantIds.push(tenant.tenantId);
});

afterAll(async () => {
  for (const id of tenantIds) await cleanupTestData(app, id);
  await closeTestApp();
});

describe("shift end reminder - the tracer rule (AC-2, D-04)", () => {
  it("sends exactly one notice at 17:15 to a person still clocked in, and stays at one", async () => {
    const p = await personWithShift();
    await createEntry(app, tenant, p.employeeId, localInstant(TEST_DAY, "08:58"), null);
    await tick(TEST_DAY, "17:15");
    const first = await soleNotification(app.prisma, { where: { userId: p.userId, type: END } });
    expect(first.link).toBe("/dashboard?clock=1");
    expect(first.relatedType).toBe("Shift");
    expect(first.relatedId).toBe(p.shiftId);
    expect(first.title).toBe("Schichtende");
    expect(first.message).toBe("Deine Schicht endete um 17:00. Feierabend? Jetzt ausstempeln.");

    await tick(TEST_DAY, "17:20");
    await app.prisma.notification.update({
      where: { id: first.id },
      data: { dismissedAt: localInstant(TEST_DAY, "17:21") },
    });
    await tick(TEST_DAY, "17:25");
    const again = await soleNotification(app.prisma, { where: { userId: p.userId, type: END } });
    expect(again.id).toBe(first.id);
  });

  it("sends nothing before the offset (17:14) and after the window (18:15)", async () => {
    const early = await personWithShift();
    await createEntry(app, tenant, early.employeeId, localInstant(TEST_DAY, "08:58"), null);
    await tick(TEST_DAY, "17:14");
    expect(await remindersOf(app, early.userId)).toHaveLength(0);

    const late = await personWithShift();
    await createEntry(app, tenant, late.employeeId, localInstant(TEST_DAY, "08:58"), null);
    await tick(TEST_DAY, "18:15");
    expect(await remindersOf(app, late.userId)).toHaveLength(0);
  });

  it("is still due at 18:14", async () => {
    const p = await personWithShift();
    await createEntry(app, tenant, p.employeeId, localInstant(TEST_DAY, "08:58"), null);
    await tick(TEST_DAY, "18:14");
    expect(await remindersOf(app, p.userId, END)).toHaveLength(1);
  });

  it("sends nothing to a person who already clocked out (closed entry 08:58-17:02)", async () => {
    const p = await personWithShift();
    await createEntry(
      app,
      tenant,
      p.employeeId,
      localInstant(TEST_DAY, "08:58"),
      localInstant(TEST_DAY, "17:02"),
    );
    await tick(TEST_DAY, "17:15");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
  });

  it("sends nothing to a person without an entry", async () => {
    const p = await personWithShift();
    await tick(TEST_DAY, "17:15");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
  });

  it("sends nothing for an open entry opened after the shift end (17:05)", async () => {
    const p = await personWithShift();
    await createEntry(app, tenant, p.employeeId, localInstant(TEST_DAY, "17:05"), null);
    await tick(TEST_DAY, "17:15");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
  });

  it("ignores an invalid open entry", async () => {
    const p = await personWithShift();
    await createEntry(app, tenant, p.employeeId, localInstant(TEST_DAY, "08:58"), null, {
      isInvalid: true,
    });
    await tick(TEST_DAY, "17:15");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
  });
});

describe("shift end reminder - several shifts of one day (D-07)", () => {
  it("an adjacent next shift (09-13, 13-17) gives no notice at 13:15, one at 17:15", async () => {
    const person = await addPerson(app, tenant);
    await createShift(app, tenant, person.employeeId, TEST_DAY, "09:00", "13:00");
    const second = await createShift(app, tenant, person.employeeId, TEST_DAY, "13:00", "17:00");
    await createEntry(app, tenant, person.employeeId, localInstant(TEST_DAY, "09:00"), null);
    await tick(TEST_DAY, "13:15");
    expect(await remindersOf(app, person.userId)).toHaveLength(0);
    await tick(TEST_DAY, "17:15");
    const notice = await soleNotification(app.prisma, {
      where: { userId: person.userId, type: END },
    });
    expect(notice.relatedId).toBe(second.id);
  });

  it("a split shift (09-12, 14-17) gives the first shift its own notice at 12:15", async () => {
    const person = await addPerson(app, tenant);
    const first = await createShift(app, tenant, person.employeeId, TEST_DAY, "09:00", "12:00");
    await createShift(app, tenant, person.employeeId, TEST_DAY, "14:00", "17:00");
    await createEntry(app, tenant, person.employeeId, localInstant(TEST_DAY, "09:00"), null);
    await tick(TEST_DAY, "12:15");
    const notice = await soleNotification(app.prisma, {
      where: { userId: person.userId, type: END },
    });
    expect(notice.relatedId).toBe(first.id);
    expect(notice.message).toBe("Deine Schicht endete um 12:00. Feierabend? Jetzt ausstempeln.");
  });
});

describe("shift end reminder - overnight and DST (D-03)", () => {
  it("an overnight shift 22:00-06:00 is reminded at 06:15 of the next local day", async () => {
    const p = await personWithShift("22:00", "06:00");
    await createEntry(app, tenant, p.employeeId, localInstant(TEST_DAY, "21:58"), null);
    await tick(nextDay(TEST_DAY), "06:14");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
    await tick(nextDay(TEST_DAY), "06:15");
    const notice = await soleNotification(app.prisma, { where: { userId: p.userId, type: END } });
    expect(notice.relatedId).toBe(p.shiftId);
    expect(notice.message).toBe("Deine Schicht endete um 6:00. Feierabend? Jetzt ausstempeln.");
  });

  it("the fall-back night 2026-10-24 22:00 - 2026-10-25 06:00 ends at 06:15 local, not at 05:15", async () => {
    const day = "2026-10-24";
    const p = await personWithShift("22:00", "06:00", day);
    await createEntry(app, tenant, p.employeeId, localInstant(day, "21:58"), null);
    expect(localInstant("2026-10-25", "06:15").toISOString()).toBe("2026-10-25T05:15:00.000Z");
    await tick("2026-10-25", "05:15");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
    await tick("2026-10-25", "06:15");
    expect(await remindersOf(app, p.userId, END)).toHaveLength(1);
  });
});

describe("shift end reminder - switches and opt-out (D-01, D-05)", () => {
  it("a person who switched the end reminder off gets nothing while a colleague still does", async () => {
    const off = await addPerson(app, tenant, { reminderShiftEndOff: true });
    await createShift(app, tenant, off.employeeId, TEST_DAY, "09:00", "17:00");
    await createEntry(app, tenant, off.employeeId, localInstant(TEST_DAY, "08:58"), null);
    const on = await personWithShift();
    await createEntry(app, tenant, on.employeeId, localInstant(TEST_DAY, "08:58"), null);
    await tick(TEST_DAY, "17:15");
    expect(await remindersOf(app, off.userId)).toHaveLength(0);
    expect(await remindersOf(app, on.userId, END)).toHaveLength(1);
  });

  it("the start opt-out does not stop the end reminder", async () => {
    const p = await addPerson(app, tenant, { reminderShiftStartOff: true });
    await createShift(app, tenant, p.employeeId, TEST_DAY, "09:00", "17:00");
    await createEntry(app, tenant, p.employeeId, localInstant(TEST_DAY, "08:58"), null);
    await tick(TEST_DAY, "17:15");
    expect(await remindersOf(app, p.userId, END)).toHaveLength(1);
  });

  it("sends nothing while the END switch is off, even with START on", async () => {
    const t = await seedReminderTenant(app, "end-off", { startEnabled: true, endEnabled: false });
    tenantIds.push(t.tenantId);
    await createShift(app, t, t.employeeId, TEST_DAY, "09:00", "17:00");
    await createEntry(app, t, t.employeeId, localInstant(TEST_DAY, "08:58"), null);
    await app.tryShiftReminders(localInstant(TEST_DAY, "17:15", t.tz));
    await app.settlePushDispatch();
    expect(await remindersOf(app, t.userId)).toHaveLength(0);
    await setReminderConfig(app, t.tenantId, { endEnabled: true });
    await app.tryShiftReminders(localInstant(TEST_DAY, "17:15", t.tz));
    await app.settlePushDispatch();
    expect(await remindersOf(app, t.userId, END)).toHaveLength(1);
  });

  it("the start reminder does not fire for a person in the END case (open entry)", async () => {
    const t = await seedReminderTenant(app, "end-vs-start", {
      startEnabled: true,
      endEnabled: true,
    });
    tenantIds.push(t.tenantId);
    await createShift(app, t, t.employeeId, TEST_DAY, "09:00", "17:00");
    await createEntry(app, t, t.employeeId, localInstant(TEST_DAY, "08:58"), null);
    await app.tryShiftReminders(localInstant(TEST_DAY, "09:15", t.tz));
    await app.tryShiftReminders(localInstant(TEST_DAY, "17:15", t.tz));
    await app.settlePushDispatch();
    const rows = await remindersOf(app, t.userId);
    expect(rows.map((r) => r.type)).toEqual([END]);
    expect(rows.some((r) => r.type === START)).toBe(false);
  });
});

describe("shift end reminder - the registries (D-08)", () => {
  it("is never e-mailed and pushed with the neutral one-hour constant", () => {
    expect(resolveEmailPolicy(END)?.email).toBe("never");
    expect(resolvePushPolicy(END)).toEqual({
      push: "send",
      body: "Feierabend? Jetzt ausstempeln.",
      ttlSeconds: 3600,
    });
  });
});
