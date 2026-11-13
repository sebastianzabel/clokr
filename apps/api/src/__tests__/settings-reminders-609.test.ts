/**
 * Issue #609 (D-01) - the tenant settings of the shift reminders are written through the existing
 * PUT /settings/work: three switches, the offset (5-120 minutes) and the evening time (HH:MM),
 * bounded, audited with the changed keys only, and off for a tenant that never touched them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, auditRowChangingField } from "./setup";

const ENABLE = {
  reminderShiftStartEnabled: true,
  reminderShiftEndEnabled: true,
  reminderDayCloseEnabled: true,
  reminderOffsetMinutes: 30,
  reminderDayCloseTime: "21:15",
};

describe("shift reminder settings (#609, D-01)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const admin = () => ({ authorization: `Bearer ${data.adminToken}` });
  const put = (payload: Record<string, unknown>, headers = admin()) =>
    app.inject({ method: "PUT", url: "/api/v1/settings/work", headers, payload });
  const get = async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/settings/work", headers: admin() });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as Record<string, unknown>;
  };

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rem609");
  });
  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  it("a freshly seeded tenant reads the defaults: three switches off, 15 minutes, 20:00", async () => {
    const cfg = await get();
    expect(cfg.reminderShiftStartEnabled).toBe(false);
    expect(cfg.reminderShiftEndEnabled).toBe(false);
    expect(cfg.reminderDayCloseEnabled).toBe(false);
    expect(cfg.reminderOffsetMinutes).toBe(15);
    expect(cfg.reminderDayCloseTime).toBe("20:00");
  });

  it("the GET /work fallback object names the five keys with the defaults", () => {
    const src = readFileSync(
      join(__dirname, "..", "contexts", "platform", "api", "settings.ts"),
      "utf8",
    );
    for (const line of [
      "reminderShiftStartEnabled: false,",
      "reminderShiftEndEnabled: false,",
      "reminderDayCloseEnabled: false,",
      "reminderOffsetMinutes: 15,",
      'reminderDayCloseTime: "20:00",',
    ]) {
      expect(src, line).toContain(line);
    }
  });

  it.each([
    [{ reminderOffsetMinutes: 4 }],
    [{ reminderOffsetMinutes: 121 }],
    [{ reminderOffsetMinutes: 15.5 }],
    [{ reminderOffsetMinutes: "15" }],
    [{ reminderDayCloseTime: "24:00" }],
    [{ reminderDayCloseTime: "7:5" }],
    [{ reminderDayCloseTime: "20:60" }],
    [{ reminderDayCloseTime: "" }],
    [{ reminderShiftStartEnabled: "yes" }],
    [{ reminderShiftEndEnabled: 1 }],
    [{ reminderDayCloseEnabled: null }],
  ])("rejects %j with 400 and changes nothing", async (payload) => {
    const before = await get();
    const res = await put(payload as Record<string, unknown>);
    expect(res.statusCode).toBe(400);
    const after = await get();
    for (const k of Object.keys(ENABLE)) expect(after[k], k).toEqual(before[k]);
  });

  it("accepts the bounds 5 and 120 minutes and the times 00:00 and 23:59", async () => {
    for (const payload of [
      { reminderOffsetMinutes: 5 },
      { reminderOffsetMinutes: 120 },
      { reminderDayCloseTime: "00:00" },
      { reminderDayCloseTime: "23:59" },
    ]) {
      const res = await put(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(200);
    }
    const cfg = await get();
    expect(cfg.reminderOffsetMinutes).toBe(120);
    expect(cfg.reminderDayCloseTime).toBe("23:59");
    // back to the defaults so the next cases see a known baseline
    expect(
      (await put({ reminderOffsetMinutes: 15, reminderDayCloseTime: "20:00" })).statusCode,
    ).toBe(200);
  });

  it("an admin switches all three occasions on, sets 30 minutes and 21:15, and the change is audited", async () => {
    const res = await put(ENABLE);
    expect(res.statusCode).toBe(200);
    const cfg = await get();
    for (const [k, v] of Object.entries(ENABLE)) expect(cfg[k], k).toBe(v);

    const row = await auditRowChangingField(
      app,
      "TenantConfig",
      cfg.id as string,
      "UPDATE",
      "reminderShiftStartEnabled",
    );
    // exactly the changed reminder keys, before and after (offset and time were 15 / "20:00")
    expect(row.oldValue).toEqual({
      reminderShiftStartEnabled: false,
      reminderShiftEndEnabled: false,
      reminderDayCloseEnabled: false,
      reminderOffsetMinutes: 15,
      reminderDayCloseTime: "20:00",
    });
    expect(row.newValue).toEqual({ ...ENABLE, appliedCount: 0 });
  });

  it("echoing the whole GET body back is accepted (the other admin pages send the full config)", async () => {
    const cfg = await get();
    const res = await put(cfg);
    expect(res.statusCode).toBe(200);
    const again = await get();
    for (const [k, v] of Object.entries(ENABLE)) expect(again[k], k).toBe(v);
  });

  it("an EMPLOYEE token cannot write the settings (permission unchanged)", async () => {
    const res = await put(
      { reminderOffsetMinutes: 10 },
      {
        authorization: `Bearer ${data.empToken}`,
      },
    );
    expect(res.statusCode).toBe(403);
    expect((await get()).reminderOffsetMinutes).toBe(30);
  });
});
