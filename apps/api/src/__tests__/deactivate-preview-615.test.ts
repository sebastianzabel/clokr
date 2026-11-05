/**
 * Issue #615 (D-08/D-09/D-10/D-11/D-17/D-21) — `POST /api/v1/employees/:id/deactivate/preview`.
 *
 * The read-only call the deactivate dialog loads before confirming: the evaluated last working day,
 * the exit plan's absences, the live saldo and the exit-year Resturlaub. A successful preview writes
 * nothing (no business row, no audit row); a refused day is returned in the body with exactly the
 * status, code and text `PATCH /:id/deactivate` answers. Rights per figure: see
 * `deactivate-preview-rights-615.test.ts`.
 *
 * Every date is computed relative to the tenant-local today, so the file passes on any day of the
 * year.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { fromZonedTime } from "date-fns-tz";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
  grantSystemRole,
  numericEmployeeNumber,
  reissueTokenNow,
} from "./setup";
import { getTenantTimezone, todayInTz } from "../contexts/working-time-account";

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const utcMidnight = (iso: string) => new Date(`${iso}T00:00:00Z`);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
/** First date on or after `from` whose UTC weekday is `weekday` (0 = Sunday). */
const onOrAfter = (from: Date, weekday: number) =>
  addDays(from, (weekday - from.getUTCDay() + 7) % 7);
