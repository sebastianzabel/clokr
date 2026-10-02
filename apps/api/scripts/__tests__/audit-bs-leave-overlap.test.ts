/**
 * Phase 448 Plan 04 (Issue #448, D-06) — Bestand dry-run for `audit-bs-leave-overlap.ts`.
 *
 * Modelled on `audit-multi-day-half-day-leave.test.ts`'s and `audit-exit-month-saldo.test.ts`'s
 * own structure (same test DB, same run-against-`app.prisma` pattern, same
 * `--tenant-id`/`--all-tenants` exclusivity contract as the former).
 *
 * Fixture shapes reused verbatim from `src/__tests__/bs-leave-correction-448.test.ts` (plan 02):
 * FIXED_SCHEDULE AZUBI, `createBsAbsenceTx`-style VOCATIONAL_SCHOOL Absence rows, a closed-month
 * SaldoSnapshot seed for the locked case.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  getTestApp,
  seedTestData,
  seedEntitlementYears,
  cleanupTestData,
  closeTestApp,
} from "../../src/__tests__/setup";
import { leaveTypeFields } from "../../src/contexts/absence/leave-type";
import { monthRangeUtc } from "../../src/contexts/working-time-account";
import {
  run,
  parseCliArgs,
  classifyOverlap,
  renderReport,
  EXIT_OK,
  EXIT_ERROR,
  EXIT_FINDINGS,
} from "../audit-bs-leave-overlap";

describe("audit-bs-leave-overlap (Phase 448 Plan 04, D-06)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let sickTypeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bsoverlap448");
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      years: [2027, 2028],
    });
    const sickType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK") },
    });
    sickTypeId = sickType.id;
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("448-04 script test cleanup failed:", err);
    }
    await closeTestApp();
  });

  function mkDate(iso: string): Date {
    return new Date(`${iso}T00:00:00.000Z`);
  }

  async function createBsAbsence(employeeId: string, isoDate: string) {
    return app.prisma.absence.create({
      data: {
        employeeId,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: mkDate(isoDate),
        endDate: mkDate(isoDate),
        days: 1,
        halfDay: false,
        createdBy: "system",
      },
    });
  }

  async function createLeaveRequest(opts: {
    employeeId: string;
    leaveTypeId: string;
    start: string;
    end: string;
    days: number;
    status: "PENDING" | "APPROVED" | "CANCELLATION_REQUESTED";
    reviewedBy?: string | null;
  }) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId: opts.employeeId,
        leaveTypeId: opts.leaveTypeId,
        startDate: mkDate(opts.start),
        endDate: mkDate(opts.end),
        days: opts.days,
        halfDay: false,
        status: opts.status,
        reviewedBy: opts.reviewedBy ?? null,
      },
    });
  }

  // ── Pure helpers (DB-free) ──────────────────────────────────────────────────

  it("exit code constants are 0/1/2", () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_ERROR).toBe(1);
    expect(EXIT_FINDINGS).toBe(2);
  });

  it("classifyOverlap: a 2-decimal day mismatch is a finding even when not locked", () => {
    expect(classifyOverlap({ storedDays: 5, repricedDays: 4, locked: false })).toBe(true);
    expect(classifyOverlap({ storedDays: 4, repricedDays: 4, locked: false })).toBe(false);
  });

  it("classifyOverlap: a locked month is always a finding, even when the price matches", () => {
    expect(classifyOverlap({ storedDays: 4, repricedDays: 4, locked: true })).toBe(true);
  });

  it("renderReport contains only ids and numbers, no name-like field", () => {
    const line = renderReport({
      leaveRequestId: "aaaaaaaa-1111-2222-3333-444444444444",
      employeeId: "bbbbbbbb-1111-2222-3333-444444444444",
      tenantId: "cccccccc-1111-2222-3333-444444444444",
      bsAbsenceIds: ["dddddddd-1111-2222-3333-444444444444"],
      storedDays: 5,
      repricedDays: 4,
      locked: false,
    });
    expect(line).toContain("leaveRequestId=aaaaaaaa-1111-2222-3333-444444444444");
    expect(line).toContain("stored=5");
    expect(line).toContain("repriced=4");
    expect(line).toContain("locked=false");
    expect(line).not.toMatch(/[A-Za-z]{2,}\.[A-Za-z]{1,2}\./); // no "A. Exit"-shaped name fragment
  });

  it("parseCliArgs reads --tenant-id/--all-tenants/--help and defaults to false/null", () => {
    expect(parseCliArgs([])).toEqual({ tenantId: null, allTenants: false, help: false });
    expect(parseCliArgs(["--tenant-id", "abc"])).toEqual({
      tenantId: "abc",
      allTenants: false,
      help: false,
    });
    expect(parseCliArgs(["--all-tenants"])).toEqual({
      tenantId: null,
      allTenants: true,
      help: false,
    });
  });

  it("parseCliArgs rejects an unknown flag (no --apply/--write/--fix ever)", () => {
    expect(() => parseCliArgs(["--apply"])).toThrow();
    expect(() => parseCliArgs(["--write"])).toThrow();
    expect(() => parseCliArgs(["--fix"])).toThrow();
  });

  // ── grep-verified static guarantees ─────────────────────────────────────────

  it("the script source never contains a write/apply flag literal", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../audit-bs-leave-overlap.ts", import.meta.url), "utf8");
    expect(src).not.toContain("--apply");
    expect(src).not.toContain("--write");
    expect(src).not.toContain("--fix");
  });

  it("the script source calls no Prisma write method (read-only)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../audit-bs-leave-overlap.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\.(update|create|delete|updateMany|deleteMany|upsert)\(|executeRaw/);
  });

  it("the script source selects no name/employee-number field (DSGVO)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../audit-bs-leave-overlap.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/firstName|lastName|employeeNumber/);
  });

  // ── Usage errors — no DB touched ────────────────────────────────────────────

  it("neither --tenant-id nor --all-tenants: usage message on stderr, exit 1", async () => {
    const errSpy = vi.fn();
    const originalErr = console.error;
    console.error = errSpy;
    let code: number;
    try {
      code = await run({ tenantId: null, allTenants: false, help: false }, app.prisma);
    } finally {
      console.error = originalErr;
    }
    expect(code).toBe(EXIT_ERROR);
    expect(errSpy).toHaveBeenCalled();
  });

  it("both --tenant-id and --all-tenants: usage message on stderr, exit 1", async () => {
    const errSpy = vi.fn();
    const originalErr = console.error;
    console.error = errSpy;
    let code: number;
    try {
      code = await run({ tenantId: data.tenant.id, allTenants: true, help: false }, app.prisma);
    } finally {
      console.error = originalErr;
    }
    expect(code).toBe(EXIT_ERROR);
    expect(errSpy).toHaveBeenCalled();
  });

  // ── RED-then-GREEN against the real worker test DB ─────────────────────────

  it("APPROVED Mo-Fr stored 5, BS Tuesday: one finding (ids, stored 5, repriced 4, locked false), exit 2", async () => {
    const request = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      start: "2027-06-07",
      end: "2027-06-11",
      days: 5,
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });
    const bsAbsence = await createBsAbsence(data.employee.id, "2027-06-08");

    const beforeCount = await app.prisma.leaveRequest.count({ where: { id: request.id } });

    const logSpy = vi.fn();
    const originalLog = console.info;
    console.info = logSpy;
    let code: number;
    try {
      code = await run({ tenantId: data.tenant.id, allTenants: false, help: false }, app.prisma);
    } finally {
      console.info = originalLog;
    }

    expect(code).toBe(EXIT_FINDINGS);
    const unchanged = await app.prisma.leaveRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(Number(unchanged.days)).toBe(5); // zero mutation

    const lines = logSpy.mock.calls.map((args) => String(args[0]));
    const line = lines.find((l) => l.includes(request.id));
    expect(line, "finding line for the request must be printed").toBeTruthy();
    expect(line).toContain(`leaveRequestId=${request.id}`);
    expect(line).toContain(`employeeId=${data.employee.id}`);
    expect(line).toContain(`tenantId=${data.tenant.id}`);
    expect(line).toContain(bsAbsence.id);
    expect(line).toContain("stored=5");
    expect(line).toContain("repriced=4");
    expect(line).toContain("locked=false");
    expect(beforeCount).toBe(1);
  }, 60_000);

  it("same request, stored days already corrected to 4: consistent (not listed), exit 0", async () => {
    const request = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      start: "2027-07-05",
      end: "2027-07-09",
      days: 4, // already BS-free priced
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });
    await createBsAbsence(data.employee.id, "2027-07-06");

    const logSpy = vi.fn();
    const originalLog = console.info;
    console.info = logSpy;
    let code: number;
    try {
      code = await run({ tenantId: data.tenant.id, allTenants: false, help: false }, app.prisma);
    } finally {
      console.info = originalLog;
    }

    // This tenant also has the Plan-04-earlier finding fixture seeded above (still a genuine
    // mismatch) — so overall exit code for the TENANT stays EXIT_FINDINGS. The important
    // assertion here is that THIS request's own line never appears with a non-zero delta and
    // is not double counted.
    const lines = logSpy.mock.calls.map((args) => String(args[0]));
    const line = lines.find((l) => l.includes(request.id));
    expect(line, "an already-consistent request must not be reported").toBeFalsy();
    expect(code).toBe(EXIT_FINDINGS); // driven by the sibling fixture above, not this request
  }, 60_000);

  it("BS date inside a closed month: finding with locked=true, exit 2", async () => {
    const request = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      start: "2027-08-02",
      end: "2027-08-06",
      days: 4, // already BS-free priced — the ONLY reason this is still a finding is the lock
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });
    await createBsAbsence(data.employee.id, "2027-08-03");

    const { start: monthStart } = monthRangeUtc(2027, 8, "Europe/Berlin");
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: monthStart,
        periodEnd: monthStart,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });

    const logSpy = vi.fn();
    const originalLog = console.info;
    console.info = logSpy;
    let code: number;
    try {
      code = await run({ tenantId: data.tenant.id, allTenants: false, help: false }, app.prisma);
    } finally {
      console.info = originalLog;
    }

    expect(code).toBe(EXIT_FINDINGS);
    const lines = logSpy.mock.calls.map((args) => String(args[0]));
    const line = lines.find((l) => l.includes(request.id));
    expect(line, "finding line for the locked request must be printed").toBeTruthy();
    expect(line).toContain("locked=true");
    expect(line).toContain("stored=4");
    expect(line).toContain("repriced=4");
  }, 60_000);

  it("SICK request overlapping the same BS date is never listed", async () => {
    const sickRequest = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: sickTypeId,
      start: "2027-09-06",
      end: "2027-09-10",
      days: 5,
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });
    await createBsAbsence(data.employee.id, "2027-09-07");

    const logSpy = vi.fn();
    const originalLog = console.info;
    console.info = logSpy;
    try {
      await run({ tenantId: data.tenant.id, allTenants: false, help: false }, app.prisma);
    } finally {
      console.info = originalLog;
    }

    const lines = logSpy.mock.calls.map((args) => String(args[0]));
    expect(lines.join("\n")).not.toContain(sickRequest.id);
  }, 60_000);

  it("--tenant-id of another tenant finds nothing from this tenant (isolation), exit 0", async () => {
    const otherTenant = await app.prisma.tenant.create({
      data: {
        name: `P44804-other-${Date.now().toString(36)}`,
        slug: `p44804-other-${Date.now().toString(36)}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    const logSpy = vi.fn();
    const originalLog = console.info;
    console.info = logSpy;
    try {
      const code = await run(
        { tenantId: otherTenant.id, allTenants: false, help: false },
        app.prisma,
      );
      expect(code).toBe(EXIT_OK);
      const lines = logSpy.mock.calls.map((args) => String(args[0]));
      expect(lines.join("\n")).not.toContain(data.tenant.id);
    } finally {
      console.info = originalLog;
      await app.prisma.tenant.delete({ where: { id: otherTenant.id } });
    }
  }, 60_000);
});
