/**
 * Issue #481 (R4, D-09) — recalculate-shift-based-leave-days.ts never reprices imported
 * pre-tracking requests.
 *
 * The marker is the employee's first non-deleted time entry (no tracking-start field exists).
 * Would-be candidates ending before it are listed as [SKIPPED-PRE-TRACKING] and never written,
 * in dry-run and with --confirm. `--before <YYYY-MM-DD>` adds an explicit cut-off. An employee
 * with no tracked day cannot be excluded (fail-open) and is announced once with a [NOTE] line.
 *
 * Prod-shaped fixture (Contract A): SHIFT_BASED 5 days Mo–Fr until 31.07.2026, 4 days Di–Fr from
 * 01.08.2026; first tracked day 27.05.2026; two imported requests in March/April.
 *
 * Uses initials-only for employee names (no PII per memory feedback_no_pii_in_github).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, cleanupTestData, createTestSalon } from "../../src/__tests__/setup";
import { main, parseCli } from "../recalculate-shift-based-leave-days";
import type { FastifyInstance } from "fastify";

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("recalculate-shift-based-leave-days — pre-tracking exclusion (Issue #481, D-09)", () => {
  let app: FastifyInstance;
  let tenantA: string;
  let tenantB: string;
  let vacA: string;
  const ids: Record<string, string> = {};

  async function mkTenant(label: string) {
    const suffix = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const tenant = await app.prisma.tenant.create({
      data: { name: `RSB481 ${suffix}`, slug: `rsb481-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    const salon = await createTestSalon(app.prisma, tenant.id);
    await app.prisma.tenantConfig.create({ data: { tenantId: tenant.id } });
    const vac = await app.prisma.leaveType.create({
      data: {
        tenantId: tenant.id,
        code: "VACATION",
        name: "Urlaub",
        isPaid: true,
        requiresApproval: true,
      },
    });
    return { tenantId: tenant.id, salonId: salon.id, vacId: vac.id, suffix };
  }

  async function mkEmployee(
    t: { tenantId: string; suffix: string },
    label: string,
    hire: string,
    rows: Array<{ validFrom: string; contract: number; usual: number[] }>,
  ) {
    const user = await app.prisma.user.create({
      data: {
        email: `rsb481-${label}-${t.suffix}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: t.tenantId,
        userId: user.id,
        employeeNumber: `RSB481-${label}-${t.suffix}`,
        firstName: "R",
        lastName: label,
        hireDate: D(hire),
      },
    });
    for (const r of rows) {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "SHIFT_BASED",
          weeklyHours: r.contract * 8,
          contractWorkDaysPerWeek: r.contract,
          workDays: r.usual,
          usualWorkDays: r.usual,
          validFrom: D(r.validFrom),
        },
      });
    }
    return employee.id;
  }

  async function mkRequest(
    employeeId: string,
    leaveTypeId: string,
    start: string,
    end: string,
    days: number,
    status: "APPROVED" | "PENDING" = "APPROVED",
  ) {
    const r = await app.prisma.leaveRequest.create({
      data: { employeeId, leaveTypeId, startDate: D(start), endDate: D(end), days, status },
    });
    return r.id;
  }

  async function mkTimeEntry(employeeId: string, salonId: string, date: string, deleted: boolean) {
    await app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: D(date),
        startTime: new Date(`${date}T07:00:00.000Z`),
        endTime: new Date(`${date}T15:00:00.000Z`),
        breakMinutes: 30,
        source: "MANUAL",
        type: "WORK",
        ...(deleted ? { deletedAt: new Date() } : {}),
      },
    });
  }

  async function capture(argv: string[]) {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const summary = await main(argv, app.prisma as never);
      const lines = spy.mock.calls.map((c) => String(c[0]));
      return { summary, lines };
    } finally {
      spy.mockRestore();
    }
  }

  beforeAll(async () => {
    app = await getTestApp();
    const a = await mkTenant("a");
    tenantA = a.tenantId;
    vacA = a.vacId;
    const e1 = await mkEmployee(a, "e1", "2025-09-01", [
      { validFrom: "2025-09-01", contract: 5, usual: [1, 2, 3, 4, 5] },
      { validFrom: "2026-08-01", contract: 4, usual: [2, 3, 4, 5] },
    ]);
    ids.e1 = e1;
    await mkTimeEntry(e1, a.salonId, "2026-03-02", true); // soft-deleted — must not count
    await mkTimeEntry(e1, a.salonId, "2026-05-27", false); // first tracked day
    // Created in this order: the imported pair first, so R_imp2 is priced against R_imp1.
    ids.imp1 = await mkRequest(e1, a.vacId, "2026-03-23", "2026-03-31", 4);
    ids.imp2 = await mkRequest(e1, a.vacId, "2026-04-01", "2026-04-07", 4);
    ids.mid = await mkRequest(e1, a.vacId, "2026-06-15", "2026-06-19", 4);
    ids.post = await mkRequest(e1, a.vacId, "2026-07-23", "2026-07-29", 4);
    ids.ok = await mkRequest(e1, a.vacId, "2026-09-11", "2026-09-14", 1);
    ids.pend = await mkRequest(e1, a.vacId, "2026-07-13", "2026-07-18", 4, "PENDING");

    const b = await mkTenant("b");
    tenantB = b.tenantId;
    const e2 = await mkEmployee(b, "e2", "2026-05-18", [
      { validFrom: "2026-05-18", contract: 4, usual: [2, 3, 4, 5] },
    ]);
    ids.e2 = e2;
    ids.e2a = await mkRequest(e2, b.vacId, "2026-06-12", "2026-06-28", 10);
    ids.e2b = await mkRequest(e2, b.vacId, "2026-08-03", "2026-08-05", 1);
  });

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      try {
        await cleanupTestData(app, t);
      } catch (err) {
        console.error("Cleanup failed:", err);
      }
    }
  });

  it("dry-run skips the imported requests with a reason and lists only the real candidates", async () => {
    const auditsBefore = await app.prisma.auditLog.count();
    const { summary, lines } = await capture(["--tenant-id", tenantA, "--status", "APPROVED"]);

    const byId = Object.fromEntries(summary.candidates.map((c) => [c.leaveRequestId, c]));
    expect(Object.keys(byId).sort()).toEqual([ids.mid, ids.post].sort());
    expect([byId[ids.mid].oldDays, byId[ids.mid].newDays]).toEqual([4, 5]);
    expect([byId[ids.post].oldDays, byId[ids.post].newDays]).toEqual([4, 5]);

    expect(summary.skippedPreTracking.map((s) => s.leaveRequestId).sort()).toEqual(
      [ids.imp1, ids.imp2].sort(),
    );
    for (const s of summary.skippedPreTracking) {
      expect(s.reason).toContain("ersten erfassten Arbeitstag");
      expect(s.reason).toContain("2026-05-27");
    }
    const skipLines = lines.filter((l) => l.startsWith("[SKIPPED-PRE-TRACKING]"));
    expect(skipLines).toHaveLength(2);
    expect(skipLines.join("\n")).toMatch(/days 4 -> \d/);
    expect(summary.employeesWithoutTrackedDay).toEqual([]);

    const stored = await app.prisma.leaveRequest.findMany({
      where: { id: { in: [ids.imp1, ids.imp2, ids.mid, ids.post] } },
    });
    expect(stored.every((r) => Number(r.days) === 4)).toBe(true);
    expect(await app.prisma.auditLog.count()).toBe(auditsBefore);
  });

  it("parseCli: --before accepts YYYY-MM-DD only", () => {
    expect(parseCli(["--tenant-id", "x", "--before", "2026-07-01"]).before?.toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(parseCli(["--tenant-id", "x"]).before).toBeNull();
    for (const bad of ["2026-13-45", "01.07.2026"]) {
      expect(() => parseCli(["--tenant-id", "x", "--before", bad])).toThrow(/YYYY-MM-DD/);
    }
  });

  it("--before 2026-07-01 additionally skips R_mid; the first-tracked-day reason wins for the imports", async () => {
    const { summary } = await capture([
      "--tenant-id",
      tenantA,
      "--status",
      "APPROVED",
      "--before",
      "2026-07-01",
    ]);
    expect(summary.candidates.map((c) => c.leaveRequestId)).toEqual([ids.post]);
    const reasons = Object.fromEntries(
      summary.skippedPreTracking.map((s) => [s.leaveRequestId, s.reason]),
    );
    expect(reasons[ids.mid]).toContain("--before 2026-07-01");
    expect(reasons[ids.imp1]).toContain("ersten erfassten Arbeitstag");
    expect(reasons[ids.imp2]).toContain("ersten erfassten Arbeitstag");
  });

  it("an employee without any tracked day is not excluded (fail-open) and announced once", async () => {
    const { summary, lines } = await capture(["--tenant-id", tenantB]);
    const byId = Object.fromEntries(summary.candidates.map((c) => [c.leaveRequestId, c]));
    expect([byId[ids.e2a].oldDays, byId[ids.e2a].newDays]).toEqual([10, 9]);
    expect(byId[ids.e2b]).toBeDefined();
    expect(summary.skippedPreTracking).toEqual([]);
    expect(summary.employeesWithoutTrackedDay).toEqual([ids.e2]);
    expect(lines.filter((l) => l.startsWith("[NOTE]"))).toHaveLength(1);
  });

  it("--confirm corrects the PENDING request and leaves the skipped import untouched", async () => {
    const { summary } = await capture([
      "--tenant-id",
      tenantA,
      "--request-id",
      ids.imp1,
      "--request-id",
      ids.pend,
      "--confirm",
    ]);
    expect(summary.correctedPending).toBe(1);
    expect(summary.skippedPreTracking.map((s) => s.leaveRequestId)).toEqual([ids.imp1]);
    const pend = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: ids.pend } });
    expect(Number(pend.days)).toBe(5);
    expect(
      await app.prisma.auditLog.count({ where: { entityId: ids.pend, action: "UPDATE" } }),
    ).toBe(1);
    const imp1 = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: ids.imp1 } });
    expect(Number(imp1.days)).toBe(4);
    expect(await app.prisma.auditLog.count({ where: { entityId: ids.imp1 } })).toBe(0);
  });
});
