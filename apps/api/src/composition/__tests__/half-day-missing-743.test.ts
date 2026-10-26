/**
 * Issue #743 - a PAST workday with an approved half-day leave and no valid entry reads "Fehlt"
 * (the other half was owed); today never does; a day with an entry reads "present"; a full leave
 * day stays "absent". Every reader of `resolveDayStatus` (team week, attendance, my-week,
 * open-items) follows because the rule lives only in `contexts/time-tracking/presence.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  reissueTokenNow,
  tokenWithoutSignIn,
} from "../../__tests__/setup";
import { createPopulationPerson } from "../../__tests__/population-fixtures-613";

const WED = "2026-06-17";
const HIRE = new Date("2025-01-01T00:00:00Z");
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const AT_WED_1200 = "2026-06-17T10:00:00Z";
const AT_MON_AFTER = "2026-06-22T10:00:00Z";

type Cell = { date: string; status: string };
type Att = { employees: Array<{ id: string; status: string }> };

describe("Issue #743 - half-day leave on the one day status", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  const ids: Record<string, string> = {};
  const emails: Record<string, string> = {};

  async function getJson<T>(url: string, token: string): Promise<T> {
    const res = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    return JSON.parse(res.body) as T;
  }

  async function views(clock: string, tag: string) {
    const token = await tokenWithoutSignIn(app, emails[tag]);
    vi.useFakeTimers({ now: new Date(clock), toFake: ["Date"] });
    try {
      const admin = reissueTokenNow(app, d.adminToken);
      const mine = reissueTokenNow(app, token);
      const week = await getJson<{ team: Array<{ id: string; days: Cell[] }> }>(
        `/api/v1/dashboard/team-week?date=${WED}`,
        admin,
      );
      const my = await getJson<{ days: Cell[] }>(`/api/v1/dashboard/my-week?date=${WED}`, mine);
      const open = await getJson<{ missingDays: string[] }>("/api/v1/dashboard/open-items", mine);
      const att = await getJson<Att>("/api/v1/dashboard/today-attendance", admin);
      return {
        team: week.team.find((r) => r.id === ids[tag])?.days.find((c) => c.date === WED)?.status,
        my: my.days.find((c) => c.date === WED)?.status,
        missing: open.missingDays.includes(WED),
        att: att.employees.find((e) => e.id === ids[tag])?.status,
      };
    } finally {
      vi.useRealTimers();
    }
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "t743");
    await app.prisma.tenantConfig.updateMany({
      where: { tenantId: d.tenant.id },
      data: { missingEntriesDays: 7 },
    });
    const vacation = await app.prisma.leaveType.findFirstOrThrow({
      where: { tenantId: d.tenant.id, code: "VACATION" },
    });
    for (const [tag, halfDay, withEntry] of [
      ["HALF", true, false],
      ["HALFE", true, true],
      ["FULL", false, false],
    ] as const) {
      const p = await createPopulationPerson(app, {
        tenantId: d.tenant.id,
        salonId: d.salonId,
        tag,
        hireDate: HIRE,
      });
      ids[tag] = p.employeeId;
      emails[tag] = p.email;
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: p.employeeId,
          leaveTypeId: vacation.id,
          startDate: day(WED),
          endDate: day(WED),
          days: halfDay ? 0.5 : 1,
          halfDay,
          status: "APPROVED",
          reviewedBy: d.adminUser.id,
          reviewedAt: new Date(),
        },
      });
      if (withEntry) {
        await app.prisma.timeEntry.create({
          data: {
            employeeId: p.employeeId,
            salonId: d.salonId,
            date: day(WED),
            startTime: new Date(`${WED}T06:00:00Z`),
            endTime: new Date(`${WED}T10:00:00Z`),
            breakMinutes: 0,
            type: "WORK",
            source: "MANUAL",
          },
        });
      }
    }
  });

  afterAll(async () => {
    await cleanupTestData(app, d.tenant.id);
    await closeTestApp();
  });

  it("past half day without entry: missing in every reader", async () => {
    const v = await views(AT_MON_AFTER, "HALF");
    expect(v.team).toBe("missing");
    expect(v.my).toBe("missing");
    expect(v.missing).toBe(true);
  });

  it("past half day with an entry: present, not missing", async () => {
    const v = await views(AT_MON_AFTER, "HALFE");
    expect(v.team).toBe("present");
    expect(v.my).not.toBe("missing");
    expect(v.missing).toBe(false);
  });

  it("past full leave day: absent as before", async () => {
    const v = await views(AT_MON_AFTER, "FULL");
    expect(v.team).toBe("absent");
    expect(v.my).toBe("leave");
    expect(v.missing).toBe(false);
  });

  it("today: a half day is never overdue (team week and attendance)", async () => {
    const v = await views(AT_WED_1200, "HALF");
    expect(v.team).toBe("absent");
    expect(v.att).toBe("absent");
    expect(v.missing).toBe(false);
  });
});
