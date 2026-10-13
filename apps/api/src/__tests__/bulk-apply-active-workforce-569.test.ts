/**
 * Issue #569 — the bulk apply of the tenant's default working time (`PUT /api/v1/settings/work`
 * with `applyToExisting: true`) reaches only the active workforce.
 *
 * On prod (04.10.2026) it wrote new contract rows for two DSGVO-anonymized employees, because the
 * employee query had no filter at all. An anonymized employee is erased (Art. 17 GDPR) and must not
 * receive new rows; an employee who left before the new contract starts has no contract to change.
 * An employee who leaves AFTER the new contract starts still gets it (it governs the remaining days).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("Issue #569 — bulk apply reaches only the active workforce", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const ids: Record<"anonymized" | "exitedBefore" | "exitsLater" | "active", string> = {
    anonymized: "",
    exitedBefore: "",
    exitsLater: "",
    active: "",
  };

  async function mkEmployee(
    label: string,
    fields: { firstName: string; lastName: string; exitDate?: Date },
  ): Promise<string> {
    const uid = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `bulk569-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `B569-${uid}`,
        firstName: fields.firstName,
        lastName: fields.lastName,
        hireDate: new Date("2024-01-01"),
        exitDate: fields.exitDate,
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        weeklyHours: 16,
        mondayHours: 4,
        tuesdayHours: 4,
        wednesdayHours: 4,
        thursdayHours: 4,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4],
        validFrom: new Date("2024-01-01"),
      },
    });
    return employee.id;
  }

  async function scheduleCount(employeeId: string): Promise<number> {
    return app.prisma.workSchedule.count({ where: { employeeId } });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, `bulk569-${Date.now()}`);
    ids.anonymized = await mkEmployee("anon", { firstName: "Gelöscht", lastName: "GELÖSCHT-569" });
    ids.exitedBefore = await mkEmployee("exited", {
      firstName: "Ex",
      lastName: "Before",
      exitDate: new Date(Date.now() - 60 * DAY_MS),
    });
    ids.exitsLater = await mkEmployee("later", {
      firstName: "Ex",
      lastName: "Later",
      exitDate: new Date(Date.now() + 60 * DAY_MS),
    });
    ids.active = await mkEmployee("active", { firstName: "Still", lastName: "Here" });
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  it("writes no contract for anonymized or already-exited employees, and one for every other", async () => {
    const before = {
      anonymized: await scheduleCount(ids.anonymized),
      exitedBefore: await scheduleCount(ids.exitedBefore),
      exitsLater: await scheduleCount(ids.exitsLater),
      active: await scheduleCount(ids.active),
    };

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        applyToExisting: true,
        defaultWeeklyHours: 40,
        defaultMondayHours: 8,
        defaultTuesdayHours: 8,
        defaultWednesdayHours: 8,
        defaultThursdayHours: 8,
        defaultFridayHours: 8,
        defaultSaturdayHours: 0,
        defaultSundayHours: 0,
      },
    });
    expect(res.statusCode, res.body).toBe(200);

    // Erased and departed people get nothing new.
    expect(await scheduleCount(ids.anonymized)).toBe(before.anonymized);
    expect(await scheduleCount(ids.exitedBefore)).toBe(before.exitedBefore);
    // Control: the filter narrows, it does not switch the bulk apply off.
    expect(await scheduleCount(ids.active)).toBe(before.active + 1);
    expect(await scheduleCount(ids.exitsLater)).toBe(before.exitsLater + 1);
  });
});
