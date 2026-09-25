/**
 * Phase 71b (issue #71) — D-02/D-03, AC-2/AC-3 (Task 3).
 *
 * Executes the REAL migration text (never a restatement of it) — same pattern as
 * `time-entry-salon-migration.test.ts`/`shift-salon-migration.test.ts`: `readDataSection()`
 * resolves the migration file by its exact, hardcoded directory name (never `readdirSync`), and
 * the row-correctness replay runs inside a `$transaction` that always ends by throwing a
 * module-private sentinel error so the fixture never lands in the shared test database —
 * assertions run AFTER the rejection, on values captured outside the callback (an assertion
 * failure inside the callback would be masked by the rollback).
 *
 * The migrated test database already has `Salon.federalState` and `PublicHoliday.salonId` NOT
 * NULL (plan 01 applied this migration via `test:setup`), so the replay first drops NOT NULL on
 * both columns INSIDE the rolled-back transaction (Postgres DDL is transactional) to recreate the
 * legacy, pre-migration shape.
 *
 * Second half of this file (D-03/AC-3): a committed, schema-neutral replay of ONLY the backfill's
 * two `UPDATE` statements proves the backfill moves no saldo, no `SaldoSnapshot` row and no lock
 * flag — deliberately COMMITTED because the rolled-back `DROP NOT NULL` above takes an ACCESS
 * EXCLUSIVE lock that forbids any HTTP read (`app.inject`) while the transaction is open.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { findDefaultSalon } from "../contexts/platform/facade/salons";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root, same resolution as
// time-entry-salon-migration.test.ts / shift-salon-migration.test.ts.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const HOLIDAYS_PER_SALON_MIGRATION_DIR = "20260925123734_holidays_per_salon";
const MIGRATION_PATH = join(
  REPO_ROOT,
  "packages/db/prisma/migrations",
  HOLIDAYS_PER_SALON_MIGRATION_DIR,
  "migration.sql",
);

const DATA_SECTION_BEGIN = "-- 71b-data-migration:begin";
const DATA_SECTION_END = "-- 71b-data-migration:end";

/**
 * Returns the text strictly between the two marker lines. FAILS the calling test (via `expect`,
 * not a thrown error) if either marker is missing, or if the section does not contain both
 * `UPDATE "Salon"` and `UPDATE "PublicHoliday"` statements — a migration file that lost its data
 * section (or half of it) must fail loudly here, not be silently treated as "nothing to run".
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
  expect(section, 'data section does not contain an UPDATE "Salon"').toContain('UPDATE "Salon"');
  expect(section, 'data section does not contain an UPDATE "PublicHoliday"').toContain(
    'UPDATE "PublicHoliday"',
  );
  return section;
}

/**
 * Strips comment-only lines, then splits on a semicolon that ends a line — the statement
 * terminator. Same shape as the sibling migration-replay tests (a single `$executeRawUnsafe` call
 * carrying several statements can be rejected by the driver's extended protocol).
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
  it("contains exactly the three expected statements (INSERT Salon, UPDATE Salon, UPDATE PublicHoliday), no ALTER TABLE", () => {
    const section = readDataSection();
    const statements = splitDataSectionStatements(section);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('INSERT INTO "Salon"');
    expect(statements[1]).toContain('UPDATE "Salon"');
    expect(statements[2]).toContain('UPDATE "PublicHoliday"');
    expect(section, "the data section must not contain an ALTER TABLE").not.toContain(
      "ALTER TABLE",
    );
  });
});

function uniqueSuffix(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

type SalonRow = {
  id: string;
  tenantId: string;
  name: string;
  federalState: string | null;
  isActive: boolean;
  createdAt: Date;
};

type HolidayRow = {
  id: string;
  tenantId: string;
  salonId: string | null;
  date: Date;
  name: string;
  federalState: string;
  year: number;
};

async function selectSalon(tx: Prisma.TransactionClient, id: string): Promise<SalonRow> {
  const rows = await tx.$queryRaw<SalonRow[]>`SELECT * FROM "Salon" WHERE "id" = ${id}`;
  return rows[0];
}

async function selectHoliday(tx: Prisma.TransactionClient, id: string): Promise<HolidayRow> {
  const rows = await tx.$queryRaw<HolidayRow[]>`SELECT * FROM "PublicHoliday" WHERE "id" = ${id}`;
  return rows[0];
}

/**
 * Thrown at the end of the rolled-back transaction below so this fixture (four tenants, several
 * salons and PublicHoliday rows) never actually lands in the shared test database.
 */
