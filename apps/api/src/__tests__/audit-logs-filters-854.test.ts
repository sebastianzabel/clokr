/**
 * Issue #583 (Phase 854, D-854-11) - `GET /audit-logs` filters by period (tenant-local calendar days)
 * and affected person, and every row names its affected person. The tenant scope stays its own AND
 * member: no filter value, a foreign tenant's employee id included, can bring a foreign row in.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

let app: FastifyInstance;
let tenantA: Awaited<ReturnType<typeof seedTestData>>;
let tenantB: Awaited<ReturnType<typeof seedTestData>>;
let addressCounter = 0;

function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.91.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function get(url: string, token: string) {
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: uniqueAddress(),
  });
}

type LogRow = {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  affectedEmployee: {
    firstName: string;
    lastName: string;
    employeeNumber: string;
  } | null;
};

async function list(
  token: string,
  query = "",
): Promise<{ logs: LogRow[]; total: number; page: number; limit: number }> {
  const res = await get(`/api/v1/audit-logs?limit=200${query}`, token);
  expect(res.statusCode, res.body).toBe(200);
  return JSON.parse(res.body);
}

/** Inserts a row of tenant A's admin at an exact instant; returns its (unique) entity id. */
async function row(
  tenant: typeof tenantA,
  data: {
    entity?: string;
    entityId?: string;
    action?: string;
    createdAt?: Date;
    oldValue?: object;
    newValue?: object;
  },
): Promise<string> {
  const entityId = data.entityId ?? randomUUID();
  await app.prisma.auditLog.create({
    data: {
      userId: tenant.adminUser.id,
      action: data.action ?? "UPDATE",
      entity: data.entity ?? "TimeEntry",
      entityId,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      ...(data.oldValue ? { oldValue: data.oldValue } : {}),
      ...(data.newValue ? { newValue: data.newValue } : {}),
    },
  });
  return entityId;
}

const ids = (logs: LogRow[]) => logs.map((l) => l.entityId);

beforeAll(async () => {
  app = await getTestApp();
  tenantA = await seedTestData(app, "alf854a");
  tenantB = await seedTestData(app, "alf854b");
  // Pin the zone: the day edges below are written for Europe/Berlin.
  await app.prisma.tenantConfig.update({
    where: { tenantId: tenantA.tenant.id },
    data: { timezone: "Europe/Berlin" },
  });
});

afterAll(async () => {
  await cleanupTestData(app, tenantA.tenant.id);
  await cleanupTestData(app, tenantB.tenant.id);
  await closeTestApp();
});

