/**
 * Phase 429 Plan 04 — RED-then-GREEN + zero-mutation proof for
 * dry-run-429-leave-contract-days.ts.
 *
 * Fixture (mirrors the issue's own example, same shape as
 * `src/__tests__/shift-based-leave-week-soll-429.test.ts`'s "A" scenario, 429-02-SUMMARY.md):
 * a SHIFT_BASED employee, 38h/week, 4-day contract (`contractWorkDaysPerWeek: 4`), `workDays`
 * Mo-Sa. Every day of June 2026 is worked Mon-Thu 9h30 (570 min = 38h*60/4) net, EXCEPT the test
 * week (2026-06-08..14): Monday 08.06 is an APPROVED VACATION day with no shift/no entry, and
 * Tue-Thu (09.-11.06) are worked 10h30 (630 min) instead of 9h30 — the issue's own "leave Mon
 * unplanned, Tue-Thu 10.5h" example.
 *
 * Ground truth: `closeEmployeeMonth()` (the CURRENT, already-#429-fixed formula on this branch)
 * is called directly, pure, with a hand-built CloseMonthInput mirroring this exact fixture, to
 * get the month's true recomputed `expectedMinutes`/`balanceMinutes`. The SEEDED SaldoSnapshot's
 * STORED `balanceMinutes` is then set to `groundTruth.balanceMinutes - 180` — a DELIBERATELY
 * WRONG value, offset by exactly 180 minutes from the correct one (429-04-PLAN.md's own
 * documented escape hatch: hand-deriving what the OLD pre-#429 `avgWorkMinutesCore`-based formula
 * would have stored for this exact fixture is unnecessary extra complexity for proving the
 * SCRIPT's delta computation is correct — the point of this test is that the script correctly
 * reports a 180-minute delta against a real closed snapshot, not that the seeded "old" value is
 * itself a historically faithful replay of the pre-fix code path). `storedExpectedMinutes` is
 * left EQUAL to the ground truth, so `expectedDelta` is 0 and only `balanceDelta` carries the
 * 180-minute offset — one isolated, unambiguous assertion.
 *
 * The snapshot's month is LOCKED by flagging one of the real worked entries (Tuesday's)
 * `isLocked: true` directly — not by inserting an EXTRA locked entry, which would change the
 * aggregate worked minutes and invalidate the ground-truth comparison.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  getTestApp,
  closeTestApp,
  cleanupTestData,
  createTestSalon,
  salonIdForEmployee,
} from "../../src/__tests__/setup";
import { leaveTypeFields } from "../../src/contexts/absence/leave-type";
import {
  closeEmployeeMonth,
  toCloseMonthApprovedLeave,
  type CloseMonthInput,
} from "../../src/contexts/working-time-account/close-employee-month";
import { monthRangeUtc, monthDayBounds } from "../../src/contexts/working-time-account/timezone";
import {
  main,
  EXIT_OK,
  EXIT_FINDINGS,
  computeDelta,
  truncId,
  formatFindingLine,
  parseCliArgs,
} from "../dry-run-429-leave-contract-days";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

const TZ = "Europe/Berlin";
const { start: JUNE_START, end: JUNE_END } = monthRangeUtc(2026, 6, TZ);
const { firstDay: JUNE_FIRST, lastDay: JUNE_LAST } = monthDayBounds(JUNE_START, JUNE_END, TZ);

const D = (s: string) => new Date(s + "T00:00:00Z");
const dow = (s: string) => D(s).getUTCDay();

function daysOfJune(): string[] {
  const out: string[] = [];
  for (let d = 1; d <= 30; d++) out.push(`2026-06-${String(d).padStart(2, "0")}`);
  return out;
}

const WEEK = [
  "2026-06-08",
  "2026-06-09",
  "2026-06-10",
  "2026-06-11",
  "2026-06-12",
  "2026-06-13",
  "2026-06-14",
];
const inWeek = (d: string) => WEEK.includes(d);

/** Every week other than the test week: Mon-Thu 9h30 (570 min = 38h*60/4), the contract. */
const base = (d: string) => (dow(d) >= 1 && dow(d) <= 4 ? 570 : 0);
/** The issue's own example: Mon unplanned (leave), Tue-Thu 10h30 (630 min) instead. */
const scenA = (d: string) => (inWeek(d) ? (dow(d) >= 2 && dow(d) <= 4 ? 630 : 0) : base(d));

function entryTimes(ds: string, netMin: number): { start: Date; end: Date } {
  const start = new Date(ds + "T06:00:00Z");
  const end = new Date(start.getTime() + netMin * 60_000);
  return { start, end };
}

/** Same gross/net back-calculation as shift-based-leave-week-soll-429.test.ts's `shift()`. */
function shiftTimes(netMin: number): { startTime: string; endTime: string } {
  const brk = netMin + 45 > 9 * 60 ? 45 : netMin + 30 > 6 * 60 ? 30 : 0;
  const s = 8 * 60;
  const e = s + netMin + brk;
  const hm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { startTime: hm(s), endTime: hm(e) };
}

