/**
 * Phase 566 (#566), plan 05 — the first add-on gates: setting up a NEW NFC terminal, a NEW WLAN
 * presence source or a NEW API key needs the booked module (D-05); everything that maintains or
 * uses an existing setup stays free (D-05, D-06).
 *
 * Tenants come from `seedGrundversionTenant` (no module booked); the shared `seedTestData` fixture
 * books everything and would make every gate case vacuous.
 *
 * Amended 2026-10-16 for #92 (Phase 92b-04, D-07): the exact `activityMinutes` pin of the analytics
 * summary case names the new key TRAVEL (0). Case count unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { TenantModule } from "@clokr/db";
import {
  getTestApp,
  seedGrundversionTenant,
  seedOperator,
  cleanupTestData,
  createTestSalon,
} from "./setup";
import { signOperatorToken } from "../contexts/platform/operator-auth";
import { moduleNotBookedMessage } from "../contexts/platform/tenant-packages";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

type Seed = Awaited<ReturnType<typeof seedGrundversionTenant>>;

let app: FastifyInstance;
let addressCounter = 0;

/** A distinct client address per request, so the per-IP rate limits never couple test cases. */
function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.91.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function setModules(tenantId: string, bookedModules: TenantModule[]) {
  await app.prisma.tenant.update({ where: { id: tenantId }, data: { bookedModules } });
}

/** Asserts the exact refusal shape: status 409, body keys exactly `code` and `error`. */
function expectModuleRefusal(res: { statusCode: number; body: string }, module: TenantModule) {
  expect(res.statusCode).toBe(409);
  const body = JSON.parse(res.body) as Record<string, unknown>;
  expect(Object.keys(body).sort((a, b) => a.localeCompare(b))).toEqual(["code", "error"]);
  expect(body.code).toBe("MODULE_NOT_BOOKED");
  expect(body.error).toBe(moduleNotBookedMessage(module));
}

beforeAll(async () => {
  app = await getTestApp();
});

async function cleanup(tenantId: string) {
  try {
    await app.prisma.break.deleteMany({ where: { timeEntry: { employee: { tenantId } } } });
    await app.prisma.timeEntry.deleteMany({ where: { employee: { tenantId } } });
    await app.prisma.presenceDevice.deleteMany({ where: { tenantId } });
    await app.prisma.presenceSource.deleteMany({ where: { tenantId } });
    await app.prisma.apiKey.deleteMany({ where: { tenantId } });
    await app.prisma.roleAssignment.deleteMany({ where: { tenantId } });
    await app.prisma.accessRole.deleteMany({ where: { tenantId } });
    await app.prisma.terminalApiKey.deleteMany({ where: { tenantId } });
    await cleanupTestData(app, tenantId);
  } catch (err) {
    console.error("Test cleanup failed:", err);
  }
}

