/**
 * Issue #563 (D-04, D-13) — the tenant-level opening hours are gone from the settings API; opening
 * hours live only on `Salon.openingHours`. A settings write never touches a salon.
 *
 * Replaces `settings-store-hours-salon-mirror.test.ts`: the salon mirror of `PUT /settings/work` is
 * gone, so what that file pinned (a settings write copies hours into the sole active salon) is
 * pinned the other way round. Issue #638 dropped the tenant column, so the former column reads
 * (stale client key stripped, column unchanged) are removed with it — there is nothing left to read.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon, auditRowsFor } from "./setup";
import * as salonFacade from "../contexts/platform/facade/salons";

async function putWork(app: FastifyInstance, token: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "PUT",
    url: "/api/v1/settings/work",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

describe("storeHours retired in the settings API (#563, D-13)", () => {
  let app: FastifyInstance;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      try {
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("GET /settings/work still carries the shift check mode", async () => {
    const data = await seedTestData(app, "sh-retired-get");
    tenantIds.push(data.tenant.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(JSON.parse(res.body)).toHaveProperty("shiftStoreHoursMode");
  });

  it("the sole active salon keeps its hours (and gets no audit row) when a settings write is saved", async () => {
    const data = await seedTestData(app, "sh-retired-sole", { withDefaultSalon: false });
    tenantIds.push(data.tenant.id);
    const salon = await createTestSalon(app.prisma, data.tenant.id, { name: "Einziger Salon" });

    const res = await putWork(app, data.adminToken, { retroEntryWindowDays: 14 });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);

    const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
    expect(fresh.openingHours).toEqual(salon.openingHours);
    expect(await auditRowsFor(app, "Salon", salon.id)).toHaveLength(0);
  });

  it("PUT { shiftStoreHoursMode } alone (the reduced admin/system section) changes only the mode", async () => {
    const data = await seedTestData(app, "sh-retired-mode");
    tenantIds.push(data.tenant.id);

    const before = await app.prisma.tenantConfig.findUniqueOrThrow({
      where: { tenantId: data.tenant.id },
    });
    const tenantBefore = await app.prisma.tenant.findUniqueOrThrow({
      where: { id: data.tenant.id },
    });
    const newMode = before.shiftStoreHoursMode === "STRICT" ? "OFF" : "STRICT";

    const res = await putWork(app, data.adminToken, { shiftStoreHoursMode: newMode });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    expect(JSON.parse(res.body).shiftStoreHoursMode).toBe(newMode);

    const after = await app.prisma.tenantConfig.findUniqueOrThrow({
      where: { tenantId: data.tenant.id },
    });
    expect(after.shiftStoreHoursMode).toBe(newMode);
    expect(after.defaultWeeklyHours).toEqual(before.defaultWeeklyHours);
    expect(after.timezone).toBe(before.timezone);
    const tenantAfter = await app.prisma.tenant.findUniqueOrThrow({
      where: { id: data.tenant.id },
    });
    expect(tenantAfter.name).toBe(tenantBefore.name);
    expect(tenantAfter.federalState).toBe(tenantBefore.federalState);
  });

  it("the salon facade no longer exports the mirror, but still the default week", () => {
    const names = Object.keys(salonFacade);
    expect(names).not.toContain("syncSoleActiveSalonOpeningHours");
    expect(names).toContain("DEFAULT_SALON_OPENING_HOURS");
  });
});
