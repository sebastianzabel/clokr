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

describe("shift start reminder - entries around the shift (AC-1, D-04, D-07)", () => {
  it("sends nothing when a valid closed entry was still running at the shift start (08:30-09:20)", async () => {
    const p = await personWithShift();
    await createEntry(
      app,
      tenant,
      p.employeeId,
      localInstant(TEST_DAY, "08:30"),
      localInstant(TEST_DAY, "09:10"),
    );
    await tick(TEST_DAY, "09:15");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
  });

  it("sends when the only valid closed entry ended before the shift start (08:30-08:50, WR-04)", async () => {
    const p = await personWithShift();
    await createEntry(
      app,
      tenant,
      p.employeeId,
      localInstant(TEST_DAY, "08:30"),
      localInstant(TEST_DAY, "08:50"),
    );
    await tick(TEST_DAY, "09:15");
    expect(await remindersOf(app, p.userId, START)).toHaveLength(1);
  });

  it("sends when the only valid entry is the early one of 06:30-06:50", async () => {
    const p = await personWithShift();
    await createEntry(
      app,
      tenant,
      p.employeeId,
      localInstant(TEST_DAY, "06:30"),
      localInstant(TEST_DAY, "06:50"),
    );
    await tick(TEST_DAY, "09:15");
    expect(await remindersOf(app, p.userId, START)).toHaveLength(1);
  });

  it("ignores an invalid open entry", async () => {
    const p = await personWithShift();
    await createEntry(app, tenant, p.employeeId, localInstant(TEST_DAY, "08:58"), null, {
      isInvalid: true,
    });
    await tick(TEST_DAY, "09:15");
    expect(await remindersOf(app, p.userId, START)).toHaveLength(1);
  });

  it("two shifts of one day each get their own notice, with distinct shift ids", async () => {
    const person = await addPerson(app, tenant);
    const a = await createShift(app, tenant, person.employeeId, TEST_DAY, "09:00", "12:00");
    const b = await createShift(app, tenant, person.employeeId, TEST_DAY, "13:00", "17:00");
    await tick(TEST_DAY, "09:15");
    expect(await remindersOf(app, person.userId, START)).toHaveLength(1);
    await tick(TEST_DAY, "13:15");
    const rows = await remindersOf(app, person.userId, START);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.relatedId).sort((x, y) => (x ?? "").localeCompare(y ?? ""))).toEqual(
      [a.id, b.id].sort((x, y) => x.localeCompare(y)),
    );
  });

  it("a person clocked in since 09:05 gets no notice for the adjacent 13:00 shift (D-07)", async () => {
    const person = await addPerson(app, tenant);
    await createShift(app, tenant, person.employeeId, TEST_DAY, "09:00", "12:00");
    await createShift(app, tenant, person.employeeId, TEST_DAY, "13:00", "17:00");
    await createEntry(app, tenant, person.employeeId, localInstant(TEST_DAY, "09:05"), null);
    await tick(TEST_DAY, "09:15");
    await tick(TEST_DAY, "13:15");
    expect(await remindersOf(app, person.userId)).toHaveLength(0);
  });
});

describe("shift start reminder - the window (D-04)", () => {
  it("is still due at 10:14 and gone at 10:15", async () => {
    const early = await personWithShift();
    await tick(TEST_DAY, "10:14");
    expect(await remindersOf(app, early.userId, START)).toHaveLength(1);

    const late = await personWithShift("09:00", "17:00", nextDay(TEST_DAY));
    const nextDayTenantTick = nextDay(TEST_DAY);
    await tick(nextDayTenantTick, "10:15");
    expect(await remindersOf(app, late.userId)).toHaveLength(0);
  });

  it("uses the tenant offset: N = 30 sends nothing at 09:29 and one at 09:30", async () => {
    const t = await seedReminderTenant(app, "start-n30", { startEnabled: true, offsetMinutes: 30 });
    tenantIds.push(t.tenantId);
    await createShift(app, t, t.employeeId, TEST_DAY, "09:00", "17:00");
    await app.tryShiftReminders(localInstant(TEST_DAY, "09:29", t.tz));
    expect(await remindersOf(app, t.userId)).toHaveLength(0);
    await app.tryShiftReminders(localInstant(TEST_DAY, "09:30", t.tz));
    await app.settlePushDispatch();
    expect(await remindersOf(app, t.userId, START)).toHaveLength(1);
  });

  it("treats a stored offset of 3 like 5", async () => {
    const t = await seedReminderTenant(app, "start-n3", { startEnabled: true, offsetMinutes: 3 });
    tenantIds.push(t.tenantId);
    await createShift(app, t, t.employeeId, TEST_DAY, "09:00", "17:00");
    await app.tryShiftReminders(localInstant(TEST_DAY, "09:04", t.tz));
    expect(await remindersOf(app, t.userId)).toHaveLength(0);
    await app.tryShiftReminders(localInstant(TEST_DAY, "09:05", t.tz));
    await app.settlePushDispatch();
    expect(await remindersOf(app, t.userId, START)).toHaveLength(1);
  });
});

