/**
 * leave-provisional-approval.test.ts
 *
 * Phase 107 Plan 04 — integration coverage for the approval-time recompute (D-07/D-10) and the
 * no-roster acceptance (D-07/D-08/AC-UV-04) that Task 1/2 wired into leave.ts. Unit-level coverage
 * of the calc core itself (countShiftBasedLeaveDays, the D-28 count-first precedence) already
 * lives in vacation-calc.test.ts (Plan 03) — this file proves the ROUTE wiring: that
 * PATCH /requests/:id/review actually recomputes `days` and sets `daysProvisional` in the same
 * write as the status flip, that deductVacationDays() gets the fresh value, that an unrostered
 * period is ACCEPTED rather than rejected, and that the client cannot set the flag itself.
 *
 * This file owns its own tenant + fixture (two SHIFT_BASED employees with DIFFERENT contractual
 * counts, plus one FIXED_SCHEDULE control) rather than reusing another suite's — same reasoning
 * as leave-overtime-comp-shift-based.test.ts's header note. Neither SHIFT_BASED employee uses a
 * count of 5 — that is exactly the cardinality the original guessing bug never manifested for
 * (CLAUDE.md / 107-RESEARCH.md), so a suite that only used 5 would prove very little. `workDays`
 * on both is seeded to a shape that disagrees with the count's naive Mo-Fr prefix, so an
 * accidental fall-back to `workDays.length` would show up as a visibly wrong number rather than a
 * coincidentally-right one.
 *
 * Every date is derived from `todayStr()` (tenant-TZ-safe, test-dates.ts) plus a fixed day
 * offset — never a hardcoded calendar literal — and every anchor week is verified holiday-free
 * (NIEDERSACHSEN) before use, since a stray public holiday would silently change the expected day
 * count via D-08 (already covered at the unit level, not what this suite is proving). This makes
 * the suite stable under the CLOKR_TEST_FAKE_CLOCK=00:30 tenant-midnight harness too, since
 * `todayStr()` resolves "today" in the tenant timezone, not raw UTC.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { utcMidnight, dbDateStr, todayStr } from "./test-dates";

const DAY_MS = 24 * 60 * 60 * 1000;

// Phase 120 (D-11(e)/D-12): `app.inject` sends no `user-agent` unless the test supplies one, so
// without this the `userAgent` column would be `null` and the D-12 assertions could only ever
// check the IP.
const TEST_USER_AGENT = "clokr-phase120-test";

function addDaysIso(iso: string, days: number): string {
  return dbDateStr(new Date(utcMidnight(iso).getTime() + days * DAY_MS));
}

/**
 * Next Monday at least `daysOut` days out (tenant-TZ "today" as the anchor, UTC arithmetic from
 * there), advanced by whole weeks until `weekSpan` consecutive weeks (7 * weekSpan days from that
 * Monday) contain ZERO NIEDERSACHSEN public holidays. Mirrors
 * leave-overtime-comp-shift-based.test.ts's `nextNonHolidayMonday`, generalised to a multi-week
 * span for the whole-two-ISO-week fixture (Case 2) and built on test-dates.ts's `dbDateStr` /
 * `utcMidnight` rather than hand-rolled ISO slicing.
 */
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

// Computed past anchor for hireDate/validFrom fixture columns — two full years before "now",
// always in the past, carries no literal calendar-year string.
const PAST_ANCHOR = new Date(Date.UTC(new Date().getUTCFullYear() - 2, 0, 1));

// Widely-spaced anchor weeks, one per case, so no realistic holiday-skip can make two collide
// and no two requests for the SAME employee can overlap (the POST /requests overlap guard).
const UV04_MONDAY = nextHolidayFreeMonday(14); // Case 1 — SB4, no roster ever
const WHOLE_WEEKS_MONDAY = nextHolidayFreeMonday(126, 2); // Case 2 — SB3, 2 whole ISO weeks
const RC01_MONDAY = nextHolidayFreeMonday(42); // Case 3 — SB4, create-before-roster
const PROVISIONAL_MONDAY = nextHolidayFreeMonday(154); // Case 4 — SB3, never rostered
const REGRESSION_MONDAY = nextHolidayFreeMonday(182); // Case 5 — FX
const TAMPER_MONDAY = nextHolidayFreeMonday(70); // Case 6 — SB4
const PREVIEW_MONDAY = nextHolidayFreeMonday(98); // Case 7 — SB4

