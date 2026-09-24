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
//
// The appointment case (D-11) uses a dynamic in-horizon date, because the appointment sync always
// fetches today..today+horizon. The cross-tenant case (AC-2/AC-5) couples two tenants to the same
// branch id — allowed, the coupling is unique per (tenant, provider, branch) only.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, createTestSalon } from "../../../__tests__/setup";
import { todayInTz, dateStrInTz } from "../../../contexts/working-time-account/timezone";
import { syncPhorestShifts } from "../sync-shifts";
import { syncPhorestAppointments } from "../sync-appointments";
import { syncPhorestForTenant } from "../sync-tenant";
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

const TZ = "Europe/Berlin";

/** In-horizon appointment date, computed the way the service does (todayInTz + N days). */
function inHorizon(daysAhead: number): string {
  const day = todayInTz(TZ);
  day.setUTCDate(day.getUTCDate() + daysAhead);
  return dateStrInTz(day, TZ);
}

/** An appointment page with one item per entry (only staff + date + times, no PII needed). */
function appointmentsBody(items: { id: string; staffId: string; date: string }[]): unknown {
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

function uniqueSuffix(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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

describe("appointment hard-replace per salon (Phase 65b, D-11)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("(e) A's hard-replace removes A's stale row, never B's row; the stored row carries A's salon", async () => {
    const seed = await seedPhorestTenant(app, "scope-e");
    try {
      const b = await addCoupledSalon(app, seed.tenantId, "branch-2", { name: "Salon B" });
      const s = uniqueSuffix();
      const date = inHorizon(5);
      const bRow = await app.prisma.phorestAppointment.create({
        data: {
          employeeId: seed.mappedEmployeeId2,
          salonId: b.salonId,
          date: new Date(date),
          startTime: "12:00",
          endTime: "13:00",
          externalId: `appt-b-keep-${s}`,
        },
      });
      const aStale = await app.prisma.phorestAppointment.create({
        data: {
          employeeId: seed.mappedEmployeeId2,
          salonId: seed.salonId,
          date: new Date(date),
          startTime: "14:00",
          endTime: "15:00",
          externalId: `appt-a-stale-${s}`,
        },
      });
      const requested = mockPhorestByBranch({
        "branch-1": {
          appointments: appointmentsBody([
            { id: `appt-a-new-${s}`, staffId: MAPPED_STAFF_ID, date },
          ]),
        },
      });

      const res = await syncPhorestAppointments(app, seed.tenantId, seed.target, {});

      expect(res.status).toBe("SUCCESS");
      expect(res.appointmentsRemoved).toBe(1);
      expect(res.appointmentsStored).toBe(1);
      expect(await app.prisma.phorestAppointment.findUnique({ where: { id: aStale.id } })).toBe(
        null,
      );
      const bAfter = await app.prisma.phorestAppointment.findUnique({ where: { id: bRow.id } });
      expect(bAfter).toEqual(bRow);
      const fresh = await app.prisma.phorestAppointment.findUniqueOrThrow({
        where: { externalId: `appt-a-new-${s}` },
      });
      expect(fresh.employeeId).toBe(seed.mappedEmployeeId);
      expect(fresh.salonId).toBe(seed.salonId);
      expectOnlyBranch1(requested);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });
});

