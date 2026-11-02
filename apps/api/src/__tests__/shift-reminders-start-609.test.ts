/**
 * Issue #609 (AC-1, AC-5; D-03 .. D-07) - the shift START reminder, end to end on the production job
 * path: tenant switch -> five-minute job -> shift facade -> literal notify() -> registry-gated push.
 *
 * Every instant is built from an explicit tenant-local date and time (`localInstant`), never from the
 * wall clock; the job takes its "now" as a parameter through the `tryShiftReminders` decorator. Each
 * case uses its own person (and shift), so the once-per-shift dedupe cannot mask a rule.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, cleanupTestData, soleNotification } from "./setup";
import { resolveEmailPolicy } from "../contexts/platform/notification-email-policy";
import { resolvePushPolicy } from "../contexts/platform/notification-push-policy";
import {
  TEST_DAY,
  addPerson,
  createEntry,
  createShift,
  localInstant,
  remindersOf,
  seedReminderTenant,
  setReminderConfig,
  type ReminderTenant,
} from "./shift-reminder-fixtures-609";

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
  tenant = await seedReminderTenant(app, "start", { startEnabled: true });
  tenantIds.push(tenant.tenantId);
});

afterAll(async () => {
  for (const id of tenantIds) await cleanupTestData(app, id);
  await closeTestApp();
});

describe("shift start reminder - the tracer (AC-1, D-04, D-06, D-08, D-09)", () => {
  it("sends exactly one notice at 09:15 with the link, the shift relation and the in-app text", async () => {
    const p = await personWithShift();
    await tick(TEST_DAY, "09:15");
    const notice = await soleNotification(app.prisma, { where: { userId: p.userId, type: START } });
    expect(notice.link).toBe("/dashboard?clock=1");
    expect(notice.relatedType).toBe("Shift");
    expect(notice.relatedId).toBe(p.shiftId);
    expect(notice.title).toBe("Schicht begonnen");
    expect(notice.message).toBe("Deine Schicht hat um 9:00 begonnen. Jetzt einstempeln?");
  });

  it("sends nothing before the offset has passed (09:14)", async () => {
    const p = await personWithShift();
    await tick(TEST_DAY, "09:14");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
  });

  it("does not repeat on a later tick, also not after the person dismissed the notice", async () => {
    const p = await personWithShift();
    await tick(TEST_DAY, "09:15");
    await tick(TEST_DAY, "09:20");
    const first = await soleNotification(app.prisma, { where: { userId: p.userId, type: START } });
    await app.prisma.notification.update({
      where: { id: first.id },
      data: { dismissedAt: localInstant(TEST_DAY, "09:21") },
    });
    await tick(TEST_DAY, "09:25");
    const again = await soleNotification(app.prisma, { where: { userId: p.userId, type: START } });
    expect(again.id).toBe(first.id);
  });

  it("sends nothing to a person who is already clocked in (valid open entry since 08:58)", async () => {
    const p = await personWithShift();
    await createEntry(app, tenant, p.employeeId, localInstant(TEST_DAY, "08:58"), null);
    await tick(TEST_DAY, "09:15");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
  });

  it("sends nothing to a person without a planned shift", async () => {
    const q = await addPerson(app, tenant);
    await tick(TEST_DAY, "09:15");
    expect(await remindersOf(app, q.userId)).toHaveLength(0);
  });

  it("sends nothing while the tenant switch is off", async () => {
    const off = await seedReminderTenant(app, "start-off", { startEnabled: false });
    tenantIds.push(off.tenantId);
    await createShift(app, off, off.employeeId, TEST_DAY, "09:00", "17:00");
    await app.tryShiftReminders(localInstant(TEST_DAY, "09:15", off.tz));
    await app.settlePushDispatch();
    expect(await remindersOf(app, off.userId)).toHaveLength(0);
    // switching it on makes the very same shift due
    await setReminderConfig(app, off.tenantId, { startEnabled: true });
    await app.tryShiftReminders(localInstant(TEST_DAY, "09:15", off.tz));
    await app.settlePushDispatch();
    expect(await remindersOf(app, off.userId, START)).toHaveLength(1);
  });
});

describe("shift start reminder - the registries (D-08)", () => {
  it("is never e-mailed and pushed with the neutral one-hour constant", () => {
    expect(resolveEmailPolicy(START)?.email).toBe("never");
    expect(resolvePushPolicy(START)).toEqual({
      push: "send",
      body: "Deine Schicht hat begonnen. Jetzt einstempeln?",
      ttlSeconds: 3600,
    });
  });
});
