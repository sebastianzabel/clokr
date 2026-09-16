/**
 * fix(sec-12 / #225): POST /api/v1/time-entries/clock-in resolved `body.nfcCardId` via an
 * unfiltered `employee.findUnique({ where: { nfcCardId } })`. `Employee.nfcCardId` is globally
 * `@unique`, not per tenant. The downstream tenant check (`employeeRecord.tenantId !==
 * req.user.tenantId`) DOES block the cross-tenant clock-in itself, but the two failure paths
 * produced two DIFFERENT German error messages: an unknown card → "NFC Karte nicht gefunden",
 * a foreign tenant's REAL card → "Mitarbeiter nicht gefunden". That distinction is an existence
 * oracle — it lets an authenticated caller probe whether a given NFC card exists anywhere in the
 * system, not just in their own tenant. Fixed by scoping the initial lookup to the caller's
 * tenant (`findFirst` with `nfcCardId` AND `tenantId`), so both cases now produce the identical
 * "NFC Karte nicht gefunden" / 404 response. The later tenantId comparison is left in place —
 * it still guards the `body.employeeId` path.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("POST /api/v1/time-entries/clock-in — nfcCardId tenant scoping / existence oracle (#225)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  const TENANT_B_CARD_ID = "sec12-tenantb-real-card";
  const UNKNOWN_CARD_ID = "sec12-nobody-has-this-card";

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sec12-a");
    tenantB = await seedTestData(app, "sec12-b");

    await app.prisma.employee.update({
      where: { id: tenantB.employee.id },
      data: { nfcCardId: TENANT_B_CARD_ID },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantA failed:", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantB failed:", err);
    }
  });

  it("tenantA caller clocking in with tenantB's REAL card and an UNKNOWN card get the IDENTICAL 404 response (no existence oracle)", async () => {
    const realForeignCardRes = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { nfcCardId: TENANT_B_CARD_ID },
    });

    const unknownCardRes = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { nfcCardId: UNKNOWN_CARD_ID },
    });

    expect(realForeignCardRes.statusCode).toBe(404);
    expect(unknownCardRes.statusCode).toBe(404);
    expect(JSON.parse(realForeignCardRes.body)).toEqual({ error: "NFC Karte nicht gefunden" });
    expect(JSON.parse(realForeignCardRes.body)).toEqual(JSON.parse(unknownCardRes.body));
  });

  it("tenantB caller clocking in with their OWN card still works (no regression)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
      payload: { nfcCardId: TENANT_B_CARD_ID },
    });

    expect([200, 409]).toContain(res.statusCode);
  });
});
