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
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import {
  getTestApp,
  closeTestApp,
  seedGrundversionTenant,
  seedOperator,
  seedSupportAccess,
  cleanupTestData,
} from "./setup";
import { signOperatorToken } from "../contexts/platform/operator-auth";
import { createSupportAccessInTx } from "../contexts/platform/support-access";

type Fixture = Awaited<ReturnType<typeof seedGrundversionTenant>>;
type Principal = { id: string; token: string; tokenVersion: number };

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
    tokenVersion: operator.tokenVersion,
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

// ── Phase 93b-03: the grant lifecycle ─────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const TENANT_NOT_FOUND_BODY = { error: "Mandant nicht gefunden" };

function listGrants(tenantId: string, token: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1/operator/tenants/${tenantId}/support-access`,
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: uniqueAddress(),
  });
}

function endGrant(tenantId: string, accessId: string, token: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/operator/tenants/${tenantId}/support-access/${accessId}/end`,
    headers: { authorization: `Bearer ${token}`, "user-agent": "vitest-support-end" },
    remoteAddress: uniqueAddress(),
  });
}

function startedRows(operatorId: string, tenantId: string) {
  return app.prisma.operatorAuditLog.count({
    where: { action: "SUPPORT_ACCESS_STARTED", operatorId, subjectTenantId: tenantId },
  });
}

function tenantStartedRows(operatorId: string) {
  return app.prisma.auditLog.count({
    where: {
      action: "SUPPORT_ACCESS_STARTED",
      newValue: { path: ["actor", "operatorId"], equals: operatorId },
    },
  });
}

describe("grant request validation and duration (D-02, D-03, AC-93-1)", () => {
  const LONG_REASON = "x".repeat(501);
  const INVALID_BODIES: [string, Record<string, unknown>][] = [
    ["no reason", {}],
    ["a reason of 9 trimmed characters", { reason: "  123456789  " }],
    ["a reason of 501 characters", { reason: LONG_REASON }],
    ["a whitespace-only reason", { reason: "              " }],
    ["a duration of 2 hours", { reason: REASON, durationHours: 2 }],
    ["a duration given as a string", { reason: REASON, durationHours: "1" }],
    ["an extra body key", { reason: REASON, expiresAt: "2030-01-01T00:00:00Z" }],
  ];

  it.each(INVALID_BODIES)("refuses %s with 400 and writes nothing", async (_label, body) => {
    const { tenant } = await newTenant("validation");
    const operator = await newPrincipal();
    const res = await requestGrant(tenant.id, operator.token, body);
    expect(res.statusCode, res.body).toBe(400);
    expect(await app.prisma.supportAccess.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(await startedRows(operator.id, tenant.id)).toBe(0);
    expect(await tenantStartedRows(operator.id)).toBe(0);
  });

  it.each([4, 8, 24])(
    "a duration of %i hours ends exactly that long after the start",
    async (h) => {
      const { tenant } = await newTenant(`duration-${h}`);
      const operator = await newPrincipal();
      const res = await requestGrant(tenant.id, operator.token, {
        reason: REASON,
        durationHours: h,
      });
      expect(res.statusCode, res.body).toBe(201);
      const access = JSON.parse(res.body).access as { id: string; durationHours: number };
      expect(access.durationHours).toBe(h);
      const row = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: access.id } });
      expect(row.expiresAt.getTime() - row.startedAt.getTime()).toBe(h * HOUR_MS);
    },
  );

  it("an unknown tenant answers the exact operator tenant 404 and writes nothing", async () => {
    const operator = await newPrincipal();
    const res = await requestGrant(randomUUID(), operator.token, { reason: REASON });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual(TENANT_NOT_FOUND_BODY);
    expect(await app.prisma.supportAccess.count({ where: { operatorId: operator.id } })).toBe(0);
  });

  it("a deactivated tenant cannot receive a grant (409 TENANT_DEACTIVATED, no row)", async () => {
    const { tenant } = await newTenant("grant-deactivated");
    const operator = await newPrincipal();
    await app.prisma.tenant.update({
      where: { id: tenant.id },
      data: { deactivatedAt: new Date() },
    });
    const res = await requestGrant(tenant.id, operator.token, { reason: REASON });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).code).toBe("TENANT_DEACTIVATED");
    expect(await app.prisma.supportAccess.count({ where: { tenantId: tenant.id } })).toBe(0);
  });
});

