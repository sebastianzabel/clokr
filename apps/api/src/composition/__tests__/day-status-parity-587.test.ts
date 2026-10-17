/**
 * Issue #587 (AC-587-1, D-587-1/D-587-2) — the dashboard's team week and the attendance list
 * resolve a person's day status through the SAME function, with the SAME inputs, so for one
 * person and one day they cannot contradict each other any more.
 *
 * Before #587 `GET /dashboard/today-attendance` hard-coded "today is never future" and read no
 * shifts and no PENDING leave, so a FIXED_SCHEDULE person at 12:00 with no shift read "Fehlt"
 * there and "Geplant" in `GET /dashboard/team-week`, and a SHIFT_BASED person past a shift start
 * read "—" in the list and "Fehlt" in the week.
 *
 * One tenant (Europe/Berlin), `Date` faked at non-midnight instants. Persons come from
 * `createPopulationPerson`; no names, no real e-mails.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  reissueTokenNow,
} from "../../__tests__/setup";
import { createPopulationPerson } from "../../__tests__/population-fixtures-613";

const WED = "2026-06-17";
const WEEK_URL = `/api/v1/dashboard/team-week?date=${WED}`;
const HIRE = new Date("2025-01-01T00:00:00Z");
const day = (s: string) => new Date(`${s}T00:00:00Z`);

type Cell = { date: string; status: string; reason: string | null; isWorkday: boolean };
type Week = { team: Array<{ id: string; employeeNumber: string | null; days: Cell[] }> };
type Att = {
  date: string;
  employees: Array<{
    id: string;
    employeeNumber: string | null;
    status: string;
    reason: string | null;
  }>;
};

describe("Issue #587 — one day status for the team week and the attendance list", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  const ids = { FX: "", SB1: "" };

  /** Both answers inside ONE faked-clock window. */
  async function bothAt(
    token: string,
    clock: string,
    weekUrl = WEEK_URL,
  ): Promise<{ week: Week; att: Att }> {
    vi.useFakeTimers({ now: new Date(clock), toFake: ["Date"] });
    try {
      const t = reissueTokenNow(app, token);
      const headers = { authorization: `Bearer ${t}` };
      const w = await app.inject({ method: "GET", url: weekUrl, headers });
      expect(w.statusCode, w.body).toBe(200);
      const a = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/today-attendance",
        headers,
      });
      expect(a.statusCode, a.body).toBe(200);
      return { week: JSON.parse(w.body) as Week, att: JSON.parse(a.body) as Att };
    } finally {
      vi.useRealTimers();
    }
  }

  function cellOf(week: Week, id: string, date: string): Cell {
    const row = week.team.find((r) => r.id === id);
    expect(row, `team-week row ${id}`).toBeDefined();
    const cell = row?.days.find((c) => c.date === date);
    expect(cell, `team-week cell ${date} of ${id}`).toBeDefined();
    return cell as Cell;
  }

  function rowOf(att: Att, id: string) {
    const row = att.employees.find((r) => r.id === id);
    expect(row, `attendance row ${id}`).toBeDefined();
    return row as Att["employees"][number];
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "ds587");
    const tenantId = d.tenant.id;

    const fx = await createPopulationPerson(app, {
      tenantId,
      salonId: d.salonId,
      tag: "fx",
      hireDate: HIRE,
    });
    ids.FX = fx.employeeId;

    const sb1 = await createPopulationPerson(app, {
      tenantId,
      salonId: d.salonId,
      tag: "sb1",
      hireDate: HIRE,
    });
    ids.SB1 = sb1.employeeId;
    await app.prisma.workSchedule.updateMany({
      where: { employeeId: sb1.employeeId },
      data: {
        type: "SHIFT_BASED",
        contractWorkDaysPerWeek: 5,
        usualWorkDays: [1, 2, 3, 4, 5],
      },
    });
    await app.prisma.shift.create({
      data: {
        employeeId: sb1.employeeId,
        salonId: d.salonId,
        date: day(WED),
        startTime: "09:00",
        endTime: "17:00",
        label: "Frueh ds587",
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("day-status-parity-587 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("tracer", () => {
    it("a FIXED_SCHEDULE person at 12:00 without a shift or entry reads scheduled in both views", async () => {
      const { week, att } = await bothAt(d.adminToken, "2026-06-17T10:00:00Z");
      const cell = cellOf(week, ids.FX, WED);
      expect(cell.status).toBe("scheduled");
      expect(rowOf(att, ids.FX)).toMatchObject({ status: "scheduled", reason: cell.reason });
    });

    it("a SHIFT_BASED person past the shift start reads missing in both views", async () => {
      const { week, att } = await bothAt(d.adminToken, "2026-06-17T10:00:00Z");
      const cell = cellOf(week, ids.SB1, WED);
      expect(cell.status).toBe("missing");
      expect(rowOf(att, ids.SB1)).toMatchObject({ status: "missing", reason: cell.reason });
    });

    it("every attendance row has the status and reason of its person's today cell", async () => {
      const { week, att } = await bothAt(d.adminToken, "2026-06-17T10:00:00Z");
      expect(att.employees.length).toBeGreaterThan(0);
      for (const row of att.employees) {
        const cell = cellOf(week, row.id, att.date);
        expect({ status: row.status, reason: row.reason }).toEqual({
          status: cell.status,
          reason: cell.reason,
        });
      }
    });
  });
});
