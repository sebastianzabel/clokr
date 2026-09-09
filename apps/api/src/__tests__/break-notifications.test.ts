/**
 * RED scaffold (Phase 92, Wave 0 — Nyquist) — break-notifications.test.ts
 *
 * Covers BREAK-06: the attendance-checker nudge cron `app.tryBreakUnconfirmedNudge()`
 * (built in Plan 05) emits ONE `BREAK_UNCONFIRMED` in-app notification per unconfirmed
 * (breakStatus AUTO) TimeEntry, per-entry-deduplicates, sends only to the entry's own
 * employee, is COMPLETELY DORMANT for tenants that have NOT opted into
 * `enforceBreakConfirmation` (BREAK-05 Gesamt-Opt-in master gate), and auto-dismisses
 * once the entry transitions to CONFIRMED/WAIVED (relies on the type-scoped 3-arg
 * `dismissByRelated` built in Plan 03).
 *
 * RED reason: `app.tryBreakUnconfirmedNudge` does not exist yet — every it() below
 * throws `TypeError: app.tryBreakUnconfirmedNudge is not a function` until Plan 05
 * adds the Fastify decorator (mirrors `tryEndOfMonthGapReminder` in attendance-checker.ts).
 * This is the intended RED state for this Wave-0 plan.
 *
 * Because Phase 91 writes breakStatus="AUTO" unconditionally on every >6h/>9h
 * clock-out, the master-gate case (enforceBreakConfirmation=false) is the proof that
 * un-opted tenants see ZERO behavior change once the cron ships.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { fromZonedTime } from "date-fns-tz";
import { daysAgoStrInTz } from "./test-dates";

// ── Seed helpers ──────────────────────────────────────────────────────────────

/**
 * Isolated tenant with a manager + two employees (primary + secondary), so
 * recipient-isolation can be asserted (T-92-01 threat mitigation).
 */