describe("no silent extension, re-request after end or expiry, two operators (D-02, AC-93-5)", () => {
  it("a second request while active leaves the stored expiresAt byte-equal", async () => {
    const { tenant } = await newTenant("noextend");
    const operator = await newPrincipal();
    const first = await requestGrant(tenant.id, operator.token, { reason: REASON });
    expect(first.statusCode).toBe(201);
    const accessId = String(JSON.parse(first.body).access.id);
    const before = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: accessId } });

    const second = await requestGrant(tenant.id, operator.token, {
      reason: "A second and different reason",
      durationHours: 24,
    });
    expect(second.statusCode, second.body).toBe(409);
    expect(JSON.parse(second.body).code).toBe("SUPPORT_ACCESS_ALREADY_ACTIVE");

    const after = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: accessId } });
    expect(after.expiresAt.toISOString()).toBe(before.expiresAt.toISOString());
    expect(after.reason).toBe(before.reason);
    expect(await app.prisma.supportAccess.count({ where: { tenantId: tenant.id } })).toBe(1);
  });

  it("after the operator ended the grant a NEW request opens a NEW row and the first stays", async () => {
    const { tenant } = await newTenant("renew-ended");
    const operator = await newPrincipal();
    const first = await requestGrant(tenant.id, operator.token, { reason: REASON });
    const firstId = String(JSON.parse(first.body).access.id);
    expect((await endGrant(tenant.id, firstId, operator.token)).statusCode).toBe(200);
    const ended = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: firstId } });

    const second = await requestGrant(tenant.id, operator.token, {
      reason: "A new reason after the end",
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondId = String(JSON.parse(second.body).access.id);
    expect(secondId).not.toBe(firstId);

    const firstAfter = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: firstId } });
    expect(firstAfter).toEqual(ended);
    expect(await app.prisma.supportAccess.count({ where: { tenantId: tenant.id } })).toBe(2);
  });

  it("after expiry a NEW request opens a NEW row and the expired one stays EXPIRED", async () => {
    const { tenant } = await newTenant("renew-expired");
    const operator = await newPrincipal();
    const startedAt = new Date(Date.now() - 3 * HOUR_MS);
    const expired = await seedSupportAccess(app, {
      tenantId: tenant.id,
      operatorId: operator.id,
      startedAt,
      expiresAt: new Date(startedAt.getTime() + HOUR_MS),
    });
    const res = await requestGrant(tenant.id, operator.token, { reason: REASON });
    expect(res.statusCode, res.body).toBe(201);
    expect(await app.prisma.supportAccess.count({ where: { tenantId: tenant.id } })).toBe(2);
    const list = JSON.parse((await listGrants(tenant.id, operator.token)).body) as {
      history: { id: string; status: string }[];
    };
    expect(list.history.find((g) => g.id === expired.id)?.status).toBe("EXPIRED");
  });

  it("two different operators may hold an active grant for the same tenant at once", async () => {
    const { tenant } = await newTenant("two-operators");
    const a = await newPrincipal();
    const b = await newPrincipal();
    expect((await requestGrant(tenant.id, a.token, { reason: REASON })).statusCode).toBe(201);
    expect((await requestGrant(tenant.id, b.token, { reason: REASON })).statusCode).toBe(201);
    expect(await app.prisma.supportAccess.count({ where: { tenantId: tenant.id } })).toBe(2);
  });
});

// ── The parallel request race (D-12, D-23) ────────────────────────────────────────────────────────
// Copy of the observed-block harness of tenant-packages-566.test.ts (never imported from there):
// `firstWork` runs in one transaction that is held open after its work, `secondWork` in another, and
// `pg_blocking_pids` is polled until the second backend is seen waiting on the first.

interface RaceResult<A, B> {
  first: PromiseSettledResult<A>;
  second: PromiseSettledResult<B>;
  /** PostgreSQL reported the second transaction as blocked by the first while it was held open. */
  blocked: boolean;
}

