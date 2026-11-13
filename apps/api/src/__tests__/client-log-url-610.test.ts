/**
 * Issue #610 (review WR-02) - POST /api/v1/logs/client never writes a query string or fragment of the
 * reported page URL to the API log: a one-time pairing code can sit in `?code=` or in the `?next=` of
 * the sign-in leg that leads to the pairing page.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestData, getTestApp, seedTestData } from "./setup";

const CODE = "ab".repeat(32);

describe("POST /api/v1/logs/client - URL hygiene (Issue #610)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "clu610");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
  });

  it("logs the path of a pairing URL without the one-time code", async () => {
    const calls: unknown[][] = [];
    const spy = vi.spyOn(app.log, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/logs/client",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          level: "error",
          message: "boom",
          url: `/login?next=${encodeURIComponent(`/settings/geraet-koppeln?code=${CODE}`)}#${CODE}`,
          userAgent: "test-agent",
        },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      spy.mockRestore();
    }
    const logged = calls.map((c) => JSON.stringify(c)).join("\n");
    expect(logged).toContain("[CLIENT] boom");
    expect(logged).toContain('"url":"/login"');
    expect(logged).not.toContain(CODE);
    expect(logged).not.toContain("code=");
  });
});
