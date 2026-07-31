// Phase 85 (SS-01/SS-03/SS-04/SS-06/SS-07) — fetch-mocked fixture tests for the shared Phorest shift sync.
// Mirrors apps/api/src/__tests__/school-holidays-client.test.ts for the fetch-mock harness.
// Run via `pnpm --filter @clokr/api test -- sync-shifts` (pretest db-push) — NOT bare vitest.

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp } from "../../../__tests__/setup";
import { syncPhorestShifts } from "../sync-shifts";
import { extractWorkTimes } from "../types";
import type { PhorestApiResponse } from "../types";
import { seedPhorestTenant, cleanupPhorestTenant, UNMAPPED_STAFF_ID } from "./helpers";
import staffFixture from "./fixtures/staff.json";
import wttFixture from "./fixtures/worktimetables.json";
import wttDeletedFixture from "./fixtures/worktimetables-deleted.json";
import wttPagedP1 from "./fixtures/worktimetables-paged-p1.json";
import wttPagedP2 from "./fixtures/worktimetables-paged-p2.json";

const originalFetch = global.fetch;

// Broad, explicit window so the reconcile / plausibility date bounds deterministically include
// the 2026-07-30 / 2026-07-31 fixture dates regardless of the real "today" the suite runs on.
const WIDE_WINDOW = { startDate: "2026-07-01", endDate: "2026-12-31" };

