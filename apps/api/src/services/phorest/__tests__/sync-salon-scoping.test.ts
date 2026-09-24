// Phase 65b (issue #65, D-09/D-10/D-24) — the per-query salon boundary matrix of the Phorest
// reconcile. Issue #65's core criterion: "Ein Lauf für Salon A storniert keine Schicht und entfernt
// keinen Termin von Salon B". Plan 01 added every salon filter in one tracer (sync-tenant.test.ts);
// this file makes each filter individually load-bearing — each case fails when exactly its own
// filter is removed (see the mutation proofs in the phase SUMMARY).
//
// Every shift case: one tenant, salon A = the seed's default salon coupled to "branch-1", salon B
// coupled to "branch-2". Only A's run is executed and only "branch-1" is registered with the fetch
// mock, so a fetch for B's branch would throw — each case also asserts that no requested URL names
// branch-2. Every shift case passes an explicit window so no case depends on today's date.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp } from "../../../__tests__/setup";
import { syncPhorestShifts } from "../sync-shifts";
import {
  seedPhorestTenant,
  cleanupPhorestTenant,
  addCoupledSalon,
  mockPhorestByBranch,
  seedPendingLeaveRequest,
  MAPPED_STAFF_ID,
  MAPPED_STAFF_ID_2,
  type PhorestSeed,
} from "./helpers";
import wttFixture from "./fixtures/worktimetables.json";

const originalFetch = global.fetch;

const WIDE_WINDOW = { startDate: "2026-07-01", endDate: "2026-12-31" };

// worktimetables.json delivers exactly these two mapped slots (Erika) plus one unmapped slot.
const ERIKA_0730_KEY = `${MAPPED_STAFF_ID}|2026-07-30|08:00:00|16:00:00`;
const ERIKA_0731_KEY = `${MAPPED_STAFF_ID}|2026-07-31|09:00:00|17:00:00`;

type ShiftFixture = {
  employeeId: string;
  salonId: string;
  date: string;
  startTime: string;
  endTime: string;
  origin?: "MANUAL" | "PHOREST";
  externalId?: string | null;
  label?: string | null;
  deletedAt?: Date | null;
  deletedReason?: string | null;
};

/** Seed one shift row with an EXPLICIT salon — the whole point of this file. */
async function seedShift(app: FastifyInstance, data: ShiftFixture) {
  return app.prisma.shift.create({ data: { ...data, date: new Date(data.date) } });
}

/** The fetch log proves A's run reached Phorest and never asked for salon B's branch. */
function expectOnlyBranch1(requested: string[]): void {
  expect(requested.length).toBeGreaterThan(0);
  expect(requested.some((u) => u.includes("/branch/branch-2/"))).toBe(false);
}

