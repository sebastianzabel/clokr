/**
 * vacation-figures-940.test.ts
 *
 * Issue #940 — the person's Urlaub tab (`GET /settings/vacation/:employeeId`) and the
 * Urlaubsübersicht (`GET /reports/leave-overview`) report the same vacation figures, both from the
 * ONE Resturlaub facade (#451, D-07): „Genommen“ = counted days up to yesterday, „Genehmigt“ =
 * approved days still ahead. Before the fix the tab showed the stored `usedDays` (8, all of it in
 * December) as „Genommen“ while the report said „Genommen 0 · Genehmigt 8“.
 *
 * The same fixture pins the carry-over rule the issue questioned: a carry-over whose deadline
 * (31.03.2026) has passed WITHOUT a documented Hinweis still counts (EuGH C-684/16, BAG 19.02.2019
 * – 9 AZR 423/16), and the facade now says so through `carryOverKeptWithoutNoticeDays` instead of
 * leaving readers with a bare „—“. With a Hinweis, or while the deadline lies ahead, it is 0.
 *
 * Fake clock 2026-11-14T12:00:00Z — fixed calendar dates only (CLAUDE.md, #394/#434).
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { getVacationBalance } from "../contexts/absence/facade/vacation-balance";

const NOW = new Date("2026-11-14T12:00:00.000Z");

describe("Issue #940 — one meaning of Genommen/Genehmigt and of an expired carry-over", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let employeeId: string;
  let entitlementId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vf940");
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: { email: `vf940-${suffix}@test.de`, passwordHash: "x", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `VF940-${suffix}`,
        firstName: "Urlaub",
        lastName: "Zahlen940",
        hireDate: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    employeeId = employee.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId,
        type: "FIXED_SCHEDULE",
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    if (data.salonId) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: data.tenant.id,
          employeeId,
          salonId: data.salonId,
          kind: "HOME",
          validFrom: new Date(Date.UTC(2024, 0, 1)),
          validUntil: null,
          weekdays: [],
        },
      });
    }
    const ent = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 6,
        usedDays: 8,
        carriedOverDays: 24,
        carryOverDeadline: new Date(Date.UTC(2026, 2, 31, 23, 59, 59)),
        isAutoCalculated: true,
      },
    });
    entitlementId = ent.id;
    // Both approved requests lie AFTER the Stichtag (yesterday, 13.11.2026): Genehmigt, not Genommen.
    for (const [start, end, days] of [
      [Date.UTC(2026, 11, 14), Date.UTC(2026, 11, 18), 5],
      [Date.UTC(2026, 11, 21), Date.UTC(2026, 11, 23), 3],
    ] as const) {
      await app.prisma.leaveRequest.create({
        data: {
          employeeId,
          leaveTypeId: data.vacationType.id,
          status: "APPROVED",
          startDate: new Date(start),
          endDate: new Date(end),
          days,
        },
      });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("940 vacation-figures cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("the facade keeps an expired carry-over without a Hinweis and says so", async () => {
    const b = await getVacationBalance(app.prisma, employeeId, data.tenant.id, 2026, NOW);
    expect(b).not.toBeNull();
    expect(b!.carriedOverEffectiveDays).toBe(24);
    expect(b!.carryOverKeptWithoutNoticeDays).toBe(24);
    expect(b!.availableDays).toBe(30);
    expect(b!.takenDays).toBe(0);
    expect(b!.approvedUpcomingDays).toBe(8);
    expect(b!.remainingDays).toBe(22);
  });

  it("is 0 while the deadline lies ahead", async () => {
    const b = await getVacationBalance(
      app.prisma,
      employeeId,
      data.tenant.id,
      2026,
      new Date("2026-03-15T12:00:00.000Z"),
    );
    expect(b!.carriedOverEffectiveDays).toBe(24);
    expect(b!.carryOverKeptWithoutNoticeDays).toBe(0);
  });

  it("the Urlaub tab and the Urlaubsübersicht report the same facade figures", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);

    const tabRes = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${employeeId}?year=2026`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(tabRes.statusCode, tabRes.body).toBe(200);
    const tab = JSON.parse(tabRes.body) as {
      usedDays: number;
      balance: {
        availableDays: number;
        takenDays: number;
        approvedUpcomingDays: number;
        remainingDays: number;
        carryOverKeptWithoutNoticeDays: number;
        splitAsOf: string;
      } | null;
    };
    expect(tab.balance, "RED before #940: no balance block").not.toBeNull();
    expect(tab.balance!.takenDays).toBe(0);
    expect(tab.balance!.approvedUpcomingDays).toBe(8);
    expect(tab.balance!.availableDays).toBe(30);
    expect(tab.balance!.remainingDays).toBe(22);
    expect(tab.balance!.carryOverKeptWithoutNoticeDays).toBe(24);
    expect(tab.balance!.splitAsOf).toBe("2026-11-13");

    const overviewRes = await app.inject({
      method: "GET",
      url: "/api/v1/reports/leave-overview?year=2026",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(overviewRes.statusCode, overviewRes.body).toBe(200);
    const rows = JSON.parse(overviewRes.body) as Array<{
      employee: { id?: string };
      leaveType: { code: string } | null;
      availableDays: number | null;
      takenDays: number | null;
      approvedUpcomingDays: number | null;
      remainingDays: number | null;
      carryOverKeptWithoutNoticeDays?: number;
    }>;
    const row = rows.find((r) => r.leaveType?.code === "VACATION" && r.employee.id === employeeId);
    expect(row).toBeDefined();
    expect(row!.takenDays).toBe(tab.balance!.takenDays);
    expect(row!.approvedUpcomingDays).toBe(tab.balance!.approvedUpcomingDays);
    expect(row!.availableDays).toBe(tab.balance!.availableDays);
    expect(row!.remainingDays).toBe(tab.balance!.remainingDays);
    expect(row!.carryOverKeptWithoutNoticeDays).toBe(24);
  });

  it("is 0 once a Hinweis was documented — then the carry lapses (taken before the deadline: none)", async () => {
    await app.prisma.auditLog.create({
      data: {
        action: "CARRYOVER_WARNED",
        entity: "LeaveEntitlement",
        entityId: entitlementId,
        newValue: { year: 2026, carriedOverDays: 24 },
      },
    });
    const b = await getVacationBalance(app.prisma, employeeId, data.tenant.id, 2026, NOW);
    expect(b!.carryOverKeptWithoutNoticeDays).toBe(0);
    expect(b!.carriedOverEffectiveDays).toBe(0);
    expect(b!.carriedOverExpiredDays).toBe(24);
  });
});
