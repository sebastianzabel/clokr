/**
 * Phase 325 (issue #325) — D-02/D-03/D-04, AC-2/AC-3/AC-8.
 *
 * Executes the REAL migration text (never a restatement of it) — same pattern as
 * `salon-migration.test.ts` (Phase 64b): `readDataSection()` resolves the migration file by its
 * exact, hardcoded directory name (never `readdirSync`), and the replay case runs inside a
 * `$transaction` that always ends by throwing a module-private sentinel error so the fixture never
 * lands in the shared test database — assertions run AFTER the rejection, on values captured
 * outside the callback (an assertion failure inside the callback would be masked by the rollback).
 *
 * The migrated test database already has `salonId` NOT NULL (Plan 01 applied this migration via
 * `test:setup`), so the replay first drops NOT NULL on both columns INSIDE the rolled-back
 * transaction (Postgres DDL is transactional) to recreate the legacy, pre-migration shape.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { getTestApp, seedTestData, cleanupTestData, withPre71bSalonSchema } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS, findDefaultSalon } from "../contexts/platform/facade/salons";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root, same resolution as
// t100-09-oracle-probe.test.ts / salon-migration.test.ts.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SHIFT_SALON_MIGRATION_DIR = "20260924145508_shift_salon";
const MIGRATION_PATH = join(
  REPO_ROOT,
  "packages/db/prisma/migrations",
  SHIFT_SALON_MIGRATION_DIR,
  "migration.sql",
);

const DATA_SECTION_BEGIN = "-- 325-data-migration:begin";
const DATA_SECTION_END = "-- 325-data-migration:end";

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
  expect(section, 'data section does not contain an UPDATE "Shift"').toContain('UPDATE "Shift"');
  expect(section, 'data section does not contain an UPDATE "PhorestAppointment"').toContain(
    'UPDATE "PhorestAppointment"',
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
 * carrying several statements can be rejected by the driver's extended protocol (325-CONTEXT.md
 * Planner-measured facts).
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

type ShiftRow = {
  id: string;
  employeeId: string;
  templateId: string | null;
  salonId: string | null;
  date: Date;
  startTime: string;
  endTime: string;
  label: string | null;
  note: string | null;
  conflictsWithLeave: boolean;
  origin: string;
  externalId: string | null;
  createdAt: Date;
  createdBy: string | null;
  deletedAt: Date | null;
  deletedReason: string | null;
};

type AppointmentRow = {
  id: string;
  employeeId: string;
  salonId: string | null;
  date: Date;
  startTime: string;
  endTime: string;
  externalId: string | null;
  createdAt: Date;
};

async function selectShift(tx: Prisma.TransactionClient, id: string): Promise<ShiftRow> {
  const rows = await tx.$queryRaw<ShiftRow[]>`SELECT * FROM "Shift" WHERE "id" = ${id}`;
  return rows[0];
}

async function selectAppointment(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<AppointmentRow> {
  const rows = await tx.$queryRaw<AppointmentRow[]>`
    SELECT * FROM "PhorestAppointment" WHERE "id" = ${id}
  `;
  return rows[0];
}

/** Insert a legacy-shaped (possibly NULL-salon) Shift row via raw SQL — Prisma Client's generated
 * types treat `salonId` as required, so a NULL value cannot be expressed through `tx.shift.create`. */
async function insertShift(
  tx: Prisma.TransactionClient,
  data: {
    id: string;
    employeeId: string;
    salonId: string | null;
    date: Date;
    startTime: string;
    endTime: string;
    label?: string | null;
    note?: string | null;
    conflictsWithLeave?: boolean;
    origin?: "MANUAL" | "PHOREST";
    externalId?: string | null;
    createdAt?: Date;
    createdBy?: string | null;
    deletedAt?: Date | null;
    deletedReason?: string | null;
  },
): Promise<void> {
  const origin = data.origin ?? "MANUAL";
  await tx.$executeRaw`
    INSERT INTO "Shift"
      ("id", "employeeId", "templateId", "salonId", "date", "startTime", "endTime", "label",
       "note", "conflictsWithLeave", "origin", "externalId", "createdAt", "createdBy",
       "deletedAt", "deletedReason")
    VALUES
      (${data.id}, ${data.employeeId}, NULL, ${data.salonId}, ${data.date}, ${data.startTime},
       ${data.endTime}, ${data.label ?? null}, ${data.note ?? null},
       ${data.conflictsWithLeave ?? false}, ${origin}::"ShiftOrigin", ${data.externalId ?? null},
       ${data.createdAt ?? new Date()}, ${data.createdBy ?? null}, ${data.deletedAt ?? null},
       ${data.deletedReason ?? null})
  `;
}

