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
import { lockTenantForPackages } from "../contexts/platform/tenant-packages";

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

/**
 * Holds the Tenant lock of `tenantId` in an open transaction, starts the PUT, waits until
 * PostgreSQL reports a backend blocked by the holder (observed state, never a fixed sleep), checks
 * the PUT has not settled, releases the holder and expects the PUT to complete with 200.
 */
async function expectPutWaitsOnTenantLock(tenantId: string, body: unknown) {
  let releaseHolder: (() => void) | undefined;
  const holdGate = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  let signalHolderLocked: ((pid: number) => void) | undefined;
  const holderLocked = new Promise<number>((resolve) => {
    signalHolderLocked = resolve;
  });
  const holder = app.prisma.$transaction(
    async (tx) => {
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await lockTenantForPackages(tx, tenantId);
      signalHolderLocked?.(pid);
      await holdGate;
    },
    { timeout: 20000, maxWait: 20000 },
  );
  const holderPid = await Promise.race([
    holderLocked,
    holder.then(() => Promise.reject(new Error("holder ended before it signalled"))),
  ]);

  let settled = false;
  const put = putPackages(tenantId, body).finally(() => {
    settled = true;
  });

  const deadline = Date.now() + 10000;
  let waiting = false;
  while (!settled && Date.now() < deadline) {
    const rows = await app.prisma.$queryRaw<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity
      WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
    if (rows.length > 0) {
      waiting = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(waiting).toBe(true);
  expect(settled).toBe(false);

  releaseHolder?.();
  await holder;
  const res = await put;
  expect(res.statusCode, res.body).toBe(200);
}

const DEACTIVATED_SENTENCE =
  "Der Mandant ist deaktiviert. Änderungen sind erst nach der Reaktivierung möglich.";

describe("PUT /api/v1/operator/tenants/:id/packages (edges)", () => {
  it("(d) an unchanged request, also in another order or with duplicates, writes nothing", async () => {
    const t = await newGrundversionTenant("unchanged");
    const body = { bookedModules: ["CHAIN", "ANALYTICS"], salonQuota: 2 };

    const first = await putPackages(t.tenant.id, body);
    expect(first.statusCode, first.body).toBe(200);
    expect(await packageAuditRows(t.tenant.id)).toHaveLength(1);
    expect(await tenantPackageAuditRows(t.tenant.id)).toHaveLength(1);

    for (const again of [
      body,
      { bookedModules: ["ANALYTICS", "CHAIN"], salonQuota: 2 },
      { bookedModules: ["ANALYTICS", "CHAIN", "ANALYTICS"], salonQuota: 2 },
    ]) {
      const res = await putPackages(t.tenant.id, again);
      expect(res.statusCode, res.body).toBe(200);
      expect(JSON.parse(res.body).packages).toEqual({
        bookedModules: ["CHAIN", "ANALYTICS"],
        salonQuota: 2,
        activeSalonCount: 1,
      });
    }
    expect(await packageAuditRows(t.tenant.id)).toHaveLength(1);
    expect(await tenantPackageAuditRows(t.tenant.id)).toHaveLength(1);
  });

  it("(e) rejects an invalid body with 400 and stores nothing", async () => {
    const t = await newGrundversionTenant("invalid");
    const invalid: unknown[] = [
      { bookedModules: [], salonQuota: 1, extra: 1 },
      { bookedModules: [], salonQuota: 0 },
      { bookedModules: [], salonQuota: 501 },
      { bookedModules: [], salonQuota: 2.5 },
      { bookedModules: [], salonQuota: "3" },
      { bookedModules: [] },
      { salonQuota: 2 },
      { bookedModules: ["UNKNOWN"], salonQuota: 2 },
      {
        bookedModules: ["CHAIN", "CHAIN", "ANALYTICS", "INTEGRATIONS", "HARDWARE_CLOCK"],
        salonQuota: 2,
      },
      { bookedModules: "CHAIN", salonQuota: 2 },
    ];
    for (const body of invalid) {
      const res = await putPackages(t.tenant.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await storedPackages(t.tenant.id)).toEqual({ bookedModules: [], salonQuota: 1 });
    expect(await packageAuditRows(t.tenant.id)).toHaveLength(0);
    expect(await tenantPackageAuditRows(t.tenant.id)).toHaveLength(0);
  });

  it("(f) answers an unknown tenant with 404 and a malformed id with 400", async () => {
    const res = await putPackages(randomUUID(), { bookedModules: [], salonQuota: 1 });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Mandant nicht gefunden" });

    const malformed = await call("PUT", `${BASE}/not-a-uuid/packages`, operatorToken, {
      bookedModules: [],
      salonQuota: 1,
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("(g) refuses a deactivated tenant with 409 TENANT_DEACTIVATED and writes nothing", async () => {
    const t = await newGrundversionTenant("dead");
    const deactivate = await call("POST", `${BASE}/${t.tenant.id}/deactivate`, operatorToken, {
      reason: "Vertrag beendet",
    });
    expect(deactivate.statusCode, deactivate.body).toBe(200);

    const res = await putPackages(t.tenant.id, { bookedModules: ["CHAIN"], salonQuota: 5 });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: DEACTIVATED_SENTENCE,
      code: "TENANT_DEACTIVATED",
    });
    expect(await storedPackages(t.tenant.id)).toEqual({ bookedModules: [], salonQuota: 1 });
    expect(await packageAuditRows(t.tenant.id)).toHaveLength(0);
    expect(await tenantPackageAuditRows(t.tenant.id)).toHaveLength(0);
  });

  it("(h) refuses a tenant admin token with 403 (TENANT_PRINCIPAL_REFUSED row) and no token with 401", async () => {
    const t = await newGrundversionTenant("refused");
    const body = { bookedModules: ["CHAIN"], salonQuota: 50 };

    const tenantToken = await putPackages(t.tenant.id, body, t.adminToken);
    expect(tenantToken.statusCode).toBe(403);
    const refusals = await app.prisma.operatorAuditLog.findMany({
      where: { action: "TENANT_PRINCIPAL_REFUSED", subjectTenantId: t.tenant.id },
    });
    expect(refusals.length).toBeGreaterThanOrEqual(1);

    const anonymous = await call("PUT", `${BASE}/${t.tenant.id}/packages`, undefined, body);
    expect(anonymous.statusCode).toBe(401);

    expect(await storedPackages(t.tenant.id)).toEqual({ bookedModules: [], salonQuota: 1 });
    expect(await packageAuditRows(t.tenant.id)).toHaveLength(0);
  });

  it("(i) rolls the change and the operator row back when the tenant audit write fails", async () => {
    const t = await newGrundversionTenant("rollback");
    const realAudit = app.audit.bind(app);
    vi.spyOn(app, "audit").mockImplementation(async (entry) => {
      if (entry.entity === "TenantPackages") throw new Error("forced audit failure (test)");
      return realAudit(entry);
    });

    const res = await putPackages(t.tenant.id, { bookedModules: ["CHAIN"], salonQuota: 9 });
    expect(res.statusCode).toBe(500);

    vi.restoreAllMocks();
    expect(await storedPackages(t.tenant.id)).toEqual({ bookedModules: [], salonQuota: 1 });
    expect(await packageAuditRows(t.tenant.id)).toHaveLength(0);
    expect(await tenantPackageAuditRows(t.tenant.id)).toHaveLength(0);
  });

  it("(j) is never retroactive: lowering the quota and cancelling CHAIN keeps every active salon", async () => {
    const t = await newGrundversionTenant("retro");
    await app.prisma.tenant.update({
      where: { id: t.tenant.id },
      data: { bookedModules: ["CHAIN"], salonQuota: 3 },
    });
    const extra = [
      await createTestSalon(app.prisma, t.tenant.id, { name: "Salon Zwei", isActive: true }),
      await createTestSalon(app.prisma, t.tenant.id, { name: "Salon Drei", isActive: true }),
    ];
    const salonIds = [t.salonId, ...extra.map((s) => s.id)];
    expect(await app.prisma.salon.count({ where: { tenantId: t.tenant.id, isActive: true } })).toBe(
      3,
    );

    const res = await putPackages(t.tenant.id, { bookedModules: [], salonQuota: 1 });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).packages).toEqual({
      bookedModules: [],
      salonQuota: 1,
      activeSalonCount: 3,
    });

    const salons = await app.prisma.salon.findMany({
      where: { id: { in: salonIds } },
      select: { isActive: true },
    });
    expect(salons).toHaveLength(3);
    expect(salons.every((s) => s.isActive)).toBe(true);
  });

  it("(k) the package write waits on the same Tenant lock as the salon quota check", async () => {
    // An UNCHANGED request never updates the row, so only the explicit lock can make it wait; the
    // changing request additionally proves the write itself serialises behind the holder.
    const t = await newGrundversionTenant("lock");
    await expectPutWaitsOnTenantLock(t.tenant.id, { bookedModules: [], salonQuota: 1 });
    expect(await storedPackages(t.tenant.id)).toEqual({ bookedModules: [], salonQuota: 1 });

    await expectPutWaitsOnTenantLock(t.tenant.id, { bookedModules: ["CHAIN"], salonQuota: 2 });
    expect(await storedPackages(t.tenant.id)).toEqual({ bookedModules: ["CHAIN"], salonQuota: 2 });
  });
});
