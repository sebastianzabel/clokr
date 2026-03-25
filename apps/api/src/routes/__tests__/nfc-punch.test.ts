import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";

describe("NFC Punch API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const NFC_CARD_ID = "NFC-TEST-CARD-12345";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "nfc");

    // Assign NFC card to the employee
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { nfcCardId: NFC_CARD_ID },
    });
  });

  afterAll(async () => {
    // Clean up open entries before cleanup
    await app.prisma.break.deleteMany({
      where: { timeEntry: { employeeId: data.employee.id } },
    });
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  // Helper: clean up open entries
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

  describe("POST /time-entries/nfc-punch", () => {
    it("clock in with valid NFC card (action: IN)", async () => {
      await closeOpenEntries();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
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
      // There should be an open entry from the previous test
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
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
        payload: { nfcCardId: "UNKNOWN-CARD-99999" },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("Unbekannte");
    });

    it("returns 403 for deactivated employee", async () => {
      await closeOpenEntries();

      // Deactivate user
      await app.prisma.user.update({
        where: { id: data.empUser.id },
        data: { isActive: false },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        payload: { nfcCardId: NFC_CARD_ID },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("deaktiviert");

      // Re-activate
      await app.prisma.user.update({
        where: { id: data.empUser.id },
        data: { isActive: true },
      });
    });

    it("returns 409 BLOCKED on vacation day", async () => {
      await closeOpenEntries();

      const todayStr = new Date().toISOString().split("T")[0];

      // Create and approve leave for today
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: todayStr,
          endDate: todayStr,
        },
      });

      if (createRes.statusCode === 201) {
        const reqId = JSON.parse(createRes.body).id;

        await app.inject({
          method: "PATCH",
          url: `/api/v1/leave/requests/${reqId}/review`,
          headers: { authorization: `Bearer ${data.adminToken}` },
          payload: { status: "APPROVED" },
        });

        const res = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries/nfc-punch",
          payload: { nfcCardId: NFC_CARD_ID },
        });

        expect(res.statusCode).toBe(409);
        const body = JSON.parse(res.body);
        expect(body.action).toBe("BLOCKED");

        // Clean up
        await app.inject({
          method: "DELETE",
          url: `/api/v1/leave/requests/${reqId}`,
          headers: { authorization: `Bearer ${data.adminToken}` },
        });
      }
    });

    it("rejects NFC punch with wrong terminal secret when env var set", async () => {
      await closeOpenEntries();

      // Save original env var
      const originalSecret = process.env.NFC_TERMINAL_SECRET;

      // Set terminal secret
      process.env.NFC_TERMINAL_SECRET = "my-secret-123";

      try {
        // Punch without secret should fail
        const resNoSecret = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries/nfc-punch",
          payload: { nfcCardId: NFC_CARD_ID },
        });
        expect(resNoSecret.statusCode).toBe(403);

        // Punch with wrong secret should fail
        const resWrong = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries/nfc-punch",
          payload: { nfcCardId: NFC_CARD_ID, terminalSecret: "wrong-secret" },
        });
        expect(resWrong.statusCode).toBe(403);

        // Punch with correct secret should succeed
        const resCorrect = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries/nfc-punch",
          payload: { nfcCardId: NFC_CARD_ID, terminalSecret: "my-secret-123" },
        });
        expect(resCorrect.statusCode).toBe(200);
        const body = JSON.parse(resCorrect.body);
        expect(body.action).toBe("IN");
      } finally {
        // Restore original env var
        if (originalSecret !== undefined) {
          process.env.NFC_TERMINAL_SECRET = originalSecret;
        } else {
          delete process.env.NFC_TERMINAL_SECRET;
        }
      }
    });
  });
});
