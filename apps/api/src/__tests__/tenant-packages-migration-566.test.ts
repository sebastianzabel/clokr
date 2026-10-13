/**
 * Phase 566 (issue #566), plan 04 — AC-566-04 / D-09: the Bestandsschutz of the packages migration.
 *
 * Executes the REAL data section of the `*_tenant_packages` migration (never a restatement of it),
 * the same pattern as `salon-coupling-migration.test.ts`: the migration is resolved by its exact,
 * hard-coded directory name (a renamed directory must turn this file red, so no `readdirSync`), and
 * every fixture lives inside ONE `$transaction` that always ends by throwing a module-private
 * sentinel, so nothing lands in the shared test database. Assertions run AFTER the rejection, on
 * values captured inside the callback (an assertion failing inside it would be masked by the
 * rollback).
 *
 * One fixture tenant per signal of D-09, plus the negatives (a TENANT-scoped assignment, a HOME
 * assignment, an unclassified entry, a whitespace-only Phorest id, ...), a deactivated tenant, a
 * tenant without any active salon and two tenants an operator already edited.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Prisma, TenantModule } from "@clokr/db";
import { getTestApp, createTestSalon } from "./setup";
import { createTenantWithConfig } from "../contexts/platform/tenant-provisioning";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const TENANT_PACKAGES_MIGRATION_DIR = "20261013233636_tenant_packages";
const MIGRATION_PATH = join(
  REPO_ROOT,
  "packages/db/prisma/migrations",
  TENANT_PACKAGES_MIGRATION_DIR,
  "migration.sql",
);

const DATA_SECTION_BEGIN = "-- 566-data-migration:begin";
const DATA_SECTION_END = "-- 566-data-migration:end";

/** Returns the text strictly between the two marker lines; FAILS the calling test if one is missing. */
function readDataSection(): string {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const beginIdx = sql.indexOf(DATA_SECTION_BEGIN);
  const endIdx = sql.indexOf(DATA_SECTION_END);
  expect(beginIdx, `migration.sql is missing the "${DATA_SECTION_BEGIN}" marker`).toBeGreaterThan(
    -1,
  );
  expect(endIdx, `migration.sql is missing the "${DATA_SECTION_END}" marker`).toBeGreaterThan(-1);
  return sql.slice(beginIdx + DATA_SECTION_BEGIN.length, endIdx);
}

/** Drops comment-only lines, then splits on a semicolon that ends a line. */
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

describe("data section shape (D-09)", () => {
  it("holds exactly one UPDATE of Tenant and no DDL or other write", () => {
    const statements = splitDataSectionStatements(readDataSection());
    expect(statements).toHaveLength(1);
    expect(statements[0].startsWith('UPDATE "Tenant"')).toBe(true);
    expect(statements[0]).not.toMatch(/\b(CREATE|ALTER|DROP|INSERT|DELETE|TRUNCATE)\b/i);
  });
});

/** Thrown at the end of the replay transaction so its fixtures never land in the database. */
class PackagesMigrationReplayRollback extends Error {}

type Module = "CHAIN" | "INTEGRATIONS" | "HARDWARE_CLOCK" | "ANALYTICS";
type Tx = Prisma.TransactionClient;

type Expectation = { modules: Module[]; quota: number };

/** One fixture tenant: how to build it and what the backfill must grant (`null` = left untouched). */
type FixtureSpec = {
  tag: string;
  /** What the Bestandsschutz grants — or the stored pair an operator-edited tenant keeps. */
  expected: Expectation;
  /** Stored state BEFORE the section runs; defaults to the pre-backfill Grundversion. */
  stored?: Expectation;
  /** True when the section must leave the row exactly as stored. */
  edited?: boolean;
  deactivated?: boolean;
  build: (ctx: FixtureContext) => Promise<void>;
};

type FixtureContext = {
  tx: Tx;
  tenantId: string;
  /** Creates one salon of the tenant. */
  salon: (isActive?: boolean) => Promise<{ id: string }>;
  employee: () => Promise<{ id: string }>;
};

function suffix(): string {
  return randomUUID().slice(0, 8);
}

async function addEmployee(tx: Tx, tenantId: string): Promise<{ id: string }> {
  const s = suffix();
  const user = await tx.user.create({
    data: {
      email: `fixture-${s}@example.invalid`,
      passwordHash: "not-a-real-hash",
      role: "EMPLOYEE",
    },
  });
  return tx.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `F-${s}`,
      firstName: "Fixture",
      lastName: "Employee",
      hireDate: new Date("2024-01-01"),
    },
  });
}

