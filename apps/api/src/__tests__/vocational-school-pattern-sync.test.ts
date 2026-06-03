// Phase 67.2 Plan 03 — Test I: On-demand sync hook on first BS-Pattern create.
//
// Spawned as a separate file so vi.mock of `school-holidays-sync` is scoped to
// this suite and does NOT pollute the other vocational-school tests. The mock
// replaces `syncSchoolHolidaysForTenant` with a spy so we can assert that the
// PUT handler triggers it exactly once on the first active pattern create and
// NOT on subsequent PUTs.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const syncSpy = vi.fn();

vi.mock("../plugins/school-holidays-sync", async () => {
  const actual = await vi.importActual<typeof import("../plugins/school-holidays-sync")>(
    "../plugins/school-holidays-sync",
  );
  return {
    ...actual,
    syncSchoolHolidaysForTenant: (...args: Parameters<typeof actual.syncSchoolHolidaysForTenant>) =>
      syncSpy(...args),
  };
});

// Import setup AFTER vi.mock so the route module picks up the mock when wired.
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

describe("Phase 67.2 — first-pattern-create triggers on-demand sync (Test I)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vs-sync");
  });

  afterAll(async () => {
    try {
      await app.prisma.schoolHolidayPeriod.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    syncSpy.mockReset();
    // Make the spy resolve OK by default (fire-and-forget).
    syncSpy.mockResolvedValue({ syncedAt: new Date(), perState: [] });
    await app.prisma.employeeVocationalSchoolPattern.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.absence.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.schoolHolidayPeriod.deleteMany({ where: { tenantId: data.tenant.id } });
  });

  it("First PUT triggers syncSchoolHolidaysForTenant; second PUT does NOT", async () => {
    // Sanity: tenant has zero active patterns now (deleteMany in beforeEach).
    const before = await app.prisma.employeeVocationalSchoolPattern.count({
      where: { isActive: true, employee: { tenantId: data.tenant.id } },
    });
    expect(before).toBe(0);

    // First PUT — sync MUST be called (best-effort, fire-and-forget).
    const res1 = await app.inject({
      method: "PUT",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        patterns: [
          {
            daysOfWeek: [1],
            blockWeeks: [],
            validFrom: "2026-06-01",
            federalStateOverride: "BAYERN",
          },
        ],
      },
    });
    expect(res1.statusCode).toBe(200);

    // Give the fire-and-forget Promise.catch chain one microtask tick.
    await new Promise((r) => setImmediate(r));

    expect(syncSpy).toHaveBeenCalledTimes(1);
    // The federalStateOverride MUST appear in the sync's needed-states list
    // alongside Tenant.federalState (NIEDERSACHSEN from seed).
    const firstCallArgs = syncSpy.mock.calls[0];
    const neededStates = firstCallArgs[2] as string[];
    expect(neededStates).toContain("NIEDERSACHSEN");
    expect(neededStates).toContain("BAYERN");

    // Second PUT — tenant now HAS an active pattern, so sync is NOT triggered.
    syncSpy.mockClear();
    const res2 = await app.inject({
      method: "PUT",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        patterns: [{ daysOfWeek: [3], blockWeeks: [], validFrom: "2026-06-01" }],
      },
    });
    expect(res2.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it("PUT succeeds even when sync rejects (fire-and-forget — never blocks response)", async () => {
    syncSpy.mockReset();
    syncSpy.mockRejectedValue(new Error("OpenHolidays down"));

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        patterns: [{ daysOfWeek: [2], blockWeeks: [], validFrom: "2026-06-01" }],
      },
    });
    expect(res.statusCode).toBe(200);

    // Verify the pattern persisted regardless of sync failure (audit-proof).
    const persisted = await app.prisma.employeeVocationalSchoolPattern.findMany({
      where: { employeeId: data.employee.id, isActive: true },
    });
    expect(persisted).toHaveLength(1);
  });
});
