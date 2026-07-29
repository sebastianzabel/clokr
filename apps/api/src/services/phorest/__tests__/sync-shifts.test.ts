// Phase 85 (SS-01/SS-03/SS-07) — fetch-mocked fixture tests for the shared Phorest shift sync.
// Mirrors apps/api/src/__tests__/school-holidays-client.test.ts for the fetch-mock harness.
// Run via `pnpm --filter @clokr/api test -- sync-shifts` (pretest db-push) — NOT bare vitest.

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp } from "../../../__tests__/setup";
import { syncPhorestShifts } from "../sync-shifts";
import { seedPhorestTenant, cleanupPhorestTenant, UNMAPPED_STAFF_ID } from "./helpers";
import staffFixture from "./fixtures/staff.json";
import wttFixture from "./fixtures/worktimetables.json";

const originalFetch = global.fetch;

// Route-key mock: the sync hits `/staff` AND `/staffworktimetables`. Because the worktimetable
// URL ALSO contains "/staff", the worktimetable route MUST be matched first.
function mockPhorest(): void {
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = url.toString();
    const body = u.includes("worktimetable") ? wttFixture : staffFixture;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("phorest sync-shifts", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("creates origin=PHOREST shifts and is idempotent on re-sync (no duplicates)", async () => {
    const seed = await seedPhorestTenant(app, "idem");
    try {
      mockPhorest();
      const first = await syncPhorestShifts(app, seed.tenantId);
      expect(first.status).toBe("SUCCESS");
      expect(first.created).toBe(2); // two mapped worktime entries → two shifts

      const countAfterFirst = await app.prisma.shift.count({
        where: { employeeId: seed.mappedEmployeeId, origin: "PHOREST", deletedAt: null },
      });
      expect(countAfterFirst).toBe(2);

      // Re-run against the identical fixtures — upsert by externalId, not insert.
      mockPhorest();
      const second = await syncPhorestShifts(app, seed.tenantId);
      expect(second.status).toBe("SUCCESS");
      expect(second.created).toBe(0);
      expect(second.updated).toBe(2);

      const countAfterSecond = await app.prisma.shift.count({
        where: { employeeId: seed.mappedEmployeeId, origin: "PHOREST", deletedAt: null },
      });
      expect(countAfterSecond).toBe(countAfterFirst); // no duplicates

      // Every invocation writes exactly one PhorestSyncRun row; both finished SUCCESS.
      const runs = await app.prisma.phorestSyncRun.findMany({ where: { tenantId: seed.tenantId } });
      expect(runs.length).toBe(2);
      expect(runs.every((r) => r.status === "SUCCESS")).toBe(true);
      expect(runs.every((r) => r.finishedAt !== null)).toBe(true);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("SS-01 negative-match: name/email-matchable but unmapped staff → zero shifts, unmapped++", async () => {
    const seed = await seedPhorestTenant(app, "ss01");
    try {
      mockPhorest();
      const res = await syncPhorestShifts(app, seed.tenantId);
      expect(res.status).toBe("SUCCESS");

      // Max's name + email equal the "ph-staff-unmapped" fixture entry, but he has NO mapping.
      // The sync must ignore implicit name/email matching → ZERO shifts for Max.
      const maxShifts = await app.prisma.shift.count({
        where: { employeeId: seed.unmappedEmployeeId },
      });
      expect(maxShifts).toBe(0);

      // The unmapped staff is counted and surfaced for the UI warning (never silently skipped).
      expect(res.unmapped).toBeGreaterThanOrEqual(1);
      expect(res.unmappedStaff.some((u) => u.phorestStaffId === UNMAPPED_STAFF_ID)).toBe(true);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });
});
