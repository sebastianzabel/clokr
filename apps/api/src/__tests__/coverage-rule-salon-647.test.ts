/**
 * Issue #647 — the week view's coverage uses the rules of the salon in view plus the tenant-wide
 * ones (tracer). A coverage rule written for salon A acts in `GET /shifts/week?salonId=A` only:
 * salon B and the unfiltered view of a multi-salon tenant keep the tenant-wide minimum, and a
 * foreign, unknown or inactive salon is rejected on write with the one 404.
 *
 * Fixture (fake clock 2026-06-15T10:00Z installed BEFORE the app boots; week `date=2026-06-17` is
 * Mon 06-15 … Sun 06-21): tenant T (default salon, plus salons A and B), person pA (HOME A) with one
 * shift pA@A on Tue 2026-06-16 (09:00-15:00, created directly) and a tenant-wide rule (all
 * templates, all days, minStaff 3) created directly. Synthetic names only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";

const WEEK = "date=2026-06-17";
const TUESDAY = "2026-06-16";
const NOT_FOUND = '{"error":"Salon nicht gefunden"}';

type WeekBody = {
  coverage: { date: string; minStaff: number; coverageStatus: string }[];
};

describe("Issue #647 — a coverage rule may name a salon (tracer)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };

  function week(salonId?: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?${WEEK}${salonId !== undefined ? `&salonId=${salonId}` : ""}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
  }

  async function weekBody(salonId?: string): Promise<WeekBody> {
    const res = await week(salonId);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as WeekBody;
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "cov647");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Nord" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Ost" });

    const suffix = `pa-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `${suffix}@example.invalid`,
        passwordHash: await bcrypt.hash("test1234", 10),
        isActive: true,
      },
    });
    const pA = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: suffix.toUpperCase().slice(0, 20),
        firstName: "pA",
        lastName: "Cov647",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: pA.id,
        type: "SHIFT_BASED",
        weeklyHours: 32,
        contractWorkDaysPerWeek: 5,
        usualWorkDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-01-01"),
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: pA.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
      },
    });
    await app.prisma.shift.create({
      data: {
        employeeId: pA.id,
        salonId: salonA.id,
        date: new Date(`${TUESDAY}T00:00:00Z`),
        startTime: "09:00",
        endTime: "15:00",
      },
    });
    await app.prisma.coverageRule.create({
      data: {
        tenantId: data.tenant.id,
        templateId: null,
        dayOfWeek: -1,
        minStaff: 3,
        requiresNonSupervised: false,
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("coverage-rule-salon-647 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("the salon rule is written through the API and acts only in its own filtered view", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/coverage-rules",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        templateId: null,
        dayOfWeek: -1,
        minStaff: 1,
        requiresNonSupervised: false,
        salonId: salonA.id,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect((JSON.parse(created.body) as { salonId: string }).salonId).toBe(salonA.id);

    const forA = await weekBody(salonA.id);
    expect(forA.coverage).toHaveLength(7);
    expect(forA.coverage.every((c) => c.minStaff === 1)).toBe(true);
    expect(forA.coverage.find((c) => c.date.startsWith(TUESDAY))?.coverageStatus).toBe("ok");

    // Salon B never sees A's rule (AC 1)
    const forB = await weekBody(salonB.id);
    expect(forB.coverage.every((c) => c.minStaff === 3)).toBe(true);

    // The unfiltered view of a three-salon tenant has no salon in view: tenant-wide rules only
    const unfiltered = await weekBody();
    expect(unfiltered.coverage.every((c) => c.minStaff === 3)).toBe(true);
    expect(unfiltered.coverage.find((c) => c.date.startsWith(TUESDAY))?.coverageStatus).toBe(
      "under",
    );
  });

  it("a salon rule for an unknown salon answers the one 404 and writes nothing", async () => {
    const before = await app.prisma.coverageRule.count({ where: { tenantId: data.tenant.id } });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/coverage-rules",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        templateId: null,
        dayOfWeek: -1,
        minStaff: 1,
        requiresNonSupervised: false,
        salonId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(NOT_FOUND);
    expect(await app.prisma.coverageRule.count({ where: { tenantId: data.tenant.id } })).toBe(
      before,
    );
  });
});
