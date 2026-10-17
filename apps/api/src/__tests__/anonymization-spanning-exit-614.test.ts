/**
 * Issue #614 (D-02, AC-614-2) — a request that SPANS the exit day is shortened to end ON it, never
 * cancelled: an APPROVED / CANCELLATION_REQUESTED one through the leave correction core (old
 * booking reversed, new booking applied, days re-priced, § 9 credits superseded or clipped), a
 * PENDING one by re-pricing its days. Nothing left up to the exit -> cancelled instead; a row the
 * core refuses stays untouched and is reported.
 *
 * Deterministic weekdays: every case creates its requests through the API FIRST (a future week),
 * then fixes the exit day X on the employee row (D-01 keeps an existing exit date). X is the
 * Wednesday of the first holiday-free week at least two weeks ahead; the requests run Mon-Fri of
 * that week. The exit-day-is-today path is proven by anonymization-ends-employment-614.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
  grantSystemRole,
  auditRowsFor,
  soleAuditRow,
} from "./setup";
import { getTenantTimezone, todayInTz } from "../contexts/working-time-account";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { getHolidayMap, resolveLeaveDays } from "../contexts/absence/leave-days";

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const utcMidnight = (iso: string) => new Date(`${iso}T00:00:00Z`);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
/** First date on or after `from` whose UTC weekday is `weekday` (0 = Sunday). */
const onOrAfter = (from: Date, weekday: number) =>
  addDays(from, (weekday - from.getUTCDay() + 7) % 7);

const NOTE = "Notiz-Zebra-614-spanning";