async function addTimeEntry(
  tx: Tx,
  employeeId: string,
  salonId: string,
  data: Partial<Prisma.TimeEntryUncheckedCreateInput> = {},
) {
  return tx.timeEntry.create({
    data: {
      employeeId,
      salonId,
      date: new Date("2026-03-02"),
      startTime: new Date("2026-03-02T08:00:00Z"),
      endTime: new Date("2026-03-02T16:00:00Z"),
      ...data,
    },
  });
}

function keyFields(): { keyHash: string; keyPrefix: string; name: string } {
  return { keyHash: randomUUID(), keyPrefix: "clk_fixt", name: "fixture" };
}

async function setPhorest(tx: Tx, tenantId: string, data: Prisma.TenantConfigUpdateInput) {
  await tx.tenantConfig.update({ where: { tenantId }, data });
}

/** The fixture catalogue: one tenant per signal of D-09 and per negative. */
const FIXTURES: FixtureSpec[] = [
  {
    tag: "NONE",
    expected: { modules: [], quota: 1 },
    build: async ({ salon }) => {
      await salon();
    },
  },
  {
    tag: "SALONS_ANY_STATE",
    expected: { modules: ["CHAIN"], quota: 1 },
    build: async ({ salon }) => {
      await salon(true);
      await salon(false);
    },
  },
  {
    tag: "THREE_ACTIVE",
    expected: { modules: ["CHAIN"], quota: 3 },
    build: async ({ salon }) => {
      await salon();
      await salon();
      await salon();
    },
  },
  {
    tag: "ZERO_ACTIVE",
    expected: { modules: [], quota: 1 },
    build: async ({ salon }) => {
      await salon(false);
    },
  },
  {
    tag: "CUSTOMER_ROLE",
    expected: { modules: ["CHAIN"], quota: 1 },
    build: async ({ tx, tenantId, salon }) => {
      await salon();
      await tx.accessRole.create({
        data: { tenantId, name: "Fixture", nameKey: `fixture-${suffix()}`, permissions: [] },
      });
    },
  },
  {
    tag: "SCOPED_SALONS",
    expected: { modules: ["CHAIN"], quota: 1 },
    build: async ({ tx, tenantId, salon, employee }) => {
      const s = await salon();
      await assign(tx, tenantId, employee, "SALONS", { salonIds: [s.id] });
    },
  },
  {
    tag: "SCOPED_PERSONS",
    expected: { modules: ["CHAIN"], quota: 1 },
    build: async ({ tx, tenantId, salon, employee }) => {
      await salon();
      const e = await employee();
      await assign(tx, tenantId, employee, "PERSONS", { employeeIds: [e.id] });
    },
  },
  {
    tag: "TENANT_SCOPED_ONLY",
    expected: { modules: [], quota: 1 },
    build: async ({ tx, tenantId, salon, employee }) => {
      await salon();
      await assign(tx, tenantId, employee, "TENANT", {});
    },
  },
  {
    tag: "DEPLOYMENT",
    expected: { modules: ["CHAIN"], quota: 1 },
    build: async ({ tx, tenantId, salon, employee }) => {
      const s = await salon();
      const e = await employee();
      await tx.employeeSalonAssignment.create({
        data: {
          tenantId,
          employeeId: e.id,
          salonId: s.id,
          kind: "DEPLOYMENT",
          validFrom: new Date("2026-01-01"),
        },
      });
    },
  },
  {
    tag: "HOME_ONLY",
    expected: { modules: [], quota: 1 },
    build: async ({ tx, tenantId, salon, employee }) => {
      const s = await salon();
      const e = await employee();
      await tx.employeeSalonAssignment.create({
        data: {
          tenantId,
          employeeId: e.id,
          salonId: s.id,
          kind: "HOME",
          validFrom: new Date("2026-01-01"),
        },
      });
    },
  },
  {
    tag: "COUPLING",
    expected: { modules: ["INTEGRATIONS"], quota: 1 },
    build: async ({ tx, tenantId, salon }) => {
      const s = await salon();
      await tx.salonCoupling.create({
        data: {
          tenantId,
          salonId: s.id,
          provider: "PHOREST",
          externalBranchId: `branch-${suffix()}`,
        },
      });
    },
  },
  {
    tag: "REVOKED_API_KEY",
    expected: { modules: ["INTEGRATIONS"], quota: 1 },
    build: async ({ tx, tenantId, salon }) => {
      await salon();
      await tx.apiKey.create({
        data: {
          tenantId,
          ...keyFields(),
          scopes: [],
          createdBy: randomUUID(),
          revokedAt: new Date("2026-01-01"),
        },
      });
    },
  },
  {
    tag: "PHOREST_BUSINESS",
    expected: { modules: ["INTEGRATIONS"], quota: 1 },
    build: async ({ tx, tenantId, salon }) => {
      await salon();
      await setPhorest(tx, tenantId, { phorestBusinessId: "business-fixture" });
    },
  },
  {
    tag: "PHOREST_USER",
    expected: { modules: ["INTEGRATIONS"], quota: 1 },
    build: async ({ tx, tenantId, salon }) => {
      await salon();
      await setPhorest(tx, tenantId, { phorestUsername: "user-fixture" });
    },
  },
  {
    tag: "PHOREST_PASSWORD",
    expected: { modules: ["INTEGRATIONS"], quota: 1 },
    build: async ({ tx, tenantId, salon }) => {
      await salon();
      await setPhorest(tx, tenantId, { phorestPassword: "secret-fixture" });
    },
  },
  {
    tag: "PHOREST_BLANK",
    expected: { modules: [], quota: 1 },
    build: async ({ tx, tenantId, salon }) => {
      await salon();
      await setPhorest(tx, tenantId, { phorestBusinessId: "   " });
    },
  },
  {
    tag: "TERMINAL",
    expected: { modules: ["HARDWARE_CLOCK"], quota: 1 },
    build: async ({ tx, tenantId, salon }) => {
      await salon();
      await tx.terminalApiKey.create({ data: { tenantId, ...keyFields() } });
    },
  },
  {
    tag: "DELETED_SOURCE",
    expected: { modules: ["HARDWARE_CLOCK"], quota: 1 },
    build: async ({ tx, tenantId, salon }) => {
      await salon();
      await tx.presenceSource.create({
        data: {
          tenantId,
          ...keyFields(),
          isActive: false,
          revokedAt: new Date("2026-01-01"),
          deletedAt: new Date("2026-01-02"),
        },
      });
    },
  },
  {
    tag: "CLASSIFIED_ENTRY",
    expected: { modules: ["ANALYTICS"], quota: 1 },
    build: async ({ tx, salon, employee }) => {
      const s = await salon();
      const e = await employee();
      // Soft-deleted on purpose: a signal of use stays a signal after deletion.
      await addTimeEntry(tx, e.id, s.id, {
        activityKind: "PRODUCTIVE",
        deletedAt: new Date("2026-03-03"),
      });
    },
  },
  {
    tag: "ACTIVITY_SHARE",
    expected: { modules: ["ANALYTICS"], quota: 1 },
    build: async ({ tx, salon, employee }) => {
      const s = await salon();
      const e = await employee();
      const entry = await addTimeEntry(tx, e.id, s.id);
      await tx.timeEntryActivityShare.create({
        data: { timeEntryId: entry.id, kind: "SETUP_CLEANING", minutes: 15 },
      });
    },
  },
  {
    tag: "UNCLASSIFIED_ENTRY",
    expected: { modules: [], quota: 1 },
    build: async ({ tx, salon, employee }) => {
      const s = await salon();
      const e = await employee();
      await addTimeEntry(tx, e.id, s.id);
    },
  },
  {
    tag: "DEACTIVATED",
    deactivated: true,
    expected: { modules: ["CHAIN"], quota: 2 },
    build: async ({ salon }) => {
      await salon();
      await salon();
    },
  },
  {
    tag: "ALL_SIGNALS",
    expected: { modules: ["CHAIN", "INTEGRATIONS", "HARDWARE_CLOCK", "ANALYTICS"], quota: 2 },
    build: async ({ tx, tenantId, salon, employee }) => {
      const s = await salon();
      await salon();
      const e = await employee();
      await tx.salonCoupling.create({
        data: {
          tenantId,
          salonId: s.id,
          provider: "PHOREST",
          externalBranchId: `branch-${suffix()}`,
        },
      });
      await tx.terminalApiKey.create({ data: { tenantId, ...keyFields() } });
      await addTimeEntry(tx, e.id, s.id, { activityKind: "SETUP_CLEANING" });
    },
  },
  {
    tag: "OPERATOR_EDITED_A",
    edited: true,
    stored: { modules: [], quota: 3 },
    expected: { modules: [], quota: 3 },
    build: async ({ salon }) => {
      // Five active salons: a backfill that ran would raise the quota and grant CHAIN.
      for (let i = 0; i < 5; i += 1) await salon();
    },
  },
  {
    tag: "OPERATOR_EDITED_B",
    edited: true,
    stored: { modules: ["ANALYTICS"], quota: 1 },
    expected: { modules: ["ANALYTICS"], quota: 1 },
    build: async ({ salon }) => {
      await salon();
      await salon();
      await salon();
    },
  },
];

