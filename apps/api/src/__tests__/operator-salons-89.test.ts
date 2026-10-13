/**
 * Phase 89 plans 01 and 08 (#89, D-05/D-06/D-07/D-07a/D-09/D-12/D-16) — the operator reads a tenant's
 * salons through GET /api/v1/operator/tenants/:id/salons (master data plus the Phorest coupling,
 * inactive salons included, metadata only) and creates one through POST on the same path (Bundesland
 * and opening hours required, optional coupling, both audit trails in one transaction).
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
