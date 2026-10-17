/**
 * Issue #614 (D-02, AC-614-2) — the anonymization ends EVERY absence that starts after the exit
 * day: all three open statuses, every leave type, the imposed Berufsschule rows; rows the law or
 * the revision rules protect (closed month, § 17 BEEG reduction, live § 9 credit) are left alone
 * and reported; a row changed between plan and apply aborts the anonymization with 409.
 *
 * One describe per row of the classification table in employment-exit.ts. Every date is relative
 * to the tenant-local today (rows start in the next month, i.e. after the exit day, which is
 * today for a person without a stored exit date), so the file passes on any day of the year.
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

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const utcMidnight = (iso: string) => new Date(`${iso}T00:00:00Z`);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
/** First date on or after `from` whose UTC weekday is `weekday` (0 = Sunday). */
const onOrAfter = (from: Date, weekday: number) =>
  addDays(from, (weekday - from.getUTCDay() + 7) % 7);

const NOTE = "Notiz-Zebra-614";

describe("Issue #614 — anonymization ends every absence after the exit", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let today: Date;
  let nextMonth: Date;
  const types = {} as Record<"OVERTIME_COMP" | "SPECIAL" | "PARENTAL" | "SICK", string>;

  const auth = () => ({ authorization: `Bearer ${data.adminToken}` });

  /** A Monday in the next month (the 8th or later), so every row starts after today. */
  const nextMonday = () => onOrAfter(addDays(nextMonth, 7), 1);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "anon-kinds-614");
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    today = todayInTz(tz);
    nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    for (const code of ["OVERTIME_COMP", "SPECIAL", "PARENTAL", "SICK"] as const) {
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
      console.error("anonymization-absence-kinds-614 test cleanup failed:", err);
    }
  });

  /** Employee with a fixed Mo-Fr contract, a login and entitlement rows for every year touched. */
  async function createWorker(label: string, opts: { exitDate?: Date | null } = {}) {
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
        firstName: "Exit614",
        lastName: "Fixture",
        employeeNumber: `K614-${suffix}`,
        hireDate: utcMidnight(`${today.getUTCFullYear() - 2}-01-01`),
        exitDate: opts.exitDate ?? null,
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

  /** A VACATION request created as the employee; approved as the admin when `approve` is set. */
  async function vacation(who: Worker, start: Date, end: Date, approve: boolean) {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${who.token}` },
      payload: { type: "VACATION", startDate: isoDay(start), endDate: isoDay(end), note: NOTE },
    });
    expect(created.statusCode).toBe(201);
    const id = JSON.parse(created.body).id as string;
    if (approve) {
      const reviewed = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${id}/review`,
        headers: auth(),
        payload: { status: "APPROVED" },
      });
      expect(reviewed.statusCode).toBe(200);
    }
    return app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
  }

  /** A PENDING row of another type written directly, approved through the review API when asked. */
  async function typedRequest(
    who: Worker,
    code: "OVERTIME_COMP" | "SPECIAL",
    start: Date,
    approve: boolean,
  ) {
    const row = await app.prisma.leaveRequest.create({
      data: {
        employeeId: who.employee.id,
        leaveTypeId: types[code],
        startDate: start,
        endDate: start,
        days: 1,
        status: "PENDING",
        note: NOTE,
      },
    });
    if (approve) {
      const reviewed = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${row.id}/review`,
        headers: auth(),
        payload: { status: "APPROVED" },
      });
      expect(reviewed.statusCode, reviewed.body).toBe(200);
    }
    return app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: row.id } });
  }

  const anonymize = (employeeId: string) =>
    app.inject({ method: "DELETE", url: `/api/v1/employees/${employeeId}`, headers: auth() });

  const usedDays = async (employeeId: string, year: number) =>
    Number(
      (
        await app.prisma.leaveEntitlement.findFirstOrThrow({
          where: { employeeId, year, leaveType: { code: "VACATION" } },
          select: { usedDays: true },
        })
      ).usedDays,
    );

  const status = async (id: string) =>
    (await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } })).status;

  const anonymizeAudit = async (employeeId: string) =>
    (
      await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: employeeId, action: "ANONYMIZE" },
      })
    ).newValue as {
      absencesEnded: { cancelled: number; shortened: number; deleted: number };
      skipped: Array<{ entity: string; id: string; reason: string }>;
    };

  /** Every audit row of the given entity ids: no free text, no PII, and the marker on the exit's rows. */
  async function expectCleanAudits(who: Worker, entity: string, ids: string[]) {
    const rows = await app.prisma.auditLog.findMany({
      where: { entity, entityId: { in: ids } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const text = JSON.stringify(row.oldValue) + JSON.stringify(row.newValue);
      for (const secret of [NOTE, "Exit614", "Fixture", who.user.email]) {
        expect(text).not.toContain(secret);
      }
      const nv = row.newValue as Record<string, unknown> | null;
      if (nv && nv.auditReason === "Anonymisierung") expect(nv.trigger).toBe("ANONYMIZATION");
    }
  }

  describe("PENDING request", () => {
    it("is CANCELLED without any booking, audited once, and the managers' open notice is dismissed after the commit", async () => {
      const worker = await createWorker("pend");
      const start = nextMonday();
      const row = await vacation(worker, start, addDays(start, 2), false);
      expect(row.status).toBe("PENDING");
      const notice = await app.prisma.notification.create({
        data: {
          userId: data.adminUser.id,
          type: "LEAVE_REQUEST",
          title: "Urlaubsantrag",
          message: "Neuer Antrag",
          relatedType: "LeaveRequest",
          relatedId: row.id,
        },
      });
      const year = start.getUTCFullYear();
      const usedBefore = await usedDays(worker.employee.id, year);

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      const after = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.status).toBe("CANCELLED");
      expect(after.deletedAt).toBeNull();
      expect(await usedDays(worker.employee.id, year)).toBe(usedBefore);

      const cancel = await soleAuditRow(app.prisma, {
        where: { entity: "LeaveRequest", entityId: row.id, action: "CANCEL" },
      });
      const nv = cancel.newValue as Record<string, unknown>;
      expect(nv.auditReason).toBe("Anonymisierung");
      expect(nv.trigger).toBe("ANONYMIZATION");
      expect((cancel.oldValue as Record<string, unknown>).status).toBe("PENDING");
      await expectCleanAudits(worker, "LeaveRequest", [row.id]);

      const dismissed = await app.prisma.notification.findUniqueOrThrow({
        where: { id: notice.id },
      });
      expect(dismissed.dismissedAt).not.toBeNull();
    });
  });

  describe("CANCELLATION_REQUESTED request", () => {
    it("VACATION is CANCELLED and booked back exactly like an approved cancellation", async () => {
      const worker = await createWorker("cancreq");
      const start = nextMonday();
      const row = await vacation(worker, start, addDays(start, 2), true);
      const year = start.getUTCFullYear();
      const usedApproved = await usedDays(worker.employee.id, year);
      const cancelReq = await app.inject({
        method: "DELETE",
        url: `/api/v1/leave/requests/${row.id}`,
        headers: { authorization: `Bearer ${worker.token}` },
        payload: { reason: "Plan geändert" },
      });
      expect(cancelReq.statusCode, cancelReq.body).toBe(200);
      expect(await status(row.id)).toBe("CANCELLATION_REQUESTED");
      expect(await usedDays(worker.employee.id, year)).toBe(usedApproved);

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      expect(await status(row.id)).toBe("CANCELLED");
      expect(await usedDays(worker.employee.id, year)).toBe(usedApproved - Number(row.days));
      const cancels = await auditRowsFor(app, "LeaveRequest", row.id, "CANCEL");
      expect(
        cancels.filter(
          (r) => (r.newValue as Record<string, unknown>).auditReason === "Anonymisierung",
        ),
      ).toHaveLength(1);
      await expectCleanAudits(worker, "LeaveRequest", [row.id]);
    });
  });

  describe("APPROVED request", () => {
    it("VACATION is CANCELLED with the entitlement days booked back (one CANCEL audit)", async () => {
      const worker = await createWorker("apprvac");
      const start = nextMonday();
      const row = await vacation(worker, start, addDays(start, 3), true);
      const year = start.getUTCFullYear();
      const usedBefore = await usedDays(worker.employee.id, year);
      expect(usedBefore).toBeGreaterThanOrEqual(Number(row.days));

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      expect(await status(row.id)).toBe("CANCELLED");
      expect(await usedDays(worker.employee.id, year)).toBe(usedBefore - Number(row.days));
      expect(await auditRowsFor(app, "LeaveRequest", row.id, "CANCEL")).toHaveLength(1);
      expect((await anonymizeAudit(worker.employee.id)).absencesEnded.cancelled).toBe(1);
    });

    it("OVERTIME_COMP reverses exactly the STORED minutes and audits OVERTIME_COMP_REVERSED with source stored", async () => {
      const worker = await createWorker("approt");
      const start = nextMonday();
      const row = await typedRequest(worker, "OVERTIME_COMP", start, true);
      expect(row.status).toBe("APPROVED");
      expect(row.overtimeCompMinutes).toBe(480);
      // The stored amount is what counts, never a recomputation: change it away from the
      // schedule-derived value so a recomputing implementation would book 480 instead of 300.
      await app.prisma.leaveRequest.update({
        where: { id: row.id },
        data: { overtimeCompMinutes: 300 },
      });
      const account = await app.prisma.overtimeAccount.findUniqueOrThrow({
        where: { employeeId: worker.employee.id },
      });
      const txBefore = await app.prisma.overtimeTransaction.count({
        where: { overtimeAccountId: account.id },
      });

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      expect(await status(row.id)).toBe("CANCELLED");
      const txs = await app.prisma.overtimeTransaction.findMany({
        where: { overtimeAccountId: account.id, type: "CORRECTION" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(txs).toHaveLength(1);
      expect(Number(txs[0].hours)).toBe(5); // 300 stored minutes / 60
      expect(txs[0].description).toContain("(Anonymisierung)");
      expect(
        await app.prisma.overtimeTransaction.count({ where: { overtimeAccountId: account.id } }),
      ).toBe(txBefore + 1);

      const reversed = await soleAuditRow(app.prisma, {
        where: { entity: "LeaveRequest", entityId: row.id, action: "OVERTIME_COMP_REVERSED" },
      });
      expect(reversed.newValue).toEqual({ overtimeCompMinutes: 300, hours: 5, source: "stored" });
      expect(await auditRowsFor(app, "LeaveRequest", row.id, "CANCEL")).toHaveLength(1);
    });

    it("SPECIAL (booking-neutral) is CANCELLED without any entitlement or journal change", async () => {
      const worker = await createWorker("apprspec");
      const start = nextMonday();
      const row = await typedRequest(worker, "SPECIAL", start, true);
      expect(row.status).toBe("APPROVED");
      const year = start.getUTCFullYear();
      const usedBefore = await usedDays(worker.employee.id, year);
      const account = await app.prisma.overtimeAccount.findUniqueOrThrow({
        where: { employeeId: worker.employee.id },
      });
      const txBefore = await app.prisma.overtimeTransaction.count({
        where: { overtimeAccountId: account.id },
      });

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      expect(await status(row.id)).toBe("CANCELLED");
      expect(await usedDays(worker.employee.id, year)).toBe(usedBefore);
      expect(
        await app.prisma.overtimeTransaction.count({ where: { overtimeAccountId: account.id } }),
      ).toBe(txBefore);
      expect(await auditRowsFor(app, "LeaveRequest", row.id, "CANCEL")).toHaveLength(1);
    });

    it("revalidates invalid time entries of the cancelled range, one UPDATE TimeEntry audit each", async () => {
      const worker = await createWorker("reval");
      const start = nextMonday();
      const row = await vacation(worker, start, addDays(start, 1), true);
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: worker.employee.id,
          date: start,
          startTime: new Date(`${isoDay(start)}T06:00:00Z`),
          endTime: new Date(`${isoDay(start)}T10:00:00Z`),
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
          salonId: data.salonId,
          isInvalid: true,
          invalidReasonCode: "LEAVE_CANCELLATION_PENDING",
        },
      });

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(after.isInvalid).toBe(false);
      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "TimeEntry", entityId: entry.id, action: "UPDATE" },
      });
      expect((audit.newValue as Record<string, unknown>).auditReason).toBe("Anonymisierung");
      expect((audit.newValue as Record<string, unknown>).trigger).toBe("ANONYMIZATION");
      expect(await status(row.id)).toBe("CANCELLED");
    });
  });

  describe("Berufsschule (Absence) rows", () => {
    it("after the exit day: soft-deleted, row kept, one DELETE audit; a multi-day row spanning the exit day is skipped SPANNING_ABSENCE", async () => {
      const worker = await createWorker("bs");
      const start = nextMonday();
      const later = await app.prisma.absence.create({
        data: {
          employeeId: worker.employee.id,
          type: "VOCATIONAL_SCHOOL",
          source: "MANUAL",
          startDate: start,
          endDate: start,
          days: 1,
          note: NOTE,
          createdBy: "system",
        },
      });
      const spanning = await app.prisma.absence.create({
        data: {
          employeeId: worker.employee.id,
          type: "VOCATIONAL_SCHOOL",
          source: "MANUAL",
          startDate: addDays(today, -1),
          endDate: addDays(today, 1),
          days: 3,
          createdBy: "system",
        },
      });

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      const gone = await app.prisma.absence.findUniqueOrThrow({ where: { id: later.id } });
      expect(gone.deletedAt).not.toBeNull();
      const kept = await app.prisma.absence.findUniqueOrThrow({ where: { id: spanning.id } });
      expect(kept.deletedAt).toBeNull();

      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "Absence", entityId: later.id, action: "DELETE" },
      });
      const nv = audit.newValue as Record<string, unknown>;
      expect(nv.auditReason).toBe("Anonymisierung");
      expect(nv.trigger).toBe("ANONYMIZATION");
      expect(await auditRowsFor(app, "Absence", spanning.id)).toHaveLength(0);
      await expectCleanAudits(worker, "Absence", [later.id]);

      const summary = await anonymizeAudit(worker.employee.id);
      expect(summary.absencesEnded.deleted).toBe(1);
      expect(summary.skipped).toContainEqual({
        entity: "Absence",
        id: spanning.id,
        reason: "SPANNING_ABSENCE",
      });
    });
  });

  describe("rows that are never changed, only reported", () => {
    it("CLOSED_MONTH: an approved vacation inside a closed month stays APPROVED, entitlement unchanged, reported", async () => {
      const worker = await createWorker("closed");
      const lastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
      // Months close in order from the first tracked month, so last month must be the first one.
      await app.prisma.employee.update({
        where: { id: worker.employee.id },
        data: { hireDate: lastMonth },
      });
      const start = onOrAfter(addDays(lastMonth, 7), 1);
      // The Bestand defect: leave after an old exit, inside a month that was closed meanwhile.
      // Written directly (a past-month request cannot be created while the exit date is old).
      const row = await app.prisma.leaveRequest.create({
        data: {
          employeeId: worker.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: start,
          endDate: addDays(start, 2),
          days: 3,
          status: "APPROVED",
          note: NOTE,
        },
      });
      const year = start.getUTCFullYear();
      await app.prisma.leaveEntitlement.updateMany({
        where: { employeeId: worker.employee.id, year, leaveType: { code: "VACATION" } },
        data: { usedDays: 3 },
      });

      const close = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: auth(),
        payload: {
          employeeId: worker.employee.id,
          year: lastMonth.getUTCFullYear(),
          month: lastMonth.getUTCMonth() + 1,
          confirmGaps: true,
        },
      });
      expect(close.statusCode, close.body).toBe(201);
      // The exit date is set directly, after the close: it lies on the third day of the closed
      // month, before the leave recorded after it - the Bestand shape.
      await app.prisma.employee.update({
        where: { id: worker.employee.id },
        data: { exitDate: addDays(lastMonth, 2) },
      });

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      expect(await status(row.id)).toBe("APPROVED");
      expect(await usedDays(worker.employee.id, year)).toBe(3);
      expect(await auditRowsFor(app, "LeaveRequest", row.id, "CANCEL")).toHaveLength(0);
      const summary = await anonymizeAudit(worker.employee.id);
      expect(summary.skipped).toContainEqual({
        entity: "LeaveRequest",
        id: row.id,
        reason: "CLOSED_MONTH",
      });
    });

    it("PARENTAL_REDUCTION_ACTIVE: an approved Elternzeit with an active § 17 BEEG reduction stays APPROVED, reported", async () => {
      const worker = await createWorker("parental");
      const start = nextMonth;
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, 0));
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
      const commit = await app.inject({
        method: "POST",
        url: `/api/v1/leave/parental-reductions/${row.id}`,
        headers: { ...auth(), "content-type": "application/json" },
        payload: JSON.stringify({ declaredAt: "2020-01-01", years: [start.getUTCFullYear()] }),
      });
      expect(commit.statusCode, commit.body).toBeLessThan(300);

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      expect(await status(row.id)).toBe("APPROVED");
      expect(await auditRowsFor(app, "LeaveRequest", row.id, "CANCEL")).toHaveLength(0);
      expect((await anonymizeAudit(worker.employee.id)).skipped).toContainEqual({
        entity: "LeaveRequest",
        id: row.id,
        reason: "PARENTAL_REDUCTION_ACTIVE",
      });
    });

    it("SECTION9_CREDIT_ACTIVE: a vacation referenced by a non-superseded § 9 credit stays APPROVED, reported", async () => {
      const worker = await createWorker("sec9");
      const start = nextMonday();
      const row = await vacation(worker, start, addDays(start, 2), true);
      const sick = await app.prisma.leaveRequest.create({
        data: {
          employeeId: worker.employee.id,
          leaveTypeId: types.SICK,
          startDate: start,
          endDate: addDays(start, 1),
          days: 2,
          status: "APPROVED",
        },
      });
      // Written directly: a future sick/vacation pair cannot be produced through the API.
      await app.prisma.section9Credit.create({
        data: {
          employeeId: worker.employee.id,
          sickRequestId: sick.id,
          vacationRequestId: row.id,
          overlapStart: start,
          overlapEnd: addDays(start, 1),
        },
      });
      const year = start.getUTCFullYear();
      const usedBefore = await usedDays(worker.employee.id, year);

      expect((await anonymize(worker.employee.id)).statusCode).toBe(204);

      expect(await status(row.id)).toBe("APPROVED");
      expect(await usedDays(worker.employee.id, year)).toBe(usedBefore);
      expect(await auditRowsFor(app, "LeaveRequest", row.id, "CANCEL")).toHaveLength(0);
      expect((await anonymizeAudit(worker.employee.id)).skipped).toContainEqual({
        entity: "LeaveRequest",
        id: row.id,
        reason: "SECTION9_CREDIT_ACTIVE",
      });
    });
  });

  describe("a row changed between plan and apply (409 EMPLOYMENT_EXIT_CONFLICT)", () => {
    /** Two approved vacations; the plan sees both, the LATER one is flipped before apply runs. */
    async function conflictFixture(label: string) {
      const worker = await createWorker(label);
      const start = nextMonday();
      const first = await vacation(worker, start, addDays(start, 1), true);
      const second = await vacation(worker, addDays(start, 7), addDays(start, 8), true);
      return { worker, first, second, year: start.getUTCFullYear() };
    }

    it("the route answers 409 and writes nothing, including the request that was already cancelled inside the transaction", async () => {
      const { worker, first, second, year } = await conflictFixture("conflict");
      const usedBefore = await usedDays(worker.employee.id, year);
      const originalPlan = app.absenceExit.plan;
      app.absenceExit.plan = async (input) => {
        const plan = await originalPlan(input);
        // Between plan and apply: someone else moves the second request out of APPROVED.
        await app.prisma.leaveRequest.update({
          where: { id: second.id },
          data: { status: "CANCELLATION_REQUESTED" },
        });
        return plan;
      };
      let res;
      try {
        res = await anonymize(worker.employee.id);
      } finally {
        app.absenceExit.plan = originalPlan;
      }
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("EMPLOYMENT_EXIT_CONFLICT");

      // Nothing of the transaction survived: the first request (planned first, already
      // cancelled when the second failed) is APPROVED again, the booking is untouched, the
      // person is not anonymized and no exit date was stored.
      expect(await status(first.id)).toBe("APPROVED");
      expect(await status(second.id)).toBe("CANCELLATION_REQUESTED");
      expect(await usedDays(worker.employee.id, year)).toBe(usedBefore);
      const employee = await app.prisma.employee.findUniqueOrThrow({
        where: { id: worker.employee.id },
      });
      expect(employee.firstName).toBe("Exit614");
      expect(employee.exitDate).toBeNull();
      expect(await auditRowsFor(app, "LeaveRequest", first.id, "CANCEL")).toHaveLength(0);
      expect(await auditRowsFor(app, "LeaveRequest", second.id, "CANCEL")).toHaveLength(0);
      expect(await auditRowsFor(app, "Employee", worker.employee.id, "ANONYMIZE")).toHaveLength(0);
    });

    it("apply() itself rejects with code EMPLOYMENT_EXIT_CONFLICT and rolls its writes back", async () => {
      const { worker, first, second, year } = await conflictFixture("conflict-direct");
      const usedBefore = await usedDays(worker.employee.id, year);
      const plan = await app.absenceExit.plan({
        tenantId: data.tenant.id,
        employeeId: worker.employee.id,
        exitDay: today,
      });
      expect(plan.actions).toHaveLength(2);
      await app.prisma.leaveRequest.update({
        where: { id: second.id },
        data: { status: "CANCELLATION_REQUESTED" },
      });

      const audited: string[] = [];
      await expect(
        app.prisma.$transaction((tx) =>
          app.absenceExit.apply(tx, plan, async (entry) => {
            audited.push(entry.entityId);
          }),
        ),
      ).rejects.toMatchObject({ code: "EMPLOYMENT_EXIT_CONFLICT" });

      expect(audited).toContain(first.id); // the first request really was processed ...
      expect(await status(first.id)).toBe("APPROVED"); // ... and rolled back
      expect(await usedDays(worker.employee.id, year)).toBe(usedBefore);
    });
  });
});