class HolidaySalonMigrationReplayRollback extends Error {}

describe("Phase 71b — holiday-salon migration replay (D-02/D-03, AC-2/AC-3)", () => {
  let app: FastifyInstance;
  // withDefaultSalon:false — otherwise the migration's own idempotent "INSERT ... WHERE NOT
  // EXISTS" step would be a silent no-op against an already-salon'd tenant, and P's "gets exactly
  // one new salon" case would prove nothing (mirrors time-entry-salon-migration.test.ts's note).
  let tenantP: Omit<Awaited<ReturnType<typeof seedTestData>>, "salonId"> & {
    salonId: string | null;
  };
  let tenantQ: Omit<Awaited<ReturnType<typeof seedTestData>>, "salonId"> & {
    salonId: string | null;
  };
  let tenantR: Omit<Awaited<ReturnType<typeof seedTestData>>, "salonId"> & {
    salonId: string | null;
  };
  let tenantS: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenantP = await seedTestData(app, "hsm-p", { withDefaultSalon: false });
    tenantQ = await seedTestData(app, "hsm-q", { withDefaultSalon: false });
    tenantR = await seedTestData(app, "hsm-r", { withDefaultSalon: false });
    tenantS = await seedTestData(app, "hsm-s"); // WITH default salon — "already backfilled"

    // Tenant P is BAYERN — Step 1's INSERT must give its new salon federalState BAYERN, not the
    // NI default seedTestData used at tenant-creation time.
    await app.prisma.tenant.update({
      where: { id: tenantP.tenant.id },
      data: { federalState: "BAYERN" },
    });

    // Tenant S's federalState now DIFFERS from its already-backfilled salon's (NIEDERSACHSEN) —
    // the "untouched" case only proves something if the tenant's CURRENT state and the salon's
    // stored state disagree (D-02's guard: WHERE federalState IS NULL, never "differs from
    // tenant"). This also gives mutation proof (b) below something to actually flip.
    await app.prisma.tenant.update({
      where: { id: tenantS.tenant.id },
      data: { federalState: "HAMBURG" },
    });
  });

  afterAll(async () => {
    for (const tenant of [tenantP, tenantQ, tenantR, tenantS]) {
      try {
        await cleanupTestData(app, tenant.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it(
    "replays the migration's data section against legacy-shaped NULL rows (P/Q/R/S), " +
      "pins the default-salon rule against findDefaultSalon (D-04), and is idempotent on a second run",
    async () => {
      const dataSection = readDataSection();
      const statements = splitDataSectionStatements(dataSection);
      expect(statements).toHaveLength(3);

      const s = uniqueSuffix();

      // Q: three salons — inactive earliest, active earliest-ACTIVE (the D-04 default), active
      // later (a distractor whose mere existence pins the tie-break, mirrors
      // time-entry-salon-migration.test.ts's own Q fixture).
      const qSalon0Id = `q0-${s}`;
      const qSalon1Id = `q1-${s}`;
      const qSalon2Id = `q2-${s}`;
      // R: two inactive-only salons — the earliest wins by the migration-only fallback.
      const rSalon0Id = `r0-${s}`;
      const rSalon1Id = `r1-${s}`;

      const qHoliday0Id = `qh0-${s}`;
      const qHoliday1Id = `qh1-${s}`;
      const rHolidayId = `rh0-${s}`;
      let sHolidayId = "";

      type Captured = {
        salonBefore: Record<string, SalonRow>;
        salonAfterFirst: Record<string, SalonRow>;
        salonAfterSecond: Record<string, SalonRow>;
        holidayBefore: Record<string, HolidayRow>;
        holidayAfterFirst: Record<string, HolidayRow>;
        holidayAfterSecond: Record<string, HolidayRow>;
        pSalons: Array<{ id: string; federalState: string; isActive: boolean }>;
        pSalonsAfterSecond: Array<{ id: string }>;
        defaultSalonQId: string | null;
        crossTenantCount: number;
        nullSalonFederalStateCount: number;
        nullHolidaySalonIdCount: number;
      };
      let captured: Captured | undefined;

      await expect(
        app.prisma.$transaction(
          async (tx) => {
            // 1. Recreate the legacy, pre-migration shape — DROP NOT NULL on both columns. DDL is
            //    transactional in Postgres, so this never leaks outside the rollback.
            await tx.$executeRawUnsafe(
              `ALTER TABLE "Salon" ALTER COLUMN "federalState" DROP NOT NULL`,
            );
            await tx.$executeRawUnsafe(
              `ALTER TABLE "PublicHoliday" ALTER COLUMN "salonId" DROP NOT NULL`,
            );

            // 2. Q's three salons — created with a PLACEHOLDER federalState (Prisma's generated
            //    type requires it even after DROP NOT NULL), then nulled by a raw UPDATE (step 5).
            await tx.salon.create({
              data: {
                id: qSalon0Id,
                tenantId: tenantQ.tenant.id,
                name: "Q0 inactive earliest",
                federalState: "NIEDERSACHSEN",
                openingHours: [],
                isActive: false,
                deactivatedAt: new Date("2020-01-01T00:00:00Z"),
                createdAt: new Date("2020-01-01T00:00:00Z"),
              },
            });
            await tx.salon.create({
              data: {
                id: qSalon1Id,
                tenantId: tenantQ.tenant.id,
                name: "Q1 active earliest-active",
                federalState: "NIEDERSACHSEN",
                openingHours: [],
                isActive: true,
                createdAt: new Date("2020-01-02T00:00:00Z"),
              },
            });
            await tx.salon.create({
              data: {
                id: qSalon2Id,
                tenantId: tenantQ.tenant.id,
                name: "Q2 active later",
                federalState: "NIEDERSACHSEN",
                openingHours: [],
                isActive: true,
                createdAt: new Date("2020-01-03T00:00:00Z"),
              },
            });

            // 3. R's two inactive-only salons.
            await tx.salon.create({
              data: {
                id: rSalon0Id,
                tenantId: tenantR.tenant.id,
                name: "R0 inactive earliest",
                federalState: "NIEDERSACHSEN",
                openingHours: [],
                isActive: false,
                deactivatedAt: new Date("2020-01-01T00:00:00Z"),
                createdAt: new Date("2020-01-01T00:00:00Z"),
              },
            });
            await tx.salon.create({
              data: {
                id: rSalon1Id,
                tenantId: tenantR.tenant.id,
                name: "R1 inactive later",
                federalState: "NIEDERSACHSEN",
                openingHours: [],
                isActive: false,
                deactivatedAt: new Date("2020-01-02T00:00:00Z"),
                createdAt: new Date("2020-01-02T00:00:00Z"),
              },
            });

            // 4. PublicHoliday rows — Q gets two, R gets one, both created with a PLACEHOLDER
            //    salonId (an already-real salon of the SAME tenant) then nulled by a raw UPDATE.
            //    S gets one with its REAL, already-correct salonId — never nulled, the
            //    "already backfilled" case.
            await tx.publicHoliday.create({
              data: {
                id: qHoliday0Id,
                tenantId: tenantQ.tenant.id,
                salonId: qSalon2Id,
                date: new Date("2020-05-01"),
                name: "Q Feiertag 1",
                federalState: "NIEDERSACHSEN",
                year: 2020,
              },
            });
            await tx.publicHoliday.create({
              data: {
                id: qHoliday1Id,
                tenantId: tenantQ.tenant.id,
                salonId: qSalon2Id,
                date: new Date("2020-05-02"),
                name: "Q Feiertag 2",
                federalState: "NIEDERSACHSEN",
                year: 2020,
              },
            });
            await tx.publicHoliday.create({
              data: {
                id: rHolidayId,
                tenantId: tenantR.tenant.id,
                salonId: rSalon1Id,
                date: new Date("2020-05-03"),
                name: "R Feiertag",
                federalState: "NIEDERSACHSEN",
                year: 2020,
              },
            });
            const sHoliday = await tx.publicHoliday.create({
              data: {
                tenantId: tenantS.tenant.id,
                salonId: tenantS.salonId,
                date: new Date("2020-05-04"),
                name: "S Feiertag (bereits migriert)",
                federalState: "HAMBURG", // denormalized column — deliberately NOT NI, unrelated to D-02's guard
                year: 2020,
              },
            });
            sHolidayId = sHoliday.id;

            // 5. Null out the columns that must arrive at the backfill with the pre-migration
            //    shape (Q's/R's salons' federalState, Q's/R's holidays' salonId). S is left alone.
            for (const id of [qSalon0Id, qSalon1Id, qSalon2Id, rSalon0Id, rSalon1Id]) {
              await tx.$executeRaw`UPDATE "Salon" SET "federalState" = NULL WHERE "id" = ${id}`;
            }
            for (const id of [qHoliday0Id, qHoliday1Id, rHolidayId]) {
              await tx.$executeRaw`UPDATE "PublicHoliday" SET "salonId" = NULL WHERE "id" = ${id}`;
            }

            // tenantS.salonId is tracked too — the "already backfilled, untouched" case (D-02's
            // guard is `federalState IS NULL`, never "differs from the tenant's CURRENT state";
            // S's tenant was switched to HAMBURG in beforeAll while S's salon stays NIEDERSACHSEN
            // on purpose, see beforeAll's comment).
            const salonIds = [
              qSalon0Id,
              qSalon1Id,
              qSalon2Id,
              rSalon0Id,
              rSalon1Id,
              tenantS.salonId!,
            ];
            const holidayIds = [qHoliday0Id, qHoliday1Id, rHolidayId, sHolidayId];

            const salonBefore = Object.fromEntries(
              await Promise.all(salonIds.map(async (id) => [id, await selectSalon(tx, id)])),
            );
            const holidayBefore = Object.fromEntries(
              await Promise.all(holidayIds.map(async (id) => [id, await selectHoliday(tx, id)])),
            );

            // 6. Execute the REAL data section, statement by statement (extended-protocol
            //    pitfall — a single multi-statement raw call can be rejected by the driver).
            for (const stmt of statements) {
              await tx.$executeRawUnsafe(stmt);
            }

            const salonAfterFirst = Object.fromEntries(
              await Promise.all(salonIds.map(async (id) => [id, await selectSalon(tx, id)])),
            );
            const holidayAfterFirst = Object.fromEntries(
              await Promise.all(holidayIds.map(async (id) => [id, await selectHoliday(tx, id)])),
            );

            // 7. Whole-database invariants (AC-2): zero NULLs left anywhere, no PublicHoliday row
            //    whose salon belongs to a different tenant.
            const [{ count: nullSalonFederalStateCount }] = await tx.$queryRaw<
              { count: number }[]
            >`SELECT count(*)::int AS count FROM "Salon" WHERE "federalState" IS NULL`;
            const [{ count: nullHolidaySalonIdCount }] = await tx.$queryRaw<{ count: number }[]>`
              SELECT count(*)::int AS count FROM "PublicHoliday" WHERE "salonId" IS NULL
            `;
            const [{ count: crossTenantCount }] = await tx.$queryRaw<{ count: number }[]>`
              SELECT count(*)::int AS count FROM "PublicHoliday" ph
              JOIN "Salon" sa ON sa."id" = ph."salonId"
              WHERE sa."tenantId" != ph."tenantId"
            `;

            // 8. D-04 rule pin — findDefaultSalon(tx, ...) vs. the migration's own choice for Q.
            const defaultSalonQ = await findDefaultSalon(tx, tenantQ.tenant.id);

            // 9. P now has exactly one (new) salon, BAYERN, active.
            const pSalons = await tx.salon.findMany({ where: { tenantId: tenantP.tenant.id } });

            // 10. Run the section a SECOND time — idempotency (NOT EXISTS / IS NULL guards).
            for (const stmt of statements) {
              await tx.$executeRawUnsafe(stmt);
            }
            const salonAfterSecond = Object.fromEntries(
              await Promise.all(salonIds.map(async (id) => [id, await selectSalon(tx, id)])),
            );
            const holidayAfterSecond = Object.fromEntries(
              await Promise.all(holidayIds.map(async (id) => [id, await selectHoliday(tx, id)])),
            );
            const pSalonsAfterSecond = await tx.salon.findMany({
              where: { tenantId: tenantP.tenant.id },
            });

            captured = {
              salonBefore,
              salonAfterFirst,
              salonAfterSecond,
              holidayBefore,
              holidayAfterFirst,
              holidayAfterSecond,
              pSalons: pSalons.map((sal) => ({
                id: sal.id,
                federalState: sal.federalState,
                isActive: sal.isActive,
              })),
              pSalonsAfterSecond: pSalonsAfterSecond.map((sal) => ({ id: sal.id })),
              defaultSalonQId: defaultSalonQ?.id ?? null,
              crossTenantCount,
              nullSalonFederalStateCount,
              nullHolidaySalonIdCount,
            };

            throw new HolidaySalonMigrationReplayRollback(
              "deliberate rollback — this fixture must never be committed",
            );
          },
          { timeout: 60000 },
        ),
      ).rejects.toBeInstanceOf(HolidaySalonMigrationReplayRollback);

      expect(captured).toBeDefined();
      const c = captured!;

      // AC-2: no NULLs left anywhere, no cross-tenant salon.
      expect(c.nullSalonFederalStateCount).toBe(0);
      expect(c.nullHolidaySalonIdCount).toBe(0);
      expect(c.crossTenantCount).toBe(0);

      // P: exactly one new salon, BAYERN (the tenant's CURRENT state), active.
      expect(c.pSalons).toHaveLength(1);
      expect(c.pSalons[0].federalState).toBe("BAYERN");
      expect(c.pSalons[0].isActive).toBe(true);

      // Q: all three salons get NIEDERSACHSEN; both holidays get Q1 (earliest ACTIVE), matching
      // findDefaultSalon (D-04) — NOT Q2, the later-created distractor.
      for (const id of [qSalon0Id, qSalon1Id, qSalon2Id]) {
        expect(c.salonAfterFirst[id].federalState).toBe("NIEDERSACHSEN");
      }
      expect(c.holidayAfterFirst[qHoliday0Id].salonId).toBe(qSalon1Id);
      expect(c.holidayAfterFirst[qHoliday1Id].salonId).toBe(qSalon1Id);
      expect(c.defaultSalonQId).toBe(qSalon1Id);

      // R: only inactive salons → the migration-only fallback picks the earliest (R0).
      expect(c.salonAfterFirst[rSalon0Id].federalState).toBe("NIEDERSACHSEN");
      expect(c.salonAfterFirst[rSalon1Id].federalState).toBe("NIEDERSACHSEN");
      expect(c.holidayAfterFirst[rHolidayId].salonId).toBe(rSalon0Id);

      // S: untouched — its holiday's salonId, its salon's federalState (still NIEDERSACHSEN, NOT
      // the tenant's CURRENT HAMBURG) are byte-identical to their pre-replay values (they were
      // never nulled, so "before" IS the already-migrated state). Compares the WHOLE row,
      // including federalState — the field Q/R change and S must not.
      expect(c.holidayAfterFirst[sHolidayId]).toEqual(c.holidayBefore[sHolidayId]);
      expect(c.salonAfterFirst[tenantS.salonId!]).toEqual(c.salonBefore[tenantS.salonId!]);
      expect(c.salonAfterFirst[tenantS.salonId!].federalState).toBe("NIEDERSACHSEN");

      // AC-3: every OTHER column is byte-identical, for every fixture row.
      for (const id of [qSalon0Id, qSalon1Id, qSalon2Id, rSalon0Id, rSalon1Id]) {
        const { federalState: _beforeFs, ...beforeRest } = c.salonBefore[id];
        const { federalState: _afterFs, ...afterRest } = c.salonAfterFirst[id];
        expect(afterRest).toEqual(beforeRest);
      }
      for (const id of [qHoliday0Id, qHoliday1Id, rHolidayId]) {
        const { salonId: _beforeSalonId, ...beforeRest } = c.holidayBefore[id];
        const { salonId: _afterSalonId, ...afterRest } = c.holidayAfterFirst[id];
        expect(afterRest).toEqual(beforeRest);
      }

      // Idempotency: a second run changes no row and adds no salon for P.
      expect(c.salonAfterSecond).toEqual(c.salonAfterFirst);
      expect(c.holidayAfterSecond).toEqual(c.holidayAfterFirst);
      expect(c.pSalonsAfterSecond).toHaveLength(1);
      expect(c.pSalonsAfterSecond[0].id).toBe(c.pSalons[0].id);
    },
  );
});

/**
 * Phase 71b (issue #71), D-03/AC-3 — the backfill's two `UPDATE` statements are proven to move no
 * saldo, no `SaldoSnapshot` row and no lock flag.
 *
 * Deliberately COMMITTED and schema-neutral: the `ALTER TABLE ... DROP NOT NULL` above takes an
 * ACCESS EXCLUSIVE lock that forbids any HTTP read (`app.inject`) while the transaction is open —
 * so the saldo can only be read BEFORE the replay starts and AFTER it has committed. The global
 * Step 1 INSERT is deliberately NOT replayed against committed data (mirrors
 * time-entry-salon-migration.test.ts) — it would create a real, permanent salon for every
 * salonless tenant in the shared test database.
 */
describe("Phase 71b — saldo neutrality of the holiday-salon backfill (D-03, AC-3)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let holidayId: string;

  // A fixed, PAST "now" inside month M (June 2026) — May 2026 (M-1) is closed, June is the still
  // open month. Only PAST instants are used (a fake "now" beyond the access token's expiry would
  // answer 401).
  const PINNED_NOW = new Date("2026-06-16T10:00:00.000Z");

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "hsm-saldo"); // seed.salonId = the tenant's default salon

    // Hire date at the start of month M-1 (May 2026) so close-month's "close sequentially from
    // Jan 1" guard has nothing earlier in the year to demand first.
    await app.prisma.employee.update({
      where: { id: seed.employee.id },
      data: { hireDate: new Date("2026-05-01T00:00:00Z") },
    });

    // A manual holiday in the OPEN month (June), on the salon under test.
    const holiday = await app.prisma.publicHoliday.create({
      data: {
        tenantId: seed.tenant.id,
        salonId: seed.salonId!,
        date: new Date("2026-06-04T00:00:00Z"),
        name: "HSM Test-Feiertag",
        federalState: "NIEDERSACHSEN",
        year: 2026,
      },
    });
    holidayId = holiday.id;

    // Workdays in May 2026 (closed month) and June 2026 (open month, including the holiday date).
    const mayDates = ["2026-05-04", "2026-05-05", "2026-05-06"];
    const juneDates = ["2026-06-01", "2026-06-02", "2026-06-04"];
    for (const d of [...mayDates, ...juneDates]) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: seed.employee.id,
          salonId: seed.salonId!,
          date: new Date(`${d}T00:00:00Z`),
          startTime: new Date(`${d}T07:00:00Z`),
          endTime: new Date(`${d}T15:30:00Z`),
          breakMinutes: 30,
        },
      });
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED_NOW);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${seed.adminToken}` },
        payload: { employeeId: seed.employee.id, year: 2026, month: 5, confirmGaps: true },
      });
      expect(res.statusCode, res.body).toBe(201);
    } finally {
      vi.useRealTimers();
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  async function fetchOvertimeBody(): Promise<unknown> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${seed.employee.id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  }

  async function fetchSnapshots() {
    return app.prisma.saldoSnapshot.findMany({
      where: { employeeId: seed.employee.id },
      orderBy: [{ periodStart: "asc" }, { id: "asc" }],
    });
  }

  async function fetchBalanceHours(): Promise<number> {
    const acc = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: seed.employee.id },
    });
    return Number(acc!.balanceHours);
  }

  async function fetchLockedEntryCount(): Promise<number> {
    return app.prisma.timeEntry.count({
      where: { employeeId: seed.employee.id, isLocked: true },
    });
  }

  it("replaying only the two backfill UPDATEs, committed and schema-neutral, changes no saldo/SaldoSnapshot/lock-flag", async () => {
    const dataSection = readDataSection();
    const statements = splitDataSectionStatements(dataSection);
    // Every statement EXCEPT the Step 1 INSERT — never replayed against committed data (see this
    // describe block's docblock). Running every remaining statement (not just the two named
    // UPDATEs) in order means a mutation that appends a THIRD, unexpected statement to the data
    // section (mutation proof (c)) is executed here too, not silently skipped.
    const nonInsertStatements = statements.filter(
      (s) => !s.trim().startsWith('INSERT INTO "Salon"'),
    );
    expect(nonInsertStatements.length).toBeGreaterThanOrEqual(2);
    expect(nonInsertStatements.some((s) => s.trim().startsWith('UPDATE "Salon"'))).toBe(true);
    expect(nonInsertStatements.some((s) => s.trim().startsWith('UPDATE "PublicHoliday"'))).toBe(
      true,
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED_NOW);
    try {
      // Warm-up GET first, so any self-healing snapshot/account write it performs has already
      // happened before the "before" capture below.
      await fetchOvertimeBody();

      const bodyBefore = await fetchOvertimeBody();
      const snapshotsBefore = await fetchSnapshots();
      const balanceBefore = await fetchBalanceHours();
      const lockedCountBefore = await fetchLockedEntryCount();
      const auditCountBefore = await app.prisma.auditLog.count();

      // NULL the fixture salon's federalState and the fixture holiday's salonId, then replay
      // ONLY the two UPDATE statements — the global Step 1 INSERT is deliberately NOT run against
      // committed data (see this describe block's docblock).
      await app.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `ALTER TABLE "Salon" ALTER COLUMN "federalState" DROP NOT NULL`,
          );
          await tx.$executeRawUnsafe(
            `ALTER TABLE "PublicHoliday" ALTER COLUMN "salonId" DROP NOT NULL`,
          );
          await tx.$executeRaw`UPDATE "Salon" SET "federalState" = NULL WHERE "id" = ${seed.salonId}`;
          await tx.$executeRaw`UPDATE "PublicHoliday" SET "salonId" = NULL WHERE "id" = ${holidayId}`;
          for (const stmt of nonInsertStatements) {
            await tx.$executeRawUnsafe(stmt);
          }
          await tx.$executeRawUnsafe(
            `ALTER TABLE "Salon" ALTER COLUMN "federalState" SET NOT NULL`,
          );
          await tx.$executeRawUnsafe(
            `ALTER TABLE "PublicHoliday" ALTER COLUMN "salonId" SET NOT NULL`,
          );
        },
        { timeout: 30000 },
      );

      const salonCol = await app.prisma.$queryRaw<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'Salon' AND column_name = 'federalState'
      `;
      expect(salonCol[0].is_nullable).toBe("NO");
      const holidayCol = await app.prisma.$queryRaw<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'PublicHoliday' AND column_name = 'salonId'
      `;
      expect(holidayCol[0].is_nullable).toBe("NO");

      const bodyAfter = await fetchOvertimeBody();
      const snapshotsAfter = await fetchSnapshots();
      const balanceAfter = await fetchBalanceHours();
      const lockedCountAfter = await fetchLockedEntryCount();
      const auditCountAfter = await app.prisma.auditLog.count();

      // The backfill really re-assigned the nulled fixture rows back to their own values (the
      // salon is its own tenant's default and only salon; the holiday is on that same salon).
      const salonAfter = await app.prisma.salon.findUniqueOrThrow({
        where: { id: seed.salonId! },
      });
      expect(salonAfter.federalState).toBe("NIEDERSACHSEN");
      const holidayAfter = await app.prisma.publicHoliday.findUniqueOrThrow({
        where: { id: holidayId },
      });
      expect(holidayAfter.salonId).toBe(seed.salonId);

      expect(bodyAfter).toEqual(bodyBefore);
      expect(snapshotsAfter).toEqual(snapshotsBefore);
      expect(snapshotsAfter.length).toBeGreaterThan(0);
      expect(balanceAfter).toBe(balanceBefore);
      expect(lockedCountAfter).toBe(lockedCountBefore);
      expect(auditCountAfter).toBe(auditCountBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});
