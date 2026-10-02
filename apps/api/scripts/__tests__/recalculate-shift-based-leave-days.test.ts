/**
 * Issue #425 — `--status`/`--request-id` filter tests for
 * recalculate-shift-based-leave-days.ts.
 *
 * Covers:
 *   - parseCli(): accepts --status PENDING | APPROVED, throws a German error on any other
 *     value, collects repeated --request-id flags into an array, and defaults to
 *     status: null / requestIds: [] when neither flag is given.
 *   - main(): --status PENDING/--status APPROVED narrows the dry-run candidate scan to that
 *     single status; --request-id restricts the scan to specific requests even though another
 *     request would otherwise also be a candidate.
 *
 * Both fixture requests are forced into a stale `days` value directly via Prisma (bypassing the
 * API) after creation — this is what makes them scan CANDIDATES (a mismatch against
 * `countShiftBasedLeaveDays()`'s current value) without depending on any particular
 * Sunday-spanning date; the calculation itself is covered by vacation-calc.test.ts and
 * leave-days-by-contract-417.test.ts.
 *
 * Uses initials-only for employee names (no PII per memory feedback_no_pii_in_github).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData, createTestSalon } from "../../src/__tests__/setup";
import { utcMidnight, dbDateStr, todayStr } from "../../src/__tests__/test-dates";
import { getHolidays, STATE_MAP } from "../../src/contexts/platform/holidays";
import { main, parseCli } from "../recalculate-shift-based-leave-days";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function addDaysIso(iso: string, days: number): string {
  return dbDateStr(new Date(utcMidnight(iso).getTime() + days * DAY_MS));
}

/** Mirrors the identical helper in leave-days-by-contract-417.test.ts. */
function nextHolidayFreeMonday(daysOut: number, weekSpan = 1): string {
  const anchor = utcMidnight(todayStr());
  let candidateIso = dbDateStr(new Date(anchor.getTime() + daysOut * DAY_MS));
  const daysUntilMonday = (8 - utcMidnight(candidateIso).getUTCDay()) % 7;
  candidateIso = addDaysIso(candidateIso, daysUntilMonday);

  const spanDays = weekSpan * 7;
  const MAX_ADVANCES = 16;
  for (let i = 0; i < MAX_ADVANCES; i++) {
    const spanDates: string[] = [];
    for (let d = 0; d < spanDays; d++) spanDates.push(addDaysIso(candidateIso, d));

    const years = new Set(spanDates.map((iso) => Number(iso.slice(0, 4))));
    const holidayDates = new Set<string>();
    for (const y of years) {
      for (const h of getHolidays(y, STATE_MAP.NIEDERSACHSEN)) holidayDates.add(h.date);
    }
    if (!spanDates.some((iso) => holidayDates.has(iso))) return candidateIso;
    candidateIso = addDaysIso(candidateIso, 7);
  }
  throw new Error(
    `nextHolidayFreeMonday: exceeded MAX_ADVANCES without a holiday-free ${weekSpan}-week span`,
  );
}

const PAST_ANCHOR = new Date(Date.UTC(new Date().getUTCFullYear() - 2, 0, 1));
const PENDING_MONDAY = nextHolidayFreeMonday(60);
const APPROVED_MONDAY = nextHolidayFreeMonday(75);

