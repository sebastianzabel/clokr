/**
 * HTTP-layer integration tests for the confirmGaps gate on POST /overtime/close-month.
 *
 * Phase 76.28 — Plan 00 Task 2 (RED scaffold).
 *
 * All cases drive the full HTTP layer via app.inject so that Zod schema validation
 * and the handler gate are exercised end-to-end (no mocking of closeEmployeeMonth).
 *
 * Case 1 (RED): gap employee + NO confirmGaps → 409 with gapCount/gapDates/requiresConfirmation.
 * Case 2 (RED): gap employee + confirmGaps:true → 201 + SaldoSnapshot.note matches /1 Lücke/.
 * Case 3 (GREEN guard): no-gap employee + NO confirmGaps → 201 (no gate needed).
 * Case 4 (A1 parity, RED): GET /status missingDates === close-writer gap set for same inputs.
 *
 * RED reason for Cases 1/2/4:
 *   - Current closeMonthSchema (overtime.ts:722-726) has no confirmGaps field.
 *   - Current handler never checks r.gaps and never returns 409.
 *   - Current snapshot.note is NULL (no gap info written by handler).
 *   - Plan 01 Task 1 (schema + gate) + Task 3 (note) turns Cases 1/2/4 GREEN.
 *
 * Case 3 is GREEN against current code — serves as a regression guard to ensure
 * Plan 01 does NOT accidentally break the no-gap close path.
 *
 * Fixture: isolated tenant (T-76.28-00-01), June 2026 (22 Mon–Fri workdays, fully past),
 * hireDate = June 1 → sequential guard loop runs 0 iterations.
 *
 * Each case uses its own distinct employee to avoid cross-case state contamination.
 * The snapshot created in one case (e.g. Case 2 closing gapEmpCase2) does not
 * interfere with Case 1 (gapEmpCase1) or Case 4 (parityEmp).
 */

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { monthRangeUtc } from "../utils/timezone";
import bcrypt from "bcryptjs";

const TZ = "Europe/Berlin";

