/**
 * Issue #93 (Phase 93b-01) — storage and decider half of the support access: the `SupportAccess` table
 * with its immutability trigger, the ONE decider of "active", grant creation under the Tenant row lock
 * and the two audit writers, all driven through the Unterbau functions against the real database (no
 * HTTP yet; the routes arrive in 93b-02).
 *
 * Operator accounts are never deleted by tests (audit rows reference them with onDelete Restrict), so
 * every case that needs a fresh principal seeds a fresh synthetic operator. Tenants are cleaned up in
 * `afterAll`, which also removes their grants through the trigger-disabled delete of `cleanupTestData`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
import {
  SUPPORT_ACCESS_DEFAULT_HOURS,
  SUPPORT_ACCESS_DURATION_HOURS,
  SUPPORT_ACCESS_REASON_MAX,
  SUPPORT_ACCESS_REASON_MIN,
  assertActiveSupportAccess,
  createSupportAccess,
  isSupportAccessActive,
  recordSupportAccessRefused,
  supportAccessStatus,
  supportEmployeeStatus,
  writeSupportReadAudit,
} from "../contexts/platform/support-access";
import { OPERATOR_AUDIT_ACTIONS } from "../contexts/platform/operator-audit";

type Fixture = Awaited<ReturnType<typeof seedGrundversionTenant>>;

let app: FastifyInstance;
let addressCounter = 0;
const tenants: Fixture[] = [];
const REASON = "Support ticket: investigate the monthly saldo";

/** Every call carries its own address so the stored IP identifies the case. */
function fakeRequest(): { ip: string; headers: Record<string, string> } {
  const n = addressCounter++;
  return {
    ip: `10.93.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`,
    headers: { "user-agent": "decider-test" },
  };
}

async function newTenant(): Promise<Fixture> {
  const fixture = await seedGrundversionTenant(app, `d93${randomUUID().slice(0, 8)}`);
  tenants.push(fixture);
  return fixture;
}

async function newOperatorId(): Promise<string> {
  return (await seedOperator(app)).id;
}

const END_TRANSITION = (id: string) =>
  app.prisma
    .$executeRaw`UPDATE "SupportAccess" SET "endedAt" = now(), "endedBy" = 'OPERATOR' WHERE "id" = ${id} AND "endedAt" IS NULL`;

beforeAll(async () => {
  app = await getTestApp();
});