// Route-key mock: the sync hits `/staff` AND `/staffworktimetables`. Because the worktimetable
// URL ALSO contains "/staff", the worktimetable route MUST be matched first.
function mockPhorest(worktimetables: unknown = wttFixture): void {
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = url.toString();
    const body = u.includes("worktimetable") ? worktimetables : staffFixture;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

// Worktimetables fetch fails with a non-ok HTTP status (staff still ok) → GATE 1 (fetch-ok).
function mockPhorestWttStatus(status: number): void {
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("worktimetable")) {
      return new Response("upstream unavailable", { status });
    }
    return new Response(JSON.stringify(staffFixture), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

// Paginated worktimetables: dispatch on the `page` query param — page 0 → p1 (has-more), 1 → p2.
function mockPhorestPaged(): void {
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("worktimetable")) {
      const pageParam = new URL(u).searchParams.get("page");
      const body = pageParam === "1" ? wttPagedP2 : wttPagedP1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(staffFixture), {
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

  it("SS-04 soft-cancel: a shift removed from the fresh window is soft-cancelled and drops from the active roster", async () => {
    const seed = await seedPhorestTenant(app, "cancel");
    try {
      // Seed: full window → two mapped shifts (07-30, 07-31).
      mockPhorest(wttFixture);
      const first = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(first.created).toBe(2);
      expect(first.cancelled).toBe(0);

      // Re-sync against the same window minus the 07-31 entry → it must be soft-cancelled.
      mockPhorest(wttDeletedFixture);
      const second = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(second.status).toBe("SUCCESS");
      expect(second.cancelled).toBe(1);

      // The cancelled row carries PHOREST_REMOVED + deletedAt, and no longer appears in an
      // active (deletedAt: null) roster query for its date (proves the §615 roster drop).
      const jul31 = new Date("2026-07-31");
      const cancelledRow = await app.prisma.shift.findFirst({
        where: { employeeId: seed.mappedEmployeeId, date: jul31 },
      });
      expect(cancelledRow?.deletedReason).toBe("PHOREST_REMOVED");
      expect(cancelledRow?.deletedAt).not.toBeNull();

      const activeOnJul31 = await app.prisma.shift.count({
        where: { employeeId: seed.mappedEmployeeId, date: jul31, deletedAt: null },
      });
      expect(activeOnJul31).toBe(0);

      // An audit DELETE row was written for the cancel (Revisionssicherheit).
      const deleteAudits = await app.prisma.auditLog.count({
        where: { entity: "Shift", action: "DELETE", entityId: cancelledRow?.id },
      });
      expect(deleteAudits).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("GUARDRAIL fetch-error: a 503 worktimetables fetch → status ERROR, zero cancel", async () => {
    const seed = await seedPhorestTenant(app, "err");
    try {
      // Seed active PHOREST shifts first so a false-cancel would have something to hit.
      mockPhorest(wttFixture);
      await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);

      mockPhorestWttStatus(503);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("ERROR");
      expect(res.cancelled).toBe(0);

      // Nothing was cancelled — the two seeded shifts are still active.
      const stillActive = await app.prisma.shift.count({
        where: { employeeId: seed.mappedEmployeeId, origin: "PHOREST", deletedAt: null },
      });
      expect(stillActive).toBe(2);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("GUARDRAIL empty-200 plausibility floor: HTTP-200 empty window with prior active shifts → SUSPECT, zero cancel", async () => {
    const seed = await seedPhorestTenant(app, "suspect");
    try {
      mockPhorest(wttFixture);
      await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);

      // A 200 with an EMPTY window (e.g. wrong branchId) must NOT be read as "everything deleted".
      mockPhorest({ _embedded: { workTimeTables: [] } });
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUSPECT");
      expect(res.cancelled).toBe(0);

      const stillActive = await app.prisma.shift.count({
        where: { employeeId: seed.mappedEmployeeId, origin: "PHOREST", deletedAt: null },
      });
      expect(stillActive).toBe(2);

      // The SUSPECT run is recorded (not SUCCESS) with cancelled 0.
      const suspectRun = await app.prisma.phorestSyncRun.findFirst({
        where: { tenantId: seed.tenantId, status: "SUSPECT" },
      });
      expect(suspectRun).not.toBeNull();
      expect(suspectRun?.cancelled).toBe(0);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("GUARDRAIL paginated: a two-page window is fully read before diffing → zero false cancel of the page-2 shift", async () => {
    const seed = await seedPhorestTenant(app, "paged");
    try {
      // Seed both shifts (07-30, 07-31) via the full single-page fixture.
      mockPhorest(wttFixture);
      const first = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(first.created).toBe(2);

      // Re-sync against a PAGINATED response: page 1 alone omits the 07-31 entry (it is on page 2).
      // The sync MUST exhaust both pages before diffing → the page-2 shift is NOT cancelled.
      mockPhorestPaged();
      const second = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(second.status).toBe("SUCCESS");
      expect(second.cancelled).toBe(0);

      const activeOnJul31 = await app.prisma.shift.count({
        where: { employeeId: seed.mappedEmployeeId, date: new Date("2026-07-31"), deletedAt: null },
      });
      expect(activeOnJul31).toBe(1); // page-2 shift still active
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("SS-03 MANUAL-safety: a MANUAL shift in the same window is never soft-cancelled", async () => {
    const seed = await seedPhorestTenant(app, "manual");
    try {
      // A MANUAL shift in-window whose slot does NOT match any fixture entry (so no adopt).
      const manual = await app.prisma.shift.create({
        data: {
          employeeId: seed.mappedEmployeeId,
          date: new Date("2026-07-30"),
          startTime: "12:00",
          endTime: "20:00",
          origin: "MANUAL",
          label: "Handeintrag",
        },
      });

      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");

      const stillActive = await app.prisma.shift.findUnique({ where: { id: manual.id } });
      expect(stillActive?.deletedAt).toBeNull();
      expect(stillActive?.origin).toBe("MANUAL");
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("SS-06 window: the reconcile window is driven by phorestSyncWindowDays", async () => {
    const seed = await seedPhorestTenant(app, "window");
    try {
      // A PHOREST shift 10 days out, absent from every fixture (so always a cancel candidate IF in window).
      const plusDays = (n: number) => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      };
      const far = await app.prisma.shift.create({
        data: {
          employeeId: seed.mappedEmployeeId,
          date: new Date(plusDays(10)),
          startTime: "08:00",
          endTime: "12:00",
          origin: "PHOREST",
          externalId: `win-test-${seed.tenantId}`,
        },
      });

      // windowDays = 7 (seed default): today+10 is OUT of window → NOT cancelled.
      mockPhorest(wttFixture);
      const narrow = await syncPhorestShifts(app, seed.tenantId);
      expect(narrow.status).toBe("SUCCESS");
      const afterNarrow = await app.prisma.shift.findUnique({ where: { id: far.id } });
      expect(afterNarrow?.deletedAt).toBeNull();

      // Widen the window to 30 days: today+10 is now IN window and absent from the fresh set → cancelled.
      await app.prisma.tenantConfig.update({
        where: { tenantId: seed.tenantId },
        data: { phorestSyncWindowDays: 30 },
      });
      mockPhorest(wttFixture);
      const wide = await syncPhorestShifts(app, seed.tenantId);
      expect(wide.cancelled).toBeGreaterThanOrEqual(1);
      const afterWide = await app.prisma.shift.findUnique({ where: { id: far.id } });
      expect(afterWide?.deletedReason).toBe("PHOREST_REMOVED");
      expect(afterWide?.deletedAt).not.toBeNull();
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("SS-07 adopt-on-match: a legacy label=Phorest MANUAL row is updated in place, not duplicated", async () => {
    const seed = await seedPhorestTenant(app, "adopt");
    try {
      // Pre-existing (pre-migration) label="Phorest" origin=MANUAL row, externalId null,
      // occupying the exact slot of the 07-30 mapped fixture entry (08:00-16:00).
      await app.prisma.shift.create({
        data: {
          employeeId: seed.mappedEmployeeId,
          date: new Date("2026-07-30"),
          startTime: "08:00",
          endTime: "16:00",
          origin: "MANUAL",
          label: "Phorest",
        },
      });

      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");

      // Exactly ONE active shift for that slot — adopted in place, not duplicated.
      const slot = await app.prisma.shift.findMany({
        where: {
          employeeId: seed.mappedEmployeeId,
          date: new Date("2026-07-30"),
          startTime: "08:00",
          endTime: "16:00",
          deletedAt: null,
        },
      });
      expect(slot.length).toBe(1);
      expect(slot[0].origin).toBe("PHOREST");
      expect(slot[0].externalId).not.toBeNull();

      // Idempotent: a second sync finds it via the externalId upsert and does not re-adopt/duplicate.
      mockPhorest(wttFixture);
      await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      const slotAgain = await app.prisma.shift.count({
        where: {
          employeeId: seed.mappedEmployeeId,
          date: new Date("2026-07-30"),
          startTime: "08:00",
          endTime: "16:00",
          deletedAt: null,
        },
      });
      expect(slotAgain).toBe(1);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("CR-01 adopt-safety: a genuine MANUAL shift (non-'Phorest' label) at the exact fixture slot is NEVER adopted or cancelled", async () => {
    const seed = await seedPhorestTenant(app, "manualslot");
    try {
      // A genuinely hand-entered MANUAL shift occupying the EXACT slot of the 07-30 mapped
      // fixture entry (08:00-16:00), but with a real label — NOT the legacy "Phorest" marker.
      // The sync must not reclassify it to origin=PHOREST (which would make it eligible for
      // auto soft-cancel), honouring the locked "MANUAL shifts are NEVER touched" invariant.
      const manual = await app.prisma.shift.create({
        data: {
          employeeId: seed.mappedEmployeeId,
          date: new Date("2026-07-30"),
          startTime: "08:00",
          endTime: "16:00",
          origin: "MANUAL",
          label: "Handeintrag",
        },
      });

      mockPhorest(wttFixture);
      const first = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(first.status).toBe("SUCCESS");

      // The MANUAL shift is untouched: still origin=MANUAL, still active, externalId untouched.
      const untouched = await app.prisma.shift.findUnique({ where: { id: manual.id } });
      expect(untouched?.origin).toBe("MANUAL");
      expect(untouched?.deletedAt).toBeNull();
      expect(untouched?.externalId).toBeNull();

      // The Phorest entry is created as a SEPARATE PHOREST row (collision handling = Phase 87),
      // so the slot now holds two active rows: the untouched MANUAL one + the new PHOREST one.
      const slot = await app.prisma.shift.findMany({
        where: {
          employeeId: seed.mappedEmployeeId,
          date: new Date("2026-07-30"),
          startTime: "08:00",
          endTime: "16:00",
          deletedAt: null,
        },
      });
      expect(slot.some((s) => s.origin === "MANUAL" && s.id === manual.id)).toBe(true);
      expect(slot.some((s) => s.origin === "PHOREST" && s.externalId !== null)).toBe(true);

      // A second sync must still never touch the MANUAL row (idempotent, no late adopt/cancel).
      mockPhorest(wttFixture);
      await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      const stillUntouched = await app.prisma.shift.findUnique({ where: { id: manual.id } });
      expect(stillUntouched?.origin).toBe("MANUAL");
      expect(stillUntouched?.deletedAt).toBeNull();
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });
});

// WR-01 regression: the slot-type filter is an ALLOW-LIST, not a NON_WORKING deny-list.
// extractWorkTimes is the ONLY filter point (it drops `type` before the sync sees the item), so a
// NOT_SPECIFIED / absent-type slot must NOT survive as a phantom working shift on the §615 roster.
describe("extractWorkTimes slot-type allow-list (WR-01)", () => {
  it("keeps ONLY WORKING slots; NON_WORKING, NOT_SPECIFIED, and untyped slots are dropped", () => {
    const data: PhorestApiResponse = {
      _embedded: {
        workTimeTables: [
          {
            staffId: "ph-staff-mapped",
            timeSlots: [
              { date: "2026-08-03", startTime: "08:00:00", endTime: "16:00:00", type: "WORKING" },
              {
                date: "2026-08-04",
                startTime: "00:00:00",
                endTime: "00:00:00",
                type: "NON_WORKING",
              },
              {
                date: "2026-08-05",
                startTime: "09:00:00",
                endTime: "17:00:00",
                type: "NOT_SPECIFIED",
              },
              // Slot with NO `type` at all — must also be treated as a non-working day, not a shift.
              { date: "2026-08-06", startTime: "10:00:00", endTime: "18:00:00" },
            ],
          },
        ],
      },
    };

    const items = extractWorkTimes(data);

    // ONLY the single WORKING slot survives.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      staffId: "ph-staff-mapped",
      date: "2026-08-03",
      startTime: "08:00:00",
      endTime: "16:00:00",
    });
  });
});
