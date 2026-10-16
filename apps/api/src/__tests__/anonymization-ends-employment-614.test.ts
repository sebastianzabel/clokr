/**
 * Issue #614 — DSGVO anonymization ends the employment.
 *
 * D-01: `DELETE /api/v1/employees/:id` stores the tenant-local day of the anonymization as the exit
 * date when none is set (an existing one, past or future, is never changed) and brings the
 * exit-year VACATION entitlement to its § 5 BUrlG value exactly like `PATCH /:id/deactivate`
 * (Issue #447 invariant).
 *
 * Every date is computed relative to the tenant-local today, so the file passes on any day of the
 * year.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, soleAuditRow } from "./setup";
import { getTenantTimezone, todayInTz } from "../contexts/working-time-account";

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const utcMidnight = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("Issue #614 — anonymization ends the employment", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let today: Date;

  const auth = () => ({ authorization: `Bearer ${data.adminToken}` });

  /** Creates a plain employee row (no API round trip) with an active user. */
  async function createEmployee(label: string, extra: { exitDate?: Date | null } = {}) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@example.invalid`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: "Exit614",
        lastName: "Fixture",
        employeeNumber: `E614-${suffix}`,
        hireDate: utcMidnight(`${today.getUTCFullYear() - 2}-01-01`),
        exitDate: extra.exitDate ?? null,
      },
    });
    return { user, employee };
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "anon-exit-614");
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    today = todayInTz(tz);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("anonymization-ends-employment-614 test cleanup failed:", err);
    }
  });

  describe("D-01 exit date", () => {
    it("sets the exit date to the tenant-local today when none is stored, and says so in the ANONYMIZE audit", async () => {
      const { employee } = await createEmployee("set");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${employee.id}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(204);

      const after = await app.prisma.employee.findUniqueOrThrow({ where: { id: employee.id } });
      expect(after.exitDate).not.toBeNull();
      expect(isoDay(after.exitDate!)).toBe(isoDay(today));

      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: employee.id, action: "ANONYMIZE" },
      });
      const newValue = audit.newValue as { exitDate: string; exitDateSet: boolean };
      expect(newValue.exitDate).toBe(isoDay(today));
      expect(newValue.exitDateSet).toBe(true);
    });

    it("never changes an exit date that is already stored (future day, entered as UTC midnight like the web)", async () => {
      const future = utcMidnight(
        isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 0))),
      );
      const { employee } = await createEmployee("keep", { exitDate: future });
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${employee.id}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(204);

      const after = await app.prisma.employee.findUniqueOrThrow({ where: { id: employee.id } });
      expect(after.exitDate!.toISOString()).toBe(future.toISOString());

      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: employee.id, action: "ANONYMIZE" },
      });
      const newValue = audit.newValue as { exitDate: string; exitDateSet: boolean };
      expect(newValue.exitDate).toBe(isoDay(future));
      expect(newValue.exitDateSet).toBe(false);
    });

    it("leaves the exit-year VACATION entitlement exactly as PATCH /:id/deactivate leaves it for an identical twin (Issue #447)", async () => {
      // Hired on the first of the month three months ago, so the § 5 BUrlG sync has a Teilurlaub
      // to compute for the exit year (Wartezeit not fulfilled).
      const hire = utcMidnight(
        isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 3, 1))),
      );
      const twins: string[] = [];
      for (const label of ["twin-a", "twin-b"]) {
        const email = `${label}-${crypto.randomUUID().slice(0, 8)}@example.invalid`;
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/employees",
          headers: auth(),
          payload: {
            usualWorkDays: [1, 2, 3, 4, 5],
            email,
            firstName: "Twin614",
            lastName: "Fixture",
            employeeNumber: `T614-${crypto.randomUUID().slice(0, 8)}`,
            hireDate: hire.toISOString(),
            role: "EMPLOYEE",
            weeklyHours: 40,
            password: "Test@1234567!",
          },
        });
        expect(res.statusCode).toBe(201);
        twins.push(JSON.parse(res.body).id);
      }
      const [anonymized, deactivated] = twins;
      const exitYear = today.getUTCFullYear();
      const rowOf = (employeeId: string) =>
        app.prisma.leaveEntitlement.findFirst({
          where: { employeeId, year: exitYear, leaveType: { code: "VACATION" } },
          select: { totalDays: true, isAutoCalculated: true, usedDays: true },
        });

      // Same booked state before either exit: the creation path wrote identical rows.
      const beforeA = await rowOf(anonymized);
      const beforeB = await rowOf(deactivated);
      expect(beforeA).not.toBeNull();
      expect(beforeB).not.toBeNull();
      expect(Number(beforeA!.totalDays)).toBe(Number(beforeB!.totalDays));

      const deact = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${deactivated}/deactivate`,
        headers: auth(),
        payload: { exitDate: today.toISOString() },
      });
      expect(deact.statusCode).toBe(200);
      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${anonymized}`,
        headers: auth(),
      });
      expect(del.statusCode).toBe(204);

      const afterA = await rowOf(anonymized);
      const afterB = await rowOf(deactivated);
      expect(afterA).not.toBeNull();
      expect(afterB).not.toBeNull();
      expect(Number(afterA!.totalDays)).toBe(Number(afterB!.totalDays));
      expect(afterA!.isAutoCalculated).toBe(afterB!.isAutoCalculated);
      expect(Number(afterA!.usedDays)).toBe(Number(afterB!.usedDays));
    });
  });
});
