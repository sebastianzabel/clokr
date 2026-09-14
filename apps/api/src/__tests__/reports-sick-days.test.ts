import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
} from "./setup";
import type { FastifyInstance } from "fastify";

/**
 * Regression test for WR-05: sick day double-counting fix.
 *
 * Before the fix, `sickDaysWithoutAttest` was initialized to `sickDaysAbsence`,
 * causing double-counting when both a LeaveRequest and an Absence(SICK) existed
 * for the same period (Absence was an AU-Bescheinigung document tracker, not the
 * authoritative sick day source — LeaveRequest is).
 *
 * This test suite guards that boundary and ensures the fix is never silently
 * reverted.
 */
describe("Reports: sick day double-count regression (WR-05)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Separate employees for each test to avoid cross-test interference
  let empA: { id: string };
  let empB: { id: string };
  let empC: { id: string };

  let krankmeldungTypeId: string;
  let kinderkrankTypeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rpt-sick");

    // Create sick leave types for this tenant
    const krankmeldungType = await app.prisma.leaveType.create({
      data: {
        tenantId: data.tenant.id,
        code: "SICK",
        name: "Krankmeldung",
        isPaid: true,
        requiresApproval: false,
        color: "#EF4444",
      },
    });
    krankmeldungTypeId = krankmeldungType.id;

    const kinderkrankType = await app.prisma.leaveType.create({
      data: {
        tenantId: data.tenant.id,
        code: "SICK_CHILD",
        name: "Kinderkrank",
        isPaid: true,
        requiresApproval: false,
        color: "#F97316",
      },
    });
    kinderkrankTypeId = kinderkrankType.id;

    // ── Employee A: Krankmeldung + matching Absence(SICK) — double-count guard ──
    const userA = await app.prisma.user.create({
      data: {
        email: `emp-a-${Date.now()}@rpt-sick-test.de`,
        passwordHash: "DUMMY",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employeeA = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: userA.id,
        employeeNumber: `RSA-${Date.now()}`,
        firstName: "Anna",
        lastName: "SickTest",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employeeA.id,
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
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employeeA.id, balanceHours: 0 },
    });
    empA = { id: employeeA.id };

    // LeaveRequest: Krankmeldung 2025-03-03 to 2025-03-05 (Mon-Wed, 3 days), no attest
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeA.id,
        leaveTypeId: krankmeldungTypeId,
        startDate: new Date("2025-03-03T00:00:00.000Z"),
        endDate: new Date("2025-03-05T00:00:00.000Z"),
        days: 3,
        status: "APPROVED",
        attestPresent: false,
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
      },
    });

    // Absence(SICK): same 3-day range — this tracks the AU-Bescheinigung document,
    // NOT the authoritative sick count. Must NOT double the sick day total.
    await app.prisma.absence.create({
      data: {
        employeeId: employeeA.id,
        type: "SICK",
        startDate: new Date("2025-03-03T00:00:00.000Z"),
        endDate: new Date("2025-03-05T00:00:00.000Z"),
        days: 3,
        createdBy: data.adminUser.id,
      },
    });

    // ── Employee B: Kinderkrank LeaveRequest only, NO Absence ──────────────────
    const userB = await app.prisma.user.create({
      data: {
        email: `emp-b-${Date.now()}@rpt-sick-test.de`,
        passwordHash: "DUMMY",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employeeB = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: userB.id,
        employeeNumber: `RSB-${Date.now()}`,
        firstName: "Ben",
        lastName: "SickTest",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employeeB.id,
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
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employeeB.id, balanceHours: 0 },
    });
    empB = { id: employeeB.id };

    // LeaveRequest: Kinderkrank 2025-03-10 to 2025-03-11 (Mon-Tue, 2 days), no attest, no Absence
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeB.id,
        leaveTypeId: kinderkrankTypeId,
        startDate: new Date("2025-03-10T00:00:00.000Z"),
        endDate: new Date("2025-03-11T00:00:00.000Z"),
        days: 2,
        status: "APPROVED",
        attestPresent: false,
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
      },
    });
    // No Absence record for employee B

    // ── Employee C: Krankmeldung with full attest + matching Absence ───────────
    const userC = await app.prisma.user.create({
      data: {
        email: `emp-c-${Date.now()}@rpt-sick-test.de`,
        passwordHash: "DUMMY",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employeeC = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: userC.id,
        employeeNumber: `RSC-${Date.now()}`,
        firstName: "Clara",
        lastName: "SickTest",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employeeC.id,
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
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employeeC.id, balanceHours: 0 },
    });
    empC = { id: employeeC.id };

    // LeaveRequest: Krankmeldung 2025-03-17 to 2025-03-21 (Mon-Fri, 5 days), full attest
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeC.id,
        leaveTypeId: krankmeldungTypeId,
        startDate: new Date("2025-03-17T00:00:00.000Z"),
        endDate: new Date("2025-03-21T00:00:00.000Z"),
        days: 5,
        status: "APPROVED",
        attestPresent: true,
        attestValidFrom: new Date("2025-03-17T00:00:00.000Z"),
        attestValidTo: new Date("2025-03-21T00:00:00.000Z"),
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
      },
    });

    // Matching Absence(SICK) — must NOT double-count with attest LeaveRequest
    await app.prisma.absence.create({
      data: {
        employeeId: employeeC.id,
        type: "SICK",
        startDate: new Date("2025-03-17T00:00:00.000Z"),
        endDate: new Date("2025-03-21T00:00:00.000Z"),
        days: 5,
        createdBy: data.adminUser.id,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Test A: Double-count prevention ────────────────────────────────────────
  it("Test A: sickDaysWithoutAttest = 3 when LeaveRequest + Absence(SICK) both exist for 3 days", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?year=2025&month=3&employeeId=${empA.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Response is { month, year, rows: [...] }
    const rows: Array<{
      employeeId: string;
      sickDays: number;
      sickDaysWithAttest: number;
      sickDaysWithoutAttest: number;
    }> = body.rows;

    const emp = rows.find((r) => r.employeeId === empA.id);
    expect(emp).toBeDefined();

    // Regression guard: sickDaysWithoutAttest must be 3 (from LeaveRequest only)
    // Before the WR-05 fix it was 6 (3 from sickDaysAbsence init + 3 from LeaveRequest loop)
    expect(emp!.sickDaysWithoutAttest).toBe(3);
    expect(emp!.sickDaysWithAttest).toBe(0);
    expect(emp!.sickDays).toBe(3);
  });

  // ── Test B: No absence record — only LeaveRequest ──────────────────────────
  it("Test B: sickDaysWithoutAttest = 2 when only a Kinderkrank LeaveRequest exists (no Absence)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?year=2025&month=3&employeeId=${empB.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const rows: Array<{
      employeeId: string;
      sickDays: number;
      sickDaysWithAttest: number;
      sickDaysWithoutAttest: number;
    }> = body.rows;

    const emp = rows.find((r) => r.employeeId === empB.id);
    expect(emp).toBeDefined();

    expect(emp!.sickDaysWithoutAttest).toBe(2);
    expect(emp!.sickDaysWithAttest).toBe(0);
    expect(emp!.sickDays).toBe(2);
  });

  // ── Test C: Full attest + Absence — no double-count ────────────────────────
  it("Test C: sickDaysWithAttest = 5, sickDaysWithoutAttest = 0 when full attest + Absence(SICK) for same 5 days", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?year=2025&month=3&employeeId=${empC.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const rows: Array<{
      employeeId: string;
      sickDays: number;
      sickDaysWithAttest: number;
      sickDaysWithoutAttest: number;
    }> = body.rows;

    const emp = rows.find((r) => r.employeeId === empC.id);
    expect(emp).toBeDefined();

    // All 5 days are attestiert — sickDaysWithoutAttest must be 0 (not 5 from Absence init)
    expect(emp!.sickDaysWithAttest).toBe(5);
    expect(emp!.sickDaysWithoutAttest).toBe(0);
    expect(emp!.sickDays).toBe(5);
  });

  // ── Integrity: sickDays always equals the sum of attest + without-attest ───
  it("sickDays = sickDaysWithAttest + sickDaysWithoutAttest (no double-count in total)", async () => {
    // Verify all three employees in one batch call without employeeId filter
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?year=2025&month=3`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const rows: Array<{
      employeeId: string;
      sickDays: number;
      sickDaysWithAttest: number;
      sickDaysWithoutAttest: number;
    }> = body.rows;

    const empIds = [empA.id, empB.id, empC.id];
    for (const id of empIds) {
      const emp = rows.find((r) => r.employeeId === id);
      expect(emp).toBeDefined();
      // Fundamental invariant: total = attest + without-attest
      expect(emp!.sickDays).toBe(emp!.sickDaysWithAttest + emp!.sickDaysWithoutAttest);
    }
  });
});

// ── Phase 104 (D-30): § 9 attribution in the Monatsbericht ──────────────────────
// A confirmed § 9 credit moves the credited days from Urlaub into "Krank mit
// Attest" — a manager cannot confirm "AU liegt vor" without an actual certificate,
// so the days count as attested even though the underlying SICK LeaveRequest's own
// (D-02, independent, display-only) attestPresent flag is untouched.
describe("Reports: § 9 BUrlG attribution in the Monatsbericht (D-30)", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "rpt-s9");
    // Issue #136 (batch B): this describe's confirmCredit calls book onto hardcoded 2026
    // dates, while seedTestData only provisions the LIVE current year's entitlement row.
    await seedEntitlementYears(app, {
      employeeId: d.employee.id,
      leaveTypeId: d.vacationType.id,
      years: [2026],
    });
  });

  afterAll(async () => {
    try {
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: d.employee.id } });
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function createRequest(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${d.empToken}` },
      payload,
    });
  }

  async function approve(id: string) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${d.adminToken}` },
      payload: { status: "APPROVED" },
    });
  }

  async function creditFor(sickId: string) {
    return app.prisma.section9Credit.findFirstOrThrow({ where: { sickRequestId: sickId } });
  }

  async function confirmCredit(id: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/section9/${id}/confirm`,
      headers: { authorization: `Bearer ${d.adminToken}` },
      payload: body,
    });
  }

  async function monthlyRow(year: number, month: number) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?employeeId=${d.employee.id}&year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      section9Note?: string;
      rows: Array<{
        employeeId: string;
        vacationDays: number;
        sickDaysWithAttest: number;
        sickDaysWithoutAttest: number;
        sickDays: number;
        totalAbsenceDays: number;
        section9DaysThisMonth: number;
      }>;
    };
    return { body, row: body.rows.find((r) => r.employeeId === d.employee.id) };
  }

  async function monthlyPdf(year: number, month: number) {
    return app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly/pdf?employeeId=${d.employee.id}&year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
  }

  it("Test 1 (D-30): a confirmed § 9 day appears in sickDaysWithAttest and is removed from vacationDays — the day is reported as a Kranktag exactly once", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2026-05-04", // Monday
      endDate: "2026-05-08", // Friday
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2026-05-06", // Wednesday
      endDate: "2026-05-07", // Thursday — overlaps the vacation
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    const credit = await creditFor(sickId);
    const confirmRes = await confirmCredit(credit.id, {
      attestSource: "EAU",
      attestValidFrom: "2026-05-06",
      attestValidTo: "2026-05-07",
      reason: "AU für Mi/Do eingereicht",
    });
    expect(confirmRes.statusCode).toBe(200);

    const { row, body } = await monthlyRow(2026, 5);
    expect(row).toBeDefined();
    // 5-day vacation minus the 2 credited days -> 3.
    expect(row!.vacationDays).toBe(3);
    // The 2 credited days move to "mit Attest"; sickDaysWithoutAttest correspondingly
    // drops back to 0 (both days were originally uncounted-attest via the plain SICK
    // request) — no double-count, the "sickDays = with + without" invariant holds.
    expect(row!.sickDaysWithAttest).toBe(2);
    expect(row!.sickDaysWithoutAttest).toBe(0);
    expect(row!.sickDays).toBe(row!.sickDaysWithAttest + row!.sickDaysWithoutAttest);
    expect(row!.section9DaysThisMonth).toBe(2);
    // D-30's explanatory legend note fires because this report has an affected row.
    expect(body.section9Note).toContain("§ 9 BUrlG");
  });

  it("Test 2 (D-09): an AU_PENDING credit changes nothing — the day still counts as Urlaub", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2026-06-01", // Monday
      endDate: "2026-06-05", // Friday
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2026-06-03", // Wednesday
      endDate: "2026-06-04", // Thursday
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    // Deliberately NOT confirmed — the credit auto-created on sick approval (D-09)
    // stays AU_PENDING.
    const credit = await creditFor(sickId);
    expect(credit.status).toBe("AU_PENDING");

    const { row, body } = await monthlyRow(2026, 6);
    expect(row).toBeDefined();
    // Full 5-day vacation still charged — nothing moved yet.
    expect(row!.vacationDays).toBe(5);
    expect(row!.section9DaysThisMonth).toBe(0);
    expect(body.section9Note).toBeUndefined();
  });

  // Phase 104 code review WR-02: the subtraction from sickDaysWithoutAttest was clamped
  // but the addition to sickDaysWithAttest was not. When the Krankmeldung already carries
  // attestPresent (set independently via PATCH /requests/:id/attest, which D-02 keeps
  // orthogonal to § 9), its days were counted by the sickLeaveRequests loop AND added
  // again by the § 9 shift — a 2-day sickness reported 4 sick days in the legal
  // Arbeitszeitnachweis.
  it("Test 3 (WR-02): a § 9 confirm on a Krankmeldung that ALREADY has attestPresent does not inflate sickDays", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2026-07-06", // Monday
      endDate: "2026-07-10", // Friday
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2026-07-08", // Wednesday
      endDate: "2026-07-09", // Thursday — overlaps the vacation
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    // The pre-existing, § 9-independent attest toggle (D-02) covering BOTH sick days.
    const attestRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${sickId}/attest`,
      headers: { authorization: `Bearer ${d.adminToken}` },
      payload: {
        attestPresent: true,
        attestValidFrom: "2026-07-08",
        attestValidTo: "2026-07-09",
      },
    });
    expect(attestRes.statusCode).toBe(200);

    // Baseline BEFORE the § 9 confirm: both days already count as "mit Attest".
    const beforeConfirm = await monthlyRow(2026, 7);
    expect(beforeConfirm.row!.sickDaysWithAttest).toBe(2);
    expect(beforeConfirm.row!.sickDaysWithoutAttest).toBe(0);
    expect(beforeConfirm.row!.sickDays).toBe(2);

    const credit = await creditFor(sickId);
    const confirmRes = await confirmCredit(credit.id, {
      attestSource: "EAU",
      attestValidFrom: "2026-07-08",
      attestValidTo: "2026-07-09",
      reason: "AU für Mi/Do — Attest war am Antrag bereits vermerkt",
    });
    expect(confirmRes.statusCode).toBe(200);

    const { row } = await monthlyRow(2026, 7);
    expect(row).toBeDefined();
    // The sickness is 2 days and stays 2 days — the § 9 shift must not add them twice.
    expect(row!.sickDaysWithAttest).toBe(2);
    expect(row!.sickDaysWithoutAttest).toBe(0);
    expect(row!.sickDays).toBe(2);
    expect(row!.sickDays).toBe(row!.sickDaysWithAttest + row!.sickDaysWithoutAttest);
    // The Urlaub side of the shift is unaffected by WR-02: 5-day vacation minus 2 credited.
    expect(row!.vacationDays).toBe(3);
    expect(row!.section9DaysThisMonth).toBe(2);
  });

  it("Test 7: the report response carries an explanatory § 9 note only when a row is actually affected", async () => {
    // Re-uses Test 1's now-CONFIRMED credit (May 2026) — querying the SAME employee's
    // June report (Test 2's AU_PENDING month) must NOT carry the note.
    const { body: mayBody } = await monthlyRow(2026, 5);
    expect(mayBody.section9Note).toBe(
      "Tage mit bestätigter AU während genehmigten Urlaubs werden als Kranktage geführt und nicht auf den Jahresurlaub angerechnet (§ 9 BUrlG).",
    );
    const { body: juneBody } = await monthlyRow(2026, 6);
    expect(juneBody.section9Note).toBeUndefined();
  });

  it("Test 4 (D-30): the Monatsbericht PDF renders for a month WITH a confirmed § 9 credit", async () => {
    const res = await monthlyPdf(2026, 5); // May — Test 1 left a CONFIRMED credit here
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("Test 5 (D-30): the Monatsbericht PDF also renders for a month WITHOUT any § 9 credit", async () => {
    const res = await monthlyPdf(2026, 6); // June — Test 2's AU_PENDING month, no CONFIRMED credit
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("Test 6 (D-30): the company-wide Monatsbericht PDF renders for a month with an affected employee", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/monthly/pdf/all?year=2026&month=5",
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
  });
});

// ── Phase 97 (T2): Monatsbericht type comparisons run on LeaveType.code (Task 1) ──
// The abwesenheits-aufschlüsselung and the sick-day split used to derive identity from
// LeaveType.name. These tests construct fixtures with a CORRECT code but a RENAMED
// display name — only a code-based comparison can pass them; a name-based one would
// silently drop the renamed row out of its own bucket.
describe("Reports: Monatsbericht type comparisons run on LeaveType.code (Phase 97 T2)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  let empRenamed: { id: string };
  let empNullCode: { id: string };
  let empParity: { id: string };

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rpt-code");

    const sickTypeRenamed = await app.prisma.leaveType.create({
      data: {
        tenantId: data.tenant.id,
        code: "SICK",
        name: "Krank", // renamed away from the canonical "Krankmeldung"
        isPaid: true,
        requiresApproval: false,
        color: "#EF4444",
      },
    });

    // seedTestData already created this tenant's one VACATION-code row (the
    // `@@unique([tenantId, code])` constraint permits only one) — rename IT rather
    // than creating a second, exactly modelling a tenant renaming its existing type.
    const vacationTypeRenamed = await app.prisma.leaveType.update({
      where: { id: data.vacationType.id },
      data: { name: "Erholungsurlaub" }, // renamed away from the canonical "Urlaub"
    });

    // A pre-Phase-97 style row: a name the backfill could not map, so it was left
    // without a code (D-09 — no silent default to the vacation code).
    const nullCodeType = await app.prisma.leaveType.create({
      data: {
        tenantId: data.tenant.id,
        code: null,
        name: "Sonderfall ohne Code",
        isPaid: true,
        requiresApproval: true,
        color: "#9CA3AF",
      },
    });

    // ── Employee "renamed": SICK + VACATION on renamed-name rows, non-overlapping ──
    const userRenamed = await app.prisma.user.create({
      data: {
        email: `emp-renamed-${Date.now()}@rpt-code-test.de`,
        passwordHash: "DUMMY",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employeeRenamed = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: userRenamed.id,
        employeeNumber: `RC-R-${Date.now()}`,
        firstName: "Rena",
        lastName: "CodeTest",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employeeRenamed.id,
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
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employeeRenamed.id, balanceHours: 0 },
    });
    empRenamed = { id: employeeRenamed.id };

    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeRenamed.id,
        leaveTypeId: sickTypeRenamed.id,
        startDate: new Date("2027-02-01T00:00:00.000Z"),
        endDate: new Date("2027-02-02T00:00:00.000Z"),
        days: 2,
        status: "APPROVED",
        attestPresent: false,
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeRenamed.id,
        leaveTypeId: vacationTypeRenamed.id,
        startDate: new Date("2027-02-08T00:00:00.000Z"),
        endDate: new Date("2027-02-09T00:00:00.000Z"),
        days: 2,
        status: "APPROVED",
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
      },
    });

    // ── Employee "null-code": request on a row with no code at all ─────────────
    const userNullCode = await app.prisma.user.create({
      data: {
        email: `emp-nullcode-${Date.now()}@rpt-code-test.de`,
        passwordHash: "DUMMY",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employeeNullCode = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: userNullCode.id,
        employeeNumber: `RC-N-${Date.now()}`,
        firstName: "Nell",
        lastName: "CodeTest",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employeeNullCode.id,
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
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employeeNullCode.id, balanceHours: 0 },
    });
    empNullCode = { id: employeeNullCode.id };

    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeNullCode.id,
        leaveTypeId: nullCodeType.id,
        startDate: new Date("2027-02-15T00:00:00.000Z"),
        endDate: new Date("2027-02-16T00:00:00.000Z"),
        days: 2,
        status: "APPROVED",
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
      },
    });

    // ── Employee "parity": three canonical, non-overlapping, non-sick types ────
    const userParity = await app.prisma.user.create({
      data: {
        email: `emp-parity-${Date.now()}@rpt-code-test.de`,
        passwordHash: "DUMMY",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employeeParity = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: userParity.id,
        employeeNumber: `RC-P-${Date.now()}`,
        firstName: "Pia",
        lastName: "CodeTest",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employeeParity.id,
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
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employeeParity.id, balanceHours: 0 },
    });
    empParity = { id: employeeParity.id };

    const overtimeCompType = await app.prisma.leaveType.create({
      data: {
        tenantId: data.tenant.id,
        code: "OVERTIME_COMP",
        name: "Überstundenausgleich",
        isPaid: true,
        requiresApproval: true,
        color: "#F59E0B",
      },
    });
    const specialType = await app.prisma.leaveType.create({
      data: {
        tenantId: data.tenant.id,
        code: "SPECIAL",
        name: "Sonderurlaub",
        isPaid: true,
        requiresApproval: true,
        color: "#8B5CF6",
      },
    });

    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeParity.id,
        leaveTypeId: vacationTypeRenamed.id,
        startDate: new Date("2027-02-01T00:00:00.000Z"),
        endDate: new Date("2027-02-03T00:00:00.000Z"),
        days: 3,
        status: "APPROVED",
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeParity.id,
        leaveTypeId: overtimeCompType.id,
        startDate: new Date("2027-02-05T00:00:00.000Z"),
        endDate: new Date("2027-02-05T00:00:00.000Z"),
        days: 1,
        status: "APPROVED",
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeParity.id,
        leaveTypeId: specialType.id,
        startDate: new Date("2027-02-10T00:00:00.000Z"),
        endDate: new Date("2027-02-11T00:00:00.000Z"),
        days: 2,
        status: "APPROVED",
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function monthlyRowFor(employeeId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?year=2027&month=2&employeeId=${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{
        employeeId: string;
        sickDays: number;
        sickDaysWithAttest: number;
        sickDaysWithoutAttest: number;
        totalAbsenceDays: number;
        vacationDays: number;
        overtimeCompDays: number;
        specialLeaveDays: number;
        educationDays: number;
        unpaidDays: number;
        maternityDays: number;
        parentalDays: number;
      }>;
    };
    const row = body.rows.find((r) => r.employeeId === employeeId);
    expect(row).toBeDefined();
    return row!;
  }

  it("Case 1: an APPROVED request on a SICK-code row renamed to 'Krank' still counts as a sick day", async () => {
    const row = await monthlyRowFor(empRenamed.id);
    expect(row.sickDaysWithoutAttest).toBe(2);
    expect(row.sickDays).toBe(2);
  });

  it("Case 2: the same request does NOT count in totalAbsenceDays (the non-sick sum)", async () => {
    const row = await monthlyRowFor(empRenamed.id);
    // totalAbsenceDays combines this employee's non-sick requests only — the 2-day
    // VACATION request, never the 2-day SICK request.
    expect(row.totalAbsenceDays).toBe(2);
  });

  it("Case 3: an APPROVED request on a VACATION-code row renamed to 'Erholungsurlaub' appears in vacationDays", async () => {
    const row = await monthlyRowFor(empRenamed.id);
    expect(row.vacationDays).toBe(2);
  });

  it("Case 4: a request on a code=null row appears in none of the seven type sums and is not counted as sick", async () => {
    const row = await monthlyRowFor(empNullCode.id);
    expect(row.vacationDays).toBe(0);
    expect(row.overtimeCompDays).toBe(0);
    expect(row.specialLeaveDays).toBe(0);
    expect(row.educationDays).toBe(0);
    expect(row.unpaidDays).toBe(0);
    expect(row.maternityDays).toBe(0);
    expect(row.parentalDays).toBe(0);
    expect(row.sickDays).toBe(0);
  });

  it("Case 5 (AC-5): the sum of all seven type buckets over a non-overlapping fixture equals the fixture's own days", async () => {
    const row = await monthlyRowFor(empParity.id);
    expect(row.vacationDays).toBe(3);
    expect(row.overtimeCompDays).toBe(1);
    expect(row.specialLeaveDays).toBe(2);
    expect(row.educationDays).toBe(0);
    expect(row.unpaidDays).toBe(0);
    expect(row.maternityDays).toBe(0);
    expect(row.parentalDays).toBe(0);
    const sum =
      row.vacationDays +
      row.overtimeCompDays +
      row.specialLeaveDays +
      row.educationDays +
      row.unpaidDays +
      row.maternityDays +
      row.parentalDays;
    expect(sum).toBe(6);
  });
});