function buildGroundTruthInput(): CloseMonthInput {
  const days = daysOfJune();
  const schedule = {
    type: "SHIFT_BASED",
    weeklyHours: 38,
    contractWorkDaysPerWeek: 4,
    workDays: [1, 2, 3, 4, 5, 6],
    mondayHours: 8,
    tuesdayHours: 8,
    wednesdayHours: 8,
    thursdayHours: 8,
    fridayHours: 8,
    saturdayHours: 8,
    sundayHours: 0,
  };
  return {
    employeeId: "ground-truth",
    monthStart: JUNE_START,
    monthEnd: JUNE_END,
    monthFirstDay: JUNE_FIRST,
    monthLastDay: JUNE_LAST,
    tz: TZ,
    carryOverIn: 0,
    schedule,
    hireDate: D("2025-01-01"),
    exitDate: null,
    isTimeTrackingExempt: false,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    entries: days
      .filter((d) => scenA(d) > 0)
      .map((d) => {
        const { start, end } = entryTimes(d, scenA(d));
        return { date: D(d), startTime: start, endTime: end, breakMinutes: 0 };
      }),
    shifts: days
      .filter((d) => scenA(d) > 0)
      .map((d) => {
        const { startTime, endTime } = shiftTimes(scenA(d));
        return { date: D(d), startTime, endTime };
      }),
    approvedLeave: toCloseMonthApprovedLeave([
      {
        startDate: D("2026-06-08"),
        endDate: D("2026-06-08"),
        halfDay: false,
        leaveType: { code: "VACATION" },
      },
    ]),
    absences: [],
    holidayDateStrings: new Set(),
    tenantConfig: { defaultBreakOver6h: 30, defaultBreakOver9h: 45 },
  };
}

