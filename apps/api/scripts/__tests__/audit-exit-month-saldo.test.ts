/**
 * Phase 447 Plan 02 (Issue #447, D-04) — RED-then-GREEN + zero-mutation proof for
 * audit-exit-month-saldo.ts.
 *
 * Modelled on dry-run-429-leave-contract-days.test.ts's own structure (same test DB, same
 * run-against-`app.prisma` pattern). Three fixtures, one tenant:
 *
 *   A — FIXED_SCHEDULE 40h/5d, hire 2026-07-01, exit 2026-07-10 (inclusive), worked the 8
 *       Mo-Fr days 01.-10.07. at 8h/day (= 3840 min, the exact fw-40-5-exit golden shape from
 *       447-01-PLAN.md). A non-superseded MONTHLY snapshot for July is seeded with the
 *       PRE-#447 (pre-fix) shape it would have stored before Issue #447 shipped: Soll ran to
 *       month end (23 Mo-Fr days * 480 = 11040), balance = 3840 - 11040 = -7200. One of its
 *       TimeEntry rows (10.07., the exit day) is flagged isLocked: true, so the month reads as
 *       locked without inserting an extra row that would change worked minutes.
 *   B — same tenant, a different FIXED_SCHEDULE employee with an exit month that has NO
 *       SaldoSnapshot at all yet (owner has not closed it).
 *   C — same tenant, a regular employee with exitDate: null (still employed) — must never be
 *       selected or printed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  getTestApp,
  closeTestApp,
  cleanupTestData,
  createTestSalon,
  salonIdForEmployee,
} from "../../src/__tests__/setup";
import { monthRangeUtc } from "../../src/contexts/working-time-account/timezone";
import {
  main,
  EXIT_OK,
  EXIT_FINDINGS,
  computeDelta,
  exitMonthOf,
  truncId,
  formatExitMonthLine,
  parseCliArgs,
} from "../audit-exit-month-saldo";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

const TZ = "Europe/Berlin";

describe("audit-exit-month-saldo (Phase 447 Plan 02, D-04)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empAId: string;
  let empBId: string;
  let empCId: string;
  let snapshotAId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const slug = "p44702-" + Date.now().toString(36);

    const tenant = await prisma.tenant.create({
      data: { name: `P44702 ${slug}`, slug, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await createTestSalon(prisma, tenantId);
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
    });

    // ── Fixture A: FIXED 40/5, exit 10.07.2026, pre-#447 stored snapshot ─────
    const userA = await prisma.user.create({
      data: {
        email: `a-${slug}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: false, // exited — would also never auto-close again, see 447-02-SUMMARY.md finding
      },
    });
    const empA = await prisma.employee.create({
      data: {
        tenantId,
        userId: userA.id,
        employeeNumber: `A-${slug}`,
        firstName: "A.",
        lastName: "Exit",
        hireDate: new Date("2026-07-01T00:00:00Z"),
        exitDate: new Date("2026-07-10T00:00:00Z"),
      },
    });
    empAId = empA.id;
    const salonA = await salonIdForEmployee(prisma, empAId);
    await prisma.workSchedule.create({
      data: {
        employeeId: empAId,
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
        validFrom: new Date("2026-07-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empAId, balanceHours: 0 } });

    const julyMoFr = ["01", "02", "03", "06", "07", "08", "09", "10"].map((d) => `2026-07-${d}`);
    for (const d of julyMoFr) {
      const start = new Date(d + "T08:00:00Z");
      const end = new Date(start.getTime() + 480 * 60_000);
      await prisma.timeEntry.create({
        data: {
          employeeId: empAId,
          date: new Date(d + "T00:00:00Z"),
          startTime: start,
          endTime: end,
          breakMinutes: 0,
          type: "WORK",
          salonId: salonA,
          isLocked: d === "2026-07-10",
          lockedAt: d === "2026-07-10" ? new Date() : null,
        },
      });
    }

    const { start: julyStart, end: julyEnd } = monthRangeUtc(2026, 7, TZ);
    const snapA = await prisma.saldoSnapshot.create({
      data: {
        employeeId: empAId,
        periodType: "MONTHLY",
        periodStart: julyStart,
        periodEnd: julyEnd,
        workedMinutes: 3840,
        expectedMinutes: 11040, // pre-#447: Soll ran to month end (23 Mo-Fr days * 480)
        balanceMinutes: -7200, // 3840 - 11040
        carryOver: -7200,
        closedAt: new Date(),
        closedBy: null,
        note: "Pre-Issue-447 formula stand-in (Phase 447-02 test seed — see test file docblock)",
      },
    });
    snapshotAId = snapA.id;

    // ── Fixture B: FIXED 40/5, exit in August, no snapshot yet ───────────────
    const userB = await prisma.user.create({
      data: {
        email: `b-${slug}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: false,
      },
    });
    const empB = await prisma.employee.create({
      data: {
        tenantId,
        userId: userB.id,
        employeeNumber: `B-${slug}`,
        firstName: "B.",
        lastName: "Noclose",
        hireDate: new Date("2026-08-01T00:00:00Z"),
        exitDate: new Date("2026-08-15T00:00:00Z"),
      },
    });
    empBId = empB.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: empBId,
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
        validFrom: new Date("2026-08-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empBId, balanceHours: 0 } });
    // No SaldoSnapshot for August — the owner has not closed this exit month yet.

    // ── Fixture C: still employed (exitDate: null) — must never be printed ──
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
        lastName: "Active",
        hireDate: new Date("2026-01-01T00:00:00Z"),
        exitDate: null,
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
        validFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empCId, balanceHours: 0 } });
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("447-02 script test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Pure helpers (DB-free) ─────────────────────────────────────────────────

  it("exit code constants are 0/1/2", () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_FINDINGS).toBe(2);
  });

  it('truncId("e1d8e99f-1234-5678-9abc-def012345678") returns an 8-char id, no full UUID', () => {
    const id = truncId("e1d8e99f-1234-5678-9abc-def012345678");
    expect(id).toBe("e1d8e99f");
    expect(id.length).toBe(8);
  });

  it("computeDelta is recomputed-minus-stored for both fields", () => {
    const d = computeDelta(
      { expectedMinutes: 11040, balanceMinutes: -7200 },
      { expectedMinutes: 3840, balanceMinutes: 0 },
    );
    expect(d).toEqual({ expectedDelta: -7200, balanceDelta: 7200 });
  });

  it("exitMonthOf derives { year, month } from the exit day's tenant-TZ string", () => {
    expect(exitMonthOf(new Date("2026-07-10T00:00:00Z"), TZ)).toEqual({ year: 2026, month: 7 });
    // Europe/Berlin is UTC+1 in January — a UTC-midnight date still falls on the same local day.
    expect(exitMonthOf(new Date("2026-01-15T00:00:00Z"), TZ)).toEqual({ year: 2026, month: 1 });
  });

  it("formatExitMonthLine contains no name-like field, only truncated ids — snapshot present", () => {
    const line = formatExitMonthLine({
      tenantId: "e1d8e99f-1111-2222-3333-444444444444",
      employeeId: "aaaaaaaa-1111-2222-3333-444444444444",
      monthLabel: "2026-07",
      snapshotId: "bbbbbbbb-1111-2222-3333-444444444444",
      locked: true,
      storedExpectedMinutes: 11040,
      storedBalanceMinutes: -7200,
      recomputedExpectedMinutes: 3840,
      recomputedBalanceMinutes: 0,
      expectedDelta: -7200,
      balanceDelta: 7200,
    });
    expect(line).toContain("month=2026-07");
    expect(line).toContain("locked=true");
    expect(line).toContain("expected(stored=11040,recomputed=3840,delta=-7200)");
    expect(line).toContain("balance(stored=-7200,recomputed=0,delta=+7200)");
    expect(line).toMatch(/emp=[0-9a-f]{8}/);
    expect(line).not.toMatch(/[A-Za-z]{2,}\.[A-Za-z]{1,2}\./); // no "A. Exit"-shaped name fragment
  });

  it("formatExitMonthLine prints stored=none and no delta when no snapshot exists", () => {
    const line = formatExitMonthLine({
      tenantId: "e1d8e99f-1111-2222-3333-444444444444",
      employeeId: "aaaaaaaa-1111-2222-3333-444444444444",
      monthLabel: "2026-08",
      snapshotId: null,
      locked: null,
      storedExpectedMinutes: null,
      storedBalanceMinutes: null,
      recomputedExpectedMinutes: 1200,
      recomputedBalanceMinutes: 0,
      expectedDelta: null,
      balanceDelta: null,
    });
    expect(line).toContain("snapshot=none");
    expect(line).toContain("locked=-");
    expect(line).toContain("expected(stored=none,recomputed=1200)");
    expect(line).not.toContain("delta=");
  });

  it("parseCliArgs reads --tenant-id and defaults to null (all tenants)", () => {
    expect(parseCliArgs([]).tenantId).toBeNull();
    expect(parseCliArgs(["--tenant-id", "abc"]).tenantId).toBe("abc");
  });

  it("parseCliArgs rejects an unknown flag", () => {
    expect(() => parseCliArgs(["--apply"])).toThrow();
    expect(() => parseCliArgs(["--write"])).toThrow();
  });

  // ── grep-verified static guarantees ───────────────────────────────────────

  it("the script source never contains a write/apply flag literal", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../audit-exit-month-saldo.ts", import.meta.url), "utf8");
    expect(src).not.toContain("--apply");
    expect(src).not.toContain("--write");
  });

  it("the script source calls no Prisma write method", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../audit-exit-month-saldo.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\.(update|create|delete|updateMany|deleteMany|upsert)\(|executeRaw/);
  });

  it("the script source selects no name/employee-number field (DSGVO)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../audit-exit-month-saldo.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/firstName|lastName|employeeNumber/);
  });

  // ── RED-then-GREEN against the real worker test DB ────────────────────────

  it("finds fixture A's delta, reports locked=true, lists fixture B as stored=none, omits fixture C, and mutates nothing", async () => {
    const prisma = app.prisma;

    const beforeSnapshots = await prisma.saldoSnapshot.count({ where: { employeeId: empAId } });
    const beforeAuditLogs = await prisma.auditLog.count();
    const beforeEntries = await prisma.timeEntry.count({ where: { employeeId: empAId } });
    const beforeSnapA = await prisma.saldoSnapshot.findUniqueOrThrow({
      where: { id: snapshotAId },
    });

    const logSpy = vi.fn();
    const originalLog = console.log;
    console.log = logSpy;
    let code: number;
    try {
      code = await main(["--tenant-id", tenantId], prisma);
    } finally {
      console.log = originalLog;
    }

    const afterSnapshots = await prisma.saldoSnapshot.count({ where: { employeeId: empAId } });
    const afterAuditLogs = await prisma.auditLog.count();
    const afterEntries = await prisma.timeEntry.count({ where: { employeeId: empAId } });
    const afterSnapA = await prisma.saldoSnapshot.findUniqueOrThrow({ where: { id: snapshotAId } });

    // Zero-mutation proof.
    expect(afterSnapshots).toBe(beforeSnapshots);
    expect(afterAuditLogs).toBe(beforeAuditLogs);
    expect(afterEntries).toBe(beforeEntries);
    expect(afterSnapA).toEqual(beforeSnapA);

    expect(code).toBe(EXIT_FINDINGS);

    const lines = logSpy.mock.calls.map((args) => String(args[0]));
    const fullOutput = lines.join("\n");

    const lineA = lines.find((l) => l.includes(truncId(empAId)) && l.includes("month=2026-07"));
    expect(lineA, "fixture A's line must be printed").toBeTruthy();
    expect(lineA).toContain("locked=true");
    expect(lineA).toContain("expected(stored=11040,recomputed=3840,delta=-7200)");
    expect(lineA).toContain("balance(stored=-7200,recomputed=0,delta=+7200)");

    const lineB = lines.find((l) => l.includes(truncId(empBId)));
    expect(lineB, "fixture B's line must be printed").toBeTruthy();
    expect(lineB).toContain("snapshot=none");
    expect(lineB).toContain("stored=none");
    expect(lineB).not.toContain("delta=");

    expect(fullOutput).not.toContain(truncId(empCId));
  }, 60_000);

  it("filtering by a different, unrelated --tenant-id finds nothing (EXIT_OK, no line printed)", async () => {
    const prisma = app.prisma;
    const otherTenant = await prisma.tenant.create({
      data: {
        name: `P44702-other-${Date.now().toString(36)}`,
        slug: `p44702-other-${Date.now().toString(36)}`,
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
      expect(lines.join("\n")).not.toContain("month=2026-07");
    } finally {
      console.log = originalLog;
      await prisma.tenant.delete({ where: { id: otherTenant.id } });
    }
  }, 60_000);
});
