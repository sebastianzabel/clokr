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
