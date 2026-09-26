/**
 * Phase 65b (issue #65) — D-05/D-06, AC-1/AC-3/AC-4/AC-5.
 *
 * Executes the REAL migration text (never a restatement of it) — same pattern as
 * `shift-salon-migration.test.ts` (Phase 325): `readDataSection()` resolves the migration file by
 * its exact, hardcoded directory name (never `readdirSync`), and the replay case runs inside a
 * `$transaction` that always ends by throwing a module-private sentinel error so the fixture never
 * lands in the shared test database — assertions run AFTER the rejection, on values captured
 * outside the callback (an assertion failure inside the callback would be masked by the rollback).
 *
 * The migrated test database already has `PhorestSyncRun.salonId` NOT NULL (plan 01 applied this
 * migration via `test:setup`), so the replay first drops NOT NULL INSIDE the rolled-back
 * transaction (Postgres DDL is transactional) to recreate the legacy, pre-migration shape.
 *
 * The helpers below are copied from the 325 test, not imported: importing another test file would
 * register its describes a second time.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  withPre71bSalonSchema,
} from "./setup";
import { findDefaultSalon } from "../contexts/platform/facade/salons";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root, same resolution as
// shift-salon-migration.test.ts.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SALON_COUPLING_MIGRATION_DIR = "20260925004150_salon_coupling";
const MIGRATION_PATH = join(
  REPO_ROOT,
  "packages/db/prisma/migrations",
  SALON_COUPLING_MIGRATION_DIR,
  "migration.sql",
);

const DATA_SECTION_BEGIN = "-- 65b-data-migration:begin";
const DATA_SECTION_END = "-- 65b-data-migration:end";

/**
 * Returns the text strictly between the two marker lines. FAILS the calling test (via `expect`)
 * if either marker is missing, a statement is missing, or DDL / a TenantConfig write snuck into
 * the data section (phorestBranchId is deliberately NOT cleared — it is the rollback path).
 */
function readDataSection(): string {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const beginIdx = sql.indexOf(DATA_SECTION_BEGIN);
  const endIdx = sql.indexOf(DATA_SECTION_END);
  expect(beginIdx, `migration.sql is missing the "${DATA_SECTION_BEGIN}" marker`).toBeGreaterThan(
    -1,
  );
  expect(endIdx, `migration.sql is missing the "${DATA_SECTION_END}" marker`).toBeGreaterThan(-1);
  const section = sql.slice(beginIdx + DATA_SECTION_BEGIN.length, endIdx);
  expect(section).toContain('INSERT INTO "Salon"');
  expect(section).toContain('INSERT INTO "SalonCoupling"');
  expect(section).toContain('UPDATE "PhorestSyncRun"');
  expect(section, "the data section must not contain DDL").not.toContain("ALTER TABLE");
  expect(section, "the data section must not write TenantConfig").not.toContain(
    'UPDATE "TenantConfig"',
  );
  return section;
}

/**
 * Strips comment-only lines, then splits on a semicolon that ends a line. Executed statement by
 * statement because one `$executeRawUnsafe` carrying several statements can be rejected by the
 * driver's extended protocol.
 */