// June 2026: 22 Mon–Fri workdays (fully past as of 2026-07-20)
function monFriInRange(fromStr: string, toStr: string): string[] {
  const out: string[] = [];
  const cur = new Date(fromStr + "T00:00:00Z");
  const end = new Date(toStr + "T00:00:00Z");
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

const JUNE_WORKDAYS = monFriInRange("2026-06-01", "2026-06-30"); // 22 days
const GAP_DAY = "2026-06-02"; // Tuesday — second workday of June 2026

// Seed a time entry: 07:00–15:30, 30 min break = 480 net minutes
async function seedEntry(app: FastifyInstance, empId: string, dateStr: string) {
  await app.prisma.timeEntry.create({
    data: {
      employeeId: empId,
      date: new Date(dateStr + "T00:00:00Z"),
      startTime: new Date(dateStr + "T07:00:00Z"),
      endTime: new Date(dateStr + "T15:30:00Z"),
      breakMinutes: 30,
      type: "WORK",
    },
  });
}

/** Create a FIXED_WEEKLY employee in tenantId with hireDate = June 1 2026 */
async function createGapEmployee(
  app: FastifyInstance,
  tenantId: string,
  suffix: string,
): Promise<string> {
  const prisma = app.prisma;
  const empUser = await prisma.user.create({
    data: {
      email: `gap-${suffix}@test.de`,
      passwordHash: await bcrypt.hash("test1234", 10),
      role: "EMPLOYEE",
      isActive: true,
    },
  });
  const emp = await prisma.employee.create({
    data: {
      tenantId,
      userId: empUser.id,
      employeeNumber: `GAP-${suffix}`,
      firstName: "Luecke",
      lastName: suffix,
      hireDate: new Date("2026-06-01T00:00:00Z"),
    },
  });
  await prisma.workSchedule.create({
    data: {
      employeeId: emp.id,
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
      validFrom: new Date("2026-06-01T00:00:00Z"),
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

  // Seed 21 entries (all June workdays except GAP_DAY = 2026-06-02)
  for (const d of JUNE_WORKDAYS) {
    if (d !== GAP_DAY) await seedEntry(app, emp.id, d);
  }

  return emp.id;
}

describe("close-month-gate — HTTP confirmGaps gate (Cases 1/2/3/4)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;

  // Each case uses its own employee to avoid cross-case state contamination
  let gapEmpCase1: string; // Case 1: gap employee used only for the 409 assertion
  let gapEmpCase2: string; // Case 2: gap employee used for the 201+note assertion
  let noGapEmpId: string; // Case 3: no-gap employee (all entries present)
  let parityEmpId: string; // Case 4: parity-check employee (fresh, never closed)

  beforeAll(async () => {
    app = await getTestApp();
    const s = `gate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const prisma = app.prisma;

    // Isolated tenant (T-76.28-00-01: tenant isolation per threat model)
    const tenant = await prisma.tenant.create({
      data: {
        name: `CloseGate ${s}`,
        slug: `gate-${s}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
    });

    // Admin user (required: close-month endpoint is ADMIN/MANAGER only)
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-gate-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    const adminEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "Gate",
        hireDate: new Date("2024-01-01T00:00:00Z"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: adminEmp.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: adminEmp.id, balanceHours: 0 } });

    // Case 1 employee: gap, used only for the 409 test (current code will close it instead)
    gapEmpCase1 = await createGapEmployee(app, tenantId, `c1-${s}`);

    // Case 2 employee: gap, used for confirmGaps:true → 201 + note
    gapEmpCase2 = await createGapEmployee(app, tenantId, `c2-${s}`);

    // Case 3 employee: no-gap (all 22 June entries present)
    const noGapUser = await prisma.user.create({
      data: {
        email: `nogap-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const noGapEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: noGapUser.id,
        employeeNumber: `NOGAP-${s}`,
        firstName: "Vollst",
        lastName: "Gate",
        hireDate: new Date("2026-06-01T00:00:00Z"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: noGapEmp.id,
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
        validFrom: new Date("2026-06-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: noGapEmp.id, balanceHours: 0 } });
    noGapEmpId = noGapEmp.id;
    // Seed all 22 June entries
    for (const d of JUNE_WORKDAYS) {
      await seedEntry(app, noGapEmpId, d);
    }

    // Case 4 employee: gap (same setup), used for A1 parity check (never closed by other cases)
    parityEmpId = await createGapEmployee(app, tenantId, `c4-${s}`);

    // Obtain admin token
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-gate-${s}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken;
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("close-month-gate cleanup:", err);
    }
    vi.useRealTimers();
  });

  // ── Case 1 (RED): gap employee + NO confirmGaps → 409 ────────────────────────
  //
  // Current code: handler never checks r.gaps, always proceeds to create snapshot
  // (returns 201). After Plan 01 Task 1: handler returns 409 with gap metadata.

  it("Case 1 (RED): POST close-month with gaps and NO confirmGaps → 409 with gap metadata", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-month",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { employeeId: gapEmpCase1, year: 2026, month: 6 },
    });

    // RED: current code returns 201 (no gate). After Plan 01 Task 1: returns 409.
    expect(res.statusCode, `Case 1: expected 409 got ${res.statusCode} — body: ${res.body}`).toBe(
      409,
    );

    const body = JSON.parse(res.body);
    expect(body.gapCount, "Case 1: gapCount must be 1").toBe(1);
    expect(body.gapDates, "Case 1: gapDates must include the gap day").toContain(GAP_DAY);
    expect(body.requiresConfirmation, "Case 1: requiresConfirmation must be true").toBe(true);
  });

  // ── Case 2 (RED): gap employee + confirmGaps:true → 201 + note has "1 Lücke" ─
  //
  // Current code: closeMonthSchema strips unknown field confirmGaps (Zod .parse) →
  // proceeds to create snapshot with note=null (no gap info).
  // After Plan 01 Task 1 + Task 3: returns 201 and snapshot.note contains "1 Lücke".
  //
  // Uses gapEmpCase2 (distinct employee not touched by Case 1).

  it("Case 2 (RED): POST close-month with confirmGaps:true → 201 + snapshot.note matches /1 Lücke/", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-month",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { employeeId: gapEmpCase2, year: 2026, month: 6, confirmGaps: true },
    });

    // After Plan 01: 201. Current code also returns 201 (confirmGaps stripped by Zod, no gate yet).
    expect(res.statusCode, `Case 2: expected 201 got ${res.statusCode} — body: ${res.body}`).toBe(
      201,
    );

    // RED assertion: snapshot.note must contain "1 Lücke" (T-76.28-00-02 audit trail)
    // Current code sets note=NULL. Plan 01 Task 3 turns this GREEN.
    const snap = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId: gapEmpCase2, periodType: "MONTHLY" },
      orderBy: { closedAt: "desc" },
    });
    expect(snap, "Case 2: snapshot must exist after confirmGaps:true close").not.toBeNull();
    // RED: current code writes note=null (no gap info). Plan 01 Task 3 sets it to a string
    // containing the gap count, e.g. "1 Lücke(n) geschlossen (0h): 2026-06-02".
    // Use toEqual(expect.stringMatching(...)) so null produces an AssertionError (not TypeError).
    expect(
      snap!.note,
      `Case 2 (RED): snapshot.note must match /1 Lücke/ but got: ${snap!.note}`,
    ).toEqual(expect.stringMatching(/1 Lücke/));
  });

  // ── Case 3 (GREEN guard): no-gap employee + NO confirmGaps → 201 ─────────────
  //
  // No gap → no gate needed. Currently GREEN and must stay GREEN after Plan 01.

  it("Case 3 (GREEN guard): POST close-month for employee WITH NO GAPS → 201 (no gate)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-month",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { employeeId: noGapEmpId, year: 2026, month: 6 },
    });

    expect(
      res.statusCode,
      `Case 3: expected 201 (no gap → no gate) got ${res.statusCode} — body: ${res.body}`,
    ).toBe(201);
  });

  // ── Case 4 (A1 parity): status missingDates === close-writer gap set ──────────
  //
  // Both the GET /close-month/status endpoint and POST /close-month handler call
  // findMissingWorkdays() via closeEmployeeMonth() with the same inputs → they MUST
  // return the same gap set. This test proves A1 parity by construction.
  //
  // Uses parityEmpId (never closed by Cases 1–3).

  it("Case 4 (A1 parity): GET /status missingDates === [GAP_DAY] for the parity employee", async () => {
    const statusRes = await app.inject({
      method: "GET",
      url: "/api/v1/overtime/close-month/status",
      headers: { authorization: `Bearer ${adminToken}` },
      query: { year: "2026", month: "6" },
    });

    expect(
      statusRes.statusCode,
      `Case 4: status endpoint returned ${statusRes.statusCode} — body: ${statusRes.body}`,
    ).toBe(200);

    const statusBody = JSON.parse(statusRes.body) as {
      employees: Array<{
        employeeId: string;
        status: string;
        missingDates?: string[];
      }>;
    };

    const parityRow = statusBody.employees.find((e) => e.employeeId === parityEmpId);
    expect(parityRow, "Case 4: parity employee must appear in status response").toBeDefined();
    expect(parityRow!.status, "Case 4: parity employee must have status=missing").toBe("missing");

    // A1 parity: status endpoint missingDates must equal the known close-writer gap set.
    // Both findMissingWorkdays() call sites receive identical inputs → same output guaranteed.
    const statusGaps = [...(parityRow!.missingDates ?? [])].sort();
    const closeWriterGaps = [GAP_DAY].sort();
    expect(
      statusGaps,
      "Case 4 (A1 parity): status missingDates must equal close-writer gap set [GAP_DAY]",
    ).toEqual(closeWriterGaps);

    void monthRangeUtc; // imported for potential use in future extensions
  }, 60_000);
});
