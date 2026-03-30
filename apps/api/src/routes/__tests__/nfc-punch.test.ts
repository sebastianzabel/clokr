import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "crypto";

describe("NFC Punch API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const NFC_CARD_ID = "NFC-TEST-CARD-12345";
  let terminalApiKey: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "nfc");

    // Assign NFC card to the employee
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { nfcCardId: NFC_CARD_ID },
    });

    // Create a terminal API key for this tenant
    terminalApiKey = `clk_${randomBytes(32).toString("hex")}`;
    const keyHash = createHash("sha256").update(terminalApiKey).digest("hex");
    await app.prisma.terminalApiKey.create({
      data: {
        tenantId: data.tenant.id,
        name: "Test Terminal",
        keyHash,
        keyPrefix: terminalApiKey.substring(0, 12) + "...",
      },
    });
  });

  afterAll(async () => {
    await app.prisma.break.deleteMany({
      where: { timeEntry: { employeeId: data.employee.id } },
    });
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.terminalApiKey.deleteMany({
      where: { tenantId: data.tenant.id },
    });
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  async function closeOpenEntries() {
    const open = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, endTime: null },
    });
    for (const e of open) {
      await app.prisma.timeEntry.update({
        where: { id: e.id },
        data: { endTime: new Date() },
      });
    }
  }

  function punchHeaders() {
    return { authorization: `Bearer ${terminalApiKey}` };
  }

  describe("POST /time-entries/nfc-punch", () => {
    it("clock in with valid NFC card (action: IN)", async () => {
      await closeOpenEntries();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: punchHeaders(),
        payload: { nfcCardId: NFC_CARD_ID },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.action).toBe("IN");
      expect(body.employee).toBeDefined();
      expect(body.employee.firstName).toBe("Max");
      expect(body.time).toBeDefined();
    });

    it("clock out with second NFC punch (action: OUT)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: punchHeaders(),
        payload: { nfcCardId: NFC_CARD_ID },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.action).toBe("OUT");
      expect(body.employee.firstName).toBe("Max");
    });

    it("returns 404 for unknown NFC card", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: punchHeaders(),
        payload: { nfcCardId: "UNKNOWN-CARD-99999" },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("Unbekannte");
    });

    it("returns 401 without API key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        payload: { nfcCardId: NFC_CARD_ID },
      });

      expect(res.statusCode).toBe(401);
    });

    it("returns 401 with invalid API key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: "Bearer clk_invalid_key_12345" },
        payload: { nfcCardId: NFC_CARD_ID },
      });

      expect(res.statusCode).toBe(401);
    });

    it("returns 401 with revoked API key", async () => {
      await closeOpenEntries();

      // Create and immediately revoke a key
      const revokedKey = `clk_${randomBytes(32).toString("hex")}`;
      const revokedHash = createHash("sha256").update(revokedKey).digest("hex");
      await app.prisma.terminalApiKey.create({
        data: {
          tenantId: data.tenant.id,
          name: "Revoked Terminal",
          keyHash: revokedHash,
          keyPrefix: revokedKey.substring(0, 12) + "...",
          revokedAt: new Date(),
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: `Bearer ${revokedKey}` },
        payload: { nfcCardId: NFC_CARD_ID },
      });

      expect(res.statusCode).toBe(401);
    });

    it("returns 403 for deactivated employee", async () => {
      await closeOpenEntries();

      await app.prisma.user.update({
        where: { id: data.empUser.id },
        data: { isActive: false },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: punchHeaders(),
        payload: { nfcCardId: NFC_CARD_ID },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("deaktiviert");

      await app.prisma.user.update({
        where: { id: data.empUser.id },
        data: { isActive: true },
      });
    });

    it("enforces tenant isolation", async () => {
      await closeOpenEntries();

      // Create a key for a DIFFERENT tenant
      const otherTenantKey = `clk_${randomBytes(32).toString("hex")}`;
      const otherHash = createHash("sha256").update(otherTenantKey).digest("hex");
      const otherTenant = await app.prisma.tenant.create({
        data: { name: "Other Tenant", slug: "other-nfc-test" },
      });
      await app.prisma.terminalApiKey.create({
        data: {
          tenantId: otherTenant.id,
          name: "Other Terminal",
          keyHash: otherHash,
          keyPrefix: otherTenantKey.substring(0, 12) + "...",
        },
      });

      // Try to punch with the other tenant's key — employee not found
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: `Bearer ${otherTenantKey}` },
        payload: { nfcCardId: NFC_CARD_ID },
      });

      expect(res.statusCode).toBe(404);

      // Cleanup
      await app.prisma.terminalApiKey.deleteMany({ where: { tenantId: otherTenant.id } });
      await app.prisma.tenant.delete({ where: { id: otherTenant.id } });
    });
  });

  describe("COMPLIANCE: NFC punch and API key scoping", () => {
    it("valid terminal API key punch succeeds", async () => {
      await closeOpenEntries();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: punchHeaders(),
        payload: { nfcCardId: NFC_CARD_ID },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.action).toBeDefined();
      expect(body.employee).toBeDefined();
    });

    it("lastUsedAt is updated after punch", async () => {
      await closeOpenEntries();

      const before = new Date();

      await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: punchHeaders(),
        payload: { nfcCardId: NFC_CARD_ID },
      });

      // The update is fire-and-forget — allow up to 200ms for the update to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      const keyHash = createHash("sha256").update(terminalApiKey).digest("hex");
      const apiKey = await app.prisma.terminalApiKey.findUnique({ where: { keyHash } });
      expect(apiKey).not.toBeNull();
      expect(apiKey!.lastUsedAt).not.toBeNull();
      expect(apiKey!.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    });

    it("invalid API key returns 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: "Bearer clk_invalidkey999" },
        payload: { nfcCardId: NFC_CARD_ID },
      });

      expect(res.statusCode).toBe(401);
    });

    it("revoked API key returns 401", async () => {
      await closeOpenEntries();

      // Create and immediately revoke a key
      const revokedKey2 = `clk_${randomBytes(32).toString("hex")}`;
      const revokedHash2 = createHash("sha256").update(revokedKey2).digest("hex");
      await app.prisma.terminalApiKey.create({
        data: {
          tenantId: data.tenant.id,
          name: "Revoked Terminal 2",
          keyHash: revokedHash2,
          keyPrefix: revokedKey2.substring(0, 12) + "...",
          revokedAt: new Date(),
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: `Bearer ${revokedKey2}` },
        payload: { nfcCardId: NFC_CARD_ID },
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
