/**
 * fix(sec-13 / #267): GET /api/v1/shifts/week (`shifts.ts:776-778`) has no `requireRole` —
 * `requireAuth` hangs globally at `:574`, so ANY authenticated role, including EMPLOYEE, gets the
 * full-tenant week view. `availability` (`:1106-1118`) carries an eight-valued union
 * (`"sick" | "vocational_school" | "special" | ...`, `shifts.ts:96` widening the five-valued
 * `AvailabilityBucket` from `shift-availability.ts:17`). `classifyLeaveTypeCode` maps
 * `SICK`/`SICK_CHILD` to `"sick"` — so any EMPLOYEE caller can read a named colleague's illness
 * status for a specific day. That is Art. 9 DSGVO health-category data leaking to a caller who is
 * not entitled to it, plus every other field of the same response body (employee names,
 * `contractSollMinutesByEmp` and the rest of the eleven-key set — a contractual, per-person
 * figure). This file is the RED half of the fix: it pins the leak against the UNMODIFIED handler.
 * Plan 03 adds `requireRole("ADMIN", "MANAGER")` to turn Test 2 green; this file must not change
 * then except to confirm the flip.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { dowOf, futureDateStr, nextWeekdayStr, todayStr } from "./test-dates";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import type { FastifyInstance } from "fastify";

/**
 * The target day for the `?date=` query and the LeaveRequest fixture. Derived, never a literal
 * calendar date (#271/#34): a naive "tomorrow" drifts onto Saturday/Sunday roughly one day in
 * seven, and `nextWeekdayStr` skips both — that does not itself break any assertion in this file
 * (unlike sec-11's store-hours 409), but a bare weekend date would make Test 0 below fail and
 * would silently change which day of the *next* run of this suite this fixture targets, turning
 * a future extension of this file into the exact time bomb #271 removed elsewhere.
 */
const TARGET_DAY_ISO = nextWeekdayStr(futureDateStr(1));

// The full eleven-key response shape (`shifts.ts:1506-1527`). Pinned here so a future field-omission
// "fix" that quietly drops a key (rather than gating the whole route) shows up as a failing test.
const FULL_WEEK_RESPONSE_KEYS = [
  "absenceMinutesByEmp",
  "availability",
  "contractSollMinutesByEmp",
  "coverage",
  "employees",
  "leaveMinutesByEmp",
  "schoolHoliday",
  "shiftBreakMinutesByEmp",
  "shifts",
  "vocationalSchoolMinutesByEmp",
  "weekDays",
].sort();

