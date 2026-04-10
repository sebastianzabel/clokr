import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData, closeTestApp } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let data: Awaited<ReturnType<typeof seedTestData>>;

beforeAll(async () => {
  app = await getTestApp();
  data = await seedTestData(app, "term");
});

afterAll(async () => {
  await cleanupTestData(app, data.tenant.id);
  await closeTestApp();
});

describe("Terminal API Key Management", () => {
  let terminalKeyId: string;
  let rawKey: string;

  it("POST / — creates a terminal key (ADMIN only)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/terminals",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { name: "Test Terminal" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.rawKey).toMatch(/^clk_/);
    expect(body.name).toBe("Test Terminal");
    expect(body.keyPrefix).toMatch(/^clk_/);
    terminalKeyId = body.id;
    rawKey = body.rawKey;
  });

  it("GET / — lists terminal keys (ADMIN only)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/terminals",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.keys.length).toBeGreaterThanOrEqual(1);
    expect(body.keys.find((k: { id: string }) => k.id === terminalKeyId)).toBeDefined();
  });

  it("GET /allowed-cards — returns registered NFC card IDs", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/terminals/allowed-cards",
      headers: { authorization: `Bearer ${rawKey}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.cards).toBeDefined();
    expect(Array.isArray(body.cards)).toBe(true);
  });

  it("GET /allowed-cards — includes employee NFC card IDs", async () => {
    // Assign NFC card to test employee
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { nfcCardId: "TEST-NFC-TERM" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/terminals/allowed-cards",
      headers: { authorization: `Bearer ${rawKey}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.cards).toContain("TEST-NFC-TERM");

    // Clean up
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { nfcCardId: null },
    });
  });

  it("GET /allowed-cards — rejects without API key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/terminals/allowed-cards",
    });

    expect(res.statusCode).toBe(401);
  });

  it("GET /allowed-cards — rejects invalid API key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/terminals/allowed-cards",
      headers: { authorization: "Bearer clk_invalid_key_12345" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("DELETE /:id — revokes terminal key", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/terminals/${terminalKeyId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it("GET /allowed-cards — rejects revoked API key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/terminals/allowed-cards",
      headers: { authorization: `Bearer ${rawKey}` },
    });

    expect(res.statusCode).toBe(401);
  });
});
