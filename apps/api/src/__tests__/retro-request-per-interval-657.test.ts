/**
 * Issue #657 — a Zeitnachtrag is per INTERVAL, not per day.
 *
 * Several requests of one employee and day are created as long as their intervals do not overlap
 * (half-open, a legacy request without times covers the whole day); an overlap answers 409
 * `RETRO_REQUEST_OVERLAP` and writes nothing. Both creation paths (`POST /retro-entry-requests`
 * and the entry-first Nachtrag of `POST /time-entries`) run check and write under the one
 * employee row lock.
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, cleanupTestData, seedTestData, soleAuditRow } from "./setup";
import { nextWeekdayStr, pastDateStr } from "./test-dates";

const OVERLAP_BODY = {
  error: "Der Zeitraum überschneidet sich mit einem anderen Zeitnachtrag dieses Tages.",
  code: "RETRO_REQUEST_OVERLAP",
};

describe("Issue #657 — Zeitnachtrag per interval", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let tenantId: string;
  let employeeId: string;
  let dayCounter = 0;

  /** A distinct past weekday per call, far outside the retro window and after the hire date. */
  function nextDay(): string {
    dayCounter += 1;
    return nextWeekdayStr(pastDateStr(100 + 7 * dayCounter));
  }

  function propose(day: string, startTime: string, endTime: string, token = seed.empToken) {
    return app.inject({
      method: "POST",
      url: "/api/v1/retro-entry-requests",
      headers: { authorization: `Bearer ${token}` },
      payload: { targetDate: day, reason: "Nachtrag fixture", startTime, endTime },
    });
  }

  const liveRequests = (day: string) =>
    app.prisma.retroEntryRequest.findMany({
      where: { employeeId, targetDate: new Date(`${day}T00:00:00Z`), deletedAt: null },
      orderBy: { startTime: "asc" },
    });

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "rpi657");
    tenantId = seed.tenant.id;
    employeeId = seed.employee.id;
  });

  afterAll(async () => {
    try {
      await app.prisma.timeEntry.deleteMany({ where: { employee: { tenantId } } });
      await app.prisma.retroEntryRequest.deleteMany({ where: { employee: { tenantId } } });
      await cleanupTestData(app, tenantId);
    } catch {
      // best-effort cleanup
    }
  });

  describe("AC-657-1 via POST /retro-entry-requests", () => {
    it("creates non-overlapping requests of one day, refuses an overlap, accepts touching intervals", async () => {
      const day = nextDay();

      const a = await propose(day, "08:00", "12:00");
      expect(a.statusCode).toBe(201);
      const b = await propose(day, "13:00", "17:00");
      expect(b.statusCode).toBe(201);

      const c = await propose(day, "11:00", "14:00");
      expect(c.statusCode).toBe(409);
      expect(JSON.parse(c.body)).toEqual(OVERLAP_BODY);

      const d = await propose(day, "12:00", "13:00");
      expect(d.statusCode).toBe(201);

      const rows = await liveRequests(day);
      expect(rows.map((r) => `${r.startTime}-${r.endTime}`)).toEqual([
        "08:00-12:00",
        "12:00-13:00",
        "13:00-17:00",
      ]);
      for (const id of [a, b, d].map((r) => (JSON.parse(r.body) as { id: string }).id)) {
        const audit = await soleAuditRow(app.prisma, {
          where: { entity: "RetroEntryRequest", entityId: id, action: "RETRO_ENTRY_REQUESTED" },
        });
        expect(audit).toBeTruthy();
      }
    });
  });
});
