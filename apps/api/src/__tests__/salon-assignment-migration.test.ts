/**
 * Phase 67b Plan 01 (issue #67) — AC-Stamm-1 tracer: executes the REAL migration data section (not
 * a restatement of it) and reads the result back through the API.
 *
 * `readDataSection()` resolves the migration file by its exact, hardcoded directory name — never a
 * dynamic directory scan — so a later, unrelated migration cannot be silently picked up as "the"
 * EmployeeSalonAssignment migration. Same shape as `salon-migration.test.ts`'s own helper.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS, listSalons } from "../contexts/platform/facade/salons";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root, same resolution as
// salon-migration.test.ts.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const ASSIGNMENT_MIGRATION_DIR = "20260924150127_add_employee_salon_assignment";
const MIGRATION_PATH = join(
  REPO_ROOT,
  "packages/db/prisma/migrations",
  ASSIGNMENT_MIGRATION_DIR,
  "migration.sql",
);

const DATA_SECTION_BEGIN = "-- 67b-data-migration:begin";
const DATA_SECTION_END = "-- 67b-data-migration:end";

/**
 * Returns the text strictly between the two marker lines. FAILS the calling test (via `expect`,
 * not a thrown error) if either marker is missing, or if the section does not contain an
 * `INSERT INTO "EmployeeSalonAssignment"` statement — a migration file that lost its data section
 * must fail loudly here, not be silently treated as "nothing to run".
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
  expect(
    section,
    'data section does not contain an INSERT INTO "EmployeeSalonAssignment"',
  ).toContain('INSERT INTO "EmployeeSalonAssignment"');
  return section;
}

describe("Phase 67b tracer — AC-Stamm-1 migration + GET /api/v1/employees/:id/salon-assignments", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let tenantASalonId: string;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sa-mig-a");
    tenantB = await seedTestData(app, "sa-mig-b");

    // seedTestData creates no salon (D-25 context note) — give each tenant one active default
    // salon so the migration's data section has somewhere to point the HOME row at.
    await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Salon A",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    await app.prisma.salon.create({
      data: {
        tenantId: tenantB.tenant.id,
        name: "Salon B",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });

    const tenantASalons = await listSalons(app.prisma, tenantA.tenant.id, {
      includeInactive: false,
    });
    tenantASalonId = tenantASalons[0].id;

    // Execute the migration's own data section (D-25), committed — this is what a real migration
    // run does once. NOT EXISTS makes running it again later safe.
    await app.prisma.$executeRawUnsafe(readDataSection());
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("AC-Stamm-1: tenant A's employee has exactly one open HOME row, readable via GET /api/v1/employees/:id/salon-assignments", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${tenantA.employee.id}/salon-assignments`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      assignments: Array<{
        id: string;
        employeeId: string;
        salonId: string;
        kind: string;
        validFrom: string;
        validUntil: string | null;
        weekdays: number[];
      }>;
    };

    expect(body.assignments).toHaveLength(1);
    const row = body.assignments[0];
    expect(row.kind).toBe("HOME");
    expect(row.salonId).toBe(tenantASalonId);
    expect(row.validFrom).toBe("2024-01-01");
    expect(row.validUntil).toBeNull();
    expect(row.weekdays).toEqual([]);
  });

  it("D-19: a foreign employee id (tenant B's) and a nonexistent id get byte-identical 404s against tenant A's token", async () => {
    const foreignRes = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${tenantB.employee.id}/salon-assignments`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    const unknownRes = await app.inject({
      method: "GET",
      url: "/api/v1/employees/00000000-0000-4000-8000-000000000000/salon-assignments",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(foreignRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(unknownRes.body);
    expect(JSON.parse(foreignRes.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });
  });
});

// ── Task 2: AC-Stamm-1 hardening — default-salon choice, tenant-local day, exited/anonymized
// employees, idempotency, edge tenants (D-25) ──────────────────────────────────────────────────

/**
 * Thrown at the end of the rolled-back transaction below so the whole fixture (six tenants, their
 * salons/configs/employees) never actually lands in the shared test database — same shape as
 * `salon-migration.test.ts`'s `Salon64bMigrationCasesRollback`.
 */
