/**
 * Phase 64b Plan 01 (issue #64) — AC-3 proof: executes the REAL migration text (not a
 * restatement of it) and reads the result back through the API.
 *
 * `readDataSection()` resolves the migration file by its exact, hardcoded directory name — never
 * `readdirSync` — so a later, unrelated migration cannot be silently picked up as "the" Salon
 * migration.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root, same resolution as
// t100-09-oracle-probe.test.ts.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SALON_MIGRATION_DIR = "20260924071637_add_salon";
const MIGRATION_PATH = join(
  REPO_ROOT,
  "packages/db/prisma/migrations",
  SALON_MIGRATION_DIR,
  "migration.sql",
);

const DATA_SECTION_BEGIN = "-- 64b-data-migration:begin";
const DATA_SECTION_END = "-- 64b-data-migration:end";

/**
 * Returns the text strictly between the two marker lines. FAILS the calling test (via `expect`,
 * not a thrown error) if either marker is missing, or if the section does not contain an
 * `INSERT INTO "Salon"` statement — a migration file that lost its data section must fail loudly
 * here, not be silently treated as "nothing to run".
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
  return section;
}

describe("Phase 64b tracer — default-salon migration + GET /api/v1/salons", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "salon-mig-a");
    tenantB = await seedTestData(app, "salon-mig-b");

    // Execute the migration's own data section (D-14), committed — this is what a real migration
    // run does once. NOT EXISTS makes running it again later (Task 2's cases) safe.
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

  it("AC-3: tenant A has exactly one active default salon, readable via GET /api/v1/salons; tenant B's is invisible", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      salons: Array<{
        id: string;
        name: string;
        street: string | null;
        postalCode: string | null;
        city: string | null;
        isActive: boolean;
        deactivatedAt: string | null;
        openingHours: unknown;
      }>;
      isMultiSalon: boolean;
    };

    expect(body.isMultiSalon).toBe(false);
    expect(body.salons).toHaveLength(1);

    const salon = body.salons[0];
    expect(salon.name).toBe(tenantA.tenant.name);
    expect(salon.street).toBeNull();
    expect(salon.postalCode).toBeNull();
    expect(salon.city).toBeNull();
    expect(salon.isActive).toBe(true);
    expect(salon.deactivatedAt).toBeNull();
    // seedTestData's TenantConfig is created without storeHours (setup.ts), so the migration's
    // COALESCE fallback applies — this is the schema default, which DEFAULT_SALON_OPENING_HOURS
    // is pinned to equal.
    expect(salon.openingHours).toEqual(DEFAULT_SALON_OPENING_HOURS);

    const tenantBSalon = await app.prisma.salon.findFirst({
      where: { tenantId: tenantB.tenant.id },
    });
    expect(tenantBSalon).not.toBeNull();
    expect(body.salons.some((s) => s.id === tenantBSalon!.id)).toBe(false);
  });
});
