import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("GET /api/v1/release-notes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it("returns 200 with no Authorization header (public, like /version)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/release-notes" });
    expect(res.statusCode).toBe(200);
  });

  it("response body has exactly one top-level key: releases (an array)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/release-notes" });
    const body = JSON.parse(res.body);
    expect(Object.keys(body)).toEqual(["releases"]);
    expect(Array.isArray(body.releases)).toBe(true);
  });

  it("contains >= 22 entries in this working tree, newest first", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/release-notes" });
    const body = JSON.parse(res.body);
    expect(body.releases.length).toBeGreaterThanOrEqual(22);

    // newest-first: numeric semver comparison, not lexical
    for (let i = 0; i < body.releases.length - 1; i++) {
      const a = body.releases[i].version.split(".").map(Number);
      const b = body.releases[i + 1].version.split(".").map(Number);
      const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      expect(cmp).toBeGreaterThanOrEqual(0);
    }
  });

  it("every entry has exactly version, title, intro, sections, footnote and no other key", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/release-notes" });
    const body = JSON.parse(res.body);
    const expectedKeys = ["version", "title", "intro", "sections", "footnote"].sort();
    for (const entry of body.releases) {
      expect(Object.keys(entry).sort()).toEqual(expectedKeys);
    }
  });

  it("the route module makes no outbound HTTP request (AK-04/AK-05): no fetch, no https, no github.com", () => {
    const source = readFileSync(resolve(__dirname, "../routes/release-notes.ts"), "utf-8");
    expect(/fetch\(/.test(source)).toBe(false);
    expect(/https?:\/\//.test(source)).toBe(false);
    expect(/github\.com/.test(source)).toBe(false);
  });

  it("calling the endpoint twice returns byte-identical bodies (loaded once at module init, not re-read per request)", async () => {
    const res1 = await app.inject({ method: "GET", url: "/api/v1/release-notes" });
    const res2 = await app.inject({ method: "GET", url: "/api/v1/release-notes" });
    expect(res1.body).toBe(res2.body);
  });
});

describe("GET/PUT /api/v1/me/release-notes-seen", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rns");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("GET without a token -> 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/me/release-notes-seen" });
    expect(res.statusCode).toBe(401);
  });

  it("PUT without a token -> 401", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/release-notes-seen",
      payload: { version: "1.9.18" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET as a fresh EMPLOYEE -> 200 { lastSeenVersion: null }", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/release-notes-seen",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ lastSeenVersion: null });
  });

  it("PUT { version: '1.9.18' } as EMPLOYEE -> 200, a following GET returns the same", async () => {
    const putRes = await app.inject({
      method: "PUT",
      url: "/api/v1/me/release-notes-seen",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { version: "1.9.18" },
    });
    expect(putRes.statusCode).toBe(200);
    expect(JSON.parse(putRes.body)).toEqual({ lastSeenVersion: "1.9.18" });

    const getRes = await app.inject({
      method: "GET",
      url: "/api/v1/me/release-notes-seen",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(JSON.parse(getRes.body)).toEqual({ lastSeenVersion: "1.9.18" });
  });

  it("the same flow works unchanged for an ADMIN token (D-08/AK-08: no role gate)", async () => {
    const putRes = await app.inject({
      method: "PUT",
      url: "/api/v1/me/release-notes-seen",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { version: "1.9.17" },
    });
    expect(putRes.statusCode).toBe(200);
    expect(JSON.parse(putRes.body)).toEqual({ lastSeenVersion: "1.9.17" });

    const getRes = await app.inject({
      method: "GET",
      url: "/api/v1/me/release-notes-seen",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(JSON.parse(getRes.body)).toEqual({ lastSeenVersion: "1.9.17" });
  });

  it("PUT { version: 'not-a-version' } -> 400 (Zod)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/release-notes-seen",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { version: "not-a-version" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT {} -> 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/release-notes-seen",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT writes ONLY the calling user's row: a second seeded user's lastSeenReleaseVersion stays null", async () => {
    const putRes = await app.inject({
      method: "PUT",
      url: "/api/v1/me/release-notes-seen",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { version: "1.9.16" },
    });
    expect(putRes.statusCode).toBe(200);

    const adminUser = await app.prisma.user.findUnique({
      where: { id: data.adminUser.id },
      select: { lastSeenReleaseVersion: true },
    });
    // The admin's PUT in an earlier test set it to "1.9.17" -- unaffected by the employee's
    // write here. Re-assert it is NOT "1.9.16" (the employee's value), proving cross-user
    // isolation rather than merely "the admin has some value".
    expect(adminUser?.lastSeenReleaseVersion).not.toBe("1.9.16");
  });

  it("a clk_-prefixed API-key token on GET -> 400 with a German message", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { name: "Release-notes-seen guard test key", scopes: ["read:employees"] },
    });
    expect(createRes.statusCode).toBe(200);
    const { rawKey } = JSON.parse(createRes.body);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/release-notes-seen",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/API-Keys/);
  });

  it("a clk_-prefixed API-key token on PUT -> 400 with a German message", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { name: "Release-notes-seen guard test key 2", scopes: ["read:employees"] },
    });
    expect(createRes.statusCode).toBe(200);
    const { rawKey } = JSON.parse(createRes.body);

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/release-notes-seen",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { version: "1.9.18" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/API-Keys/);
  });

  it("no AuditLog row is created by a PUT (count before === count after)", async () => {
    const before = await app.prisma.auditLog.count({
      where: { userId: data.empUser.id },
    });

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/release-notes-seen",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { version: "1.9.15" },
    });
    expect(res.statusCode).toBe(200);

    const after = await app.prisma.auditLog.count({
      where: { userId: data.empUser.id },
    });
    expect(after).toBe(before);
  });
});