describe("GET /api/v1/audit-logs - period filter in the tenant's time zone", () => {
  it("includes 23:30 local on the last day and excludes 00:10 of the next local day", async () => {
    // Winter time (UTC+1): 22:30Z is 23:30 on 2026-01-15, 23:10Z is 00:10 on 2026-01-16.
    const inside = await row(tenantA, { createdAt: new Date("2026-01-15T22:30:00Z") });
    const outside = await row(tenantA, { createdAt: new Date("2026-01-15T23:10:00Z") });
    const { logs } = await list(tenantA.adminToken, "&from=2026-01-15&to=2026-01-15");
    expect(ids(logs)).toContain(inside);
    expect(ids(logs)).not.toContain(outside);
  });

  it("starts the first day at local midnight, not at UTC midnight", async () => {
    // Summer time (UTC+2): local midnight of 2026-07-10 is 2026-07-09T22:00Z.
    const first = await row(tenantA, { createdAt: new Date("2026-07-09T22:00:00Z") });
    const before = await row(tenantA, { createdAt: new Date("2026-07-09T21:59:00Z") });
    const { logs } = await list(tenantA.adminToken, "&from=2026-07-10&to=2026-07-10");
    expect(ids(logs)).toContain(first);
    expect(ids(logs)).not.toContain(before);
  });

  it("holds the edges across the autumn change to winter time (25-hour day)", async () => {
    // 2026-10-25: DST ends. Local 00:00 is 2026-10-24T22:00Z (UTC+2); local 23:30 is
    // 2026-10-25T22:30Z (UTC+1); local 00:10 of the 26th is 2026-10-25T23:10Z.
    const open = await row(tenantA, { createdAt: new Date("2026-10-24T22:00:00Z") });
    const late = await row(tenantA, { createdAt: new Date("2026-10-25T22:30:00Z") });
    const next = await row(tenantA, { createdAt: new Date("2026-10-25T23:10:00Z") });
    const prev = await row(tenantA, { createdAt: new Date("2026-10-24T21:59:00Z") });
    const { logs } = await list(tenantA.adminToken, "&from=2026-10-25&to=2026-10-25");
    expect(ids(logs)).toEqual(expect.arrayContaining([open, late]));
    expect(ids(logs)).not.toContain(next);
    expect(ids(logs)).not.toContain(prev);
  });

  it("holds the edges across the spring change to summer time (23-hour day)", async () => {
    // 2026-03-29: DST starts. Local 00:00 is 2026-03-28T23:00Z (UTC+1); local 23:30 is
    // 2026-03-29T21:30Z (UTC+2); local 00:10 of the 30th is 2026-03-29T22:10Z.
    const open = await row(tenantA, { createdAt: new Date("2026-03-28T23:00:00Z") });
    const late = await row(tenantA, { createdAt: new Date("2026-03-29T21:30:00Z") });
    const next = await row(tenantA, { createdAt: new Date("2026-03-29T22:10:00Z") });
    const { logs } = await list(tenantA.adminToken, "&from=2026-03-29&to=2026-03-29");
    expect(ids(logs)).toEqual(expect.arrayContaining([open, late]));
    expect(ids(logs)).not.toContain(next);
  });

  it("takes a bare from or a bare to as an open-ended period", async () => {
    const old = await row(tenantA, { createdAt: new Date("2025-02-01T12:00:00Z") });
    const fromOnly = await list(tenantA.adminToken, "&from=2026-01-01");
    expect(ids(fromOnly.logs)).not.toContain(old);
    const toOnly = await list(tenantA.adminToken, "&to=2025-02-01");
    expect(ids(toOnly.logs)).toContain(old);
  });

  it("rejects a malformed or impossible day and an inverted range with 400", async () => {
    for (const q of [
      "&from=15.01.2026",
      "&from=2026-02-31",
      "&to=nonsense",
      "&from=2026-02-02&to=2026-02-01",
    ]) {
      const res = await get(`/api/v1/audit-logs?${q}`, tenantA.adminToken);
      expect(res.statusCode, q).toBe(400);
    }
  });
});

