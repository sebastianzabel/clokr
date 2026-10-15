/**
 * Issue #563 (D-04, D-13) — `TenantConfig.storeHours` is retired in the API, the way #433 retired
 * `monthlyHoursHolidayDeduction` (`contexts/platform/api/__tests__/minijob.test.ts`, "Issue #433 —
 * retired MONTHLY_HOURS holiday switch"). Opening hours live only on `Salon.openingHours`.
 *
 * Replaces `settings-store-hours-salon-mirror.test.ts`: the salon mirror of `PUT /settings/work` is
 * gone, so what that file pinned (a settings write copies hours into the sole active salon) is
 * now pinned the other way round — a settings write never touches a salon.
 *
 * The column stays in the schema for image-rollback safety until the follow-up release drops it.
 * The direct column reads below are the ONE sanctioned test read of it: they prove a stale client's
 * key never reaches the column.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon, auditRowsFor } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";
import * as salonFacade from "../contexts/platform/facade/salons";

/** Differs from the default week in day 0 (closed) and day 6 (shorter), so a write would be visible. */
const OTHER_WEEK = DEFAULT_SALON_OPENING_HOURS.map((d, i) =>
  i === 0 ? { ...d, closed: true } : i === 6 ? { ...d, open: "10:00", close: "14:00" } : d,
);

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

  async function salonAuditCount(salonIds: string[]): Promise<number> {
    let n = 0;
    for (const id of salonIds) n += (await auditRowsFor(app, "Salon", id)).length;
    return n;
  }

  it("GET /settings/work carries no storeHours but still the shift check mode", async () => {
    const data = await seedTestData(app, "sh-retired-get");
    tenantIds.push(data.tenant.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).not.toHaveProperty("storeHours");
    expect(body).toHaveProperty("shiftStoreHoursMode");
  });

  it("GET /settings/work of a tenant without a config row carries no storeHours either", async () => {
    const data = await seedTestData(app, "sh-retired-nocfg");
    tenantIds.push(data.tenant.id);
    await app.prisma.tenantConfig.delete({ where: { tenantId: data.tenant.id } });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(JSON.parse(res.body)).not.toHaveProperty("storeHours");
  });

  it("PUT with a stale storeHours key: 200, key stripped from the response, column, salon and Salon audit untouched", async () => {
    const data = await seedTestData(app, "sh-retired-put");
    tenantIds.push(data.tenant.id);
    const salonIds = [data.salonId];

    const columnBefore = (
      await app.prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId: data.tenant.id } })
    ).storeHours;
    const salonBefore = await app.prisma.salon.findUniqueOrThrow({ where: { id: data.salonId } });
    const auditsBefore = await salonAuditCount(salonIds);

    const res = await putWork(app, data.adminToken, { storeHours: OTHER_WEEK });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    expect(JSON.parse(res.body)).not.toHaveProperty("storeHours");

    const columnAfter = (
      await app.prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId: data.tenant.id } })
    ).storeHours;
    expect(columnAfter).toEqual(columnBefore);
    expect(columnAfter).not.toEqual(OTHER_WEEK);

    const salonAfter = await app.prisma.salon.findUniqueOrThrow({ where: { id: data.salonId } });
    expect(salonAfter.openingHours).toEqual(salonBefore.openingHours);
    expect(await salonAuditCount(salonIds)).toBe(auditsBefore);
  });

  it("PUT with a malformed 3-entry storeHours array is stripped before validation: 200, nothing written", async () => {
    const data = await seedTestData(app, "sh-retired-malformed");
    tenantIds.push(data.tenant.id);

    const columnBefore = (
      await app.prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId: data.tenant.id } })
    ).storeHours;

    const res = await putWork(app, data.adminToken, { storeHours: OTHER_WEEK.slice(0, 3) });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);

    const columnAfter = (
      await app.prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId: data.tenant.id } })
    ).storeHours;
    expect(columnAfter).toEqual(columnBefore);
  });

  it("the sole active salon keeps its hours (and gets no audit row) when only the retired key is sent", async () => {
    const data = await seedTestData(app, "sh-retired-sole", { withDefaultSalon: false });
    tenantIds.push(data.tenant.id);
    const salon = await createTestSalon(app.prisma, data.tenant.id, { name: "Einziger Salon" });

    const res = await putWork(app, data.adminToken, { storeHours: OTHER_WEEK });
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
    expect(after.storeHours).toEqual(before.storeHours);
    const tenantAfter = await app.prisma.tenant.findUniqueOrThrow({
      where: { id: data.tenant.id },
    });
    expect(tenantAfter.name).toBe(tenantBefore.name);
    expect(tenantAfter.federalState).toBe(tenantBefore.federalState);
  });

  it("PUT with an unrelated field answers without storeHours", async () => {
    const data = await seedTestData(app, "sh-retired-unrelated");
    tenantIds.push(data.tenant.id);

    const res = await putWork(app, data.adminToken, { retroEntryWindowDays: 14 });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    expect(JSON.parse(res.body)).not.toHaveProperty("storeHours");
  });

  it("the salon facade no longer exports the mirror, but still the default week", () => {
    const names = Object.keys(salonFacade);
    expect(names).not.toContain("syncSoleActiveSalonOpeningHours");
    expect(names).toContain("DEFAULT_SALON_OPENING_HOURS");
  });
});
