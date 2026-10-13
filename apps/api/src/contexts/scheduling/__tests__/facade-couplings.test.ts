/**
 * Phase 89 plan 07 (Issue #89, D-08/D-11/D-12/D-12a) — the Schichtplanung coupling facade:
 * `createSalonCoupling`, `setSalonCoupling`, `removeSalonCoupling` and the typed
 * `SalonCouplingConflictError`. Called directly with `app.prisma`, like facade-shifts.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../../__tests__/setup";
import {
  createSalonCoupling,
  setSalonCoupling,
  removeSalonCoupling,
  SalonCouplingConflictError,
} from "../index";

describe("Schichtplanung facade — salon coupling rules (Phase 89 plan 07)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;

  const salonOf = async (name: string, isActive = true) => {
    const salon = await createTestSalon(app.prisma, tenantA.tenant.id, { name, isActive });
    return { id: salon.id, isActive: salon.isActive };
  };
  const rowsOf = (salonId: string) =>
    app.prisma.salonCoupling.findMany({ where: { salonId, tenantId: tenantA.tenant.id } });

  /** A db whose `salonCoupling.findFirst` hides every row, so the insert itself must collide. */
  const blindDb = () =>
    new Proxy(app.prisma, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "salonCoupling") {
          return new Proxy(value as object, {
            get(t, p) {
              if (p === "findFirst") return async () => null;
              const member = Reflect.get(t, p);
              return typeof member === "function" ? member.bind(t) : member;
            },
          });
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "cfac-a");
    tenantB = await seedTestData(app, "cfac-b");
  });

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      try {
        await cleanupTestData(app, t.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed (coupling facade):", err);
      }
    }
  });

  describe("createSalonCoupling", () => {
    it("refuses an inactive salon and writes no row", async () => {
      const salon = await salonOf("cfac inactive", false);
      const res = await createSalonCoupling(app.prisma, tenantA.tenant.id, salon, "cfac-b-inact");
      expect(res).toEqual({ status: "SALON_INACTIVE" });
      expect(await rowsOf(salon.id)).toHaveLength(0);
    });

    it("creates a PHOREST coupling for an active uncoupled salon", async () => {
      const salon = await salonOf("cfac create");
      const res = await createSalonCoupling(app.prisma, tenantA.tenant.id, salon, "cfac-b-create");
      expect(res.status).toBe("CREATED");
      if (res.status !== "CREATED") return;
      expect(res.coupling).toMatchObject({
        tenantId: tenantA.tenant.id,
        salonId: salon.id,
        provider: "PHOREST",
        externalBranchId: "cfac-b-create",
      });
    });

    it("answers SALON_ALREADY_COUPLED for a second coupling of the same salon", async () => {
      const salon = await salonOf("cfac twice");
      await createSalonCoupling(app.prisma, tenantA.tenant.id, salon, "cfac-b-twice");
      const res = await createSalonCoupling(app.prisma, tenantA.tenant.id, salon, "cfac-b-twice-2");
      expect(res).toEqual({ status: "SALON_ALREADY_COUPLED" });
      expect(await rowsOf(salon.id)).toHaveLength(1);
    });

    it("answers BRANCH_ALREADY_COUPLED when another salon of the tenant owns the branch", async () => {
      const first = await salonOf("cfac branch 1");
      const second = await salonOf("cfac branch 2");
      await createSalonCoupling(app.prisma, tenantA.tenant.id, first, "cfac-b-shared");
      const res = await createSalonCoupling(app.prisma, tenantA.tenant.id, second, "cfac-b-shared");
      expect(res).toEqual({ status: "BRANCH_ALREADY_COUPLED" });
      expect(await rowsOf(second.id)).toHaveLength(0);
    });

    it("allows the same branch id in another tenant", async () => {
      const salon = await salonOf("cfac cross tenant");
      await createSalonCoupling(app.prisma, tenantA.tenant.id, salon, "cfac-b-cross");
      const foreignSalon = await createTestSalon(app.prisma, tenantB.tenant.id, {
        name: "cfac cross tenant B",
      });
      const res = await createSalonCoupling(
        app.prisma,
        tenantB.tenant.id,
        { id: foreignSalon.id, isActive: true },
        "cfac-b-cross",
      );
      expect(res.status).toBe("CREATED");
    });
  });

  describe("setSalonCoupling", () => {
    it("creates when none exists", async () => {
      const salon = await salonOf("cfac set create");
      const res = await setSalonCoupling(app.prisma, tenantA.tenant.id, salon, "cfac-s-create");
      expect(res.status).toBe("CREATED");
      expect(await rowsOf(salon.id)).toHaveLength(1);
    });

    it("reports UNCHANGED for the same branch id and keeps the row", async () => {
      const salon = await salonOf("cfac set same");
      const first = await setSalonCoupling(app.prisma, tenantA.tenant.id, salon, "cfac-s-same");
      const res = await setSalonCoupling(app.prisma, tenantA.tenant.id, salon, "cfac-s-same");
      expect(res.status).toBe("UNCHANGED");
      if (res.status !== "UNCHANGED" || first.status !== "CREATED") return;
      expect(res.coupling.id).toBe(first.coupling.id);
    });

    it("replaces a different branch id by remove + create and returns both rows", async () => {
      const salon = await salonOf("cfac set replace");
      const first = await setSalonCoupling(app.prisma, tenantA.tenant.id, salon, "cfac-s-old");
      const res = await setSalonCoupling(app.prisma, tenantA.tenant.id, salon, "cfac-s-new");
      expect(res.status).toBe("REPLACED");
      if (res.status !== "REPLACED" || first.status !== "CREATED") return;
      expect(res.removed.id).toBe(first.coupling.id);
      expect(res.removed.externalBranchId).toBe("cfac-s-old");
      expect(res.created.externalBranchId).toBe("cfac-s-new");
      const rows = await rowsOf(salon.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ externalBranchId: "cfac-s-new", provider: "PHOREST" });
    });

    it("leaves the old row untouched when the new branch belongs to another salon", async () => {
      const salon = await salonOf("cfac set conflict 1");
      const other = await salonOf("cfac set conflict 2");
      await setSalonCoupling(app.prisma, tenantA.tenant.id, salon, "cfac-s-mine");
      await setSalonCoupling(app.prisma, tenantA.tenant.id, other, "cfac-s-theirs");
      const res = await setSalonCoupling(app.prisma, tenantA.tenant.id, salon, "cfac-s-theirs");
      expect(res).toEqual({ status: "BRANCH_ALREADY_COUPLED" });
      const rows = await rowsOf(salon.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].externalBranchId).toBe("cfac-s-mine");
    });

    it("refuses an inactive salon", async () => {
      const salon = await salonOf("cfac set inactive", false);
      const res = await setSalonCoupling(app.prisma, tenantA.tenant.id, salon, "cfac-s-inact");
      expect(res).toEqual({ status: "SALON_INACTIVE" });
      expect(await rowsOf(salon.id)).toHaveLength(0);
    });
  });

  describe("removeSalonCoupling", () => {
    it("deletes an existing coupling and returns the removed row", async () => {
      const salon = await salonOf("cfac remove");
      await createSalonCoupling(app.prisma, tenantA.tenant.id, salon, "cfac-r-1");
      const res = await removeSalonCoupling(app.prisma, tenantA.tenant.id, salon.id);
      expect(res.status).toBe("REMOVED");
      if (res.status !== "REMOVED") return;
      expect(res.removed).toMatchObject({ salonId: salon.id, externalBranchId: "cfac-r-1" });
      expect(await rowsOf(salon.id)).toHaveLength(0);
    });

    it("answers NOT_FOUND for a never-coupled salon", async () => {
      const salon = await salonOf("cfac remove none");
      expect(await removeSalonCoupling(app.prisma, tenantA.tenant.id, salon.id)).toEqual({
        status: "NOT_FOUND",
      });
    });

    it("answers NOT_FOUND for another tenant's salon id and leaves the foreign row untouched", async () => {
      const foreignSalon = await createTestSalon(app.prisma, tenantB.tenant.id, {
        name: "cfac remove foreign",
      });
      const foreign = await app.prisma.salonCoupling.create({
        data: {
          tenantId: tenantB.tenant.id,
          salonId: foreignSalon.id,
          provider: "PHOREST",
          externalBranchId: "cfac-r-foreign",
        },
      });
      const res = await removeSalonCoupling(app.prisma, tenantA.tenant.id, foreignSalon.id);
      expect(res).toEqual({ status: "NOT_FOUND" });
      expect(
        await app.prisma.salonCoupling.findUnique({ where: { id: foreign.id } }),
      ).not.toBeNull();
    });
  });

  describe("unique-index races (the pre-checks are blind)", () => {
    it("throws SalonCouplingConflictError(SALON_ALREADY_COUPLED) when the salon index collides", async () => {
      const salon = await salonOf("cfac race salon");
      await createSalonCoupling(app.prisma, tenantA.tenant.id, salon, "cfac-race-s1");
      const err = await createSalonCoupling(blindDb(), tenantA.tenant.id, salon, "cfac-race-s2")
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SalonCouplingConflictError);
      expect((err as SalonCouplingConflictError).code).toBe("SALON_ALREADY_COUPLED");
      expect((err as SalonCouplingConflictError).name).toBe("SalonCouplingConflictError");
      expect(await rowsOf(salon.id)).toHaveLength(1);
    });

    it("throws SalonCouplingConflictError(BRANCH_ALREADY_COUPLED) when the branch index collides", async () => {
      const first = await salonOf("cfac race branch 1");
      const second = await salonOf("cfac race branch 2");
      await createSalonCoupling(app.prisma, tenantA.tenant.id, first, "cfac-race-b");
      const err = await createSalonCoupling(blindDb(), tenantA.tenant.id, second, "cfac-race-b")
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SalonCouplingConflictError);
      expect((err as SalonCouplingConflictError).code).toBe("BRANCH_ALREADY_COUPLED");
      expect(await rowsOf(second.id)).toHaveLength(0);
    });
  });
});