describe("GET /api/v1/audit-logs - person filter", () => {
  it("finds Employee-entity, newValue and oldValue rows of the person and not another person's", async () => {
    const person = tenantA.employee.id;
    const other = tenantA.adminEmployee.id;
    const byEntity = await row(tenantA, { entity: "Employee", entityId: person });
    const byNew = await row(tenantA, { entity: "TimeEntry", newValue: { employeeId: person } });
    const byOld = await row(tenantA, { entity: "LeaveRequest", oldValue: { employeeId: person } });
    const ofOther = await row(tenantA, { entity: "TimeEntry", newValue: { employeeId: other } });
    const unrelated = await row(tenantA, { entity: "Salon" });

    const { logs, total } = await list(tenantA.adminToken, `&employeeId=${person}`);
    expect(ids(logs)).toEqual(expect.arrayContaining([byEntity, byNew, byOld]));
    expect(ids(logs)).not.toContain(ofOther);
    expect(ids(logs)).not.toContain(unrelated);
    expect(total).toBe(logs.length);
    for (const log of logs) {
      expect(log.affectedEmployee?.employeeNumber).toBe(tenantA.employee.employeeNumber);
    }
  });

  it("returns no foreign row for another tenant's employee id, and not tenant A's other rows", async () => {
    const foreignPerson = tenantB.employee.id;
    // A foreign row about that person, written by tenant B's admin.
    await app.prisma.auditLog.create({
      data: {
        userId: tenantB.adminUser.id,
        action: "UPDATE",
        entity: "Employee",
        entityId: foreignPerson,
      },
    });
    await row(tenantA, { entity: "Salon" });

    const { logs, total } = await list(tenantA.adminToken, `&employeeId=${foreignPerson}`);
    expect(logs).toEqual([]);
    expect(total).toBe(0);
  });

  it("answers affectedEmployee null for a foreign employee id named inside tenant A's own row", async () => {
    const named = await row(tenantA, {
      entity: "TimeEntry",
      newValue: { employeeId: tenantB.employee.id },
    });
    const { logs } = await list(tenantA.adminToken, `&entity=TimeEntry`);
    const found = logs.find((l) => l.entityId === named);
    expect(found).toBeDefined();
    expect(found?.affectedEmployee).toBeNull();
  });

  it("narrows further when combined with action, entity and period", async () => {
    const person = tenantA.employee.id;
    const hit = await row(tenantA, {
      entity: "TimeEntry",
      action: "DELETE",
      createdAt: new Date("2026-05-10T10:00:00Z"),
      newValue: { employeeId: person },
    });
    const wrongAction = await row(tenantA, {
      entity: "TimeEntry",
      action: "CREATE",
      createdAt: new Date("2026-05-10T10:00:00Z"),
      newValue: { employeeId: person },
    });
    const wrongDay = await row(tenantA, {
      entity: "TimeEntry",
      action: "DELETE",
      createdAt: new Date("2026-05-12T10:00:00Z"),
      newValue: { employeeId: person },
    });
    const { logs } = await list(
      tenantA.adminToken,
      `&employeeId=${person}&action=DELETE&entity=TimeEntry&from=2026-05-10&to=2026-05-10`,
    );
    expect(ids(logs)).toEqual([hit]);
    expect(ids(logs)).not.toContain(wrongAction);
    expect(ids(logs)).not.toContain(wrongDay);
  });

  it("rejects a malformed employee id with 400", async () => {
    const res = await get(`/api/v1/audit-logs?employeeId=not-a-uuid`, tenantA.adminToken);
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/v1/audit-logs - affectedEmployee and the response shape", () => {
  it("names the person of an Employee row and of a row with employeeId, else null", async () => {
    const self = await row(tenantA, { entity: "Employee", entityId: tenantA.employee.id });
    const viaValue = await row(tenantA, {
      entity: "LeaveRequest",
      newValue: { employeeId: tenantA.adminEmployee.id },
    });
    const none = await row(tenantA, { entity: "Salon" });
    const { logs } = await list(tenantA.adminToken);
    const by = (entityId: string) => logs.find((l) => l.entityId === entityId);
    expect(by(self)?.affectedEmployee).toEqual({
      firstName: tenantA.employee.firstName,
      lastName: tenantA.employee.lastName,
      employeeNumber: tenantA.employee.employeeNumber,
    });
    expect(by(viaValue)?.affectedEmployee?.employeeNumber).toBe(
      tenantA.adminEmployee.employeeNumber,
    );
    expect(by(none)?.affectedEmployee).toBeNull();
  });

  it("keeps { logs, total, page, limit } and attaches the person to GET /:id too", async () => {
    const res = await list(tenantA.adminToken, "&page=1");
    expect(Object.keys(res).sort()).toEqual(["limit", "logs", "page", "total"]);

    const one = await row(tenantA, { entity: "Employee", entityId: tenantA.employee.id });
    const found = (await list(tenantA.adminToken, `&employeeId=${tenantA.employee.id}`)).logs.find(
      (l) => l.entityId === one,
    );
    const detail = await get(`/api/v1/audit-logs/${found?.id}`, tenantA.adminToken);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(JSON.parse(detail.body).affectedEmployee).toEqual({
      firstName: tenantA.employee.firstName,
      lastName: tenantA.employee.lastName,
      employeeNumber: tenantA.employee.employeeNumber,
    });
  });

  it("does not let a tenant's list show another tenant's rows whatever the filter", async () => {
    const foreign = await app.prisma.auditLog.create({
      data: {
        userId: tenantB.adminUser.id,
        action: "UPDATE",
        entity: "TimeEntry",
        entityId: randomUUID(),
        createdAt: new Date("2026-01-15T12:00:00Z"),
        newValue: { employeeId: tenantA.employee.id },
      },
    });
    const { logs } = await list(
      tenantA.adminToken,
      `&employeeId=${tenantA.employee.id}&userId=${tenantB.adminUser.id}&from=2026-01-15&to=2026-01-15`,
    );
    expect(logs.map((l) => l.id)).not.toContain(foreign.id);
  });
});
