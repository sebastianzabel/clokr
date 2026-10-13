/**
 * Phase 88 (D-04/D-04a) — `createTenantWithConfig` (L1) and `provisionTenant` (L2), the one
 * API-side place of the tenant-skeleton rule.
 *
 * Mutations, recorded here, not re-run by CI (Phase 88 plan 05, 2026-10-13), each run red then
 * restored from a `cp` backup:
 * - M1: hard-code `federalState: "NIEDERSACHSEN"` in the `createSalon` call -> red: "(b) L2
 *   creates exactly one active default salon in the REQUESTED Bundesland".
 * - M2: drop `federalState` from `tenant.create` in L1 -> red: same test (the tenant row falls
 *   back to the column default NIEDERSACHSEN while the caller asked for BAYERN).
 * - M3: hard-code the Bundesland in the salon create of `seed.ts` (and, separately, `seed-demo.ts`)
 *   -> red: the respective "seed parity" case; both seed files restored from `cp` backups.
 * - M1, M2 and M3 were observed red and restored. The atomicity case (c) has no recorded mutation:
 *   the only way to break it is to bypass the caller's `db`, which needs a second client that
 *   this suite does not construct.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, cleanupTestData, seedOperator } from "../../../__tests__/setup";
import {
  createTenantWithConfig,
  operatorEmployeeCreationAudit,
  provisionTenant,
  provisionTenantWithAdmin,
} from "../tenant-provisioning";
import { DEFAULT_SALON_OPENING_HOURS } from "../facade/salons";

function uniqueSlug(label: string): string {
  return `p88-${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

describe("tenant provisioning (Phase 88, D-04/D-04a)", () => {
  let app: FastifyInstance;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    for (const id of createdTenantIds) {
      await cleanupTestData(app, id);
    }
    await closeTestApp();
  });

  it("(a) L1 creates exactly one Tenant and one TenantConfig with the schema defaults", async () => {
    const slug = uniqueSlug("l1");
    const { tenant, config } = await app.prisma.$transaction((tx) =>
      createTenantWithConfig(tx, { name: `Tenant ${slug}`, slug, federalState: "BAYERN" }),
    );
    createdTenantIds.push(tenant.id);

    expect(await app.prisma.tenant.count({ where: { slug } })).toBe(1);
    expect(await app.prisma.tenantConfig.count({ where: { tenantId: tenant.id } })).toBe(1);
    expect(tenant.federalState).toBe("BAYERN");
    expect(Number(config.defaultVacationDays)).toBe(30);
    expect(config.timezone).toBe("Europe/Berlin");
    // L1 stops before the salon.
    expect(await app.prisma.salon.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it("(a) L1 honours a given timezone and a given id", async () => {
    const slug = uniqueSlug("l1tz");
    const id = `p88-id-${Math.random().toString(36).slice(2, 10)}`;
    const { tenant, config } = await app.prisma.$transaction((tx) =>
      createTenantWithConfig(tx, {
        id,
        name: `Tenant ${slug}`,
        slug,
        federalState: "NIEDERSACHSEN",
        timezone: "Europe/Lisbon",
      }),
    );
    createdTenantIds.push(tenant.id);

    expect(tenant.id).toBe(id);
    expect(config.timezone).toBe("Europe/Lisbon");
  });

  it("(b) L2 creates exactly one active default salon in the REQUESTED Bundesland", async () => {
    const slug = uniqueSlug("l2");
    const { tenant, salon } = await app.prisma.$transaction((tx) =>
      provisionTenant(tx, { name: `Tenant ${slug}`, slug, federalState: "BAYERN" }),
    );
    createdTenantIds.push(tenant.id);

    const salons = await app.prisma.salon.findMany({ where: { tenantId: tenant.id } });
    expect(salons).toHaveLength(1);
    expect(salons[0]?.id).toBe(salon.id);
    expect(tenant.federalState).toBe("BAYERN");
    expect(salon.isActive).toBe(true);
    expect(salon.deactivatedAt).toBeNull();
    expect(salon.name).toBe(tenant.name);
    expect(salon.federalState).toBe("BAYERN");
    expect(salon.openingHours).toEqual(DEFAULT_SALON_OPENING_HOURS);
  });

  it("(b) the salon Bundesland comes from the input even when it differs from the tenant row's", async () => {
    // The tenant row is written with the same input, so a divergence is only reachable if the
    // salon silently inherited something else; pin the salon value against the input directly.
    const slug = uniqueSlug("l2b");
    const { tenant, salon } = await app.prisma.$transaction((tx) =>
      provisionTenant(tx, { name: `Tenant ${slug}`, slug, federalState: "BERLIN" }),
    );
    createdTenantIds.push(tenant.id);
    expect(salon.federalState).toBe("BERLIN");
    expect(salon.federalState).not.toBe("NIEDERSACHSEN");
  });

  it("(c) atomic: a failure after provisionTenant inside the caller's transaction leaves nothing behind", async () => {
    const slug = uniqueSlug("atom");
    await expect(
      app.prisma.$transaction(async (tx) => {
        await provisionTenant(tx, { name: `Tenant ${slug}`, slug, federalState: "HESSEN" });
        throw new Error("boom after provisioning");
      }),
    ).rejects.toThrow("boom after provisioning");

    expect(await app.prisma.tenant.count({ where: { slug } })).toBe(0);
    expect(await app.prisma.salon.count({ where: { name: `Tenant ${slug}` } })).toBe(0);
  });

  it("(d) a second provisioning with the same slug is rejected with P2002", async () => {
    const slug = uniqueSlug("dup");
    const first = await app.prisma.$transaction((tx) =>
      provisionTenant(tx, { name: `Tenant ${slug}`, slug, federalState: "BAYERN" }),
    );
    createdTenantIds.push(first.tenant.id);

    await expect(
      app.prisma.$transaction((tx) =>
        provisionTenant(tx, { name: `Tenant ${slug} again`, slug, federalState: "BAYERN" }),
      ),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

// ── Seed parity (D-04a deviation) ─────────────────────────────────────────────────────────
// packages/db cannot import apps/api (research F1, packages/db/src/default-salon.ts:1-12), so
// `seed.ts` and `seed-demo.ts` keep their own tenant bootstrap. The rule's owner is
// `provisionTenant`; the seeds are a pinned copy — a change to one without the other turns this
// block red. Source-level, like salon-migration.test.ts: the seed modules run a whole seed on
// import and are never loaded here.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");

/** The `prisma.salon.create({ ... })` call of a seed module, braces balanced. */
function salonCreateCall(source: string): string {
  const start = source.indexOf("prisma.salon.create(");
  expect(start, "no prisma.salon.create( call in the seed module").toBeGreaterThan(-1);
  expect(source.indexOf("prisma.salon.create(", start + 1), "more than one salon per tenant").toBe(
    -1,
  );
  let depth = 0;
  for (let i = source.indexOf("(", start); i < source.length; i++) {
    if (source[i] === "(") depth++;
    if (source[i] === ")") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced prisma.salon.create( call");
}

describe("seed parity — D-04a deviation", () => {
  const seeds = ["packages/db/src/seed.ts", "packages/db/src/seed-demo.ts"] as const;

  for (const rel of seeds) {
    it(`${rel} creates one salon with the tenant name, the tenant's Bundesland and the default opening hours, plus a TenantConfig`, () => {
      const source = readFileSync(join(REPO_ROOT, rel), "utf8");
      const call = salonCreateCall(source);
      expect(call).toMatch(/tenantId:\s*tenant\.id/);
      expect(call).toMatch(/name:\s*tenant\.name/);
      expect(call).toMatch(/federalState:\s*tenant\.federalState/);
      expect(call).toMatch(/openingHours:\s*DEFAULT_SALON_OPENING_HOURS\b/);
      expect(call).toMatch(/isActive:\s*true/);
      expect(source).toMatch(/prisma\.tenantConfig\.(create|upsert)\(/);
      expect(source).toMatch(/tenantId:\s*tenant\.id/);
    });
  }

  it("provisionTenant produces a salon with the same three properties", async () => {
    const app = await getTestApp();
    const slug = uniqueSlug("parity");
    const { tenant, salon } = await app.prisma.$transaction((tx) =>
      provisionTenant(tx, { name: `Tenant ${slug}`, slug, federalState: "SACHSEN" }),
    );
    try {
      expect(salon.name).toBe(tenant.name);
      expect(salon.federalState).toBe(tenant.federalState);
      expect(salon.openingHours).toEqual(DEFAULT_SALON_OPENING_HOURS);
    } finally {
      await cleanupTestData(app, tenant.id);
    }
  });
});

// ── L3: the tenant with its first admin ───────────────────────────────────────────────────
// Mutation, recorded here, not re-run by CI (Phase 88 plan 10, 2026-10-13), run red then restored
// from a `cp` backup:
// - M4: drop `actor` from the operator port's `newValue` -> red: "(f) every audit row of the
//   provisioning has an empty userId and the OPERATOR actor".
// - M5: pass a tenant-user-shaped `userId` (a fake id) in the operator port -> red: the audit insert
//   violates the User foreign key, so every L3 case fails, (f) among them.
describe("provisionTenantWithAdmin (L3, Phase 88 plan 10)", () => {
  let app: FastifyInstance;
  let operatorId: string;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    app = await getTestApp();
    operatorId = (await seedOperator(app)).id;
  });

  afterAll(async () => {
    for (const id of createdTenantIds) {
      await cleanupTestData(app, id);
    }
    await closeTestApp();
  });

  function provision(slug: string, email: string, federalState: "HESSEN" | "BAYERN" = "HESSEN") {
    return app.prisma.$transaction((tx) =>
      provisionTenantWithAdmin(
        tx,
        {
          tenant: { name: `Tenant ${slug}`, slug, federalState },
          admin: { email, firstName: "Erste", lastName: "Leitung" },
        },
        operatorEmployeeCreationAudit(app, { operatorId }),
      ),
    );
  }

  it("(e) creates one tenant, config, salon, admin employee and the rows every employee gets", async () => {
    const slug = uniqueSlug("l3");
    const email = `${slug}@example.invalid`;
    const result = await provision(slug, email);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    createdTenantIds.push(result.tenant.id);

    const tenantId = result.tenant.id;
    expect(await app.prisma.tenantConfig.count({ where: { tenantId } })).toBe(1);
    const salons = await app.prisma.salon.findMany({ where: { tenantId } });
    expect(salons).toHaveLength(1);
    expect(salons[0].federalState).toBe("HESSEN");
    expect(salons[0].isActive).toBe(true);

    const employees = await app.prisma.employee.findMany({
      where: { tenantId },
      include: { user: true, workSchedules: true, overtimeAccount: true },
    });
    expect(employees).toHaveLength(1);
    const [employee] = employees;
    expect(employee.employeeNumber).toBe("1");
    // Inactive until the invitation is accepted; no password was ever set by the operator.
    expect(employee.user.role).toBe("ADMIN");
    expect(employee.user.isActive).toBe(false);
    expect(employee.user.email).toBe(email);

    // Track-only contract: no monthly hours, so no Soll and no phantom saldo.
    expect(employee.workSchedules).toHaveLength(1);
    expect(employee.workSchedules[0].type).toBe("MONTHLY_HOURS");
    expect(employee.workSchedules[0].monthlyHours).toBeNull();
    expect(employee.workSchedules[0].validFrom.getTime()).toBe(employee.hireDate.getTime());
    expect(employee.overtimeAccount).not.toBeNull();
    expect(Number(employee.overtimeAccount!.balanceHours)).toBe(0);

    // The system role assignment and the Stammsalon (HOME) row on the new default salon.
    const assignments = await app.prisma.roleAssignment.findMany({
      where: { userId: employee.userId },
    });
    expect(assignments).toHaveLength(1);
    const homeRows = await app.prisma.employeeSalonAssignment.findMany({
      where: { tenantId, employeeId: employee.id },
    });
    expect(homeRows).toHaveLength(1);
    expect(homeRows[0].salonId).toBe(salons[0].id);

    // One open invitation of about 24 hours; the stored token is the hash, not the raw token.
    const invitations = await app.prisma.invitation.findMany({
      where: { employeeId: employee.id },
    });
    expect(invitations).toHaveLength(1);
    expect(invitations[0].acceptedAt).toBeNull();
    const lifetimeMs = invitations[0].expiresAt.getTime() - invitations[0].createdAt.getTime();
    expect(Math.abs(lifetimeMs - 24 * 60 * 60 * 1000)).toBeLessThan(60_000);
    expect(invitations[0].token).not.toBe(result.invitationToken);
    expect(result.invitationToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("(f) every audit row of the provisioning has an empty userId and the OPERATOR actor", async () => {
    const slug = uniqueSlug("l3audit");
    const result = await provision(slug, `${slug}@example.invalid`);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    createdTenantIds.push(result.tenant.id);

    const employeeId = result.employee.id;
    const homeRow = await app.prisma.employeeSalonAssignment.findFirstOrThrow({
      where: { employeeId },
    });
    const roleRow = await app.prisma.roleAssignment.findFirstOrThrow({
      where: { userId: result.user.id },
    });
    const rows = await app.prisma.auditLog.findMany({
      where: { entityId: { in: [employeeId, homeRow.id, roleRow.id] } },
    });

    const kinds = rows.map((row) => `${row.entity}:${row.action}`).sort();
    expect(kinds).toEqual(
      ["Employee:CREATE", "EmployeeSalonAssignment:CREATE", "RoleAssignment:CREATE"].sort(),
    );
    for (const row of rows) {
      expect(row.userId, `${row.entity} row must not name a tenant user`).toBeNull();
      expect((row.newValue as { actor?: unknown }).actor).toEqual({
        type: "OPERATOR",
        operatorId,
      });
    }
    // The new admin did not "do" any of it.
    expect(await app.prisma.auditLog.count({ where: { userId: result.user.id } })).toBe(0);
  });

  it("(g) an existing admin e-mail is EMAIL_TAKEN and leaves no tenant behind", async () => {
    const first = uniqueSlug("l3mail");
    const email = `${first}@example.invalid`;
    const created = await provision(first, email);
    expect(created.status).toBe("OK");
    if (created.status === "OK") createdTenantIds.push(created.tenant.id);

    const second = uniqueSlug("l3mail2");
    const result = await provision(second, email);
    expect(result).toEqual({ status: "EMAIL_TAKEN" });
    expect(await app.prisma.tenant.count({ where: { slug: second } })).toBe(0);
  });

  it("(g) an existing slug is SLUG_TAKEN and leaves no rows behind", async () => {
    const slug = uniqueSlug("l3slug");
    const created = await provision(slug, `${slug}@example.invalid`);
    expect(created.status).toBe("OK");
    if (created.status === "OK") createdTenantIds.push(created.tenant.id);

    const otherEmail = `${slug}-other@example.invalid`;
    const result = await provision(slug, otherEmail);
    expect(result).toEqual({ status: "SLUG_TAKEN" });
    expect(await app.prisma.user.count({ where: { email: otherEmail } })).toBe(0);
    expect(await app.prisma.tenant.count({ where: { slug } })).toBe(1);
  });

  it("(g) invalid admin input is INVALID before any write", async () => {
    const slug = uniqueSlug("l3bad");
    const result = await provision(slug, "not-an-email");
    expect(result.status).toBe("INVALID");
    expect(await app.prisma.tenant.count({ where: { slug } })).toBe(0);
  });

  it("(g) atomic: a failure after L3 inside the caller's transaction leaves nothing behind", async () => {
    const slug = uniqueSlug("l3atom");
    const email = `${slug}@example.invalid`;
    await expect(
      app.prisma.$transaction(async (tx) => {
        const result = await provisionTenantWithAdmin(
          tx,
          {
            tenant: { name: `Tenant ${slug}`, slug, federalState: "BAYERN" },
            admin: { email, firstName: "Erste", lastName: "Leitung" },
          },
          operatorEmployeeCreationAudit(app, { operatorId }),
        );
        expect(result.status).toBe("OK");
        throw new Error("boom after L3");
      }),
    ).rejects.toThrow("boom after L3");
    expect(await app.prisma.tenant.count({ where: { slug } })).toBe(0);
    expect(await app.prisma.user.count({ where: { email } })).toBe(0);
  });
});