async function raceTwoTransactions<A, B>(
  firstWork: (tx: Prisma.TransactionClient) => Promise<A>,
  secondWork: (tx: Prisma.TransactionClient) => Promise<B>,
): Promise<RaceResult<A, B>> {
  let releaseFirst: (() => void) | undefined;
  const holdGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let signalFirstLocked: ((pid: number) => void) | undefined;
  const firstLocked = new Promise<number>((resolve) => {
    signalFirstLocked = resolve;
  });
  const firstPromise = app.prisma.$transaction(
    async (tx) => {
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const result = await firstWork(tx);
      signalFirstLocked?.(pid);
      await holdGate;
      return result;
    },
    { timeout: 20000, maxWait: 20000 },
  );
  // A work failure in tx1 would never signal; surface it instead of hanging.
  const firstPid = await Promise.race([
    firstLocked,
    firstPromise.then(
      () => Promise.reject(new Error("first transaction ended before it signalled")),
      (err: unknown) => Promise.reject(err),
    ),
  ]);

  let signalSecondPid: ((pid: number) => void) | undefined;
  const secondPidKnown = new Promise<number>((resolve) => {
    signalSecondPid = resolve;
  });
  let secondSettled = false;
  const secondPromise = app.prisma
    .$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        signalSecondPid?.(pid);
        return secondWork(tx);
      },
      { timeout: 20000, maxWait: 20000 },
    )
    .finally(() => {
      secondSettled = true;
    });
  const secondPid = await secondPidKnown;

  const deadline = Date.now() + 10000;
  let blocked = false;
  while (!secondSettled && Date.now() < deadline) {
    const [{ blockers }] = await app.prisma.$queryRaw<{ blockers: number[] }[]>`
      SELECT pg_blocking_pids(${secondPid}::int) AS blockers`;
    if (blockers.includes(firstPid)) {
      blocked = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  releaseFirst?.();
  const [first, second] = await Promise.allSettled([firstPromise, secondPromise]);
  return { first, second, blocked };
}

describe("two parallel grant requests of one operator for one tenant (D-12, D-23, AC-93-5)", () => {
  it("exactly one creates a row; the second is observed waiting on the Tenant lock and then sees it", async () => {
    const { tenant } = await newTenant("race");
    const operator = await newPrincipal();
    const input = {
      tenantId: tenant.id,
      operatorId: operator.id,
      reason: REASON,
      durationHours: 1 as const,
    };

    const { first, second, blocked } = await raceTwoTransactions(
      (tx) => createSupportAccessInTx(app, tx, input),
      (tx) => createSupportAccessInTx(app, tx, input),
    );
    console.warn(`93b-03 race: blocked=${blocked}`);

    expect(blocked, "the second transaction was never observed waiting on the first").toBe(true);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("fulfilled");
    expect((first as PromiseFulfilledResult<{ status: string }>).value.status).toBe("CREATED");
    expect((second as PromiseFulfilledResult<{ status: string }>).value.status).toBe(
      "ALREADY_ACTIVE",
    );
    expect(
      await app.prisma.supportAccess.count({
        where: { tenantId: tenant.id, operatorId: operator.id },
      }),
    ).toBe(1);
  });
});

// ── Expiry without any job, deactivation after the start (D-22, D-28, AC-93-3, AC-93-8) ───────────

describe("a grant that is no longer inside its window opens no read (D-22)", () => {
  it("a row inserted as already expired is refused with 403 and one refusal row", async () => {
    const { tenant } = await newTenant("lapsed");
    const operator = await newPrincipal();
    const startedAt = new Date(Date.now() - 5 * HOUR_MS);
    await seedSupportAccess(app, {
      tenantId: tenant.id,
      operatorId: operator.id,
      startedAt,
      expiresAt: new Date(startedAt.getTime() + HOUR_MS),
    });
    const before = (await refusalRows(operator.id, tenant.id)).length;
    const res = await readEmployees(tenant.id, operator.token);
    expect(res.statusCode, res.body).toBe(403);
    expect(JSON.parse(res.body).code).toBe("SUPPORT_ACCESS_REQUIRED");
    expect(await refusalRows(operator.id, tenant.id)).toHaveLength(before + 1);
    expect(await readRows(operator.id, tenant.id)).toHaveLength(0);
  });

  it("a running 1 h grant reads at 59 minutes and is refused at 61 minutes of application time", async () => {
    const { tenant } = await newTenant("clock");
    const operator = await newPrincipal();
    expect((await requestGrant(tenant.id, operator.token, { reason: REASON })).statusCode).toBe(
      201,
    );
    const realNow = Date.now();

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // The operator access token lives 15 minutes, so each probe carries a token signed at its own
      // fake instant; only the grant window is under test.
      vi.setSystemTime(realNow + 59 * 60_000);
      const within = signOperatorToken(app, operator.id, "access", operator.tokenVersion);
      const ok = await readEmployees(tenant.id, within);
      expect(ok.statusCode, ok.body).toBe(200);

      vi.setSystemTime(realNow + 61 * 60_000);
      const lapsed = signOperatorToken(app, operator.id, "access", operator.tokenVersion);
      const refused = await readEmployees(tenant.id, lapsed);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(JSON.parse(refused.body).code).toBe("SUPPORT_ACCESS_REQUIRED");
    } finally {
      vi.useRealTimers();
    }
    expect(await refusalRows(operator.id, tenant.id)).toHaveLength(1);
    expect(await readRows(operator.id, tenant.id)).toHaveLength(1);
  });

  it("a tenant deactivated through the operator route after the start refuses every read (409)", async () => {
    const { tenant } = await newTenant("deactivate-after");
    const operator = await newPrincipal();
    expect((await requestGrant(tenant.id, operator.token, { reason: REASON })).statusCode).toBe(
      201,
    );
    const deactivate = await app.inject({
      method: "POST",
      url: `/api/v1/operator/tenants/${tenant.id}/deactivate`,
      headers: { authorization: `Bearer ${operator.token}` },
      payload: { reason: "Vertrag beendet" },
      remoteAddress: uniqueAddress(),
    });
    expect(deactivate.statusCode, deactivate.body).toBe(200);

    const res = await readEmployees(tenant.id, operator.token);
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).code).toBe("TENANT_DEACTIVATED");
    const refusals = await refusalRows(operator.id, tenant.id);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].newValue).toMatchObject({ code: "TENANT_DEACTIVATED" });
    expect(await readRows(operator.id, tenant.id)).toHaveLength(0);
  });
});

