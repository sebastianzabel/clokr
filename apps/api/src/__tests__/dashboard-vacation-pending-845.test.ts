/**
 * Issue #845 — GET /dashboard carries the requested, undecided vacation days (`vacation.pending`)
 * for the Resturlaub cell of Ich › Mein Tag („3 beantragt“). The figure is the ONE Resturlaub facade's
 * `pendingDays` (Issue #451, D-07) — never a second sum.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";

describe("GET /dashboard vacation.pending (#845)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vp845");
  });
  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  it("equals the facade's pendingDays, also after a request is filed", async () => {
    const read = async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard",
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { vacation: { pending?: number } | null }).vacation;
    };
    const facade = async () => {
      const now = new Date();
      const b = await app.getVacationBalance(
        data.employee.id,
        data.tenant.id,
        now.getUTCFullYear(),
        now,
      );
      return b?.pendingDays ?? 0;
    };

    const before = await read();
    expect(before).not.toBeNull();
    expect(before!.pending).toBe(await facade());

    // A future weekday inside the current year whose request costs at least one day. A fixed
    // offset hit a public holiday (13.11. + 42 = 25.12., priced 0 days), so the request is
    // filed for the first candidate the pricing actually counts.
    const year = new Date().getUTCFullYear();
    let filedDays = 0;
    for (let offset = 7; offset <= 60 && filedDays === 0; offset++) {
      const day = new Date();
      day.setUTCDate(day.getUTCDate() + offset);
      if (day.getUTCFullYear() !== year) return; // year-bound figure
      if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
      const iso = day.toISOString().slice(0, 10);
      const filed = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { type: "VACATION", startDate: iso, endDate: iso },
      });
      if (filed.statusCode !== 201) return; // entitlement guard of the fixture; the parity above holds
      filedDays = Number((filed.json() as { days?: number | string }).days ?? 0);
    }
    expect(filedDays, "no countable day found within 60 days").toBeGreaterThan(0);
    const after = await read();
    expect(after!.pending).toBe(await facade());
    expect(after!.pending).toBeGreaterThan(before!.pending ?? 0);
  });
});
