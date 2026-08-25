// Phase 85 (SS-01/SS-03/SS-04/SS-06/SS-07) — fetch-mocked fixture tests for the shared Phorest shift sync.
// Mirrors apps/api/src/__tests__/school-holidays-client.test.ts for the fetch-mock harness.
// Run via `pnpm --filter @clokr/api test -- sync-shifts` (pretest db-push) — NOT bare vitest.

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp } from "../../../__tests__/setup";
import { syncPhorestShifts } from "../sync-shifts";
import { extractWorkTimes } from "../types";
import type { PhorestApiResponse } from "../types";
import {
  seedPhorestTenant,
  cleanupPhorestTenant,
  seedVocationalSchoolAbsence,
  seedPendingLeaveRequest,
  UNMAPPED_STAFF_ID,
} from "./helpers";
import staffFixture from "./fixtures/staff.json";
import wttFixture from "./fixtures/worktimetables.json";
import wttDeletedFixture from "./fixtures/worktimetables-deleted.json";
import wttPagedP1 from "./fixtures/worktimetables-paged-p1.json";
import wttPagedP2 from "./fixtures/worktimetables-paged-p2.json";
import wttTwoMapped from "./fixtures/worktimetables-two-mapped.json";

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
      expect(res.replaced).toBe(0); // D-11a: a fetch-error must delete ZERO shifts, not just cancel

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
      expect(res.replaced).toBe(0); // D-11a: an empty-200 SUSPECT run must delete ZERO shifts

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

  it("SS-03 MANUAL-safety: a MANUAL shift on a date the window does NOT cover is never touched", async () => {
    const seed = await seedPhorestTenant(app, "manual");
    try {
      // Phase 85.1 (D-11) note: this used to sit on 07-30 (a Phorest-covered day), where the new
      // D-11 replace pass now DOES soft-delete a same-day MANUAL shift by design (see the
      // "Phorest-master replace" describe block below). Moved to a date the fixture returns NO
      // slot for at all, to keep this test's original SS-04-only intent (windowed soft-cancel is
      // origin=PHOREST-scoped, so it structurally never touches a MANUAL row) uncontaminated by
      // the D-11 replace pass (which is scoped per Phorest-COVERED day only — Pitfall 2).
      const manual = await app.prisma.shift.create({
        data: {
          employeeId: seed.mappedEmployeeId,
          date: new Date("2026-08-15"),
          startTime: "12:00",
          endTime: "20:00",
          origin: "MANUAL",
          label: "Handeintrag",
        },
      });

      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");
      expect(res.replaced).toBe(0);

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

  it("CR-01 adopt-safety: a genuine MANUAL shift (non-'Phorest' label) at the exact fixture slot is NEVER reclassified to origin=PHOREST", async () => {
    const seed = await seedPhorestTenant(app, "manualslot");
    try {
      // A genuinely hand-entered MANUAL shift occupying the EXACT slot of the 07-30 mapped
      // fixture entry (08:00-16:00), but with a real label — NOT the legacy "Phorest" marker.
      // The sync must not reclassify it to origin=PHOREST via the adopt-on-match path (that path
      // is restricted to label="Phorest" rows only). Phase 85.1 (D-11) CHANGES what happens next,
      // though: on this Phorest-COVERED day, the D-11 replace pass now soft-deletes the surviving
      // duplicate (deletedReason PHOREST_REPLACED) — this is the intended double-planning fix, no
      // longer "left untouched" as the pre-85.1 comment described.
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
      expect(first.replaced).toBe(1);

      // The MANUAL shift was NEVER reclassified — origin stays MANUAL, externalId stays null,
      // right up to the soft-delete. It is now replaced, not adopted.
      const replaced = await app.prisma.shift.findUnique({ where: { id: manual.id } });
      expect(replaced?.origin).toBe("MANUAL");
      expect(replaced?.externalId).toBeNull();
      expect(replaced?.deletedReason).toBe("PHOREST_REPLACED");
      expect(replaced?.deletedAt).not.toBeNull();

      // Exactly ONE active row remains for the slot — the new PHOREST entry.
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

      // An audit DELETE row was written for the replace (Revisionssicherheit).
      const replaceAudits = await app.prisma.auditLog.count({
        where: { entity: "Shift", action: "DELETE", entityId: manual.id },
      });
      expect(replaceAudits).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });
});

// Phase 85.1 (D-08/D-11/D-11a/D-11b) — "Phorest ist Master": replace, no double-planning.
describe("phorest sync-shifts Phorest-master replace (85.1)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("D-11 replaces a wrong-time legacy label=Phorest row on a covered day (different externalId, not adopted)", async () => {
    const seed = await seedPhorestTenant(app, "wrongtime");
    try {
      // A legacy label="Phorest" row at a DIFFERENT slot than any current fixture entry for
      // 07-30 — the adopt-on-match occupant lookup (exact-time match) will NOT find it, so it
      // falls through to D-11's replace pass instead of being adopted.
      const wrongTime = await app.prisma.shift.create({
        data: {
          employeeId: seed.mappedEmployeeId,
          date: new Date("2026-07-30"),
          startTime: "06:00",
          endTime: "07:00",
          origin: "MANUAL",
          label: "Phorest",
        },
      });

      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");
      expect(res.replaced).toBe(1);

      const replaced = await app.prisma.shift.findUnique({ where: { id: wrongTime.id } });
      expect(replaced?.deletedReason).toBe("PHOREST_REPLACED");
      expect(replaced?.deletedAt).not.toBeNull();
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("D-11b: a MANUAL shift on a BS-skipped day survives untouched (BS wins)", async () => {
    const seed = await seedPhorestTenant(app, "bsreplace");
    try {
      await seedVocationalSchoolAbsence(app, seed.mappedEmployeeId, "2026-07-31");

      const manual = await app.prisma.shift.create({
        data: {
          employeeId: seed.mappedEmployeeId,
          date: new Date("2026-07-31"),
          startTime: "10:00",
          endTime: "18:00",
          origin: "MANUAL",
          label: "Handeintrag",
        },
      });

      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");
      expect(res.skippedVocationalSchool).toBe(1);
      expect(res.replaced).toBe(0); // 07-31 was skipped, never entered freshCoveredDays

      const stillActive = await app.prisma.shift.findUnique({ where: { id: manual.id } });
      expect(stillActive?.deletedAt).toBeNull();
      expect(stillActive?.origin).toBe("MANUAL");
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("D-11a GUARDRAIL fetch-error: replaced===0 alongside cancelled===0 (zero deletes on gate failure)", async () => {
    const seed = await seedPhorestTenant(app, "replaceerr");
    try {
      mockPhorest(wttFixture);
      await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);

      // A MANUAL shift on a day the first sync already covers — would be a replace candidate
      // IF the second run reached the replace pass.
      const manual = await app.prisma.shift.create({
        data: {
          employeeId: seed.mappedEmployeeId,
          date: new Date("2026-07-30"),
          startTime: "06:00",
          endTime: "07:00",
          origin: "MANUAL",
          label: "Handeintrag",
        },
      });

      mockPhorestWttStatus(503);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("ERROR");
      expect(res.replaced).toBe(0);

      const stillActive = await app.prisma.shift.findUnique({ where: { id: manual.id } });
      expect(stillActive?.deletedAt).toBeNull();
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });
});

// Phase 85.1 (D-01/D-02/D-03) — Vor-/Nachbereitungszeit padding.
describe("phorest sync-shifts padding (85.1)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("D-03 key-stability: a 0→15 puffer change pads stored times, keeps externalId raw, cancelled===0", async () => {
    const seed = await seedPhorestTenant(app, "puffer");
    try {
      mockPhorest(wttFixture);
      const first = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(first.status).toBe("SUCCESS");
      expect(first.created).toBe(2);

      const jul31 = new Date("2026-07-31");
      const beforePadding = await app.prisma.shift.findFirst({
        where: { employeeId: seed.mappedEmployeeId, date: jul31, deletedAt: null },
      });
      expect(beforePadding?.startTime).toBe("09:00");
      expect(beforePadding?.endTime).toBe("17:00");
      const rawExternalId = beforePadding?.externalId;
      expect(rawExternalId).toBe("ph-staff-mapped|2026-07-31|09:00:00|17:00:00");

      // Turn on a 15/15 puffer and re-sync against the IDENTICAL fixture.
      await app.prisma.tenantConfig.update({
        where: { tenantId: seed.tenantId },
        data: { phorestPrepMinutes: 15, phorestWrapupMinutes: 15 },
      });
      mockPhorest(wttFixture);
      const second = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(second.status).toBe("SUCCESS");
      expect(second.cancelled).toBe(0); // D-03: NO mass cancel/recreate from the puffer change
      expect(second.replaced).toBe(0); // a puffer change must NOT trip the D-11 replace pass
      expect(second.updated).toBeGreaterThan(0); // self-heals via the upsert update-branch

      const afterPadding = await app.prisma.shift.findFirst({
        where: { employeeId: seed.mappedEmployeeId, date: jul31, deletedAt: null },
      });
      expect(afterPadding?.startTime).toBe("08:45");
      expect(afterPadding?.endTime).toBe("17:15");
      // externalId is UNCHANGED — still the raw-time key, proving key-stability across the puffer
      // change (this IS the same row, updated in place, not cancelled+recreated).
      expect(afterPadding?.id).toBe(beforePadding?.id);
      expect(afterPadding?.externalId).toBe(rawExternalId);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("D-11 adopt-under-padding: a raw-time legacy label=Phorest row is UPDATEd in place with padded stored times, not replaced", async () => {
    const seed = await seedPhorestTenant(app, "adoptpad");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: seed.tenantId },
        data: { phorestPrepMinutes: 15, phorestWrapupMinutes: 15 },
      });

      // Pre-existing (pre-migration) label="Phorest" origin=MANUAL row at the RAW (unpadded)
      // 07-30 fixture slot (08:00-16:00) — legacy rows are always stored on raw times.
      const legacy = await app.prisma.shift.create({
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

      // Same id, adopted in place, origin flipped, stored times now padded.
      const adopted = await app.prisma.shift.findUnique({ where: { id: legacy.id } });
      expect(adopted?.origin).toBe("PHOREST");
      expect(adopted?.startTime).toBe("07:45");
      expect(adopted?.endTime).toBe("16:15");
      expect(adopted?.externalId).toBe("ph-staff-mapped|2026-07-30|08:00:00|16:00:00");
      expect(adopted?.deletedAt).toBeNull();

      // Not double-counted as a replace (Task 3 introduces `replaced`, asserted here for D-11's
      // adopt-on-match carve-out: an adopted row must never ALSO show up in the replace pass).
      const activeOnSlotDate = await app.prisma.shift.count({
        where: { employeeId: seed.mappedEmployeeId, date: new Date("2026-07-30"), deletedAt: null },
      });
      expect(activeOnSlotDate).toBe(1); // exactly the adopted row — no duplicate PHOREST insert
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });
});

// Phase 85.1.1 (D-02/D-05) — per-employee Phorest puffer override wins over the tenant default.
describe("phorest sync-shifts per-employee puffer override (85.1.1)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("D-02/D-05 override=0 beats a non-zero tenant default: stored times are UNPADDED (raw)", async () => {
    const seed = await seedPhorestTenant(app, "ovr0");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: seed.tenantId },
        data: { phorestPrepMinutes: 15, phorestWrapupMinutes: 15 },
      });
      await app.prisma.employee.update({
        where: { id: seed.mappedEmployeeId },
        data: { phorestPrepMinutesOverride: 0, phorestWrapupMinutesOverride: 0 },
      });

      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");

      const jul31 = new Date("2026-07-31");
      const stored = await app.prisma.shift.findFirst({
        where: { employeeId: seed.mappedEmployeeId, date: jul31, deletedAt: null },
      });
      // Raw fixture slot is 09:00-17:00 — the explicit 0/0 override must win over the 15/15
      // tenant default (?? not ||), so the stored roster equals the bookable hours exactly.
      expect(stored?.startTime).toBe("09:00");
      expect(stored?.endTime).toBe("17:00");
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("D-02 null override inherits the tenant default: stored times are padded (existing behaviour)", async () => {
    const seed = await seedPhorestTenant(app, "ovrnull");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: seed.tenantId },
        data: { phorestPrepMinutes: 15, phorestWrapupMinutes: 15 },
      });
      // No override set for the mapped employee — must inherit the tenant default.

      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");

      const jul31 = new Date("2026-07-31");
      const stored = await app.prisma.shift.findFirst({
        where: { employeeId: seed.mappedEmployeeId, date: jul31, deletedAt: null },
      });
      expect(stored?.startTime).toBe("08:45");
      expect(stored?.endTime).toBe("17:15");
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("D-02/D-05 two mapped employees resolve independently in the SAME sync run", async () => {
    const seed = await seedPhorestTenant(app, "ovrtwo");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: seed.tenantId },
        data: { phorestPrepMinutes: 15, phorestWrapupMinutes: 15 },
      });
      // Employee A gets an explicit zero override; employee B keeps the null/inherit default.
      await app.prisma.employee.update({
        where: { id: seed.mappedEmployeeId },
        data: { phorestPrepMinutesOverride: 0, phorestWrapupMinutesOverride: 0 },
      });

      mockPhorest(wttTwoMapped);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");
      expect(res.created).toBe(2);

      const jul30 = new Date("2026-07-30");
      const shiftA = await app.prisma.shift.findFirst({
        where: { employeeId: seed.mappedEmployeeId, date: jul30, deletedAt: null },
      });
      const shiftB = await app.prisma.shift.findFirst({
        where: { employeeId: seed.mappedEmployeeId2, date: jul30, deletedAt: null },
      });
      // Both fixture slots are raw 09:00-17:00. A (override=0) stays unpadded; B (null → tenant
      // default 15/15) is padded — proving independent per-employee resolution in one run.
      expect(shiftA?.startTime).toBe("09:00");
      expect(shiftA?.endTime).toBe("17:00");
      expect(shiftB?.startTime).toBe("08:45");
      expect(shiftB?.endTime).toBe("17:15");
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("D-02/D-05 key-stability: an override change re-pads stored times but never churns externalId (cancelled===0, replaced===0)", async () => {
    const seed = await seedPhorestTenant(app, "ovrkey");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: seed.tenantId },
        data: { phorestPrepMinutes: 15, phorestWrapupMinutes: 15 },
      });

      // Initial sync: no override → tenant-default-padded stored times.
      mockPhorest(wttFixture);
      const first = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(first.status).toBe("SUCCESS");

      const jul31 = new Date("2026-07-31");
      const beforeOverride = await app.prisma.shift.findFirst({
        where: { employeeId: seed.mappedEmployeeId, date: jul31, deletedAt: null },
      });
      expect(beforeOverride?.startTime).toBe("08:45");
      expect(beforeOverride?.endTime).toBe("17:15");
      const rawExternalId = beforeOverride?.externalId;
      expect(rawExternalId).toBe("ph-staff-mapped|2026-07-31|09:00:00|17:00:00");

      // Set an explicit 0/0 override and re-sync against the IDENTICAL fixture.
      await app.prisma.employee.update({
        where: { id: seed.mappedEmployeeId },
        data: { phorestPrepMinutesOverride: 0, phorestWrapupMinutesOverride: 0 },
      });
      mockPhorest(wttFixture);
      const second = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(second.status).toBe("SUCCESS");
      expect(second.cancelled).toBe(0);
      expect(second.replaced).toBe(0);

      const afterOverride = await app.prisma.shift.findFirst({
        where: { employeeId: seed.mappedEmployeeId, date: jul31, deletedAt: null },
      });
      expect(afterOverride?.startTime).toBe("09:00");
      expect(afterOverride?.endTime).toBe("17:00");
      // Same row, same raw-time externalId — no cancel/replace churn from the override change.
      expect(afterOverride?.id).toBe(beforeOverride?.id);
      expect(afterOverride?.externalId).toBe(rawExternalId);

      // Clear the override again — self-heals back to the tenant-default padding, still no churn.
      await app.prisma.employee.update({
        where: { id: seed.mappedEmployeeId },
        data: { phorestPrepMinutesOverride: null, phorestWrapupMinutesOverride: null },
      });
      mockPhorest(wttFixture);
      const third = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(third.status).toBe("SUCCESS");
      expect(third.cancelled).toBe(0);
      expect(third.replaced).toBe(0);

      const afterClear = await app.prisma.shift.findFirst({
        where: { employeeId: seed.mappedEmployeeId, date: jul31, deletedAt: null },
      });
      expect(afterClear?.startTime).toBe("08:45");
      expect(afterClear?.endTime).toBe("17:15");
      expect(afterClear?.id).toBe(beforeOverride?.id);
      expect(afterClear?.externalId).toBe(rawExternalId);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });
});

