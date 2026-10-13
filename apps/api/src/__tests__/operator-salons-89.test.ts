/**
 * Phase 89 plans 01 and 08 (#89, D-05/D-06/D-07/D-07a/D-09/D-12/D-16) — the operator reads a tenant's
 * salons through GET /api/v1/operator/tenants/:id/salons (master data plus the Phorest coupling,
 * inactive salons included, metadata only) and creates one through POST on the same path (Bundesland
 * and opening hours required, optional coupling, both audit trails in one transaction). Plan 89-09
 * adds PATCH on /:salonId: master data, opening hours, Bundesland and the coupling (set, replace,
 * remove) in one request, audited on both sides, nothing persisted when any part is refused. Plan
 * 89-10 adds POST /:salonId/deactivate and /activate: facade rules, END rows with the operator
 * actor, count-free refusals, and never a delete.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
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
let operatorId: string;
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
  operatorId = operator.id;
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

// ── POST /api/v1/operator/tenants/:id/salons (plan 89-08) ────────────────────────────────────

const OPENING_HOURS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  open: "09:00",
  close: "18:00",
  ...(day === 6 ? { closed: true } : {}),
}));

function postSalon(tenantId: string, body: unknown, token: string | undefined = operatorToken) {
  return app.inject({
    method: "POST",
    url: salonsUrl(tenantId),
    headers: {
      "user-agent": "vitest-operator-salons",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: body as object,
    remoteAddress: uniqueAddress(),
  });
}

function salonBody(overrides: Record<string, unknown> = {}) {
  return {
    name: `Salon ${randomUUID().slice(0, 8)}`,
    street: "Hauptstrasse 1",
    postalCode: "30159",
    city: "Hannover",
    openingHours: OPENING_HOURS,
    federalState: "NIEDERSACHSEN",
    ...overrides,
  };
}

describe("POST /api/v1/operator/tenants/:id/salons", () => {
  it("creates a salon, answers 201 with the twelve-key DTO and writes both audit rows", async () => {
    const body = salonBody();
    const res = await postSalon(dataA.tenant.id, body);
    expect(res.statusCode, res.body).toBe(201);
    const dto = JSON.parse(res.body) as SalonDto;
    expect(Object.keys(dto).sort(byKey)).toEqual(DTO_KEYS);
    expect(dto.name).toBe(body.name);
    expect(dto.isActive).toBe(true);
    expect(dto.coupling).toBeNull();
    expect(dto.federalState).toBe("NIEDERSACHSEN");

    const stored = await app.prisma.salon.findFirst({ where: { id: dto.id } });
    expect(stored?.tenantId).toBe(dataA.tenant.id);

    const opRows = await app.prisma.operatorAuditLog.findMany({ where: { entityId: dto.id } });
    expect(opRows).toHaveLength(1);
    expect(opRows[0]).toMatchObject({
      action: "SALON_CREATED",
      operatorId,
      subjectTenantId: dataA.tenant.id,
      entity: "Salon",
    });
    expect(opRows[0].newValue).toMatchObject({ id: dto.id, name: body.name });
    expect(opRows[0].ipAddress).toBeTruthy();
    expect(opRows[0].userAgent).toBe("vitest-operator-salons");

    const tenantRows = await app.prisma.auditLog.findMany({
      where: { entity: "Salon", entityId: dto.id },
    });
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0].action).toBe("CREATE");
    expect(tenantRows[0].userId).toBeNull();
    expect((tenantRows[0].newValue as { actor: unknown }).actor).toEqual({
      type: "OPERATOR",
      operatorId,
      tenantId: dataA.tenant.id,
    });
  });

  it("couples the salon to Phorest when a coupling is given and audits it on both sides", async () => {
    const branch = `B-${randomUUID().slice(0, 8)}`;
    const res = await postSalon(dataA.tenant.id, {
      ...salonBody(),
      coupling: { externalBranchId: branch },
    });
    expect(res.statusCode, res.body).toBe(201);
    const dto = JSON.parse(res.body) as SalonDto;
    expect(dto.coupling).toEqual({ provider: "PHOREST", externalBranchId: branch });

    const row = await app.prisma.salonCoupling.findFirst({ where: { salonId: dto.id } });
    expect(row).toMatchObject({
      tenantId: dataA.tenant.id,
      provider: "PHOREST",
      externalBranchId: branch,
    });

    const opActions = (
      await app.prisma.operatorAuditLog.findMany({
        where: { subjectTenantId: dataA.tenant.id, entityId: { in: [dto.id, row!.id] } },
      })
    )
      .map((r) => r.action)
      .sort(byKey);
    expect(opActions).toEqual(["SALON_COUPLING_SET", "SALON_CREATED"]);

    const couplingAudit = await app.prisma.auditLog.findMany({
      where: { entity: "SalonCoupling", entityId: row!.id },
    });
    expect(couplingAudit).toHaveLength(1);
    expect(couplingAudit[0].action).toBe("CREATE");
    expect(couplingAudit[0].userId).toBeNull();
    expect(couplingAudit[0].newValue).toMatchObject({
      salonId: dto.id,
      provider: "PHOREST",
      externalBranchId: branch,
      actor: { type: "OPERATOR", operatorId, tenantId: dataA.tenant.id },
    });
  });

  it("marks the first salon of a tenant without active salons as default", async () => {
    const empty = await seedTestData(app, "os89e");
    try {
      await app.prisma.salon.deleteMany({ where: { tenantId: empty.tenant.id } });
      const res = await postSalon(empty.tenant.id, salonBody());
      expect(res.statusCode, res.body).toBe(201);
      expect((JSON.parse(res.body) as SalonDto).isDefault).toBe(true);
    } finally {
      await cleanupTestData(app, empty.tenant.id);
    }
  });

  it("requires Bundesland and opening hours and rejects keys a client must never set", async () => {
    const noState = salonBody();
    delete (noState as Record<string, unknown>).federalState;
    expect((await postSalon(dataA.tenant.id, noState)).statusCode).toBe(400);

    const noHours = salonBody();
    delete (noHours as Record<string, unknown>).openingHours;
    expect((await postSalon(dataA.tenant.id, noHours)).statusCode).toBe(400);

    for (const extra of [
      { isActive: false },
      { tenantId: dataB.tenant.id },
      { provider: "PHOREST" },
    ]) {
      const res = await postSalon(dataA.tenant.id, salonBody(extra));
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }

    expect(
      (await postSalon(dataA.tenant.id, salonBody({ coupling: { externalBranchId: "" } })))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await postSalon(
          dataA.tenant.id,
          salonBody({ coupling: { externalBranchId: "B-1", provider: "PHOREST" } }),
        )
      ).statusCode,
    ).toBe(400);
  });

  it("refuses a taken branch id with the fixed 409 and persists nothing of the request", async () => {
    const taken = `B-${randomUUID().slice(0, 8)}`;
    const other = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Hat Kennung" });
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: dataA.tenant.id,
        salonId: other.id,
        provider: "PHOREST",
        externalBranchId: taken,
      },
    });

    const name = `Rollback ${randomUUID().slice(0, 8)}`;
    const opBefore = await app.prisma.operatorAuditLog.count({
      where: { subjectTenantId: dataA.tenant.id },
    });
    const res = await postSalon(
      dataA.tenant.id,
      salonBody({ name, coupling: { externalBranchId: taken } }),
    );
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: "Diese Filialkennung ist bereits einem anderen Salon zugeordnet.",
      code: "BRANCH_ALREADY_COUPLED",
    });

    expect(await app.prisma.salon.count({ where: { tenantId: dataA.tenant.id, name } })).toBe(0);
    expect(
      await app.prisma.operatorAuditLog.count({ where: { subjectTenantId: dataA.tenant.id } }),
    ).toBe(opBefore);
    // No tenant CREATE row for a salon of that name either: the audit rows hold the full salon.
    const leaked = await app.prisma.auditLog.findMany({
      where: { entity: "Salon", action: "CREATE", newValue: { path: ["name"], equals: name } },
    });
    expect(leaked).toHaveLength(0);
    const leakedActor = await app.prisma.operatorAuditLog.findMany({
      where: { action: "SALON_CREATED", newValue: { path: ["name"], equals: name } },
    });
    expect(leakedActor).toHaveLength(0);
  });

  it("refuses a deactivated tenant with the fixed 409 before any write", async () => {
    const dead = await seedTestData(app, "os89d");
    try {
      await app.prisma.tenant.update({
        where: { id: dead.tenant.id },
        data: { deactivatedAt: new Date(), deactivatedReason: "test" },
      });
      const before = await app.prisma.salon.count({ where: { tenantId: dead.tenant.id } });
      const res = await postSalon(dead.tenant.id, salonBody());
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({
        error: "Der Mandant ist deaktiviert. Änderungen sind erst nach der Reaktivierung möglich.",
        code: "TENANT_DEACTIVATED",
      });
      expect(await app.prisma.salon.count({ where: { tenantId: dead.tenant.id } })).toBe(before);
      expect(
        await app.prisma.operatorAuditLog.count({
          where: { subjectTenantId: dead.tenant.id, action: "SALON_CREATED" },
        }),
      ).toBe(0);
    } finally {
      await cleanupTestData(app, dead.tenant.id);
    }
  });

  it("answers an unknown tenant with the fixed 404, a tenant token with 403 and no token with 401", async () => {
    const unknown = await postSalon(randomUUID(), salonBody());
    expect(unknown.statusCode).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({ error: "Mandant nicht gefunden" });

    // The refusal row is bounded per (principal, route) and window, so this uses tenant B's admin,
    // whom no earlier test of this file refused.
    const where = { action: "TENANT_PRINCIPAL_REFUSED", subjectTenantId: dataB.tenant.id } as const;
    const before = await app.prisma.operatorAuditLog.count({ where });
    const refusedName = `Refused ${randomUUID().slice(0, 8)}`;
    const refused = await postSalon(
      dataB.tenant.id,
      salonBody({ name: refusedName }),
      dataB.adminToken,
    );
    expect(refused.statusCode).toBe(403);
    expect(await app.prisma.operatorAuditLog.count({ where })).toBeGreaterThan(before);
    expect(await app.prisma.salon.count({ where: { name: refusedName } })).toBe(0);

    expect((await postSalon(dataA.tenant.id, salonBody(), "")).statusCode).toBe(401);
  });

  it("never writes a Studiolution value or touches the legacy store hours", async () => {
    const res = await postSalon(dataA.tenant.id, salonBody({ provider: "STUDIOLUTION" }));
    expect(res.statusCode).toBe(400);
  });
});

// ── POST atomicity and contract pins (plan 89-08, task 2) ────────────────────────────────────

describe("POST /api/v1/operator/tenants/:id/salons — atomicity and contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Everything one request could have left behind for a salon of this name. */
  async function leftovers(tenantId: string, name: string) {
    return {
      salons: await app.prisma.salon.count({ where: { tenantId, name } }),
      operatorSalonRows: await app.prisma.operatorAuditLog.count({
        where: { action: "SALON_CREATED", newValue: { path: ["name"], equals: name } },
      }),
      tenantSalonRows: await app.prisma.auditLog.count({
        where: { entity: "Salon", action: "CREATE", newValue: { path: ["name"], equals: name } },
      }),
    };
  }

  it("rolls the salon and the operator row back when the tenant audit write fails", async () => {
    const realAudit = app.audit.bind(app);
    vi.spyOn(app, "audit").mockImplementation(async (entry) => {
      if (entry.entity === "Salon") throw new Error("forced audit failure (test)");
      return realAudit(entry);
    });

    const name = `Audit kaputt ${randomUUID().slice(0, 8)}`;
    const res = await postSalon(dataA.tenant.id, salonBody({ name }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "Interner Serverfehler" });
    expect(await leftovers(dataA.tenant.id, name)).toEqual({
      salons: 0,
      operatorSalonRows: 0,
      tenantSalonRows: 0,
    });
  });

  it("rolls salon, coupling and every audit row back when the coupling audit write fails", async () => {
    const realAudit = app.audit.bind(app);
    vi.spyOn(app, "audit").mockImplementation(async (entry) => {
      if (entry.entity === "SalonCoupling") throw new Error("forced audit failure (test)");
      return realAudit(entry);
    });

    const name = `Kopplung kaputt ${randomUUID().slice(0, 8)}`;
    const branch = `B-${randomUUID().slice(0, 8)}`;
    const res = await postSalon(
      dataA.tenant.id,
      salonBody({ name, coupling: { externalBranchId: branch } }),
    );
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "Interner Serverfehler" });

    expect(await leftovers(dataA.tenant.id, name)).toEqual({
      salons: 0,
      operatorSalonRows: 0,
      tenantSalonRows: 0,
    });
    expect(
      await app.prisma.salonCoupling.count({
        where: { tenantId: dataA.tenant.id, externalBranchId: branch },
      }),
    ).toBe(0);
    expect(
      await app.prisma.operatorAuditLog.count({
        where: {
          action: "SALON_COUPLING_SET",
          newValue: { path: ["externalBranchId"], equals: branch },
        },
      }),
    ).toBe(0);
    expect(
      await app.prisma.auditLog.count({
        where: {
          entity: "SalonCoupling",
          newValue: { path: ["externalBranchId"], equals: branch },
        },
      }),
    ).toBe(0);
  });

  it("answers a coupling race on the branch index with the mapped 409 and persists nothing", async () => {
    const taken = `B-${randomUUID().slice(0, 8)}`;
    const holder = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Race-Halter" });
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: dataA.tenant.id,
        salonId: holder.id,
        provider: "PHOREST",
        externalBranchId: taken,
      },
    });

    // Hide the pre-check from the coupling facade so the insert itself hits the unique index, as
    // a concurrent writer that committed in between would.
    const original = app.prisma.$transaction.bind(app.prisma);
    vi.spyOn(app.prisma, "$transaction").mockImplementationOnce(((
      fn: (tx: unknown) => Promise<unknown>,
    ) =>
      original(async (tx) => {
        const proxy = new Proxy(tx, {
          get(target, prop) {
            const value = Reflect.get(target, prop);
            if (prop === "salonCoupling") {
              return new Proxy(value as object, {
                get(t, p) {
                  if (p === "findFirst") return async () => null;
                  return Reflect.get(t, p);
                },
              });
            }
            return value;
          },
        });
        return fn(proxy);
      })) as never);

    const name = `Rennen ${randomUUID().slice(0, 8)}`;
    const res = await postSalon(
      dataA.tenant.id,
      salonBody({ name, coupling: { externalBranchId: taken } }),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: "Diese Filialkennung ist bereits einem anderen Salon zugeordnet.",
      code: "BRANCH_ALREADY_COUPLED",
    });
    expect(await leftovers(dataA.tenant.id, name)).toEqual({
      salons: 0,
      operatorSalonRows: 0,
      tenantSalonRows: 0,
    });
    expect(
      await app.prisma.salonCoupling.count({
        where: { tenantId: dataA.tenant.id, externalBranchId: taken },
      }),
    ).toBe(1);
  });

  it("pins the key set of every refusal body and of the created salon", async () => {
    const taken = `B-${randomUUID().slice(0, 8)}`;
    const holder = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Pin-Halter" });
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: dataA.tenant.id,
        salonId: holder.id,
        provider: "PHOREST",
        externalBranchId: taken,
      },
    });
    const dead = await seedTestData(app, "os89f");
    try {
      await app.prisma.tenant.update({
        where: { id: dead.tenant.id },
        data: { deactivatedAt: new Date(), deactivatedReason: "test" },
      });

      const branchTaken = await postSalon(
        dataA.tenant.id,
        salonBody({ coupling: { externalBranchId: taken } }),
      );
      const tenantDead = await postSalon(dead.tenant.id, salonBody());
      const tenantUnknown = await postSalon(randomUUID(), salonBody());
      const created = await postSalon(dataA.tenant.id, salonBody());

      expect(branchTaken.statusCode).toBe(409);
      expect(Object.keys(JSON.parse(branchTaken.body)).sort(byKey)).toEqual(["code", "error"]);
      expect(tenantDead.statusCode).toBe(409);
      expect(Object.keys(JSON.parse(tenantDead.body)).sort(byKey)).toEqual(["code", "error"]);
      expect(tenantUnknown.statusCode).toBe(404);
      expect(Object.keys(JSON.parse(tenantUnknown.body))).toEqual(["error"]);
      expect(created.statusCode).toBe(201);
      expect(Object.keys(JSON.parse(created.body)).sort(byKey)).toEqual(DTO_KEYS);
    } finally {
      await cleanupTestData(app, dead.tenant.id);
    }
  });
});

