/**
 * Phase 68b (issue #68) — D-02/D-03/D-04, AC-1/AC-2/AC-3/AC-5.
 *
 * Executes the REAL migration text (never a restatement of it) — same pattern as
 * `shift-salon-migration.test.ts` (Phase 325): `readDataSection()` resolves the migration file by
 * its exact, hardcoded directory name (never `readdirSync`), and the replay case runs inside a
 * `$transaction` that always ends by throwing a module-private sentinel error so the fixture never
 * lands in the shared test database — assertions run AFTER the rejection, on values captured
 * outside the callback (an assertion failure inside the callback would be masked by the rollback).
 *
 * The migrated test database already has `salonId` NOT NULL (plan 01 applied this migration via
 * `test:setup`), so the replay first drops NOT NULL on the column INSIDE the rolled-back
 * transaction (Postgres DDL is transactional) to recreate the legacy, pre-migration shape. That
 * `ALTER TABLE ... DROP NOT NULL` takes an ACCESS EXCLUSIVE lock on TimeEntry until the transaction
 * ends — while it is open, nothing on another connection may read TimeEntry (in particular no
 * `app.inject`). Plan 03's Task 2 (D-05/AC-4 saldo neutrality + the working-time-account structural
 * guard) extends this same file with two more `describe` blocks that reuse the module-scoped
 * `readDataSection`/`splitDataSectionStatements` helpers below.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS, findDefaultSalon } from "../contexts/platform";
import { invalidReasonFields } from "../contexts/time-tracking/invalid-reason";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root, same resolution as
// t100-09-oracle-probe.test.ts / shift-salon-migration.test.ts.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const TIME_ENTRY_SALON_MIGRATION_DIR = "20260925011324_time_entry_salon";
const MIGRATION_PATH = join(
  REPO_ROOT,
  "packages/db/prisma/migrations",
  TIME_ENTRY_SALON_MIGRATION_DIR,
  "migration.sql",
);

const DATA_SECTION_BEGIN = "-- 68b-data-migration:begin";
const DATA_SECTION_END = "-- 68b-data-migration:end";

/**
 * Returns the text strictly between the two marker lines. FAILS the calling test (via `expect`,
 * not a thrown error) if either marker is missing, if the INSERT/UPDATE statements are not all
 * present, or if an `ALTER TABLE` snuck into the data section (that belongs OUTSIDE the markers,
 * per D-02 — the data section must be replayable on its own against a legacy-shaped table).
 */
export function readDataSection(): string {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const beginIdx = sql.indexOf(DATA_SECTION_BEGIN);
  const endIdx = sql.indexOf(DATA_SECTION_END);
  expect(beginIdx, `migration.sql is missing the "${DATA_SECTION_BEGIN}" marker`).toBeGreaterThan(
    -1,
  );
  expect(endIdx, `migration.sql is missing the "${DATA_SECTION_END}" marker`).toBeGreaterThan(-1);
  const section = sql.slice(beginIdx + DATA_SECTION_BEGIN.length, endIdx);
  expect(section, 'data section does not contain an INSERT INTO "Salon"').toContain(
    'INSERT INTO "Salon"',
  );
  expect(section, 'data section does not contain an UPDATE "TimeEntry"').toContain(
    'UPDATE "TimeEntry"',
  );
  expect(
    section,
    "data section must not contain an ALTER TABLE (D-02: that belongs outside the marker section)",
  ).not.toContain("ALTER TABLE");
  return section;
}

/**
 * Strips comment-only lines, then splits on a semicolon that ends a line — the statement
 * terminator. Executed statement-by-statement below because a single `$executeRawUnsafe` call
 * carrying several statements can be rejected by the driver's extended protocol
 * (68b-03-PLAN.md "Planner-measured facts").
 */
