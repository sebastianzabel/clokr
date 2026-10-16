/**
 * Issue #614 (AC-614-4, D-05) — "Bevorstehende Urlaube" (`GET /api/v1/dashboard/team-upcoming-leave`)
 * never lists a request of a DSGVO-anonymized person, also for the Bestand: persons anonymized
 * before this phase have no exit date and still hold an APPROVED future leave. The filter lives in
 * the absence facade query (`getApprovedLeaveEndingOnOrAfter`), so the route's own `slice(0, 8)`
 * counts only listable rows.
 *
 * The fixture sets the pre-614 end state directly (sentinel names, inactive user, no exit date).
 * Non-vacuity is built into the test: before the persons are turned into the sentinel shape the
 * nine earlier requests crowd the listable person out of the eight-item limit.
 *
 * No person names in fixtures; dates are relative to the tenant-local today.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../__tests__/setup";
import { getTenantTimezone, todayInTz } from "../../contexts/working-time-account";

const PASSWORD = "test1234";
const DAY_MS = 86_400_000;

type Item = { id: string; employeeId: string };
type Upcoming = { salonId: string | null; items: Item[] };

describe("Issue #614 — upcoming leave never lists an anonymized person", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonId: string;
  let otherSalonId: string;
  let today: Date;
  const bestand: { employeeId: string; userId: string; requestId: string }[] = [];
  let listableRequestId = "";
  let listableEmployeeId = "";

  const day = (offset: number) => new Date(today.getTime() + offset * DAY_MS);

  async function person(label: string) {
    const s = `${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `${s}@example.invalid`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: `${label}-Fx614`,
        hireDate: new Date("2024-01-01T00:00:00Z"),
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: employee.id,
        salonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
      },
    });
    return { user, employee };
  }

  function approvedVacation(employeeId: string, startOffset: number) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        startDate: day(startOffset),
        endDate: day(startOffset),
        days: 1,
        status: "APPROVED",
      },
    });
  }

  async function upcoming(salon?: string): Promise<Upcoming> {
    const res = await app.inject({
      method: "GET",
      url: salon
        ? `/api/v1/dashboard/team-upcoming-leave?salonId=${salon}`
        : "/api/v1/dashboard/team-upcoming-leave",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Upcoming;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "up614");
    salonId = data.salonId;
    otherSalonId = (await createTestSalon(app.prisma, data.tenant.id, { name: "Up614 B" })).id;
    today = todayInTz(await getTenantTimezone(app.prisma, data.tenant.id));

    // Nine persons whose requests sort BEFORE the listable person's (start +1 … +9 vs. +20).
    for (let i = 1; i <= 9; i++) {
      const p = await person(`Bestand${i}`);
      const r = await approvedVacation(p.employee.id, i);
      bestand.push({ employeeId: p.employee.id, userId: p.user.id, requestId: r.id });
    }
    const a = await person("Listable");
    listableEmployeeId = a.employee.id;
    listableRequestId = (await approvedVacation(a.employee.id, 20)).id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("dashboard-upcoming-leave-anonymized-614 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("control: before the persons are anonymized the limit crowds the listable person out", async () => {
    const body = await upcoming();
    expect(body.items).toHaveLength(8);
    expect(body.items.map((i) => i.id)).not.toContain(listableRequestId);
  });

  describe("after the pre-614 anonymization end state (sentinel names, no exit date)", () => {
    beforeAll(async () => {
      for (const b of bestand) {
        await app.prisma.employee.update({
          where: { id: b.employeeId },
          data: { firstName: "Gelöscht", lastName: `GELÖSCHT-${b.employeeId.slice(0, 8)}` },
        });
        await app.prisma.user.update({ where: { id: b.userId }, data: { isActive: false } });
      }
      const stored = await app.prisma.employee.findMany({
        where: { id: { in: bestand.map((b) => b.employeeId) } },
        select: { exitDate: true },
      });
      expect(stored).toHaveLength(9);
      expect(stored.every((e) => e.exitDate === null)).toBe(true);
    });

    it("lists the listable person's request and no anonymized one", async () => {
      const body = await upcoming();
      expect(body.items.map((i) => i.id)).toEqual([listableRequestId]);
      expect(body.items[0].employeeId).toBe(listableEmployeeId);
    });

    it("the limit counts only listable rows (nine earlier anonymized requests do not crowd it out)", async () => {
      const body = await upcoming();
      const ids = body.items.map((i) => i.id);
      for (const b of bestand) expect(ids).not.toContain(b.requestId);
      expect(ids).toContain(listableRequestId);
    });

    it("holds under a salon filter on the listable person's home salon", async () => {
      const body = await upcoming(salonId);
      expect(body.salonId).toBe(salonId);
      expect(body.items.map((i) => i.id)).toEqual([listableRequestId]);
    });

    it("a salon filter on another salon lists nothing", async () => {
      const body = await upcoming(otherSalonId);
      expect(body.items).toEqual([]);
    });
  });
});
