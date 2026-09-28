// Issue #392 (quick task 260928-uli): regression test for the lost-update race in
// PUT /api/v1/me/preferences.
//
// Verified root cause: on /admin/themes, selectModern() sets skin, mode and theme stores in
// sequence; each store's subscriber fires its own partial savePreferences({key}) once
// prefsHydrated is true, so three (or more, elsewhere on the page) partial PUTs arrive within
// milliseconds of each other (observed API log: 19:59:19.850 and .852, then 19:59:20.885). The
// old handler does findUnique -> JS merge {...current, ...body} -> update with the WHOLE merged
// object, so a concurrent PUT that read the stale row writes an old key back over a newer one —
// a classic read-merge-write lost update. The race case below reproduces this with 5 concurrent
// single-key PUTs per round, over 10 rounds, and MUST fail on the unfixed handler.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { Prisma } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { JwtPayload } from "../middleware/auth";

const DEFAULTS = {
  skin: "editorial",
  theme: "pflaume",
  mode: "light",
  density: "comfortable",
  language: "de",
};

const SET_A = { skin: "modern", theme: "wald", mode: "dark", density: "compact", language: "en" };
const SET_B = {
  skin: "editorial",
  theme: "nacht",
  mode: "light",
  density: "comfortable",
  language: "de",
};

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
    "5 concurrent disjoint-key PUTs persist all 5 keys, in every one of 10 alternating rounds " +
      "(fails on the pre-fix findUnique -> JS merge -> full-object update handler)",
    async () => {
      const rounds = 10;
      for (let round = 0; round < rounds; round++) {
        const target = round % 2 === 0 ? SET_A : SET_B;

        const results = await Promise.all(
          (Object.keys(target) as (keyof typeof target)[]).map((key) =>
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

  it("a single partial PUT on a fresh state returns 200 with exactly the 5 default-merged keys", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/preferences",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { theme: "wald" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Object.keys(body).sort()).toEqual(["density", "language", "mode", "skin", "theme"]);
    expect(body).toEqual({ ...DEFAULTS, theme: "wald" });
  });

  it("an invalid enum value returns 400", async () => {
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
    expect(JSON.parse(res.body)).toEqual({ ...DEFAULTS, theme: "wald" });

    const stored = await app.prisma.user.findUnique({
      where: { id: data.empUser.id },
      select: { uiPreferences: true },
    });
    expect(stored?.uiPreferences).toEqual({ theme: "wald" });
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
    expect(JSON.parse(res.body)).toEqual({ ...DEFAULTS, theme: "wald" });

    const stored = await app.prisma.user.findUnique({
      where: { id: data.empUser.id },
      select: { uiPreferences: true },
    });
    expect(stored?.uiPreferences).toEqual({ theme: "wald" });
  });

  it("an unknown user id (valid JWT, nonexistent user) returns 404", async () => {
    const payload: JwtPayload = {
      sub: randomUUID(),
      role: "EMPLOYEE",
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
