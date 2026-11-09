// Issue #392 (quick task 260928-uli): regression test for the lost-update race in
// PUT /api/v1/me/preferences.
//
// Verified root cause: on /admin/themes, selectModern() sets skin, mode and theme stores in
// sequence; each store's subscriber fires its own partial savePreferences({key}) once
// prefsHydrated is true, so three (or more, elsewhere on the page) partial PUTs arrive within
// milliseconds of each other (observed API log: 19:59:19.850 and .852, then 19:59:20.885). The
// old handler does findUnique -> JS merge {...current, ...body} -> update with the WHOLE merged
// object, so a concurrent PUT that read the stale row writes an old key back over a newer one —
// a classic read-merge-write lost update. The race case below reproduces this with 6 concurrent
// single-key PUTs per round (each of the 3 keys twice), over 10 rounds, and MUST fail on the
// unfixed handler.
// #842 D-842-18: skin and density are retired, three keys remain; theme ids are mapped by
// normalizeUiTheme().
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { Prisma } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { JwtPayload } from "../middleware/auth";

// #842 D-842-18: the response carries exactly theme, mode, language.
const DEFAULTS = {
  theme: "pflaume",
  mode: "light",
  language: "de",
};

const SET_A = { theme: "petrol", mode: "dark", language: "en" };
const SET_B = { theme: "salz", mode: "light", language: "de" };

describe("PUT /api/v1/me/preferences (Issue #392, lost-update race)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "mprf");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it(
    "6 concurrent PUTs (each of the 3 keys twice) persist all 3 keys, in every one of 10 alternating rounds " +
      "(fails on the pre-fix findUnique -> JS merge -> full-object update handler)",
    async () => {
      const rounds = 10;
      for (let round = 0; round < rounds; round++) {
        const target = round % 2 === 0 ? SET_A : SET_B;

        // #842: three keys only, so each is sent twice to keep six concurrent requests per round.
        const keys = [...Object.keys(target), ...Object.keys(target)] as (keyof typeof target)[];
        const results = await Promise.all(
          keys.map((key) =>
            app.inject({
              method: "PUT",
              url: "/api/v1/me/preferences",
              headers: { authorization: `Bearer ${data.empToken}` },
              payload: { [key]: target[key] },
            }),
          ),
        );

        for (const res of results) {
          expect(res.statusCode).toBe(200);
        }

        const getRes = await app.inject({
          method: "GET",
          url: "/api/v1/me/preferences",
          headers: { authorization: `Bearer ${data.empToken}` },
        });
        expect(getRes.statusCode).toBe(200);
        const body = JSON.parse(getRes.body);
        expect(body, `round ${round} (target set ${round % 2 === 0 ? "A" : "B"})`).toEqual(target);
      }
    },
  );

  it("a single partial PUT on a fresh state returns 200 with exactly the 3 default-merged keys", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/preferences",
      headers: { authorization: `Bearer ${data.adminToken}` },
      // #842 D-842-18: the legacy id "wald" is stored and returned as "petrol".
      payload: { theme: "wald" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Object.keys(body).sort()).toEqual(["language", "mode", "theme"]);
    expect(body).toEqual({ ...DEFAULTS, theme: "petrol" });
  });

  // #842 D-842-18: the three current ids and the legacy mapping, on the wire and in storage.
  it.each([
    ["pflaume", "pflaume"],
    ["salz", "salz"],
    ["petrol", "petrol"],
    ["nacht", "salz"],
    ["schiefer", "salz"],
    ["wald", "petrol"],
  ])("PUT theme %s is stored and returned as %s", async (sent, stored) => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/preferences",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { theme: sent },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).theme).toBe(stored);
    const row = await app.prisma.user.findUnique({
      where: { id: data.empUser.id },
      select: { uiPreferences: true },
    });
    expect((row?.uiPreferences as Record<string, unknown>).theme).toBe(stored);
  });

  it("the retired skin and density keys answer 200 and are not stored (stale tab)", async () => {
    await app.prisma.user.update({
      where: { id: data.adminUser.id },
      data: { uiPreferences: { theme: "salz" } },
    });
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/preferences",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { skin: "modern", density: "compact" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ...DEFAULTS, theme: "salz" });
    const row = await app.prisma.user.findUnique({
      where: { id: data.adminUser.id },
      select: { uiPreferences: true },
    });
    expect(row?.uiPreferences).toEqual({ theme: "salz" });
  });

  it("GET normalises a stored legacy row and never returns skin or density", async () => {
    await app.prisma.user.update({
      where: { id: data.empUser.id },
      data: { uiPreferences: { theme: "wald", skin: "modern", density: "compact", mode: "dark" } },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/preferences",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Object.keys(body).sort()).toEqual(["language", "mode", "theme"]);
    expect(body).toEqual({ theme: "petrol", mode: "dark", language: "de" });
  });

  it("an unknown theme id (lila) still returns 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/preferences",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { theme: "lila" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("a stored uiPreferences of DB NULL is merged onto an empty object", async () => {
    await app.prisma.user.update({
      where: { id: data.empUser.id },
      data: { uiPreferences: Prisma.DbNull },
    });

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/preferences",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { theme: "wald" },
    });
    expect(res.statusCode).toBe(200);
    // #842 D-842-18: "wald" is stored as "petrol".
    expect(JSON.parse(res.body)).toEqual({ ...DEFAULTS, theme: "petrol" });

    const stored = await app.prisma.user.findUnique({
      where: { id: data.empUser.id },
      select: { uiPreferences: true },
    });
    expect(stored?.uiPreferences).toEqual({ theme: "petrol" });
  });

  it("a stored uiPreferences that is a JSON array is merged onto an empty object", async () => {
    await app.prisma.user.update({
      where: { id: data.empUser.id },
      data: { uiPreferences: ["garbage"] },
    });

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/preferences",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { theme: "wald" },
    });
    expect(res.statusCode).toBe(200);
    // #842 D-842-18: "wald" is stored as "petrol".
    expect(JSON.parse(res.body)).toEqual({ ...DEFAULTS, theme: "petrol" });

    const stored = await app.prisma.user.findUnique({
      where: { id: data.empUser.id },
      select: { uiPreferences: true },
    });
    expect(stored?.uiPreferences).toEqual({ theme: "petrol" });
  });

  it("an unknown user id (valid JWT, nonexistent user) returns 404", async () => {
    const payload: JwtPayload = {
      sub: randomUUID(),
      tenantId: data.tenant.id,
      employeeId: undefined,
    };
    const bearer = `Bearer ${app.jwt.sign(payload)}`;

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/preferences",
      headers: { authorization: bearer },
      payload: { theme: "wald" },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("Benutzer nicht gefunden");
  });
});
