/**
 * Issue #493 (R3, D-08, F-16) — `GET /leave/calendar` of a month shows only the requests and holidays
 * that touch that month.
 *
 * The handler filtered the `@db.Date` columns `LeaveRequest.startDate/endDate` (and the holiday
 * window of `getHolidayMap`) with `monthRangeUtc` INSTANTS. The instant of local Oct 1 00:00 in
 * Europe/Berlin is 2026-09-30T22:00Z; Postgres compares a `date` column with the UTC DATE of that
 * instant, so a request that ended on 30.09. satisfied `endDate >= start` and the 31.10. holiday
 * showed up in November. Winter behaves the same: the instant of Feb 1 00:00 is 31.01.23:00Z.
 *
 * All dates are fixed — the route takes `year`/`month` explicitly, nothing is "now"-relative.
 * Reformationstag (31.10.) is a public holiday in Niedersachsen, the seeded tenant's state.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

describe("Issue #493 — absence calendar month boundaries", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  const ids: Record<"A" | "B" | "C" | "D", string> = { A: "", B: "", C: "", D: "" };

  async function request(
    employeeId: string,
    startDate: string,
    endDate: string,
    days: number,
  ): Promise<string> {
    const row = await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: d.vacationType.id,
        startDate: new Date(`${startDate}T00:00:00Z`),
        endDate: new Date(`${endDate}T00:00:00Z`),
        days,
        status: "APPROVED",
      },
    });
    return row.id;
  }

  async function calendarIds(year: number, month: number): Promise<string[]> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/calendar?year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { id: string }[]).map((x) => x.id);
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "lcb493");
    ids.A = await request(d.employee.id, "2026-09-28", "2026-09-30", 3);
    ids.B = await request(d.adminEmployee.id, "2026-09-30", "2026-10-02", 3);
    ids.C = await request(d.employee.id, "2026-01-28", "2026-01-30", 3);
    ids.D = await request(d.employee.id, "2026-01-31", "2026-01-31", 1);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("leave-calendar-month-boundary-493 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("summer: a request that ended on 30.09. is in September and not in October", async () => {
    expect(await calendarIds(2026, 10)).not.toContain(ids.A);
    expect(await calendarIds(2026, 9)).toContain(ids.A);
  });

  it("summer: a request spanning 30.09.-02.10. appears in both months", async () => {
    expect(await calendarIds(2026, 9)).toContain(ids.B);
    expect(await calendarIds(2026, 10)).toContain(ids.B);
  });

  it("summer: the holiday 31.10. is in October and not in November", async () => {
    const oct = await calendarIds(2026, 10);
    expect(oct).toContain("holiday-2026-10-03");
    expect(oct).toContain("holiday-2026-10-31");
    expect(await calendarIds(2026, 11)).not.toContain("holiday-2026-10-31");
  });

  it("winter: a request on 31.01. is in January and not in February", async () => {
    const feb = await calendarIds(2026, 2);
    expect(feb).not.toContain(ids.C);
    expect(feb).not.toContain(ids.D);
    const jan = await calendarIds(2026, 1);
    expect(jan).toContain(ids.C);
    expect(jan).toContain(ids.D);
  });
});
