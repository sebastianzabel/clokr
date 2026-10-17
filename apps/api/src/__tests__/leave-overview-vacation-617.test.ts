/**
 * Issue #617 (AC-617-1, D-617-1, P-05) - GET /reports/leave-overview lists VACATION entitlements
 * only, selected by `leaveType.code` (never by name), and every real row carries the three new
 * per-person yearly counts `availableDays`, `takenDays`, `approvedUpcomingDays` read from the
 * Resturlaub facade. `Date` is faked to a mid-day instant, so the year and the facade's default
 * split day (tenant-local yesterday = 2026-10-16) are fixed.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { leaveTypeFields, type RequestableCode } from "../contexts/absence/leave-type";

const NOW = new Date("2026-10-17T10:00:00.000Z");
const YEAR = 2026;

type OverviewRow = {
  employee: { id: string; employeeNumber: string };
  leaveType: { code: string } | null;
  totalDays: number | null;
  usedDays: number | null;
  remainingDays: number | null;
  pendingDays: number | null;
  availableDays: number | null;
  takenDays: number | null;
  approvedUpcomingDays: number | null;
  missingEntitlement: boolean;
};

describe("Issue #617 - the in-app Urlaubsuebersicht is VACATION-only and carries the split", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function overview(): Promise<OverviewRow[]> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/leave-overview?year=${YEAR}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as OverviewRow[];
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    app = await getTestApp();
    data = await seedTestData(app, "lo617");
    const tenantId = data.tenant.id;
    const employeeId = data.employee.id;

    // The D-11 kind of fixture: further entitlement types next to the VACATION row, one of them a
    // sick-related type the vacation overview must never name.
    for (const [code, days] of [
      ["EDUCATION", 5],
      ["OTHER", 999],
      ["SICK_CHILD", 10],
    ] as const) {
      // OTHER is no requestable code (no display definition): built by hand like the D-11 fixture.
      const type = await app.prisma.leaveType.create({
        data:
          code === "OTHER"
            ? {
                tenantId,
                code,
                name: "Sonderfall ohne passende Kategorie",
                isPaid: true,
                requiresApproval: true,
                color: "#888888",
              }
            : { tenantId, ...leaveTypeFields(code as RequestableCode), color: "#888888" },
      });
      await app.prisma.leaveEntitlement.create({
        data: { employeeId, leaveTypeId: type.id, year: YEAR, totalDays: days, usedDays: 0 },
      });
    }

    // Two approved vacations: March (taken) and December (approved, upcoming), one pending.
    for (const [start, end, days, status] of [
      ["2026-03-02", "2026-03-03", 2, "APPROVED"],
      ["2026-12-14", "2026-12-16", 3, "APPROVED"],
      ["2026-11-02", "2026-11-03", 2, "PENDING"],
    ] as const) {
      await app.prisma.leaveRequest.create({
        data: {
          employeeId,
          leaveTypeId: data.vacationType.id,
          status,
          startDate: new Date(`${start}T00:00:00Z`),
          endDate: new Date(`${end}T00:00:00Z`),
          days,
        },
      });
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("leave-overview-vacation-617 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("lists VACATION rows and placeholders only; EDUCATION, OTHER and SICK_CHILD never appear", async () => {
    const rows = await overview();
    const codes = new Set(rows.filter((r) => !r.missingEntitlement).map((r) => r.leaveType?.code));
    expect([...codes]).toEqual(["VACATION"]);
    const mine = rows.filter((r) => r.employee.id === data.employee.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].totalDays).toBe(30); // not 35, not 1029
    // The anchor is not vacuous: the three other entitlement rows exist in the database.
    const stored = await app.prisma.leaveEntitlement.count({
      where: { employeeId: data.employee.id, year: YEAR },
    });
    expect(stored).toBe(4);
  });

  it("a VACATION row renamed by the tenant still appears (identity is the code)", async () => {
    await app.prisma.leaveType.update({
      where: { id: data.vacationType.id },
      data: { name: "Erholungsurlaub" },
    });
    const rows = await overview();
    const mine = rows.find((r) => r.employee.id === data.employee.id);
    expect(mine?.leaveType?.code).toBe("VACATION");
    expect(mine?.totalDays).toBe(30);
  });

  it("real rows carry availableDays, takenDays, approvedUpcomingDays equal to the facade on the same now", async () => {
    const rows = await overview();
    const mine = rows.find((r) => r.employee.id === data.employee.id)!;
    const entitlement = await app.prisma.leaveEntitlement.findFirstOrThrow({
      where: { employeeId: data.employee.id, year: YEAR, leaveTypeId: data.vacationType.id },
    });
    const balance = await app.vacationBalanceForRow(entitlement, data.tenant.id, NOW);
    expect(mine.availableDays).toBe(balance.availableDays);
    expect(mine.takenDays).toBe(balance.takenDays);
    expect(mine.approvedUpcomingDays).toBe(balance.approvedUpcomingDays);
    // Measured on the fixture: March taken, December upcoming, the pending request in neither.
    expect(mine.takenDays).toBe(2);
    expect(mine.approvedUpcomingDays).toBe(3);
    expect(mine.availableDays).toBe(30);
    expect(mine.pendingDays).toBe(2);
    expect(mine.remainingDays).toBe(
      Math.round(
        ((mine.availableDays ?? 0) - (mine.takenDays ?? 0) - (mine.approvedUpcomingDays ?? 0)) *
          100,
      ) / 100,
    );
    expect(mine.usedDays).toBe(5);
  });

  it("placeholder rows carry null for the three new figures", async () => {
    const rows = await overview();
    const placeholders = rows.filter((r) => r.missingEntitlement);
    expect(placeholders.length).toBeGreaterThan(0);
    for (const row of placeholders) {
      expect(row.availableDays).toBeNull();
      expect(row.takenDays).toBeNull();
      expect(row.approvedUpcomingDays).toBeNull();
    }
  });
});
