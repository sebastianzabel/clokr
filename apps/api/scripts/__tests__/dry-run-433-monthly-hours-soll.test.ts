/**
 * Phase 433 Plan 07 (Issue #433, D-12) — RED-then-GREEN + zero-mutation proof for
 * dry-run-433-monthly-hours-soll.ts.
 *
 * Modelled on audit-exit-month-saldo.test.ts's own structure (same test DB, same
 * run-against-`app.prisma` pattern). June 2026 has 22 Mo-Fr workdays and no statutory holiday in
 * Niedersachsen. Four fixtures, one tenant:
 *
 *   A — MONTHLY_HOURS 44h/month (= 2640 min), workDays Mo-Fr, hire 2025-01-01, a 5-day APPROVED
 *       VACATION request 15.-19.06.2026 (a full Mo-Fr week). Per-day Ø value =
 *       2640 / 22 = 120 min. The Issue #433 rule reduces June's Soll by 5*120 = 600 min:
 *       expected 2640 -> 2040. A stored, non-superseded MONTHLY snapshot for June is seeded with
 *       the PRE-#433 shape (no leave deduction at all): expectedMinutes 2640, workedMinutes 0,
 *       balanceMinutes -2640. One zero-duration WORK TimeEntry (not in the vacation week, so it
 *       never changes worked minutes) is flagged isLocked: true so the month reads as locked
 *       without affecting the ground-truth worked-minutes comparison.
 *   B — same tenant, MONTHLY_HOURS 44h/month, workDays Mo-Fr, NO leave/absence/holiday in June —
 *       its stored snapshot already equals what the Issue #433 rule recomputes (expected 2640,
 *       both worked 0), so it must never be printed (zero delta).
 *   C — same tenant, FIXED_SCHEDULE with a June snapshot — never considered (wrong schedule
 *       type), must never be printed even though it has a non-superseded MONTHLY snapshot.
 *   D — same tenant, MONTHLY_HOURS with `monthlyHours: null` (pure tracking, D-01) and a June
 *       snapshot — never considered, must never be printed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  getTestApp,
  closeTestApp,
  cleanupTestData,
  createTestSalon,
} from "../../src/__tests__/setup";
import { leaveTypeFields } from "../../src/contexts/absence/leave-type";
import { monthRangeUtc } from "../../src/contexts/working-time-account/timezone";
import {
  main,
  EXIT_OK,
  EXIT_FINDINGS,
  EXIT_ERROR,
  computeDelta,
  truncId,
  formatMonthlyHoursLine,
  parseCliArgs,
} from "../dry-run-433-monthly-hours-soll";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

const TZ = "Europe/Berlin";
const { start: JUNE_START, end: JUNE_END } = monthRangeUtc(2026, 6, TZ);

describe("dry-run-433-monthly-hours-soll (Phase 433 Plan 07, D-12)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empAId: string;
  let empBId: string;
  let empCId: string;
  let empDId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const slug = "p43307-" + Date.now().toString(36);

    const tenant = await prisma.tenant.create({
      data: { name: `P43307 ${slug}`, slug, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    const salon = await createTestSalon(prisma, tenantId);
    const salonId = salon.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
    });
    const vacationType = await prisma.leaveType.create({
      data: { tenantId, ...leaveTypeFields("VACATION"), color: "#3B82F6" },
    });

    // ── Fixture A: MONTHLY_HOURS 44h, 5-day VACATION week, pre-#433 stored snapshot ──
    const userA = await prisma.user.create({
      data: {
        email: `a-${slug}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const empA = await prisma.employee.create({
      data: {
        tenantId,
        userId: userA.id,
        employeeNumber: `A-${slug}`,
        firstName: "A.",
        lastName: "Minijob",
        hireDate: new Date("2025-01-01T00:00:00Z"),
      },
    });
    empAId = empA.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: empAId,
        type: "MONTHLY_HOURS",
        monthlyHours: 44,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empAId, balanceHours: 0 } });

    // Zero-duration WORK entry on a non-vacation June day, flagged isLocked — makes the month
    // read as locked without contributing any worked minutes (keeps the ground truth at 0).
    await prisma.timeEntry.create({
      data: {
        employeeId: empAId,
        date: new Date("2026-06-01T00:00:00Z"),
        startTime: new Date("2026-06-01T08:00:00Z"),
        endTime: new Date("2026-06-01T08:00:00Z"),
        breakMinutes: 0,
        type: "WORK",
        salonId,
        isLocked: true,
        lockedAt: new Date(),
      },
    });

    await prisma.leaveRequest.create({
      data: {
        employeeId: empAId,
        leaveTypeId: vacationType.id,
        startDate: new Date("2026-06-15T00:00:00Z"),
        endDate: new Date("2026-06-19T00:00:00Z"),
        days: 5,
        halfDay: false,
        status: "APPROVED",
      },
    });

    await prisma.saldoSnapshot.create({
      data: {
        employeeId: empAId,
        periodType: "MONTHLY",
        periodStart: JUNE_START,
        periodEnd: JUNE_END,
        workedMinutes: 0,
        expectedMinutes: 2640, // pre-#433: full-month Soll, no leave deduction at all
        balanceMinutes: -2640, // 0 - 2640
        carryOver: -2640,
        closedAt: new Date(),
        closedBy: null,
        note: "Pre-Issue-433 formula stand-in (Phase 433-07 test seed — see test file docblock)",
      },
    });

    // ── Fixture B: MONTHLY_HOURS 44h, no leave/absence/holiday — snapshot already matches ──
    const userB = await prisma.user.create({
      data: {
        email: `b-${slug}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const empB = await prisma.employee.create({
      data: {
        tenantId,
        userId: userB.id,
        employeeNumber: `B-${slug}`,
        firstName: "B.",
        lastName: "Matches",
        hireDate: new Date("2025-01-01T00:00:00Z"),
      },
    });
    empBId = empB.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: empBId,
        type: "MONTHLY_HOURS",
        monthlyHours: 44,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empBId, balanceHours: 0 } });
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: empBId,
        periodType: "MONTHLY",
        periodStart: JUNE_START,
        periodEnd: JUNE_END,
        workedMinutes: 0,
        expectedMinutes: 2640, // no deduction applies — matches the Issue #433 recompute exactly
        balanceMinutes: -2640,
        carryOver: -2640,
        closedAt: new Date(),
        closedBy: null,
        note: "Already-correct MONTHLY_HOURS snapshot (Phase 433-07 test seed)",
      },
    });

    // ── Fixture C: FIXED_SCHEDULE with a June snapshot — never considered ──────────
    const userC = await prisma.user.create({
      data: {
        email: `c-${slug}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const empC = await prisma.employee.create({
      data: {
        tenantId,
        userId: userC.id,
        employeeNumber: `C-${slug}`,
        firstName: "C.",
        lastName: "Fixed",
        hireDate: new Date("2025-01-01T00:00:00Z"),
      },
    });
    empCId = empC.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: empCId,
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
        validFrom: new Date("2025-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empCId, balanceHours: 0 } });
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: empCId,
        periodType: "MONTHLY",
        periodStart: JUNE_START,
        periodEnd: JUNE_END,
        workedMinutes: 9600,
        expectedMinutes: 10560, // 22 * 480
        balanceMinutes: -960,
        carryOver: -960,
        closedAt: new Date(),
        closedBy: null,
        note: "FIXED_SCHEDULE control fixture (Phase 433-07 test seed)",
      },
    });

    // ── Fixture D: MONTHLY_HOURS, monthlyHours null (pure tracking) — never considered ──
    const userD = await prisma.user.create({
      data: {
        email: `d-${slug}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const empD = await prisma.employee.create({
      data: {
        tenantId,
        userId: userD.id,
        employeeNumber: `D-${slug}`,
        firstName: "D.",
        lastName: "Tracking",
        hireDate: new Date("2025-01-01T00:00:00Z"),
      },
    });
    empDId = empD.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: empDId,
        type: "MONTHLY_HOURS",
        monthlyHours: null,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empDId, balanceHours: 0 } });
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: empDId,
        periodType: "MONTHLY",
        periodStart: JUNE_START,
        periodEnd: JUNE_END,
        workedMinutes: 500,
        expectedMinutes: 0,
        balanceMinutes: 500,
        carryOver: 500,
        closedAt: new Date(),
        closedBy: null,
        note: "Pure-tracking MONTHLY_HOURS control fixture (Phase 433-07 test seed)",
      },
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("433-07 script test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Pure helpers (DB-free) ─────────────────────────────────────────────────

  it("exit code constants are 0/1/2", () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_ERROR).toBe(1);
    expect(EXIT_FINDINGS).toBe(2);
  });

  it('truncId("e1d8e99f-1234-5678-9abc-def012345678") returns an 8-char id, no full UUID', () => {
    const id = truncId("e1d8e99f-1234-5678-9abc-def012345678");
    expect(id).toBe("e1d8e99f");
    expect(id.length).toBe(8);
  });

  it("computeDelta is recomputed-minus-stored for both fields", () => {
    const d = computeDelta(
      { expectedMinutes: 2640, balanceMinutes: -2640 },
      { expectedMinutes: 2040, balanceMinutes: -2040 },
    );
    expect(d).toEqual({ expectedDelta: -600, balanceDelta: 600 });
  });

  it("formatMonthlyHoursLine contains no name-like field, only truncated ids", () => {
    const line = formatMonthlyHoursLine({
      tenantId: "e1d8e99f-1111-2222-3333-444444444444",
      employeeId: "aaaaaaaa-1111-2222-3333-444444444444",
      monthLabel: "2026-06",
      snapshotId: "bbbbbbbb-1111-2222-3333-444444444444",
      locked: true,
      storedExpectedMinutes: 2640,
      storedBalanceMinutes: -2640,
      recomputedExpectedMinutes: 2040,
      recomputedBalanceMinutes: -2040,
      expectedDelta: -600,
      balanceDelta: 600,
    });
    expect(line).toContain("month=2026-06");
    expect(line).toContain("locked=true");
    expect(line).toContain("expected(stored=2640,recomputed=2040,delta=-600)");
    expect(line).toContain("balance(stored=-2640,recomputed=-2040,delta=+600)");
    expect(line).toMatch(/emp=[0-9a-f]{8}/);
    expect(line).not.toMatch(/[A-Za-z]{2,}\.[A-Za-z]{1,2}\./); // no "A. Minijob"-shaped name fragment
  });

  it("parseCliArgs reads --tenant-id / --all-tenants exclusively", () => {
    expect(parseCliArgs(["--tenant-id", "abc"])).toEqual({ tenantId: "abc", allTenants: false });
    expect(parseCliArgs(["--all-tenants"])).toEqual({ tenantId: null, allTenants: true });
  });

  it("parseCliArgs rejects an unknown flag", () => {
    expect(() => parseCliArgs(["--apply"])).toThrow();
    expect(() => parseCliArgs(["--write"])).toThrow();
    expect(() => parseCliArgs(["--repair"])).toThrow();
  });

  // ── grep-verified static guarantees ───────────────────────────────────────

  it("the script source never contains a write/repair flag literal", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../dry-run-433-monthly-hours-soll.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("--apply");
    expect(src).not.toContain("--write");
    expect(src).not.toContain("--repair");
  });

  it("the script source calls no Prisma write method", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../dry-run-433-monthly-hours-soll.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(
      /\.(create|update|delete|createMany|updateMany|deleteMany|upsert)\(|executeRaw/,
    );
  });

  it("the script source selects no name/employee-number field (DSGVO)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../dry-run-433-monthly-hours-soll.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/firstName|lastName|employeeNumber/);
  });

  it("the script source never reads the retired monthlyHoursHolidayDeduction switch", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../dry-run-433-monthly-hours-soll.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("monthlyHoursHolidayDeduction");
  });

  it("requires exactly one of --tenant-id / --all-tenants", async () => {
    const logSpy = vi.fn();
    const originalError = console.error;
    console.error = logSpy;
    let codeNeither: number;
    let codeBoth: number;
    try {
      codeNeither = await main([]);
      codeBoth = await main(["--tenant-id", tenantId, "--all-tenants"]);
    } finally {
      console.error = originalError;
    }
    expect(codeNeither).toBe(EXIT_ERROR);
    expect(codeBoth).toBe(EXIT_ERROR);
    const lines = logSpy.mock.calls.map((args) => String(args[0]));
    expect(lines.join("\n")).toContain("Usage-Fehler");
  });

  // ── RED-then-GREEN against the real worker test DB ────────────────────────

  it("finds fixture A's delta, reports locked=true, omits fixture B/C/D, and mutates nothing", async () => {
    const prisma = app.prisma;

    const beforeSnapshots = await prisma.saldoSnapshot.findMany({
      where: { employeeId: { in: [empAId, empBId, empCId, empDId] } },
      orderBy: { id: "asc" },
    });
    const beforeLeave = await prisma.leaveRequest.findMany({
      where: { employeeId: { in: [empAId, empBId, empCId, empDId] } },
      orderBy: { id: "asc" },
    });
    const beforeSchedules = await prisma.workSchedule.findMany({
      where: { employeeId: { in: [empAId, empBId, empCId, empDId] } },
      orderBy: { id: "asc" },
    });
    const beforeOvertime = await prisma.overtimeAccount.findMany({
      where: { employeeId: { in: [empAId, empBId, empCId, empDId] } },
      orderBy: { id: "asc" },
    });
    const beforeAuditLogs = await prisma.auditLog.count();

    const logSpy = vi.fn();
    const originalLog = console.log;
    console.log = logSpy;
    let code: number;
    try {
      code = await main(["--tenant-id", tenantId], prisma);
    } finally {
      console.log = originalLog;
    }

    const afterSnapshots = await prisma.saldoSnapshot.findMany({
      where: { employeeId: { in: [empAId, empBId, empCId, empDId] } },
      orderBy: { id: "asc" },
    });
    const afterLeave = await prisma.leaveRequest.findMany({
      where: { employeeId: { in: [empAId, empBId, empCId, empDId] } },
      orderBy: { id: "asc" },
    });
    const afterSchedules = await prisma.workSchedule.findMany({
      where: { employeeId: { in: [empAId, empBId, empCId, empDId] } },
      orderBy: { id: "asc" },
    });
    const afterOvertime = await prisma.overtimeAccount.findMany({
      where: { employeeId: { in: [empAId, empBId, empCId, empDId] } },
      orderBy: { id: "asc" },
    });
    const afterAuditLogs = await prisma.auditLog.count();

    // Zero-mutation proof.
    expect(afterSnapshots).toEqual(beforeSnapshots);
    expect(afterLeave).toEqual(beforeLeave);
    expect(afterSchedules).toEqual(beforeSchedules);
    expect(afterOvertime).toEqual(beforeOvertime);
    expect(afterAuditLogs).toBe(beforeAuditLogs);

    expect(code).toBe(EXIT_FINDINGS);

    const lines = logSpy.mock.calls.map((args) => String(args[0]));
    const fullOutput = lines.join("\n");

    const lineA = lines.find((l) => l.includes(truncId(empAId)) && l.includes("month=2026-06"));
    expect(lineA, "fixture A's line must be printed").toBeTruthy();
    expect(lineA).toContain("locked=true");
    expect(lineA).toContain("expected(stored=2640,recomputed=2040,delta=-600)");
    expect(lineA).toContain("balance(stored=-2640,recomputed=-2040,delta=+600)");

    expect(fullOutput).not.toContain(truncId(empBId));
    expect(fullOutput).not.toContain(truncId(empCId));
    expect(fullOutput).not.toContain(truncId(empDId));
  }, 60_000);

  it("filtering by a different, unrelated --tenant-id finds nothing (EXIT_OK, no line printed)", async () => {
    const prisma = app.prisma;
    const otherTenant = await prisma.tenant.create({
      data: {
        name: `P43307-other-${Date.now().toString(36)}`,
        slug: `p43307-other-${Date.now().toString(36)}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    const logSpy = vi.fn();
    const originalLog = console.log;
    console.log = logSpy;
    try {
      const code = await main(["--tenant-id", otherTenant.id], prisma);
      expect(code).toBe(EXIT_OK);
      const lines = logSpy.mock.calls.map((args) => String(args[0]));
      expect(lines.join("\n")).not.toContain("month=2026-06");
    } finally {
      console.log = originalLog;
      await prisma.tenant.delete({ where: { id: otherTenant.id } });
    }
  }, 60_000);
});
