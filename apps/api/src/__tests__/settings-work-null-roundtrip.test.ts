// The admin forms echo the WHOLE tenant config back on save — apps/web/.../admin/export
// sends `{ ..._gOtherFields, datev… }`, where `_gOtherFields` is the untouched
// `GET /settings/work` response. Every nullable column therefore arrives at the PUT as an
// explicit `null`, including columns the saving page does not display at all.
//
// `holidayRulesValidFromYear` was declared `.optional()` without `.nullable()`, so that null
// failed the WHOLE request with a bare "Validierungsfehler" — on a field the DATEV page never
// shows. Reported from the running dev stack as "entering Berater-/Mandantennummer gives a
// validation error"; the two new numbers were innocent.
//
// This test pins the ROUND TRIP rather than the one field: read the config, send it back
// unchanged, expect 200. That is the shape the forms actually use, so a future `.optional()`
// on any nullable column fails here instead of in production.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("PUT /settings/work — a config read back and re-sent unchanged is accepted", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "settings-roundtrip");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("round-trips the full config, with every nullable column explicitly null", async () => {
    const read = await app.inject({
      method: "GET",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(read.statusCode).toBe(200);
    const cfg = JSON.parse(read.body) as Record<string, unknown>;

    // Anti-vacuity: the round trip only proves anything if the payload actually CARRIES nulls.
    // A config with none would make the assertion below pass while testing nothing.
    const nullKeys = Object.keys(cfg).filter((k) => cfg[k] === null);
    expect(
      nullKeys.length,
      "the seeded config carries no null columns — this round trip would prove nothing",
    ).toBeGreaterThan(0);
    expect(
      nullKeys,
      "holidayRulesValidFromYear is not null here, so this test no longer covers the reported case",
    ).toContain("holidayRulesValidFromYear");

    const write = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: cfg,
    });
    expect(
      write.statusCode,
      `re-sending the config unchanged was rejected: ${write.body.slice(0, 400)}`,
    ).toBe(200);
  });

  it("accepts an explicit null for holidayRulesValidFromYear on its own", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { holidayRulesValidFromYear: null },
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  });

  it("accepts a Decimal column in the string form its own GET emits", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultWeeklyHours: "38.50" },
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  });

  it("does NOT coerce non-numeric shapes — the tolerance is for Prisma's digits, nothing else", async () => {
    // z.coerce.number() would accept all three (true -> 1, null -> 0, "" -> 0). The narrow
    // preprocess must not; without this the round-trip fix would be a hole, not a tolerance.
    for (const bad of [true, "", "vierzig", "40abc"]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { defaultWeeklyHours: bad },
      });
      expect(res.statusCode, `${JSON.stringify(bad)} was accepted`).toBe(400);
    }
  });

  it("still rejects an out-of-range value in string form — bounds survive the tolerance", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultWeeklyHours: "999.00" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("still rejects an out-of-range year — nullable must not have widened the bounds", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { holidayRulesValidFromYear: 1999 },
    });
    expect(res.statusCode).toBe(400);
  });
});