describe("recalculate-shift-based-leave-days — --status/--request-id filters (Issue #425)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let pendingRequestId: string;
  let approvedRequestId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = "rsbld-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `RSBLD ${suffix}`, slug: `rsbld-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await createTestSalon(prisma, tenantId);
    await prisma.tenantConfig.create({ data: { tenantId } });

    const passwordHash = await bcrypt.hash("test1234", 10);

    async function makeUser(label: string, role: "EMPLOYEE" | "ADMIN") {
      const email = `rsbld-${label}-${suffix}@test.de`;
      const user = await prisma.user.create({
        data: { email, passwordHash, role, isActive: true },
      });
      const employee = await prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `RSBLD-${label.toUpperCase()}-${suffix}`,
          firstName: "R",
          lastName: label,
          hireDate: PAST_ANCHOR,
        },
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "test1234" },
      });
      return { employee, token: JSON.parse(login.body).accessToken as string };
    }

    const admin = await makeUser("admin", "ADMIN");
    const adminToken = admin.token;

    const emp = await makeUser("emp", "EMPLOYEE");
    const empId = emp.employee.id;
    const empToken = emp.token;

    await prisma.workSchedule.create({
      data: {
        employeeId: empId,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        contractWorkDaysPerWeek: 5,
        workDays: [1, 2, 3, 4, 5],
        validFrom: PAST_ANCHOR,
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empId, balanceHours: 0 } });

    const vacType = await prisma.leaveType.create({
      data: { tenantId, code: "VACATION", name: "Urlaub", isPaid: true, requiresApproval: true },
    });

    const thisYear = new Date().getUTCFullYear();
    for (const year of [thisYear, thisYear + 1]) {
      await prisma.leaveEntitlement.create({
        data: { employeeId: empId, leaveTypeId: vacType.id, year, totalDays: 200, usedDays: 0 },
      });
    }

    async function postVacation(token: string, startDate: string, endDate: string) {
      return app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "VACATION", startDate, endDate },
      });
    }

    // PENDING request — Mon-Tue on a 5-day contract, correctly computed as 2 days.
    const pendingRes = await postVacation(empToken, PENDING_MONDAY, addDaysIso(PENDING_MONDAY, 1));
    expect(pendingRes.statusCode).toBe(201);
    pendingRequestId = JSON.parse(pendingRes.body).id as string;
    // Force a stale `days` value directly (bypassing the API) — this is what makes the row a
    // scan CANDIDATE (correct value is 2, stored value is now 1).
    await prisma.leaveRequest.update({ where: { id: pendingRequestId }, data: { days: 1 } });

    // APPROVED request — a separate Mon-Tue range, approved by the admin, then also forced
    // stale the same way.
    const approvedRes = await postVacation(
      empToken,
      APPROVED_MONDAY,
      addDaysIso(APPROVED_MONDAY, 1),
    );
    expect(approvedRes.statusCode).toBe(201);
    approvedRequestId = JSON.parse(approvedRes.body).id as string;
    const reviewRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${approvedRequestId}/review`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(reviewRes.statusCode).toBe(200);
    await prisma.leaveRequest.update({ where: { id: approvedRequestId }, data: { days: 1 } });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("recalculate-shift-based-leave-days filter test cleanup failed:", err);
    }
  });

  describe("parseCli()", () => {
    it("accepts --status PENDING", () => {
      expect(parseCli(["--tenant-id", "abc", "--status", "PENDING"])).toMatchObject({
        status: "PENDING",
      });
    });

    it("accepts --status APPROVED", () => {
      expect(parseCli(["--tenant-id", "abc", "--status", "APPROVED"])).toMatchObject({
        status: "APPROVED",
      });
    });

    it("throws a German error on an invalid --status value", () => {
      expect(() => parseCli(["--tenant-id", "abc", "--status", "FOO"])).toThrow(
        /Ungültiger --status Wert/,
      );
    });

    it("collects two repeated --request-id flags into an array of 2", () => {
      const args = parseCli(["--tenant-id", "abc", "--request-id", "id-1", "--request-id", "id-2"]);
      expect(args.requestIds).toEqual(["id-1", "id-2"]);
    });

    it("defaults to status: null, requestIds: [] when neither flag is given", () => {
      const args = parseCli(["--tenant-id", "abc"]);
      expect(args.status).toBeNull();
      expect(args.requestIds).toEqual([]);
    });
  });

  it("--status PENDING narrows the dry-run scan to the PENDING request only", async () => {
    const summary = await main(["--tenant-id", tenantId, "--status", "PENDING"], app.prisma);
    const ids = summary.candidates.map((c) => c.leaveRequestId);
    expect(ids).toContain(pendingRequestId);
    expect(ids).not.toContain(approvedRequestId);
  });

  it("--status APPROVED narrows the dry-run scan to the APPROVED request only", async () => {
    const summary = await main(["--tenant-id", tenantId, "--status", "APPROVED"], app.prisma);
    const ids = summary.candidates.map((c) => c.leaveRequestId);
    expect(ids).toContain(approvedRequestId);
    expect(ids).not.toContain(pendingRequestId);
  });

  it("--request-id restricts the scan to that request even though the PENDING one would otherwise also be a candidate", async () => {
    const summary = await main(
      ["--tenant-id", tenantId, "--request-id", approvedRequestId],
      app.prisma,
    );
    expect(summary.candidates).toHaveLength(1);
    expect(summary.candidates[0]!.leaveRequestId).toBe(approvedRequestId);
  });
});

/**
 * Issue #436 (D-04/D-09) — the Bestand list: two APPROVED VACATION requests of the SAME
 * SHIFT_BASED employee, sharing one ISO week, both carrying their PRE-436 stored `days` (3 each,
 * seeded directly via Prisma rather than priced through the live POST/review endpoints — the
 * live endpoints already apply the week-union rule this script's dry-run is meant to SURFACE,
 * so seeding the OLD value directly is what makes the row a genuine "predates the fix"
 * candidate). `A` (created first, Mo-Mi) has no counted sibling created BEFORE it, so its price
 * under the NEW rule is unchanged (its own 3-day fragment) — NOT a candidate. `B` (created after
 * `A`, Do-Sa) completes the whole Mo-Sa week together with `A`; under the new week-union rule it
 * costs only 1 (4 - A's 3), not its own-alone 3 — a Bestand candidate (`3 -> 1`).
 * `--confirm` is never passed — this proves the dry-run default, not the write path.
 */
describe("recalculate-shift-based-leave-days — Bestand list (Issue #436, D-04/D-09)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let idA: string;
  let idB: string;

  const WEEK_MONDAY = nextHolidayFreeMonday(95);

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = "u436-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `U436B ${suffix}`, slug: `u436b-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await createTestSalon(prisma, tenantId);
    await prisma.tenantConfig.create({ data: { tenantId } });

    const passwordHash = await bcrypt.hash("test1234", 10);
    const email = `u436b-emp-${suffix}@test.de`;
    const user = await prisma.user.create({
      data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `U436B-${suffix}`,
        firstName: "U436B",
        lastName: "emp",
        hireDate: PAST_ANCHOR,
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 38,
        contractWorkDaysPerWeek: 4,
        workDays: [2, 3, 4, 5],
        validFrom: PAST_ANCHOR,
      },
    });

    const vacType = await prisma.leaveType.create({
      data: { tenantId, code: "VACATION", name: "Urlaub", isPaid: true, requiresApproval: true },
    });

    const createdAtA = new Date(PAST_ANCHOR.getTime() + 1000);
    const createdAtB = new Date(PAST_ANCHOR.getTime() + 2000);

    const a = await prisma.leaveRequest.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: vacType.id,
        startDate: new Date(WEEK_MONDAY), // Mo
        endDate: new Date(addDaysIso(WEEK_MONDAY, 2)), // Mi
        halfDay: false,
        status: "APPROVED",
        days: 3, // pre-436 stored value — correct even under the new rule (A alone)
        createdAt: createdAtA,
      },
    });
    idA = a.id;

    const b = await prisma.leaveRequest.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: vacType.id,
        startDate: new Date(addDaysIso(WEEK_MONDAY, 3)), // Do
        endDate: new Date(addDaysIso(WEEK_MONDAY, 5)), // Sa
        halfDay: false,
        status: "APPROVED",
        days: 3, // pre-436 stored value (its OWN 3-day fragment, priced in isolation) — the
        // NEW week-union rule prices it as 1 (4 - A's 3), so this row is the Bestand candidate.
        createdAt: createdAtB,
      },
    });
    idB = b.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("recalculate-shift-based-leave-days Bestand test cleanup failed:", err);
    }
  });

  it("dry-run lists B (3 -> 1) and does NOT list A; writes nothing and audits nothing", async () => {
    const auditCountBefore = await app.prisma.auditLog.count({
      where: { entity: "LeaveRequest", entityId: { in: [idA, idB] } },
    });

    const summary = await main(["--tenant-id", tenantId], app.prisma);

    const candidateB = summary.candidates.find((c) => c.leaveRequestId === idB);
    expect(candidateB).toBeDefined();
    expect(candidateB!.oldDays).toBe(3);
    expect(candidateB!.newDays).toBe(1);

    const candidateA = summary.candidates.find((c) => c.leaveRequestId === idA);
    expect(candidateA).toBeUndefined();

    const freshA = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: idA } });
    const freshB = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: idB } });
    expect(Number(freshA.days)).toBe(3);
    expect(Number(freshB.days)).toBe(3); // unchanged — dry-run never writes

    const auditCountAfter = await app.prisma.auditLog.count({
      where: { entity: "LeaveRequest", entityId: { in: [idA, idB] } },
    });
    expect(auditCountAfter).toBe(auditCountBefore);
  });
});
