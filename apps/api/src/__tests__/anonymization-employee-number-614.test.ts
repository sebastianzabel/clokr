/**
 * Issue #614 (D-03, owner decision 16.10.2026) — the anonymization KEEPS the employee number.
 *
 * Legal basis: § 41 EStG (Lohnkonto, 6 years), § 147 AO (10 years), Art. 17 Abs. 3 lit. b DSGVO.
 * Without name, e-mail and notes the number is a pseudonym; the payroll office assigns corrections
 * of old months by the DATEV `pnr`. The direct consequence: a kept number stays reserved in its
 * tenant, so a reuse answers a deliberate 409 instead of the internal error the
 * `@@unique([tenantId, employeeNumber])` constraint used to raise.
 *
 * What is proven: the number survives, the DATEV lines of an old month stay under the SAME pnr with
 * the same hours/days, the sentinel (firstName + lastName) still marks the row, a second
 * anonymization changes nothing, and create / change answer 409 with a German message.
 *
 * No person names and no real e-mails in fixtures; dates are relative to the tenant-local today.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import iconv from "iconv-lite";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  configureDatevKanzlei,
} from "./setup";
import { getTenantTimezone, todayInTz } from "../contexts/working-time-account";
import { isAnonymizedEmployee } from "../contexts/platform";
import { EMPLOYEE_NUMBER_RESERVED_MESSAGE } from "../contexts/platform/employee-creation";
import { DATEV_BWD_SATZ_ID } from "../composition/reports";

const F_PNR = 1;
const F_LOHNART = 5;
const F_STUNDEN = 6;
const F_TAGE = 7;

describe("Issue #614 D-03 — the employee number survives the anonymization", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let tz: string;
  let lastYear = 0;
  let lastMonth = 0;
  const target = { id: "", number: "", userEmail: "" };
  let other = { id: "", number: "" };

  const auth = () => ({ authorization: `Bearer ${data.adminToken}` });

  async function createEmployee(label: string, workDays: string[]) {
    const s = `${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `${s}@example.invalid`;
    const user = await app.prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash("test1234", 4),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `N614-${s}`.toUpperCase().slice(0, 24),
        firstName: label,
        lastName: "Fixture",
        hireDate: new Date("2025-01-01T00:00:00Z"),
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
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-01-01T00:00:00Z"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: 0 },
    });
    for (const day of workDays) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: employee.id,
          date: new Date(`${day}T00:00:00Z`),
          startTime: new Date(`${day}T08:00:00Z`),
          endTime: new Date(`${day}T16:00:00Z`),
          breakMinutes: 30,
          type: "WORK",
          source: "MANUAL",
          salonId: data.salonId,
        },
      });
    }
    return { id: employee.id, number: employee.employeeNumber, email };
  }

  async function datevLinesOf(pnr: string): Promise<string[][]> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/datev?year=${lastYear}&month=${lastMonth}`,
      headers: auth(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const text = iconv.decode(res.rawPayload, "win1252");
    return text
      .split("[Bewegungsdaten]")[1]
      .split("\r\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => l.split(";"))
      .filter((f) => f[0] === String(DATEV_BWD_SATZ_ID) && f[F_PNR] === pnr)
      .map((f) => [f[F_LOHNART]!, f[F_STUNDEN]!, f[F_TAGE]!]);
  }

  const del = (id: string) =>
    app.inject({ method: "DELETE", url: `/api/v1/employees/${id}`, headers: auth() });

  const row = (id: string) =>
    app.prisma.employee.findUniqueOrThrow({
      where: { id },
      select: { firstName: true, lastName: true, employeeNumber: true, exitDate: true },
    });

  let datevBefore: string[][] = [];

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "num614");
    await configureDatevKanzlei(app, data.tenant.id);
    tz = await getTenantTimezone(app.prisma, data.tenant.id);
    const today = todayInTz(tz);
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    lastYear = first.getUTCFullYear();
    lastMonth = first.getUTCMonth() + 1;

    // The first two Monday-Friday days of LAST month carry the closed WORK entries.
    const days: string[] = [];
    for (let d = 1; days.length < 2; d++) {
      const cand = new Date(Date.UTC(lastYear, lastMonth - 1, d));
      if (cand.getUTCDay() >= 1 && cand.getUTCDay() <= 5)
        days.push(cand.toISOString().slice(0, 10));
    }
    const t = await createEmployee("Target", days);
    target.id = t.id;
    target.number = t.number;
    target.userEmail = t.email;
    other = await createEmployee("Other", []);

    datevBefore = await datevLinesOf(target.number);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("anonymization-employee-number-614 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("control: the DATEV export of last month carries the person under the original pnr", () => {
    expect(datevBefore.length).toBeGreaterThan(0);
    expect(datevBefore.some(([lohnart]) => lohnart === "100")).toBe(true);
  });

  it("DELETE anonymizes: sentinel set, e-mail gone, employee number unchanged", async () => {
    const res = await del(target.id);
    expect(res.statusCode, res.body).toBe(204);

    const emp = await row(target.id);
    expect(isAnonymizedEmployee(emp)).toBe(true);
    expect(emp.firstName).toBe("Gelöscht");
    expect(emp.lastName).toBe(`GELÖSCHT-${target.number}`);
    expect(emp.employeeNumber).toBe(target.number);
    expect(emp.exitDate).not.toBeNull();

    const user = await app.prisma.employee.findUniqueOrThrow({
      where: { id: target.id },
      select: { user: { select: { email: true } } },
    });
    expect(user.user.email).not.toBe(target.userEmail);
  });

  it("the DATEV export of last month is unchanged: same pnr, same Lohnarten, stunden and tage", async () => {
    const after = await datevLinesOf(target.number);
    expect(after).toEqual(datevBefore);
  });

  it("a second anonymization is idempotent (lastName, employeeNumber, exitDate unchanged)", async () => {
    const first = await row(target.id);
    const res = await del(target.id);
    expect(res.statusCode, res.body).toBe(204);
    const second = await row(target.id);
    expect(second.lastName).toBe(first.lastName);
    expect(second.employeeNumber).toBe(first.employeeNumber);
    expect(second.exitDate?.getTime()).toBe(first.exitDate?.getTime());
  });

  it("POST with the kept number answers 409 with a German message and creates nothing", async () => {
    const employeesBefore = await app.prisma.employee.count({
      where: { tenantId: data.tenant.id },
    });
    const email = `reuse-${Date.now().toString(36)}@example.invalid`;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: auth(),
      payload: {
        usualWorkDays: [1, 2, 3, 4, 5],
        email,
        firstName: "Reuse",
        lastName: "Fixture",
        employeeNumber: target.number,
        hireDate: new Date().toISOString(),
        role: "EMPLOYEE",
        weeklyHours: 40,
        password: "Test@1234567!",
      },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: EMPLOYEE_NUMBER_RESERVED_MESSAGE });
    expect(EMPLOYEE_NUMBER_RESERVED_MESSAGE).toMatch(/Personalnummer.*vergeben/);
    expect(await app.prisma.employee.count({ where: { tenantId: data.tenant.id } })).toBe(
      employeesBefore,
    );
    expect(await app.prisma.user.count({ where: { email } })).toBe(0);
  });

  it("POST with a new unique number still works", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: auth(),
      payload: {
        usualWorkDays: [1, 2, 3, 4, 5],
        email: `fresh-${Date.now().toString(36)}@example.invalid`,
        firstName: "Fresh",
        lastName: "Fixture",
        employeeNumber: `${target.number}-NEW`,
        hireDate: new Date().toISOString(),
        role: "EMPLOYEE",
        weeklyHours: 40,
        password: "Test@1234567!",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it("PATCH to the kept number answers 409 and leaves the other employee unchanged", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${other.id}`,
      headers: auth(),
      payload: { employeeNumber: target.number },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: EMPLOYEE_NUMBER_RESERVED_MESSAGE });
    expect((await row(other.id)).employeeNumber).toBe(other.number);
  });

  it("PATCH to a new unique number still works", async () => {
    const next = `${other.number}-X`;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${other.id}`,
      headers: auth(),
      payload: { employeeNumber: next },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await row(other.id)).employeeNumber).toBe(next);
  });
});
