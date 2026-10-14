/**
 * Phase 566 (#566), plan 05 — the first add-on gates: setting up a NEW NFC terminal, a NEW WLAN
 * presence source or a NEW API key needs the booked module (D-05); everything that maintains or
 * uses an existing setup stays free (D-05, D-06).
 *
 * Tenants come from `seedGrundversionTenant` (no module booked); the shared `seedTestData` fixture
 * books everything and would make every gate case vacuous.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { TenantModule } from "@clokr/db";
import { getTestApp, seedGrundversionTenant, cleanupTestData, createTestSalon } from "./setup";
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
