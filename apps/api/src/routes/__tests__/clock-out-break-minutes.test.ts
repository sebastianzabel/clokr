// Phase 129 (issue #129) — D-09 regression tests.
//
// `TimeEntry.breakMinutes` must be derived only from `Break` rows, never from a client-supplied
// integer on the clock-out body. This file guards two invariants:
//   (a) a `breakMinutes` value in the POST /:id/clock-out body is inert — the stored value is
//       whatever the entry's Break rows sum to, not the body value.
//   (b) a real break recorded via POST /:id/breaks survives a REOPEN (which adds its own gap
//       Break) and a subsequent clock-out — the stored value is always the sum of ALL Break rows.
//
// D-09(c) — the resolver/consolidation tree stays byte-identical — is not a test in this file;
// it is the `git diff --exit-code -- apps/api/src/services/clock/` acceptance criterion on the
// plan for this task.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import { getTenantTimezone, todayInTz } from "../../utils/timezone";
import type { FastifyInstance } from "fastify";

describe("POST /:id/clock-out — breakMinutes is derived from Break rows only (Phase 129)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let tz: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cobm");
    tz = await getTenantTimezone(app.prisma, data.tenant.id);
    // Auto-break must never fire in this suite — every fixture is well under the 6h
    // threshold anyway, but disabling it removes any dependency on tenant config defaults.
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { autoBreakEnabled: false },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // D-04: partial unique index (employeeId, date) WHERE deletedAt IS NULL means only one
  // non-deleted entry per employee-day — clear both Break and TimeEntry rows before each test.
  beforeEach(async () => {
    const today = todayInTz(tz);
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, date: today },
      select: { id: true },
    });
    await app.prisma.break.deleteMany({
      where: { timeEntryId: { in: entries.map((e) => e.id) } },
    });
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id, date: today },
    });
  });

  // D-10 (issue #136): derive the fixture day via the tenant timezone helper, the same way
  // the route does, instead of a standalone `new Date(); setHours(0,0,0,0)` assumption. The
  // fixture's working window stays well under 90 minutes, so it cannot straddle a tenant-tz
  // midnight, and no assertion below depends on which calendar day it landed on.
  async function seedOpenEntry() {
    const startTime = new Date(Date.now() - 90 * 60 * 1000); // 90 min ago — well past the
    // 60s STOP-debounce (D-02) and well under the 6h auto-break threshold.
    return app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: todayInTz(tz),
        startTime,
        source: "MANUAL",
      },
    });
  }

  it("(a) a body breakMinutes value cannot reach the stored column", async () => {
    const entry = await seedOpenEntry();

    // Record a real 20-minute break while the entry is still open.
    const breakStart = new Date(entry.startTime.getTime() + 10 * 60 * 1000);
    const breakEnd = new Date(entry.startTime.getTime() + 30 * 60 * 1000);
    const breakRes = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${entry.id}/breaks`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { startTime: breakStart.toISOString(), endTime: breakEnd.toISOString() },
    });
    expect(breakRes.statusCode).toBe(200);
    expect(JSON.parse(breakRes.body).breakMinutes).toBe(20);

    // Clock out with an inert, adversarial breakMinutes value in the body.
    const clockOutRes = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${entry.id}/clock-out`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { breakMinutes: 999 },
    });
    expect(clockOutRes.statusCode).toBe(200);
    const clockOutBody = JSON.parse(clockOutRes.body);
    expect(clockOutBody.entry.breakMinutes).toBe(20);

    // Assert against a fresh read, not only the response body.
    const stored = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
    expect(stored?.breakMinutes).toBe(20);
    expect(stored?.breakMinutes).not.toBe(999);
  });

  it("(b) a real break survives REOPEN + clock-out, invariant = sum of ALL Break rows", async () => {
    const entry = await seedOpenEntry();

    // Record a real 20-minute break while the entry is still open.
    const breakStart = new Date(entry.startTime.getTime() + 10 * 60 * 1000);
    const breakEnd = new Date(entry.startTime.getTime() + 30 * 60 * 1000);
    const breakRes = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${entry.id}/breaks`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { startTime: breakStart.toISOString(), endTime: breakEnd.toISOString() },
    });
    expect(breakRes.statusCode).toBe(200);

    // First clock-out — closes the entry.
    const firstClockOut = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${entry.id}/clock-out`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {},
    });
    expect(firstClockOut.statusCode).toBe(200);

    // REOPEN — same-day clock-in on the already-closed entry. The resolver inserts its own
    // gap Break (old endTime → new START timestamp) and recomputes breakMinutes from ALL
    // Break rows on the entry.
    const reopenRes = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { source: "MANUAL" },
    });
    expect(reopenRes.statusCode).toBe(200);

    // Second clock-out — again carries an adversarial breakMinutes in the body.
    const secondClockOut = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${entry.id}/clock-out`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { breakMinutes: 999 },
    });
    expect(secondClockOut.statusCode).toBe(200);

    // The original 20-minute Break row must still exist.
    const allBreaks = await app.prisma.break.findMany({
      where: { timeEntryId: entry.id },
      orderBy: { startTime: "asc" },
    });
    expect(allBreaks.length).toBeGreaterThanOrEqual(2); // the manual 20min break + the gap break
    const originalBreak = allBreaks.find(
      (b) =>
        b.startTime.getTime() === breakStart.getTime() &&
        b.endTime.getTime() === breakEnd.getTime(),
    );
    expect(originalBreak).toBeDefined();

    // Invariant, not a hardcoded total: stored breakMinutes == rounded sum of ALL Break rows.
    const expectedTotal = Math.round(
      allBreaks.reduce((sum, b) => sum + (b.endTime.getTime() - b.startTime.getTime()) / 60000, 0),
    );
    const stored = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
    expect(stored?.breakMinutes).toBe(expectedTotal);
    expect(stored?.breakMinutes).not.toBe(999);
  });
});
