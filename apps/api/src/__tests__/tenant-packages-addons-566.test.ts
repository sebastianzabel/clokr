/**
 * Phase 566 (#566), plan 05 — the first add-on gates: setting up a NEW NFC terminal, a NEW WLAN
 * presence source or a NEW API key needs the booked module (D-05); everything that maintains or
 * uses an existing setup stays free (D-05, D-06).
 *
 * Tenants come from `seedGrundversionTenant` (no module booked); the shared `seedTestData` fixture
 * books everything and would make every gate case vacuous.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { TenantModule } from "@clokr/db";
import { getTestApp, seedGrundversionTenant, cleanupTestData } from "./setup";
import { moduleNotBookedMessage } from "../contexts/platform/tenant-packages";

type Seed = Awaited<ReturnType<typeof seedGrundversionTenant>>;

let app: FastifyInstance;

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