export function splitDataSectionStatements(section: string): string[] {
  const withoutComments = section
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe("data section shape (D-02)", () => {
  it("contains exactly the two expected statements (INSERT Salon, UPDATE TimeEntry), no ALTER TABLE", () => {
    const section = readDataSection();
    const statements = splitDataSectionStatements(section);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('INSERT INTO "Salon"');
    expect(statements[1]).toContain('UPDATE "TimeEntry"');
  });
});

type TimeEntryRow = {
  id: string;
  employeeId: string;
  date: Date;
  startTime: Date;
  endTime: Date | null;
  breakMinutes: number;
  type: string;
  source: string;
  note: string | null;
  isLocked: boolean;
  lockedAt: Date | null;
  isInvalid: boolean;
  invalidReason: string | null;
  invalidReasonCode: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  breakStatus: string;
  breakWaivedReason: string | null;
  retroRequestId: string | null;
  salonId: string | null;
};

async function selectTimeEntry(tx: Prisma.TransactionClient, id: string): Promise<TimeEntryRow> {
  const rows = await tx.$queryRaw<TimeEntryRow[]>`SELECT * FROM "TimeEntry" WHERE "id" = ${id}`;
  return rows[0];
}

function uniqueSuffix(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Thrown at the end of the rolled-back transaction below so this fixture (four tenants, six
 * salons, 21 TimeEntry rows, four RetroEntryRequest rows) never actually lands in the shared test
 * database.
 */
class TimeEntrySalonMigrationReplayRollback extends Error {}

describe("Phase 68b — time-entry-salon migration replay (D-03/D-04, AC-2/AC-3)", () => {
  let app: FastifyInstance;
  // A fifth, HELPER tenant whose only job is to hold a temporary, real salon id — Prisma's
  // generated TimeEntry.create() type requires `salonId` even after the in-transaction
  // `DROP NOT NULL` (the client validates its own required fields), so every fixture row that
  // must end up NULL is first created with this helper's salon, then nulled by a raw UPDATE.
  // The helper salon must NOT belong to P/Q/R/S — a temporary salon on P would make the data
  // section's `INSERT ... WHERE NOT EXISTS` a silent no-op for P (68b-03-PLAN.md context).
  let helper: Awaited<ReturnType<typeof seedTestData>>;
  // withDefaultSalon:false — otherwise the migration's own idempotent INSERT would be a silent
  // no-op against an already-salon'd tenant, and P's "gets exactly one new salon" case would prove
  // nothing (mirrors shift-salon-migration.test.ts's own note).
  let tenantP: Omit<Awaited<ReturnType<typeof seedTestData>>, "salonId"> & {
    salonId: string | null;
  };
  let tenantQ: Omit<Awaited<ReturnType<typeof seedTestData>>, "salonId"> & {
    salonId: string | null;
  };
  let tenantR: Omit<Awaited<ReturnType<typeof seedTestData>>, "salonId"> & {
    salonId: string | null;
  };
  let tenantS: Omit<Awaited<ReturnType<typeof seedTestData>>, "salonId"> & {
    salonId: string | null;
  };

  beforeAll(async () => {
    app = await getTestApp();
    helper = await seedTestData(app, "temig-helper");
    tenantP = await seedTestData(app, "temig-p", { withDefaultSalon: false });
    tenantQ = await seedTestData(app, "temig-q", { withDefaultSalon: false });
    tenantR = await seedTestData(app, "temig-r", { withDefaultSalon: false });
    tenantS = await seedTestData(app, "temig-s", { withDefaultSalon: false });
  });

  afterAll(async () => {
    for (const tenant of [helper, tenantP, tenantQ, tenantR, tenantS]) {
      try {
        await cleanupTestData(app, tenant.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it(
    "replays the migration's data section against legacy-shaped NULL-salon rows (P/Q/R/S), " +
      "pins the default-salon rule against findDefaultSalon (D-04), and is idempotent on a second run",
    async () => {
      const dataSection = readDataSection();
      const statements = splitDataSectionStatements(dataSection);
      expect(statements).toHaveLength(2);

      const s = uniqueSuffix();

      // Salon ids for Q, R, S — explicit so the S tie-break ("lower id wins") is deterministic:
      // "sa-..." sorts lexicographically before "sb-...". P deliberately gets no salon at all.
      const qSalon0Id = `q0-${s}`; // inactive, earliest
      const qSalon1Id = `q1-${s}`; // active, earliest ACTIVE — the D-04 default
      const qSalon2Id = `q2-${s}`; // active, created later
      const rSalon0Id = `r0-${s}`; // the tenant's only salon, inactive
      const sSalonAId = `sa-${s}`; // tie on createdAt, lower id — wins by D-04's id ASC tie-break
      const sSalonBId = `sb-${s}`; // tie on createdAt, higher id

      // Five NULL-salon flavors per tenant (locked, soft-deleted, retro-pending, invalid, plain),
      // plus one extra Q row that ALREADY carries a salon (must stay untouched — only NULLs fill).
      function flavorIds(tenantKey: string) {
        return {
          locked: `${tenantKey}-locked-${s}`,
          deleted: `${tenantKey}-deleted-${s}`,
          retro: `${tenantKey}-retro-${s}`,
          invalid: `${tenantKey}-invalid-${s}`,
          plain: `${tenantKey}-plain-${s}`,
        };
      }
      const pIds = flavorIds("p");
      const qIds = flavorIds("q");
      const rIds = flavorIds("r");
      const sIds = flavorIds("s");
      const qAlreadySalonId = `q-already-${s}`;

      const nullIds = [
        ...Object.values(pIds),
        ...Object.values(qIds),
        ...Object.values(rIds),
        ...Object.values(sIds),
      ];
      const allIds = [...nullIds, qAlreadySalonId];

      type Snapshot = TimeEntryRow[];
      type Captured = {
        before: Snapshot;
        afterFirst: Snapshot;
        afterSecond: Snapshot;
        nullCount: number;
        crossTenantCount: number;
        auditCountBefore: number;
        auditCountAfter: number;
        defaultSalonQId: string | null;
        defaultSalonRId: string | null;
        defaultSalonSId: string | null;
        pSalons: Array<{ id: string; name: string; isActive: boolean }>;
        pSalonsAfterSecond: Array<{ id: string }>;
      };
      let captured: Captured | undefined;

      await expect(
        app.prisma.$transaction(
          async (tx) => {
            // 1. Recreate the legacy, pre-migration shape — drop NOT NULL. DDL is transactional
            //    in Postgres, so this never leaks outside the rollback.
            await tx.$executeRawUnsafe(
              `ALTER TABLE "TimeEntry" ALTER COLUMN "salonId" DROP NOT NULL`,
            );

            // 2. Salons for Q, R, S — P deliberately gets none (the INSERT step must create P's).
            await tx.salon.create({
              data: {
                id: qSalon0Id,
                tenantId: tenantQ.tenant.id,
                name: "Q0 inactive earliest",
                openingHours: DEFAULT_SALON_OPENING_HOURS as unknown as Prisma.InputJsonValue,
                isActive: false,
                deactivatedAt: new Date("2020-01-01T00:00:00Z"),
                createdAt: new Date("2020-01-01T00:00:00Z"),
              },
            });
            await tx.salon.create({
              data: {
                id: qSalon1Id,
                tenantId: tenantQ.tenant.id,
                name: "Q1 active early",
                openingHours: DEFAULT_SALON_OPENING_HOURS as unknown as Prisma.InputJsonValue,
                isActive: true,
                createdAt: new Date("2020-01-02T00:00:00Z"),
              },
            });
            await tx.salon.create({
              data: {
                id: qSalon2Id,
                tenantId: tenantQ.tenant.id,
                name: "Q2 active late",
                openingHours: DEFAULT_SALON_OPENING_HOURS as unknown as Prisma.InputJsonValue,
                isActive: true,
                createdAt: new Date("2020-01-03T00:00:00Z"),
              },
            });
            await tx.salon.create({
              data: {
                id: rSalon0Id,
                tenantId: tenantR.tenant.id,
                name: "R0 inactive (only salon)",
                openingHours: DEFAULT_SALON_OPENING_HOURS as unknown as Prisma.InputJsonValue,
                isActive: false,
                deactivatedAt: new Date("2020-01-01T00:00:00Z"),
                createdAt: new Date("2020-01-01T00:00:00Z"),
              },
            });
            await tx.salon.create({
              data: {
                id: sSalonAId,
                tenantId: tenantS.tenant.id,
                name: "S tie A (lower id)",
                openingHours: DEFAULT_SALON_OPENING_HOURS as unknown as Prisma.InputJsonValue,
                isActive: true,
                createdAt: new Date("2020-06-01T00:00:00Z"),
              },
            });
            await tx.salon.create({
              data: {
                id: sSalonBId,
                tenantId: tenantS.tenant.id,
                name: "S tie B (higher id)",
                openingHours: DEFAULT_SALON_OPENING_HOURS as unknown as Prisma.InputJsonValue,
                isActive: true,
                createdAt: new Date("2020-06-01T00:00:00Z"),
              },
            });

            // 3. One PENDING RetroEntryRequest per tenant, for that tenant's retro-pending row.
            const retroReqs: Record<string, string> = {};
            for (const [key, tenant, day] of [
              ["p", tenantP, "2020-04-03"],
              ["q", tenantQ, "2020-04-03"],
              ["r", tenantR, "2020-04-03"],
              ["s", tenantS, "2020-04-03"],
            ] as const) {
              const retro = await tx.retroEntryRequest.create({
                data: {
                  employeeId: tenant.employee.id,
                  targetDate: new Date(day),
                  reason: "68b-03 fixture retro-pending",
                  status: "PENDING",
                },
              });
              retroReqs[key] = retro.id;
            }

            // 4. Legacy-shaped fixture rows — created WITH the helper's temporary salon (Prisma's
            //    generated type requires salonId even after DROP NOT NULL), nulled in step 5.
            async function makeFlavorRows(
              tenantKey: string,
              tenant: { employee: { id: string }; adminUser: { id: string } },
              ids: ReturnType<typeof flavorIds>,
              retroRequestId: string,
            ) {
              await tx.timeEntry.create({
                data: {
                  id: ids.locked,
                  employeeId: tenant.employee.id,
                  salonId: helper.salonId,
                  date: new Date("2020-04-01"),
                  startTime: new Date("2020-04-01T08:00:00Z"),
                  endTime: new Date("2020-04-01T16:00:00Z"),
                  isLocked: true,
                  lockedAt: new Date("2020-05-01T00:00:00Z"),
                  updatedAt: new Date("2020-05-02T00:00:00Z"),
                  note: `${tenantKey} locked fixture`,
                  createdBy: tenant.adminUser.id,
                },
              });
              await tx.timeEntry.create({
                data: {
                  id: ids.deleted,
                  employeeId: tenant.employee.id,
                  salonId: helper.salonId,
                  date: new Date("2020-04-02"),
                  startTime: new Date("2020-04-02T08:00:00Z"),
                  endTime: new Date("2020-04-02T16:00:00Z"),
                  deletedAt: new Date("2020-05-03T00:00:00Z"),
                  updatedAt: new Date("2020-05-04T00:00:00Z"),
                  note: `${tenantKey} soft-deleted fixture`,
                  createdBy: tenant.adminUser.id,
                },
              });
              await tx.timeEntry.create({
                data: {
                  id: ids.retro,
                  employeeId: tenant.employee.id,
                  salonId: helper.salonId,
                  date: new Date("2020-04-03"),
                  startTime: new Date("2020-04-03T08:00:00Z"),
                  endTime: new Date("2020-04-03T16:00:00Z"),
                  retroRequestId,
                  updatedAt: new Date("2020-05-05T00:00:00Z"),
                  note: `${tenantKey} retro-pending fixture`,
                  createdBy: tenant.adminUser.id,
                  ...invalidReasonFields("RETRO_APPROVAL_PENDING"),
                  isInvalid: true,
                },
              });
              await tx.timeEntry.create({
                data: {
                  id: ids.invalid,
                  employeeId: tenant.employee.id,
                  salonId: helper.salonId,
                  date: new Date("2020-04-04"),
                  startTime: new Date("2020-04-04T08:00:00Z"),
                  endTime: null,
                  updatedAt: new Date("2020-05-06T00:00:00Z"),
                  note: `${tenantKey} invalid fixture`,
                  createdBy: tenant.adminUser.id,
                  ...invalidReasonFields("MISSING_CLOCK_OUT"),
                  isInvalid: true,
                },
              });
              await tx.timeEntry.create({
                data: {
                  id: ids.plain,
                  employeeId: tenant.employee.id,
                  salonId: helper.salonId,
                  date: new Date("2020-04-05"),
                  startTime: new Date("2020-04-05T08:00:00Z"),
                  endTime: new Date("2020-04-05T16:00:00Z"),
                  updatedAt: new Date("2020-05-07T00:00:00Z"),
                  note: `${tenantKey} plain fixture`,
                  createdBy: tenant.adminUser.id,
                },
              });
            }

            await makeFlavorRows("p", tenantP, pIds, retroReqs.p);
            await makeFlavorRows("q", tenantQ, qIds, retroReqs.q);
            await makeFlavorRows("r", tenantR, rIds, retroReqs.r);
            await makeFlavorRows("s", tenantS, sIds, retroReqs.s);

            // The Q row that already carries a REAL salon (Q2) BEFORE the backfill runs — the
            // backfill's `WHERE "salonId" IS NULL` guard must leave it exactly as-is.
            await tx.timeEntry.create({
              data: {
                id: qAlreadySalonId,
                employeeId: tenantQ.employee.id,
                salonId: qSalon2Id,
                date: new Date("2020-04-06"),
                startTime: new Date("2020-04-06T08:00:00Z"),
                endTime: new Date("2020-04-06T16:00:00Z"),
                updatedAt: new Date("2020-05-08T00:00:00Z"),
                note: "q already-salon2 fixture",
                createdBy: tenantQ.adminUser.id,
              },
            });

            // 5. Null out only the rows that must arrive at the backfill with salonId IS NULL.
            for (const id of nullIds) {
              await tx.$executeRaw`UPDATE "TimeEntry" SET "salonId" = NULL WHERE "id" = ${id}`;
            }

            const before: Snapshot = await Promise.all(allIds.map((id) => selectTimeEntry(tx, id)));
            const [{ count: auditCountBefore }] = await tx.$queryRaw<{ count: number }[]>`
              SELECT count(*)::int AS count FROM "AuditLog"
            `;

            // 6. Execute the REAL data section, statement by statement (extended-protocol pitfall
            //    — a single multi-statement raw call can be rejected by the driver).
            for (const stmt of statements) {
              await tx.$executeRawUnsafe(stmt);
            }

            const afterFirst: Snapshot = await Promise.all(
              allIds.map((id) => selectTimeEntry(tx, id)),
            );
            const [{ count: auditCountAfter }] = await tx.$queryRaw<{ count: number }[]>`
              SELECT count(*)::int AS count FROM "AuditLog"
            `;

            // 7. Whole-database invariants (AC-2): zero NULLs left anywhere, no row whose salon
            //    belongs to a different tenant than its own employee.
            const [{ count: nullCount }] = await tx.$queryRaw<{ count: number }[]>`
              SELECT count(*)::int AS count FROM "TimeEntry" WHERE "salonId" IS NULL
            `;
            const [{ count: crossTenantCount }] = await tx.$queryRaw<{ count: number }[]>`
              SELECT count(*)::int AS count FROM "TimeEntry" te
              JOIN "Employee" e ON e."id" = te."employeeId"
              JOIN "Salon" sa ON sa."id" = te."salonId"
              WHERE sa."tenantId" != e."tenantId"
            `;

            // 8. D-04 rule pin — findDefaultSalon(tx, ...) vs. the migration's own choice.
            const defaultSalonQ = await findDefaultSalon(tx, tenantQ.tenant.id);
            const defaultSalonR = await findDefaultSalon(tx, tenantR.tenant.id);
            const defaultSalonS = await findDefaultSalon(tx, tenantS.tenant.id);

            // 9. P now has exactly one (new) salon.
            const pSalons = await tx.salon.findMany({ where: { tenantId: tenantP.tenant.id } });

            // 10. Run the section a SECOND time — idempotency (NOT EXISTS / salonId IS NULL guards).
            for (const stmt of statements) {
              await tx.$executeRawUnsafe(stmt);
            }
            const afterSecond: Snapshot = await Promise.all(
              allIds.map((id) => selectTimeEntry(tx, id)),
            );
            const pSalonsAfterSecond = await tx.salon.findMany({
              where: { tenantId: tenantP.tenant.id },
            });

            captured = {
              before,
              afterFirst,
              afterSecond,
              nullCount,
              crossTenantCount,
              auditCountBefore,
              auditCountAfter,
              defaultSalonQId: defaultSalonQ?.id ?? null,
              defaultSalonRId: defaultSalonR?.id ?? null,
              defaultSalonSId: defaultSalonS?.id ?? null,
              pSalons: pSalons.map((sal) => ({
                id: sal.id,
                name: sal.name,
                isActive: sal.isActive,
              })),
              pSalonsAfterSecond: pSalonsAfterSecond.map((sal) => ({ id: sal.id })),
            };

            throw new TimeEntrySalonMigrationReplayRollback(
              "deliberate rollback — this fixture must never be committed",
            );
          },
          { timeout: 60000 },
        ),
      ).rejects.toBeInstanceOf(TimeEntrySalonMigrationReplayRollback);

      expect(captured).toBeDefined();
      const c = captured!;

      // AC-2: no NULLs left anywhere, no cross-tenant salon.
      expect(c.nullCount).toBe(0);
      expect(c.crossTenantCount).toBe(0);

      // AuditLog: the backfill writes no per-row audit (D-03).
      expect(c.auditCountAfter).toBe(c.auditCountBefore);

      // P: exactly one new salon, named after the tenant, active; its rows point to it.
      expect(c.pSalons).toHaveLength(1);
      expect(c.pSalons[0].name).toBe(tenantP.tenant.name);
      expect(c.pSalons[0].isActive).toBe(true);
      for (const id of Object.values(pIds)) {
        const row = c.afterFirst.find((r) => r.id === id)!;
        expect(row.salonId).toBe(c.pSalons[0].id);
      }

      // Q: NULL-salon rows point to Q1 (earliest ACTIVE); the already-Q2 row is untouched.
      for (const id of Object.values(qIds)) {
        const row = c.afterFirst.find((r) => r.id === id)!;
        expect(row.salonId).toBe(qSalon1Id);
      }
      const qAlreadyAfter = c.afterFirst.find((r) => r.id === qAlreadySalonId)!;
      expect(qAlreadyAfter.salonId).toBe(qSalon2Id); // backfill only fills NULLs

      // R: only an inactive salon → migration-only fallback to it; findDefaultSalon(R) is null.
      for (const id of Object.values(rIds)) {
        const row = c.afterFirst.find((r) => r.id === id)!;
        expect(row.salonId).toBe(rSalon0Id);
      }
      expect(c.defaultSalonRId).toBeNull();

      // S: tie on createdAt → lower id wins, for BOTH the migration SQL and findDefaultSalon (D-04).
      for (const id of Object.values(sIds)) {
        const row = c.afterFirst.find((r) => r.id === id)!;
        expect(row.salonId).toBe(sSalonAId);
      }
      expect(c.defaultSalonSId).toBe(sSalonAId);

      // D-04: the runtime resolver agrees with the migration's own choice for Q too.
      expect(c.defaultSalonQId).toBe(qSalon1Id);

      // AC-3: every OTHER column is byte-identical, for every fixture row — updatedAt, isLocked
      // and lockedAt explicitly (D-03/D-04 in the plan's own wording).
      for (const id of allIds) {
        const beforeRow = c.before.find((r) => r.id === id)!;
        const afterRow = c.afterFirst.find((r) => r.id === id)!;
        const { salonId: _beforeSalonId, ...beforeRest } = beforeRow;
        const { salonId: _afterSalonId, ...afterRest } = afterRow;
        expect(afterRest).toEqual(beforeRest);
        expect(afterRow.updatedAt).toEqual(beforeRow.updatedAt);
        expect(afterRow.isLocked).toEqual(beforeRow.isLocked);
        expect(afterRow.lockedAt).toEqual(beforeRow.lockedAt);
      }

      // Idempotency: a second run changes no row and adds no salon.
      expect(c.afterSecond).toEqual(c.afterFirst);
      expect(c.pSalonsAfterSecond).toHaveLength(1);
      expect(c.pSalonsAfterSecond[0].id).toBe(c.pSalons[0].id);
    },
  );
});

describe("Phase 68b — Restrict FK proof (AC-1/AC-5)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let entryId: string;

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "temig-fk");
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        salonId: seed.salonId,
        date: new Date(),
        startTime: new Date(),
      },
    });
    entryId = entry.id;
  });

  afterAll(async () => {
    try {
      await app.prisma.timeEntry.delete({ where: { id: entryId } });
    } catch (err) {
      console.error("Test cleanup failed (entry):", err);
    }
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("TimeEntry_salonId_fkey is ON DELETE RESTRICT; deleting a salon that carries an entry fails and the salon stays", async () => {
    const constraints = await app.prisma.$queryRaw<{ conname: string; confdeltype: string }[]>`
      SELECT conname, confdeltype::text AS confdeltype FROM pg_constraint
      WHERE conname = 'TimeEntry_salonId_fkey'
    `;
    expect(constraints).toHaveLength(1);
    expect(constraints[0].confdeltype).toBe("r");

    await expect(app.prisma.salon.delete({ where: { id: seed.salonId } })).rejects.toMatchObject({
      code: "P2003",
    });
    const stillThere = await app.prisma.salon.findUnique({ where: { id: seed.salonId } });
    expect(stillThere).not.toBeNull();
  });
});

describe("Phase 68b — partial unique index untouched (AC-5)", () => {
  it("TimeEntry_employeeId_date_unique_not_deleted is still a UNIQUE index with WHERE (deletedAt IS NULL); TimeEntry_salonId_idx exists", async () => {
    const app = await getTestApp();
    const indexes = await app.prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'TimeEntry'
        AND indexname IN ('TimeEntry_employeeId_date_unique_not_deleted', 'TimeEntry_salonId_idx')
      ORDER BY indexname
    `;
    expect(indexes).toHaveLength(2);
    const uniqueIdx = indexes.find(
      (i) => i.indexname === "TimeEntry_employeeId_date_unique_not_deleted",
    )!;
    expect(uniqueIdx.indexdef).toContain("UNIQUE INDEX");
    expect(uniqueIdx.indexdef).toContain('WHERE ("deletedAt" IS NULL)');
    const salonIdx = indexes.find((i) => i.indexname === "TimeEntry_salonId_idx")!;
    expect(salonIdx.indexdef).toContain('"salonId"');
  });
});
