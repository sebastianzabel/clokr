/**
 * Issue #93 (Phase 93b-02) — the support access tracer over HTTP: an operator requests a grant
 * (`POST /api/v1/operator/tenants/:id/support-access`), reads the tenant's curated employee list under
 * it (`GET /api/v1/operator/tenants/:id/support/employees`), and both protocols record the read before
 * the data leaves the server. Without a grant — or when the grant ends while the read waits — nothing is
 * returned and the refusal is logged.
 *
 * Operator accounts are never deleted by tests (audit rows reference them with onDelete Restrict), so
 * every case that needs a fresh principal seeds a fresh synthetic operator. Tenants are cleaned up in
 * `afterAll`, which also removes their grants through the trigger-disabled delete of `cleanupTestData`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedGrundversionTenant,
  seedOperator,
  seedSupportAccess,
  cleanupTestData,
} from "./setup";
import { signOperatorToken } from "../contexts/platform/operator-auth";

type Fixture = Awaited<ReturnType<typeof seedGrundversionTenant>>;
type Principal = { id: string; token: string };

const REASON = "Support ticket: employee list does not load";
const GRANT_KEYS = [
  "durationHours",
  "endedAt",
  "endedBy",
  "expiresAt",
  "id",
  "reason",
  "startedAt",
  "status",
  "tenantId",
];
const EMPLOYEE_KEYS = [
  "employeeNumber",
  "exitDate",
  "firstName",
  "hireDate",
  "homeSalon",
  "id",
  "lastName",
  "scheduleType",
  "status",
];
const byKey = (a: string, b: string) => a.localeCompare(b);

let app: FastifyInstance;
let addressCounter = 0;
const tenants: Fixture[] = [];

/** Every request carries its own remote address so the per-route rate limits never interfere. */
function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.93.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

async function newTenant(label: string): Promise<Fixture> {
  const fixture = await seedGrundversionTenant(app, `g93-${label}`);
  tenants.push(fixture);
  return fixture;
}

async function newPrincipal(): Promise<Principal> {
  const operator = await seedOperator(app);
  return {
    id: operator.id,
    token: signOperatorToken(app, operator.id, "access", operator.tokenVersion),
  };
}

function requestGrant(tenantId: string, token: string, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/operator/tenants/${tenantId}/support-access`,
    headers: { authorization: `Bearer ${token}`, "user-agent": "vitest-support-grant" },
    payload: body,
    remoteAddress: uniqueAddress(),
  });
}

function readEmployees(tenantId: string, token: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1/operator/tenants/${tenantId}/support/employees`,
    headers: { authorization: `Bearer ${token}`, "user-agent": "vitest-support-read" },
    remoteAddress: uniqueAddress(),
  });
}

function readRows(operatorId: string, tenantId: string) {
  return app.prisma.operatorAuditLog.findMany({
    where: { action: "SUPPORT_DATA_READ", operatorId, subjectTenantId: tenantId },
  });
}

function refusalRows(operatorId: string, tenantId: string) {
  return app.prisma.operatorAuditLog.findMany({
    where: { action: "SUPPORT_ACCESS_REFUSED", operatorId, subjectTenantId: tenantId },
  });
}

