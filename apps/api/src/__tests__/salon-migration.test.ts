/**
 * Phase 64b Plan 01 (issue #64) — AC-3 proof: executes the REAL migration text (not a
 * restatement of it) and reads the result back through the API.
 *
 * `readDataSection()` resolves the migration file by its exact, hardcoded directory name — never
 * a dynamic directory scan — so a later, unrelated migration cannot be silently picked up as "the"
 * Salon migration.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import {
  DEFAULT_SALON_OPENING_HOURS,
  salonOpeningHoursSchema,
  type SalonOpeningHours,
} from "../contexts/platform/facade/salons";

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
  // Phase 325 (issue #325), D-17: this block opts out of seedTestData's default salon
  // (`{ withDefaultSalon: false }`) — otherwise the migration's own `INSERT ... WHERE NOT EXISTS`
  // below would be a silent no-op against an already-salon'd tenant, and this test would keep
  // passing while proving nothing (325-RESEARCH.md Pitfall 2). The opt-out overload returns
  // `salonId: null` instead of the default overload's `salonId: string`, hence the widened type.
  let tenantA: Omit<Awaited<ReturnType<typeof seedTestData>>, "salonId"> & {
    salonId: string | null;
  };
  let tenantB: Omit<Awaited<ReturnType<typeof seedTestData>>, "salonId"> & {
    salonId: string | null;
  };

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "salon-mig-a", { withDefaultSalon: false });
    tenantB = await seedTestData(app, "salon-mig-b", { withDefaultSalon: false });

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

// ── Task 2: AC-3 hardening — custom hours, no TenantConfig, pre-existing salon, idempotency ────

/**
 * Thrown at the end of the rolled-back transaction below so the whole fixture (three tenants,
 * their configs, the pre-existing salon) never actually lands in the shared test database —
 * the ONLY durable state this test suite creates is the tracer's own two tenants above.
 */
class Salon64bMigrationCasesRollback extends Error {}

const CUSTOM_STORE_HOURS: SalonOpeningHours = [
  { day: 0, open: "08:00", close: "20:00", closed: true },
  { day: 1, open: "08:00", close: "20:00" },
  { day: 2, open: "08:00", close: "20:00" },
  { day: 3, open: "08:00", close: "20:00" },
  { day: 4, open: "08:00", close: "20:00" },
  { day: 5, open: "09:00", close: "14:00" },
  { day: 6, open: "08:00", close: "20:00", closed: true },
];

describe("Phase 64b — migration data-section cases A-C (D-14) + idempotency, rolled back", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  it("case A (custom storeHours), case B (no TenantConfig), case C (pre-existing salon), both runs idempotent", async () => {
    const dataSection = readDataSection();

    type Snapshot = {
      tenantAName: string;
      tenantBName: string;
      preexistingSalonId: string;
      afterFirst: {
        a: Array<{ name: string; openingHours: unknown }>;
        b: Array<{ name: string; openingHours: unknown }>;
        c: Array<{ id: string }>;
      };
      afterSecond: {
        a: Array<{ name: string; openingHours: unknown }>;
        b: Array<{ name: string; openingHours: unknown }>;
        c: Array<{ id: string }>;
      };
    };
    let snapshot: Snapshot | undefined;

    await expect(
      app.prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

          // Case A: TenantConfig.storeHours set to a NON-default week.
          const tenantA = await tx.tenant.create({
            data: {
              name: `Salon Case A ${s}`,
              slug: `salon-case-a-${s}`,
              federalState: "NIEDERSACHSEN",
            },
          });
          await tx.tenantConfig.create({
            data: { tenantId: tenantA.id, storeHours: CUSTOM_STORE_HOURS },
          });

          // Case B: tenant WITHOUT a TenantConfig row at all.
          const tenantB = await tx.tenant.create({
            data: {
              name: `Salon Case B ${s}`,
              slug: `salon-case-b-${s}`,
              federalState: "NIEDERSACHSEN",
            },
          });

          // Case C: tenant that already has a salon before the data section runs.
          const tenantC = await tx.tenant.create({
            data: {
              name: `Salon Case C ${s}`,
              slug: `salon-case-c-${s}`,
              federalState: "NIEDERSACHSEN",
            },
          });
          await tx.tenantConfig.create({ data: { tenantId: tenantC.id } });
          const preexistingSalon = await tx.salon.create({
            data: {
              tenantId: tenantC.id,
              name: "Bereits vorhandener Salon",
              openingHours: DEFAULT_SALON_OPENING_HOURS,
              isActive: true,
            },
          });

          // First run of the real migration data section.
          await tx.$executeRawUnsafe(dataSection);
          const afterFirst = {
            a: await tx.salon.findMany({ where: { tenantId: tenantA.id } }),
            b: await tx.salon.findMany({ where: { tenantId: tenantB.id } }),
            c: await tx.salon.findMany({ where: { tenantId: tenantC.id } }),
          };

          // Second run — NOT EXISTS must make this a no-op for every tenant.
          await tx.$executeRawUnsafe(dataSection);
          const afterSecond = {
            a: await tx.salon.findMany({ where: { tenantId: tenantA.id } }),
            b: await tx.salon.findMany({ where: { tenantId: tenantB.id } }),
            c: await tx.salon.findMany({ where: { tenantId: tenantC.id } }),
          };

          snapshot = {
            tenantAName: tenantA.name,
            tenantBName: tenantB.name,
            preexistingSalonId: preexistingSalon.id,
            afterFirst,
            afterSecond,
          };

          throw new Salon64bMigrationCasesRollback(
            "deliberate rollback — this fixture must never be committed",
          );
        },
        { timeout: 20000 },
      ),
    ).rejects.toBeInstanceOf(Salon64bMigrationCasesRollback);

    expect(snapshot).toBeDefined();
    const { tenantAName, tenantBName, preexistingSalonId, afterFirst, afterSecond } = snapshot!;

    // Case A: exactly one salon, custom hours copied verbatim.
    expect(afterFirst.a).toHaveLength(1);
    expect(afterFirst.a[0].name).toBe(tenantAName);
    expect(afterFirst.a[0].openingHours).toEqual(CUSTOM_STORE_HOURS);
    expect(afterSecond.a).toHaveLength(1);

    // Case B: exactly one salon, COALESCE fallback equals the facade constant.
    expect(afterFirst.b).toHaveLength(1);
    expect(afterFirst.b[0].name).toBe(tenantBName);
    expect(afterFirst.b[0].openingHours).toEqual(DEFAULT_SALON_OPENING_HOURS);
    expect(afterSecond.b).toHaveLength(1);

    // Case C: still exactly the ONE pre-existing salon, same id, both runs.
    expect(afterFirst.c).toHaveLength(1);
    expect(afterFirst.c[0].id).toBe(preexistingSalonId);
    expect(afterSecond.c).toHaveLength(1);
    expect(afterSecond.c[0].id).toBe(preexistingSalonId);
  });
});

