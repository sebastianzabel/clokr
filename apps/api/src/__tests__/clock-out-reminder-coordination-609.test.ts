/**
 * Issue #609 (D-06, P-609-15) - the 10-hour CLOCK_OUT_REMINDER stays silent for an open entry the
 * shift-end reminder already covered, and only for that entry.
 *
 * The existing job reads the wall clock, so the entries are relative to the real `Date.now()`; 11
 * hours back keeps every case clear of a day boundary. The REMINDER_SHIFT_END rows are written
 * directly with an explicit `createdAt`, because the rule compares that instant with the entry start.
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
import {
  addPerson,
  createEntry,
  seedReminderTenant,
  type ReminderTenant,
} from "./shift-reminder-fixtures-609";

const CLOCK_OUT = "CLOCK_OUT_REMINDER";
const END = "REMINDER_SHIFT_END";
const HOUR_MS = 3_600_000;

let app: FastifyInstance;
let tenant: ReminderTenant;

/** A fresh person with an open entry that started 11 hours ago. */
async function personOpenSince() {
  const person = await addPerson(app, tenant);
  const start = new Date(Date.now() - 11 * HOUR_MS);
  const entry = await createEntry(app, tenant, person.employeeId, start, null);
  return { ...person, entryId: entry.id, start };
}

async function endNotice(userId: string, createdAt: Date, dismissed = false) {
  await app.prisma.notification.create({
    data: {
      userId,
      type: END,
      title: "Schichtende",
      message: "Deine Schicht endete. Feierabend? Jetzt ausstempeln.",
      link: "/dashboard?clock=1",
      relatedType: "Shift",
      relatedId: `shift-${userId}`,
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
  it("writes no CLOCK_OUT_REMINDER when an end notice was created after the entry start (also dismissed)", async () => {
    const live = await personOpenSince();
    await endNotice(live.userId, new Date(live.start.getTime() + HOUR_MS));
    const dismissed = await personOpenSince();
    await endNotice(dismissed.userId, new Date(dismissed.start.getTime() + HOUR_MS), true);
    await app.tryClockOutReminder();
    expect(await clockOutRowsOf(live.userId, live.entryId)).toBeNull();
    expect(await clockOutRowsOf(dismissed.userId, dismissed.entryId)).toBeNull();
  });

  it("writes exactly one CLOCK_OUT_REMINDER when the end notice is older than the entry start", async () => {
    const p = await personOpenSince();
    await endNotice(p.userId, new Date(p.start.getTime() - HOUR_MS));
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
    await endNotice(other.userId, new Date(p.start.getTime() + HOUR_MS));
    await app.tryClockOutReminder();
    await soleNotification(app.prisma, {
      where: { userId: p.userId, type: CLOCK_OUT, link: `/time-entries?highlight=${p.entryId}` },
    });
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
