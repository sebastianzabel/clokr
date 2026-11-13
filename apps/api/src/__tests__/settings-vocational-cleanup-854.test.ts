/**
 * Issue #854 (D-854-20) - the Berufsschul-Schichtbereinigung toggle persists: PUT /settings/work
 * accepts `vocationalSchoolAutoCleanupShifts` (it used to be stripped, so the admin switch saved
 * nothing), changes only that field and writes exactly one audit row naming it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, auditRowChangingField } from "./setup";

describe("vocationalSchoolAutoCleanupShifts in PUT /settings/work (#854, D-854-20)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const admin = () => ({ authorization: `Bearer ${data.adminToken}` });
  const put = (payload: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: "/api/v1/settings/work", headers: admin(), payload });
  const get = async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/settings/work", headers: admin() });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as Record<string, unknown>;
  };

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vsc854");
  });
  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  it("persists false, leaves every other field unchanged and writes one audit row naming the field", async () => {
    // Make sure a config row exists, then take the baseline.
    expect((await put({ reminderOffsetMinutes: 15 })).statusCode).toBe(200);
    const before = await get();
    expect(before.vocationalSchoolAutoCleanupShifts).toBe(true);

    const res = await put({ vocationalSchoolAutoCleanupShifts: false });
    expect(res.statusCode).toBe(200);

    const after = await get();
    expect(after.vocationalSchoolAutoCleanupShifts).toBe(false);
    for (const key of Object.keys(before)) {
      if (key === "vocationalSchoolAutoCleanupShifts" || key === "updatedAt") continue;
      expect(after[key], key).toEqual(before[key]);
    }

    const row = await auditRowChangingField(
      app,
      "TenantConfig",
      after.id as string,
      "UPDATE",
      "vocationalSchoolAutoCleanupShifts",
    );
    expect(row.oldValue).toEqual({ vocationalSchoolAutoCleanupShifts: true });
    expect(row.newValue).toMatchObject({ vocationalSchoolAutoCleanupShifts: false });
  });

  it("a PUT without the key keeps the stored value", async () => {
    expect((await get()).vocationalSchoolAutoCleanupShifts).toBe(false);
    expect((await put({ reminderOffsetMinutes: 20 })).statusCode).toBe(200);
    expect((await get()).vocationalSchoolAutoCleanupShifts).toBe(false);
  });

  it("switches back on, and a non-boolean is a 400 that changes nothing", async () => {
    expect((await put({ vocationalSchoolAutoCleanupShifts: "no" })).statusCode).toBe(400);
    expect((await get()).vocationalSchoolAutoCleanupShifts).toBe(false);
    expect((await put({ vocationalSchoolAutoCleanupShifts: true })).statusCode).toBe(200);
    expect((await get()).vocationalSchoolAutoCleanupShifts).toBe(true);
  });
});