afterAll(async () => {
  for (const fixture of tenants) {
    try {
      await cleanupTestData(app, fixture.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  }
  await closeTestApp();
});

// ── Constants and pure functions ────────────────────────────────────────────────────────────────

describe("constants and pure helpers (D-02, D-03)", () => {
  it("offers the four durations with a one hour default and the 10..500 reason bounds", () => {
    expect([...SUPPORT_ACCESS_DURATION_HOURS]).toEqual([1, 4, 8, 24]);
    expect(SUPPORT_ACCESS_DEFAULT_HOURS).toBe(1);
    expect(SUPPORT_ACCESS_REASON_MIN).toBe(10);
    expect(SUPPORT_ACCESS_REASON_MAX).toBe(500);
  });

  it("derives the status from endedAt first, then from the window", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    const future = new Date(now.getTime() + 1);
    const past = new Date(now.getTime() - 1);
    expect(supportAccessStatus({ endedAt: null, expiresAt: future }, now)).toBe("ACTIVE");
    expect(supportAccessStatus({ endedAt: null, expiresAt: now }, now)).toBe("EXPIRED");
    expect(supportAccessStatus({ endedAt: null, expiresAt: past }, now)).toBe("EXPIRED");
    expect(supportAccessStatus({ endedAt: past, expiresAt: future }, now)).toBe("ENDED");
    expect(isSupportAccessActive({ endedAt: null, expiresAt: future }, now)).toBe(true);
    expect(isSupportAccessActive({ endedAt: past, expiresAt: future }, now)).toBe(false);
  });

  it("classifies the employee status: sentinel, exit date before today, otherwise active", () => {
    const today = new Date("2026-10-15T00:00:00.000Z");
    const person = { firstName: "Test", lastName: "Person" };
    expect(
      supportEmployeeStatus(
        { firstName: "Gelöscht", lastName: "GELÖSCHT-001", exitDate: null },
        today,
      ),
    ).toBe("ANONYMIZED");
    expect(
      supportEmployeeStatus({ ...person, exitDate: new Date("2026-10-14T00:00:00.000Z") }, today),
    ).toBe("EXITED");
    expect(supportEmployeeStatus({ ...person, exitDate: new Date(today) }, today)).toBe("ACTIVE");
    expect(
      supportEmployeeStatus({ ...person, exitDate: new Date("2026-10-16T00:00:00.000Z") }, today),
    ).toBe("ACTIVE");
    expect(supportEmployeeStatus({ ...person, exitDate: null }, today)).toBe("ACTIVE");
  });
});

// ── Grant creation (D-02, D-03, D-04, D-06, D-12) ───────────────────────────────────────────────

describe("createSupportAccess", () => {
  it("creates a one hour grant and writes the start row to both protocols", async () => {
    const { tenant } = await newTenant();
    const operatorId = await newOperatorId();
    const request = fakeRequest();
    const result = await createSupportAccess(app, {
      tenantId: tenant.id,
      operatorId,
      reason: REASON,
      durationHours: 1,
      request,
    });
    expect(result.status).toBe("CREATED");
    if (result.status !== "CREATED") return;
    expect(result.row.expiresAt.getTime() - result.row.startedAt.getTime()).toBe(3_600_000);
    expect(result.row.reason).toBe(REASON);
    expect(result.row.endedAt).toBeNull();

    const operatorRows = await app.prisma.operatorAuditLog.findMany({
      where: { action: OPERATOR_AUDIT_ACTIONS.SUPPORT_ACCESS_STARTED, entityId: result.row.id },
    });
    expect(operatorRows).toHaveLength(1);
    expect(operatorRows[0].operatorId).toBe(operatorId);
    expect(operatorRows[0].subjectTenantId).toBe(tenant.id);
    expect(operatorRows[0].ipAddress).toBe(request.ip);
    expect(operatorRows[0].newValue).toMatchObject({ reason: REASON, durationHours: 1 });

    const tenantRows = await app.prisma.auditLog.findMany({
      where: { action: "SUPPORT_ACCESS_STARTED", entity: "SupportAccess", entityId: result.row.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0].ipAddress).toBeNull();
    expect(tenantRows[0].userId).toBeNull();
    expect(tenantRows[0].newValue).toMatchObject({
      actor: { type: "OPERATOR", operatorId, tenantId: tenant.id },
    });
  });

  it("sizes a 24 hour grant to exactly 24 hours", async () => {
    const { tenant } = await newTenant();
    const result = await createSupportAccess(app, {
      tenantId: tenant.id,
      operatorId: await newOperatorId(),
      reason: REASON,
      durationHours: 24,
      request: fakeRequest(),
    });
    expect(result.status).toBe("CREATED");
    if (result.status !== "CREATED") return;
    expect(result.row.expiresAt.getTime() - result.row.startedAt.getTime()).toBe(24 * 3_600_000);
  });

  it("refuses a second request of the same operator for the same tenant while one is active", async () => {
    const { tenant } = await newTenant();
    const operatorId = await newOperatorId();
    const input = {
      tenantId: tenant.id,
      operatorId,
      reason: REASON,
      durationHours: 1 as const,
      request: fakeRequest(),
    };
    expect((await createSupportAccess(app, input)).status).toBe("CREATED");
    expect((await createSupportAccess(app, input)).status).toBe("ALREADY_ACTIVE");
    expect(await app.prisma.supportAccess.count({ where: { tenantId: tenant.id } })).toBe(1);
    expect(
      await app.prisma.operatorAuditLog.count({
        where: {
          subjectTenantId: tenant.id,
          action: OPERATOR_AUDIT_ACTIONS.SUPPORT_ACCESS_STARTED,
        },
      }),
    ).toBe(1);
  });

  it("allows two operators to hold a grant for the same tenant at the same time", async () => {
    const { tenant } = await newTenant();
    const base = { tenantId: tenant.id, reason: REASON, durationHours: 1 as const };
    const first = await createSupportAccess(app, {
      ...base,
      operatorId: await newOperatorId(),
      request: fakeRequest(),
    });
    const second = await createSupportAccess(app, {
      ...base,
      operatorId: await newOperatorId(),
      request: fakeRequest(),
    });
    expect(first.status).toBe("CREATED");
    expect(second.status).toBe("CREATED");
    expect(await app.prisma.supportAccess.count({ where: { tenantId: tenant.id } })).toBe(2);
  });

  it("accepts a new request once the earlier grant is expired or ended", async () => {
    const { tenant } = await newTenant();
    const operatorId = await newOperatorId();
    const past = new Date(Date.now() - 2 * 3_600_000);
    await seedSupportAccess(app, {
      tenantId: tenant.id,
      operatorId,
      startedAt: past,
      expiresAt: new Date(past.getTime() + 3_600_000),
    });
    const result = await createSupportAccess(app, {
      tenantId: tenant.id,
      operatorId,
      reason: REASON,
      durationHours: 1,
      request: fakeRequest(),
    });
    expect(result.status).toBe("CREATED");
  });

  it("answers NOT_FOUND for an unknown tenant and writes nothing", async () => {
    const unknownTenantId = randomUUID();
    const result = await createSupportAccess(app, {
      tenantId: unknownTenantId,
      operatorId: await newOperatorId(),
      reason: REASON,
      durationHours: 1,
      request: fakeRequest(),
    });
    expect(result.status).toBe("NOT_FOUND");
    expect(await app.prisma.supportAccess.count({ where: { tenantId: unknownTenantId } })).toBe(0);
    expect(
      await app.prisma.operatorAuditLog.count({ where: { subjectTenantId: unknownTenantId } }),
    ).toBe(0);
  });

  it("answers TENANT_DEACTIVATED for a deactivated tenant and writes nothing", async () => {
    const { tenant } = await newTenant();
    // Direct column write on a throwaway fixture tenant: the operator deactivation route is not the
    // subject of this test, only its effect on the grant decision.
    await app.prisma.tenant.update({
      where: { id: tenant.id },
      data: { deactivatedAt: new Date() },
    });
    const result = await createSupportAccess(app, {
      tenantId: tenant.id,
      operatorId: await newOperatorId(),
      reason: REASON,
      durationHours: 1,
      request: fakeRequest(),
    });
    expect(result.status).toBe("TENANT_DEACTIVATED");
    expect(await app.prisma.supportAccess.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(
      await app.prisma.operatorAuditLog.count({
        where: {
          subjectTenantId: tenant.id,
          action: OPERATOR_AUDIT_ACTIONS.SUPPORT_ACCESS_STARTED,
        },
      }),
    ).toBe(0);
  });
});

// ── The decider (D-10, D-22, D-28) ──────────────────────────────────────────────────────────────

describe("assertActiveSupportAccess", () => {
  it("is OK for the grant's own operator and tenant, carrying the access id, reason and expiry", async () => {
    const { tenant } = await newTenant();
    const operatorId = await newOperatorId();
    const grant = await seedSupportAccess(app, { tenantId: tenant.id, operatorId, reason: REASON });
    const result = await assertActiveSupportAccess(app.prisma, {
      tenantId: tenant.id,
      operatorId,
    });
    expect(result).toEqual({
      status: "OK",
      accessId: grant.id,
      reason: REASON,
      expiresAt: grant.expiresAt,
    });
  });

  it("is REQUIRED for another operator", async () => {
    const { tenant } = await newTenant();
    await seedSupportAccess(app, { tenantId: tenant.id, operatorId: await newOperatorId() });
    const result = await assertActiveSupportAccess(app.prisma, {
      tenantId: tenant.id,
      operatorId: await newOperatorId(),
    });
    expect(result.status).toBe("REQUIRED");
  });

  it("is REQUIRED for another tenant of the same operator", async () => {
    const first = await newTenant();
    const second = await newTenant();
    const operatorId = await newOperatorId();
    await seedSupportAccess(app, { tenantId: first.tenant.id, operatorId });
    const result = await assertActiveSupportAccess(app.prisma, {
      tenantId: second.tenant.id,
      operatorId,
    });
    expect(result.status).toBe("REQUIRED");
  });

  it("is REQUIRED one millisecond after expiry and OK exactly one millisecond before", async () => {
    const { tenant } = await newTenant();
    const operatorId = await newOperatorId();
    const grant = await seedSupportAccess(app, { tenantId: tenant.id, operatorId });
    const input = { tenantId: tenant.id, operatorId };
    const justAfter = new Date(grant.expiresAt.getTime() + 1);
    const justBefore = new Date(grant.expiresAt.getTime() - 1);
    expect((await assertActiveSupportAccess(app.prisma, input, justAfter)).status).toBe("REQUIRED");
    expect((await assertActiveSupportAccess(app.prisma, input, grant.expiresAt)).status).toBe(
      "REQUIRED",
    );
    expect((await assertActiveSupportAccess(app.prisma, input, justBefore)).status).toBe("OK");
  });

  it("is REQUIRED for a row seeded already expired", async () => {
    const { tenant } = await newTenant();
    const operatorId = await newOperatorId();
    const startedAt = new Date(Date.now() - 3 * 3_600_000);
    await seedSupportAccess(app, {
      tenantId: tenant.id,
      operatorId,
      startedAt,
      expiresAt: new Date(startedAt.getTime() + 3_600_000),
    });
    const result = await assertActiveSupportAccess(app.prisma, {
      tenantId: tenant.id,
      operatorId,
    });
    expect(result.status).toBe("REQUIRED");
  });

  it("is REQUIRED for a row seeded already ended", async () => {
    const { tenant } = await newTenant();
    const operatorId = await newOperatorId();
    await seedSupportAccess(app, {
      tenantId: tenant.id,
      operatorId,
      endedAt: new Date(),
      endedBy: "OPERATOR",
    });
    const result = await assertActiveSupportAccess(app.prisma, {
      tenantId: tenant.id,
      operatorId,
    });
    expect(result.status).toBe("REQUIRED");
  });

  it("answers TENANT_NOT_FOUND for an unknown tenant", async () => {
    const result = await assertActiveSupportAccess(app.prisma, {
      tenantId: randomUUID(),
      operatorId: await newOperatorId(),
    });
    expect(result.status).toBe("TENANT_NOT_FOUND");
  });

  it("answers TENANT_DEACTIVATED for a deactivated tenant even with a running grant", async () => {
    const { tenant } = await newTenant();
    const operatorId = await newOperatorId();
    await seedSupportAccess(app, { tenantId: tenant.id, operatorId });
    // Direct column write on a throwaway fixture tenant, see the creation case above.
    await app.prisma.tenant.update({
      where: { id: tenant.id },
      data: { deactivatedAt: new Date() },
    });
    const result = await assertActiveSupportAccess(app.prisma, {
      tenantId: tenant.id,
      operatorId,
    });
    expect(result.status).toBe("TENANT_DEACTIVATED");
  });
});

// ── Share-lock re-check (D-19 check-then-audit window) ──────────────────────────────────────────

interface RaceResult<A, B> {
  first: PromiseSettledResult<A>;
  second: PromiseSettledResult<B>;
  /** PostgreSQL reported the second transaction as blocked by the first while it was held open. */
  blocked: boolean;
}

/**
 * Local copy of the harness of `tenant-packages-566.test.ts` (copied, not imported): runs `firstWork`
 * in one transaction and holds it open after the work, starts `secondWork` in another, and polls
 * `pg_blocking_pids` until the second is seen waiting on the first — synchronised on observed database
 * state, never on a fixed sleep.
 */
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

describe("assertActiveSupportAccess with lockGrant (D-19)", () => {
  it("waits on an uncommitted end transition and answers REQUIRED once the end committed", async () => {
    const { tenant } = await newTenant();
    const operatorId = await newOperatorId();
    const grant = await seedSupportAccess(app, { tenantId: tenant.id, operatorId });

    const result = await raceTwoTransactions(
      (tx) =>
        tx.$executeRaw`UPDATE "SupportAccess" SET "endedAt" = now(), "endedBy" = 'OPERATOR' WHERE "id" = ${grant.id} AND "endedAt" IS NULL`,
      (tx) =>
        assertActiveSupportAccess(tx, { tenantId: tenant.id, operatorId }, new Date(), {
          lockGrant: true,
        }),
    );

    expect(result.blocked).toBe(true);
    expect(result.first.status).toBe("fulfilled");
    expect(result.second.status).toBe("fulfilled");
    if (result.second.status !== "fulfilled") return;
    expect(result.second.value.status).toBe("REQUIRED");
  });

  it("returns OK for the locked call when no end runs concurrently", async () => {
    const { tenant } = await newTenant();
    const operatorId = await newOperatorId();
    const grant = await seedSupportAccess(app, { tenantId: tenant.id, operatorId });
    const result = await app.prisma.$transaction((tx) =>
      assertActiveSupportAccess(tx, { tenantId: tenant.id, operatorId }, new Date(), {
        lockGrant: true,
      }),
    );
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.accessId).toBe(grant.id);
  });
});

// ── Audit writers (D-06) ────────────────────────────────────────────────────────────────────────

describe("writeSupportReadAudit and recordSupportAccessRefused", () => {
  it("writes exactly one operator row with IP/UA and one tenant row without, inside the transaction", async () => {
    const { tenant } = await newTenant();
    const operatorId = await newOperatorId();
    const grant = await seedSupportAccess(app, { tenantId: tenant.id, operatorId, reason: REASON });
    const request = fakeRequest();
    const employeeId = randomUUID();
    await app.prisma.$transaction((tx) =>
      writeSupportReadAudit(app, tx, {
        operatorId,
        tenantId: tenant.id,
        accessId: grant.id,
        newValue: { category: "EMPLOYEE_MONTH", employeeId, month: "2026-09", reason: REASON },
        request,
      }),
    );

    const operatorRows = await app.prisma.operatorAuditLog.findMany({
      where: { action: OPERATOR_AUDIT_ACTIONS.SUPPORT_DATA_READ, entityId: grant.id },
    });
    expect(operatorRows).toHaveLength(1);
    expect(operatorRows[0].operatorId).toBe(operatorId);
    expect(operatorRows[0].subjectTenantId).toBe(tenant.id);
    expect(operatorRows[0].entity).toBe("SupportAccess");
    expect(operatorRows[0].ipAddress).toBe(request.ip);
    expect(operatorRows[0].userAgent).toBe("decider-test");
    expect(operatorRows[0].newValue).toMatchObject({
      category: "EMPLOYEE_MONTH",
      employeeId,
      month: "2026-09",
      reason: REASON,
    });

    const tenantRows = await app.prisma.auditLog.findMany({
      where: { action: "SUPPORT_DATA_READ", entity: "SupportAccess", entityId: grant.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0].ipAddress).toBeNull();
    expect(tenantRows[0].userAgent).toBeNull();
    expect(tenantRows[0].userId).toBeNull();
    expect(tenantRows[0].newValue).toMatchObject({
      category: "EMPLOYEE_MONTH",
      actor: { type: "OPERATOR", operatorId, tenantId: tenant.id },
    });
  });

  it("persists neither row when the surrounding transaction fails afterwards", async () => {
    const { tenant } = await newTenant();
    const operatorId = await newOperatorId();
    const grant = await seedSupportAccess(app, { tenantId: tenant.id, operatorId });
    await expect(
      app.prisma.$transaction(async (tx) => {
        await writeSupportReadAudit(app, tx, {
          operatorId,
          tenantId: tenant.id,
          accessId: grant.id,
          newValue: { category: "EMPLOYEES", reason: REASON },
          request: fakeRequest(),
        });
        throw new Error("rollback on purpose");
      }),
    ).rejects.toThrow("rollback on purpose");
    expect(
      await app.prisma.operatorAuditLog.count({
        where: { action: OPERATOR_AUDIT_ACTIONS.SUPPORT_DATA_READ, entityId: grant.id },
      }),
    ).toBe(0);
    expect(
      await app.prisma.auditLog.count({
        where: { action: "SUPPORT_DATA_READ", entityId: grant.id },
      }),
    ).toBe(0);
  });

  it("records one refusal row carrying method and code", async () => {
    const { tenant } = await newTenant();
    const operatorId = await newOperatorId();
    const route = `/api/v1/operator/tenants/:id/support/${randomUUID()}`;
    await recordSupportAccessRefused(app.prisma, {
      operatorId,
      tenantId: tenant.id,
      method: "GET",
      route,
      code: "SUPPORT_ACCESS_REQUIRED",
      request: fakeRequest(),
    });
    const rows = await app.prisma.operatorAuditLog.findMany({
      where: { action: OPERATOR_AUDIT_ACTIONS.SUPPORT_ACCESS_REFUSED, entityId: route },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].operatorId).toBe(operatorId);
    expect(rows[0].subjectTenantId).toBe(tenant.id);
    expect(rows[0].entity).toBe("Route");
    expect(rows[0].newValue).toEqual({ method: "GET", code: "SUPPORT_ACCESS_REQUIRED" });
  });
});

// ── The trigger (D-07, D-25) ────────────────────────────────────────────────────────────────────

describe("SupportAccess immutability trigger", () => {
  it("refuses a raw DELETE", async () => {
    const { tenant } = await newTenant();
    const grant = await seedSupportAccess(app, {
      tenantId: tenant.id,
      operatorId: await newOperatorId(),
    });
    await expect(
      app.prisma.$executeRaw`DELETE FROM "SupportAccess" WHERE "id" = ${grant.id}`,
    ).rejects.toThrow(/append-only/);
    expect(await app.prisma.supportAccess.count({ where: { id: grant.id } })).toBe(1);
  });

  it("refuses a raw UPDATE of the reason", async () => {
    const { tenant } = await newTenant();
    const grant = await seedSupportAccess(app, {
      tenantId: tenant.id,
      operatorId: await newOperatorId(),
      reason: REASON,
    });
    await expect(
      app.prisma
        .$executeRaw`UPDATE "SupportAccess" SET "reason" = 'rewritten reason text' WHERE "id" = ${grant.id}`,
    ).rejects.toThrow(/append-only/);
    const after = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: grant.id } });
    expect(after.reason).toBe(REASON);
  });

  it("allows the single end transition exactly once", async () => {
    const { tenant } = await newTenant();
    const grant = await seedSupportAccess(app, {
      tenantId: tenant.id,
      operatorId: await newOperatorId(),
    });
    expect(await END_TRANSITION(grant.id)).toBe(1);
    // The guarded UPDATE of an already ended row matches nothing instead of failing.
    expect(await END_TRANSITION(grant.id)).toBe(0);
    const after = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: grant.id } });
    expect(after.endedAt).not.toBeNull();
    expect(after.endedBy).toBe("OPERATOR");
    // A second, unguarded end of the same row is an UPDATE the trigger refuses.
    await expect(
      app.prisma
        .$executeRaw`UPDATE "SupportAccess" SET "endedBy" = 'TENANT' WHERE "id" = ${grant.id}`,
    ).rejects.toThrow(/append-only/);
  });
});

// ── Test cleanup (D-20) ─────────────────────────────────────────────────────────────────────────

describe("cleanupTestData with a grant", () => {
  it("removes the tenant although it holds a grant", async () => {
    const fixture = await seedGrundversionTenant(app, `d93c${randomUUID().slice(0, 7)}`);
    await seedSupportAccess(app, {
      tenantId: fixture.tenant.id,
      operatorId: await newOperatorId(),
    });
    await cleanupTestData(app, fixture.tenant.id);
    expect(await app.prisma.tenant.count({ where: { id: fixture.tenant.id } })).toBe(0);
    expect(await app.prisma.supportAccess.count({ where: { tenantId: fixture.tenant.id } })).toBe(
      0,
    );
    // The trigger is enabled again after the cleanup transaction.
    const other = await newTenant();
    const grant = await seedSupportAccess(app, {
      tenantId: other.tenant.id,
      operatorId: await newOperatorId(),
    });
    await expect(
      app.prisma.$executeRaw`DELETE FROM "SupportAccess" WHERE "id" = ${grant.id}`,
    ).rejects.toThrow(/append-only/);
  });
});
