/**
 * Issue #836 (D-836-07, D-836-08, D-836-19) — the tracer: `POST /leave/requests` answers with a
 * non-blocking `leaveLimitWarnings` when the request pushes a salon group over a stored rule.
 *
 * Fixture (fake clock 2026-06-15T10:00Z, installed BEFORE the app boots): one tenant with its
 * default salon S, person A (raw employee, Mo-Fr contract) and person B (the seeded employee,
 * Mo-Fr contract), both homed in S. August 2026: Mon 3rd .. Fri 7th is A's leave, B asks for
 * Wed 5th .. Tue 11th. The overlapping workdays are Wed 5th, Thu 6th and Fri 7th; the weekend
 * between is not a workday of anyone. No person names.
 *
 * Mutation proof (Phase 836, 2026-11-06) — recorded here, not re-run by CI; each change was
 * reverted with cp afterwards:
 * M1 check.ts: `count <= rule.maxPersons` turned into `count < rule.maxPersons` (the equal case
 *    warns) -> red: "warns with the overlapping workdays …", "a CLASSIFICATION group …", "under the
 *    limit the response carries no key", "a PENDING leave of another person counts too" (4 failed |
 *    3 passed).
 * M2 constants.ts: SICK added to LEAVE_LIMIT_COUNTED_CODES -> red: "a SICK request never warns, even
 *    against a blackout of zero persons" (1 failed | 6 passed).
 * M3 leave.ts: the catch rethrows instead of logging -> red: "a failing check never loses the
 *    created request" (1 failed | 6 passed).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

const PASSWORD = "test1234";

type Warning = {
  ruleId: string;
  salonId: string;
  maxPersons: number;
  days: Array<{
    day: string;
    count: number;
    max: number;
    persons: unknown[];
    hiddenCount: number;
  }>;
};

describe("Issue #836 — POST /leave/requests warns when a salon limit is exceeded", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let personA: string;

  async function addLeaveOfA(status: "APPROVED" | "PENDING") {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId: personA,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-08-03T00:00:00Z"),
        endDate: new Date("2026-08-07T00:00:00Z"),
        days: 5,
        status,
      },
    });
  }

  function addRule(maxPersons: number, groupKind: "ALL" | "CLASSIFICATION" = "ALL") {
    return app.prisma.leaveLimitRule.create({
      data: {
        tenantId: data.tenant.id,
        salonId: data.salonId,
        groupKind,
        classification: groupKind === "CLASSIFICATION" ? "VOLLZEIT" : null,
        maxPersons,
        name: "Fixture rule",
      },
    });
  }

  function postB(type: "VACATION" | "SICK", startDate: string, endDate: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type, startDate, endDate },
    });
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "lv836a");
    const user = await app.prisma.user.create({
      data: {
        email: `a-${Date.now().toString(36)}@example.invalid`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        isActive: true,
      },
    });
    const a = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `A836${Date.now().toString(36)}`.slice(0, 20),
        firstName: "A",
        lastName: "Leave836",
        hireDate: new Date("2024-01-01"),
      },
    });
    personA = a.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId: personA,
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
    for (const employeeId of [personA, data.employee.id]) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: data.tenant.id,
          employeeId,
          salonId: data.salonId,
          kind: "HOME",
          validFrom: new Date("2024-01-01T00:00:00Z"),
          validUntil: null,
          weekdays: [],
        },
      });
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.prisma.leaveLimitRule.deleteMany({ where: { tenantId: data.tenant.id } });
    await app.prisma.leaveRequest.deleteMany({
      where: { employeeId: { in: [personA, data.employee.id] } },
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

  it("warns with the overlapping workdays and counts when an approved leave fills the limit", async () => {
    await addLeaveOfA("APPROVED");
    const rule = await addRule(1);

    const res = await postB("VACATION", "2026-08-05", "2026-08-11");
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body) as { id: string; leaveLimitWarnings?: Warning[] };
    // the request exists although it exceeds the limit (warn, never block)
    expect(await app.prisma.leaveRequest.count({ where: { id: body.id } })).toBe(1);
    expect(body.leaveLimitWarnings).toHaveLength(1);
    const warning = body.leaveLimitWarnings![0];
    expect(warning.ruleId).toBe(rule.id);
    expect(warning.salonId).toBe(data.salonId);
    expect(warning.maxPersons).toBe(1);
    // Wed, Thu, Fri overlap; the weekend and the days only B takes (Mon 10th, Tue 11th) are absent
    // B holds own-data reach only (836-05): A is a number in hiddenCount, never a person
    expect(warning.days).toEqual([
      { day: "2026-08-05", count: 2, max: 1, persons: [], hiddenCount: 1 },
      { day: "2026-08-06", count: 2, max: 1, persons: [], hiddenCount: 1 },
      { day: "2026-08-07", count: 2, max: 1, persons: [], hiddenCount: 1 },
    ]);
    // no person id or name travels in a warning for this reader
    expect(res.body).not.toContain(personA);
  });

  it("a CLASSIFICATION group of the requester is checked on its own", async () => {
    await addLeaveOfA("APPROVED");
    await addRule(1, "CLASSIFICATION");
    const res = await postB("VACATION", "2026-08-05", "2026-08-11");
    expect(res.statusCode, res.body).toBe(201);
    const warnings = (JSON.parse(res.body) as { leaveLimitWarnings?: Warning[] })
      .leaveLimitWarnings;
    expect(warnings).toHaveLength(1);
    expect(warnings![0].days.map((d) => d.day)).toEqual(["2026-08-05", "2026-08-06", "2026-08-07"]);
  });

  it("under the limit the response carries no key", async () => {
    await addLeaveOfA("APPROVED");
    await addRule(2);
    const res = await postB("VACATION", "2026-08-05", "2026-08-11");
    expect(res.statusCode, res.body).toBe(201);
    expect(JSON.parse(res.body)).not.toHaveProperty("leaveLimitWarnings");
  });

  it("without any rule the body has exactly the keys it had before", async () => {
    await addLeaveOfA("APPROVED");
    const res = await postB("VACATION", "2026-08-05", "2026-08-11");
    expect(res.statusCode, res.body).toBe(201);
    expect(Object.keys(JSON.parse(res.body)).sort()).toEqual(
      [
        "attestPresent",
        "attestValidFrom",
        "attestValidTo",
        "cancellationRequestedBy",
        "createdAt",
        "days",
        "daysProvisional",
        "deletedAt",
        "employee",
        "employeeId",
        "endDate",
        "halfDay",
        "id",
        "leaveType",
        "leaveTypeId",
        "note",
        "overtimeCompMinutes",
        "reviewNote",
        "reviewedAt",
        "reviewedBy",
        "specialLeaveRuleId",
        "startDate",
        "status",
        "typeCode",
        "updatedAt",
      ].sort(),
    );
  });

  it("a PENDING leave of another person counts too", async () => {
    await addLeaveOfA("PENDING");
    await addRule(1);
    const res = await postB("VACATION", "2026-08-05", "2026-08-11");
    expect(res.statusCode, res.body).toBe(201);
    const warnings = (JSON.parse(res.body) as { leaveLimitWarnings?: Warning[] })
      .leaveLimitWarnings;
    expect(warnings).toHaveLength(1);
    expect(warnings![0].days).toHaveLength(3);
  });

  it("a SICK request never warns, even against a blackout of zero persons", async () => {
    await addLeaveOfA("APPROVED");
    await addRule(0);
    const res = await postB("SICK", "2026-08-05", "2026-08-11");
    expect(res.statusCode, res.body).toBe(201);
    expect(JSON.parse(res.body)).not.toHaveProperty("leaveLimitWarnings");
  });

  it("a failing check never loses the created request", async () => {
    await addLeaveOfA("APPROVED");
    await addRule(1);
    vi.spyOn(app.prisma.leaveLimitRule, "findMany").mockRejectedValue(new Error("boom"));
    const res = await postB("VACATION", "2026-08-05", "2026-08-11");
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body) as { id: string };
    expect(body).not.toHaveProperty("leaveLimitWarnings");
    expect(await app.prisma.leaveRequest.count({ where: { id: body.id } })).toBe(1);
  });
});