/** Insert a legacy-shaped (possibly NULL-salon) PhorestAppointment row via raw SQL — same reason
 * as {@link insertShift}. */
async function insertAppointment(
  tx: Prisma.TransactionClient,
  data: {
    id: string;
    employeeId: string;
    salonId: string | null;
    date: Date;
    startTime: string;
    endTime: string;
    externalId?: string | null;
    createdAt?: Date;
  },
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "PhorestAppointment"
      ("id", "employeeId", "salonId", "date", "startTime", "endTime", "externalId", "createdAt")
    VALUES
      (${data.id}, ${data.employeeId}, ${data.salonId}, ${data.date}, ${data.startTime},
       ${data.endTime}, ${data.externalId ?? null}, ${data.createdAt ?? new Date()})
  `;
}

describe("data section shape (D-02)", () => {
  it("contains exactly the three expected statements (INSERT Salon, UPDATE Shift, UPDATE PhorestAppointment), no ALTER TABLE", () => {
    const section = readDataSection();
    const statements = splitDataSectionStatements(section);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('INSERT INTO "Salon"');
    expect(statements[1]).toContain('UPDATE "Shift"');
    expect(statements[2]).toContain('UPDATE "PhorestAppointment"');
  });
});

/**
 * Thrown at the end of the rolled-back transaction below so this fixture (four tenants, six
 * salons, five shifts, four appointments) never actually lands in the shared test database.
 */
class ShiftSalonMigrationReplayRollback extends Error {}

describe("Phase 325 — shift-salon migration replay (D-03/D-04/AC-2/AC-8)", () => {
  let app: FastifyInstance;
  // withDefaultSalon:false — otherwise the migration's own idempotent INSERT would be a silent
  // no-op against an already-salon'd tenant, and P's "gets exactly one new salon" case would prove
  // nothing (325-RESEARCH.md Pitfall 2, mirrored from salon-migration.test.ts).
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
    tenantP = await seedTestData(app, "shift-mig-p", { withDefaultSalon: false });
    tenantQ = await seedTestData(app, "shift-mig-q", { withDefaultSalon: false });
    tenantR = await seedTestData(app, "shift-mig-r", { withDefaultSalon: false });
    tenantS = await seedTestData(app, "shift-mig-s", { withDefaultSalon: false });
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
    "replays the migration's data section against legacy-shaped NULL-salon rows (P/Q/R/S), " +
      "pins the default-salon rule against findDefaultSalon (D-04), and is idempotent on a second run",
    async () => {
      const dataSection = readDataSection();
      const statements = splitDataSectionStatements(dataSection);
      expect(statements).toHaveLength(3);

      const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

      // Fixture ids, fixed outside the transaction so both the callback and the post-rollback
      // assertions can reference them.
      const qSalon0Id = `q0-${s}`; // inactive, earliest
      const qSalon1Id = `q1-${s}`; // active, earliest ACTIVE — the D-04 default
      const qSalon2Id = `q2-${s}`; // active, created later
      const rSalon0Id = `r0-${s}`; // the tenant's only salon, inactive
      const sSalonAId = `sa-${s}`; // tie on createdAt, lower id — wins by D-04's id ASC tie-break
      const sSalonBId = `sb-${s}`; // tie on createdAt, higher id

      const pShiftId = `p-shift-${s}`;
      const pApptId = `p-appt-${s}`;
      const qShiftId = `q-shift-${s}`; // soft-deleted
      const qShiftAlreadySalonedId = `q-shift-salon2-${s}`; // already carries Q2 — must stay Q2
      const qApptId = `q-appt-${s}`;
      const rShiftId = `r-shift-${s}`; // PHOREST-origin with externalId
      const rApptId = `r-appt-${s}`;
      const sShiftId = `s-shift-${s}`; // conflictsWithLeave + note/label/createdBy
      const sApptId = `s-appt-${s}`;

      const allShiftIds = [pShiftId, qShiftId, qShiftAlreadySalonedId, rShiftId, sShiftId];
      const allApptIds = [pApptId, qApptId, rApptId, sApptId];

      type Snapshot = { shifts: ShiftRow[]; appts: AppointmentRow[] };
      type Captured = {
        before: Snapshot;
        afterFirst: Snapshot;
        afterSecond: Snapshot;
        nullShiftCount: number;
        nullApptCount: number;
        crossTenantShiftCount: number;
        crossTenantApptCount: number;
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
            // 1. Recreate the legacy, pre-migration shape — drop NOT NULL on both columns. DDL is
            //    transactional in Postgres, so this never leaks outside the rollback.
            await tx.$executeRawUnsafe(`ALTER TABLE "Shift" ALTER COLUMN "salonId" DROP NOT NULL`);
            await tx.$executeRawUnsafe(
              `ALTER TABLE "PhorestAppointment" ALTER COLUMN "salonId" DROP NOT NULL`,
            );

            // 2. Salons for Q, R, S — P deliberately gets none (the INSERT step must create P's).
            await tx.salon.create({
              data: {
                id: qSalon0Id,
                tenantId: tenantQ.tenant.id,
                federalState: "NIEDERSACHSEN",
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
                federalState: "NIEDERSACHSEN",
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
                federalState: "NIEDERSACHSEN",
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
                federalState: "NIEDERSACHSEN",
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
                federalState: "NIEDERSACHSEN",
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
                federalState: "NIEDERSACHSEN",
                name: "S tie B (higher id)",
                openingHours: DEFAULT_SALON_OPENING_HOURS as unknown as Prisma.InputJsonValue,
                isActive: true,
                createdAt: new Date("2020-06-01T00:00:00Z"),
              },
            });

            // 3. Legacy-shaped fixture rows — NULL salonId, one of each required flavor.
            await insertShift(tx, {
              id: pShiftId,
              employeeId: tenantP.employee.id,
              salonId: null,
              date: new Date("2020-03-01"), // past-dated (SHIFT_PAST_IMMUTABLE)
              startTime: "08:00",
              endTime: "16:00",
              label: "Alt-Schicht",
            });
            await insertAppointment(tx, {
              id: pApptId,
              employeeId: tenantP.employee.id,
              salonId: null,
              date: new Date("2020-03-01"),
              startTime: "09:00",
              endTime: "10:00",
            });

            await insertShift(tx, {
              id: qShiftId,
              employeeId: tenantQ.employee.id,
              salonId: null,
              date: new Date("2020-03-02"),
              startTime: "08:00",
              endTime: "16:00",
              deletedAt: new Date("2020-04-01T00:00:00Z"), // soft-deleted
              deletedReason: "AUTO_BS_DAY_CLEANUP",
            });
            await insertShift(tx, {
              id: qShiftAlreadySalonedId,
              employeeId: tenantQ.employee.id,
              salonId: qSalon2Id, // already has a salon — backfill must only fill NULLs
              date: new Date("2020-03-03"),
              startTime: "08:00",
              endTime: "16:00",
            });
            await insertAppointment(tx, {
              id: qApptId,
              employeeId: tenantQ.employee.id,
              salonId: null,
              date: new Date("2020-03-02"),
              startTime: "09:00",
              endTime: "10:00",
            });

            await insertShift(tx, {
              id: rShiftId,
              employeeId: tenantR.employee.id,
              salonId: null,
              date: new Date("2020-03-04"),
              startTime: "08:00",
              endTime: "16:00",
              origin: "PHOREST",
              externalId: `r-ext-${s}`,
            });
            await insertAppointment(tx, {
              id: rApptId,
              employeeId: tenantR.employee.id,
              salonId: null,
              date: new Date("2020-03-04"),
              startTime: "09:00",
              endTime: "10:00",
            });

            await insertShift(tx, {
              id: sShiftId,
              employeeId: tenantS.employee.id,
              salonId: null,
              date: new Date("2020-03-05"),
              startTime: "08:00",
              endTime: "16:00",
              conflictsWithLeave: true,
              note: "Kollidiert mit Urlaub",
              label: "Frühschicht",
              createdBy: tenantS.adminUser.id,
            });
            await insertAppointment(tx, {
              id: sApptId,
              employeeId: tenantS.employee.id,
              salonId: null,
              date: new Date("2020-03-05"),
              startTime: "09:00",
              endTime: "10:00",
            });

            const before: Snapshot = {
              shifts: await Promise.all(allShiftIds.map((id) => selectShift(tx, id))),
              appts: await Promise.all(allApptIds.map((id) => selectAppointment(tx, id))),
            };

            // Phase 71b (issue #71): the data section's own `INSERT INTO "Salon"` predates
            // federalState and would NOT NULL-fail against the post-71b schema otherwise — wrap
            // both runs (and everything reading Salon rows in between) in ONE
            // withPre71bSalonSchema window.
            await withPre71bSalonSchema(tx, async () => {
              // 4. Execute the REAL data section, statement by statement (extended-protocol
              //    pitfall — a single multi-statement raw call can be rejected by the driver).
              for (const stmt of statements) {
                await tx.$executeRawUnsafe(stmt);
              }

              const afterFirst: Snapshot = {
                shifts: await Promise.all(allShiftIds.map((id) => selectShift(tx, id))),
                appts: await Promise.all(allApptIds.map((id) => selectAppointment(tx, id))),
              };

              // 5. Whole-database invariants (AC-2): zero NULLs left anywhere, no row whose salon
              //    belongs to a different tenant than its own employee.
              const [{ count: nullShiftCount }] = await tx.$queryRaw<{ count: number }[]>`
                SELECT count(*)::int AS count FROM "Shift" WHERE "salonId" IS NULL
              `;
              const [{ count: nullApptCount }] = await tx.$queryRaw<{ count: number }[]>`
                SELECT count(*)::int AS count FROM "PhorestAppointment" WHERE "salonId" IS NULL
              `;
              const [{ count: crossTenantShiftCount }] = await tx.$queryRaw<{ count: number }[]>`
                SELECT count(*)::int AS count FROM "Shift" sh
                JOIN "Employee" e ON e."id" = sh."employeeId"
                JOIN "Salon" sa ON sa."id" = sh."salonId"
                WHERE sa."tenantId" != e."tenantId"
              `;
              const [{ count: crossTenantApptCount }] = await tx.$queryRaw<{ count: number }[]>`
                SELECT count(*)::int AS count FROM "PhorestAppointment" pa
                JOIN "Employee" e ON e."id" = pa."employeeId"
                JOIN "Salon" sa ON sa."id" = pa."salonId"
                WHERE sa."tenantId" != e."tenantId"
              `;

              // 6. D-04 rule pin — findDefaultSalon(tx, ...) vs. the migration's own choice.
              const defaultSalonQ = await findDefaultSalon(tx, tenantQ.tenant.id);
              const defaultSalonR = await findDefaultSalon(tx, tenantR.tenant.id);
              const defaultSalonS = await findDefaultSalon(tx, tenantS.tenant.id);

              // 7. P now has exactly one (new) salon.
              const pSalons = await tx.salon.findMany({ where: { tenantId: tenantP.tenant.id } });

              // 8. Run the section a SECOND time — idempotency (NOT EXISTS / salonId IS NULL guards).
              for (const stmt of statements) {
                await tx.$executeRawUnsafe(stmt);
              }
              const afterSecond: Snapshot = {
                shifts: await Promise.all(allShiftIds.map((id) => selectShift(tx, id))),
                appts: await Promise.all(allApptIds.map((id) => selectAppointment(tx, id))),
              };
              const pSalonsAfterSecond = await tx.salon.findMany({
                where: { tenantId: tenantP.tenant.id },
              });

              captured = {
                before,
                afterFirst,
                afterSecond,
                nullShiftCount,
                nullApptCount,
                crossTenantShiftCount,
                crossTenantApptCount,
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
            });

            throw new ShiftSalonMigrationReplayRollback(
              "deliberate rollback — this fixture must never be committed",
            );
          },
          { timeout: 30000 },
        ),
      ).rejects.toBeInstanceOf(ShiftSalonMigrationReplayRollback);

      expect(captured).toBeDefined();
      const c = captured!;

      // AC-2: no NULLs left anywhere, no cross-tenant salon.
      expect(c.nullShiftCount).toBe(0);
      expect(c.nullApptCount).toBe(0);
      expect(c.crossTenantShiftCount).toBe(0);
      expect(c.crossTenantApptCount).toBe(0);

      // P: exactly one new salon, named after the tenant, active; its rows point to it.
      expect(c.pSalons).toHaveLength(1);
      expect(c.pSalons[0].name).toBe(tenantP.tenant.name);
      expect(c.pSalons[0].isActive).toBe(true);
      const pShiftAfter = c.afterFirst.shifts.find((row) => row.id === pShiftId)!;
      const pApptAfter = c.afterFirst.appts.find((row) => row.id === pApptId)!;
      expect(pShiftAfter.salonId).toBe(c.pSalons[0].id);
      expect(pApptAfter.salonId).toBe(c.pSalons[0].id);

      // Q: NULL-salon rows point to Q1 (earliest ACTIVE); the already-Q2 row is untouched.
      const qShiftAfter = c.afterFirst.shifts.find((row) => row.id === qShiftId)!;
      const qShiftAlreadySalonedAfter = c.afterFirst.shifts.find(
        (row) => row.id === qShiftAlreadySalonedId,
      )!;
      const qApptAfter = c.afterFirst.appts.find((row) => row.id === qApptId)!;
      expect(qShiftAfter.salonId).toBe(qSalon1Id);
      expect(qApptAfter.salonId).toBe(qSalon1Id);
      expect(qShiftAlreadySalonedAfter.salonId).toBe(qSalon2Id); // backfill only fills NULLs

      // R: only an inactive salon → migration-only fallback to it; findDefaultSalon(R) is null.
      const rShiftAfter = c.afterFirst.shifts.find((row) => row.id === rShiftId)!;
      const rApptAfter = c.afterFirst.appts.find((row) => row.id === rApptId)!;
      expect(rShiftAfter.salonId).toBe(rSalon0Id);
      expect(rApptAfter.salonId).toBe(rSalon0Id);
      expect(c.defaultSalonRId).toBeNull();

      // S: tie on createdAt → lower id wins, for BOTH the migration SQL and findDefaultSalon (D-04).
      const sShiftAfter = c.afterFirst.shifts.find((row) => row.id === sShiftId)!;
      const sApptAfter = c.afterFirst.appts.find((row) => row.id === sApptId)!;
      expect(sShiftAfter.salonId).toBe(sSalonAId);
      expect(sApptAfter.salonId).toBe(sSalonAId);
      expect(c.defaultSalonSId).toBe(sSalonAId);

      // D-04: the runtime resolver agrees with the migration's own choice for Q too.
      expect(c.defaultSalonQId).toBe(qSalon1Id);

      // AC-8/D-03: every OTHER column is byte-identical, for every fixture row.
      for (const id of allShiftIds) {
        const beforeRow = c.before.shifts.find((row) => row.id === id)!;
        const afterRow = c.afterFirst.shifts.find((row) => row.id === id)!;
        const { salonId: _beforeSalonId, ...beforeRest } = beforeRow;
        const { salonId: _afterSalonId, ...afterRest } = afterRow;
        expect(afterRest).toEqual(beforeRest);
      }
      for (const id of allApptIds) {
        const beforeRow = c.before.appts.find((row) => row.id === id)!;
        const afterRow = c.afterFirst.appts.find((row) => row.id === id)!;
        const { salonId: _beforeSalonId, ...beforeRest } = beforeRow;
        const { salonId: _afterSalonId, ...afterRest } = afterRow;
        expect(afterRest).toEqual(beforeRest);
      }

      // Idempotency: a second run changes no row and adds no salon.
      expect(c.afterSecond.shifts).toEqual(c.afterFirst.shifts);
      expect(c.afterSecond.appts).toEqual(c.afterFirst.appts);
      expect(c.pSalonsAfterSecond).toHaveLength(1);
      expect(c.pSalonsAfterSecond[0].id).toBe(c.pSalons[0].id);
    },
  );
});

describe("Phase 325 — Restrict FK proof (AC-3)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let shiftId: string;

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "shift-salon-fk");
    const shift = await app.prisma.shift.create({
      data: {
        employeeId: seed.employee.id,
        salonId: seed.salonId,
        date: new Date(),
        startTime: "09:00",
        endTime: "17:00",
      },
    });
    shiftId = shift.id;
    await app.prisma.phorestAppointment.create({
      data: {
        employeeId: seed.employee.id,
        salonId: seed.salonId,
        date: new Date(),
        startTime: "09:00",
        endTime: "10:00",
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("Shift_salonId_fkey and PhorestAppointment_salonId_fkey are ON DELETE RESTRICT; deleting a salon with rows fails and the salon stays", async () => {
    const constraints = await app.prisma.$queryRaw<{ conname: string; confdeltype: string }[]>`
      SELECT conname, confdeltype::text AS confdeltype FROM pg_constraint
      WHERE conname IN ('Shift_salonId_fkey', 'PhorestAppointment_salonId_fkey')
    `;
    expect(constraints).toHaveLength(2);
    for (const constraint of constraints) {
      expect(constraint.confdeltype).toBe("r");
    }

    // Both a shift and an appointment reference the salon — deletion must fail.
    await expect(app.prisma.salon.delete({ where: { id: seed.salonId } })).rejects.toMatchObject({
      code: "P2003",
    });
    const stillThereWithBoth = await app.prisma.salon.findUnique({ where: { id: seed.salonId } });
    expect(stillThereWithBoth).not.toBeNull();

    // Remove the shift — the appointment alone still blocks the delete.
    await app.prisma.shift.delete({ where: { id: shiftId } });
    await expect(app.prisma.salon.delete({ where: { id: seed.salonId } })).rejects.toMatchObject({
      code: "P2003",
    });
    const stillThereWithAppointmentOnly = await app.prisma.salon.findUnique({
      where: { id: seed.salonId },
    });
    expect(stillThereWithAppointmentOnly).not.toBeNull();
  });
});

// Issue #342: cleanupTestData used to skip PhorestAppointment rows, so a tenant whose employee
// still had one failed to delete on PhorestAppointment_employeeId_fkey (both employeeId and
// salonId are onDelete: Restrict) and leaked fixture rows into the shared test database.
describe("Issue #342 — cleanupTestData removes PhorestAppointment rows", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "cleanup-phorest-appt");
    await app.prisma.phorestAppointment.create({
      data: {
        employeeId: seed.employee.id,
        salonId: seed.salonId,
        date: new Date(),
        startTime: "09:00",
        endTime: "10:00",
      },
    });
  });

  afterAll(async () => {
    try {
      // Safety net for the RED run (before the setup.ts fix): remove the appointment ourselves
      // so a failed cleanupTestData does not leak this fixture into the shared test database.
      await app.prisma.phorestAppointment.deleteMany({ where: { employeeId: seed.employee.id } });
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    try {
      // On the green path the test below already removed the tenant; only clean up if it's
      // still there, or cleanupTestData's tenant.delete throws P2025 (record not found).
      const stillThere = await app.prisma.tenant.findUnique({ where: { id: seed.tenant.id } });
      if (stillThere) {
        await cleanupTestData(app, seed.tenant.id);
      }
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("cleanupTestData deletes a tenant whose employee still has a PhorestAppointment", async () => {
    const employeeId = seed.employee.id;
    const tenantId = seed.tenant.id;

    await expect(cleanupTestData(app, tenantId)).resolves.toBeUndefined();

    const remainingAppointments = await app.prisma.phorestAppointment.count({
      where: { employeeId },
    });
    expect(remainingAppointments).toBe(0);

    const tenantRow = await app.prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenantRow).toBeNull();
  });
});
