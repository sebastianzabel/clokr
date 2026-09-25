// Phase 65b (issue #65, D-07/D-09/D-24) — the per-tenant Phorest orchestrator with TWO coupled
// salons. The core acceptance criterion of #65: a run for salon A must never cancel, suspect or
// remove salon B's rows, every row carries the salon whose branch delivered it, and exactly one
// PhorestSyncRun is written per coupled ACTIVE salon. The per-query guard matrix lives in its own
// file (sync-salon-scoping.test.ts); this file is the end-to-end tracer.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, createTestSalon } from "../../../__tests__/setup";
import { todayInTz, dateStrInTz } from "../../../contexts/working-time-account/timezone";
import { syncPhorestForTenant } from "../sync-tenant";
import {
  seedPhorestTenant,
  cleanupPhorestTenant,
  addCoupledSalon,
  mockPhorestByBranch,
  MAPPED_STAFF_ID,
  MAPPED_STAFF_ID_2,
} from "./helpers";

const originalFetch = global.fetch;
const TZ = "Europe/Berlin";

// Explicit window so no case depends on the real "today" (mirrors sync-shifts.test.ts).
const WIDE_WINDOW = { startDate: "2026-07-01", endDate: "2026-12-31" };

type Slot = { staffId: string; date: string; start: string; end: string };

/** A worktimetable page in the fixtures/worktimetables*.json shape. */
function worktimetables(slots: Slot[]): unknown {
  return {
    _embedded: {
      workTimeTables: slots.map((s) => ({
        staffId: s.staffId,
        timeSlots: [{ date: s.date, startTime: s.start, endTime: s.end, type: "WORKING" }],
      })),
    },
    page: { size: 200, totalElements: slots.length, totalPages: 1, number: 0 },
  };
}

/** An appointment page with one item per entry (only staff + date + times, no PII needed). */
function appointments(items: { id: string; staffId: string; date: string }[]): unknown {
  return {
    _embedded: {
      appointments: items.map((a) => ({
        appointmentId: a.id,
        staffId: a.staffId,
        appointmentDate: a.date,
        startTime: "10:00:00",
        endTime: "11:00:00",
      })),
    },
    page: { size: 200, totalElements: items.length, totalPages: 1, number: 0 },
  };
}

/** In-horizon appointment date, computed the way the service does (todayInTz + N days). */
function inHorizon(daysAhead: number): string {
  const day = todayInTz(TZ);
  day.setUTCDate(day.getUTCDate() + daysAhead);
  return dateStrInTz(day, TZ);
}

const BEA_SLOT: Slot = {
  staffId: MAPPED_STAFF_ID_2,
  date: "2026-07-31",
  start: "09:00:00",
  end: "17:00:00",
};
const ERIKA_SLOT: Slot = {
  staffId: MAPPED_STAFF_ID,
  date: "2026-07-30",
  start: "09:00:00",
  end: "17:00:00",
};

