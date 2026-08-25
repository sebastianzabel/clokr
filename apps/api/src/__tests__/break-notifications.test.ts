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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

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

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function otherDayStr(): string {
  // A distinct date from today, still safely in the past — avoids the
  // partial-unique-index collision (employeeId, date WHERE deletedAt IS NULL).
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
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
    const entry = await seedAutoEntry(app, seed.employee.id, todayStr());

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
    await seedAutoEntry(app, seed.employee.id, todayStr());

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
    await seedAutoEntry(app, seed.employee.id, todayStr());

    await app.tryBreakUnconfirmedNudge();

    const notifsOther = await app.prisma.notification.findMany({
      where: { userId: seed.empUser2.id, type: "BREAK_UNCONFIRMED" },
    });
    expect(notifsOther, "T-92-01: nudge must go only to the entry's own employee").toHaveLength(0);
  });

  it("(RED / master gate T-92-04) enforceBreakConfirmation=false → ZERO BREAK_UNCONFIRMED despite an AUTO entry", async () => {
    const seed = await seedBreakTenant(app, "gateoff", { enforceBreakConfirmation: false });
    tenantIds.push(seed.tenant.id);
    await seedAutoEntry(app, seed.employee.id, todayStr());

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
    const entryA = await seedAutoEntry(app, seed.employee.id, todayStr());
    const entryB = await seedAutoEntry(app, seed.employee.id, otherDayStr());

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
});