describe("GET /api/v1/shifts/week — role gate (#267)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let sickColleagueId: string;
  let mgrToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sec13");

    // (a) A third person in the same tenant — the foreign colleague whose sick reason leaks.
    // She is never a caller (no login attempted, no token used) — Employee.userId is a required
    // unique FK, so a bare inactive User row is unavoidable to satisfy the schema, not a fixture
    // she is ever authenticated as.
    const sickColleagueUser = await app.prisma.user.create({
      data: {
        email: `krank-sec13-${Date.now()}@test.de`,
        passwordHash: "UNUSED",
        role: "EMPLOYEE",
        isActive: false,
      },
    });
    const sickColleague = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: sickColleagueUser.id,
        employeeNumber: `K-${Date.now()}`,
        firstName: "Krank",
        lastName: "Kollegin",
        hireDate: new Date("2024-01-01"),
      },
    });
    sickColleagueId = sickColleague.id;

    // (b) SICK LeaveType + an APPROVED request for her, covering TARGET_DAY_ISO. Only the
    // APPROVED status produces a bucket (`getApprovedLeaveOverlapping` filters on it) — a
    // PENDING request here would make Test 1 silently vacuous.
    const sickType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: sickColleagueId,
        leaveTypeId: sickType.id,
        startDate: new Date(`${TARGET_DAY_ISO}T00:00:00Z`),
        endDate: new Date(`${TARGET_DAY_ISO}T00:00:00Z`),
        days: 1,
        status: "APPROVED",
      },
    });

    // (c) MANAGER ad hoc — seedTestData() knows only ADMIN/EMPLOYEE (leave.test.ts:988-1010 pattern).
    const passwordHash = await bcrypt.hash("test1234", 10);
    const email = `mgr-sec13-${Date.now()}@test.de`;
    const mgrUser = await app.prisma.user.create({
      data: { email, passwordHash, role: "MANAGER", isActive: true },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: mgrUser.id,
        employeeNumber: `M-${Date.now()}`,
        firstName: "Manager",
        lastName: "Gate",
        hireDate: new Date("2024-01-01"),
      },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "test1234" },
    });
    mgrToken = JSON.parse(loginRes.body).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  // Test 0 — date bomb guard (#271). A target day that drifted onto a weekend would not falsify
  // any assertion below, but it would make a future extension of this file a silent time bomb.
  it("the target day is a weekday strictly after today (guards against the weekend date bomb, #271)", () => {
    expect(TARGET_DAY_ISO > todayStr()).toBe(true);
    expect([1, 2, 3, 4, 5]).toContain(dowOf(TARGET_DAY_ISO));
  });

  // Test 1 — anti-vacuity gate (CLAUDE.md § Anti-vacuity gate). Without this, Test 2's "EMPLOYEE
  // gets no sick bucket" could pass merely because the fixture never produced one — not because
  // anything was withheld.
  it("[vacuity gate] the fixture genuinely produces a 'sick' bucket for the foreign colleague on the target day", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${TARGET_DAY_ISO}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.employees)).toBe(true);
    expect(body.employees.length).toBeGreaterThan(0);
    expect(Array.isArray(body.availability)).toBe(true);
    expect(body.availability.length).toBeGreaterThan(0);

    const sickRows = body.availability.filter(
      (row: { employeeId: string; date: string; availability: string }) =>
        row.employeeId === sickColleagueId &&
        row.date === TARGET_DAY_ISO &&
        row.availability === "sick",
    );
    expect(sickRows.length).toBe(1);
  });

  // Test 2 — the direction that hurts (D-07, Abnahmekriterium 2). This is the RED half today.
  it("[RED today] EMPLOYEE is refused — no sick bucket, no availability field, no per-person financial field", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${TARGET_DAY_ISO}`,
      headers: { authorization: `Bearer ${data.empToken}` },
    });

    expect(res.statusCode).toBe(403);

    // Mechanism-blind: holds regardless of whether the eventual fix is a role gate or a field
    // omission (D-02 — the whole field is masked, not one value within it).
    expect(res.body).not.toContain("sick");
    expect(res.body).not.toContain("vocational_school");
    expect(res.body).not.toContain("special");

    const parsed = JSON.parse(res.body);
    expect(Object.prototype.hasOwnProperty.call(parsed, "availability")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "contractSollMinutesByEmp")).toBe(false);
  });

  // Test 3 — counter-direction MANAGER (D-08, Abnahmekriterium 3). Represented individually, not
  // as a stand-in for ADMIN.
  it("MANAGER keeps the full week view, including the sick bucket and the full key set", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${TARGET_DAY_ISO}`,
      headers: { authorization: `Bearer ${mgrToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const sickRows = body.availability.filter(
      (row: { employeeId: string; date: string; availability: string }) =>
        row.employeeId === sickColleagueId &&
        row.date === TARGET_DAY_ISO &&
        row.availability === "sick",
    );
    expect(sickRows.length).toBe(1);

    // The key-set pin guards against a future field-omission "fix" that quietly narrows the
    // response for privileged roles too, silently breaking the shift planner it must feed.
    expect(Object.keys(body).sort()).toEqual(FULL_WEEK_RESPONSE_KEYS);
  });

  // Test 4 — counter-direction ADMIN (D-08). ADMIN is checked separately from MANAGER, not
  // assumed identical.
  it("ADMIN keeps the full week view, including planning-source fields consumed by the shift planner", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${TARGET_DAY_ISO}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(Object.keys(body).sort()).toEqual(FULL_WEEK_RESPONSE_KEYS);
    // Sources for the Berufsschule badge and the planning coverage view (Abnahmekriterium 3).
    expect(body.vocationalSchoolMinutesByEmp).toBeDefined();
    expect(body.coverage).toBeDefined();
  });
});