describe("phorest sync per salon — orchestrator (Phase 65b, D-07/D-09)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("(a) GATE 3 is per salon: A's empty branch is SUCCESS, never SUSPECT, and cancels none of B's shifts", async () => {
    const seed = await seedPhorestTenant(app, "tenant-a");
    try {
      const b = await addCoupledSalon(app, seed.tenantId, "branch-2", { name: "Salon B" });
      mockPhorestByBranch({
        "branch-1": { worktimetables: worktimetables([]) },
        "branch-2": { worktimetables: worktimetables([BEA_SLOT]) },
      });

      const run1 = await syncPhorestForTenant(app, seed.tenantId, WIDE_WINDOW);
      expect(run1.map((r) => r.salonId)).toEqual([seed.salonId, b.salonId]);
      expect(run1[1].created).toBe(1);
      const bShifts = await app.prisma.shift.findMany({ where: { salonId: b.salonId } });
      expect(bShifts).toHaveLength(1);

      const run2 = await syncPhorestForTenant(app, seed.tenantId, WIDE_WINDOW);
      expect(run2.map((r) => r.salonId)).toEqual([seed.salonId, b.salonId]);
      const a = run2[0];
      expect(a.status).toBe("SUCCESS");
      expect(a.cancelled).toBe(0);

      const bAfter = await app.prisma.shift.findMany({
        where: { id: { in: bShifts.map((s) => s.id) } },
      });
      expect(bAfter.every((s) => s.deletedAt === null)).toBe(true);
      const deleteAudits = await app.prisma.auditLog.findMany({
        where: { action: "DELETE", entityId: { in: bShifts.map((s) => s.id) } },
      });
      expect(deleteAudits).toHaveLength(0);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("(f) every created shift and stored appointment carries the salon whose branch delivered it", async () => {
    const seed = await seedPhorestTenant(app, "tenant-f");
    try {
      const b = await addCoupledSalon(app, seed.tenantId, "branch-2", { name: "Salon B" });
      mockPhorestByBranch({
        "branch-1": {
          worktimetables: worktimetables([ERIKA_SLOT]),
          appointments: appointments([
            { id: "appt-a-1", staffId: MAPPED_STAFF_ID, date: inHorizon(3) },
          ]),
        },
        "branch-2": {
          worktimetables: worktimetables([BEA_SLOT]),
          appointments: appointments([
            { id: "appt-b-1", staffId: MAPPED_STAFF_ID_2, date: inHorizon(4) },
          ]),
        },
      });

      const results = await syncPhorestForTenant(app, seed.tenantId, WIDE_WINDOW);
      expect(results.map((r) => r.status)).toEqual(["SUCCESS", "SUCCESS"]);

      const erikaShifts = await app.prisma.shift.findMany({
        where: { employeeId: seed.mappedEmployeeId, deletedAt: null },
      });
      const beaShifts = await app.prisma.shift.findMany({
        where: { employeeId: seed.mappedEmployeeId2, deletedAt: null },
      });
      expect(erikaShifts).toHaveLength(1);
      expect(erikaShifts[0].salonId).toBe(seed.salonId);
      expect(beaShifts).toHaveLength(1);
      expect(beaShifts[0].salonId).toBe(b.salonId);

      const appts = await app.prisma.phorestAppointment.findMany({
        where: { employeeId: { in: [seed.mappedEmployeeId, seed.mappedEmployeeId2] } },
      });
      expect(appts).toHaveLength(2);
      const byEmployee = new Map(appts.map((a) => [a.employeeId, a.salonId]));
      expect(byEmployee.get(seed.mappedEmployeeId)).toBe(seed.salonId);
      expect(byEmployee.get(seed.mappedEmployeeId2)).toBe(b.salonId);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("(g) one PhorestSyncRun per coupled active salon, each with its salon of the same tenant", async () => {
    const seed = await seedPhorestTenant(app, "tenant-g");
    try {
      const b = await addCoupledSalon(app, seed.tenantId, "branch-2", { name: "Salon B" });
      mockPhorestByBranch({ "branch-1": {}, "branch-2": {} });

      const results = await syncPhorestForTenant(app, seed.tenantId, WIDE_WINDOW);
      const runs = await app.prisma.phorestSyncRun.findMany({
        where: { tenantId: seed.tenantId },
        include: { salon: { select: { tenantId: true } } },
      });
      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.salonId).sort()).toEqual([seed.salonId, b.salonId].sort());
      for (const run of runs) {
        expect(run.tenantId).toBe(seed.tenantId);
        expect(run.salon.tenantId).toBe(run.tenantId);
      }
      expect(results.map((r) => r.runId).sort()).toEqual(runs.map((r) => r.id).sort());
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("(h) an uncoupled active salon and a coupled INACTIVE salon get no run and no fetch", async () => {
    const seed = await seedPhorestTenant(app, "tenant-h");
    try {
      const b = await addCoupledSalon(app, seed.tenantId, "branch-2", { name: "Salon B" });
      const c = await createTestSalon(app.prisma, seed.tenantId, {
        name: "Salon C",
        createdAt: new Date(Date.now() + 120_000),
      });
      const d = await addCoupledSalon(app, seed.tenantId, "branch-4", {
        name: "Salon D",
        isActive: false,
      });
      const requested = mockPhorestByBranch({ "branch-1": {}, "branch-2": {} });

      const results = await syncPhorestForTenant(app, seed.tenantId, WIDE_WINDOW);
      expect(results.map((r) => r.salonId)).toEqual([seed.salonId, b.salonId]);
      expect(results.every((r) => r.status === "SUCCESS")).toBe(true);

      const foreignRuns = await app.prisma.phorestSyncRun.count({
        where: { tenantId: seed.tenantId, salonId: { in: [c.id, d.salonId] } },
      });
      expect(foreignRuns).toBe(0);
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.some((u) => u.includes("/branch/branch-4/"))).toBe(false);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("zero coupled active salons: no run row, no fetch, empty result", async () => {
    const seed = await seedPhorestTenant(app, "tenant-z");
    try {
      await app.prisma.salonCoupling.deleteMany({ where: { tenantId: seed.tenantId } });
      const requested = mockPhorestByBranch({ "branch-1": {} });
      const before = await app.prisma.phorestSyncRun.count({ where: { tenantId: seed.tenantId } });

      const results = await syncPhorestForTenant(app, seed.tenantId, WIDE_WINDOW);
      expect(results).toEqual([]);
      expect(await app.prisma.phorestSyncRun.count({ where: { tenantId: seed.tenantId } })).toBe(
        before,
      );
      expect(requested).toHaveLength(0);
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("isolation + order: a 503 on salon A's branch leaves A ERROR while B still syncs, strictly after A", async () => {
    const seed = await seedPhorestTenant(app, "tenant-i");
    try {
      const b = await addCoupledSalon(app, seed.tenantId, "branch-2", { name: "Salon B" });
      const requested = mockPhorestByBranch({
        "branch-1": { status: 503 },
        "branch-2": { worktimetables: worktimetables([BEA_SLOT]) },
      });

      const results = await syncPhorestForTenant(app, seed.tenantId, WIDE_WINDOW);
      expect(results.map((r) => r.salonId)).toEqual([seed.salonId, b.salonId]);
      expect(results[0].status).toBe("ERROR");
      expect(results[1].status).toBe("SUCCESS");
      expect(results[1].created).toBe(1);
      const bShifts = await app.prisma.shift.count({
        where: { salonId: b.salonId, deletedAt: null },
      });
      expect(bShifts).toBe(1);

      const lastA = requested.map((u) => u.includes("/branch/branch-1/")).lastIndexOf(true);
      const firstB = requested.findIndex((u) => u.includes("/branch/branch-2/"));
      expect(lastA).toBeGreaterThanOrEqual(0);
      expect(firstB).toBeGreaterThan(lastA);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });
});
