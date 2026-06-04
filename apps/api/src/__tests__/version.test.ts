import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { getTestApp, closeTestApp } from "./setup";
import type { FastifyInstance } from "fastify";

describe("GET /api/v1/version (Phase 69 / DEVOPS-V8-02)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it("returns 200 with body shape { version: string }", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/version" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("version");
    expect(typeof body.version).toBe("string");
    // D-02: minimal shape — no name, no buildTime, no sha
    expect(Object.keys(body).sort()).toEqual(["version"]);
  });

  it("version matches apps/api/package.json and is valid semver", async () => {
    const pkgPath = resolve(__dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
    const res = await app.inject({ method: "GET", url: "/api/v1/version" });
    const body = res.json();
    expect(body.version).toBe(pkg.version);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
