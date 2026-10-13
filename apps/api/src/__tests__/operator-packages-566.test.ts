/**
 * Phase 566 (#566), plan 03 — the operator books and cancels packages and sets the salon quota per
 * tenant through PUT /api/v1/operator/tenants/:id/packages. Every effective change is recorded
 * twice in one transaction (OperatorAuditLog + the tenant's own AuditLog) and is never retroactive.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedGrundversionTenant,
  seedOperator,
  createTestSalon,
  cleanupTestData,
} from "./setup";
import { signOperatorToken } from "../contexts/platform/operator-auth";

const BASE = "/api/v1/operator/tenants";

let app: FastifyInstance;
let operatorId: string;
let operatorToken: string;
let addressCounter = 0;
const tenants: Awaited<ReturnType<typeof seedGrundversionTenant>>[] = [];

/** Every request carries its own remote address so the per-route rate limits never interfere. */
function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.566.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function call(method: "GET" | "POST" | "PUT", url: string, token?: string, body?: unknown) {
  return app.inject({
    method,
    url,
    ...(body !== undefined ? { payload: body as object } : {}),
    headers: {
      "user-agent": "vitest-operator-packages",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    remoteAddress: uniqueAddress(),
  });
}

function putPackages(tenantId: string, body: unknown, token: string | undefined = operatorToken) {
  return call("PUT", `${BASE}/${tenantId}/packages`, token, body);
}

async function newGrundversionTenant(label: string) {
  const fixture = await seedGrundversionTenant(app, `op566-${label}`);
  tenants.push(fixture);
  return fixture;
}

function packageAuditRows(tenantId: string) {
  return app.prisma.operatorAuditLog.findMany({
    where: { action: "TENANT_PACKAGES_CHANGED", subjectTenantId: tenantId },
  });
}

function tenantPackageAuditRows(tenantId: string) {
  return app.prisma.auditLog.findMany({
    where: { entity: "TenantPackages", entityId: tenantId },
  });
}

async function storedPackages(tenantId: string) {
  const row = await app.prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { bookedModules: true, salonQuota: true },
  });
  return { bookedModules: row.bookedModules ?? [], salonQuota: row.salonQuota };
}

beforeAll(async () => {
  app = await getTestApp();
  const operator = await seedOperator(app);
  operatorId = operator.id;
  operatorToken = signOperatorToken(app, operatorId, "access", operator.tokenVersion);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const t of tenants) {
    try {
      await cleanupTestData(app, t.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  }
  await closeTestApp();
});

describe("PUT /api/v1/operator/tenants/:id/packages (tracer)", () => {
  it("(a) stores the normalised packages and answers the tenant DTO with the packages", async () => {
    const t = await newGrundversionTenant("tracer");

    const res = await putPackages(t.tenant.id, {
      bookedModules: ["ANALYTICS", "CHAIN", "CHAIN"],
      salonQuota: 3,
    });
    expect(res.statusCode, res.body).toBe(200);
    const dto = JSON.parse(res.body) as {
      id: string;
      packages: { bookedModules: string[]; salonQuota: number; activeSalonCount: number };
    };
    expect(dto.id).toBe(t.tenant.id);
    expect(dto.packages).toEqual({
      bookedModules: ["CHAIN", "ANALYTICS"],
      salonQuota: 3,
      activeSalonCount: 1,
    });
    expect(await storedPackages(t.tenant.id)).toEqual({
      bookedModules: ["CHAIN", "ANALYTICS"],
      salonQuota: 3,
    });
  });

  it("(b) writes one operator audit row and one stamped tenant audit row", async () => {
    const t = await newGrundversionTenant("audit");

    const res = await putPackages(t.tenant.id, {
      bookedModules: ["ANALYTICS", "CHAIN"],
      salonQuota: 4,
    });
    expect(res.statusCode, res.body).toBe(200);

    const operatorRows = await packageAuditRows(t.tenant.id);
    expect(operatorRows).toHaveLength(1);
    expect(operatorRows[0].operatorId).toBe(operatorId);
    expect(operatorRows[0].entity).toBe("Tenant");
    expect(operatorRows[0].entityId).toBe(t.tenant.id);
    expect(operatorRows[0].oldValue).toEqual({ bookedModules: [], salonQuota: 1 });
    expect(operatorRows[0].newValue).toEqual({
      bookedModules: ["CHAIN", "ANALYTICS"],
      salonQuota: 4,
    });

    const tenantRows = await tenantPackageAuditRows(t.tenant.id);
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0].action).toBe("UPDATE");
    expect(tenantRows[0].userId).toBeNull();
    expect(tenantRows[0].oldValue).toEqual({ bookedModules: [], salonQuota: 1 });
    expect(tenantRows[0].newValue).toEqual({
      bookedModules: ["CHAIN", "ANALYTICS"],
      salonQuota: 4,
      actor: { type: "OPERATOR", operatorId, tenantId: t.tenant.id },
    });
  });

  it("(c) the salon quota honours the new package: a second salon can now be activated", async () => {
    const t = await newGrundversionTenant("honours");
    const second = await createTestSalon(app.prisma, t.tenant.id, {
      name: "Zweiter Salon",
      isActive: false,
    });
    const activate = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/salons/${second.id}/activate`,
        headers: { authorization: `Bearer ${t.adminToken}` },
      });

    // Grundversion: one salon, the second activation is refused.
    expect((await activate()).statusCode).toBe(409);

    expect(
      (await putPackages(t.tenant.id, { bookedModules: ["CHAIN"], salonQuota: 3 })).statusCode,
    ).toBe(200);

    const ok = await activate();
    expect(ok.statusCode, ok.body).toBe(200);
    expect(JSON.parse(ok.body).isActive).toBe(true);
  });
});