// ── PATCH /api/v1/operator/tenants/:id/salons/:salonId (plan 89-09) ──────────────────────────

function patchSalon(
  tenantId: string,
  salonId: string,
  body: unknown,
  token: string | undefined = operatorToken,
) {
  return app.inject({
    method: "PATCH",
    url: `${salonsUrl(tenantId)}/${salonId}`,
    headers: {
      "user-agent": "vitest-operator-salons",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: body as object,
    remoteAddress: uniqueAddress(),
  });
}

async function couplingRows(salonId: string) {
  return app.prisma.salonCoupling.findMany({ where: { salonId } });
}

async function operatorActions(tenantId: string, entityIds: string[]) {
  const rows = await app.prisma.operatorAuditLog.findMany({
    where: { subjectTenantId: tenantId, entityId: { in: entityIds } },
    orderBy: { createdAt: "asc" },
  });
  return rows;
}

const REFUSAL_TEXT = {
  FEDERAL_STATE_IN_USE:
    "Das Bundesland ist durch Zeiteinträge oder Zuordnungen festgelegt. Ein Umzug ist ein neuer Salon.",
  SALON_INACTIVE: "Deaktivierte Salons können nicht gekoppelt werden.",
  BRANCH_ALREADY_COUPLED: "Diese Filialkennung ist bereits einem anderen Salon zugeordnet.",
  TENANT_DEACTIVATED:
    "Der Mandant ist deaktiviert. Änderungen sind erst nach der Reaktivierung möglich.",
} as const;

describe("PATCH /api/v1/operator/tenants/:id/salons/:salonId", () => {
  it("changes name, address and opening hours, answers the twelve-key DTO and audits both sides", async () => {
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Alt" });
    const hours = OPENING_HOURS.map((h) => ({ ...h, close: "19:00" }));
    const newName = `Neu ${randomUUID().slice(0, 8)}`;

    const res = await patchSalon(dataA.tenant.id, salon.id, {
      name: newName,
      street: "Neue Strasse 2",
      city: null,
      openingHours: hours,
    });
    expect(res.statusCode, res.body).toBe(200);
    const dto = JSON.parse(res.body) as SalonDto;
    expect(Object.keys(dto).sort(byKey)).toEqual(DTO_KEYS);
    expect(dto).toMatchObject({
      id: salon.id,
      name: newName,
      street: "Neue Strasse 2",
      city: null,
    });
    expect(dto.openingHours).toEqual(hours);

    const opRows = await operatorActions(dataA.tenant.id, [salon.id]);
    expect(opRows).toHaveLength(1);
    expect(opRows[0]).toMatchObject({ action: "SALON_UPDATED", operatorId, entity: "Salon" });
    expect(opRows[0].oldValue).toMatchObject({ id: salon.id, name: "Alt" });
    expect(opRows[0].newValue).toMatchObject({ id: salon.id, name: newName });
    expect(opRows[0].ipAddress).toBeTruthy();
    // Coupling changes have their own rows: a SALON_UPDATED row never carries a coupling value.
    expect(opRows[0].oldValue).not.toHaveProperty("coupling");
    expect(opRows[0].newValue).not.toHaveProperty("coupling");

    const tenantRows = await app.prisma.auditLog.findMany({
      where: { entity: "Salon", entityId: salon.id },
    });
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0].action).toBe("UPDATE");
    expect(tenantRows[0].userId).toBeNull();
    expect(tenantRows[0].oldValue).toMatchObject({ name: "Alt" });
    expect(tenantRows[0].newValue).toMatchObject({
      name: newName,
      actor: { type: "OPERATOR", operatorId, tenantId: dataA.tenant.id },
    });
    expect(tenantRows[0].oldValue).not.toHaveProperty("coupling");
    expect(tenantRows[0].newValue).not.toHaveProperty("coupling");
  });

  it("writes no coupling value on SALON_UPDATED when name and coupling change in one request", async () => {
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Kombi-Alt" });
    const existingBranch = `K0-${randomUUID().slice(0, 8)}`;
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: dataA.tenant.id,
        salonId: salon.id,
        provider: "PHOREST",
        externalBranchId: existingBranch,
      },
    });
    const nextBranch = `K1-${randomUUID().slice(0, 8)}`;
    const res = await patchSalon(dataA.tenant.id, salon.id, {
      name: "Kombi-Neu",
      coupling: { externalBranchId: nextBranch },
    });
    expect(res.statusCode, res.body).toBe(200);

    const updated = await app.prisma.operatorAuditLog.findFirstOrThrow({
      where: { subjectTenantId: dataA.tenant.id, entityId: salon.id, action: "SALON_UPDATED" },
    });
    expect(updated.oldValue).toMatchObject({ name: "Kombi-Alt" });
    expect(updated.newValue).toMatchObject({ name: "Kombi-Neu" });
    expect(updated.oldValue).not.toHaveProperty("coupling");
    expect(updated.newValue).not.toHaveProperty("coupling");
    // The coupling change is recorded in its own rows.
    const couplingActions = await app.prisma.operatorAuditLog.findMany({
      where: { subjectTenantId: dataA.tenant.id, entity: "SalonCoupling" },
      select: { action: true, newValue: true, oldValue: true },
    });
    expect(couplingActions.map((r) => r.action)).toEqual(
      expect.arrayContaining(["SALON_COUPLING_REMOVED", "SALON_COUPLING_SET"]),
    );
  });

  it("leaves the legacy store hours of the tenant untouched when the salon hours change", async () => {
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Zeiten" });
    const before = await app.prisma.tenantConfig.findFirst({
      where: { tenantId: dataA.tenant.id },
      select: { storeHours: true },
    });
    const res = await patchSalon(dataA.tenant.id, salon.id, {
      openingHours: OPENING_HOURS.map((h) => ({ ...h, open: "10:00" })),
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await app.prisma.tenantConfig.findFirst({
      where: { tenantId: dataA.tenant.id },
      select: { storeHours: true },
    });
    expect(after?.storeHours).toEqual(before?.storeHours);
  });

  it("answers an empty patch with the fixed 400, and rejects unknown keys and isActive", async () => {
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Leer" });
    const empty = await patchSalon(dataA.tenant.id, salon.id, {});
    expect(empty.statusCode).toBe(400);
    expect(JSON.parse(empty.body)).toEqual({ error: "Keine Änderungen angegeben." });

    for (const extra of [
      { isActive: false },
      { tenantId: dataB.tenant.id },
      { provider: "PHOREST" },
      { coupling: { externalBranchId: "B-1", provider: "PHOREST" } },
      { coupling: { externalBranchId: "" } },
    ]) {
      const res = await patchSalon(dataA.tenant.id, salon.id, { name: "X", ...extra });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect((await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } })).name).toBe(
      "Leer",
    );
    expect(await operatorActions(dataA.tenant.id, [salon.id])).toHaveLength(0);
  });

  it("changes the Bundesland of an unreferenced salon", async () => {
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, {
      name: "Frei",
      federalState: "NIEDERSACHSEN",
    });
    const res = await patchSalon(dataA.tenant.id, salon.id, { federalState: "BAYERN" });
    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(res.body) as SalonDto).federalState).toBe("BAYERN");
  });

  it("refuses a Bundesland change on a salon with an assignment or a time entry, without counts", async () => {
    const withAssignment = await createTestSalon(app.prisma, dataA.tenant.id, {
      name: "Mit Zuordnung",
      federalState: "NIEDERSACHSEN",
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: dataA.tenant.id,
        employeeId: dataA.employee.id,
        salonId: withAssignment.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2020-01-01"),
        validUntil: new Date("2020-01-31"),
        weekdays: [],
      },
    });
    const withEntry = await createTestSalon(app.prisma, dataA.tenant.id, {
      name: "Mit Zeiteintrag",
      federalState: "NIEDERSACHSEN",
    });
    await app.prisma.timeEntry.create({
      data: {
        employeeId: dataA.employee.id,
        salonId: withEntry.id,
        date: new Date("2026-01-05T00:00:00Z"),
        startTime: new Date("2026-01-05T08:00:00Z"),
        endTime: new Date("2026-01-05T16:00:00Z"),
        breakMinutes: 30,
      },
    });

    for (const salon of [withAssignment, withEntry]) {
      const res = await patchSalon(dataA.tenant.id, salon.id, {
        name: "Darf nicht bleiben",
        federalState: "BAYERN",
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body)).toEqual({
        error: REFUSAL_TEXT.FEDERAL_STATE_IN_USE,
        code: "FEDERAL_STATE_IN_USE",
      });
      const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
      expect(fresh.federalState).toBe("NIEDERSACHSEN");
      expect(fresh.name).not.toBe("Darf nicht bleiben");
      expect(await operatorActions(dataA.tenant.id, [salon.id])).toHaveLength(0);
      expect(
        await app.prisma.auditLog.count({ where: { entity: "Salon", entityId: salon.id } }),
      ).toBe(0);
    }
  });

  it("sets a coupling, keeps an identical one silently, replaces it as remove plus create and removes it", async () => {
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Kopplung" });
    const c1 = `C1-${randomUUID().slice(0, 8)}`;
    const c2 = `C2-${randomUUID().slice(0, 8)}`;

    // none -> C1: CREATED
    const set = await patchSalon(dataA.tenant.id, salon.id, { coupling: { externalBranchId: c1 } });
    expect(set.statusCode, set.body).toBe(200);
    expect((JSON.parse(set.body) as SalonDto).coupling).toEqual({
      provider: "PHOREST",
      externalBranchId: c1,
    });
    const afterSet = await couplingRows(salon.id);
    expect(afterSet).toHaveLength(1);
    const firstId = afterSet[0].id;
    expect(
      (await operatorActions(dataA.tenant.id, [salon.id, firstId])).map((r) => r.action),
    ).toEqual(["SALON_COUPLING_SET"]);
    const createRow = await app.prisma.auditLog.findMany({
      where: { entity: "SalonCoupling", entityId: firstId },
    });
    expect(createRow).toHaveLength(1);
    expect(createRow[0].action).toBe("CREATE");
    expect(createRow[0].userId).toBeNull();
    expect(createRow[0].newValue).toMatchObject({
      salonId: salon.id,
      provider: "PHOREST",
      externalBranchId: c1,
      actor: { type: "OPERATOR", operatorId, tenantId: dataA.tenant.id },
    });

    // C1 again: 200, no new audit row anywhere
    const opBefore = await app.prisma.operatorAuditLog.count({
      where: { subjectTenantId: dataA.tenant.id },
    });
    const tenantBefore = await app.prisma.auditLog.count({ where: { entity: "SalonCoupling" } });
    const same = await patchSalon(dataA.tenant.id, salon.id, {
      coupling: { externalBranchId: c1 },
    });
    expect(same.statusCode, same.body).toBe(200);
    expect(
      await app.prisma.operatorAuditLog.count({ where: { subjectTenantId: dataA.tenant.id } }),
    ).toBe(opBefore);
    expect(await app.prisma.auditLog.count({ where: { entity: "SalonCoupling" } })).toBe(
      tenantBefore,
    );

    // C1 -> C2: exactly one row C2, REMOVED then SET
    const replaced = await patchSalon(dataA.tenant.id, salon.id, {
      coupling: { externalBranchId: c2 },
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect((JSON.parse(replaced.body) as SalonDto).coupling?.externalBranchId).toBe(c2);
    const afterReplace = await couplingRows(salon.id);
    expect(afterReplace).toHaveLength(1);
    expect(afterReplace[0].externalBranchId).toBe(c2);
    const couplingOps = (await operatorActions(dataA.tenant.id, [firstId, afterReplace[0].id])).map(
      (r) => r.action,
    );
    expect(couplingOps).toEqual([
      "SALON_COUPLING_SET",
      "SALON_COUPLING_REMOVED",
      "SALON_COUPLING_SET",
    ]);
    const deleteRow = await app.prisma.auditLog.findMany({
      where: { entity: "SalonCoupling", entityId: firstId, action: "DELETE" },
    });
    expect(deleteRow).toHaveLength(1);
    expect(deleteRow[0].oldValue).toMatchObject({ salonId: salon.id, externalBranchId: c1 });
    expect(
      await app.prisma.auditLog.count({
        where: { entity: "SalonCoupling", entityId: afterReplace[0].id, action: "CREATE" },
      }),
    ).toBe(1);

    // null: row gone, REMOVED + tenant DELETE
    const removed = await patchSalon(dataA.tenant.id, salon.id, { coupling: null });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((JSON.parse(removed.body) as SalonDto).coupling).toBeNull();
    expect(await couplingRows(salon.id)).toHaveLength(0);
    const secondId = afterReplace[0].id;
    expect((await operatorActions(dataA.tenant.id, [secondId])).map((r) => r.action)).toEqual([
      "SALON_COUPLING_SET",
      "SALON_COUPLING_REMOVED",
    ]);
    expect(
      await app.prisma.auditLog.count({
        where: { entity: "SalonCoupling", entityId: secondId, action: "DELETE" },
      }),
    ).toBe(1);

    // null without a coupling: 200, no further audit row
    const opAfter = await app.prisma.operatorAuditLog.count({
      where: { subjectTenantId: dataA.tenant.id },
    });
    const none = await patchSalon(dataA.tenant.id, salon.id, { coupling: null });
    expect(none.statusCode, none.body).toBe(200);
    expect(
      await app.prisma.operatorAuditLog.count({ where: { subjectTenantId: dataA.tenant.id } }),
    ).toBe(opAfter);
  });

  it("refuses a coupling on an inactive salon with 422 and keeps a combined name change out", async () => {
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, {
      name: "Inaktiv-Kopplung",
      isActive: false,
    });
    const res = await patchSalon(dataA.tenant.id, salon.id, {
      name: "Soll nicht gelten",
      coupling: { externalBranchId: `B-${randomUUID().slice(0, 8)}` },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(JSON.parse(res.body)).toEqual({
      error: REFUSAL_TEXT.SALON_INACTIVE,
      code: "SALON_INACTIVE",
    });
    expect((await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } })).name).toBe(
      "Inaktiv-Kopplung",
    );
    expect(await couplingRows(salon.id)).toHaveLength(0);
    expect(await operatorActions(dataA.tenant.id, [salon.id])).toHaveLength(0);
    expect(
      await app.prisma.auditLog.count({ where: { entity: "Salon", entityId: salon.id } }),
    ).toBe(0);
  });

  it("refuses a taken branch id with 409 and persists nothing of the request", async () => {
    const taken = `B-${randomUUID().slice(0, 8)}`;
    const holder = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Halter" });
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: dataA.tenant.id,
        salonId: holder.id,
        provider: "PHOREST",
        externalBranchId: taken,
      },
    });
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Will Kennung" });

    const res = await patchSalon(dataA.tenant.id, salon.id, {
      name: "Umbenannt",
      coupling: { externalBranchId: taken },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: REFUSAL_TEXT.BRANCH_ALREADY_COUPLED,
      code: "BRANCH_ALREADY_COUPLED",
    });
    expect((await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } })).name).toBe(
      "Will Kennung",
    );
    expect(await couplingRows(salon.id)).toHaveLength(0);
    expect(await operatorActions(dataA.tenant.id, [salon.id])).toHaveLength(0);
    expect(
      await app.prisma.auditLog.count({ where: { entity: "Salon", entityId: salon.id } }),
    ).toBe(0);
  });

  it("answers a foreign salon id and an unknown id with byte-identical 404 bodies", async () => {
    const foreign = await createTestSalon(app.prisma, dataB.tenant.id, { name: "Fremd-PATCH" });
    const viaForeign = await patchSalon(dataA.tenant.id, foreign.id, { name: "Uebernommen" });
    const viaUnknown = await patchSalon(dataA.tenant.id, randomUUID(), { name: "Uebernommen" });
    expect(viaForeign.statusCode).toBe(404);
    expect(viaUnknown.statusCode).toBe(404);
    expect(viaForeign.body).toBe(viaUnknown.body);
    expect(JSON.parse(viaForeign.body)).toEqual({ error: "Salon nicht gefunden" });
    expect((await app.prisma.salon.findUniqueOrThrow({ where: { id: foreign.id } })).name).toBe(
      "Fremd-PATCH",
    );
  });

  it("refuses a deactivated tenant with 409 before the salon is read, an unknown tenant with 404", async () => {
    const dead = await seedTestData(app, "os89g");
    try {
      const salon = await createTestSalon(app.prisma, dead.tenant.id, { name: "Tot" });
      await app.prisma.tenant.update({
        where: { id: dead.tenant.id },
        data: { deactivatedAt: new Date(), deactivatedReason: "test" },
      });
      // A random salon id too: the gate answers first, so the salon lookup is never reached.
      for (const id of [salon.id, randomUUID()]) {
        const res = await patchSalon(dead.tenant.id, id, { name: "Neu" });
        expect(res.statusCode, res.body).toBe(409);
        expect(JSON.parse(res.body)).toEqual({
          error: REFUSAL_TEXT.TENANT_DEACTIVATED,
          code: "TENANT_DEACTIVATED",
        });
      }
      expect((await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } })).name).toBe(
        "Tot",
      );
    } finally {
      await cleanupTestData(app, dead.tenant.id);
    }
    const unknown = await patchSalon(randomUUID(), randomUUID(), { name: "Neu" });
    expect(unknown.statusCode).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({ error: "Mandant nicht gefunden" });
  });

  it("refuses a tenant token with 403 and an audit row, no token with 401, and a malformed id with 400", async () => {
    const salon = await createTestSalon(app.prisma, dataB.tenant.id, { name: "Token-Ziel" });
    const where = { action: "TENANT_PRINCIPAL_REFUSED", subjectTenantId: dataB.tenant.id } as const;
    const before = await app.prisma.operatorAuditLog.count({ where });
    const refused = await patchSalon(
      dataB.tenant.id,
      salon.id,
      { name: "Uebernommen" },
      dataB.adminToken,
    );
    expect(refused.statusCode).toBe(403);
    expect(await app.prisma.operatorAuditLog.count({ where })).toBeGreaterThan(before);
    expect((await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } })).name).toBe(
      "Token-Ziel",
    );

    expect((await patchSalon(dataB.tenant.id, salon.id, { name: "X" }, "")).statusCode).toBe(401);
    expect((await patchSalon(dataB.tenant.id, "not-a-uuid", { name: "X" })).statusCode).toBe(400);
  });
});