describe("shift start reminder - overnight, DST and time zone (AC-5, D-03)", () => {
  it("a 23:30 shift is reminded at 00:10 of the next local day", async () => {
    const p = await personWithShift("23:30", "07:30");
    await tick(TEST_DAY, "23:44");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
    await tick(nextDay(TEST_DAY), "00:10");
    const notice = await soleNotification(app.prisma, { where: { userId: p.userId, type: START } });
    expect(notice.relatedId).toBe(p.shiftId);
    expect(notice.message).toBe("Deine Schicht hat um 23:30 begonnen. Jetzt einstempeln?");
  });

  it("a 09:00 shift on the spring-forward day is reminded at 09:15 local, not at 08:15", async () => {
    const day = "2027-03-28";
    const p = await personWithShift("09:00", "17:00", day);
    await tick(day, "08:15");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
    await tick(day, "09:15");
    expect(await remindersOf(app, p.userId, START)).toHaveLength(1);
  });

  it("a 09:00 shift on the fall-back day is reminded at 09:15 local", async () => {
    const day = "2026-10-25";
    const p = await personWithShift("09:00", "17:00", day);
    await tick(day, "09:14");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
    await tick(day, "09:15");
    expect(await remindersOf(app, p.userId, START)).toHaveLength(1);
  });

  it("follows the tenant time zone: Lisbon sends at 09:15 Lisbon time, not at 09:15 Berlin time", async () => {
    const t = await seedReminderTenant(app, "start-lisbon", {
      startEnabled: true,
      timezone: "Europe/Lisbon",
    });
    tenantIds.push(t.tenantId);
    await createShift(app, t, t.employeeId, TEST_DAY, "09:00", "17:00");
    await app.tryShiftReminders(localInstant(TEST_DAY, "09:15", "Europe/Berlin"));
    expect(await remindersOf(app, t.userId)).toHaveLength(0);
    await app.tryShiftReminders(localInstant(TEST_DAY, "09:15", "Europe/Lisbon"));
    await app.settlePushDispatch();
    expect(await remindersOf(app, t.userId, START)).toHaveLength(1);
  });
});

describe("shift start reminder - only the right persons (D-05)", () => {
  async function dueOrNot(overrides: Parameters<typeof addPerson>[2]) {
    const person = await addPerson(app, tenant, overrides);
    await createShift(app, tenant, person.employeeId, TEST_DAY, "09:00", "17:00");
    await tick(TEST_DAY, "09:15");
    return remindersOf(app, person.userId);
  }

  it("an exited person (exit day before the shift) gets nothing", async () => {
    expect(await dueOrNot({ exitDate: new Date("2026-11-09T00:00:00Z") })).toHaveLength(0);
  });

  it("an anonymised person gets nothing", async () => {
    expect(await dueOrNot({ anonymized: true })).toHaveLength(0);
  });

  it("a person whose login is deactivated gets nothing", async () => {
    expect(await dueOrNot({ userActive: false })).toHaveLength(0);
  });

  it("a person exempt from time tracking (section 18 ArbZG) gets nothing", async () => {
    expect(await dueOrNot({ isTimeTrackingExempt: true })).toHaveLength(0);
  });

  it("a person who switched the start reminder off gets nothing while a colleague still does", async () => {
    const off = await dueOrNot({ reminderShiftStartOff: true });
    expect(off).toHaveLength(0);
    const on = await dueOrNot({});
    expect(on.map((r) => r.type)).toEqual([START]);
  });

  it("an opt-out of another occasion does not stop the start reminder", async () => {
    const rows = await dueOrNot({ reminderShiftEndOff: true, reminderDayCloseOff: true });
    expect(rows.map((r) => r.type)).toEqual([START]);
  });
});

describe("an open entry of an earlier day is not 'clocked in' (WR-03)", () => {
  const YESTERDAY = "2026-11-09";

  it("still sends the start reminder to a person whose entry from yesterday was never closed", async () => {
    const p = await personWithShift();
    await createEntry(app, tenant, p.employeeId, localInstant(YESTERDAY, "09:00"), null);
    await tick(TEST_DAY, "09:15");
    const notice = await soleNotification(app.prisma, { where: { userId: p.userId, type: START } });
    expect(notice.relatedId).toBe(p.shiftId);
  });

  it("control: an open entry of the shift's own day still silences it", async () => {
    const p = await personWithShift();
    await createEntry(app, tenant, p.employeeId, localInstant(TEST_DAY, "06:00"), null);
    await tick(TEST_DAY, "09:15");
    expect(await remindersOf(app, p.userId)).toHaveLength(0);
  });
});

describe("split shifts: an earlier closed entry does not silence the second shift (WR-04)", () => {
  it("sends the start reminder of shift B (13:00) although the entry of shift A (11:30-12:30) is closed", async () => {
    const p = await addPerson(app, tenant);
    await createShift(app, tenant, p.employeeId, TEST_DAY, "11:30", "12:30");
    const b = await createShift(app, tenant, p.employeeId, TEST_DAY, "13:00", "17:00");
    await createEntry(
      app,
      tenant,
      p.employeeId,
      localInstant(TEST_DAY, "11:30"),
      localInstant(TEST_DAY, "12:30"),
    );
    await tick(TEST_DAY, "13:15");
    const notice = await soleNotification(app.prisma, { where: { userId: p.userId, type: START } });
    expect(notice.relatedId).toBe(b.id);
  });

  it("control: an entry that is still running at the start of B silences it", async () => {
    const p = await addPerson(app, tenant);
    await createShift(app, tenant, p.employeeId, TEST_DAY, "11:30", "12:30");
    await createShift(app, tenant, p.employeeId, TEST_DAY, "13:00", "17:00");
    await createEntry(
      app,
      tenant,
      p.employeeId,
      localInstant(TEST_DAY, "11:30"),
      localInstant(TEST_DAY, "13:05"),
    );
    await tick(TEST_DAY, "13:15");
    expect(await remindersOf(app, p.userId, START)).toHaveLength(0);
  });
});
