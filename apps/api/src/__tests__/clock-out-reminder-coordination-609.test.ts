/**
 * Issue #609 (D-06, WR-01, P-609-15) - the 10-hour CLOCK_OUT_REMINDER stays silent for an open entry
 * the shift-end reminder already covered, and only for that entry's CURRENT open period.
 *
 * The existing job reads the wall clock, so the entries are relative to the real `Date.now()`. The
 * REMINDER_SHIFT_END rows are written directly with an explicit `createdAt` and point at a real
 * shift of the entry's own day, because the rule compares that instant with the open period and
 * resolves the notice's shift to a day. An untouched open entry carries `updatedAt = startTime`.
 * The re-open case runs through the real clock resolver, so it proves the write that bumps
 * `updatedAt`, not an assumption about it.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  cleanupTestData,
  soleNotification,
  soleNotificationOrNull,
} from "./setup";
import { resolveClockEvent } from "../services/clock/resolver";
import {
  addPerson,
  createEntry,
  createShift,
  seedReminderTenant,
  type ReminderTenant,
} from "./shift-reminder-fixtures-609";

const CLOCK_OUT = "CLOCK_OUT_REMINDER";
const END = "REMINDER_SHIFT_END";
const HOUR_MS = 3_600_000;

let app: FastifyInstance;
let tenant: ReminderTenant;

/** The tenant-local calendar day of an instant ("YYYY-MM-DD"). */
function dayOf(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tenant.tz }).format(instant);
}

/** A fresh person with an open entry that started `hoursAgo` hours ago and was never touched since. */
async function personOpenSince(hoursAgo = 11) {
  const person = await addPerson(app, tenant);
  const start = new Date(Date.now() - hoursAgo * HOUR_MS);
  const entry = await createEntry(app, tenant, person.employeeId, start, null, {
    updatedAt: start,
  });
  return { ...person, entryId: entry.id, start, day: dayOf(start) };
}

/** A shift notice of `type` for `shiftId`, created at `createdAt`. */
async function endNotice(userId: string, shiftId: string, createdAt: Date, dismissed = false) {
  await app.prisma.notification.create({
    data: {
      userId,
      type: END,
      title: "Schichtende",
      message: "Deine Schicht endete. Feierabend? Jetzt ausstempeln.",
      link: "/dashboard?clock=1",
      relatedType: "Shift",
      relatedId: shiftId,
      createdAt,
      dismissedAt: dismissed ? new Date(createdAt.getTime() + 60_000) : null,
    },
  });
}

function clockOutRowsOf(userId: string, entryId: string) {
  return soleNotificationOrNull(app.prisma, {
    where: { userId, type: CLOCK_OUT, link: `/time-entries?highlight=${entryId}` },
  });
}

beforeAll(async () => {
  app = await getTestApp();
  tenant = await seedReminderTenant(app, "coord", {});
});

afterAll(async () => {
  await cleanupTestData(app, tenant.tenantId);
  await closeTestApp();
});

describe("the 10-hour clock-out reminder and the shift-end reminder (D-06)", () => {
  it("writes no CLOCK_OUT_REMINDER when an end notice about the entry's shift was created after the start (also dismissed)", async () => {
    const live = await personOpenSince();
    const liveShift = await createShift(app, tenant, live.employeeId, live.day, "08:00", "12:00");
    await endNotice(live.userId, liveShift.id, new Date(live.start.getTime() + HOUR_MS));
    const dismissed = await personOpenSince();
    const dismissedShift = await createShift(
      app,
      tenant,
      dismissed.employeeId,
      dismissed.day,
      "08:00",
      "12:00",
    );
    await endNotice(
      dismissed.userId,
      dismissedShift.id,
      new Date(dismissed.start.getTime() + HOUR_MS),
      true,
    );
    await app.tryClockOutReminder();
    expect(await clockOutRowsOf(live.userId, live.entryId)).toBeNull();
    expect(await clockOutRowsOf(dismissed.userId, dismissed.entryId)).toBeNull();
  });

  it("writes exactly one CLOCK_OUT_REMINDER when the end notice is older than the entry start", async () => {
    const p = await personOpenSince();
    const shift = await createShift(app, tenant, p.employeeId, p.day, "08:00", "12:00");
    await endNotice(p.userId, shift.id, new Date(p.start.getTime() - HOUR_MS));
    await app.tryClockOutReminder();
    const row = await soleNotification(app.prisma, {
      where: { userId: p.userId, type: CLOCK_OUT, link: `/time-entries?highlight=${p.entryId}` },
    });
    expect(row.relatedId).toBe(p.entryId);
  });

  it("writes exactly one CLOCK_OUT_REMINDER when there is no end notice at all (control)", async () => {
    const p = await personOpenSince();
    await app.tryClockOutReminder();
    await app.tryClockOutReminder();
    await soleNotification(app.prisma, {
      where: { userId: p.userId, type: CLOCK_OUT, link: `/time-entries?highlight=${p.entryId}` },
    });
  });

  it("an end notice of ANOTHER user does not silence the person", async () => {
    const p = await personOpenSince();
    const other = await addPerson(app, tenant);
    const otherShift = await createShift(app, tenant, other.employeeId, p.day, "08:00", "12:00");
    await endNotice(other.userId, otherShift.id, new Date(p.start.getTime() + HOUR_MS));
    await app.tryClockOutReminder();
    await soleNotification(app.prisma, {
      where: { userId: p.userId, type: CLOCK_OUT, link: `/time-entries?highlight=${p.entryId}` },
    });
  });
});