describe("Issue #614 — anonymization shortens requests that span the exit day", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let today: Date;
  let monday: Date;
  let wednesday: Date;
  const types = {} as Record<"PARENTAL" | "SICK", string>;

  const auth = () => ({ authorization: `Bearer ${data.adminToken}` });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "anon-spanning-614");
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    today = todayInTz(tz);
    for (const code of ["PARENTAL", "SICK"] as const) {
      const row = await app.prisma.leaveType.create({
        data: { tenantId: data.tenant.id, ...leaveTypeFields(code), color: "#8B5CF6" },
      });
      types[code] = row.id;
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("anonymization-spanning-exit-614 test cleanup failed:", err);
    }
  });

  /** Employee with a fixed Mo-Fr contract, a login and entitlement rows for every year touched. */
  async function createWorker(label: string) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@example.invalid`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: "Span614",
        lastName: "Fixture",
        employeeNumber: `S614-${suffix}`,
        hireDate: utcMidnight(`${today.getUTCFullYear() - 2}-01-01`),
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
        validFrom: utcMidnight(`${today.getUTCFullYear() - 2}-01-01`),
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    await seedEntitlementYears(app, {
      employeeId: employee.id,
      leaveTypeId: data.vacationType.id,
      years: [today.getUTCFullYear(), today.getUTCFullYear() + 1],
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

  /** Monday of the first week (two weeks ahead or later) without a public holiday Mon-Fri. */
  async function fixtureWeek(who: Worker) {
    if (monday) return;
    for (let week = 0; week < 30; week++) {
      const candidate = onOrAfter(addDays(today, 14 + week * 7), 1);
      const holidays = await getHolidayMap(
        app.prisma,
        data.tenant.id,
        who.employee.id,
        candidate,
        addDays(candidate, 4),
      );
      if (holidays.size === 0) {
        monday = candidate;
        wednesday = addDays(candidate, 2);
        return;
      }
    }
    throw new Error("no holiday-free week found");
  }

  async function request(
    who: Worker,
    type: "VACATION" | "SICK",
    start: Date,
    end: Date,
    approve: boolean,
  ) {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${who.token}` },
      payload: { type, startDate: isoDay(start), endDate: isoDay(end), note: NOTE },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = JSON.parse(created.body).id as string;
    if (approve) {
      const reviewed = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${id}/review`,
        headers: auth(),
        payload: { status: "APPROVED" },
      });
      expect(reviewed.statusCode, reviewed.body).toBe(200);
    }
    return app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
  }

  /** D-01: an existing exit date stays, so the test fixes the exit day (the weekday) itself. */
  const setExit = (who: Worker, exitDay: Date) =>
    app.prisma.employee.update({ where: { id: who.employee.id }, data: { exitDate: exitDay } });

  const anonymize = (employeeId: string) =>
    app.inject({ method: "DELETE", url: `/api/v1/employees/${employeeId}`, headers: auth() });

  /** Sum of the VACATION `usedDays` over every year row (a fixture week may cross New Year). */
  const usedSum = async (employeeId: string) =>
    (
      await app.prisma.leaveEntitlement.findMany({
        where: { employeeId, leaveType: { code: "VACATION" } },
        select: { usedDays: true },
      })
    ).reduce((sum, row) => sum + Number(row.usedDays), 0);

  const reload = (id: string) => app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });

  const anonymizeAudit = async (employeeId: string) =>
    (
      await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: employeeId, action: "ANONYMIZE" },
      })
    ).newValue as {
      absencesEnded: { cancelled: number; shortened: number; deleted: number };
      skipped: Array<{ entity: string; id: string; reason: string }>;
    };

  /** The days the kernel prices for [start, end] of an existing request (self-excluded). */
  async function kernelDays(who: Worker, id: string, start: Date, end: Date, code = "VACATION") {
    const holidays = await getHolidayMap(app.prisma, data.tenant.id, who.employee.id, start, end);
    return (
      await resolveLeaveDays(
        app.prisma,
        who.employee.id,
        data.tenant.id,
        start,
        end,
        false,
        new Set(holidays.keys()),
        { mode: "request", leaveTypeCode: code, excludeRequestId: id },
      )
    ).days;
  }

  /** No audit row of the entity ids carries a note, a name or an e-mail; the exit's rows carry the marker. */
  async function expectCleanAudits(who: Worker, entity: string, ids: string[]) {
    const rows = await app.prisma.auditLog.findMany({
      where: { entity, entityId: { in: ids } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const text = JSON.stringify(row.oldValue) + JSON.stringify(row.newValue);
      for (const secret of [NOTE, "Span614", "Fixture", who.user.email]) {
        expect(text).not.toContain(secret);
      }
      const nv = row.newValue as Record<string, unknown> | null;
      if (nv && nv.auditReason === "Anonymisierung") expect(nv.trigger).toBe("ANONYMIZATION");
    }
  }

  describe("APPROVED request spanning the exit day", () => {
    it("ends ON the exit day, status unchanged, days re-priced by the kernel, entitlement moved by the difference, one LEAVE_CORRECTED without free text", async () => {
      const worker = await createWorker("appr");
      await fixtureWeek(worker);
      const row = await request(worker, "VACATION", monday, addDays(monday, 4), true);
      expect(row.status).toBe("APPROVED");
      const oldDays = Number(row.days);
      const usedBefore = await usedSum(worker.employee.id);
      await setExit(worker, wednesday);

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      const after = await reload(row.id);
      expect(after.status).toBe("APPROVED");
      expect(isoDay(after.startDate)).toBe(isoDay(monday));
      expect(isoDay(after.endDate)).toBe(isoDay(wednesday));
      const expected = await kernelDays(worker, row.id, monday, wednesday);
      expect(expected).toBeGreaterThan(0);
      expect(Number(after.days)).toBe(expected);
      expect(after.note).toBeNull();
      expect(await usedSum(worker.employee.id)).toBe(usedBefore - (oldDays - expected));

      const corrected = await auditRowsFor(app, "LeaveRequest", row.id, "LEAVE_CORRECTED");
      expect(corrected).toHaveLength(1);
      const nv = corrected[0].newValue as Record<string, unknown>;
      expect(nv.trigger).toBe("ANONYMIZATION");
      expect(nv.auditReason).toBe("Anonymisierung");
      expect(nv.endDate).toBe(isoDay(wednesday));
      expect(nv.days).toBe(expected);
      expect(nv.exitDate).toBe(isoDay(wednesday));
      expect(await auditRowsFor(app, "LeaveRequest", row.id, "CANCEL")).toHaveLength(0);
      await expectCleanAudits(worker, "LeaveRequest", [row.id]);

      const ended = await anonymizeAudit(worker.employee.id);
      expect(ended.absencesEnded.shortened).toBe(1);
      expect(ended.absencesEnded.cancelled).toBe(0);
      expect(ended.skipped).toEqual([]);
    });
  });

  describe("CANCELLATION_REQUESTED request spanning the exit day", () => {
    it("is shortened the same way and keeps its status", async () => {
      const worker = await createWorker("cancreq");
      await fixtureWeek(worker);
      const row = await request(worker, "VACATION", monday, addDays(monday, 4), true);
      // Written directly: the cancellation request endpoint adds nothing to this fixture.
      await app.prisma.leaveRequest.update({
        where: { id: row.id },
        data: { status: "CANCELLATION_REQUESTED" },
      });
      const oldDays = Number(row.days);
      const usedBefore = await usedSum(worker.employee.id);
      await setExit(worker, wednesday);

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      const after = await reload(row.id);
      expect(after.status).toBe("CANCELLATION_REQUESTED");
      expect(isoDay(after.endDate)).toBe(isoDay(wednesday));
      const expected = await kernelDays(worker, row.id, monday, wednesday);
      expect(Number(after.days)).toBe(expected);
      expect(await usedSum(worker.employee.id)).toBe(usedBefore - (oldDays - expected));
      expect(await auditRowsFor(app, "LeaveRequest", row.id, "LEAVE_CORRECTED")).toHaveLength(1);
      expect((await anonymizeAudit(worker.employee.id)).absencesEnded.shortened).toBe(1);
    });
  });

  describe("PENDING request spanning the exit day", () => {
    it("ends on the exit day with re-priced days, no booking, one UPDATE audit", async () => {
      const worker = await createWorker("pend");
      await fixtureWeek(worker);
      const row = await request(worker, "VACATION", monday, addDays(monday, 4), false);
      expect(row.status).toBe("PENDING");
      const usedBefore = await usedSum(worker.employee.id);
      await setExit(worker, wednesday);

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      const after = await reload(row.id);
      expect(after.status).toBe("PENDING");
      expect(isoDay(after.endDate)).toBe(isoDay(wednesday));
      const expected = await kernelDays(worker, row.id, monday, wednesday);
      expect(Number(after.days)).toBe(expected);
      expect(after.note).toBeNull();
      expect(await usedSum(worker.employee.id)).toBe(usedBefore);

      const updates = await auditRowsFor(app, "LeaveRequest", row.id, "UPDATE");
      const exitUpdates = updates.filter(
        (u) => (u.newValue as Record<string, unknown> | null)?.trigger === "ANONYMIZATION",
      );
      expect(exitUpdates).toHaveLength(1);
      const nv = exitUpdates[0].newValue as Record<string, unknown>;
      expect(nv.endDate).toBe(isoDay(wednesday));
      expect(nv.days).toBe(expected);
      expect(await auditRowsFor(app, "LeaveRequest", row.id, "LEAVE_CORRECTED")).toHaveLength(0);
      await expectCleanAudits(worker, "LeaveRequest", [row.id]);
      expect((await anonymizeAudit(worker.employee.id)).absencesEnded.shortened).toBe(1);
    });
  });

  describe("nothing remains up to the exit day", () => {
    it("(weekend path) a vacation from the exit SATURDAY on is re-priced to 0 days up to it and CANCELLED, the stored days booked back", async () => {
      const worker = await createWorker("nothing");
      await fixtureWeek(worker);
      const saturday = addDays(monday, 5);
      const nextWednesday = addDays(monday, 9);
      const usedBefore = await usedSum(worker.employee.id);
      const row = await request(worker, "VACATION", saturday, nextWednesday, true);
      expect(Number(row.days)).toBeGreaterThan(0);
      expect(await usedSum(worker.employee.id)).toBe(usedBefore + Number(row.days));
      await setExit(worker, saturday);

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      const after = await reload(row.id);
      expect(after.status).toBe("CANCELLED");
      // The booking is reversed by the STORED days, so the ledger is exactly where it started.
      expect(await usedSum(worker.employee.id)).toBe(usedBefore);
      expect(await auditRowsFor(app, "LeaveRequest", row.id, "CANCEL")).toHaveLength(1);
      expect(await auditRowsFor(app, "LeaveRequest", row.id, "LEAVE_CORRECTED")).toHaveLength(0);
      const ended = await anonymizeAudit(worker.employee.id);
      expect(ended.absencesEnded.cancelled).toBe(1);
      expect(ended.absencesEnded.shortened).toBe(0);
    });
  });

  describe("§ 9 pair spanning the exit day", () => {
    it("supersedes the credit, books a clipped replacement up to the exit, ledger net follows the core's arithmetic, PII sweep nulls the replacement's document and reason", async () => {
      const worker = await createWorker("sec9");
      await fixtureWeek(worker);
      const vacation = await request(worker, "VACATION", monday, addDays(monday, 4), true);
      // Sick Tue-Thu inside the vacation: it spans the exit day (Wednesday) as well.
      const sick = await request(worker, "SICK", addDays(monday, 1), addDays(monday, 3), true);
      const credit = await app.prisma.section9Credit.findFirstOrThrow({
        where: { sickRequestId: sick.id },
      });
      const confirmed = await app.inject({
        method: "POST",
        url: `/api/v1/leave/section9/${credit.id}/confirm`,
        headers: auth(),
        payload: {
          attestSource: "EAU",
          attestValidFrom: isoDay(addDays(monday, 1)),
          attestValidTo: isoDay(addDays(monday, 3)),
          reason: "AU eingereicht",
        },
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(Number(JSON.parse(confirmed.body).creditedDays)).toBe(3);
      await app.prisma.section9Credit.update({
        where: { id: credit.id },
        data: { documentPath: "section9/doc-614-spanning.pdf" },
      });
      await setExit(worker, wednesday);

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      const original = await app.prisma.section9Credit.findUniqueOrThrow({
        where: { id: credit.id },
      });
      expect(original.status).toBe("SUPERSEDED");
      const replacement = await app.prisma.section9Credit.findFirstOrThrow({
        where: { supersedesId: credit.id },
      });
      expect(replacement.status).toBe("CONFIRMED");
      expect(isoDay(replacement.creditedStart!)).toBe(isoDay(addDays(monday, 1)));
      expect(isoDay(replacement.creditedEnd!)).toBe(isoDay(wednesday));
      expect(Number(replacement.creditedDays)).toBe(2);
      // PII sweep after the exit writes: the replacement copied the document pointer and wrote a reason.
      expect(replacement.documentPath).toBeNull();
      expect(replacement.reason).toBeNull();
      expect(original.documentPath).toBeNull();

      const vacationAfter = await reload(vacation.id);
      const sickAfter = await reload(sick.id);
      expect(isoDay(vacationAfter.endDate)).toBe(isoDay(wednesday));
      expect(isoDay(sickAfter.endDate)).toBe(isoDay(wednesday));
      expect(vacationAfter.status).toBe("APPROVED");
      expect(sickAfter.status).toBe("APPROVED");
      // Ledger: vacation days up to the exit minus the sick days credited back (core: reverse the
      // old booking, undo the credit, apply the new range, re-credit the clipped part).
      expect(await usedSum(worker.employee.id)).toBe(
        Number(vacationAfter.days) - Number(replacement.creditedDays),
      );
      expect(Number(sickAfter.days)).toBe(
        await kernelDays(worker, sick.id, addDays(monday, 1), wednesday, "SICK"),
      );

      const ended = await anonymizeAudit(worker.employee.id);
      expect(ended.absencesEnded.shortened).toBe(2);
      expect(ended.skipped).toEqual([]);
      expect(
        await auditRowsFor(app, "Section9Credit", credit.id, "SECTION9_CREDIT_SUPERSEDED"),
      ).toHaveLength(1);
      await expectCleanAudits(worker, "LeaveRequest", [vacation.id, sick.id]);
      await expectCleanAudits(worker, "Section9Credit", [credit.id, replacement.id]);
    });
  });

  describe("refused by the correction core", () => {
    it("PARENTAL_REDUCTION_ACTIVE: an Elternzeit whose declared § 17 BEEG year would change stays untouched, reported", async () => {
      const worker = await createWorker("parental");
      const year = today.getUTCFullYear();
      const start = utcMidnight(`${year}-01-01`);
      const end = utcMidnight(`${year + 1}-03-31`);
      const row = await app.prisma.leaveRequest.create({
        data: {
          employeeId: worker.employee.id,
          leaveTypeId: types.PARENTAL,
          startDate: start,
          endDate: end,
          days: 0,
          status: "APPROVED",
          reviewedBy: "system",
          reviewedAt: new Date(),
        },
      });
      const declared = await app.inject({
        method: "POST",
        url: `/api/v1/leave/parental-reductions/${row.id}`,
        headers: { ...auth(), "content-type": "application/json" },
        payload: JSON.stringify({ declaredAt: "2020-01-01", years: [year] }),
      });
      expect(declared.statusCode, declared.body).toBeLessThan(300);
      // Exit on 15 January: the year's full-month count drops from 12 to 0.
      await setExit(worker, utcMidnight(`${year}-01-15`));

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      const after = await reload(row.id);
      expect(after.status).toBe("APPROVED");
      expect(isoDay(after.endDate)).toBe(isoDay(end));
      expect(await auditRowsFor(app, "LeaveRequest", row.id, "LEAVE_CORRECTED")).toHaveLength(0);
      const ended = await anonymizeAudit(worker.employee.id);
      expect(ended.skipped).toContainEqual({
        entity: "LeaveRequest",
        id: row.id,
        reason: "PARENTAL_REDUCTION_ACTIVE",
      });
      expect(ended.absencesEnded.shortened).toBe(0);
    });
  });
});
