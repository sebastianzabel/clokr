/**
 * Phase 71b Plan 04 (issue #71, AC-4..AC-7/AC-13) — the three single-employee saldo readers
 * (month-saldo.ts, overtime-balance.ts, recalculate-snapshots.ts) now resolve statutory holidays
 * by WORK LOCATION (§ 2 EFZG) through the Unterbau's central resolver, the same mechanism plans
 * 02/03 already proved for the resolver itself and for Abwesenheiten/Schichtplanung.
 *
 * Fronleichnam 2026 = Thursday 2026-06-04 (BAYERN, not NIEDERSACHSEN) — June 2026 carries no
 * NIEDERSACHSEN statutory holiday. June 2026 has 22 Mo-Fr workdays -> FIXED 40h Mo-Fr (8h/day)
 * June Soll with no holiday at all = 10560 minutes.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";

describe("Saldo by work location (Phase 71b Plan 04, issue #71, AC-4..AC-7)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let salonAId: string; // BAYERN
  let salonBId: string; // NIEDERSACHSEN, created FIRST — the tenant's default salon
  let e1Id: string; // HOME B, closed WORK entry on 2026-06-04 in salon A
  let e2Id: string; // HOME B, closed WORK entry on 2026-06-04 in salon B
  let e3Id: string; // HOME B + DEPLOYMENT A Thursdays, no June-4 entry
  let e4Id: string; // HOME B only — control
  let e5Id: string; // HOME B + DEPLOYMENT A Thursdays, entry in salon B on 2026-06-04
  let e7Id: string; // HOME A

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-10T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "hwls", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;

    const salonB = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonBId = salonB.id;
    const salonA = await createTestSalon(app.prisma, tenantId, { federalState: "BAYERN" });
    salonAId = salonA.id;

    const passwordHash = await bcrypt.hash("test1234", 10);

    async function createFixedEmployee(label: string) {
      const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const user = await app.prisma.user.create({
        data: {
          email: `hwls-${label}-${suffix}@test.de`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `HWLS-${label}-${suffix}`,
          firstName: label,
          lastName: "WorkLocationSaldo",
          hireDate: new Date("2026-06-01"),
        },
      });
      await app.prisma.workSchedule.create({
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
          validFrom: new Date("2026-06-01"),
        },
      });
      await app.prisma.overtimeAccount.create({
        data: { employeeId: employee.id, balanceHours: 0 },
      });
      return employee;
    }

    async function assignHome(employeeId: string, salonId: string) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId,
          employeeId,
          salonId,
          kind: "HOME",
          validFrom: new Date("2026-06-01"),
          validUntil: null,
          weekdays: [],
        },
      });
    }
    async function assignDeployment(employeeId: string, salonId: string, weekdays: number[]) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId,
          employeeId,
          salonId,
          kind: "DEPLOYMENT",
          validFrom: new Date("2026-06-01"),
          validUntil: null,
          weekdays,
        },
      });
    }
    async function createEntry(employeeId: string, dateStr: string, salonId: string) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: new Date(`${dateStr}T00:00:00Z`),
          startTime: new Date(`${dateStr}T08:00:00Z`),
          endTime: new Date(`${dateStr}T16:00:00Z`),
          breakMinutes: 0,
          type: "WORK",
          salonId,
        },
      });
    }

    const e1 = await createFixedEmployee("e1");
    e1Id = e1.id;
    await assignHome(e1Id, salonBId);
    await createEntry(e1Id, "2026-06-04", salonAId);

    const e2 = await createFixedEmployee("e2");
    e2Id = e2.id;
    await assignHome(e2Id, salonBId);
    await createEntry(e2Id, "2026-06-04", salonBId);

    const e3 = await createFixedEmployee("e3");
    e3Id = e3.id;
    await assignHome(e3Id, salonBId);
    await assignDeployment(e3Id, salonAId, [3]); // Thursday (0 = Monday)

    const e4 = await createFixedEmployee("e4");
    e4Id = e4.id;
    await assignHome(e4Id, salonBId);

    const e5 = await createFixedEmployee("e5");
    e5Id = e5.id;
    await assignHome(e5Id, salonBId);
    await assignDeployment(e5Id, salonAId, [3]);
    await createEntry(e5Id, "2026-06-04", salonBId);

    const e7 = await createFixedEmployee("e7");
    e7Id = e7.id;
    await assignHome(e7Id, salonAId);

    // Manual holiday, salon A only (Wednesday) — stacks with Fronleichnam (Thursday) for e7, who
    // is HOME A every day; must not touch e4 (HOME B/NIEDERSACHSEN).
    await app.prisma.publicHoliday.create({
      data: {
        tenantId,
        salonId: salonAId,
        date: new Date("2026-06-10"),
        name: "Stadtfest A",
        federalState: "BAYERN",
        year: 2026,
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("holiday-work-location-saldo cleanup failed:", err);
    }
  });

  async function monthSaldo(employeeId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${employeeId}?year=2026&month=6`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as { expectedMinutes: number };
  }

  it("AC-4: one tenant, two Bundesländer, one date — the closed entry's salon decides the June Soll, not a tenant-wide state", async () => {
    const e1Result = await monthSaldo(e1Id);
    expect(e1Result.expectedMinutes).toBe(10080);
    const e2Result = await monthSaldo(e2Id);
    expect(e2Result.expectedMinutes).toBe(10560);
  });

  it("AC-5: a Thursday DEPLOYMENT to BAYERN reduces the Soll with no entry needed; HOME NIEDERSACHSEN alone does not", async () => {
    const e3Result = await monthSaldo(e3Id);
    expect(e3Result.expectedMinutes).toBe(10080);
    const e4Result = await monthSaldo(e4Id);
    expect(e4Result.expectedMinutes).toBe(10560);
  });

  it("AC-6: a closed entry in the HOME salon beats the DEPLOYMENT pattern for the same day", async () => {
    const e5Result = await monthSaldo(e5Id);
    expect(e5Result.expectedMinutes).toBe(10560);
  });

  it("AC-7: a manual holiday of salon A reduces only the Soll of employees resolved to salon A that day", async () => {
    const e7Result = await monthSaldo(e7Id);
    expect(e7Result.expectedMinutes).toBe(9600);
    const e4Result = await monthSaldo(e4Id);
    expect(e4Result.expectedMinutes).toBe(10560);
  });
});