async function assign(
  tx: Tx,
  tenantId: string,
  employee: FixtureContext["employee"],
  scopeType: "TENANT" | "SALONS" | "PERSONS",
  scope: { salonIds?: string[]; employeeIds?: string[] },
): Promise<void> {
  const holder = await employee();
  const employeeRow = await tx.employee.findUniqueOrThrow({
    where: { id: holder.id },
    select: { userId: true },
  });
  // A system role (tenantId null) on purpose: the Phase 76b templates must never count as CHAIN.
  const role = await tx.accessRole.create({
    data: {
      tenantId: null,
      name: "Fixture system role",
      nameKey: `fixture-${suffix()}`,
      permissions: [],
    },
  });
  await tx.roleAssignment.create({
    data: {
      tenantId,
      userId: employeeRow.userId,
      accessRoleId: role.id,
      scopeType,
      salonIds: scope.salonIds ?? [],
      employeeIds: scope.employeeIds ?? [],
    },
  });
}

/** Creates one fixture tenant and resets it to its stored (pre-backfill) state. */
async function buildFixtureTenant(tx: Tx, spec: FixtureSpec): Promise<string> {
  const s = suffix();
  const { tenant } = await createTenantWithConfig(tx, {
    name: `Fixture ${spec.tag}`,
    slug: `pkg566-mig-${spec.tag.toLowerCase().replace(/_/g, "-")}-${s}`,
    federalState: "NIEDERSACHSEN",
  });
  const ctx: FixtureContext = {
    tx,
    tenantId: tenant.id,
    salon: (isActive = true) => createTestSalon(tx, tenant.id, { isActive }),
    employee: () => addEmployee(tx, tenant.id),
  };
  await spec.build(ctx);
  const stored = spec.stored ?? { modules: [], quota: 1 };
  await tx.tenant.update({
    where: { id: tenant.id },
    data: {
      bookedModules: stored.modules as TenantModule[],
      salonQuota: stored.quota,
      ...(spec.deactivated ? { deactivatedAt: new Date("2026-02-01") } : {}),
    },
  });
  return tenant.id;
}