describe("POST /api/v1/terminals needs Hardware-Stempeln (D-05)", () => {
  let t: Seed;

  beforeAll(async () => {
    t = await seedGrundversionTenant(app, "a566-term");
  });
  afterAll(async () => cleanup(t.tenant.id));

  it("(a) refuses on the Grundversion with exactly { error, code } naming the module and creates nothing", async () => {
    await setModules(t.tenant.id, []);
    const auditBefore = await app.prisma.auditLog.count({ where: { entity: "TerminalApiKey" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/terminals",
      headers: bearer(t.adminToken),
      payload: { name: "Ladenterminal" },
    });

    expectModuleRefusal(res, TenantModule.HARDWARE_CLOCK);
    expect(JSON.parse(res.body).error).toContain("Hardware-Stempeln");
    expect(await app.prisma.terminalApiKey.count({ where: { tenantId: t.tenant.id } })).toBe(0);
    expect(await app.prisma.auditLog.count({ where: { entity: "TerminalApiKey" } })).toBe(
      auditBefore,
    );
  });

  it("(b) works exactly as before once the module is booked", async () => {
    await setModules(t.tenant.id, [TenantModule.HARDWARE_CLOCK]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/terminals",
      headers: bearer(t.adminToken),
      payload: { name: "Ladenterminal" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.rawKey).toMatch(/^clk_/);
    expect(body.name).toBe("Ladenterminal");
    expect(body.keyPrefix).toMatch(/^clk_/);
    expect(await app.prisma.terminalApiKey.count({ where: { tenantId: t.tenant.id } })).toBe(1);
  });

  it("(b2) another module does not unlock it", async () => {
    await setModules(t.tenant.id, [TenantModule.INTEGRATIONS, TenantModule.CHAIN]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/terminals",
      headers: bearer(t.adminToken),
      payload: { name: "Zweites Terminal" },
    });

    expectModuleRefusal(res, TenantModule.HARDWARE_CLOCK);
  });

  it("(c) an invalid body on a Grundversion tenant is still 400 (validation first)", async () => {
    await setModules(t.tenant.id, []);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/terminals",
      headers: bearer(t.adminToken),
      payload: { name: "" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("(d) a caller without terminal:manage still gets the existing 403 (permission first)", async () => {
    await setModules(t.tenant.id, []);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/terminals",
      headers: bearer(t.empToken),
      payload: { name: "Ladenterminal" },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/v1/admin/presence-sources needs Hardware-Stempeln (D-05)", () => {
  let t: Seed;
  const BASE = "/api/v1/admin/presence-sources";

  beforeAll(async () => {
    t = await seedGrundversionTenant(app, "a566-src");
  });
  afterAll(async () => cleanup(t.tenant.id));

  it("refuses on the Grundversion, naming the module, with no source row and no audit row", async () => {
    await setModules(t.tenant.id, []);
    const auditBefore = await app.prisma.auditLog.count({
      where: { entity: "PresenceSource", action: "CREATE" },
    });

    const res = await app.inject({
      method: "POST",
      url: BASE,
      headers: bearer(t.adminToken),
      payload: { name: "Büro FritzBox" },
    });

    expectModuleRefusal(res, TenantModule.HARDWARE_CLOCK);
    expect(JSON.parse(res.body).error).toContain("Hardware-Stempeln");
    expect(await app.prisma.presenceSource.count({ where: { tenantId: t.tenant.id } })).toBe(0);
    expect(
      await app.prisma.auditLog.count({ where: { entity: "PresenceSource", action: "CREATE" } }),
    ).toBe(auditBefore);
  });

  it("creates the source once the module is booked", async () => {
    await setModules(t.tenant.id, [TenantModule.HARDWARE_CLOCK]);

    const res = await app.inject({
      method: "POST",
      url: BASE,
      headers: bearer(t.adminToken),
      payload: { name: "Büro FritzBox" },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).rawKey).toMatch(/^clk_/);
    expect(await app.prisma.presenceSource.count({ where: { tenantId: t.tenant.id } })).toBe(1);
  });

  it("an invalid body is still 400 and a caller without the permission still 403", async () => {
    await setModules(t.tenant.id, []);

    const invalid = await app.inject({
      method: "POST",
      url: BASE,
      headers: bearer(t.adminToken),
      payload: { name: "" },
    });
    expect(invalid.statusCode).toBe(400);

    const forbidden = await app.inject({
      method: "POST",
      url: BASE,
      headers: bearer(t.empToken),
      payload: { name: "Büro FritzBox" },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});

describe("POST /api/v1/api-keys needs Integrationen (D-05)", () => {
  let t: Seed;

  beforeAll(async () => {
    t = await seedGrundversionTenant(app, "a566-key");
  });
  afterAll(async () => cleanup(t.tenant.id));

  it("refuses on the Grundversion, naming the module, with no key row", async () => {
    await setModules(t.tenant.id, []);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: bearer(t.adminToken),
      payload: { name: "Lohnexport", scopes: ["read:employees"] },
    });

    expectModuleRefusal(res, TenantModule.INTEGRATIONS);
    expect(JSON.parse(res.body).error).toContain("Integrationen");
    expect(await app.prisma.apiKey.count({ where: { tenantId: t.tenant.id } })).toBe(0);
  });

  it("creates the key once the module is booked", async () => {
    await setModules(t.tenant.id, [TenantModule.INTEGRATIONS]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: bearer(t.adminToken),
      payload: { name: "Lohnexport", scopes: ["read:employees"] },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.rawKey).toMatch(/^clk_/);
    expect(body.name).toBe("Lohnexport");
    expect(await app.prisma.apiKey.count({ where: { tenantId: t.tenant.id } })).toBe(1);
  });

  it("an invalid body is still 400 (validation first)", async () => {
    await setModules(t.tenant.id, []);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: bearer(t.adminToken),
      payload: { name: "Lohnexport", scopes: [] },
    });

    expect(res.statusCode).toBe(400);
  });

  it("scope admin without role-assignment rights is still the existing 403, not the 409", async () => {
    await setModules(t.tenant.id, []);
    // The employee gets api-key:manage through a stored assignment, but not role-assignment:manage.
    const roleName = `Schluessel ${randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: t.tenant.id,
        name: roleName,
        nameKey: roleNameKey(roleName),
        permissions: normalizeRolePermissions(["api-key:manage:ZUGEWIESEN"]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: t.tenant.id,
        userId: t.empUser.id,
        accessRoleId: role.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });

    const keysBefore = await app.prisma.apiKey.count({ where: { tenantId: t.tenant.id } });
    const adminScope = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: bearer(t.empToken),
      payload: { name: "Wurzel", scopes: ["admin"] },
    });
    expect(adminScope.statusCode).toBe(403);
    expect(JSON.parse(adminScope.body)).toEqual({ error: "Forbidden" });

    // Control: the same caller without the admin scope reaches the gate and gets the 409.
    const plainScope = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: bearer(t.empToken),
      payload: { name: "Lesen", scopes: ["read:employees"] },
    });
    expectModuleRefusal(plainScope, TenantModule.INTEGRATIONS);
    expect(await app.prisma.apiKey.count({ where: { tenantId: t.tenant.id } })).toBe(keysBefore);
  });
});

describe("everything that maintains or uses an existing setup stays free without the module (D-05, D-06)", () => {
  let t: Seed;
  const NFC_CARD_ID = `NFC-566-${randomBytes(6).toString("hex")}`;
  const MAC = "AA:BB:CC:DD:EE:5A";
  let terminalId: string;
  let terminalKey: string;
  let apiKeyId: string;
  let apiKeyRaw: string;
  let sourceId: string;
  let sourceKey: string;

  beforeAll(async () => {
    t = await seedGrundversionTenant(app, "a566-free");
    await app.prisma.employee.update({
      where: { id: t.employee.id },
      data: { nfcCardId: NFC_CARD_ID },
    });

    // The setups are created while the modules ARE booked, then the modules are taken away.
    await setModules(t.tenant.id, [TenantModule.HARDWARE_CLOCK, TenantModule.INTEGRATIONS]);
    const term = await app.inject({
      method: "POST",
      url: "/api/v1/terminals",
      headers: bearer(t.adminToken),
      payload: { name: "Bestandsterminal" },
    });
    expect(term.statusCode).toBe(200);
    terminalId = JSON.parse(term.body).id;
    terminalKey = JSON.parse(term.body).rawKey;

    const key = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: bearer(t.adminToken),
      payload: { name: "Bestandsschluessel", scopes: ["read:employees"] },
    });
    expect(key.statusCode).toBe(200);
    apiKeyId = JSON.parse(key.body).id;
    apiKeyRaw = JSON.parse(key.body).rawKey;

    const src = await app.inject({
      method: "POST",
      url: "/api/v1/admin/presence-sources",
      headers: bearer(t.adminToken),
      payload: { name: "Bestandsquelle" },
    });
    expect(src.statusCode).toBe(201);
    sourceId = JSON.parse(src.body).id;
    sourceKey = JSON.parse(src.body).rawKey;

    await setModules(t.tenant.id, []);
  });
  afterAll(async () => cleanup(t.tenant.id));

  it("the Grundversion is really in force for the cases below", async () => {
    const row = await app.prisma.tenant.findUniqueOrThrow({ where: { id: t.tenant.id } });
    expect(row.bookedModules).toEqual([]);
    const refused = await app.inject({
      method: "POST",
      url: "/api/v1/terminals",
      headers: bearer(t.adminToken),
      payload: { name: "Neues Terminal" },
    });
    expect(refused.statusCode).toBe(409);
  });

  it("an existing terminal key still punches (clock in)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/nfc-punch",
      headers: bearer(terminalKey),
      payload: { nfcCardId: NFC_CARD_ID },
      remoteAddress: uniqueAddress(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.action).toBe("IN");
    expect(body.employee.firstName).toBe("Max");
  });

  it("an existing terminal key still reads the allowed cards", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/terminals/allowed-cards",
      headers: bearer(terminalKey),
      remoteAddress: uniqueAddress(),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).cards).toContain(NFC_CARD_ID);
  });

  it("an existing API key still authenticates a read it is scoped for", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/employees",
      headers: bearer(apiKeyRaw),
      remoteAddress: uniqueAddress(),
    });

    expect(res.statusCode).toBe(200);
  });

  it("an existing presence source can be renamed", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/presence-sources/${sourceId}`,
      headers: bearer(t.adminToken),
      payload: { name: "Umbenannte Quelle" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe("Umbenannte Quelle");
  });

  it("a device of an existing source can be assigned and unassigned", async () => {
    const assign = await app.inject({
      method: "POST",
      url: `/api/v1/admin/presence-sources/${sourceId}/devices/${MAC}/assign`,
      headers: bearer(t.adminToken),
      payload: { employeeId: t.employee.id },
    });
    expect(assign.statusCode).toBe(200);
    expect(JSON.parse(assign.body).employeeId).toBe(t.employee.id);
    expect(JSON.parse(assign.body).mac).toBe(MAC.toLowerCase());

    const unassign = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/presence-sources/${sourceId}/devices/${MAC}`,
      headers: bearer(t.adminToken),
    });
    expect(unassign.statusCode).toBe(200);
    expect(JSON.parse(unassign.body).success).toBe(true);
  });

  it("the ingest of an existing source still accepts events", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: bearer(sourceKey),
      payload: {
        mac: "00:11:22:33:44:55",
        eventType: "connected",
        timestamp: "2026-01-15T08:05:00.000Z",
        adapter: "fritzbox",
      },
      remoteAddress: uniqueAddress(),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("an employee still registers an own device", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/employees/me/wifi/devices",
      headers: bearer(t.empToken),
      payload: { mac: "AA:BB:CC:DD:EE:5B", label: "Eigenes Geraet" },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).mac).toBe("aa:bb:cc:dd:ee:5b");
  });

  it("an existing presence source can be revoked (soft-deleted)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/presence-sources/${sourceId}`,
      headers: bearer(t.adminToken),
    });

    expect(res.statusCode).toBe(200);
    const row = await app.prisma.presenceSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(row.deletedAt).not.toBeNull();
  });

  it("an existing API key can be revoked", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/api-keys/${apiKeyId}`,
      headers: bearer(t.adminToken),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it("an existing terminal key can be revoked", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/terminals/${terminalId}`,
      headers: bearer(t.adminToken),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });
});

describe("integrations — couplings (D-05)", () => {
  let t: Seed;
  const COUPLINGS = "/api/v1/integrations/phorest/couplings";
  const BRANCH = `branch-566-${randomBytes(4).toString("hex")}`;
  let salonId: string;

  beforeAll(async () => {
    t = await seedGrundversionTenant(app, "a566-coup");
    const salon = await createTestSalon(app.prisma, t.tenant.id, { name: "Kopplungssalon" });
    salonId = salon.id;
  });
  afterAll(async () => cleanup(t.tenant.id));

  it("(a) a new coupling is refused on the Grundversion with MODULE_NOT_BOOKED and nothing is persisted", async () => {
    await setModules(t.tenant.id, []);
    const auditBefore = await app.prisma.auditLog.count({
      where: { entity: "SalonCoupling", action: "CREATE" },
    });

    const res = await app.inject({
      method: "POST",
      url: COUPLINGS,
      headers: bearer(t.adminToken),
      payload: { salonId, externalBranchId: BRANCH },
    });

    expectModuleRefusal(res, TenantModule.INTEGRATIONS);
    expect(JSON.parse(res.body).error).toContain("Integrationen");
    expect(await app.prisma.salonCoupling.count({ where: { tenantId: t.tenant.id } })).toBe(0);
    expect(
      await app.prisma.auditLog.count({ where: { entity: "SalonCoupling", action: "CREATE" } }),
    ).toBe(auditBefore);
  });

  it("(b) the same request works exactly as before once the module is booked", async () => {
    await setModules(t.tenant.id, [TenantModule.INTEGRATIONS]);

    const res = await app.inject({
      method: "POST",
      url: COUPLINGS,
      headers: bearer(t.adminToken),
      payload: { salonId, externalBranchId: BRANCH },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.coupling.salonId).toBe(salonId);
    expect(body.coupling.provider).toBe("PHOREST");
    expect(body.coupling.externalBranchId).toBe(BRANCH);
    expect(await app.prisma.salonCoupling.count({ where: { tenantId: t.tenant.id } })).toBe(1);
  });

  it("(c) an unknown salon id on the Grundversion keeps the existing 404 (salon resolution precedes the gate)", async () => {
    await setModules(t.tenant.id, []);

    const res = await app.inject({
      method: "POST",
      url: COUPLINGS,
      headers: bearer(t.adminToken),
      payload: { salonId: randomUUID(), externalBranchId: `${BRANCH}-other` },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Salon nicht gefunden" });
  });
});

describe("integrations — no bypass (D-05, D-06)", () => {
  let t: Seed;
  let operatorToken: string;
  const OPERATOR_SALONS = () => `/api/v1/operator/tenants/${t.tenant.id}/salons`;
  const CONFIG = "/api/v1/integrations/phorest/config";
  const OPENING_HOURS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day,
    open: "09:00",
    close: "18:00",
    ...(day === 6 ? { closed: true } : {}),
  }));

  function newBranch() {
    return `B-${randomUUID().slice(0, 8)}`;
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

  function operatorCall(method: "POST" | "PATCH", url: string, payload: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${operatorToken}`, "user-agent": "vitest-566" },
      payload: payload as object,
      remoteAddress: uniqueAddress(),
    });
  }

  /** Operator audit rows of this tenant, optionally narrowed to some actions. */
  function operatorRowCount() {
    return app.prisma.operatorAuditLog.count({ where: { subjectTenantId: t.tenant.id } });
  }

  /** Tenant audit rows the operator stamped for this tenant (Salon and SalonCoupling entities). */
  function stampedTenantRowCount() {
    return app.prisma.auditLog.count({
      where: {
        entity: { in: ["Salon", "SalonCoupling"] },
        newValue: { path: ["actor", "tenantId"], equals: t.tenant.id },
      },
    });
  }

  async function bookIntegrations(on: boolean) {
    await setModules(
      t.tenant.id,
      on ? [TenantModule.CHAIN, TenantModule.INTEGRATIONS] : [TenantModule.CHAIN],
    );
  }

  beforeAll(async () => {
    t = await seedGrundversionTenant(app, "a566-nobyp");
    await app.prisma.tenant.update({
      where: { id: t.tenant.id },
      data: { bookedModules: [TenantModule.CHAIN], salonQuota: 5 },
    });
    const operator = await seedOperator(app);
    operatorToken = signOperatorToken(app, operator.id, "access", operator.tokenVersion);
  });
  afterAll(async () => cleanup(t.tenant.id));

  it("operator salon create with a coupling is refused without Integrationen and persists nothing", async () => {
    await bookIntegrations(false);
    const name = `Ohne Modul ${randomUUID().slice(0, 8)}`;
    const salonsBefore = await app.prisma.salon.count({ where: { tenantId: t.tenant.id } });
    const opBefore = await operatorRowCount();
    const tenantRowsBefore = await stampedTenantRowCount();

    const res = await operatorCall(
      "POST",
      OPERATOR_SALONS(),
      salonBody({ name, coupling: { externalBranchId: newBranch() } }),
    );

    expectModuleRefusal(res, TenantModule.INTEGRATIONS);
    expect(await app.prisma.salon.count({ where: { tenantId: t.tenant.id } })).toBe(salonsBefore);
    expect(await app.prisma.salon.count({ where: { tenantId: t.tenant.id, name } })).toBe(0);
    expect(await app.prisma.salonCoupling.count({ where: { tenantId: t.tenant.id } })).toBe(0);
    expect(await operatorRowCount()).toBe(opBefore);
    expect(await stampedTenantRowCount()).toBe(tenantRowsBefore);
  });

  it("operator salon create WITHOUT a coupling stays free of the Integrationen module", async () => {
    await bookIntegrations(false);

    const res = await operatorCall("POST", OPERATOR_SALONS(), salonBody());

    expect(res.statusCode, res.body).toBe(201);
  });

  it("operator edit that couples an uncoupled salon is refused and the whole request is rolled back", async () => {
    await bookIntegrations(false);
    const salon = await createTestSalon(app.prisma, t.tenant.id, { name: "Unveraendert" });
    const opBefore = await operatorRowCount();
    const tenantRowsBefore = await stampedTenantRowCount();

    const res = await operatorCall("PATCH", `${OPERATOR_SALONS()}/${salon.id}`, {
      name: "Neuer Name",
      coupling: { externalBranchId: newBranch() },
    });

    expectModuleRefusal(res, TenantModule.INTEGRATIONS);
    const stored = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
    expect(stored.name).toBe("Unveraendert");
    expect(await app.prisma.salonCoupling.count({ where: { salonId: salon.id } })).toBe(0);
    expect(await operatorRowCount()).toBe(opBefore);
    expect(await stampedTenantRowCount()).toBe(tenantRowsBefore);
  });

  it("maintaining an existing coupling stays free: replace, unchanged, operator removal and tenant removal", async () => {
    const salon = await createTestSalon(app.prisma, t.tenant.id, { name: "Bestand" });
    const c1 = newBranch();
    const c2 = newBranch();

    // The coupling is created while the module is booked, then the module is cancelled.
    await bookIntegrations(true);
    const set = await operatorCall("PATCH", `${OPERATOR_SALONS()}/${salon.id}`, {
      coupling: { externalBranchId: c1 },
    });
    expect(set.statusCode, set.body).toBe(200);
    await bookIntegrations(false);

    // Different branch: REPLACED.
    const replaced = await operatorCall("PATCH", `${OPERATOR_SALONS()}/${salon.id}`, {
      coupling: { externalBranchId: c2 },
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const rows = await app.prisma.salonCoupling.findMany({ where: { salonId: salon.id } });
    expect(rows.map((r) => r.externalBranchId)).toEqual([c2]);

    // Same branch: success, no write.
    const opBefore = await operatorRowCount();
    const same = await operatorCall("PATCH", `${OPERATOR_SALONS()}/${salon.id}`, {
      coupling: { externalBranchId: c2 },
    });
    expect(same.statusCode, same.body).toBe(200);
    expect(await operatorRowCount()).toBe(opBefore);

    // Operator removal.
    const removed = await operatorCall("PATCH", `${OPERATOR_SALONS()}/${salon.id}`, {
      coupling: null,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await app.prisma.salonCoupling.count({ where: { salonId: salon.id } })).toBe(0);

    // Tenant removal of a coupling that exists while the module is not booked.
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: t.tenant.id,
        salonId: salon.id,
        provider: "PHOREST",
        externalBranchId: newBranch(),
      },
    });
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/integrations/phorest/couplings/${salon.id}`,
      headers: bearer(t.adminToken),
    });
    expect(del.statusCode, del.body).toBe(200);
    expect(await app.prisma.salonCoupling.count({ where: { salonId: salon.id } })).toBe(0);
  });

  describe("PUT /api/v1/integrations/phorest/config", () => {
    let c: Seed;

    beforeAll(async () => {
      c = await seedGrundversionTenant(app, "a566-cfg");
    });
    afterAll(async () => cleanup(c.tenant.id));

    function putConfig(payload: Record<string, unknown>) {
      return app.inject({
        method: "PUT",
        url: CONFIG,
        headers: bearer(c.adminToken),
        payload,
      });
    }

    function phorestFields() {
      return app.prisma.tenantConfig.findUniqueOrThrow({
        where: { tenantId: c.tenant.id },
        select: {
          phorestBusinessId: true,
          phorestUsername: true,
          phorestPassword: true,
          phorestAutoSync: true,
        },
      });
    }

    it("a branch that would create the sole salon's coupling is refused and the credentials roll back", async () => {
      await setModules(c.tenant.id, []);
      expect(
        await app.prisma.salon.count({ where: { tenantId: c.tenant.id, isActive: true } }),
      ).toBe(1);
      expect(await app.prisma.salonCoupling.count({ where: { tenantId: c.tenant.id } })).toBe(0);
      const before = await phorestFields();

      const res = await putConfig({
        phorestBusinessId: "biz-566-refused",
        phorestUsername: "refused@example.invalid",
        phorestPassword: "refused-secret",
        phorestAutoSync: true,
        branchId: newBranch(),
      });

      expectModuleRefusal(res, TenantModule.INTEGRATIONS);
      expect(await phorestFields()).toEqual(before);
      expect(await app.prisma.salonCoupling.count({ where: { tenantId: c.tenant.id } })).toBe(0);
    });

    it("saving the credentials without a branch stays free", async () => {
      await setModules(c.tenant.id, []);

      const res = await putConfig({
        phorestBusinessId: "biz-566-free",
        phorestUsername: "free@example.invalid",
      });

      expect(res.statusCode, res.body).toBe(200);
      const after = await phorestFields();
      expect(after.phorestBusinessId).toBe("biz-566-free");
      expect(after.phorestUsername).toBe("free@example.invalid");
      expect(await app.prisma.salonCoupling.count({ where: { tenantId: c.tenant.id } })).toBe(0);
    });

    it("updating the branch of the sole salon's existing coupling stays free", async () => {
      await setModules(c.tenant.id, [TenantModule.INTEGRATIONS]);
      const first = newBranch();
      const created = await putConfig({
        phorestBusinessId: "biz-566-edit",
        phorestUsername: "edit@example.invalid",
        branchId: first,
      });
      expect(created.statusCode, created.body).toBe(200);
      await setModules(c.tenant.id, []);

      const second = newBranch();
      const res = await putConfig({
        phorestBusinessId: "biz-566-edit",
        phorestUsername: "edit@example.invalid",
        branchId: second,
      });

      expect(res.statusCode, res.body).toBe(200);
      const rows = await app.prisma.salonCoupling.findMany({ where: { tenantId: c.tenant.id } });
      expect(rows.map((r) => r.externalBranchId)).toEqual([second]);
    });
  });
});

describe("analytics — summary (D-05): only activityMinutes is package-bound", () => {
  let t: Seed;

  function summary(salonId?: string) {
    const qs = new URLSearchParams({
      employeeId: t.employee.id,
      from: "2026-09-07",
      to: "2026-09-13",
      ...(salonId ? { salonId } : {}),
    });
    return app.inject({
      method: "GET",
      url: `/api/v1/time-entries/summary?${qs.toString()}`,
      headers: bearer(t.adminToken),
    });
  }

  function entry(
    date: string,
    kind: "UNSPECIFIED" | "PRODUCTIVE",
    shares?: { kind: "SETUP_CLEANING"; minutes: number }[],
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId: t.employee.id,
        salonId: t.salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T08:00:00Z`),
        endTime: new Date(`${date}T16:30:00Z`),
        breakMinutes: 30,
        type: "WORK",
        source: "MANUAL",
        activityKind: kind,
        ...(shares ? { activityShares: { create: shares } } : {}),
      },
    });
  }

  beforeAll(async () => {
    t = await seedGrundversionTenant(app, "a566-analytics");
    await entry("2026-09-08", "UNSPECIFIED");
    await entry("2026-09-09", "PRODUCTIVE", [{ kind: "SETUP_CLEANING", minutes: 60 }]);
  });
  afterAll(async () => {
    await app.prisma.timeEntryActivityShare.deleteMany({
      where: { timeEntry: { employee: { tenantId: t.tenant.id } } },
    });
    await cleanup(t.tenant.id);
  });

  it("(a) booked: activityMinutes per kind, and no reason key at all", async () => {
    await setModules(t.tenant.id, [TenantModule.ANALYTICS]);
    const res = await summary();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.activityMinutes).toEqual({
      PRODUCTIVE: 420,
      SETUP_CLEANING: 60,
      TRAVEL: 0,
      UNSPECIFIED: 480,
    });
    expect(Object.keys(body)).not.toContain("activityMinutesUnavailableReason");
  });

  it("(b) unbooked: activityMinutes null with MODULE_NOT_BOOKED, every other figure identical", async () => {
    await setModules(t.tenant.id, [TenantModule.ANALYTICS]);
    const booked = JSON.parse((await summary()).body) as Record<string, unknown>;
    await setModules(t.tenant.id, []);
    const res = await summary();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.activityMinutes).toBeNull();
    expect(body.activityMinutesUnavailableReason).toBe("MODULE_NOT_BOOKED");
    const { activityMinutes: _a, activityMinutesUnavailableReason: _r, ...rest } = body;
    const { activityMinutes: _b, ...bookedRest } = booked;
    expect(rest).toEqual(bookedRest);
    expect(rest.workingMinutes).toBe(960);
    expect(rest.entryCount).toBe(2);
  });

  it("(c) unbooked with salonId narrowing: same rule", async () => {
    await setModules(t.tenant.id, []);
    const res = await summary(t.salonId);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.activityMinutes).toBeNull();
    expect(body.activityMinutesUnavailableReason).toBe("MODULE_NOT_BOOKED");
    expect(body.workingMinutes).toBe(960);
  });

  it("(d) unbooked: recording an activity kind and a share stays free", async () => {
    await setModules(t.tenant.id, []);
    const e = await entry("2026-09-10", "UNSPECIFIED");
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${e.id}`,
      headers: bearer(t.adminToken),
      payload: {
        activityKind: "PRODUCTIVE",
        activityShares: [{ kind: "SETUP_CLEANING", minutes: 30 }],
      },
    });
    expect(res.statusCode).toBe(200);
    const row = await app.prisma.timeEntry.findUniqueOrThrow({
      where: { id: e.id },
      include: { activityShares: { select: { kind: true, minutes: true } } },
    });
    expect(row.activityKind).toBe("PRODUCTIVE");
    expect(row.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 30 }]);
  });
});
