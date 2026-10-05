/**
 * Phase 79 Plan 04 (Issue #79), R3 — `GET /api/v1/time-entries/summary`: presence time, working
 * time and recorded break of ONE employee over a period, summed over the very entry set the
 * Arbeitszeitkonto counts (T1: closed, valid, non-deleted WORK entries).
 *
 * Fake clock 2026-06-15T10:00:00Z — installed BEFORE the app boots so every token's iat/exp and
 * the saldo's "today" agree. No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

describe("Issue #79 (Phase 79 Plan 04) — GET /api/v1/time-entries/summary", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "tsum79");
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("time-entries-summary-79 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("tracer — the caller's own employee", () => {
    it("08:00-16:00 with a 30-minute break: presence 480, working 450, break 30, one entry (R1, R2, R3)", async () => {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          salonId: data.salonId,
          date: new Date("2026-02-02T00:00:00Z"),
          startTime: new Date("2026-02-02T08:00:00Z"),
          endTime: new Date("2026-02-02T16:00:00Z"),
          breakMinutes: 30,
          type: "WORK",
          source: "MANUAL",
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries/summary?employeeId=${data.employee.id}&from=2026-02-01&to=2026-02-28`,
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        employeeId: data.employee.id,
        from: "2026-02-01",
        to: "2026-02-28",
        presenceMinutes: 480,
        workingMinutes: 450,
        breakMinutes: 30,
        entryCount: 1,
      });
    });
  });
});
