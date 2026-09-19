/**
 * Phase 262 (GitHub issue #262) — `GET /leave/overlap` returns `typeCode`/`typeName` (and, for
 * `/calendar`, `section9`/`section9Days`) to every authenticated caller today, without checking
 * whether the caller is entitled to see the absence TYPE of someone else's entry. The decision
 * this phase enforces: MANAGER and ADMIN may see a foreign entry's absence type; EMPLOYEE may
 * not — masked fields come back as `null`, never omitted (D-01).
 *
 * `/overlap` and `/calendar` are deliberately tested in ONE file: from Plan 262-02 onward both
 * handlers answer the same visibility question through one shared, module-private decision
 * function (D-06), so one file gives that shared question a single home.
 *
 * This is Plan 262-01, the RED half of a red/green pair (D-24, Abnahmekriterium 7):
 *   - The "GET /leave/overlap — Rollenmaskierung" group below is asserted against the UNCHANGED
 *     handler and is EXPECTED to fail — `leave.ts` is not touched anywhere in this plan. Its
 *     failing output is quoted verbatim in this plan's SUMMARY.md as the proof the assertions
 *     measure something real, not a vacuously-passing check.
 *   - The "GET /leave/calendar" group is a regression pin against the ALREADY-correct neighbour
 *     handler and is expected to be green from the start.
 * Plan 262-02 turns the `/overlap` group green by introducing the shared decision function.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";

// ── Target month derivation ────────────────────────────────────────────────
// Every fixture LeaveRequest below lives inside the SAME calendar month, derived from "now" so
// this file never rots into a hardcoded-date time bomb (project history: hardcoded fixture dates
// expire). "Next calendar month" rather than "this month" keeps every fixture day (as late as
// day 20) safely inside the target month no matter where "today" itself falls — Date.UTC
// normalises a December -> January rollover on its own.
const NOW = new Date();
const TARGET_MONTH_START_UTC = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 1));
const TARGET_YEAR = TARGET_MONTH_START_UTC.getUTCFullYear();
const TARGET_MONTH = TARGET_MONTH_START_UTC.getUTCMonth() + 1; // 1-12, calendar month

/** "YYYY-MM-DD" for day `day` (1-31) of the target month. */
function targetDateStr(day: number): string {
  return `${TARGET_YEAR}-${String(TARGET_MONTH).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Same day as `targetDateStr`, as a `Date` at UTC midnight — matches `@db.Date` semantics. */
function targetDate(day: number): Date {
  return new Date(targetDateStr(day));
}

// Day 0 of the FOLLOWING month is the last day of the target month (test-dates.ts uses the same
// trick for its own month-boundary helpers).
const LAST_DAY_OF_TARGET_MONTH = new Date(Date.UTC(TARGET_YEAR, TARGET_MONTH, 0)).getUTCDate();
/** The /overlap query window: the full target month, matching this plan's fixture layout. */
const WINDOW_START = targetDateStr(1);
const WINDOW_END = targetDateStr(LAST_DAY_OF_TARGET_MONTH);

describe("Leave type visibility — /overlap and /calendar answer the same question (Phase 262)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let managerToken: string;

  // Fixture LeaveRequest ids, referenced by every describe block below.
  let sickRequestId: string;
  let employeeOwnVacationId: string;
  let overlappingVacationId: string;
  let pendingSickRequestId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ltv");

    // ── MANAGER fixture, ad hoc per file (Claude's Discretion, see 262-CONTEXT.md).
    // seedTestData() provisions only ADMIN + EMPLOYEE; this mirrors leave.test.ts:988-1010
    // rather than widening the shared fixture mid-milestone.
    const managerPasswordHash = await bcrypt.hash("test1234", 10);
    const managerEmail = `mgr-ltv-${Date.now()}@test.de`;
    const managerUser = await app.prisma.user.create({
      data: {
        email: managerEmail,
        passwordHash: managerPasswordHash,
        role: "MANAGER",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: managerUser.id,
        employeeNumber: `MGR-LTV-${Date.now()}`,
        firstName: "Manager",
        lastName: "Onbehalf",
        // Copied fixture-template literal (leave.test.ts:988-1010) — an employment start date,
        // not a fixture request date, and the one hardcoded-looking literal this plan's own
        // acceptance criteria explicitly permits to remain.
        hireDate: new Date("2024-01-01"),
      },
    });
    const managerLoginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: managerEmail, password: "test1234" },
    });
    managerToken = JSON.parse(managerLoginRes.body).accessToken;

    // ── SICK LeaveType — find-or-create, mirroring ensureLeaveType()'s identity lookup shape
    // (leave.ts) without importing its module-private helper.
    let sickType = await app.prisma.leaveType.findFirst({
      where: { tenantId: data.tenant.id, code: "SICK" },
    });
    if (!sickType) {
      sickType = await app.prisma.leaveType.create({
        data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
      });
    }

    // ── Four LeaveRequest rows, created directly via prisma — no POST, no entitlement/ArbZG
    // apparatus needed for a pure read-path masking test. All four inside the same target month.
    const sickRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.adminEmployee.id, // the FOREIGN entry from EMPLOYEE's point of view
        leaveTypeId: sickType.id,
        startDate: targetDate(5),
        endDate: targetDate(7),
        days: 3,
        status: "APPROVED",
      },
    });
    sickRequestId = sickRequest.id;

    const employeeOwnVacation = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id, // EMPLOYEE's own entry; foreign from ADMIN/MANAGER's view
        leaveTypeId: data.vacationType.id,
        startDate: targetDate(15),
        endDate: targetDate(16),
        days: 2,
        status: "APPROVED",
      },
    });
    employeeOwnVacationId = employeeOwnVacation.id;

    const overlappingVacation = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.adminEmployee.id, // counterpart for the § 9 Vorgang below
        leaveTypeId: data.vacationType.id,
        startDate: targetDate(6),
        endDate: targetDate(8),
        days: 3,
        status: "APPROVED",
      },
    });
    overlappingVacationId = overlappingVacation.id;

    const pendingSickRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.adminEmployee.id, // D-23: PENDING must not survive the fix
        leaveTypeId: sickType.id,
        startDate: targetDate(20),
        endDate: targetDate(20),
        days: 1,
        status: "PENDING",
      },
    });
    pendingSickRequestId = pendingSickRequest.id;

    // ── Section9Credit — a real AU_PENDING row coupling sickRequest <-> overlappingVacation
    // (intersection: day 6-7), so the /calendar section9/section9Days masking assertions in
    // Task 3 measure something real instead of an always-null field (D-24 guard, Test 0 below).
    await app.prisma.section9Credit.create({
      data: {
        employeeId: data.adminEmployee.id,
        sickRequestId,
        vacationRequestId: overlappingVacationId,
        overlapStart: targetDate(6),
        overlapEnd: targetDate(7),
        status: "AU_PENDING",
      },
    });
  });

  afterAll(async () => {
    try {
      // Section9Credit's two LeaveRequest FKs are onDelete: Restrict — clear it before
      // cleanupTestData's own leaveRequest.deleteMany. cleanupTestData already does this itself
      // (scoped by tenantId-derived employeeIds, which covers this row too); the explicit call
      // here is the same belt-and-braces precedent section9-credit.test.ts's afterAll follows.
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: data.adminEmployee.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("Test 0 — fixtures are real", () => {
    it("three distinct, non-empty tokens exist for EMPLOYEE, MANAGER, ADMIN", () => {
      expect(data.empToken).toBeTruthy();
      expect(managerToken).toBeTruthy();
      expect(data.adminToken).toBeTruthy();
      expect(new Set([data.empToken, managerToken, data.adminToken]).size).toBe(3);
    });

    it("the foreign leave requests are visible to at least one caller via /overlap (guards against a vacuously empty response)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/overlap?startDate=${WINDOW_START}&endDate=${WINDOW_END}`,
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const rows = JSON.parse(res.body) as Array<{ id: string }>;
      expect(rows.length).toBeGreaterThan(0);
    });

    it("the § 9 Vorgang produces a real AU_PENDING marker with days for an authorized caller via /calendar", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/calendar?year=${TARGET_YEAR}&month=${TARGET_MONTH}`,
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const rows = JSON.parse(res.body) as Array<{
        id: string;
        section9: string | null;
        section9Days: string[];
      }>;
      const row = rows.find((r) => r.id === sickRequestId);
      expect(row).toBeDefined();
      expect(row?.section9).toBe("AU_PENDING");
      expect(row?.section9Days.length).toBeGreaterThan(0);
    });
  });

  describe("GET /leave/overlap — Rollenmaskierung", () => {
    type OverlapRow = {
      id: string;
      employeeName: string;
      // The TARGET shape after D-01, not today's shape — today both fields are always the real
      // (non-null) string. Typing them `string | null` here is a claim about what the endpoint
      // SHOULD return, not a runtime check; the claim is enforced by the assertions below, not
      // by this type.
      typeCode: string | null;
      typeName: string | null;
      startDate: string;
      endDate: string;
      status: string;
    };

    async function overlap(token: string): Promise<OverlapRow[]> {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/overlap?startDate=${WINDOW_START}&endDate=${WINDOW_END}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body) as OverlapRow[];
    }

    it("D-18: EMPLOYEE gets neither typeCode nor typeName for a foreign entry", async () => {
      const rows = await overlap(data.empToken);
      expect(rows.length).toBeGreaterThan(0); // D-25: guard before indexing
      const row = rows.find((r) => r.id === sickRequestId);
      expect(row).toBeDefined();
      expect(row?.typeCode).toBeNull();
      expect(row?.typeName).toBeNull();
    });

    it("D-19: MANAGER sees the real type for a foreign entry", async () => {
      const rows = await overlap(managerToken);
      expect(rows.length).toBeGreaterThan(0);
      const row = rows.find((r) => r.id === sickRequestId);
      expect(row).toBeDefined();
      expect(row?.typeCode).toBe("SICK");
    });

    it("D-19: ADMIN sees the real type for a foreign entry (own-entry exclusion, D-02, means ADMIN's own SICK row from Task 1 is structurally absent here — this checks the OTHER foreign entry, EMPLOYEE's vacation)", async () => {
      const rows = await overlap(data.adminToken);
      expect(rows.length).toBeGreaterThan(0);
      const row = rows.find((r) => r.id === employeeOwnVacationId);
      expect(row).toBeDefined();
      expect(row?.typeCode).toBe("VACATION");
    });

    it("D-21: no caller receives their own entry back", async () => {
      const employeeRows = await overlap(data.empToken);
      expect(employeeRows.length).toBeGreaterThan(0);
      expect(employeeRows.find((r) => r.id === employeeOwnVacationId)).toBeUndefined();

      const adminRows = await overlap(data.adminToken);
      expect(adminRows.length).toBeGreaterThan(0);
      expect(adminRows.find((r) => r.id === sickRequestId)).toBeUndefined();
      expect(adminRows.find((r) => r.id === overlappingVacationId)).toBeUndefined();
    });

    it("D-22: the masked fields stay present on the row, just null (not omitted)", async () => {
      const rows = await overlap(data.empToken);
      expect(rows.length).toBeGreaterThan(0);
      const row = rows.find((r) => r.id === sickRequestId);
      expect(row).toBeDefined();
      expect("typeCode" in (row as OverlapRow)).toBe(true);
      expect("typeName" in (row as OverlapRow)).toBe(true);
      expect(row?.typeCode).toBeNull();
      expect(row?.typeName).toBeNull();
    });

    it("D-23: no returned entry has status PENDING, and the PENDING request's id appears in none of the three responses", async () => {
      const employeeRows = await overlap(data.empToken);
      const managerRows = await overlap(managerToken);
      const adminRows = await overlap(data.adminToken);
      for (const rows of [employeeRows, managerRows, adminRows]) {
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.some((r) => r.status === "PENDING")).toBe(false);
        expect(rows.find((r) => r.id === pendingSickRequestId)).toBeUndefined();
      }
    });

    it("D-03: employeeName stays the full name for every role", async () => {
      const employeeRows = await overlap(data.empToken);
      const eRow = employeeRows.find((r) => r.id === sickRequestId);
      expect(eRow).toBeDefined();
      expect(eRow?.employeeName).toBe(
        `${data.adminEmployee.firstName} ${data.adminEmployee.lastName}`,
      );

      const managerRows = await overlap(managerToken);
      const mRow = managerRows.find((r) => r.id === sickRequestId);
      expect(mRow).toBeDefined();
      expect(mRow?.employeeName).toBe(
        `${data.adminEmployee.firstName} ${data.adminEmployee.lastName}`,
      );

      const adminRows = await overlap(data.adminToken);
      const aRow = adminRows.find((r) => r.id === employeeOwnVacationId);
      expect(aRow).toBeDefined();
      expect(aRow?.employeeName).toBe(`${data.employee.firstName} ${data.employee.lastName}`);
    });
  });
});
