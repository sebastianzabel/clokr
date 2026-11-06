/**
 * Issue #836 (D-836-09/10/11, AC-6/AC-10/AC-14) — approving a request over a salon limit needs an
 * audited exception: without `limitException` the API answers 409 and writes NOTHING.
 *
 * Fixture (fake clock 2026-06-15T10:00Z, installed BEFORE the app boots): one tenant with its
 * default salon S and a second salon S2; person A (raw employee, Mo-Fr contract, homed in S) has an
 * approved vacation Mon 3 Aug .. Fri 7 Aug 2026; person B (the seeded employee, homed in S) asks for
 * Wed 5 .. Fri 7 Aug; person C (raw employee, homed in S2). The admin of the seed approves. No names.
 *
 * Mutation proof (Phase 836, 2026-11-06) — recorded here, not re-run by CI; each change was
 * reverted with cp afterwards:
 * M1 leave.ts review: `if (!body.limitException)` turned into `if (false)` (the 409 never fires) ->
 *    red: "409 without an exception ...", the window blackout case, "a PENDING request filed before
 *    the blackout ..." (3 failed | 10 passed).
 * M2 leave.ts review: the exception spread removed from the APPROVE audit -> red: "records the
 *    exception with its reason ..." (1 failed | 12 passed).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  auditRowsFor,
  soleAuditRow,
} from "./setup";
import { evaluateLeaveLimits } from "../contexts/absence/leave-limits";

const PASSWORD = "test1234";
const REASON = "Hochzeit der Tochter, mit Team abgestimmt";

describe("Issue #836 — review needs an exception over a limit", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let personA: string;
  let personC: string;
  let salon2: string;

  async function rawEmployee(tag: string, salonId: string) {
    const user = await app.prisma.user.create({
      data: {
        email: `${tag}-${Date.now().toString(36)}@example.invalid`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        isActive: true,
      },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `${tag}${Date.now().toString(36)}`.slice(0, 20),
        firstName: tag,
        lastName: "Leave836",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await home(emp.id, salonId);
    return emp.id;
  }

  function home(employeeId: string, salonId: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  function leave(
    employeeId: string,
    status: "APPROVED" | "PENDING" | "CANCELLATION_REQUESTED",
    startDate: string,
    endDate: string,
    days: number,
    createdAt?: Date,
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(`${startDate}T00:00:00Z`),
        endDate: new Date(`${endDate}T00:00:00Z`),
        days,
        status,
        ...(createdAt ? { createdAt } : {}),
      },
    });
  }

  function rule(
    over: Partial<{
      salonId: string | null;
      maxPersons: number;
      validFrom: Date | null;
      validUntil: Date | null;
    }> = {},
  ) {
    return app.prisma.leaveLimitRule.create({
      data: {
        tenantId: data.tenant.id,
        salonId: data.salonId,
        groupKind: "ALL",
        maxPersons: 1,
        name: "Fixture rule",
        ...over,
      },
    });
  }

  function review(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload,
    });
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "lv836b");
    salon2 = (await createTestSalon(app.prisma, data.tenant.id, { name: "Zweiter Salon" })).id;
    personA = await rawEmployee("A", data.salonId);
    personC = await rawEmployee("C", salon2);
    await home(data.employee.id, data.salonId);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.prisma.leaveLimitRule.deleteMany({ where: { tenantId: data.tenant.id } });
    await app.prisma.leaveRequest.deleteMany({
      where: { employeeId: { in: [personA, personC, data.employee.id] } },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("409 without an exception, and the request, the audit and the notices stay untouched", async () => {
    await leave(personA, "APPROVED", "2026-08-03", "2026-08-07", 5);
    const pending = await leave(data.employee.id, "PENDING", "2026-08-05", "2026-08-07", 3);
    const r = await rule();
    const notificationsBefore = await app.prisma.notification.count({
      where: { userId: data.empUser.id },
    });

    const res = await review(pending.id, { status: "APPROVED" });
    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body) as {
      code: string;
      exceedances: Array<{
        ruleId: string;
        days: Array<{ day: string; count: number; persons: Array<{ employeeId: string }> }>;
      }>;
    };
    expect(body.code).toBe("LEAVE_LIMIT_EXCEPTION_REQUIRED");
    expect(body.exceedances[0].ruleId).toBe(r.id);
    expect(body.exceedances[0].days.map((d) => d.count)).toEqual([2, 2, 2]);
    // the seeded admin reads the whole tenant (836-05): A is named; who else is hidden is covered by
    // leave-limits-redaction-836.test.ts
    expect(body.exceedances[0].days[0].persons.map((p) => p.employeeId)).toEqual([personA]);

    const after = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.status).toBe("PENDING");
    expect(after.reviewedAt).toBeNull();
    expect(after.reviewedBy).toBeNull();
    expect(Number(after.days)).toBe(3);
    expect(await auditRowsFor(app, "LeaveRequest", pending.id, "APPROVE")).toHaveLength(0);
    expect(await app.prisma.notification.count({ where: { userId: data.empUser.id } })).toBe(
      notificationsBefore,
    );
  });

  it("records the exception with its reason, the rule snapshot and the day counts in the APPROVE audit", async () => {
    await leave(personA, "APPROVED", "2026-08-03", "2026-08-07", 5);
    const pending = await leave(data.employee.id, "PENDING", "2026-08-05", "2026-08-07", 3);
    const r = await rule();

    const res = await review(pending.id, {
      status: "APPROVED",
      limitException: { reason: `  ${REASON}  ` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).status).toBe("APPROVED");

    const row = await soleAuditRow(app.prisma, {
      where: { entity: "LeaveRequest", entityId: pending.id, action: "APPROVE" },
    });
    const exception = (row.newValue as Record<string, unknown>).leaveLimitException as {
      reason: string;
      rules: Array<{ ruleId: string; maxPersons: number; salonId: string | null }>;
      days: Array<{ day: string; salonId: string; ruleId: string; count: number }>;
    };
    expect(exception.reason).toBe(REASON);
    expect(exception.rules).toHaveLength(1);
    expect(exception.rules[0]).toMatchObject({
      ruleId: r.id,
      maxPersons: 1,
      salonId: data.salonId,
    });
    expect(exception.days).toEqual([
      { day: "2026-08-05", salonId: data.salonId, ruleId: r.id, count: 2 },
      { day: "2026-08-06", salonId: data.salonId, ruleId: r.id, count: 2 },
      { day: "2026-08-07", salonId: data.salonId, ruleId: r.id, count: 2 },
    ]);
    expect(JSON.stringify(row)).not.toContain(personA);
  });

  it("a reason outside 10 to 500 characters is a 400 with the German message", async () => {
    await leave(personA, "APPROVED", "2026-08-03", "2026-08-07", 5);
    const pending = await leave(data.employee.id, "PENDING", "2026-08-05", "2026-08-07", 3);
    await rule();
    for (const reason of ["zu kurz", "x".repeat(501)]) {
      const res = await review(pending.id, { status: "APPROVED", limitException: { reason } });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toContain("Die Begründung der Ausnahme muss 10 bis 500 Zeichen lang sein.");
    }
    const after = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.status).toBe("PENDING");
  });

  it("an exception on a request under the limit is ignored and never audited", async () => {
    const pending = await leave(data.employee.id, "PENDING", "2026-08-05", "2026-08-07", 3);
    await rule();
    const res = await review(pending.id, {
      status: "APPROVED",
      limitException: { reason: REASON },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await soleAuditRow(app.prisma, {
      where: { entity: "LeaveRequest", entityId: pending.id, action: "APPROVE" },
    });
    expect(Object.keys(row.newValue as object)).not.toContain("leaveLimitException");
  });

  it("a rejection and a cancellation approval over the limit are never checked", async () => {
    await leave(personA, "APPROVED", "2026-08-03", "2026-08-07", 5);
    await rule();
    const rejected = await leave(data.employee.id, "PENDING", "2026-08-05", "2026-08-07", 3);
    const res = await review(rejected.id, { status: "REJECTED", reviewNote: "Nein" });
    expect(res.statusCode, res.body).toBe(200);

    const cancelling = await leave(
      data.employee.id,
      "CANCELLATION_REQUESTED",
      "2026-08-05",
      "2026-08-07",
      3,
    );
    const res2 = await review(cancelling.id, { status: "APPROVED" });
    expect(res2.statusCode, res2.body).toBe(200);
    expect(JSON.parse(res2.body).status).toBe("CANCELLED");
  });

  it("a blackout window for the salon needs the exception, a blackout for all salons too", async () => {
    const blackout = await rule({
      maxPersons: 0,
      validFrom: new Date("2026-08-05T00:00:00Z"),
      validUntil: new Date("2026-08-06T00:00:00Z"),
    });
    const pending = await leave(data.employee.id, "PENDING", "2026-08-05", "2026-08-07", 3);
    const res = await review(pending.id, { status: "APPROVED" });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).exceedances[0].days.map((d: { day: string }) => d.day)).toEqual([
      "2026-08-05",
      "2026-08-06",
    ]);
    await app.prisma.leaveLimitRule.delete({ where: { id: blackout.id } });

    await rule({ salonId: null, maxPersons: 0 });
    const pendingC = await leave(personC, "PENDING", "2026-08-05", "2026-08-06", 2);
    const resC = await review(pendingC.id, { status: "APPROVED" });
    expect(resC.statusCode, resC.body).toBe(409);
    const okC = await review(pendingC.id, {
      status: "APPROVED",
      limitException: { reason: REASON },
    });
    expect(okC.statusCode, okC.body).toBe(200);
  });

  it("a PENDING request filed before the blackout was created still needs the exception", async () => {
    const pending = await leave(
      data.employee.id,
      "PENDING",
      "2026-08-05",
      "2026-08-07",
      3,
      new Date("2026-05-01T08:00:00Z"),
    );
    await rule({ maxPersons: 0 });
    const res = await review(pending.id, { status: "APPROVED" });
    expect(res.statusCode, res.body).toBe(409);
  });

  it("with no rule the APPROVE audit keeps exactly its former key set", async () => {
    const pending = await leave(data.employee.id, "PENDING", "2026-08-05", "2026-08-07", 3);
    const res = await review(pending.id, { status: "APPROVED", reviewNote: "ok" });
    expect(res.statusCode, res.body).toBe(200);
    const row = await soleAuditRow(app.prisma, {
      where: { entity: "LeaveRequest", entityId: pending.id, action: "APPROVE" },
    });
    expect(Object.keys(row.newValue as object).sort()).toEqual(
      ["days", "daysProvisional", "reviewNote", "status"].sort(),
    );
  });

  describe("short-circuit: no rule that could apply, no fact loading (AC-14)", () => {
    /** Wraps the client and records every `model.method` call of the checker. */
    function recording(db: FastifyInstance["prisma"]) {
      const calls: string[] = [];
      const proxy = new Proxy(db, {
        get(target, model, receiver) {
          const value = Reflect.get(target, model, receiver) as unknown;
          if (typeof model !== "string" || typeof value !== "object" || value === null) {
            return value;
          }
          return new Proxy(value, {
            get(delegate, method) {
              const fn = Reflect.get(delegate, method) as unknown;
              if (typeof fn !== "function") return fn;
              return (...args: unknown[]) => {
                calls.push(`${model}.${String(method)}`);
                return (fn as (...a: unknown[]) => unknown).apply(delegate, args);
              };
            },
          });
        },
      });
      return { db: proxy as FastifyInstance["prisma"], calls };
    }

    const candidate = (employeeId: string) => ({
      requestId: null,
      employeeId,
      typeCode: "VACATION",
      startDay: "2026-08-05",
      endDay: "2026-08-07",
    });

    it("no rule at all reads the rules and nothing else", async () => {
      const { db, calls } = recording(app.prisma);
      const result = await evaluateLeaveLimits(db, data.tenant.id, {
        candidates: [candidate(data.employee.id)],
        excludeRequestIds: [],
      });
      expect(result.exceedances).toEqual([]);
      expect(calls).toEqual(["leaveLimitRule.findMany"]);
    });

    it("a soft-removed rule counts as no rule", async () => {
      await rule();
      await app.prisma.leaveLimitRule.updateMany({
        where: { tenantId: data.tenant.id },
        data: { deletedAt: new Date("2026-06-01T00:00:00Z") },
      });
      const { db, calls } = recording(app.prisma);
      await evaluateLeaveLimits(db, data.tenant.id, {
        candidates: [candidate(data.employee.id)],
        excludeRequestIds: [],
      });
      expect(calls).toEqual(["leaveLimitRule.findMany"]);
    });

    it("a rule of another salon reads the rules and the Stammsalon only", async () => {
      await rule({ salonId: salon2 });
      const { db, calls } = recording(app.prisma);
      const result = await evaluateLeaveLimits(db, data.tenant.id, {
        candidates: [candidate(data.employee.id)],
        excludeRequestIds: [],
      });
      expect(result.exceedances).toEqual([]);
      expect(calls).toEqual(["leaveLimitRule.findMany", "employeeSalonAssignment.findMany"]);
    });

    it("a rule window that misses the request reads the rules only", async () => {
      await rule({
        validFrom: new Date("2026-09-01T00:00:00Z"),
        validUntil: new Date("2026-09-30T00:00:00Z"),
      });
      const { db, calls } = recording(app.prisma);
      await evaluateLeaveLimits(db, data.tenant.id, {
        candidates: [candidate(data.employee.id)],
        excludeRequestIds: [],
      });
      expect(calls).toEqual(["leaveLimitRule.findMany"]);
    });

    it("a tenant without an active salon and without rules never reaches the holiday resolver", async () => {
      // holidaysAtWorkLocation throws for a tenant without an active salon; the checker must not
      // get that far when there is nothing to check (the review of such a tenant behaves as before).
      const bare = await seedTestData(app, "lv836bare", { withDefaultSalon: false });
      try {
        const { db, calls } = recording(app.prisma);
        const result = await evaluateLeaveLimits(db, bare.tenant.id, {
          candidates: [candidate(bare.employee.id)],
          excludeRequestIds: [],
        });
        expect(result.exceedances).toEqual([]);
        expect(calls).toEqual(["leaveLimitRule.findMany"]);
      } finally {
        await cleanupTestData(app, bare.tenant.id);
      }
    });
  });
});