describe("dry-run-429-leave-contract-days (Phase 429 Plan 04)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;
  let salonId: string;
  let leaveTypeId: string;
  let snapshotId: string;
  let groundTruth: ReturnType<typeof closeEmployeeMonth>;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const slug = "p42904-" + Date.now().toString(36);

    const tenant = await prisma.tenant.create({
      data: { name: `P42904 ${slug}`, slug, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await createTestSalon(prisma, tenantId);
    await prisma.tenantConfig.create({
      data: {
        tenantId,
        defaultVacationDays: 30,
        timezone: TZ,
        defaultBreakOver6h: 30,
        defaultBreakOver9h: 45,
      },
    });

    const vacationType = await prisma.leaveType.create({
      data: { tenantId, ...leaveTypeFields("VACATION"), color: "#3B82F6" },
    });
    leaveTypeId = vacationType.id;

    const empUser = await prisma.user.create({
      data: {
        email: `sb-${slug}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: empUser.id,
        employeeNumber: `SB-${slug}`,
        firstName: "S.",
        lastName: "B.",
        hireDate: new Date("2025-01-01T00:00:00Z"),
        breakOver6hOverride: null,
        breakOver9hOverride: null,
      },
    });
    empId = emp.id;
    salonId = await salonIdForEmployee(prisma, empId);

    await prisma.workSchedule.create({
      data: {
        employeeId: empId,
        type: "SHIFT_BASED",
        weeklyHours: 38,
        contractWorkDaysPerWeek: 4,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 8,
        sundayHours: 0,
        validFrom: new Date("2025-01-01T00:00:00Z"),
        workDays: [1, 2, 3, 4, 5, 6],
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empId, balanceHours: 0 } });

    // ── Seed entries + shifts for scenA across all of June 2026 ────────────
    const days = daysOfJune();
    for (const d of days) {
      const netMin = scenA(d);
      if (netMin <= 0) continue;
      const { start, end } = entryTimes(d, netMin);
      await prisma.timeEntry.create({
        data: {
          employeeId: empId,
          date: D(d),
          startTime: start,
          endTime: end,
          breakMinutes: 0,
          type: "WORK",
          salonId,
          // Lock the Tuesday-of-the-test-week entry directly (no extra row) so the aggregate
          // worked minutes used for the ground-truth comparison are untouched.
          isLocked: d === "2026-06-09",
          lockedAt: d === "2026-06-09" ? new Date() : null,
        },
      });
      const { startTime, endTime } = shiftTimes(netMin);
      await prisma.shift.create({
        data: { employeeId: empId, salonId, date: D(d), startTime, endTime },
      });
    }

    // ── Seed the APPROVED leave request (Monday of the test week) ──────────
    await prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId,
        startDate: D("2026-06-08"),
        endDate: D("2026-06-08"),
        days: 1,
        halfDay: false,
        status: "APPROVED",
      },
    });

    // ── Ground truth: closeEmployeeMonth(), pure, no DB, same fixture shape ─
    groundTruth = closeEmployeeMonth(buildGroundTruthInput());

    // ── Seed the CLOSED SaldoSnapshot — balanceMinutes deliberately wrong by -180 ─
    const seeded = await prisma.saldoSnapshot.create({
      data: {
        employeeId: empId,
        periodType: "MONTHLY",
        periodStart: JUNE_START,
        periodEnd: JUNE_END,
        workedMinutes: groundTruth.workedMinutes,
        expectedMinutes: groundTruth.expectedMinutes, // unchanged — isolates balanceDelta
        balanceMinutes: groundTruth.balanceMinutes - 180, // deliberately wrong by -180
        carryOver: groundTruth.balanceMinutes - 180,
        closedAt: new Date(),
        closedBy: null,
        note: "Stale (pre-#429 formula stand-in, Phase 429-04 test seed — see test file docblock)",
      },
    });
    snapshotId = seeded.id;
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("429-04 script test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Pure helpers (DB-free) ─────────────────────────────────────────────────

  it("exit code constants are 0/2 (no --apply path, so no EXIT_ERROR=1 case is exercised here)", () => {
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
      { expectedMinutes: 9000, balanceMinutes: 100 },
      { expectedMinutes: 9000, balanceMinutes: 280 },
    );
    expect(d).toEqual({ expectedDelta: 0, balanceDelta: 180 });
  });

  it("formatFindingLine contains no name-like field, only truncated ids", () => {
    const line = formatFindingLine({
      tenantId: "e1d8e99f-1111-2222-3333-444444444444",
      employeeId: "aaaaaaaa-1111-2222-3333-444444444444",
      monthLabel: "2026-06",
      snapshotId: "bbbbbbbb-1111-2222-3333-444444444444",
      locked: true,
      storedExpectedMinutes: 9000,
      storedBalanceMinutes: -80,
      recomputedExpectedMinutes: 9000,
      recomputedBalanceMinutes: 100,
      expectedDelta: 0,
      balanceDelta: 180,
    });
    expect(line).toContain("month=2026-06");
    expect(line).toContain("locked=true");
    expect(line).toContain("delta=+180");
    expect(line).toMatch(/emp=[0-9a-f]{8}/);
    expect(line).not.toMatch(/[A-Za-z]{2,}\.[A-Za-z]{1,2}\./); // no "S. B."-shaped name fragment
  });

  it("parseCliArgs reads --tenant-id and defaults to null (all tenants)", () => {
    expect(parseCliArgs([]).tenantId).toBeNull();
    expect(parseCliArgs(["--tenant-id", "abc"]).tenantId).toBe("abc");
  });

  it("parseCliArgs rejects an unknown flag (in particular, --apply never parses)", () => {
    expect(() => parseCliArgs(["--apply"])).toThrow();
  });

  // ── grep-verified static guarantees (D-15) ────────────────────────────────

  it("the script source never contains the literal string --apply", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../dry-run-429-leave-contract-days.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("--apply");
  });

  it("the script source calls no Prisma write method", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../dry-run-429-leave-contract-days.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/\.(update|create|delete|updateMany|deleteMany|upsert)\(/);
  });

  // ── RED-then-GREEN against the real worker test DB ────────────────────────

  it("finds the seeded 180-minute delta, reports locked=true, and mutates nothing", async () => {
    const prisma = app.prisma;

    const before = await prisma.saldoSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });

    const code = await main(["--tenant-id", tenantId], prisma);

    const after = await prisma.saldoSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });

    // Zero-mutation proof — the seeded row is byte-identical after main() runs.
    expect(after).toEqual(before);
    expect(after.balanceMinutes).toBe(groundTruth.balanceMinutes - 180);
    expect(after.expectedMinutes).toBe(groundTruth.expectedMinutes);

    expect(code).toBe(EXIT_FINDINGS);
  }, 60_000);

  it("the finding's balanceDelta is exactly 180 and expectedDelta is 0 (isolated assertion)", async () => {
    const prisma = app.prisma;
    const logSpy = vi.fn();
    const originalLog = console.log;
    console.log = logSpy;
    try {
      await main(["--tenant-id", tenantId], prisma);
    } finally {
      console.log = originalLog;
    }

    const lines = logSpy.mock.calls.map((args) => String(args[0]));
    const findingLine = lines.find((l) => l.includes(truncId(empId)) && l.includes("delta="));
    expect(findingLine, "a finding line for this employee must be printed").toBeTruthy();
    expect(findingLine).toContain("expected(");
    expect(findingLine).toContain("delta=+0");
    expect(findingLine).toContain("balance(");
    expect(findingLine).toContain("delta=+180");
    expect(findingLine).toContain("locked=true");
    expect(findingLine).toContain("month=2026-06");
  }, 60_000);

  it("filtering by a different, unrelated --tenant-id finds nothing (EXIT_OK)", async () => {
    const prisma = app.prisma;
    const otherTenant = await prisma.tenant.create({
      data: {
        name: `P42904-other-${Date.now().toString(36)}`,
        slug: `p42904-other-${Date.now().toString(36)}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    try {
      const code = await main(["--tenant-id", otherTenant.id], prisma);
      expect(code).toBe(EXIT_OK);
    } finally {
      await prisma.tenant.delete({ where: { id: otherTenant.id } });
    }
  }, 60_000);
});