// ── Living assertion: DEFAULT_SALON_OPENING_HOURS pinned to the schema's storeHours default ────

describe("DEFAULT_SALON_OPENING_HOURS living assertion", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenant = await seedTestData(app, "salon-living-assertion");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenant.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("a TenantConfig created without storeHours equals DEFAULT_SALON_OPENING_HOURS, which itself parses under salonOpeningHoursSchema", async () => {
    const config = await app.prisma.tenantConfig.findUniqueOrThrow({
      where: { tenantId: tenant.tenant.id },
    });
    expect(config.storeHours).toEqual(DEFAULT_SALON_OPENING_HOURS);
    expect(() => salonOpeningHoursSchema.parse(DEFAULT_SALON_OPENING_HOURS)).not.toThrow();
  });

  it("WR-06: the facade constant AND the seeds' own copy (packages/db/src/default-salon.ts) are byte-identical to TenantConfig.storeHours's @default in schema.prisma", async () => {
    const schemaText = readFileSync(join(REPO_ROOT, "packages/db/prisma/schema.prisma"), "utf8");
    const modelStart = schemaText.indexOf("model TenantConfig {");
    expect(modelStart, "model TenantConfig not found in schema.prisma").toBeGreaterThan(-1);
    const modelBody = schemaText.slice(modelStart, schemaText.indexOf("\n}", modelStart));
    const defaultMatch = /^\s*storeHours\s+Json\s+@default\("((?:[^"\\]|\\.)*)"\)/m.exec(modelBody);
    expect(defaultMatch, "TenantConfig.storeHours @default(...) not found").not.toBeNull();
    // Prisma string literal -> JSON text: the only escapes in this default are \" quotes.
    const schemaDefaultJson = (defaultMatch?.[1] ?? "").replace(/\\"/g, '"');
    const schemaDefault: unknown = JSON.parse(schemaDefaultJson);

    // A path computed at runtime, so tsc (rootDir: ./src) does not try to compile the seed file
    // into this package — vitest still loads the real module, not a restatement of it.
    const seedModulePath = join(REPO_ROOT, "packages/db/src/default-salon.ts");
    const seedModule = (await import(seedModulePath)) as {
      DEFAULT_SALON_OPENING_HOURS: unknown;
    };

    expect(DEFAULT_SALON_OPENING_HOURS).toEqual(schemaDefault);
    expect(seedModule.DEFAULT_SALON_OPENING_HOURS).toEqual(schemaDefault);
    expect(JSON.stringify(DEFAULT_SALON_OPENING_HOURS)).toBe(schemaDefaultJson);
    expect(JSON.stringify(seedModule.DEFAULT_SALON_OPENING_HOURS)).toBe(schemaDefaultJson);
  });
});
