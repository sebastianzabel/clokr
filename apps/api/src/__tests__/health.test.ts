/**
 * Integration tests for the DB-ping health routes (OPS-V1814-05 / F-M10).
 *
 * /health and /api/v1/health must perform a real `SELECT 1`:
 *   - DB reachable  → 200 { status: "ok" }
 *   - DB unreachable → 503 { status: "degraded" }
 * /api/v1/version must stay static (no DB dependency) — a DB blip must not fail
 * the release smoke test.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp } from "./setup";
import type { FastifyInstance } from "fastify";

describe("health routes — DB ping (OPS-V1814-05)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
    vi.restoreAllMocks();
  });

  for (const path of ["/health", "/api/v1/health"]) {
    it(`GET ${path} returns 200 { status: "ok" } when the DB ping resolves`, async () => {
      const res = await app.inject({ method: "GET", url: path });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe("ok");
    });

    it(`GET ${path} returns 503 { status: "degraded" } when the DB ping rejects`, async () => {
      const spy = vi
        .spyOn(app.prisma, "$queryRaw")
        .mockRejectedValueOnce(new Error("DB down") as never);
      try {
        const res = await app.inject({ method: "GET", url: path });
        expect(res.statusCode).toBe(503);
        expect(JSON.parse(res.body).status).toBe("degraded");
      } finally {
        spy.mockRestore();
      }
    });
  }

  it("GET /api/v1/version stays static (200) even when the DB ping would fail", async () => {
    const spy = vi.spyOn(app.prisma, "$queryRaw").mockRejectedValue(new Error("DB down") as never);
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/version" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toHaveProperty("version");
    } finally {
      spy.mockRestore();
    }
  });
});