const firstWeekdayOnOrAfter = (from: Date) => {
  let day = from;
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day = addDays(day, 1);
  return day;
};
/** Plain-JSON copy so Decimal / Date compare by value. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface PreviewBody {
  exitDate: string;
  today: string;
  storedExitDate: string | null;
  refusal: { status: number; code: string; error: string } | null;
  absences: Array<Record<string, unknown>> | null;
  saldo: { balanceMinutes: number; asOf: string } | null;
  saldoUnavailableReason: string | null;
  vacation: Record<string, unknown> | null;
  vacationUnavailableReason: string | null;
}

describe("Issue #615 — deactivation preview", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let today: Date;
  let firstOfLastMonth: Date;

  const auth = () => ({ authorization: `Bearer ${data.adminToken}` });

  /** Employee with a fixed contract, a login and entitlement rows for every year touched. */
  async function createWorker(label: string, opts: { hireDate?: Date } = {}) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@example.invalid`,
        passwordHash: await bcrypt.hash("test1234", 10),
        isActive: true,
      },
    });
    const hireDate = opts.hireDate ?? firstOfLastMonth;
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: "Prev615",
        lastName: "Fixture",
        employeeNumber: numericEmployeeNumber(),
        hireDate,
      },
    });
    await grantSystemRole(app.prisma, {
      tenantId: data.tenant.id,
      userId: user.id,
      role: "EMPLOYEE",
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
        validFrom: hireDate,
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    await seedEntitlementYears(app, {
      employeeId: employee.id,
      leaveTypeId: data.vacationType.id,
      years: [today.getUTCFullYear() - 1, today.getUTCFullYear(), today.getUTCFullYear() + 1],
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: user.email, password: "test1234" },
    });
    expect(login.statusCode).toBe(200);
    return { user, employee, token: JSON.parse(login.body).accessToken as string };
  }
  type Worker = Awaited<ReturnType<typeof createWorker>>;

  /** Creates a VACATION request as the employee and approves it as the admin. */
  async function approvedVacation(who: { token: string }, start: Date, end: Date) {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${who.token}` },
      payload: { type: "VACATION", startDate: isoDay(start), endDate: isoDay(end) },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = JSON.parse(created.body).id as string;
    const reviewed = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: auth(),
      payload: { status: "APPROVED" },
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    return app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
  }

  async function workerWithVacation(label: string, opts: { hireDate?: Date } = {}) {
    const worker = await createWorker(label, opts);
    const start = onOrAfter(addDays(today, 8), 1); // a Monday, wholly after today
    const vacation = await approvedVacation(worker, start, addDays(start, 2));
    return { worker, vacation };
  }

  const preview = (
    employeeId: string,
    payload?: Record<string, unknown>,
    headers: Record<string, string> = auth(),
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/employees/${employeeId}/deactivate/preview`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });

  const deactivate = (employeeId: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employeeId}/deactivate`,
      headers: auth(),
      ...(payload === undefined ? {} : { payload }),
    });

  const closeLastMonth = async (who: Worker) => {
    const closed = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-month",
      headers: auth(),
      payload: {
        employeeId: who.employee.id,
        year: firstOfLastMonth.getUTCFullYear(),
        month: firstOfLastMonth.getUTCMonth() + 1,
        confirmGaps: true,
      },
    });
    expect(closed.statusCode, closed.body).toBe(201);
  };

  /**
   * Everything a deactivation or a preview could touch for one person: the login state, the
   * employee row, every leave request, absence and entitlement row, the unrevoked refresh tokens,
   * the person's overtime account and the audit rows (the whole table: a preview writes none).
   */
  async function writeSnapshot(who: Worker) {
    const employeeId = who.employee.id;
    return plain({
      user: await app.prisma.user.findUniqueOrThrow({ where: { id: who.user.id } }),
      employee: await app.prisma.employee.findUniqueOrThrow({ where: { id: employeeId } }),
      leave: await app.prisma.leaveRequest.findMany({
        where: { employeeId },
        orderBy: [{ id: "asc" }],
      }),
      absences: await app.prisma.absence.findMany({
        where: { employeeId },
        orderBy: [{ id: "asc" }],
      }),
      entitlements: await app.prisma.leaveEntitlement.findMany({
        where: { employeeId },
        orderBy: [{ year: "asc" }, { id: "asc" }],
      }),
      overtimeAccount: await app.prisma.overtimeAccount.findUnique({ where: { employeeId } }),
      snapshots: await app.prisma.saldoSnapshot.count({ where: { employeeId } }),
      unrevokedTokens: await app.prisma.refreshToken.count({
        where: { userId: who.user.id, revokedAt: null },
      }),
      auditRows: await app.prisma.auditLog.count(),
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "deactivate-preview-615");
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    expect(tz).toBe("Europe/Berlin");
    today = todayInTz(tz);
    firstOfLastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("deactivate-preview-615 test cleanup failed:", err);
    }
  });

  // ── Tracer: the contract ─────────────────────────────────────────────────────────────────────
  describe("contract", () => {
    it("answers the evaluated day, the exit plan's absences, the live saldo and the exit-year Resturlaub, and writes nothing", async () => {
      const { worker, vacation } = await workerWithVacation("contract");
      // The current-year row is machine-owned, so the exit rule would recompute it.
      await app.prisma.leaveEntitlement.updateMany({
        where: { employeeId: worker.employee.id, year: today.getUTCFullYear() },
        data: { isAutoCalculated: true },
      });
      const before = await writeSnapshot(worker);

      const res = await preview(worker.employee.id, { exitDate: isoDay(today) });
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as PreviewBody;

      expect(Object.keys(body).sort((a, b) => a.localeCompare(b))).toEqual(
        [
          "absences",
          "exitDate",
          "refusal",
          "saldo",
          "saldoUnavailableReason",
          "storedExitDate",
          "today",
          "vacation",
          "vacationUnavailableReason",
        ].sort((a, b) => a.localeCompare(b)),
      );
      expect(body.exitDate).toBe(isoDay(today));
      expect(body.today).toBe(isoDay(today));
      expect(body.storedExitDate).toBeNull();
      expect(body.refusal).toBeNull();

      expect(body.absences).toHaveLength(1);
      expect(body.absences![0]).toMatchObject({
        entity: "LeaveRequest",
        id: vacation.id,
        action: "CANCEL",
        typeCode: "VACATION",
      });
      expect(body.absences).toEqual(
        plain(
          await app.absenceExit.preview({
            tenantId: data.tenant.id,
            employeeId: worker.employee.id,
            exitDay: utcMidnight(isoDay(today)),
            marker: { auditReason: "Deaktivierung", trigger: "DEACTIVATION" },
          }),
        ),
      );

      expect(body.saldoUnavailableReason).toBeNull();
      expect(body.saldo).not.toBeNull();
      expect(Number.isInteger(body.saldo!.balanceMinutes)).toBe(true);
      expect(body.saldo!.asOf).toBe(isoDay(addDays(today, -1)));

      expect(body.vacationUnavailableReason).toBeNull();
      expect(body.vacation).toEqual(
        plain(await app.exitVacationBalance(worker.employee.id, data.tenant.id, isoDay(today))),
      );
      expect(body.vacation).toMatchObject({ year: today.getUTCFullYear(), asOf: isoDay(today) });

      expect(await writeSnapshot(worker)).toEqual(before);
    });

    it("a stored exit date is reported as storedExitDate", async () => {
      const worker = await createWorker("stored-exit");
      const stored = addDays(today, 20);
      await app.prisma.employee.update({
        where: { id: worker.employee.id },
        data: { exitDate: stored },
      });
      const res = await preview(worker.employee.id, { exitDate: isoDay(today) });
      expect(res.statusCode, res.body).toBe(200);
      expect((JSON.parse(res.body) as PreviewBody).storedExitDate).toBe(isoDay(stored));
    });

    it("an inactive person gets the 409 of the deactivation", async () => {
      const worker = await createWorker("inactive");
      expect((await deactivate(worker.employee.id, { exitDate: isoDay(today) })).statusCode).toBe(
        200,
      );
      const res = await preview(worker.employee.id, { exitDate: isoDay(today) });
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: "Mitarbeiter ist bereits deaktiviert" });
    });
  });

  // ── Refusal parity with the deactivation ─────────────────────────────────────────────────────
  describe("a refused day is returned in the body exactly as the deactivation answers it", () => {
    async function expectParity(
      who: Worker,
      day: string,
      status: number,
      code: string,
    ): Promise<PreviewBody> {
      const res = await preview(who.employee.id, { exitDate: day });
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as PreviewBody;
      expect(body.refusal).toMatchObject({ status, code });
      expect(body.refusal!.error.length).toBeGreaterThan(10);
      expect(body.absences).toBeNull();
      expect(body.vacation).toBeNull();
      expect(body.vacationUnavailableReason).toBe("EXIT_DATE_REFUSED");
      // The saldo does not depend on the day and stays visible for a caller who may read it.
      expect(body.saldo).not.toBeNull();

      const patch = await deactivate(who.employee.id, { exitDate: day });
      expect(patch.statusCode, patch.body).toBe(status);
      expect(JSON.parse(patch.body)).toEqual({
        error: body.refusal!.error,
        code: body.refusal!.code,
      });
      return body;
    }

    it("a future day is EXIT_DATE_IN_FUTURE (400)", async () => {
      const { worker } = await workerWithVacation("future");
      await expectParity(worker, isoDay(addDays(today, 1)), 400, "EXIT_DATE_IN_FUTURE");
    });

    it("a day before the hire day is EXIT_DATE_BEFORE_HIRE (400)", async () => {
      const hireDay = addDays(today, -10);
      const worker = await createWorker("before-hire", {
        hireDate: utcMidnight(isoDay(hireDay)),
      });
      await expectParity(worker, isoDay(addDays(hireDay, -1)), 400, "EXIT_DATE_BEFORE_HIRE");
    });

    it("a day in a closed month is MONTH_LOCKED (409)", async () => {
      const worker = await createWorker("locked");
      await closeLastMonth(worker);
      await expectParity(
        worker,
        isoDay(firstWeekdayOnOrAfter(firstOfLastMonth)),
        409,
        "MONTH_LOCKED",
      );
    });

    it("a refusal writes nothing either", async () => {
      const { worker } = await workerWithVacation("refusal-no-write");
      const before = await writeSnapshot(worker);
      const res = await preview(worker.employee.id, { exitDate: isoDay(addDays(today, 1)) });
      expect(res.statusCode, res.body).toBe(200);
      expect(await writeSnapshot(worker)).toEqual(before);
    });

    it("an impossible date is a validation 400 for the preview too", async () => {
      const worker = await createWorker("bad-format");
      const res = await preview(worker.employee.id, { exitDate: "2026-02-30" });
      expect(res.statusCode, res.body).toBe(400);
    });
  });

  // ── Tenant-local default (D-01) ──────────────────────────────────────────────────────────────
  describe("the default day is the tenant-local today", () => {
    it("without a body the evaluated day is today", async () => {
      const worker = await createWorker("default-day");
      const res = await preview(worker.employee.id);
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as PreviewBody;
      expect(body.exitDate).toBe(isoDay(today));
      expect(body.today).toBe(isoDay(today));
    });

    it("at 00:30 Europe/Berlin (the UTC day is still the previous one) the day and today are the Berlin day", async () => {
      const worker = await createWorker("berlin");
      const instant = fromZonedTime(`${isoDay(today)}T00:30:00`, "Europe/Berlin");
      expect(isoDay(instant)).toBe(isoDay(addDays(today, -1)));

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(instant);
      try {
        const headers = { authorization: `Bearer ${reissueTokenNow(app, data.adminToken)}` };
        const res = await preview(worker.employee.id, undefined, headers);
        expect(res.statusCode, res.body).toBe(200);
        const body = JSON.parse(res.body) as PreviewBody;
        expect(body.exitDate).toBe(isoDay(today));
        expect(body.today).toBe(isoDay(today));
        expect(body.refusal).toBeNull();
        // The saldo window ends the tenant-local day before.
        expect(body.saldo!.asOf).toBe(isoDay(addDays(today, -1)));

        const next = await preview(
          worker.employee.id,
          { exitDate: isoDay(addDays(today, 1)) },
          headers,
        );
        expect((JSON.parse(next.body) as PreviewBody).refusal?.code).toBe("EXIT_DATE_IN_FUTURE");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Live saldo and Resturlaub parity ─────────────────────────────────────────────────────────
  describe("figures come from the same places the account pages read", () => {
    it("the saldo is the live value of GET /overtime/:employeeId, not the stored balance", async () => {
      const worker = await createWorker("live-saldo", {
        hireDate: utcMidnight(isoDay(addDays(today, -7))),
      });
      await app.prisma.overtimeAccount.update({
        where: { employeeId: worker.employee.id },
        data: { balanceHours: 99 },
      });
      const got = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${worker.employee.id}`,
        headers: auth(),
      });
      expect(got.statusCode, got.body).toBe(200);
      const live = (JSON.parse(got.body) as { balanceHours: number }).balanceHours;

      const res = await preview(worker.employee.id, { exitDate: isoDay(today) });
      const body = JSON.parse(res.body) as PreviewBody;
      expect(body.saldo!.balanceMinutes).toBe(Math.round(live * 60));
      expect(body.saldo!.balanceMinutes).not.toBe(99 * 60);
    });

    it("the Resturlaub equals what GET /leave/entitlements shows after the deactivation on the same day", async () => {
      const year = today.getUTCFullYear();
      const worker = await createWorker("rest-parity", { hireDate: utcMidnight("2024-01-01") });
      // Only the exit-year row: an unused earlier year would be carried over lazily by the GET
      // below (a write of that read route), which the preview - a pure read - cannot anticipate.
      await app.prisma.leaveEntitlement.deleteMany({
        where: { employeeId: worker.employee.id, year: { not: year } },
      });
      await app.prisma.leaveEntitlement.updateMany({
        where: { employeeId: worker.employee.id, year },
        data: { isAutoCalculated: true },
      });
      const res = await preview(worker.employee.id, { exitDate: isoDay(today) });
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as PreviewBody;
      expect(body.vacation).not.toBeNull();
      const projected = body.vacation as { remainingAtExitDays: number };

      expect((await deactivate(worker.employee.id, { exitDate: isoDay(today) })).statusCode).toBe(
        200,
      );
      const got = await app.inject({
        method: "GET",
        url: `/api/v1/leave/entitlements/${worker.employee.id}?year=${year}`,
        headers: auth(),
      });
      expect(got.statusCode, got.body).toBe(200);
      const row = (
        JSON.parse(got.body) as Array<{ vacationBalance: { remainingDays: number } | null }>
      ).find((r) => r.vacationBalance !== null)!;
      expect(row.vacationBalance!.remainingDays).toBe(projected.remainingAtExitDays);
    });

    it("a person without a VACATION row has no Resturlaub: NO_ENTITLEMENT", async () => {
      const worker = await createWorker("no-entitlement");
      await app.prisma.leaveEntitlement.deleteMany({ where: { employeeId: worker.employee.id } });
      const res = await preview(worker.employee.id, { exitDate: isoDay(today) });
      const body = JSON.parse(res.body) as PreviewBody;
      expect(body.vacation).toBeNull();
      expect(body.vacationUnavailableReason).toBe("NO_ENTITLEMENT");
    });
  });
});