beforeAll(async () => {
  app = await getTestApp();
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

describe("POST /operator/tenants/:id/support-access", () => {
  it("(a) grants a one hour access by default and writes both start records", async () => {
    const { tenant } = await newTenant("grant");
    const operator = await newPrincipal();

    const res = await requestGrant(tenant.id, operator.token, { reason: `  ${REASON}  ` });
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body) as { access: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(["access"]);
    expect(Object.keys(body.access).sort(byKey)).toEqual(GRANT_KEYS);
    expect(body.access.reason).toBe(REASON);
    expect(body.access.status).toBe("ACTIVE");
    expect(body.access.durationHours).toBe(1);

    const row = await app.prisma.supportAccess.findUniqueOrThrow({
      where: { id: String(body.access.id) },
    });
    expect(row.expiresAt.getTime() - row.startedAt.getTime()).toBe(3_600_000);
    expect(row.operatorId).toBe(operator.id);

    const operatorRows = await app.prisma.operatorAuditLog.findMany({
      where: { action: "SUPPORT_ACCESS_STARTED", entityId: row.id },
    });
    expect(operatorRows).toHaveLength(1);
    expect(operatorRows[0].ipAddress).toBeTruthy();
    const tenantRows = await app.prisma.auditLog.findMany({
      where: { action: "SUPPORT_ACCESS_STARTED", entityId: row.id },
    });
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0].ipAddress).toBeNull();
    expect(tenantRows[0].newValue).toMatchObject({ actor: { tenantId: tenant.id } });
  });

  it("(e) refuses a second request while one is active and keeps the single row", async () => {
    const { tenant } = await newTenant("twice");
    const operator = await newPrincipal();
    expect((await requestGrant(tenant.id, operator.token, { reason: REASON })).statusCode).toBe(
      201,
    );

    const second = await requestGrant(tenant.id, operator.token, {
      reason: REASON,
      durationHours: 4,
    });
    expect(second.statusCode, second.body).toBe(409);
    expect(JSON.parse(second.body).code).toBe("SUPPORT_ACCESS_ALREADY_ACTIVE");
    const rows = await app.prisma.supportAccess.findMany({
      where: { tenantId: tenant.id, operatorId: operator.id },
    });
    expect(rows).toHaveLength(1);
  });

  it("rejects a short reason, an unlisted duration and an unknown key; unknown tenant is the one 404", async () => {
    const { tenant } = await newTenant("input");
    const operator = await newPrincipal();
    expect(
      (await requestGrant(tenant.id, operator.token, { reason: "too short" })).statusCode,
    ).toBe(400);
    expect(
      (await requestGrant(tenant.id, operator.token, { reason: REASON, durationHours: 3 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await requestGrant(tenant.id, operator.token, { reason: REASON, until: "2030-01-01" }))
        .statusCode,
    ).toBe(400);
    const unknown = await requestGrant(randomUUID(), operator.token, { reason: REASON });
    expect(unknown.statusCode).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({ error: "Mandant nicht gefunden" });
  });
});

describe("GET /operator/tenants/:id/support/employees", () => {
  it("(b) serves the curated list under a grant and writes exactly one record in each log", async () => {
    const { tenant, employee, empUser } = await newTenant("read");
    await app.prisma.employee.update({
      where: { id: employee.id },
      data: { birthDate: new Date("1991-03-14") },
    });
    const operator = await newPrincipal();
    const grantRes = await requestGrant(tenant.id, operator.token, { reason: REASON });
    expect(grantRes.statusCode).toBe(201);
    const accessId = String(JSON.parse(grantRes.body).access.id);

    const operatorBefore = (await readRows(operator.id, tenant.id)).length;
    const tenantBefore = await app.prisma.auditLog.count({
      where: { action: "SUPPORT_DATA_READ", entityId: accessId },
    });

    const res = await readEmployees(tenant.id, operator.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(String(res.headers["cache-control"])).toContain("no-store");
    const body = JSON.parse(res.body) as { items: Record<string, unknown>[] };
    expect(Object.keys(body)).toEqual(["items"]);
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    for (const item of body.items) {
      expect(Object.keys(item).sort(byKey)).toEqual(EMPLOYEE_KEYS);
    }
    const seeded = body.items.find((item) => item.id === employee.id);
    expect(seeded).toBeDefined();
    expect(seeded?.employeeNumber).toBe(employee.employeeNumber);
    expect(seeded?.status).toBe("ACTIVE");
    expect(seeded?.scheduleType).toBe("FIXED_SCHEDULE");
    expect(seeded?.homeSalon).toBeNull();

    // Data minimisation: neither the login address nor the birth date appears anywhere in the body.
    expect(res.body).not.toContain(empUser.email);
    expect(res.body).not.toContain("1991-03-14");
    expect(res.body).not.toContain('"birthDate"');
    expect(res.body).not.toContain('"email"');

    const operatorRowsNow = await readRows(operator.id, tenant.id);
    expect(operatorRowsNow).toHaveLength(operatorBefore + 1);
    const operatorRow = operatorRowsNow[0];
    expect(operatorRow.entityId).toBe(accessId);
    expect(operatorRow.ipAddress).toBeTruthy();
    expect(operatorRow.newValue).toMatchObject({ category: "EMPLOYEES", reason: REASON });

    const tenantRows = await app.prisma.auditLog.findMany({
      where: { action: "SUPPORT_DATA_READ", entityId: accessId },
    });
    expect(tenantRows).toHaveLength(tenantBefore + 1);
    expect(tenantRows[0].ipAddress).toBeNull();
    expect(tenantRows[0].newValue).toMatchObject({
      category: "EMPLOYEES",
      actor: { type: "OPERATOR", operatorId: operator.id, tenantId: tenant.id },
    });
  });

  it("(c) refuses an operator without a grant, logs the refusal and returns no data", async () => {
    const { tenant } = await newTenant("nogrant");
    const operator = await newPrincipal();
    const readsBefore = (await readRows(operator.id, tenant.id)).length;
    const refusalsBefore = (await refusalRows(operator.id, tenant.id)).length;

    const res = await readEmployees(tenant.id, operator.token);
    expect(res.statusCode, res.body).toBe(403);
    expect(Object.keys(JSON.parse(res.body)).sort(byKey)).toEqual(["code", "error"]);
    expect(JSON.parse(res.body).code).toBe("SUPPORT_ACCESS_REQUIRED");
    expect(String(res.headers["cache-control"])).toContain("no-store");

    expect(await refusalRows(operator.id, tenant.id)).toHaveLength(refusalsBefore + 1);
    expect(await readRows(operator.id, tenant.id)).toHaveLength(readsBefore);
  });

  it("(d) a grant of tenant A does not open tenant B", async () => {
    const a = await newTenant("tenant-a");
    const b = await newTenant("tenant-b");
    const operator = await newPrincipal();
    expect((await requestGrant(a.tenant.id, operator.token, { reason: REASON })).statusCode).toBe(
      201,
    );

    expect((await readEmployees(a.tenant.id, operator.token)).statusCode).toBe(200);
    const foreign = await readEmployees(b.tenant.id, operator.token);
    expect(foreign.statusCode).toBe(403);
    expect(JSON.parse(foreign.body).code).toBe("SUPPORT_ACCESS_REQUIRED");
    expect(await readRows(operator.id, b.tenant.id)).toHaveLength(0);
  });

  it("an unknown tenant answers the one operator 404 and writes no row", async () => {
    const operator = await newPrincipal();
    const res = await readEmployees(randomUUID(), operator.token);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Mandant nicht gefunden" });
    expect(String(res.headers["cache-control"])).toContain("no-store");
  });

  it("an expired grant does not open the read", async () => {
    const { tenant } = await newTenant("expired");
    const operator = await newPrincipal();
    const startedAt = new Date(Date.now() - 2 * 3_600_000);
    await seedSupportAccess(app, {
      tenantId: tenant.id,
      operatorId: operator.id,
      startedAt,
      expiresAt: new Date(startedAt.getTime() + 3_600_000),
    });
    const res = await readEmployees(tenant.id, operator.token);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("SUPPORT_ACCESS_REQUIRED");
  });

  it("a deactivated tenant is refused even with a running grant", async () => {
    const { tenant } = await newTenant("deactivated");
    const operator = await newPrincipal();
    await seedSupportAccess(app, { tenantId: tenant.id, operatorId: operator.id });
    await app.prisma.tenant.update({
      where: { id: tenant.id },
      data: { deactivatedAt: new Date() },
    });
    const res = await readEmployees(tenant.id, operator.token);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("TENANT_DEACTIVATED");
    expect(await readRows(operator.id, tenant.id)).toHaveLength(0);
    expect(await refusalRows(operator.id, tenant.id)).toHaveLength(1);
  });

  it("(f) a tenant admin token never reaches a support route", async () => {
    const { tenant, adminToken } = await newTenant("principal");
    const operator = await newPrincipal();
    await seedSupportAccess(app, { tenantId: tenant.id, operatorId: operator.id });

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/operator/tenants/${tenant.id}/support/employees`,
      headers: { authorization: `Bearer ${adminToken}` },
      remoteAddress: uniqueAddress(),
    });
    expect(read.statusCode).toBe(403);
    expect(read.body).not.toContain("employeeNumber");

    const grant = await app.inject({
      method: "POST",
      url: `/api/v1/operator/tenants/${tenant.id}/support-access`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { reason: REASON },
      remoteAddress: uniqueAddress(),
    });
    expect(grant.statusCode).toBe(403);

    const refused = await app.prisma.operatorAuditLog.count({
      where: { action: "TENANT_PRINCIPAL_REFUSED" },
    });
    expect(refused).toBeGreaterThan(0);
    expect(await readRows(operator.id, tenant.id)).toHaveLength(0);
  });
});

describe("(g) the grant ends while a read waits (D-19 check-then-audit window)", () => {
  it("refuses inside the audit transaction, writes the refusal and no read record", async () => {
    const { tenant } = await newTenant("endrace");
    const operator = await newPrincipal();
    const grant = await seedSupportAccess(app, { tenantId: tenant.id, operatorId: operator.id });
    const refusalsBefore = (await refusalRows(operator.id, tenant.id)).length;

    // Hold an UNCOMMITTED legal end transition of the grant in a transaction of the test.
    let releaseEnd: (() => void) | undefined;
    const holdGate = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    let signalHeld: ((pid: number) => void) | undefined;
    const held = new Promise<number>((resolve) => {
      signalHeld = resolve;
    });
    const endTx = app.prisma.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx.$executeRaw`UPDATE "SupportAccess" SET "endedAt" = now(), "endedBy" = 'OPERATOR' WHERE "id" = ${grant.id} AND "endedAt" IS NULL`;
        signalHeld?.(pid);
        await holdGate;
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
    const heldPid = await Promise.race([
      held,
      endTx.then(
        () => Promise.reject(new Error("the end transaction finished before it signalled")),
        (err: unknown) => Promise.reject(err),
      ),
    ]);

    // Fire the read without awaiting it; it must block on the share lock of the grant row.
    const pending = readEmployees(tenant.id, operator.token);
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });

    // Synchronise on observed database state: a backend that waits on the held end transaction.
    const deadline = Date.now() + 10_000;
    let waitingBackends = 0;
    let polls = 0;
    while (!settled && Date.now() < deadline) {
      polls += 1;
      const waiting = await app.prisma.$queryRaw<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity WHERE ${heldPid}::int = ANY(pg_blocking_pids(pid))`;
      if (waiting.length > 0) {
        waitingBackends = waiting.length;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    console.warn(`93b-02 case (g): ${waitingBackends} backend(s) waiting after ${polls} poll(s)`);
    expect(waitingBackends, "the read was never observed waiting on the held end").toBeGreaterThan(
      0,
    );
    expect(settled, "the read answered before the end committed").toBe(false);

    releaseEnd?.();
    await endTx;
    const res = await pending;

    expect(res.statusCode, res.body).toBe(403);
    expect(JSON.parse(res.body).code).toBe("SUPPORT_ACCESS_REQUIRED");
    expect(String(res.headers["cache-control"])).toContain("no-store");
    expect(await refusalRows(operator.id, tenant.id)).toHaveLength(refusalsBefore + 1);
    const readsOfGrant = await app.prisma.operatorAuditLog.count({
      where: { action: "SUPPORT_DATA_READ", entityId: grant.id },
    });
    expect(readsOfGrant).toBe(0);
    const tenantReads = await app.prisma.auditLog.count({
      where: { action: "SUPPORT_DATA_READ", entityId: grant.id },
    });
    expect(tenantReads).toBe(0);
  });
});