describe("cross-tenant same branch (Phase 65b, AC-2/AC-5)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  /**
   * Tenant T2, coupled to the SAME branch id as the seed tenant. Built by hand instead of a second
   * seedPhorestTenant(): that helper purges the fixed fixture e-mails first and would delete T1's
   * employees. T2's user e-mail is suffixed; its mapping reuses MAPPED_STAFF_ID, which is legal
   * because PhorestStaffMapping is unique per (tenant, phorestStaffId).
   */
  async function seedSecondTenantOnSameBranch(
    branchId: string,
  ): Promise<{ tenantId: string; salonId: string; employeeId: string }> {
    const s = uniqueSuffix();
    const tenant = await app.prisma.tenant.create({
      data: { name: `Phorest T2 ${s}`, slug: `phorest-t2-${s}`, federalState: "NIEDERSACHSEN" },
    });
    await app.prisma.tenantConfig.create({
      data: {
        tenantId: tenant.id,
        timezone: TZ,
        phorestBusinessId: "biz-1",
        phorestUsername: "user@salon.de",
        phorestPassword: "secret-pw",
        phorestSyncWindowDays: 7,
      },
    });
    const salon = await createTestSalon(app.prisma, tenant.id, { name: tenant.name });
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: tenant.id,
        salonId: salon.id,
        provider: "PHOREST",
        externalBranchId: branchId,
      },
    });
    const user = await app.prisma.user.create({
      data: { email: `t2-${s}@example.test`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        employeeNumber: `T2-${s}`,
        firstName: "Tara",
        lastName: "Zweitmandant",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.phorestStaffMapping.create({
      data: { tenantId: tenant.id, phorestStaffId: MAPPED_STAFF_ID, employeeId: employee.id },
    });
    return { tenantId: tenant.id, salonId: salon.id, employeeId: employee.id };
  }

  it("two tenants coupled to the same branch id: T1's orchestrator run never touches T2 and every run's salon is its own tenant's", async () => {
    const t1 = await seedPhorestTenant(app, "scope-xt");
    let t2: Awaited<ReturnType<typeof seedSecondTenantOnSameBranch>> | undefined;
    try {
      t2 = await seedSecondTenantOnSameBranch(t1.target.externalBranchId);
      const s = uniqueSuffix();
      // In T1's window and absent from T1's fresh set — a tenant-blind reconcile would cancel it.
      const t2Shift = await app.prisma.shift.create({
        data: {
          employeeId: t2.employeeId,
          salonId: t2.salonId,
          date: new Date("2026-08-05"),
          startTime: "08:00",
          endTime: "16:00",
          label: "Phorest",
          origin: "PHOREST",
          externalId: `${MAPPED_STAFF_ID}|2026-08-05|08:00:00|16:00:00|t2-${s}`,
        },
      });
      // In T1's appointment horizon — a tenant-blind hard-replace would delete it.
      const t2Appt = await app.prisma.phorestAppointment.create({
        data: {
          employeeId: t2.employeeId,
          salonId: t2.salonId,
          date: new Date(inHorizon(4)),
          startTime: "10:00",
          endTime: "11:00",
          externalId: `appt-t2-${s}`,
        },
      });
      const requested = mockPhorestByBranch({ "branch-1": { worktimetables: wttFixture } });

      const results = await syncPhorestForTenant(app, t1.tenantId, WIDE_WINDOW);

      expect(results.map((r) => r.salonId)).toEqual([t1.salonId]);
      expect(results[0].status).toBe("SUCCESS");
      expect(results[0].created).toBe(2);
      expect(results[0].cancelled).toBe(0);
      expect(results[0].appointments.status).toBe("SUCCESS");

      expect(await app.prisma.shift.findUnique({ where: { id: t2Shift.id } })).toEqual(t2Shift);
      expect(await app.prisma.phorestAppointment.findUnique({ where: { id: t2Appt.id } })).toEqual(
        t2Appt,
      );
      expect(await app.prisma.phorestSyncRun.count({ where: { tenantId: t2.tenantId } })).toBe(0);

      const runs = await app.prisma.phorestSyncRun.findMany({
        where: { tenantId: { in: [t1.tenantId, t2.tenantId] } },
        include: { salon: { select: { tenantId: true } } },
      });
      expect(runs).toHaveLength(1);
      for (const run of runs) {
        expect(run.salon.tenantId).toBe(run.tenantId);
      }
      expect(runs[0].tenantId).toBe(t1.tenantId);
      expect(runs[0].salonId).toBe(t1.salonId);
      expect(requested.length).toBeGreaterThan(0);
    } finally {
      if (t2) await cleanupPhorestTenant(app, t2.tenantId);
      await cleanupPhorestTenant(app, t1.tenantId);
    }
  });
});
