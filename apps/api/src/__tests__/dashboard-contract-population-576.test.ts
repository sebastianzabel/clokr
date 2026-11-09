/**
 * Issue #576 (plan 04) — the team week and today's attendance list only persons who hold a
 * contract (`hasWorkScheduleInPeriodWhere`, AND-ed onto the #613 population). A person without
 * any WorkSchedule row valid by the end of the period is no member of the team view; the period
 * reports keep their #613 population unchanged.
 *
 * Fixed clock 2026-09-16T10:00:00Z (Wednesday, Europe/Berlin); week 14.–20.09.2026.
 * Synthetic persons only (`createPopulationPerson`), no names.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  reissueTokenNow,
} from "./setup";
import { createPopulationPerson, type PopulationPerson } from "./population-fixtures-613";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const NOW = "2026-09-16T10:00:00.000Z";
const HIRE = new Date("2025-01-01T00:00:00.000Z");
const PASSWORD = "test1234";

describe("Issue #576 — team week and attendance list persons with a contract", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;

  async function getJson<T>(token: string, url: string): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    try {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${reissueTokenNow(app, token)}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      return JSON.parse(res.body) as T;
    } finally {
      vi.useRealTimers();
    }
  }

  async function weekIds(token: string): Promise<Set<string>> {
    const body = await getJson<{ team: Array<{ id: string }> }>(
      token,
      "/api/v1/dashboard/team-week",
    );
    return new Set(body.team.map((r) => r.id));
  }

  async function attendanceIds(token: string): Promise<Set<string>> {
    const body = await getJson<{ employees: Array<{ id: string }> }>(
      token,
      "/api/v1/dashboard/today-attendance",
    );
    return new Set(body.employees.map((r) => r.id));
  }

  async function withoutContract(p: PopulationPerson): Promise<void> {
    await app.prisma.workSchedule.deleteMany({ where: { employeeId: p.employeeId } });
  }

  async function contractFrom(p: PopulationPerson, validFrom: Date): Promise<void> {
    await app.prisma.workSchedule.updateMany({
      where: { employeeId: p.employeeId },
      data: { validFrom },
    });
  }

  async function workEntry(salonId: string, employeeId: string, date: string): Promise<void> {
    await app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00.000Z`),
        startTime: new Date(`${date}T07:00:00Z`),
        endTime: new Date(`${date}T11:00:00Z`),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "cp576");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("whole-tenant caller", () => {
    let n: PopulationPerson; // no contract at all
    let c: PopulationPerson; // contract from today
    let l: PopulationPerson; // contract only after the week
    let control: PopulationPerson; // ordinary contract

    beforeAll(async () => {
      const base = { tenantId: d.tenant.id, salonId: d.salonId, hireDate: HIRE };
      n = await createPopulationPerson(app, { ...base, tag: "n" });
      c = await createPopulationPerson(app, { ...base, tag: "c" });
      l = await createPopulationPerson(app, { ...base, tag: "l" });
      control = await createPopulationPerson(app, { ...base, tag: "k" });
      await withoutContract(n);
      await contractFrom(c, new Date("2026-09-15T22:00:00.000Z")); // local 16.09. 00:00
      await contractFrom(l, new Date("2026-09-30T22:00:00.000Z")); // local 01.10. 00:00
    });

    it("the team week lists the contract holders and leaves out the persons without one", async () => {
      const ids = await weekIds(d.adminToken);
      expect(ids.has(control.employeeId), "positive control").toBe(true);
      expect(ids.has(c.employeeId)).toBe(true);
      expect(ids.has(n.employeeId)).toBe(false);
      expect(ids.has(l.employeeId)).toBe(false);
    });

    it("today's attendance follows the same rule", async () => {
      const ids = await attendanceIds(d.adminToken);
      expect(ids.has(control.employeeId), "positive control").toBe(true);
      expect(ids.has(c.employeeId)).toBe(true);
      expect(ids.has(n.employeeId)).toBe(false);
      expect(ids.has(l.employeeId)).toBe(false);
    });

    it("the monthly report keeps its #613 population (a person without a contract stays)", async () => {
      const body = await getJson<{ rows: Array<{ employeeId: string }> }>(
        d.adminToken,
        "/api/v1/reports/monthly?year=2026&month=8",
      );
      const ids = new Set(body.rows.map((r) => r.employeeId));
      expect(ids.has(control.employeeId), "positive control").toBe(true);
      expect(ids.has(n.employeeId)).toBe(true);
    });
  });

  describe("salon-scoped manager", () => {
    let managerToken: string;
    let s: PopulationPerson; // no contract, entry in the scoped salon
    let s2: PopulationPerson; // same, with a contract (proves the entry path lists)
    let p: PopulationPerson; // contract, Stammsalon in the scoped salon

    beforeAll(async () => {
      const salonA = await createTestSalon(app.prisma, d.tenant.id, { name: "CP576 Salon A" });
      const salonB = await createTestSalon(app.prisma, d.tenant.id, { name: "CP576 Salon B" });
      const tenantId = d.tenant.id;
      s = await createPopulationPerson(app, {
        tenantId,
        salonId: salonB.id,
        tag: "s",
        hireDate: HIRE,
      });
      s2 = await createPopulationPerson(app, {
        tenantId,
        salonId: salonB.id,
        tag: "t",
        hireDate: HIRE,
      });
      p = await createPopulationPerson(app, {
        tenantId,
        salonId: salonA.id,
        tag: "p",
        hireDate: HIRE,
      });
      await withoutContract(s);
      await workEntry(salonA.id, s.employeeId, "2026-09-15");
      await workEntry(salonA.id, s2.employeeId, "2026-09-15");

      const manager = await createPopulationPerson(app, {
        tenantId,
        salonId: salonA.id,
        tag: "m",
        hireDate: HIRE,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
      });
      const name = `CP576 ${crypto.randomBytes(3).toString("hex")}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId,
          name,
          nameKey: roleNameKey(name),
          permissions: normalizeRolePermissions([
            "team-overview:read:ZUGEWIESEN",
            "time-entry:read:ZUGEWIESEN",
          ]),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId,
          userId: manager.userId,
          accessRoleId: role.id,
          scopeType: "SALONS",
          salonIds: [salonA.id],
          employeeIds: [],
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: manager.email, password: PASSWORD },
      });
      expect(res.statusCode, res.body).toBe(200);
      managerToken = (JSON.parse(res.body) as { accessToken: string }).accessToken;
    });

    it("a person listed only by an in-scope entry needs a contract too", async () => {
      const ids = await weekIds(managerToken);
      expect(ids.has(p.employeeId), "Stammsalon control").toBe(true);
      expect(ids.has(s2.employeeId), "entry-path control").toBe(true);
      expect(ids.has(s.employeeId)).toBe(false);
    });
  });
});