async function readPackages(
  tx: Tx,
  ids: string[],
): Promise<Record<string, { modules: string[]; quota: number }>> {
  const rows = await tx.tenant.findMany({
    where: { id: { in: ids } },
    select: { id: true, bookedModules: true, salonQuota: true },
  });
  return Object.fromEntries(
    rows.map((r) => [r.id, { modules: [...(r.bookedModules ?? [])], quota: r.salonQuota }]),
  );
}

describe("Phase 566 — the Bestandsschutz backfill replayed on per-signal fixtures (D-09, AC-566-04)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  it("grants exactly what each tenant uses, keeps operator-edited tenants and is idempotent", async () => {
    const statements = splitDataSectionStatements(readDataSection());
    expect(statements).toHaveLength(1);

    type Captured = {
      ids: Record<string, string>;
      before: Record<string, { modules: string[]; quota: number }>;
      afterFirst: Record<string, { modules: string[]; quota: number }>;
      afterSecond: Record<string, { modules: string[]; quota: number }>;
    };
    let captured: Captured | undefined;

    await expect(
      app.prisma.$transaction(
        async (tx) => {
          const ids: Record<string, string> = {};
          for (const spec of FIXTURES) ids[spec.tag] = await buildFixtureTenant(tx, spec);
          const allIds = Object.values(ids);

          const before = await readPackages(tx, allIds);
          await tx.$executeRawUnsafe(statements[0]);
          const afterFirst = await readPackages(tx, allIds);
          // A second execution must change nothing: every granted or edited tenant is guarded.
          await tx.$executeRawUnsafe(statements[0]);
          const afterSecond = await readPackages(tx, allIds);

          captured = { ids, before, afterFirst, afterSecond };
          throw new PackagesMigrationReplayRollback(
            "deliberate rollback — these fixtures must never be committed",
          );
        },
        { timeout: 60000, maxWait: 30000 },
      ),
    ).rejects.toBeInstanceOf(PackagesMigrationReplayRollback);

    expect(captured, "the callback must have run to its end").toBeDefined();
    const { ids, before, afterFirst, afterSecond } = captured as Captured;

    for (const spec of FIXTURES) {
      const id = ids[spec.tag];
      const stored = spec.stored ?? { modules: [], quota: 1 };
      expect(before[id], `${spec.tag}: stored state before the section`).toEqual(stored);
      expect(afterFirst[id], `${spec.tag}: state after the first execution`).toEqual(spec.expected);
      expect(afterSecond[id], `${spec.tag}: state after the second execution`).toEqual(
        spec.expected,
      );
    }

    // The operator-edited tenants are asserted unchanged on their own, not only through the table.
    expect(afterFirst[ids.OPERATOR_EDITED_A]).toEqual(before[ids.OPERATOR_EDITED_A]);
    expect(afterFirst[ids.OPERATOR_EDITED_B]).toEqual(before[ids.OPERATOR_EDITED_B]);

    // Anti-vacuity: the catalogue produced a spread of grants, not 24 identical rows.
    const grantedKinds = new Set(Object.values(afterFirst).map((p) => p.modules.join(",")));
    expect(grantedKinds.size).toBeGreaterThanOrEqual(6);
  });
});