// ── History and early end (D-03, D-06) ────────────────────────────────────────────────────────────

describe("GET /operator/tenants/:id/support-access", () => {
  it("lists the grants of THIS operator, newest first, with the derived statuses", async () => {
    const { tenant } = await newTenant("history");
    const operator = await newPrincipal();
    const other = await newPrincipal();
    const now = Date.now();
    const expired = await seedSupportAccess(app, {
      tenantId: tenant.id,
      operatorId: operator.id,
      startedAt: new Date(now - 10 * HOUR_MS),
      expiresAt: new Date(now - 9 * HOUR_MS),
    });
    const ended = await seedSupportAccess(app, {
      tenantId: tenant.id,
      operatorId: operator.id,
      startedAt: new Date(now - 5 * HOUR_MS),
      expiresAt: new Date(now + 5 * HOUR_MS),
      endedAt: new Date(now - 4 * HOUR_MS),
      endedBy: "OPERATOR",
    });
    const foreign = await seedSupportAccess(app, { tenantId: tenant.id, operatorId: other.id });
    const active = await seedSupportAccess(app, {
      tenantId: tenant.id,
      operatorId: operator.id,
      startedAt: new Date(now - 60_000),
      expiresAt: new Date(now + HOUR_MS),
    });

    const res = await listGrants(tenant.id, operator.token);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as {
      active: { id: string } | null;
      history: { id: string; status: string; endedBy: string | null }[];
    };
    expect(Object.keys(body).sort(byKey)).toEqual(["active", "history"]);
    expect(body.active?.id).toBe(active.id);
    expect(body.history.map((g) => g.id)).toEqual([active.id, ended.id, expired.id]);
    expect(body.history.map((g) => g.status)).toEqual(["ACTIVE", "ENDED", "EXPIRED"]);
    expect(body.history[1].endedBy).toBe("OPERATOR");
    expect(res.body).not.toContain(foreign.id);

    const otherList = JSON.parse((await listGrants(tenant.id, other.token)).body) as {
      active: { id: string } | null;
      history: { id: string }[];
    };
    expect(otherList.history.map((g) => g.id)).toEqual([foreign.id]);
    expect(otherList.active?.id).toBe(foreign.id);
  });

  it("an unknown tenant answers the operator tenant 404", async () => {
    const operator = await newPrincipal();
    const res = await listGrants(randomUUID(), operator.token);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual(TENANT_NOT_FOUND_BODY);
  });

  it("a tenant admin token never reaches the history", async () => {
    const { tenant, adminToken } = await newTenant("history-principal");
    const res = await listGrants(tenant.id, adminToken);
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /operator/tenants/:id/support-access/:accessId/end", () => {
  it("ends the grant, logs it in both protocols, refuses the next read and a second end", async () => {
    const { tenant } = await newTenant("end");
    const operator = await newPrincipal();
    const grant = await requestGrant(tenant.id, operator.token, { reason: REASON });
    const accessId = String(JSON.parse(grant.body).access.id);
    expect((await readEmployees(tenant.id, operator.token)).statusCode).toBe(200);

    const res = await endGrant(tenant.id, accessId, operator.token);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as { access: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(["access"]);
    expect(Object.keys(body.access).sort(byKey)).toEqual(GRANT_KEYS);
    expect(body.access.status).toBe("ENDED");
    expect(body.access.endedBy).toBe("OPERATOR");
    expect(body.access.endedAt).toBeTruthy();

    const operatorRows = await app.prisma.operatorAuditLog.findMany({
      where: { action: "SUPPORT_ACCESS_ENDED", entityId: accessId },
    });
    expect(operatorRows).toHaveLength(1);
    expect(operatorRows[0].ipAddress).toBeTruthy();
    expect(operatorRows[0].newValue).toMatchObject({ endedBy: "OPERATOR" });
    const tenantRows = await app.prisma.auditLog.findMany({
      where: { action: "SUPPORT_ACCESS_ENDED", entityId: accessId },
    });
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0].ipAddress).toBeNull();
    expect(tenantRows[0].newValue).toMatchObject({
      actor: { type: "OPERATOR", operatorId: operator.id, tenantId: tenant.id },
    });

    const afterEnd = await readEmployees(tenant.id, operator.token);
    expect(afterEnd.statusCode).toBe(403);
    expect(JSON.parse(afterEnd.body).code).toBe("SUPPORT_ACCESS_REQUIRED");

    const again = await endGrant(tenant.id, accessId, operator.token);
    expect(again.statusCode, again.body).toBe(409);
    expect(JSON.parse(again.body).code).toBe("SUPPORT_ACCESS_NOT_ACTIVE");
    expect(
      await app.prisma.operatorAuditLog.count({
        where: { action: "SUPPORT_ACCESS_ENDED", entityId: accessId },
      }),
    ).toBe(1);
  });

  it("another operator's grant id and a random uuid answer byte-identical 404 bodies", async () => {
    const { tenant } = await newTenant("end-foreign");
    const owner = await newPrincipal();
    const intruder = await newPrincipal();
    const grant = await seedSupportAccess(app, { tenantId: tenant.id, operatorId: owner.id });

    const foreign = await endGrant(tenant.id, grant.id, intruder.token);
    const unknown = await endGrant(tenant.id, randomUUID(), intruder.token);
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.body).toBe(unknown.body);
    // The owner's grant is untouched.
    const row = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.endedAt).toBeNull();
  });

  it("a grant of another tenant is indistinguishable from an unknown id", async () => {
    const a = await newTenant("end-tenant-a");
    const b = await newTenant("end-tenant-b");
    const operator = await newPrincipal();
    const grant = await seedSupportAccess(app, { tenantId: a.tenant.id, operatorId: operator.id });
    const viaB = await endGrant(b.tenant.id, grant.id, operator.token);
    const unknown = await endGrant(b.tenant.id, randomUUID(), operator.token);
    expect(viaB.statusCode).toBe(404);
    expect(viaB.body).toBe(unknown.body);
  });

  it("ending an expired grant answers 409 SUPPORT_ACCESS_NOT_ACTIVE and changes nothing", async () => {
    const { tenant } = await newTenant("end-expired");
    const operator = await newPrincipal();
    const startedAt = new Date(Date.now() - 3 * HOUR_MS);
    const grant = await seedSupportAccess(app, {
      tenantId: tenant.id,
      operatorId: operator.id,
      startedAt,
      expiresAt: new Date(startedAt.getTime() + HOUR_MS),
    });
    const res = await endGrant(tenant.id, grant.id, operator.token);
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).code).toBe("SUPPORT_ACCESS_NOT_ACTIVE");
    const row = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.endedAt).toBeNull();
  });

  it("a tenant admin token never reaches the end route", async () => {
    const { tenant, adminToken } = await newTenant("end-principal");
    const operator = await newPrincipal();
    const grant = await seedSupportAccess(app, { tenantId: tenant.id, operatorId: operator.id });
    const res = await endGrant(tenant.id, grant.id, adminToken);
    expect(res.statusCode).toBe(403);
    const row = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.endedAt).toBeNull();
  });
});
