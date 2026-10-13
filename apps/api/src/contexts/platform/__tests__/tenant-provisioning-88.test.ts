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
 * - M1 and M2 were observed red and restored. The atomicity case (c) has no recorded mutation:
 *   the only way to break it is to bypass the caller's `db`, which needs a second client that
 *   this suite does not construct.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, cleanupTestData } from "../../../__tests__/setup";
import { createTenantWithConfig, provisionTenant } from "../tenant-provisioning";
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