// Phase 85.1 (D-06/D-07/D-09) — "BS gewinnt": VOCATIONAL_SCHOOL wins over a Phorest shift.
describe("phorest sync-shifts BS-gewinnt skip (85.1)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("D-06 BS-skip: a VOCATIONAL_SCHOOL day is not created/adopted, counted, and audited", async () => {
    const seed = await seedPhorestTenant(app, "bsskip");
    try {
      // 07-31 is a BS day for the mapped employee — the fixture's 09:00-17:00 slot must be skipped.
      await seedVocationalSchoolAbsence(app, seed.mappedEmployeeId, "2026-07-31");

      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");
      expect(res.skippedVocationalSchool).toBe(1);
      expect(res.created).toBe(1); // only the 07-30 slot is created; 07-31 is skipped

      const jul31Active = await app.prisma.shift.count({
        where: { employeeId: seed.mappedEmployeeId, date: new Date("2026-07-31"), deletedAt: null },
      });
      expect(jul31Active).toBe(0);

      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "Shift", action: "UPDATE", entityId: null },
      });
      expect(
        audits.some(
          (a) =>
            a.newValue &&
            (a.newValue as Record<string, unknown>).skipped === "VOCATIONAL_SCHOOL" &&
            (a.newValue as Record<string, unknown>).employeeId === seed.mappedEmployeeId,
        ),
      ).toBe(true);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("D-06 Ferien: no BS absence seeded → the Phorest shift applies normally", async () => {
    const seed = await seedPhorestTenant(app, "ferien");
    try {
      // No VOCATIONAL_SCHOOL absence seeded — Ferien-aware generator produces none during holidays.
      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");
      expect(res.skippedVocationalSchool).toBe(0);
      expect(res.created).toBe(2); // both fixture slots apply
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("D-07 BS-skip protects pre-existing shift from false soft-cancel", async () => {
    const seed = await seedPhorestTenant(app, "bsprotect");
    try {
      // Pre-existing active PHOREST shift on 07-31, seeded directly (simulates a prior sync).
      const preExisting = await app.prisma.shift.create({
        data: {
          employeeId: seed.mappedEmployeeId,
          date: new Date("2026-07-31"),
          startTime: "09:00",
          endTime: "17:00",
          origin: "PHOREST",
          externalId: `bs-protect-${seed.tenantId}`,
          label: "Phorest",
        },
      });

      // The day BECOMES a BS day this run.
      await seedVocationalSchoolAbsence(app, seed.mappedEmployeeId, "2026-07-31");

      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");
      expect(res.skippedVocationalSchool).toBe(1);
      expect(res.cancelled).toBe(0); // NOT false-soft-cancelled

      const stillActive = await app.prisma.shift.findUnique({ where: { id: preExisting.id } });
      expect(stillActive?.deletedAt).toBeNull();
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });
});

// Phase 95 (SHIFT-02) — a Phorest-covered shift on a day where the employee has an active,
// not-yet-APPROVED leave request must NOT be soft-cancelled by the PHOREST_REMOVED reconcile.
// Mirrors the D-07 BS-skip protection precisely, but the protected day comes from a LeaveRequest
// DATE RANGE (expanded per-day), and Phorest DROPPED the slot (the day is never in wttFixture).
describe("SHIFT-02 pending-leave protection", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // Seed an active PHOREST shift on a day that wttFixture does NOT cover (08-xx), so on the next
  // sync its externalId is absent from the fresh set → it WOULD be a stale soft-cancel candidate.
  async function seedVanishedPhorestShift(employeeId: string, dateStr: string, tag: string) {
    return app.prisma.shift.create({
      data: {
        employeeId,
        date: new Date(dateStr),
        startTime: "09:00",
        endTime: "17:00",
        origin: "PHOREST",
        externalId: `pending-protect-${tag}-${dateStr}`,
        label: "Phorest",
      },
    });
  }

  it("PENDING leave protects a Phorest-vanished shift from soft-cancel", async () => {
    const seed = await seedPhorestTenant(app, "pl-pending");
    try {
      const preExisting = await seedVanishedPhorestShift(
        seed.mappedEmployeeId,
        "2026-08-15",
        seed.tenantId,
      );
      await seedPendingLeaveRequest(
        app,
        seed.mappedEmployeeId,
        "2026-08-15",
        "2026-08-15",
        "PENDING",
      );

      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");
      expect(res.cancelled).toBe(0); // NOT soft-cancelled — pending leave protects the day
      expect(res.protectedPendingLeave).toBe(1);

      const stillActive = await app.prisma.shift.findUnique({ where: { id: preExisting.id } });
      expect(stillActive?.deletedAt).toBeNull();

      // Revisionssicherheit: the protected skip is audited (no silent skip), no hard delete.
      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "Shift", action: "UPDATE", entityId: null },
      });
      expect(
        audits.some(
          (a) =>
            a.newValue &&
            (a.newValue as Record<string, unknown>).skipped === "PENDING_LEAVE" &&
            (a.newValue as Record<string, unknown>).employeeId === seed.mappedEmployeeId,
        ),
      ).toBe(true);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("CANCELLATION_REQUESTED leave protects the shift the same way", async () => {
    const seed = await seedPhorestTenant(app, "pl-cancreq");
    try {
      const preExisting = await seedVanishedPhorestShift(
        seed.mappedEmployeeId,
        "2026-08-15",
        seed.tenantId,
      );
      await seedPendingLeaveRequest(
        app,
        seed.mappedEmployeeId,
        "2026-08-15",
        "2026-08-15",
        "CANCELLATION_REQUESTED",
      );

      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");
      expect(res.cancelled).toBe(0);
      expect(res.protectedPendingLeave).toBe(1);

      const stillActive = await app.prisma.shift.findUnique({ where: { id: preExisting.id } });
      expect(stillActive?.deletedAt).toBeNull();
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("APPROVED leave does NOT protect — the vanished shift IS soft-cancelled", async () => {
    const seed = await seedPhorestTenant(app, "pl-approved");
    try {
      const preExisting = await seedVanishedPhorestShift(
        seed.mappedEmployeeId,
        "2026-08-15",
        seed.tenantId,
      );
      await seedPendingLeaveRequest(
        app,
        seed.mappedEmployeeId,
        "2026-08-15",
        "2026-08-15",
        "APPROVED",
      );

      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");
      expect(res.cancelled).toBe(1); // APPROVED → normal removal
      expect(res.protectedPendingLeave).toBe(0);

      const removed = await app.prisma.shift.findUnique({ where: { id: preExisting.id } });
      expect(removed?.deletedAt).not.toBeNull();
      expect(removed?.deletedReason).toBe("PHOREST_REMOVED");
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  // LO-04: the pendingLeaves query is guarded by `deletedAt: null` (source comment T-95-02).
  // A soft-deleted PENDING leave must NOT protect the shift — it is soft-cancelled normally.
  it("soft-deleted PENDING leave does NOT protect — the vanished shift IS soft-cancelled", async () => {
    const seed = await seedPhorestTenant(app, "pl-softdel");
    try {
      const preExisting = await seedVanishedPhorestShift(
        seed.mappedEmployeeId,
        "2026-08-15",
        seed.tenantId,
      );
      // Seed a PENDING leave that is soft-deleted (deletedAt set, NOT null) → must be ignored.
      await seedPendingLeaveRequest(
        app,
        seed.mappedEmployeeId,
        "2026-08-15",
        "2026-08-15",
        "PENDING",
        new Date("2026-08-01T00:00:00Z"),
      );

      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");
      expect(res.cancelled).toBe(1); // soft-deleted leave → no protection → normal removal
      expect(res.protectedPendingLeave).toBe(0);

      const removed = await app.prisma.shift.findUnique({ where: { id: preExisting.id } });
      expect(removed?.deletedAt).not.toBeNull();
      expect(removed?.deletedReason).toBe("PHOREST_REMOVED");
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("multi-day PENDING leave protects every in-window day in its range", async () => {
    const seed = await seedPhorestTenant(app, "pl-range");
    try {
      const days = ["2026-08-17", "2026-08-18", "2026-08-19"];
      const preExisting = [];
      for (const d of days) {
        preExisting.push(await seedVanishedPhorestShift(seed.mappedEmployeeId, d, seed.tenantId));
      }
      // One leave request spanning Mon–Wed.
      await seedPendingLeaveRequest(
        app,
        seed.mappedEmployeeId,
        "2026-08-17",
        "2026-08-19",
        "PENDING",
      );

      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");
      expect(res.cancelled).toBe(0); // every day in the range is protected
      expect(res.protectedPendingLeave).toBe(3);

      for (const s of preExisting) {
        const still = await app.prisma.shift.findUnique({ where: { id: s.id } });
        expect(still?.deletedAt).toBeNull();
      }
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("two overlapping leaves on one day (APPROVED + PENDING) — PENDING still protects", async () => {
    const seed = await seedPhorestTenant(app, "pl-overlap");
    try {
      const preExisting = await seedVanishedPhorestShift(
        seed.mappedEmployeeId,
        "2026-08-22",
        seed.tenantId,
      );
      // Both an APPROVED and a PENDING leave land on the same day (rare, via corrections).
      await seedPendingLeaveRequest(
        app,
        seed.mappedEmployeeId,
        "2026-08-22",
        "2026-08-22",
        "APPROVED",
      );
      await seedPendingLeaveRequest(
        app,
        seed.mappedEmployeeId,
        "2026-08-22",
        "2026-08-22",
        "PENDING",
      );

      mockPhorest(wttFixture);
      const res = await syncPhorestShifts(app, seed.tenantId, WIDE_WINDOW);
      expect(res.status).toBe("SUCCESS");
      expect(res.cancelled).toBe(0); // ONE protecting status (PENDING) is enough
      expect(res.protectedPendingLeave).toBe(1);

      const stillActive = await app.prisma.shift.findUnique({ where: { id: preExisting.id } });
      expect(stillActive?.deletedAt).toBeNull();
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