class SalonAssignmentMigrationCasesRollback extends Error {}

describe("Phase 67b — migration data-section cases A-D (D-25) + idempotency, rolled back", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  it("case A (earliest-ACTIVE default salon), case B (tenant-local day across timezones + no-TenantConfig fallback), case C (exited + anonymized employees), case D (existing HOME row kept, idempotent, inactive-only tenant, salon-less tenant)", async () => {
    const dataSection = readDataSection();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ad-hoc snapshot shape, scoped to this one test
    let snapshot: any;

    await expect(
      app.prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

          async function makeTenant(label: string, timezone: string | null | undefined) {
            const tenant = await tx.tenant.create({
              data: {
                name: `SA ${label} ${s}`,
                slug: `sa-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${s}`,
                federalState: "NIEDERSACHSEN",
              },
            });
            if (timezone !== null) {
              await tx.tenantConfig.create({
                data: { tenantId: tenant.id, timezone: timezone ?? "Europe/Berlin" },
              });
            }
            return tenant;
          }

          async function makeEmployee(
            tenantId: string,
            empNo: string,
            opts: { hireDate: Date; exitDate?: Date; firstName?: string },
          ) {
            const user = await tx.user.create({
              data: {
                email: `${empNo}-${s}@test.de`.toLowerCase(),
                passwordHash: "x",
                role: "EMPLOYEE",
                isActive: true,
              },
            });
            return tx.employee.create({
              data: {
                tenantId,
                userId: user.id,
                employeeNumber: empNo,
                firstName: opts.firstName ?? "Test",
                lastName: "Case",
                hireDate: opts.hireDate,
                exitDate: opts.exitDate ?? null,
              },
            });
          }

          // ── Case A: default salon = earliest-created ACTIVE salon, tie-break id ──────────────
          const tenantA = await makeTenant("CaseA", "Europe/Berlin");
          const base = new Date("2026-01-01T00:00:00Z").getTime();
          await tx.salon.create({
            data: {
              tenantId: tenantA.id,
              name: "Inactive (earliest overall)",
              openingHours: DEFAULT_SALON_OPENING_HOURS,
              isActive: false,
              createdAt: new Date(base),
            },
          });
          const s1 = await tx.salon.create({
            data: {
              tenantId: tenantA.id,
              name: "S1 (earliest active)",
              openingHours: DEFAULT_SALON_OPENING_HOURS,
              isActive: true,
              createdAt: new Date(base + 1000),
            },
          });
          await tx.salon.create({
            data: {
              tenantId: tenantA.id,
              name: "S2 (later active)",
              openingHours: DEFAULT_SALON_OPENING_HOURS,
              isActive: true,
              createdAt: new Date(base + 2000),
            },
          });
          const empA = await makeEmployee(tenantA.id, `A-${s}`, {
            hireDate: new Date("2024-01-01T00:00:00Z"),
          });

          // ── Case B: tenant-local day, three timezone scenarios ───────────────────────────────
          const tenantNY = await makeTenant("CaseBNY", "America/New_York");
          await tx.salon.create({
            data: {
              tenantId: tenantNY.id,
              name: "NY Salon",
              openingHours: DEFAULT_SALON_OPENING_HOURS,
              isActive: true,
            },
          });
          const empNY = await makeEmployee(tenantNY.id, `NY-${s}`, {
            hireDate: new Date("2025-03-01T03:00:00Z"),
          });

          const tenantBerlin = await makeTenant("CaseBBerlin", "Europe/Berlin");
          await tx.salon.create({
            data: {
              tenantId: tenantBerlin.id,
              name: "Berlin Salon",
              openingHours: DEFAULT_SALON_OPENING_HOURS,
              isActive: true,
            },
          });
          const empBerlin = await makeEmployee(tenantBerlin.id, `BE-${s}`, {
            hireDate: new Date("2025-03-01T03:00:00Z"),
          });

          const tenantNoConfig = await makeTenant("CaseBNoConfig", null);
          await tx.salon.create({
            data: {
              tenantId: tenantNoConfig.id,
              name: "NoConfig Salon",
              openingHours: DEFAULT_SALON_OPENING_HOURS,
              isActive: true,
            },
          });
          const empNoConfig = await makeEmployee(tenantNoConfig.id, `NC-${s}`, {
            hireDate: new Date("2025-03-01T03:00:00Z"),
          });

          // ── Case C: exited + anonymized employees still get a HOME row ───────────────────────
          const tenantC = await makeTenant("CaseC", "Europe/Berlin");
          await tx.salon.create({
            data: {
              tenantId: tenantC.id,
              name: "C Salon",
              openingHours: DEFAULT_SALON_OPENING_HOURS,
              isActive: true,
            },
          });
          const empExited = await makeEmployee(tenantC.id, `EX-${s}`, {
            hireDate: new Date("2020-01-01T00:00:00Z"),
            exitDate: new Date("2023-01-01T00:00:00Z"),
          });
          const empAnon = await makeEmployee(tenantC.id, `AN-${s}`, {
            hireDate: new Date("2020-01-01T00:00:00Z"),
            firstName: "Gelöscht",
          });

          // ── Case D1: employee that already has a HOME row keeps exactly that one row ─────────
          const tenantD1 = await makeTenant("CaseD1", "Europe/Berlin");
          const d1Salon = await tx.salon.create({
            data: {
              tenantId: tenantD1.id,
              name: "D1 Salon",
              openingHours: DEFAULT_SALON_OPENING_HOURS,
              isActive: true,
            },
          });
          const empD1 = await makeEmployee(tenantD1.id, `D1-${s}`, {
            hireDate: new Date("2022-01-01T00:00:00Z"),
          });
          const preExisting = await tx.employeeSalonAssignment.create({
            data: {
              tenantId: tenantD1.id,
              employeeId: empD1.id,
              salonId: d1Salon.id,
              kind: "HOME",
              validFrom: new Date("2022-06-15"),
              validUntil: null,
              weekdays: [],
            },
          });

          // ── Case D2: tenant whose only salon is INACTIVE — fallback still assigns it ─────────
          const tenantD2 = await makeTenant("CaseD2", "Europe/Berlin");
          const inactiveOnlySalon = await tx.salon.create({
            data: {
              tenantId: tenantD2.id,
              name: "D2 Inactive-only",
              openingHours: DEFAULT_SALON_OPENING_HOURS,
              isActive: false,
            },
          });
          const empD2 = await makeEmployee(tenantD2.id, `D2-${s}`, {
            hireDate: new Date("2022-01-01T00:00:00Z"),
          });

          // ── Case D3: tenant with no salon at all — gets no HOME row ──────────────────────────
          const tenantD3 = await makeTenant("CaseD3", "Europe/Berlin");
          const empD3 = await makeEmployee(tenantD3.id, `D3-${s}`, {
            hireDate: new Date("2022-01-01T00:00:00Z"),
          });

          // ── First run ─────────────────────────────────────────────────────────────────────
          await tx.$executeRawUnsafe(dataSection);

          const homeA = await tx.employeeSalonAssignment.findMany({
            where: { employeeId: empA.id, kind: "HOME" },
          });
          const homeNY = await tx.employeeSalonAssignment.findMany({
            where: { employeeId: empNY.id, kind: "HOME" },
          });
          const homeBerlin = await tx.employeeSalonAssignment.findMany({
            where: { employeeId: empBerlin.id, kind: "HOME" },
          });
          const homeNoConfig = await tx.employeeSalonAssignment.findMany({
            where: { employeeId: empNoConfig.id, kind: "HOME" },
          });
          const homeExited = await tx.employeeSalonAssignment.findMany({
            where: { employeeId: empExited.id, kind: "HOME" },
          });
          const homeAnon = await tx.employeeSalonAssignment.findMany({
            where: { employeeId: empAnon.id, kind: "HOME" },
          });
          const homeD1AfterFirst = await tx.employeeSalonAssignment.findMany({
            where: { employeeId: empD1.id, kind: "HOME" },
          });
          const homeD2 = await tx.employeeSalonAssignment.findMany({
            where: { employeeId: empD2.id, kind: "HOME" },
          });
          const homeD3 = await tx.employeeSalonAssignment.findMany({
            where: { employeeId: empD3.id, kind: "HOME" },
          });

          // ── Second run — NOT EXISTS must make this a no-op for every tenant above ────────────
          await tx.$executeRawUnsafe(dataSection);

          const homeAAfterSecond = await tx.employeeSalonAssignment.findMany({
            where: { employeeId: empA.id, kind: "HOME" },
          });
          const homeD1AfterSecond = await tx.employeeSalonAssignment.findMany({
            where: { employeeId: empD1.id, kind: "HOME" },
          });

          snapshot = {
            caseA: { rows: homeA, expectedSalonId: s1.id },
            caseB: { ny: homeNY, berlin: homeBerlin, noConfig: homeNoConfig },
            caseC: { exited: homeExited, anon: homeAnon },
            caseD: {
              afterFirst: homeD1AfterFirst,
              afterSecond: homeD1AfterSecond,
              preExistingId: preExisting.id,
              d2: homeD2,
              inactiveOnlySalonId: inactiveOnlySalon.id,
              d3: homeD3,
              aAfterSecond: homeAAfterSecond,
            },
          };

          throw new SalonAssignmentMigrationCasesRollback(
            "deliberate rollback — this fixture must never be committed",
          );
        },
        { timeout: 20000 },
      ),
    ).rejects.toBeInstanceOf(SalonAssignmentMigrationCasesRollback);

    expect(snapshot).toBeDefined();
    const { caseA, caseB, caseC, caseD } = snapshot;

    // Case A: exactly one HOME row, pointing at S1 (earliest ACTIVE, not the earlier INACTIVE nor
    // the later S2).
    expect(caseA.rows).toHaveLength(1);
    expect(caseA.rows[0].salonId).toBe(caseA.expectedSalonId);

    // Case B: tenant-local calendar day, not the UTC day.
    expect(caseB.ny).toHaveLength(1);
    expect(caseB.ny[0].validFrom.toISOString().slice(0, 10)).toBe("2025-02-28");
    expect(caseB.berlin).toHaveLength(1);
    expect(caseB.berlin[0].validFrom.toISOString().slice(0, 10)).toBe("2025-03-01");
    expect(caseB.noConfig).toHaveLength(1);
    expect(caseB.noConfig[0].validFrom.toISOString().slice(0, 10)).toBe("2025-03-01");

    // Case C: exited AND anonymized employees still get exactly one open HOME row (AC-Stamm-1: no
    // filter on either).
    expect(caseC.exited).toHaveLength(1);
    expect(caseC.exited[0].validUntil).toBeNull();
    expect(caseC.anon).toHaveLength(1);
    expect(caseC.anon[0].validUntil).toBeNull();

    // Case D1: the pre-existing HOME row is untouched — still exactly one row, same id.
    expect(caseD.afterFirst).toHaveLength(1);
    expect(caseD.afterFirst[0].id).toBe(caseD.preExistingId);
    expect(caseD.afterSecond).toHaveLength(1);
    expect(caseD.afterSecond[0].id).toBe(caseD.preExistingId);

    // Case A idempotency: second run creates nothing additional either.
    expect(caseD.aAfterSecond).toHaveLength(1);

    // Case D2: the only salon is inactive — the fallback (ORDER BY isActive DESC) still assigns it
    // because it is the only candidate.
    expect(caseD.d2).toHaveLength(1);
    expect(caseD.d2[0].salonId).toBe(caseD.inactiveOnlySalonId);

    // Case D3: no salon at all for the tenant — no HOME row is created (there is nothing to
    // assign to).
    expect(caseD.d3).toHaveLength(0);
  });
});