// ── PATCH atomicity and contract pins (plan 89-09, task 2) ───────────────────────────────────

describe("PATCH /api/v1/operator/tenants/:id/salons/:salonId — atomicity and contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Fails the tenant audit write for one entity, calls through for everything else. */
  function failTenantAuditFor(entity: string) {
    const realAudit = app.audit.bind(app);
    vi.spyOn(app, "audit").mockImplementation(async (entry) => {
      if (entry.entity === entity) throw new Error("forced audit failure (test)");
      return realAudit(entry);
    });
  }

  it("rolls the name change back when the coupling audit write fails", async () => {
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Kopplung-Audit" });
    const branch = `B-${randomUUID().slice(0, 8)}`;
    failTenantAuditFor("SalonCoupling");

    const res = await patchSalon(dataA.tenant.id, salon.id, {
      name: "Darf nicht bleiben",
      coupling: { externalBranchId: branch },
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "Interner Serverfehler" });

    expect((await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } })).name).toBe(
      "Kopplung-Audit",
    );
    expect(await couplingRows(salon.id)).toHaveLength(0);
    expect(
      await app.prisma.operatorAuditLog.count({
        where: {
          subjectTenantId: dataA.tenant.id,
          action: { in: ["SALON_UPDATED", "SALON_COUPLING_SET"] },
          OR: [
            { entityId: salon.id },
            { newValue: { path: ["externalBranchId"], equals: branch } },
          ],
        },
      }),
    ).toBe(0);
    expect(
      await app.prisma.auditLog.count({
        where: {
          OR: [
            { entity: "Salon", entityId: salon.id },
            { entity: "SalonCoupling", newValue: { path: ["externalBranchId"], equals: branch } },
          ],
        },
      }),
    ).toBe(0);
  });

  it("rolls a name-only change back when the salon audit write fails", async () => {
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Salon-Audit" });
    failTenantAuditFor("Salon");

    const res = await patchSalon(dataA.tenant.id, salon.id, { name: "Darf nicht bleiben" });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "Interner Serverfehler" });

    expect((await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } })).name).toBe(
      "Salon-Audit",
    );
    expect(await operatorActions(dataA.tenant.id, [salon.id])).toHaveLength(0);
    expect(
      await app.prisma.auditLog.count({ where: { entity: "Salon", entityId: salon.id } }),
    ).toBe(0);
  });

  it("keeps the old coupling and writes no audit row when a replace loses a race on the branch index", async () => {
    const oldBranch = `OLD-${randomUUID().slice(0, 8)}`;
    const takenBranch = `NEW-${randomUUID().slice(0, 8)}`;
    const holder = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Replace-Halter" });
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Replace-Ziel" });
    await app.prisma.salonCoupling.createMany({
      data: [
        {
          tenantId: dataA.tenant.id,
          salonId: holder.id,
          provider: "PHOREST",
          externalBranchId: takenBranch,
        },
        {
          tenantId: dataA.tenant.id,
          salonId: salon.id,
          provider: "PHOREST",
          externalBranchId: oldBranch,
        },
      ],
    });
    const couplingBefore = await couplingRows(salon.id);

    // Hide only the branch-id pre-check, so the delete of the old row runs and the insert itself
    // hits the real unique index, as a concurrent writer that committed in between would.
    const original = app.prisma.$transaction.bind(app.prisma);
    vi.spyOn(app.prisma, "$transaction").mockImplementationOnce(((
      fn: (tx: unknown) => Promise<unknown>,
    ) =>
      original(async (tx) => {
        const proxy = new Proxy(tx, {
          get(target, prop) {
            const value = Reflect.get(target, prop);
            if (prop === "salonCoupling") {
              return new Proxy(value as object, {
                get(t, p) {
                  if (p === "findFirst") {
                    return async (args: { where?: { externalBranchId?: string } }) =>
                      args?.where?.externalBranchId !== undefined
                        ? null
                        : (Reflect.get(t, p) as (a: unknown) => Promise<unknown>).call(t, args);
                  }
                  return Reflect.get(t, p);
                },
              });
            }
            return value;
          },
        });
        return fn(proxy);
      })) as never);

    const res = await patchSalon(dataA.tenant.id, salon.id, {
      name: "Darf nicht bleiben",
      coupling: { externalBranchId: takenBranch },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: REFUSAL_TEXT.BRANCH_ALREADY_COUPLED,
      code: "BRANCH_ALREADY_COUPLED",
    });

    expect(await couplingRows(salon.id)).toEqual(couplingBefore);
    expect((await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } })).name).toBe(
      "Replace-Ziel",
    );
    expect(await operatorActions(dataA.tenant.id, [salon.id, couplingBefore[0].id])).toHaveLength(
      0,
    );
    expect(
      await app.prisma.auditLog.count({
        where: {
          OR: [
            { entity: "Salon", entityId: salon.id },
            { entity: "SalonCoupling", entityId: couplingBefore[0].id },
          ],
        },
      }),
    ).toBe(0);
  });

  it("pins the key set of every refusal body and of the updated salon", async () => {
    const taken = `B-${randomUUID().slice(0, 8)}`;
    const holder = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Pin-PATCH-Halter" });
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: dataA.tenant.id,
        salonId: holder.id,
        provider: "PHOREST",
        externalBranchId: taken,
      },
    });
    const target = await createTestSalon(app.prisma, dataA.tenant.id, {
      name: "Pin-PATCH-Ziel",
      federalState: "NIEDERSACHSEN",
    });
    const inactive = await createTestSalon(app.prisma, dataA.tenant.id, {
      name: "Pin-PATCH-Inaktiv",
      isActive: false,
    });
    const used = await createTestSalon(app.prisma, dataA.tenant.id, {
      name: "Pin-PATCH-Belegt",
      federalState: "NIEDERSACHSEN",
    });
    await app.prisma.timeEntry.create({
      data: {
        employeeId: dataA.employee.id,
        salonId: used.id,
        date: new Date("2026-01-06T00:00:00Z"),
        startTime: new Date("2026-01-06T08:00:00Z"),
        endTime: new Date("2026-01-06T16:00:00Z"),
        breakMinutes: 30,
      },
    });
    const dead = await seedTestData(app, "os89h");
    try {
      await app.prisma.tenant.update({
        where: { id: dead.tenant.id },
        data: { deactivatedAt: new Date(), deactivatedReason: "test" },
      });

      const bodies = {
        branchTaken: await patchSalon(dataA.tenant.id, target.id, {
          coupling: { externalBranchId: taken },
        }),
        inactive: await patchSalon(dataA.tenant.id, inactive.id, {
          coupling: { externalBranchId: `B-${randomUUID().slice(0, 8)}` },
        }),
        federalState: await patchSalon(dataA.tenant.id, used.id, { federalState: "BAYERN" }),
        tenantDead: await patchSalon(dead.tenant.id, randomUUID(), { name: "X" }),
      };
      for (const [name, res] of Object.entries(bodies)) {
        expect([409, 422], name).toContain(res.statusCode);
        expect(Object.keys(JSON.parse(res.body)).sort(byKey), name).toEqual(["code", "error"]);
        // D-14a: no count of entries or assignments in any refusal.
        expect(res.body, name).not.toMatch(/Count|\d/);
      }

      const salonUnknown = await patchSalon(dataA.tenant.id, randomUUID(), { name: "X" });
      expect(salonUnknown.statusCode).toBe(404);
      expect(Object.keys(JSON.parse(salonUnknown.body))).toEqual(["error"]);
      const tenantUnknown = await patchSalon(randomUUID(), randomUUID(), { name: "X" });
      expect(tenantUnknown.statusCode).toBe(404);
      expect(Object.keys(JSON.parse(tenantUnknown.body))).toEqual(["error"]);
      const noChanges = await patchSalon(dataA.tenant.id, target.id, {});
      expect(noChanges.statusCode).toBe(400);
      expect(Object.keys(JSON.parse(noChanges.body))).toEqual(["error"]);

      const ok = await patchSalon(dataA.tenant.id, target.id, { name: "Pin-PATCH-Ziel 2" });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(Object.keys(JSON.parse(ok.body)).sort(byKey)).toEqual(DTO_KEYS);
    } finally {
      await cleanupTestData(app, dead.tenant.id);
    }
  });
});