async function seedBreakTenant(
  app: FastifyInstance,
  suffix: string,
  opts: { enforceBreakConfirmation: boolean },
) {
  const s = `bn-${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const prisma = app.prisma;

  const tenant = await prisma.tenant.create({
    data: { name: `BreakNotif ${s}`, slug: `bn-${s}`, federalState: "NIEDERSACHSEN" },
  });
  await prisma.tenantConfig.create({
    data: {
      tenantId: tenant.id,
      defaultVacationDays: 30,
      timezone: "Europe/Berlin",
      enforceBreakConfirmation: opts.enforceBreakConfirmation,
    },
  });

  async function createEmployee(empSuffix: string, role: "EMPLOYEE" | "MANAGER" | "ADMIN") {
    const email = `${empSuffix}-${s}@test.de`;
    const pw = await bcrypt.hash("test1234", 10);
    const user = await prisma.user.create({
      data: { email, passwordHash: pw, role, isActive: true },
    });
    const employee = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        employeeNumber: `E-${empSuffix}-${s}`,
        firstName: "Test",
        lastName: empSuffix,
        hireDate: new Date("2024-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2024-01-01"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    return { user, employee, email };
  }

  const mgr = await createEmployee("mgr", "MANAGER");
  const primary = await createEmployee("primary", "EMPLOYEE");
  const secondary = await createEmployee("secondary", "EMPLOYEE");

  return {
    tenant,
    mgrUser: mgr.user,
    empUser: primary.user,
    employee: primary.employee,
    empEmail: primary.email,
    empUser2: secondary.user,
    employee2: secondary.employee,
  };
}

/** Seed a WORK TimeEntry carrying breakStatus AUTO for the given "YYYY-MM-DD" date. */
async function seedAutoEntry(app: FastifyInstance, employeeId: string, dateStr: string) {
  return app.prisma.timeEntry.create({
    data: {
      employeeId,
      date: new Date(dateStr + "T00:00:00Z"),
      startTime: new Date(dateStr + "T08:00:00Z"),
      endTime: new Date(dateStr + "T16:00:00Z"),
      breakMinutes: 30,
      breakStatus: "AUTO",
      type: "WORK",
      source: "MANUAL",
    },
  });
}

/**
 * The two seeded days, derived from ONE clock read (issue #136 batch E).
 *
 * Two independent corrections over the old todayStr()/otherDayStr() pair:
 *  1. Tenant timezone, not UTC. checkUnconfirmedBreaks resolves the month with
 *     dateStrInTz(now, tz) in Europe/Berlin (attendance-checker.ts:942-949); between 00:00 and
 *     02:00 Berlin the UTC slice is still yesterday.
 *  2. The second day must stay inside the SAME tenant-TZ month, because the cron scans only the
 *     current month (monthRangeUtc -> monthDayBounds -> date: { gte, lte }). Plain "yesterday"
 *     leaves that window on the 1st of every month, at any hour, so entry B gets no nudge and the
 *     auto-dismiss test reads undefined instead of null. A month always has at least two days, so
 *     stepping FORWARD on the 1st and BACK on every other day is inside-the-month unconditionally.
 *     (daysAgoStrInTz with a negative n means "n days AHEAD" — the name reads the other way.)
 */
function anchorDays(now: Date): { today: string; other: string } {
  const today = daysAgoStrInTz(now, 0);
  const dayOfMonth = Number(today.slice(8, 10));
  return { today, other: daysAgoStrInTz(now, dayOfMonth === 1 ? -1 : 1) };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("break-notifications — BREAK-06 nudge cron (RED — app.tryBreakUnconfirmedNudge not built yet)", () => {
  let app: FastifyInstance;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    for (const id of tenantIds) {
      try {
        await cleanupTestData(app, id);
      } catch (err) {
        console.error(`Cleanup failed for tenant ${id}:`, err);
      }
    }
    await closeTestApp();
  });

  it("(RED) emits ONE BREAK_UNCONFIRMED per AUTO entry with relatedType/relatedId/userId set", async () => {
    const seed = await seedBreakTenant(app, "emit", { enforceBreakConfirmation: true });
    tenantIds.push(seed.tenant.id);
    const { today } = anchorDays(new Date());
    const entry = await seedAutoEntry(app, seed.employee.id, today);

    await app.tryBreakUnconfirmedNudge();

    const notifs = await app.prisma.notification.findMany({
      where: { userId: seed.empUser.id, type: "BREAK_UNCONFIRMED" },
    });
    expect(notifs).toHaveLength(1);
    expect(notifs[0].relatedType).toBe("TimeEntry");
    expect(notifs[0].relatedId).toBe(entry.id);
  });

  it("(RED) per-entry dedup: a second call produces NO additional row for the same undismissed entry", async () => {
    const seed = await seedBreakTenant(app, "dedup", { enforceBreakConfirmation: true });
    tenantIds.push(seed.tenant.id);
    const { today } = anchorDays(new Date());
    await seedAutoEntry(app, seed.employee.id, today);

    await app.tryBreakUnconfirmedNudge();
    await app.tryBreakUnconfirmedNudge();

    const notifs = await app.prisma.notification.findMany({
      where: { userId: seed.empUser.id, type: "BREAK_UNCONFIRMED" },
    });
    expect(notifs, "dedup: exactly 1 row, not 2, after the second cron invocation").toHaveLength(1);
  });

  it("(RED) recipient isolation: an employee with NO AUTO entry receives zero nudges", async () => {
    const seed = await seedBreakTenant(app, "isolation", { enforceBreakConfirmation: true });
    tenantIds.push(seed.tenant.id);
    // Only the primary employee has an AUTO entry — the secondary must stay untouched.
    const { today } = anchorDays(new Date());
    await seedAutoEntry(app, seed.employee.id, today);

    await app.tryBreakUnconfirmedNudge();

    const notifsOther = await app.prisma.notification.findMany({
      where: { userId: seed.empUser2.id, type: "BREAK_UNCONFIRMED" },
    });
    expect(notifsOther, "T-92-01: nudge must go only to the entry's own employee").toHaveLength(0);
  });

  it("(RED / master gate T-92-04) enforceBreakConfirmation=false → ZERO BREAK_UNCONFIRMED despite an AUTO entry", async () => {
    const seed = await seedBreakTenant(app, "gateoff", { enforceBreakConfirmation: false });
    tenantIds.push(seed.tenant.id);
    const { today } = anchorDays(new Date());
    await seedAutoEntry(app, seed.employee.id, today);

    await app.tryBreakUnconfirmedNudge();

    const notifs = await app.prisma.notification.findMany({
      where: { userId: seed.empUser.id, type: "BREAK_UNCONFIRMED" },
    });
    expect(
      notifs,
      "master gate off — the cron must be fully dormant for un-opted tenants",
    ).toHaveLength(0);
  });

  it("(RED) auto-dismiss e2e: confirming ONE AUTO entry dismisses only its own nudge; the other stays open", async () => {
    const seed = await seedBreakTenant(app, "dismiss", { enforceBreakConfirmation: true });
    tenantIds.push(seed.tenant.id);
    const { today, other } = anchorDays(new Date());
    const entryA = await seedAutoEntry(app, seed.employee.id, today);
    const entryB = await seedAutoEntry(app, seed.employee.id, other);

    await app.tryBreakUnconfirmedNudge();

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: seed.empEmail, password: "test1234" },
    });
    const { accessToken } = JSON.parse(loginRes.body);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/time-entries/${entryA.id}/break-status`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { action: "confirm" },
    });
    expect(patchRes.statusCode).toBe(200);

    const notifA = await app.prisma.notification.findFirst({
      where: { relatedType: "TimeEntry", relatedId: entryA.id, type: "BREAK_UNCONFIRMED" },
    });
    const notifB = await app.prisma.notification.findFirst({
      where: { relatedType: "TimeEntry", relatedId: entryB.id, type: "BREAK_UNCONFIRMED" },
    });
    expect(notifA?.dismissedAt, "confirmed entry's own nudge must auto-dismiss").not.toBeNull();
    expect(notifB?.dismissedAt, "the OTHER (still-AUTO) entry's nudge must stay open").toBeNull();
  });

  it("issue #136: on the 1st of a month at 00:30 Europe/Berlin both seeded days are still inside the scanned month", async () => {
    // PINNED is DERIVED, never a literal: roll the real clock to the 1st of the FOLLOWING
    // month, then build 00:30 Europe/Berlin for that date via fromZonedTime. This instant is
    // simultaneously the 1st of a month AND inside the 00:00-02:00 Berlin band, so it reproduces
    // both causes from D-2 with one pin, and it can never expire.
    const real = new Date();
    const nextMonthFirst = new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth() + 1, 1));
    const y = nextMonthFirst.getUTCFullYear();
    const m = String(nextMonthFirst.getUTCMonth() + 1).padStart(2, "0");
    const d = String(nextMonthFirst.getUTCDate()).padStart(2, "0");
    const PINNED = fromZonedTime(`${y}-${m}-${d}T00:30:00`, "Europe/Berlin");

    let seed: Awaited<ReturnType<typeof seedBreakTenant>> | undefined;
    try {
      vi.useFakeTimers({ now: PINNED, toFake: ["Date"] });

      seed = await seedBreakTenant(app, "monthfirst", { enforceBreakConfirmation: true });
      tenantIds.push(seed.tenant.id);

      const { today, other } = anchorDays(new Date());
      expect(today.slice(0, 7), "same-month property, stated explicitly").toBe(other.slice(0, 7));
      expect(today, "still two distinct days — the partial unique index depends on it").not.toBe(
        other,
      );

      const entryA = await seedAutoEntry(app, seed.employee.id, today);
      const entryB = await seedAutoEntry(app, seed.employee.id, other);

      await app.tryBreakUnconfirmedNudge();

      const notifA = await app.prisma.notification.findFirst({
        where: { relatedType: "TimeEntry", relatedId: entryA.id, type: "BREAK_UNCONFIRMED" },
      });
      const notifB = await app.prisma.notification.findFirst({
        where: { relatedType: "TimeEntry", relatedId: entryB.id, type: "BREAK_UNCONFIRMED" },
      });
      expect(notifA, "entry on the 1st must be nudged even though today IS the 1st").not.toBeNull();
      expect(
        notifB,
        "the other seeded day must stay inside the scanned month and also be nudged",
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