describe("the end notice covers only the entry's current open period (WR-01)", () => {
  it("a re-opened entry that is forgotten again gets its 10-hour reminder (open 08:00, notice 12:15, out 12:20, in 13:00)", async () => {
    // The reviewer's reproducer, shifted onto the wall clock: the row starts 11 h ago, the end
    // notice comes 4 h 15 min after, the person clocks out at 4 h 20 min and back in NOW through the
    // real clock resolver, which re-opens the SAME row.
    const person = await addPerson(app, tenant);
    const start = new Date(Date.now() - 11 * HOUR_MS);
    const day = dayOf(start);
    const closedAt = new Date(start.getTime() + (4 * 60 + 20) * 60_000);
    const entry = await createEntry(app, tenant, person.employeeId, start, closedAt, {
      updatedAt: closedAt,
    });
    const shift = await createShift(app, tenant, person.employeeId, day, "08:00", "12:00");
    await endNotice(person.userId, shift.id, new Date(start.getTime() + (4 * 60 + 15) * 60_000));

    const resolution = await resolveClockEvent(app, {
      employeeId: person.employeeId,
      tenantId: tenant.tenantId,
      source: "MANUAL",
      intent: "IN",
      timestamp: new Date(),
      date: new Date(`${day}T00:00:00Z`),
      dateStr: day,
      actor: { type: "SYSTEM" },
      interactive: true,
    });
    expect(resolution.kind).toBe("CLOCKED_IN");
    const reopened = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(reopened.endTime).toBeNull();
    expect(reopened.startTime.getTime()).toBe(start.getTime()); // the same row, same start

    await app.tryClockOutReminder();
    const row = await soleNotification(app.prisma, {
      where: {
        userId: person.userId,
        type: CLOCK_OUT,
        link: `/time-entries?highlight=${entry.id}`,
      },
    });
    expect(row.relatedId).toBe(entry.id);
  });

  it("control: the same entry never re-opened stays covered by its end notice", async () => {
    const person = await addPerson(app, tenant);
    const start = new Date(Date.now() - 11 * HOUR_MS);
    const day = dayOf(start);
    const entry = await createEntry(app, tenant, person.employeeId, start, null, {
      updatedAt: start,
    });
    const shift = await createShift(app, tenant, person.employeeId, day, "08:00", "12:00");
    await endNotice(person.userId, shift.id, new Date(start.getTime() + (4 * 60 + 15) * 60_000));
    await app.tryClockOutReminder();
    expect(await clockOutRowsOf(person.userId, entry.id)).toBeNull();
  });

  it("a stale open entry from an earlier day is not covered by today's end notice", async () => {
    // Open since ~35 hours ago and forgotten. Today's shift ended and got its notice 2 hours ago,
    // which is AFTER the stale entry's start but is about another day's shift.
    const stale = await personOpenSince(35);
    const todayStart = new Date(Date.now() - 6 * HOUR_MS);
    const todayShift = await createShift(
      app,
      tenant,
      stale.employeeId,
      dayOf(todayStart),
      "08:00",
      "12:00",
    );
    // the stale entry must not share the shift's day, or the case proves nothing
    expect(dayOf(todayStart)).not.toBe(stale.day);
    await endNotice(stale.userId, todayShift.id, new Date(Date.now() - 2 * HOUR_MS));
    await app.tryClockOutReminder();
    const row = await soleNotification(app.prisma, {
      where: {
        userId: stale.userId,
        type: CLOCK_OUT,
        link: `/time-entries?highlight=${stale.entryId}`,
      },
    });
    expect(row.relatedId).toBe(stale.entryId);
  });
});

describe("the 09:00 missing-entries job stays untouched (D-06)", () => {
  it("names no REMINDER_ type in the body of checkMissingEntries", () => {
    const file = path.resolve(__dirname, "../contexts/time-tracking/plugins/attendance-checker.ts");
    const source = fs.readFileSync(file, "utf8");
    const start = source.indexOf("async function checkMissingEntries");
    expect(start, "checkMissingEntries moved or was renamed").toBeGreaterThan(0);
    const next = source.indexOf("\n  async function ", start + 10);
    expect(next).toBeGreaterThan(start);
    const body = source.slice(start, next);
    expect(body.length).toBeGreaterThan(500);
    expect(body).not.toMatch(/REMINDER_/);
  });
});
