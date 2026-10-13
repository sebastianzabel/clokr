/**
 * Phase 89 plan 01 (#89, D-05/D-06/D-07/D-12/D-16) — the operator reads a tenant's salons through
 * GET /api/v1/operator/tenants/:id/salons: master data plus the Phorest coupling, inactive salons
 * included, metadata only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  seedOperator,
  cleanupTestData,
  createTestSalon,
} from "./setup";
import { signOperatorToken } from "../contexts/platform/operator-auth";

const TENANT_BASE = "/api/v1/operator/tenants";

let app: FastifyInstance;
let dataA: Awaited<ReturnType<typeof seedTestData>>;
let dataB: Awaited<ReturnType<typeof seedTestData>>;
let operatorToken: string;
let addressCounter = 0;

/** Every request carries its own remote address so the per-route rate limits never interfere. */
function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.89.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function call(url: string, token?: string) {
  return app.inject({
    method: "GET",
    url,
    headers: {
      "user-agent": "vitest-operator-salons",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    remoteAddress: uniqueAddress(),
  });
}

function salonsUrl(tenantId: string) {
  return `${TENANT_BASE}/${tenantId}/salons`;
}

interface SalonDto {
  id: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
  coupling: { provider: string; externalBranchId: string } | null;
  createdAt: string;
  [key: string]: unknown;
}

const DTO_KEYS = [
  "city",
  "coupling",
  "createdAt",
  "deactivatedAt",
  "federalState",
  "id",
  "isActive",
  "isDefault",
  "name",
  "openingHours",
  "postalCode",
  "street",
];

function byKey(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

beforeAll(async () => {
  app = await getTestApp();
  dataA = await seedTestData(app, "os89a");
  dataB = await seedTestData(app, "os89b");
  const operator = await seedOperator(app);
  operatorToken = signOperatorToken(app, operator.id, "access", operator.tokenVersion);
});

afterAll(async () => {
  await cleanupTestData(app, dataA.tenant.id);
  await cleanupTestData(app, dataB.tenant.id);
  await closeTestApp();
});

describe("GET /api/v1/operator/tenants/:id/salons", () => {
  it("lists every salon of the tenant, inactive included, ordered createdAt then id", async () => {
    const t0 = Date.now() - 3 * 24 * 3600 * 1000;
    const inactive = await createTestSalon(app.prisma, dataA.tenant.id, {
      name: "Inaktiv",
      isActive: false,
      createdAt: new Date(t0),
    });
    const active = await createTestSalon(app.prisma, dataA.tenant.id, {
      name: "Aktiv",
      createdAt: new Date(t0 + 1000),
    });

    const res = await call(salonsUrl(dataA.tenant.id), operatorToken);
    expect(res.statusCode, res.body).toBe(200);
    const list = JSON.parse(res.body) as SalonDto[];

    const ids = list.map((s) => s.id);
    expect(ids).toContain(inactive.id);
    expect(ids).toContain(active.id);
    const stamps = list.map((s) => new Date(s.createdAt).getTime());
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(list.find((s) => s.id === inactive.id)?.isActive).toBe(false);
    expect(ids.indexOf(inactive.id)).toBeLessThan(ids.indexOf(active.id));
  });

  it("returns exactly the twelve DTO keys per salon", async () => {
    const res = await call(salonsUrl(dataA.tenant.id), operatorToken);
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body) as SalonDto[];
    expect(list.length).toBeGreaterThan(0);
    for (const item of list) {
      expect(Object.keys(item).sort(byKey)).toEqual(DTO_KEYS);
    }
  });

  it("marks isDefault on the first ACTIVE salon only, also when the earliest salon is inactive", async () => {
    const res = await call(salonsUrl(dataA.tenant.id), operatorToken);
    const list = JSON.parse(res.body) as SalonDto[];
    const firstActive = list.find((s) => s.isActive);
    expect(firstActive).toBeDefined();
    expect(list.filter((s) => s.isDefault).map((s) => s.id)).toEqual([firstActive!.id]);

    // Tenant B: only an inactive salon created first, then an active one.
    const t0 = Date.now() - 5 * 24 * 3600 * 1000;
    const earlyInactive = await createTestSalon(app.prisma, dataB.tenant.id, {
      isActive: false,
      createdAt: new Date(t0),
    });
    const lateActive = await createTestSalon(app.prisma, dataB.tenant.id, {
      createdAt: new Date(t0 + 1000),
    });
    const resB = await call(salonsUrl(dataB.tenant.id), operatorToken);
    const listB = JSON.parse(resB.body) as SalonDto[];
    expect(listB.find((s) => s.id === earlyInactive.id)?.isDefault).toBe(false);
    expect(listB.filter((s) => s.isDefault).length).toBe(1);
    const firstActiveB = listB.find((s) => s.isActive);
    expect(firstActiveB?.isDefault).toBe(true);
    expect(listB.map((s) => s.id)).toContain(lateActive.id);
  });

  it("joins the Phorest coupling onto its salon and leaves the others null", async () => {
    const coupled = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Gekoppelt" });
    const branch = `branch-${randomUUID()}`;
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: dataA.tenant.id,
        salonId: coupled.id,
        provider: "PHOREST",
        externalBranchId: branch,
      },
    });

    const res = await call(salonsUrl(dataA.tenant.id), operatorToken);
    const list = JSON.parse(res.body) as SalonDto[];
    expect(list.find((s) => s.id === coupled.id)?.coupling).toEqual({
      provider: "PHOREST",
      externalBranchId: branch,
    });
    for (const s of list.filter((x) => x.id !== coupled.id)) expect(s.coupling).toBeNull();
  });

  it("answers an unknown tenant with the fixed 404 body and a malformed id with 400", async () => {
    const unknown = await call(salonsUrl(randomUUID()), operatorToken);
    expect(unknown.statusCode).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({ error: "Mandant nicht gefunden" });

    const malformed = await call(salonsUrl("not-a-uuid"), operatorToken);
    expect(malformed.statusCode).toBe(400);
  });

  it("refuses a tenant admin token with 403 and an audit row, and no token with 401", async () => {
    const res = await call(salonsUrl(dataA.tenant.id), dataA.adminToken);
    expect(res.statusCode).toBe(403);

    const refusals = await app.prisma.operatorAuditLog.findMany({
      where: { action: "TENANT_PRINCIPAL_REFUSED", subjectTenantId: dataA.tenant.id },
    });
    expect(refusals.length).toBeGreaterThanOrEqual(1);

    expect((await call(salonsUrl(dataA.tenant.id))).statusCode).toBe(401);
  });

  it("never leaks a salon id of another tenant", async () => {
    const foreign = await createTestSalon(app.prisma, dataB.tenant.id, { name: "Fremd" });
    const res = await call(salonsUrl(dataA.tenant.id), operatorToken);
    const list = JSON.parse(res.body) as SalonDto[];
    expect(list.map((s) => s.id)).not.toContain(foreign.id);
    expect(res.body).not.toContain(foreign.id);
  });
});