describe("Leave provisional approval — SHIFT_BASED roster-aware recompute (Phase 107 Plan 04)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let vacTypeId: string;
  let adminToken: string;
  let sb4Emp: { id: string };
  let sb4Token: string;
  let sb3Emp: { id: string };
  let sb3Token: string;
  let fxEmp: { id: string };
  let fxToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;

    const suffix = "lpa-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `LPA ${suffix}`, slug: `lpa-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({ data: { tenantId } });

    const passwordHash = await bcrypt.hash("test1234", 10);

    async function makeEmployeeWithLogin(label: string, role: "EMPLOYEE" | "ADMIN") {
      const user = await prisma.user.create({
        data: { email: `lpa-${label}-${suffix}@test.de`, passwordHash, role, isActive: true },
      });
      const employee = await prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `LPA-${label.toUpperCase()}-${suffix}`,
          firstName: "LPA",
          lastName: label,
          hireDate: PAST_ANCHOR,
        },
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: `lpa-${label}-${suffix}@test.de`, password: "test1234" },
      });
      const token = JSON.parse(login.body).accessToken as string;
      return { employee, token };
    }

    // ── Admin (approver) — no WorkSchedule needed, never creates a request itself ──
    const adminPair = await makeEmployeeWithLogin("admin", "ADMIN");
    adminToken = adminPair.token;

    // ── SB4: SHIFT_BASED, contractWorkDaysPerWeek=4 ──────────────────────────────
    const sb4Pair = await makeEmployeeWithLogin("sb4", "EMPLOYEE");
    sb4Emp = sb4Pair.employee;
    sb4Token = sb4Pair.token;
    await prisma.workSchedule.create({
      data: {
        employeeId: sb4Emp.id,
        type: "SHIFT_BASED",
        weeklyHours: 32,
        contractWorkDaysPerWeek: 4,
        // Tue-Fri — deliberately NOT the naive Mo-Fr prefix [1,2,3,4] a guess-from-count
        // algorithm would produce for count 4 (D-02: workDays is frozen and irrelevant to
        // SHIFT_BASED leave-day math post-Phase-107; a fallback bug would still show a wrong
        // number if it ever fell back to this array's cardinality by coincidence).
        workDays: [2, 3, 4, 5],
        validFrom: PAST_ANCHOR,
      },
    });

    // ── SB3: SHIFT_BASED, contractWorkDaysPerWeek=3 ──────────────────────────────
    const sb3Pair = await makeEmployeeWithLogin("sb3", "EMPLOYEE");
    sb3Emp = sb3Pair.employee;
    sb3Token = sb3Pair.token;
    await prisma.workSchedule.create({
      data: {
        employeeId: sb3Emp.id,
        type: "SHIFT_BASED",
        weeklyHours: 24,
        contractWorkDaysPerWeek: 3,
        // Wed/Thu/Sat — disagrees with the naive Mo-Fr prefix [1,2,3] for count 3.
        workDays: [3, 4, 6],
        validFrom: PAST_ANCHOR,
      },
    });

    // ── FX: FIXED_SCHEDULE, standard Mon-Fri 8h (AC-REG-02 control) ──────────────
    const fxPair = await makeEmployeeWithLogin("fx", "EMPLOYEE");
    fxEmp = fxPair.employee;
    fxToken = fxPair.token;
    await prisma.workSchedule.create({
      data: {
        employeeId: fxEmp.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        // mondayHours..fridayHours default to 8, saturday/sunday default to 0 — matches the
        // schema default workDays [1,2,3,4,5].
        validFrom: PAST_ANCHOR,
      },
    });

    // ── Shared "Urlaub" LeaveType + generous entitlements for every employee, spanning
    //    both years any of the anchor offsets above could land in. ──────────────────────
    const vacType = await prisma.leaveType.create({
      data: { tenantId, name: "Urlaub", isPaid: true, requiresApproval: true },
    });
    vacTypeId = vacType.id;

    const thisYear = new Date().getUTCFullYear();
    for (const emp of [sb4Emp, sb3Emp, fxEmp]) {
      for (const year of [thisYear, thisYear + 1]) {
        await prisma.leaveEntitlement.create({
          data: { employeeId: emp.id, leaveTypeId: vacTypeId, year, totalDays: 200, usedDays: 0 },
        });
      }
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("leave-provisional-approval cleanup failed:", err);
    }
  });

  async function postVacation(token: string, startDate: string, endDate: string, extra = {}) {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "VACATION", startDate, endDate, ...extra },
    });
  }

  async function approve(id: string) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${adminToken}`, "user-agent": TEST_USER_AGENT },
      payload: { status: "APPROVED" },
    });
  }

  // Phase 120 (D-03/D-11(b)): the rejection counterpart to `approve()` above.
  async function reject(id: string, reviewNote: string) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${adminToken}`, "user-agent": TEST_USER_AGENT },
      payload: { status: "REJECTED", reviewNote },
    });
  }

  async function hoursPreview(token: string, startDate: string, endDate: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/leave/hours-preview?startDate=${startDate}&endDate=${endDate}&halfDay=false`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function seedShift(employeeId: string, dateIso: string) {
    await app.prisma.shift.create({
      data: { employeeId, date: utcMidnight(dateIso), startTime: "09:00", endTime: "15:00" },
    });
  }

  async function usedDaysFor(employeeId: string, dateIso: string): Promise<number> {
    const year = Number(dateIso.slice(0, 4));
    const ent = await app.prisma.leaveEntitlement.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: vacTypeId, year } },
    });
    return Number(ent?.usedDays ?? 0);
  }

  it("AC-UV-04: a SHIFT_BASED employee in a period with NO roster is accepted, not rejected — days is the D-07 upper bound min(calendar days, count)", async () => {
    const start = UV04_MONDAY;
    const end = addDaysIso(UV04_MONDAY, 1); // Mon+Tue, 2 calendar days, count 4 -> min(2,4)=2

    const res = await postVacation(sb4Token, start, end);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(Number(body.days)).toBe(2);
    // D-10: the flag is set at APPROVAL, never at creation.
    expect(body.daysProvisional).toBeFalsy();
  });

  it("AC-UV-01 (integration) / AC-RC-06 precondition: a whole two-ISO-week request costs count*2 both before and after shifts are seeded, and is never provisional", async () => {
    const start = WHOLE_WEEKS_MONDAY;
    const end = addDaysIso(WHOLE_WEEKS_MONDAY, 13); // Sunday of the 2nd week -> 2 whole ISO weeks

    const createRes = await postVacation(sb3Token, start, end);
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(Number(created.days)).toBe(6); // count 3 * 2 whole weeks, no roster at all yet

    // Seed a single shift inside the range — whole weeks are roster-INDEPENDENT (D-06), so this
    // must NOT change the number.
    await seedShift(sb3Emp.id, addDaysIso(WHOLE_WEEKS_MONDAY, 2));
    const preview = await hoursPreview(sb3Token, start, end);
    expect(Number(JSON.parse(preview.body).days)).toBe(6);
    expect(JSON.parse(preview.body).provisional).toBe(false);

    const usedBefore = await usedDaysFor(sb3Emp.id, start);
    const approveRes = await approve(created.id);
    expect(approveRes.statusCode).toBe(200);
    const approved = JSON.parse(approveRes.body);
    expect(Number(approved.days)).toBe(6);
    expect(approved.daysProvisional).toBe(false);
    expect(await usedDaysFor(sb3Emp.id, start)).toBe(usedBefore + 6);
  });

  it("AC-RC-01: request created before the roster existed, then the roster is planned, then approved — persisted days changes from the creation-time value to the roster-derived value, daysProvisional flips to false, and LeaveEntitlement.usedDays reflects the recomputed value", async () => {
    const start = RC01_MONDAY;
    const tuesday = addDaysIso(RC01_MONDAY, 1);
    const end = tuesday; // Mon+Tue fragment, count 4 -> creation-time upper bound min(2,4)=2

    // 1) Create while the period has NO roster at all.
    const createRes = await postVacation(sb4Token, start, end);
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(Number(created.days)).toBe(2);

    // 2) NOW the roster gets planned — but only for Tuesday, not Monday.
    await seedShift(sb4Emp.id, tuesday);

    // 3) Approve.
    const usedBefore = await usedDaysFor(sb4Emp.id, start);
    const approveRes = await approve(created.id);
    expect(approveRes.statusCode).toBe(200);
    const approved = JSON.parse(approveRes.body);

    // The persisted value CHANGED between creation (2) and approval (1) — the roster-exact
    // count of the ONE actually-rostered day, not the creation-time upper bound.
    expect(Number(approved.days)).toBe(1);
    expect(approved.daysProvisional).toBe(false); // the week now has a roster (D-06/D-08 exact)

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: created.id } });
    expect(Number(persisted!.days)).toBe(1);
    expect(persisted!.daysProvisional).toBe(false);

    // deductVacationDays() got the FRESH value (1), not the stale creation-time value (2).
    expect(await usedDaysFor(sb4Emp.id, start)).toBe(usedBefore + 1);

    // Phase 120 (D-01/D-02/D-04): the approval CHANGED `days` — the audit row must show both sides.
    // `oldVal.days !== newVal.days` is the regression guard for D-04: an implementation that
    // re-reads the row after the update() instead of snapshotting before it makes these two equal.
    const auditRow = await app.prisma.auditLog.findFirst({
      where: { action: "APPROVE", entity: "LeaveRequest", entityId: created.id },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).toBeTruthy();
    const oldVal = auditRow!.oldValue as {
      status: string;
      days: number;
      daysProvisional: boolean | null;
    };
    const newVal = auditRow!.newValue as {
      status: string;
      days: number;
      daysProvisional: boolean | null;
    };
    expect(oldVal.status).toBe("PENDING");
    expect(newVal.status).toBe("APPROVED");
    expect(oldVal.days).toBe(2);
    expect(newVal.days).toBe(1);
    expect(oldVal.days).not.toBe(newVal.days);
    expect(oldVal.daysProvisional).toBeNull();
    expect(newVal.daysProvisional).toBe(false);
    // Phase 120 (D-12 / D-11(e)): the reviewer's identity, on the same entry.
    expect(auditRow!.ipAddress).toBeTruthy();
    expect(auditRow!.userAgent).toBe(TEST_USER_AGENT);
  });

  it("approving while the period still has NO roster at all sets daysProvisional true and persists the D-07 upper bound; LeaveEntitlement.usedDays reflects it", async () => {
    const start = PROVISIONAL_MONDAY;
    const end = addDaysIso(PROVISIONAL_MONDAY, 1); // Mon+Tue, count 3 -> min(2,3)=2

    const createRes = await postVacation(sb3Token, start, end);
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(Number(created.days)).toBe(2);

    // No shift is EVER seeded for this week — approve against a still-empty roster.
    const usedBefore = await usedDaysFor(sb3Emp.id, start);
    const approveRes = await approve(created.id);
    expect(approveRes.statusCode).toBe(200);
    const approved = JSON.parse(approveRes.body);

    expect(Number(approved.days)).toBe(2); // unchanged: still the D-07 upper bound
    expect(approved.daysProvisional).toBe(true);
    // D-13: provisional consumption counts FULLY against the entitlement.
    expect(await usedDaysFor(sb3Emp.id, start)).toBe(usedBefore + 2);
  });

  it("AC-REG-02: a FIXED_SCHEDULE employee's create->approve flow is byte-identical to before this phase — days unchanged, daysProvisional stays null, usedDays increments normally", async () => {
    const start = REGRESSION_MONDAY;
    const end = addDaysIso(REGRESSION_MONDAY, 2); // Mon+Tue+Wed, 3 weekdays

    const createRes = await postVacation(fxToken, start, end);
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(Number(created.days)).toBe(3);
    expect(created.daysProvisional).toBeFalsy();

    const usedBefore = await usedDaysFor(fxEmp.id, start);
    const approveRes = await approve(created.id);
    expect(approveRes.statusCode).toBe(200);
    const approved = JSON.parse(approveRes.body);

    expect(Number(approved.days)).toBe(3); // unchanged by approval
    expect(approved.daysProvisional).toBeNull(); // not false -- null, "not applicable"
    expect(await usedDaysFor(fxEmp.id, start)).toBe(usedBefore + 3);
  });

  it("T-107-02: a daysProvisional: true value in the POST request body is ignored — the persisted value is still null after creation", async () => {
    const start = TAMPER_MONDAY;
    const end = TAMPER_MONDAY; // single day, count 4 -> min(1,4)=1

    const res = await postVacation(sb4Token, start, end, { daysProvisional: true });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(Number(body.days)).toBe(1);

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: body.id } });
    expect(persisted!.daysProvisional).toBeNull();
  });

  it("GET /hours-preview surfaces `provisional` (Phase 107, D-09): true with no roster, false once the fragment's week is rostered, same day count either way", async () => {
    const start = PREVIEW_MONDAY;
    const tuesday = addDaysIso(PREVIEW_MONDAY, 1);
    const end = tuesday; // Mon+Tue fragment, count 4 -> min(2,4)=2

    const before = await hoursPreview(sb4Token, start, end);
    expect(before.statusCode).toBe(200);
    const beforeBody = JSON.parse(before.body);
    expect(Number(beforeBody.days)).toBe(2);
    expect(beforeBody.provisional).toBe(true);

    await seedShift(sb4Emp.id, start);
    await seedShift(sb4Emp.id, tuesday);

    const after = await hoursPreview(sb4Token, start, end);
    expect(after.statusCode).toBe(200);
    const afterBody = JSON.parse(after.body);
    expect(Number(afterBody.days)).toBe(2); // same number, both days are now rostered
    expect(afterBody.provisional).toBe(false);
  });

  it("Phase 120 (D-03): a REJECT records the full before/after pair too — `days` unchanged is STATED, not absent", async () => {
    // A period no other test in this file touches, so a 201 here also proves no overlap collision.
    const start = addDaysIso(RC01_MONDAY, 21);
    const createRes = await postVacation(sb3Token, start, start);
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);

    const rejectRes = await reject(created.id, "Phase 120 audit pair");
    expect(rejectRes.statusCode).toBe(200);

    const auditRow = await app.prisma.auditLog.findFirst({
      where: { action: "REJECT", entity: "LeaveRequest", entityId: created.id },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).toBeTruthy();
    expect(auditRow!.oldValue).toBeTruthy();
    expect(auditRow!.newValue).toBeTruthy();
    const oldVal = auditRow!.oldValue as {
      status: string;
      days: number;
      daysProvisional: boolean | null;
    };
    const newVal = auditRow!.newValue as {
      status: string;
      days: number;
      daysProvisional: boolean | null;
      reviewNote: string;
    };
    expect(oldVal.status).toBe("PENDING");
    expect(newVal.status).toBe("REJECTED");
    expect(newVal.days).toBe(oldVal.days); // rejection changes no value — and says so
    expect(newVal.daysProvisional).toBe(oldVal.daysProvisional);
    expect(newVal.reviewNote).toBe("Phase 120 audit pair");
    // The recorded numbers are JSON numbers, not a Decimal serialised as a string.
    expect(typeof oldVal.days).toBe("number");
    expect(typeof newVal.days).toBe("number");
    // Phase 120 (D-12 / D-11(e)): a rejection is a reviewer action too — it carries the reviewer.
    expect(auditRow!.ipAddress).toBeTruthy();
    expect(auditRow!.userAgent).toBe(TEST_USER_AGENT);
  });
});