describe("shift reconcile per salon (Phase 65b, D-09/D-10)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  /** Seed tenant (salon A, branch-1) + coupled salon B (branch-2). */
  async function seedTwoSalons(suffix: string): Promise<{ seed: PhorestSeed; salonB: string }> {
    const seed = await seedPhorestTenant(app, suffix);
    const b = await addCoupledSalon(app, seed.tenantId, "branch-2", { name: "Salon B" });
    return { seed, salonB: b.salonId };
  }

  it("(b) staleCandidates: A cancels its own vanished PHOREST shift, never B's active PHOREST shift", async () => {
    const { seed, salonB } = await seedTwoSalons("scope-b");
    try {
      const bShift = await seedShift(app, {
        employeeId: seed.mappedEmployeeId2,
        salonId: salonB,
        date: "2026-07-31",
        startTime: "09:00",
        endTime: "17:00",
        origin: "PHOREST",
        externalId: `${MAPPED_STAFF_ID_2}|2026-07-31|09:00:00|17:00:00`,
        label: "Phorest",
      });
      const aVanished = await seedShift(app, {
        employeeId: seed.mappedEmployeeId,
        salonId: seed.salonId,
        date: "2026-08-01",
        startTime: "08:00",
        endTime: "16:00",
        origin: "PHOREST",
        externalId: `${MAPPED_STAFF_ID}|2026-08-01|08:00:00|16:00:00`,
        label: "Phorest",
      });
      const requested = mockPhorestByBranch({ "branch-1": { worktimetables: wttFixture } });

      const res = await syncPhorestShifts(app, seed.tenantId, seed.target, WIDE_WINDOW);

      expect(res.status).toBe("SUCCESS");
      expect(res.cancelled).toBe(1);
      const aAfter = await app.prisma.shift.findUniqueOrThrow({ where: { id: aVanished.id } });
      expect(aAfter.deletedAt).not.toBeNull();
      expect(aAfter.deletedReason).toBe("PHOREST_REMOVED");
      const bAfter = await app.prisma.shift.findUniqueOrThrow({ where: { id: bShift.id } });
      expect(bAfter.deletedAt).toBeNull();
      expect(bAfter.deletedReason).toBeNull();
      const bDeleteAudits = await app.prisma.auditLog.count({
        where: { action: "DELETE", entity: "Shift", entityId: bShift.id },
      });
      expect(bDeleteAudits).toBe(0);
      expectOnlyBranch1(requested);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("(c) replace pass: A's covered day replaces A's MANUAL shift, never the same employee's MANUAL shift in B", async () => {
    const { seed, salonB } = await seedTwoSalons("scope-c");
    try {
      const aManual = await seedShift(app, {
        employeeId: seed.mappedEmployeeId,
        salonId: seed.salonId,
        date: "2026-07-30",
        startTime: "18:00",
        endTime: "21:00",
      });
      const bManual = await seedShift(app, {
        employeeId: seed.mappedEmployeeId,
        salonId: salonB,
        date: "2026-07-30",
        startTime: "17:00",
        endTime: "20:00",
      });
      const requested = mockPhorestByBranch({ "branch-1": { worktimetables: wttFixture } });

      const res = await syncPhorestShifts(app, seed.tenantId, seed.target, WIDE_WINDOW);

      expect(res.status).toBe("SUCCESS");
      expect(res.replaced).toBe(1);
      const aAfter = await app.prisma.shift.findUniqueOrThrow({ where: { id: aManual.id } });
      expect(aAfter.deletedReason).toBe("PHOREST_REPLACED");
      expect(aAfter.deletedAt).not.toBeNull();
      const bAfter = await app.prisma.shift.findUniqueOrThrow({ where: { id: bManual.id } });
      expect(bAfter).toEqual(bManual);
      expectOnlyBranch1(requested);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("(d) pending-leave protection counts and audits only the run salon's shift", async () => {
    const { seed, salonB } = await seedTwoSalons("scope-d");
    try {
      await seedPendingLeaveRequest(
        app,
        seed.mappedEmployeeId2,
        "2026-07-31",
        "2026-07-31",
        "PENDING",
      );
      const aShift = await seedShift(app, {
        employeeId: seed.mappedEmployeeId2,
        salonId: seed.salonId,
        date: "2026-07-31",
        startTime: "10:00",
        endTime: "18:00",
        origin: "PHOREST",
        externalId: `${MAPPED_STAFF_ID_2}|2026-07-31|10:00:00|18:00:00`,
        label: "Phorest",
      });
      const bShift = await seedShift(app, {
        employeeId: seed.mappedEmployeeId2,
        salonId: salonB,
        date: "2026-07-31",
        startTime: "11:00",
        endTime: "19:00",
        origin: "PHOREST",
        externalId: `${MAPPED_STAFF_ID_2}|2026-07-31|11:00:00|19:00:00`,
        label: "Phorest",
      });
      // worktimetables.json has no slot of Bea, so both shifts "vanished" from branch-1's answer.
      const requested = mockPhorestByBranch({ "branch-1": { worktimetables: wttFixture } });

      const res = await syncPhorestShifts(app, seed.tenantId, seed.target, WIDE_WINDOW);

      expect(res.status).toBe("SUCCESS");
      expect(res.protectedPendingLeave).toBe(1);
      expect(res.cancelled).toBe(0);
      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "Shift", action: "UPDATE", entityId: null },
      });
      const pendingAudits = audits.filter((a) => {
        const nv = a.newValue as Record<string, unknown> | null;
        return nv?.skipped === "PENDING_LEAVE" && nv.employeeId === seed.mappedEmployeeId2;
      });
      expect(pendingAudits).toHaveLength(1);
      expect((pendingAudits[0].newValue as Record<string, unknown>).shiftId).toBe(aShift.id);
      const both = await app.prisma.shift.findMany({
        where: { id: { in: [aShift.id, bShift.id] } },
      });
      expect(both).toHaveLength(2);
      expect(both.every((s) => s.deletedAt === null)).toBe(true);
      expectOnlyBranch1(requested);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("(adopt) a legacy label='Phorest' MANUAL row in B at A's slot is never adopted — A creates its own PHOREST row", async () => {
    const { seed, salonB } = await seedTwoSalons("scope-adopt");
    try {
      const bLegacy = await seedShift(app, {
        employeeId: seed.mappedEmployeeId,
        salonId: salonB,
        date: "2026-07-30",
        startTime: "08:00",
        endTime: "16:00",
        origin: "MANUAL",
        externalId: null,
        label: "Phorest",
      });
      const requested = mockPhorestByBranch({ "branch-1": { worktimetables: wttFixture } });

      const res = await syncPhorestShifts(app, seed.tenantId, seed.target, WIDE_WINDOW);

      expect(res.status).toBe("SUCCESS");
      const bAfter = await app.prisma.shift.findUniqueOrThrow({ where: { id: bLegacy.id } });
      expect(bAfter.origin).toBe("MANUAL");
      expect(bAfter.externalId).toBeNull();
      expect(bAfter.salonId).toBe(salonB);
      expect(bAfter.deletedAt).toBeNull();
      const aRow = await app.prisma.shift.findUnique({ where: { externalId: ERIKA_0730_KEY } });
      expect(aRow).not.toBeNull();
      expect(aRow!.id).not.toBe(bLegacy.id);
      expect(aRow!.salonId).toBe(seed.salonId);
      expect(aRow!.origin).toBe("PHOREST");
      expect(aRow!.deletedAt).toBeNull();
      expectOnlyBranch1(requested);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("(i) collision, active: a slot whose externalId B owns is skipped — B's row untouched, the day not covered by A", async () => {
    const { seed, salonB } = await seedTwoSalons("scope-i-active");
    try {
      const bOwner = await seedShift(app, {
        employeeId: seed.mappedEmployeeId,
        salonId: salonB,
        date: "2026-07-30",
        startTime: "07:00",
        endTime: "15:00",
        origin: "PHOREST",
        externalId: ERIKA_0730_KEY,
        label: "Phorest",
      });
      // Control: a MANUAL shift of Erika in A on the collided day. If A treated the day as covered,
      // the replace pass would soft-delete it.
      const aControl = await seedShift(app, {
        employeeId: seed.mappedEmployeeId,
        salonId: seed.salonId,
        date: "2026-07-30",
        startTime: "18:00",
        endTime: "21:00",
      });
      const requested = mockPhorestByBranch({ "branch-1": { worktimetables: wttFixture } });

      const res = await syncPhorestShifts(app, seed.tenantId, seed.target, WIDE_WINDOW);

      expect(res.status).toBe("SUCCESS");
      expect(res.skippedOtherSalon).toBe(1);
      expect(res.created).toBe(1); // only the 2026-07-31 slot
      expect(res.replaced).toBe(0);
      const bAfter = await app.prisma.shift.findUniqueOrThrow({ where: { id: bOwner.id } });
      expect(bAfter.startTime).toBe("07:00");
      expect(bAfter.endTime).toBe("15:00");
      expect(bAfter.salonId).toBe(salonB);
      expect(bAfter.deletedAt).toBeNull();
      const controlAfter = await app.prisma.shift.findUniqueOrThrow({
        where: { id: aControl.id },
      });
      expect(controlAfter.deletedAt).toBeNull();
      const created = await app.prisma.shift.findUniqueOrThrow({
        where: { externalId: ERIKA_0731_KEY },
      });
      expect(created.salonId).toBe(seed.salonId);
      expectOnlyBranch1(requested);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("(i) collision, soft-deleted: a B-owned soft-deleted row is skipped too and never revived by A", async () => {
    const { seed, salonB } = await seedTwoSalons("scope-i-deleted");
    try {
      const deletedAt = new Date("2026-07-20T10:00:00Z");
      const bOwner = await seedShift(app, {
        employeeId: seed.mappedEmployeeId,
        salonId: salonB,
        date: "2026-07-30",
        startTime: "07:00",
        endTime: "15:00",
        origin: "PHOREST",
        externalId: ERIKA_0730_KEY,
        label: "Phorest",
        deletedAt,
        deletedReason: "PHOREST_REMOVED",
      });
      const requested = mockPhorestByBranch({ "branch-1": { worktimetables: wttFixture } });

      const res = await syncPhorestShifts(app, seed.tenantId, seed.target, WIDE_WINDOW);

      expect(res.status).toBe("SUCCESS");
      expect(res.skippedOtherSalon).toBe(1);
      expect(res.created).toBe(1);
      const bAfter = await app.prisma.shift.findUniqueOrThrow({ where: { id: bOwner.id } });
      expect(bAfter.deletedAt).toEqual(deletedAt);
      expect(bAfter.deletedReason).toBe("PHOREST_REMOVED");
      expect(bAfter.startTime).toBe("07:00");
      expect(bAfter.endTime).toBe("15:00");
      expect(bAfter.salonId).toBe(salonB);
      expectOnlyBranch1(requested);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("AC-3 parity: pre-65b PHOREST shifts on the default salon re-sync as created 0 / updated 2 / cancelled 0", async () => {
    // Single-salon on purpose: the pre-65b world had exactly one salon, and the migration coupled
    // it. The rows look like the 325 backfill left them — origin PHOREST, matching externalIds.
    const seed = await seedPhorestTenant(app, "scope-parity");
    try {
      await seedShift(app, {
        employeeId: seed.mappedEmployeeId,
        salonId: seed.salonId,
        date: "2026-07-30",
        startTime: "08:00",
        endTime: "16:00",
        origin: "PHOREST",
        externalId: ERIKA_0730_KEY,
        label: "Phorest",
      });
      await seedShift(app, {
        employeeId: seed.mappedEmployeeId,
        salonId: seed.salonId,
        date: "2026-07-31",
        startTime: "09:00",
        endTime: "17:00",
        origin: "PHOREST",
        externalId: ERIKA_0731_KEY,
        label: "Phorest",
      });
      const requested = mockPhorestByBranch({ "branch-1": { worktimetables: wttFixture } });

      const res = await syncPhorestShifts(app, seed.tenantId, seed.target, WIDE_WINDOW);

      expect(res.status).toBe("SUCCESS");
      expect(res.created).toBe(0);
      expect(res.updated).toBe(2);
      expect(res.cancelled).toBe(0);
      expect(res.replaced).toBe(0);
      expect(res.skippedOtherSalon).toBe(0);
      const active = await app.prisma.shift.count({
        where: { employeeId: seed.mappedEmployeeId, deletedAt: null, salonId: seed.salonId },
      });
      expect(active).toBe(2);
      expectOnlyBranch1(requested);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });
});