function splitDataSectionStatements(section: string): string[] {
  const withoutComments = section
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe("data section shape (D-05)", () => {
  it("holds exactly INSERT Salon, INSERT SalonCoupling, UPDATE PhorestSyncRun — in that order, no DDL, no TenantConfig write", () => {
    const statements = splitDataSectionStatements(readDataSection());
    expect(statements).toHaveLength(3);
    expect(statements[0].startsWith('INSERT INTO "Salon"')).toBe(true);
    expect(statements[1].startsWith('INSERT INTO "SalonCoupling"')).toBe(true);
    expect(statements[2].startsWith('UPDATE "PhorestSyncRun"')).toBe(true);
  });
});

/** Thrown at the end of the replay transaction so its fixture never lands in the database. */
class SalonCouplingMigrationReplayRollback extends Error {}

type Seeded = Awaited<ReturnType<typeof seedTestData>>;
type SeededNoSalon = Omit<Seeded, "salonId"> & { salonId: string | null };

describe("Phase 65b — salon-coupling migration replay (D-06, AC-3)", () => {
  let app: FastifyInstance;
  // P: no salon at all (the section's own INSERT must create it).
  let tenantP: SeededNoSalon;
  // Q: two ACTIVE salons — the earlier one is the default.
  let tenantQ: SeededNoSalon;
  // T: the earliest salon is INACTIVE, a later one is active — the active one is the default.
  let tenantT: SeededNoSalon;
  // R / S / S2: phorestBranchId NULL / whitespace / empty — no coupling.
  let tenantR: Seeded;
  let tenantS: Seeded;
  let tenantS2: Seeded;
  // U: already coupled before the section runs — stays with its one coupling.
  let tenantU: Seeded;
  let q1: string;
  let q2: string;
  let t0Inactive: string;
  let t1Active: string;

  const BRANCH_IDS: Record<string, string | null> = {};

  async function setBranch(tenantId: string, value: string | null): Promise<void> {
    // A test is the one legitimate writer of the deprecated column (the deprecation guard
    // excludes tests): it recreates the pre-65b configuration the migration reads.
    await app.prisma.tenantConfig.update({ where: { tenantId }, data: { phorestBranchId: value } });
    BRANCH_IDS[tenantId] = value;
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenantP = await seedTestData(app, "coupling-mig-p", { withDefaultSalon: false });
    tenantQ = await seedTestData(app, "coupling-mig-q", { withDefaultSalon: false });
    tenantT = await seedTestData(app, "coupling-mig-t", { withDefaultSalon: false });
    tenantR = await seedTestData(app, "coupling-mig-r");
    tenantS = await seedTestData(app, "coupling-mig-s");
    tenantS2 = await seedTestData(app, "coupling-mig-s2");
    tenantU = await seedTestData(app, "coupling-mig-u");

    q1 = (
      await createTestSalon(app.prisma, tenantQ.tenant.id, {
        name: "Q1 active early",
        createdAt: new Date("2020-01-01T00:00:00Z"),
      })
    ).id;
    q2 = (
      await createTestSalon(app.prisma, tenantQ.tenant.id, {
        name: "Q2 active late",
        createdAt: new Date("2020-01-02T00:00:00Z"),
      })
    ).id;
    t0Inactive = (
      await createTestSalon(app.prisma, tenantT.tenant.id, {
        name: "T0 inactive earliest",
        isActive: false,
        createdAt: new Date("2020-01-01T00:00:00Z"),
      })
    ).id;
    t1Active = (
      await createTestSalon(app.prisma, tenantT.tenant.id, {
        name: "T1 active later",
        createdAt: new Date("2020-01-02T00:00:00Z"),
      })
    ).id;
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: tenantU.tenant.id,
        salonId: tenantU.salonId,
        provider: "PHOREST",
        externalBranchId: "branch-U-old",
      },
    });

    await setBranch(tenantP.tenant.id, "  branch-P  ");
    await setBranch(tenantQ.tenant.id, "branch-Q");
    await setBranch(tenantT.tenant.id, "branch-T");
    await setBranch(tenantR.tenant.id, null);
    await setBranch(tenantS.tenant.id, "   ");
    await setBranch(tenantS2.tenant.id, "");
    await setBranch(tenantU.tenant.id, "branch-U");
  });

  afterAll(async () => {
    for (const t of [tenantP, tenantQ, tenantT, tenantR, tenantS, tenantS2, tenantU]) {
      try {
        await cleanupTestData(app, t.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it(
    "couples exactly the tenants with a non-blank trimmed phorestBranchId on findDefaultSalon's salon, " +
      "backfills NULL run salons, keeps phorestBranchId, and is idempotent",
    async () => {
      const statements = splitDataSectionStatements(readDataSection());
      expect(statements).toHaveLength(3);

      const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const runP = `run-p-${s}`;
      const runQ = `run-q-${s}`;
      const runT = `run-t-${s}`;
      const runQPreset = `run-q-preset-${s}`; // already carries Q2 — must keep it
      const allRunIds = [runP, runQ, runT, runQPreset];

      const fixtureTenantIds = [tenantP, tenantQ, tenantT, tenantR, tenantS, tenantS2, tenantU].map(
        (t) => t.tenant.id,
      );

      type Coupling = { id: string; tenantId: string; salonId: string; externalBranchId: string };
      type Captured = {
        runSalonsBefore: Record<string, string | null>;
        runSalonsAfterFirst: Record<string, string | null>;
        runSalonsAfterSecond: Record<string, string | null>;
        couplingsAfterFirst: Coupling[];
        couplingsAfterSecond: Coupling[];
        pSalonIds: string[];
        defaultSalon: Record<string, string | null>;
        nullRunCount: number;
        crossTenantCouplingCount: number;
        branchIdsAfter: Record<string, string | null>;
      };
      let captured: Captured | undefined;

      await expect(
        app.prisma.$transaction(
          async (tx) => {
            // 1. Recreate the legacy shape: PhorestSyncRun.salonId nullable (DDL is transactional).
            await tx.$executeRawUnsafe(
              `ALTER TABLE "PhorestSyncRun" ALTER COLUMN "salonId" DROP NOT NULL`,
            );

            // 2. Legacy runs — NULL salon for P, Q, T; one Q run already on the LATER salon Q2.
            const legacyRuns: Array<[string, string, string | null]> = [
              [runP, tenantP.tenant.id, null],
              [runQ, tenantQ.tenant.id, null],
              [runT, tenantT.tenant.id, null],
              [runQPreset, tenantQ.tenant.id, q2],
            ];
            for (const [id, tenantId, salonId] of legacyRuns) {
              await tx.$executeRaw`
                INSERT INTO "PhorestSyncRun" ("id", "tenantId", "status", "salonId")
                VALUES (${id}, ${tenantId}, 'SUCCESS', ${salonId})
              `;
            }

            async function runSalons(): Promise<Record<string, string | null>> {
              const rows = await tx.$queryRaw<{ id: string; salonId: string | null }[]>`
                SELECT "id", "salonId" FROM "PhorestSyncRun" WHERE "id" = ANY(${allRunIds})
              `;
              return Object.fromEntries(rows.map((r) => [r.id, r.salonId]));
            }
            async function couplings(): Promise<Coupling[]> {
              const rows = await tx.salonCoupling.findMany({
                where: { tenantId: { in: fixtureTenantIds } },
                orderBy: { tenantId: "asc" },
              });
              return rows.map((c) => ({
                id: c.id,
                tenantId: c.tenantId,
                salonId: c.salonId,
                externalBranchId: c.externalBranchId,
              }));
            }

            const runSalonsBefore = await runSalons();

            // Phase 71b (issue #71): this data section's own `INSERT INTO "Salon"` predates
            // federalState and would NOT NULL-fail against the post-71b schema otherwise — wrap
            // both runs (and everything reading Salon rows in between) in ONE
            // withPre71bSalonSchema window.
            await withPre71bSalonSchema(tx, async () => {
              // 3. Execute the REAL data section, statement by statement.
              for (const stmt of statements) {
                await tx.$executeRawUnsafe(stmt);
              }

              const runSalonsAfterFirst = await runSalons();
              const couplingsAfterFirst = await couplings();
              const [{ count: nullRunCount }] = await tx.$queryRaw<{ count: number }[]>`
                SELECT count(*)::int AS count FROM "PhorestSyncRun" WHERE "salonId" IS NULL
              `;
              const [{ count: crossTenantCouplingCount }] = await tx.$queryRaw<{ count: number }[]>`
                SELECT count(*)::int AS count FROM "SalonCoupling" sc
                JOIN "Salon" sa ON sa."id" = sc."salonId"
                WHERE sa."tenantId" != sc."tenantId"
              `;

              // 4. D-06 rule pin — the runtime resolver vs. the migration's own choice.
              const defaultSalon: Record<string, string | null> = {};
              for (const tenantId of fixtureTenantIds) {
                defaultSalon[tenantId] = (await findDefaultSalon(tx, tenantId))?.id ?? null;
              }
              const pSalons = await tx.salon.findMany({ where: { tenantId: tenantP.tenant.id } });

              const configs = await tx.tenantConfig.findMany({
                where: { tenantId: { in: fixtureTenantIds } },
                select: { tenantId: true, phorestBranchId: true },
              });
              const branchIdsAfter = Object.fromEntries(
                configs.map((c) => [c.tenantId, c.phorestBranchId]),
              );

              // 5. Idempotency — run the section a SECOND time in the same transaction.
              for (const stmt of statements) {
                await tx.$executeRawUnsafe(stmt);
              }

              captured = {
                runSalonsBefore,
                runSalonsAfterFirst,
                runSalonsAfterSecond: await runSalons(),
                couplingsAfterFirst,
                couplingsAfterSecond: await couplings(),
                pSalonIds: pSalons.map((sal) => sal.id),
                defaultSalon,
                nullRunCount,
                crossTenantCouplingCount,
                branchIdsAfter,
              };
            });

            throw new SalonCouplingMigrationReplayRollback(
              "deliberate rollback — this fixture must never be committed",
            );
          },
          { timeout: 30000 },
        ),
      ).rejects.toBeInstanceOf(SalonCouplingMigrationReplayRollback);

      expect(captured).toBeDefined();
      const c = captured!;
      const couplingsOf = (tenantId: string) =>
        c.couplingsAfterFirst.filter((cp) => cp.tenantId === tenantId);

      // Legacy shape really was NULL before the section ran.
      expect(c.runSalonsBefore[runP]).toBeNull();
      expect(c.runSalonsBefore[runQ]).toBeNull();
      expect(c.runSalonsBefore[runT]).toBeNull();
      expect(c.runSalonsBefore[runQPreset]).toBe(q2);

      // P: exactly one salon inserted, one PHOREST coupling "branch-P" (trimmed) on it.
      expect(c.pSalonIds).toHaveLength(1);
      expect(c.defaultSalon[tenantP.tenant.id]).toBe(c.pSalonIds[0]);
      expect(couplingsOf(tenantP.tenant.id)).toHaveLength(1);
      expect(couplingsOf(tenantP.tenant.id)[0].externalBranchId).toBe("branch-P");
      expect(couplingsOf(tenantP.tenant.id)[0].salonId).toBe(c.pSalonIds[0]);

      // Q: two active salons — the coupling lands where findDefaultSalon(tx, Q) points (Q1).
      expect(c.defaultSalon[tenantQ.tenant.id]).toBe(q1);
      expect(couplingsOf(tenantQ.tenant.id)).toHaveLength(1);
      expect(couplingsOf(tenantQ.tenant.id)[0].salonId).toBe(c.defaultSalon[tenantQ.tenant.id]);
      expect(couplingsOf(tenantQ.tenant.id)[0].externalBranchId).toBe("branch-Q");

      // T: the earliest salon is inactive — coupling on the active one, as findDefaultSalon says.
      expect(c.defaultSalon[tenantT.tenant.id]).toBe(t1Active);
      expect(couplingsOf(tenantT.tenant.id)).toHaveLength(1);
      expect(couplingsOf(tenantT.tenant.id)[0].salonId).toBe(c.defaultSalon[tenantT.tenant.id]);
      expect(couplingsOf(tenantT.tenant.id)[0].salonId).not.toBe(t0Inactive);

      // R / S / S2: NULL, whitespace, empty — no coupling.
      expect(couplingsOf(tenantR.tenant.id)).toHaveLength(0);
      expect(couplingsOf(tenantS.tenant.id)).toHaveLength(0);
      expect(couplingsOf(tenantS2.tenant.id)).toHaveLength(0);

      // U: already coupled — still exactly its one old coupling.
      expect(couplingsOf(tenantU.tenant.id)).toHaveLength(1);
      expect(couplingsOf(tenantU.tenant.id)[0].externalBranchId).toBe("branch-U-old");

      // Runs: NULL salons end on each tenant's default salon; the pre-set run keeps Q2.
      expect(c.runSalonsAfterFirst[runP]).toBe(c.defaultSalon[tenantP.tenant.id]);
      expect(c.runSalonsAfterFirst[runQ]).toBe(c.defaultSalon[tenantQ.tenant.id]);
      expect(c.runSalonsAfterFirst[runT]).toBe(c.defaultSalon[tenantT.tenant.id]);
      expect(c.runSalonsAfterFirst[runQPreset]).toBe(q2);
      expect(c.nullRunCount).toBe(0);
      expect(c.crossTenantCouplingCount).toBe(0);

      // phorestBranchId is never cleared or rewritten — byte-identical, whitespace included.
      for (const tenantId of fixtureTenantIds) {
        expect(c.branchIdsAfter[tenantId]).toBe(BRANCH_IDS[tenantId]);
      }

      // Idempotency: a second execution changes no coupling and no run salon.
      expect(c.couplingsAfterSecond).toEqual(c.couplingsAfterFirst);
      expect(c.runSalonsAfterSecond).toEqual(c.runSalonsAfterFirst);
    },
  );
});

describe("Phase 65b — Restrict FKs and coupling uniqueness (AC-1/AC-4/AC-5)", () => {
  let app: FastifyInstance;
  let tenantF: Seeded;
  let tenantG: Seeded;

  beforeAll(async () => {
    app = await getTestApp();
    tenantF = await seedTestData(app, "coupling-fk");
    tenantG = await seedTestData(app, "coupling-fk-other");
  });

  afterAll(async () => {
    for (const t of [tenantF, tenantG]) {
      try {
        await cleanupTestData(app, t.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("SalonCoupling_salonId_fkey, SalonCoupling_tenantId_fkey and PhorestSyncRun_salonId_fkey are ON DELETE RESTRICT", async () => {
    const constraints = await app.prisma.$queryRaw<{ conname: string; confdeltype: string }[]>`
      SELECT conname, confdeltype::text AS confdeltype FROM pg_constraint
      WHERE conname IN (
        'SalonCoupling_salonId_fkey', 'SalonCoupling_tenantId_fkey', 'PhorestSyncRun_salonId_fkey'
      )
      ORDER BY conname
    `;
    expect(constraints).toEqual([
      { conname: "PhorestSyncRun_salonId_fkey", confdeltype: "r" },
      { conname: "SalonCoupling_salonId_fkey", confdeltype: "r" },
      { conname: "SalonCoupling_tenantId_fkey", confdeltype: "r" },
    ]);
  });

  it("deleting a salon that has a coupling fails and the salon stays", async () => {
    const salon = await createTestSalon(app.prisma, tenantF.tenant.id, { name: "FK coupling" });
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: tenantF.tenant.id,
        salonId: salon.id,
        provider: "PHOREST",
        externalBranchId: "fk-coupling-branch",
      },
    });

    await expect(app.prisma.salon.delete({ where: { id: salon.id } })).rejects.toMatchObject({
      code: "P2003",
    });
    expect(await app.prisma.salon.findUnique({ where: { id: salon.id } })).not.toBeNull();
  });

  it("deleting a salon that has a PhorestSyncRun fails and the salon stays", async () => {
    const salon = await createTestSalon(app.prisma, tenantF.tenant.id, { name: "FK run" });
    await app.prisma.phorestSyncRun.create({
      data: { tenantId: tenantF.tenant.id, salonId: salon.id, status: "SUCCESS" },
    });

    await expect(app.prisma.salon.delete({ where: { id: salon.id } })).rejects.toMatchObject({
      code: "P2003",
    });
    expect(await app.prisma.salon.findUnique({ where: { id: salon.id } })).not.toBeNull();
  });

  it("a salon holds at most one coupling; a branch id is unique per tenant, not across tenants", async () => {
    const salon = await createTestSalon(app.prisma, tenantF.tenant.id, { name: "Unique A" });
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: tenantF.tenant.id,
        salonId: salon.id,
        provider: "PHOREST",
        externalBranchId: "uniq-branch",
      },
    });

    // Second coupling on the SAME salon (another branch) — salonId is unique.
    await expect(
      app.prisma.salonCoupling.create({
        data: {
          tenantId: tenantF.tenant.id,
          salonId: salon.id,
          provider: "PHOREST",
          externalBranchId: "uniq-branch-other",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    // Another salon of the SAME tenant with the same provider + branch — rejected.
    const sibling = await createTestSalon(app.prisma, tenantF.tenant.id, { name: "Unique B" });
    await expect(
      app.prisma.salonCoupling.create({
        data: {
          tenantId: tenantF.tenant.id,
          salonId: sibling.id,
          provider: "PHOREST",
          externalBranchId: "uniq-branch",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    // The same branch id on a salon of ANOTHER tenant — accepted.
    const accepted = await app.prisma.salonCoupling.create({
      data: {
        tenantId: tenantG.tenant.id,
        salonId: tenantG.salonId,
        provider: "PHOREST",
        externalBranchId: "uniq-branch",
      },
    });
    expect(accepted.externalBranchId).toBe("uniq-branch");
    expect(
      await app.prisma.salonCoupling.count({
        where: {
          externalBranchId: "uniq-branch",
          tenantId: { in: [tenantF.tenant.id, tenantG.tenant.id] },
        },
      }),
    ).toBe(2);
  });
});