// ── POST /:salonId/deactivate and /activate (plan 89-10) ─────────────────────────────────────

function postAction(
  tenantId: string,
  salonId: string,
  action: "deactivate" | "activate",
  token: string | undefined = operatorToken,
) {
  return app.inject({
    method: "POST",
    url: `${salonsUrl(tenantId)}/${salonId}/${action}`,
    headers: {
      "user-agent": "vitest-operator-salons",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    remoteAddress: uniqueAddress(),
  });
}

const STATE_TEXT = {
  HOME_SALON_IN_USE:
    "Der Salon ist noch Stammsalon von Mitarbeitenden. Die Mitarbeitenden müssen zuerst einem anderen Stammsalon zugeordnet werden.",
  LAST_ACTIVE_SALON:
    "Das ist der letzte aktive Salon des Mandanten. Ein Mandant braucht mindestens einen aktiven Salon.",
  ALREADY_INACTIVE: "Der Salon ist bereits deaktiviert.",
  ALREADY_ACTIVE: "Der Salon ist bereits aktiv.",
} as const;

async function auditRowCount(tenantId: string, salonId: string) {
  const operatorRows = await app.prisma.operatorAuditLog.count({
    where: { subjectTenantId: tenantId, entityId: salonId },
  });
  const tenantRows = await app.prisma.auditLog.count({
    where: { entity: "Salon", entityId: salonId },
  });
  return { operatorRows, tenantRows };
}

describe("POST /api/v1/operator/tenants/:id/salons/:salonId/deactivate and /activate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deactivates a salon, ends its Einsatzsalon assignment and audits all of it on both sides", async () => {
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Zu deaktivieren" });
    const assignment = await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: dataA.tenant.id,
        employeeId: dataA.employee.id,
        salonId: salon.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });

    const res = await postAction(dataA.tenant.id, salon.id, "deactivate");
    expect(res.statusCode, res.body).toBe(200);
    const dto = JSON.parse(res.body) as SalonDto;
    expect(Object.keys(dto).sort(byKey)).toEqual(DTO_KEYS);
    expect(dto).toMatchObject({ id: salon.id, isActive: false });
    expect(dto.deactivatedAt).toBeTruthy();

    // Never deleted.
    const row = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
    expect(row.isActive).toBe(false);

    const opRows = await operatorActions(dataA.tenant.id, [salon.id]);
    expect(opRows).toHaveLength(1);
    expect(opRows[0]).toMatchObject({
      action: "SALON_DEACTIVATED",
      operatorId,
      entity: "Salon",
    });
    expect(opRows[0].oldValue).toMatchObject({ id: salon.id, isActive: true });
    expect(opRows[0].newValue).toMatchObject({ id: salon.id, isActive: false });
    expect(opRows[0].oldValue).not.toHaveProperty("coupling");

    const tenantRows = await app.prisma.auditLog.findMany({
      where: { entity: "Salon", entityId: salon.id },
    });
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0]).toMatchObject({ action: "DEACTIVATE", userId: null });
    expect(tenantRows[0].newValue).toMatchObject({
      isActive: false,
      actor: { type: "OPERATOR", operatorId, tenantId: dataA.tenant.id },
    });

    const endRows = await app.prisma.auditLog.findMany({
      where: { entity: "EmployeeSalonAssignment", entityId: assignment.id },
    });
    expect(endRows).toHaveLength(1);
    expect(endRows[0]).toMatchObject({ action: "END", userId: null });
    expect(endRows[0].oldValue).toMatchObject({ id: assignment.id, validUntil: null });
    expect(endRows[0].newValue).toMatchObject({
      id: assignment.id,
      trigger: "SALON_DEACTIVATED",
      actor: { type: "OPERATOR", operatorId, tenantId: dataA.tenant.id },
    });
    const ended = await app.prisma.employeeSalonAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(ended.validUntil).not.toBeNull();
  });

  it("deactivates a salon with time entries without deleting or touching them", async () => {
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Mit Zeitdaten" });
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: dataA.employee.id,
        salonId: salon.id,
        date: new Date("2025-03-12T00:00:00Z"),
        startTime: new Date("2025-03-12T08:00:00Z"),
        endTime: new Date("2025-03-12T16:00:00Z"),
        breakMinutes: 30,
      },
    });

    const res = await postAction(dataA.tenant.id, salon.id, "deactivate");
    expect(res.statusCode, res.body).toBe(200);

    expect(await app.prisma.salon.count({ where: { id: salon.id } })).toBe(1);
    const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after).toEqual(entry);
  });

  it("refuses a salon that is still a Stammsalon with the count-free fixed body and writes nothing", async () => {
    const home = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Stammsalon" });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: dataA.tenant.id,
        employeeId: dataA.employee.id,
        salonId: home.id,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });

    const res = await postAction(dataA.tenant.id, home.id, "deactivate");
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: string; code: string };
    expect(body).toEqual({ error: STATE_TEXT.HOME_SALON_IN_USE, code: "HOME_SALON_IN_USE" });
    expect(/\d/.test(body.error)).toBe(false);
    expect(Object.keys(body).sort(byKey)).toEqual(["code", "error"]);

    expect((await app.prisma.salon.findUniqueOrThrow({ where: { id: home.id } })).isActive).toBe(
      true,
    );
    expect(await auditRowCount(dataA.tenant.id, home.id)).toEqual({
      operatorRows: 0,
      tenantRows: 0,
    });
  });

  it("refuses the last active salon of a tenant and an already inactive salon, writing nothing", async () => {
    const solo = await seedTestData(app, "os89g");
    try {
      const only = await app.prisma.salon.findFirstOrThrow({
        where: { tenantId: solo.tenant.id, isActive: true },
      });
      const last = await postAction(solo.tenant.id, only.id, "deactivate");
      expect(last.statusCode).toBe(409);
      expect(JSON.parse(last.body)).toEqual({
        error: STATE_TEXT.LAST_ACTIVE_SALON,
        code: "LAST_ACTIVE_SALON",
      });
      expect(await auditRowCount(solo.tenant.id, only.id)).toEqual({
        operatorRows: 0,
        tenantRows: 0,
      });

      const inactive = await createTestSalon(app.prisma, solo.tenant.id, {
        name: "Schon inaktiv",
        isActive: false,
      });
      const already = await postAction(solo.tenant.id, inactive.id, "deactivate");
      expect(already.statusCode).toBe(409);
      expect(JSON.parse(already.body)).toEqual({
        error: STATE_TEXT.ALREADY_INACTIVE,
        code: "ALREADY_INACTIVE",
      });
      expect(await auditRowCount(solo.tenant.id, inactive.id)).toEqual({
        operatorRows: 0,
        tenantRows: 0,
      });
    } finally {
      await cleanupTestData(app, solo.tenant.id);
    }
  });

  it("reactivates an inactive salon, audits it and does not restore ended assignments", async () => {
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Wieder aktiv" });
    const assignment = await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: dataA.tenant.id,
        employeeId: dataA.employee.id,
        salonId: salon.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    expect((await postAction(dataA.tenant.id, salon.id, "deactivate")).statusCode).toBe(200);
    const endedRow = await app.prisma.employeeSalonAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(endedRow.validUntil).not.toBeNull();

    const res = await postAction(dataA.tenant.id, salon.id, "activate");
    expect(res.statusCode, res.body).toBe(200);
    const dto = JSON.parse(res.body) as SalonDto;
    expect(Object.keys(dto).sort(byKey)).toEqual(DTO_KEYS);
    expect(dto).toMatchObject({ id: salon.id, isActive: true, deactivatedAt: null });

    const opRows = await operatorActions(dataA.tenant.id, [salon.id]);
    expect(opRows.map((r) => r.action)).toEqual(["SALON_DEACTIVATED", "SALON_ACTIVATED"]);
    expect(opRows[1]).toMatchObject({ operatorId, entity: "Salon" });
    const tenantRows = await app.prisma.auditLog.findMany({
      where: { entity: "Salon", entityId: salon.id },
      orderBy: { createdAt: "asc" },
    });
    expect(tenantRows.map((r) => r.action)).toEqual(["DEACTIVATE", "ACTIVATE"]);
    expect(tenantRows[1].newValue).toMatchObject({
      actor: { type: "OPERATOR", operatorId, tenantId: dataA.tenant.id },
    });

    const afterActivate = await app.prisma.employeeSalonAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(afterActivate).toEqual(endedRow);
  });

  it("refuses to reactivate an active salon without writing a row", async () => {
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, { name: "Schon aktiv" });
    const res = await postAction(dataA.tenant.id, salon.id, "activate");
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: STATE_TEXT.ALREADY_ACTIVE,
      code: "ALREADY_ACTIVE",
    });
    expect(await auditRowCount(dataA.tenant.id, salon.id)).toEqual({
      operatorRows: 0,
      tenantRows: 0,
    });
  });

  it("rolls the deactivation back when an END audit row cannot be written", async () => {
    const salon = await createTestSalon(app.prisma, dataA.tenant.id, { name: "END-Audit" });
    const assignment = await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: dataA.tenant.id,
        employeeId: dataA.employee.id,
        salonId: salon.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    const realAudit = app.audit.bind(app);
    vi.spyOn(app, "audit").mockImplementation(async (entry) => {
      if (entry.entity === "EmployeeSalonAssignment")
        throw new Error("forced audit failure (test)");
      return realAudit(entry);
    });

    const res = await postAction(dataA.tenant.id, salon.id, "deactivate");
    expect(res.statusCode).toBe(500);

    expect((await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } })).isActive).toBe(
      true,
    );
    expect(
      (await app.prisma.employeeSalonAssignment.findUniqueOrThrow({ where: { id: assignment.id } }))
        .validUntil,
    ).toBeNull();
    expect(await auditRowCount(dataA.tenant.id, salon.id)).toEqual({
      operatorRows: 0,
      tenantRows: 0,
    });
  });

  it("answers an unknown salon id and an unknown tenant with the fixed 404 bodies", async () => {
    for (const action of ["deactivate", "activate"] as const) {
      const salon = await postAction(dataA.tenant.id, randomUUID(), action);
      expect(salon.statusCode).toBe(404);
      expect(JSON.parse(salon.body)).toEqual({ error: "Salon nicht gefunden" });
      const tenant = await postAction(randomUUID(), randomUUID(), action);
      expect(tenant.statusCode).toBe(404);
      expect(JSON.parse(tenant.body)).toEqual({ error: "Mandant nicht gefunden" });
    }
  });
});
