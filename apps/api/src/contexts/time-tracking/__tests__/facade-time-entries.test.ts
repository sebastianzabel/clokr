/**
 * Phase 100B Plan 08 (Wave 4) — focused integration test for the Zeiterfassung `TimeEntry`/
 * `Break` facade (T1-T12, plus the T2 regrouping).
 *
 * Two non-vacuousness proofs are the point of this file (100B-08-PLAN.md Task 1):
 *
 * 1. The T1/T2/regrouped-T2 membership test below was seen RED by temporarily adding
 *    `isInvalid: false` to `getWorkedEntriesInRange`'s `where` (collapsing it onto T1) — the
 *    "invalidEntry" row then disappeared from its expected result and the test failed. Reverted
 *    immediately after confirming red; see 100B-08-SUMMARY.md for the captured transcript.
 * 2. The hard-delete rollback test was seen RED under a `hardDeleteTimeDataForEmployee` whose
 *    first parameter was temporarily typed `app: FastifyInstance` reaching for `app.prisma`
 *    internally — both rows survived the forced rollback in that version, exactly R1's hazard.
 *    Reverted immediately after confirming red; see 100B-08-SUMMARY.md for the transcript.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import {
  getValidWorkedEntriesInRange,
  getWorkedEntriesInRange,
  getRecordedWorkEntriesInRange,
  getRecordedWorkEntriesByIds,
  employeesWithValidWorkSince,
  getClaimedEntryDatesInRange,
  countLockedEntries,
  getInvalidEntries,
  getEntryActivityFeed,
  revalidateLeaveCancellationEntries,
  lockEntriesForMonth,
  unlockEntriesForMonth,
  archiveEntriesBefore,
  clearEntryNotesForEmployee,
  hardDeleteTimeDataForEmployee,
  createImportedTimeEntry,
} from "../index";
import { invalidReasonFields } from "../invalid-reason"; // Issue #370 — intra-context import
import type { FastifyInstance } from "fastify";

describe("Zeiterfassung facade — TimeEntry/Break (Phase 100B Plan 08)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let otherTenantData: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "te-facade");
    otherTenantData = await seedTestData(app, "te-facade-other");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, otherTenantData.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("T1 vs T2 vs the regrouped T2 — the exact membership difference", () => {
    const d1 = new Date("2026-02-02T00:00:00Z"); // valid, closed WORK
    const d2 = new Date("2026-02-03T00:00:00Z"); // isInvalid:true, closed WORK
    const d3 = new Date("2026-02-04T00:00:00Z"); // open (endTime:null) WORK
    const d4 = new Date("2026-02-05T00:00:00Z"); // soft-deleted, closed WORK
    const d5 = new Date("2026-02-06T00:00:00Z"); // non-WORK (OVERTIME), closed

    beforeAll(async () => {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: d1,
          startTime: new Date("2026-02-02T08:00:00Z"),
          endTime: new Date("2026-02-02T16:00:00Z"),
          type: "WORK",
          isInvalid: false,
          salonId: data.salonId, // Phase 68b (issue #68)
        },
      });
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: d2,
          startTime: new Date("2026-02-03T08:00:00Z"),
          endTime: new Date("2026-02-03T16:00:00Z"),
          type: "WORK",
          isInvalid: true,
          salonId: data.salonId, // Phase 68b (issue #68)
        },
      });
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: d3,
          startTime: new Date("2026-02-04T08:00:00Z"),
          endTime: null,
          type: "WORK",
          isInvalid: false,
          salonId: data.salonId, // Phase 68b (issue #68)
        },
      });
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: d4,
          startTime: new Date("2026-02-05T08:00:00Z"),
          endTime: new Date("2026-02-05T16:00:00Z"),
          type: "WORK",
          isInvalid: false,
          deletedAt: new Date(),
          salonId: data.salonId, // Phase 68b (issue #68)
        },
      });
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: d5,
          startTime: new Date("2026-02-06T08:00:00Z"),
          endTime: new Date("2026-02-06T16:00:00Z"),
          type: "OVERTIME",
          isInvalid: false,
          salonId: data.salonId, // Phase 68b (issue #68)
        },
      });
    });

    it("T1 getValidWorkedEntriesInRange returns ONLY the valid, closed, WORK, non-deleted row", async () => {
      const rows = await getValidWorkedEntriesInRange(
        app.prisma,
        { kind: "employee", employeeId: data.employee.id, tenantId: data.tenant.id },
        d1,
        d5,
      );
      expect(rows.map((r) => r.date.toISOString().slice(0, 10)).sort()).toEqual(["2026-02-02"]);
      // Phase 79 (issue #79), D-13: every T1 row carries its entry id.
      const validEntry = await app.prisma.timeEntry.findFirstOrThrow({
        where: { employeeId: data.employee.id, date: d1 },
        select: { id: true },
      });
      expect(rows.map((r) => r.id)).toEqual([validEntry.id]);
      // Issue #81 (D-12): the saldo input never carries the activity dimension.
      // Issue #696: `employeeId` is additive, so a bulk read over several persons can be split.
      expect(Object.keys(rows[0]).sort()).toEqual([
        "breakMinutes",
        "date",
        "employeeId",
        "endTime",
        "id",
        "startTime",
      ]);
    });

    it("T2 getWorkedEntriesInRange returns the valid AND invalid closed rows, never the open/deleted/non-WORK ones", async () => {
      const rows = await getWorkedEntriesInRange(
        app.prisma,
        { kind: "employee", employeeId: data.employee.id, tenantId: data.tenant.id },
        d1,
        d5,
      );
      expect(rows.map((r) => r.date.toISOString().slice(0, 10)).sort()).toEqual([
        "2026-02-02",
        "2026-02-03",
      ]);
    });

    it("getRecordedWorkEntriesInRange ALSO includes the open (unclosed) WORK row, still excludes deleted/non-WORK", async () => {
      const rows = await getRecordedWorkEntriesInRange(
        app.prisma,
        { kind: "employee", employeeId: data.employee.id, tenantId: data.tenant.id },
        d1,
        d5,
      );
      expect(rows.map((r) => r.date.toISOString().slice(0, 10)).sort()).toEqual([
        "2026-02-02",
        "2026-02-03",
        "2026-02-04",
      ]);
      // Issue #84 (D-15): the recorded read carries the entry's salon, additively.
      expect(Object.keys(rows[0]).sort((a, b) => a.localeCompare(b))).toEqual([
        "breakMinutes",
        "date",
        "employeeId",
        "endTime",
        "isInvalid",
        "salonId",
        "startTime",
      ]);
    });

    it("getClaimedEntryDatesInRange ALSO includes the non-WORK (OVERTIME) row, still excludes the soft-deleted one", async () => {
      const set = await getClaimedEntryDatesInRange(
        app.prisma,
        [data.employee.id],
        data.tenant.id,
        d1,
        d5,
      );
      const dates = [...set].map((k) => k.split("::")[1]).sort();
      expect(dates).toEqual(["2026-02-02", "2026-02-03", "2026-02-04", "2026-02-06"]);
    });

    // `EmployeeScope`'s "employee"/"employees" variants constrain by employeeId ONLY — matching
    // `getShiftsInRange` (S1)'s own precedent and its own docblock's reasoning: a single
    // employeeId already denotes exactly one employee in exactly one tenant, so the CALLER's own
    // upstream tenant validation (fetch-then-compare against req.user.tenantId) is what carries
    // the boundary, not a second employee:{tenantId} join repeated inside every read here. The
    // "tenant" scope variant is the one that DOES add a real employee:{tenantId} constraint —
    // proven below against dashboard.ts's own bulk/team-wide call shape.
    it("the 'tenant' scope variant constrains to the given tenantId — the WRONG tenant sees nothing", async () => {
      const rows = await getWorkedEntriesInRange(
        app.prisma,
        { kind: "tenant", tenantId: otherTenantData.tenant.id },
        d1,
        d5,
      );
      expect(rows.some((r) => r.employeeId === data.employee.id)).toBe(false);

      const ownTenantRows = await getWorkedEntriesInRange(
        app.prisma,
        { kind: "tenant", tenantId: data.tenant.id },
        d1,
        d5,
      );
      expect(ownTenantRows.some((r) => r.employeeId === data.employee.id)).toBe(true);
    });
  });

  describe("T6 revalidateLeaveCancellationEntries — H2 negative assertions", () => {
    const from = new Date("2026-03-02T00:00:00Z");
    const to = new Date("2026-03-06T00:00:00Z");

    it("clears isInvalid on a LEAVE_CANCELLATION_PENDING entry", async () => {
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-03-02T00:00:00Z"),
          startTime: new Date("2026-03-02T08:00:00Z"),
          endTime: new Date("2026-03-02T16:00:00Z"),
          type: "WORK",
          isInvalid: true,
          invalidReasonCode: "LEAVE_CANCELLATION_PENDING",
          invalidReason: "Urlaubsstornierung ausstehend",
          salonId: data.salonId, // Phase 68b (issue #68)
        },
      });
      await revalidateLeaveCancellationEntries(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        from,
        to,
      );
      const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(after.isInvalid).toBe(false);
      expect(after.invalidReasonCode).toBeNull();
    });

    it("H2: never touches a LOCKED entry, even if it matches every other filter", async () => {
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-03-03T00:00:00Z"),
          startTime: new Date("2026-03-03T08:00:00Z"),
          endTime: new Date("2026-03-03T16:00:00Z"),
          type: "WORK",
          isInvalid: true,
          invalidReasonCode: "LEAVE_CANCELLATION_PENDING",
          invalidReason: "Urlaubsstornierung ausstehend",
          isLocked: true,
          salonId: data.salonId, // Phase 68b (issue #68)
        },
      });
      await revalidateLeaveCancellationEntries(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        from,
        to,
      );
      const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(
        after.isInvalid,
        "a locked entry must never be revalidated (Revisionssicherheit)",
      ).toBe(true);
    });

    it("H2: never touches a SOFT-DELETED entry", async () => {
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-03-04T00:00:00Z"),
          startTime: new Date("2026-03-04T08:00:00Z"),
          endTime: new Date("2026-03-04T16:00:00Z"),
          type: "WORK",
          isInvalid: true,
          invalidReasonCode: "LEAVE_CANCELLATION_PENDING",
          invalidReason: "Urlaubsstornierung ausstehend",
          deletedAt: new Date(),
          salonId: data.salonId, // Phase 68b (issue #68)
        },
      });
      await revalidateLeaveCancellationEntries(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        from,
        to,
      );
      const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(after.isInvalid).toBe(true);
    });

    it("returns one {id, oldValue, newValue} per revalidated row; locked, soft-deleted and other-reason rows are neither changed nor returned (Issue #370)", async () => {
      const decFrom = new Date("2026-12-01T00:00:00Z");
      const decTo = new Date("2026-12-04T00:00:00Z");
      const mkDecEntry = (day: string, extra: Record<string, unknown>) =>
        app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date(`${day}T00:00:00Z`),
            startTime: new Date(`${day}T08:00:00Z`),
            endTime: new Date(`${day}T16:00:00Z`),
            type: "WORK",
            salonId: data.salonId, // Phase 68b (issue #68)
            ...extra,
          },
        });
      const rowA = await mkDecEntry("2026-12-01", {
        isInvalid: true,
        ...invalidReasonFields("LEAVE_CANCELLATION_PENDING"),
      });
      const rowB = await mkDecEntry("2026-12-02", {
        isInvalid: true,
        ...invalidReasonFields("LEAVE_CANCELLATION_PENDING"),
        isLocked: true,
      });
      const rowC = await mkDecEntry("2026-12-03", {
        isInvalid: true,
        ...invalidReasonFields("LEAVE_CANCELLATION_PENDING"),
        deletedAt: new Date(),
      });
      const rowD = await mkDecEntry("2026-12-04", {
        isInvalid: true,
        ...invalidReasonFields("MISSING_CLOCK_OUT"),
      });

      const result = await revalidateLeaveCancellationEntries(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        decFrom,
        decTo,
      );
      expect(result).toEqual([
        {
          id: rowA.id,
          oldValue: { isInvalid: true, invalidReasonCode: "LEAVE_CANCELLATION_PENDING" },
          newValue: { isInvalid: false, invalidReasonCode: null },
        },
      ]);

      const bAfter = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: rowB.id } });
      const cAfter = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: rowC.id } });
      const dAfter = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: rowD.id } });
      expect(bAfter.isInvalid).toBe(true);
      expect(cAfter.isInvalid).toBe(true);
      expect(dAfter.isInvalid).toBe(true);

      const empty = await revalidateLeaveCancellationEntries(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        decTo,
        decFrom, // from > to
      );
      expect(empty).toEqual([]);
    });
  });

  describe("T7/T8 lockEntriesForMonth / unlockEntriesForMonth — inverse over the same window", () => {
    it("locks then unlocks the same day-bound window", async () => {
      const from = new Date("2026-04-01T00:00:00Z");
      const to = new Date("2026-04-30T00:00:00Z");
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-04-15T00:00:00Z"),
          startTime: new Date("2026-04-15T08:00:00Z"),
          endTime: new Date("2026-04-15T16:00:00Z"),
          type: "WORK",
          salonId: data.salonId, // Phase 68b (issue #68)
        },
      });

      await lockEntriesForMonth(app.prisma, data.employee.id, data.tenant.id, from, to);
      const locked = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(locked.isLocked).toBe(true);
      expect(locked.lockedAt).not.toBeNull();

      await unlockEntriesForMonth(app.prisma, data.employee.id, data.tenant.id, from, to);
      const unlocked = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(unlocked.isLocked).toBe(false);
      expect(unlocked.lockedAt).toBeNull();
    });

    it("T8 unlockEntriesForMonth returns one {id, oldValue, newValue} per unlocked row (Issue #370)", async () => {
      const from = new Date("2026-10-01T00:00:00Z");
      const to = new Date("2026-10-31T00:00:00Z");
      const l1 = new Date("2026-09-01T10:00:00Z");
      const l2 = new Date("2026-09-02T11:00:00Z");

      const rowA = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-10-05T00:00:00Z"),
          startTime: new Date("2026-10-05T08:00:00Z"),
          endTime: new Date("2026-10-05T16:00:00Z"),
          type: "WORK",
          salonId: data.salonId, // Phase 68b (issue #68)
          isLocked: true,
          lockedAt: l1,
        },
      });
      const rowB = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-10-12T00:00:00Z"),
          startTime: new Date("2026-10-12T08:00:00Z"),
          endTime: new Date("2026-10-12T16:00:00Z"),
          type: "WORK",
          salonId: data.salonId, // Phase 68b (issue #68)
          isLocked: true,
          lockedAt: l2,
        },
      });
      const rowC = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-10-19T00:00:00Z"),
          startTime: new Date("2026-10-19T08:00:00Z"),
          endTime: new Date("2026-10-19T16:00:00Z"),
          type: "WORK",
          salonId: data.salonId, // Phase 68b (issue #68)
          isLocked: true,
          lockedAt: new Date("2026-09-03T12:00:00Z"),
          deletedAt: new Date("2026-09-04T00:00:00Z"),
        },
      });

      const result = await unlockEntriesForMonth(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        from,
        to,
      );
      const sorted = [...result].sort((a, b) => a.id.localeCompare(b.id));
      const expected = [
        {
          id: rowA.id,
          oldValue: { isLocked: true, lockedAt: l1 },
          newValue: { isLocked: false, lockedAt: null },
        },
        {
          id: rowB.id,
          oldValue: { isLocked: true, lockedAt: l2 },
          newValue: { isLocked: false, lockedAt: null },
        },
      ].sort((a, b) => a.id.localeCompare(b.id));
      expect(sorted).toEqual(expected);
      expect(result.some((r) => r.id === rowC.id)).toBe(false);

      const empty = await unlockEntriesForMonth(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        new Date("2030-01-01T00:00:00Z"),
        new Date("2030-01-31T00:00:00Z"),
      );
      expect(empty).toEqual([]);
    });

    it("T7 lockEntriesForMonth returns one {id, oldValue, newValue} per locked row with one batch timestamp (Issue #370)", async () => {
      const from = new Date("2026-11-01T00:00:00Z");
      const to = new Date("2026-11-30T00:00:00Z");
      const l = new Date("2026-10-01T10:00:00Z");

      const rowA = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-11-05T00:00:00Z"),
          startTime: new Date("2026-11-05T08:00:00Z"),
          endTime: new Date("2026-11-05T16:00:00Z"),
          type: "WORK",
          salonId: data.salonId, // Phase 68b (issue #68)
          isLocked: false,
          lockedAt: null,
        },
      });
      const rowB = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-11-12T00:00:00Z"),
          startTime: new Date("2026-11-12T08:00:00Z"),
          endTime: new Date("2026-11-12T16:00:00Z"),
          type: "WORK",
          salonId: data.salonId, // Phase 68b (issue #68)
          isLocked: true,
          lockedAt: l,
        },
      });
      const rowC = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-11-19T00:00:00Z"),
          startTime: new Date("2026-11-19T08:00:00Z"),
          endTime: new Date("2026-11-19T16:00:00Z"),
          type: "WORK",
          salonId: data.salonId, // Phase 68b (issue #68)
          isLocked: false,
          lockedAt: null,
          deletedAt: new Date("2026-10-02T00:00:00Z"),
        },
      });

      const result = await lockEntriesForMonth(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        from,
        to,
      );
      expect(result.length).toBe(2);
      const resultIds = result.map((r) => r.id).sort();
      expect(resultIds).toEqual([rowA.id, rowB.id].sort());
      expect(result.some((r) => r.id === rowC.id)).toBe(false);

      const resultA = result.find((r) => r.id === rowA.id)!;
      const resultB = result.find((r) => r.id === rowB.id)!;
      expect(resultA.oldValue).toEqual({ isLocked: false, lockedAt: null });
      expect(resultB.oldValue).toEqual({ isLocked: true, lockedAt: l });
      expect(resultA.newValue.isLocked).toBe(true);
      expect(resultB.newValue.isLocked).toBe(true);
      expect(resultA.newValue.lockedAt?.getTime()).toBe(resultB.newValue.lockedAt?.getTime());

      const reloadedA = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: rowA.id } });
      expect(resultA.newValue.lockedAt?.getTime()).toBe(reloadedA.lockedAt?.getTime());

      const empty = await lockEntriesForMonth(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        new Date("2030-02-01T00:00:00Z"),
        new Date("2030-02-28T00:00:00Z"),
      );
      expect(empty).toEqual([]);
    });
  });

  describe("T3 countLockedEntries", () => {
    it("counts only locked, non-deleted entries in the period, tenant-scoped", async () => {
      const from = new Date("2026-05-01T00:00:00Z");
      const to = new Date("2026-05-31T00:00:00Z");
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-05-10T00:00:00Z"),
          startTime: new Date("2026-05-10T08:00:00Z"),
          endTime: new Date("2026-05-10T16:00:00Z"),
          type: "WORK",
          isLocked: true,
          salonId: data.salonId, // Phase 68b (issue #68)
        },
      });
      const count = await countLockedEntries(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        from,
        to,
      );
      expect(count).toBeGreaterThanOrEqual(1);

      const countWrongTenant = await countLockedEntries(
        app.prisma,
        data.employee.id,
        otherTenantData.tenant.id,
        from,
        to,
      );
      expect(countWrongTenant).toBe(0);
    });
  });

  describe("T4 getInvalidEntries / T5 getEntryActivityFeed", () => {
    it("getInvalidEntries returns only isInvalid:true, non-deleted rows", async () => {
      const rows = await getInvalidEntries(app.prisma, data.employee.id, data.tenant.id);
      expect(rows.every((r) => typeof r.id === "string")).toBe(true);
    });

    it("getEntryActivityFeed orders by createdAt desc and respects the limit", async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const rows = await getEntryActivityFeed(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        since,
        2,
      );
      expect(rows.length).toBeLessThanOrEqual(2);
    });
  });

  describe("T9 archiveEntriesBefore / T10 clearEntryNotesForEmployee", () => {
    it("archiveEntriesBefore soft-deletes entries at/before cutoff and returns the count", async () => {
      const cutoff = new Date("2020-01-01T00:00:00Z");
      const old = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2019-06-01T00:00:00Z"),
          startTime: new Date("2019-06-01T08:00:00Z"),
          endTime: new Date("2019-06-01T16:00:00Z"),
          type: "WORK",
          salonId: data.salonId, // Phase 68b (issue #68)
        },
      });
      const count = await archiveEntriesBefore(
        app.prisma,
        [data.employee.id],
        data.tenant.id,
        cutoff,
      );
      expect(count).toBeGreaterThanOrEqual(1);
      const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: old.id } });
      expect(after.deletedAt).not.toBeNull();
    });

    it("clearEntryNotesForEmployee reaches a SOFT-DELETED row too (DSGVO Art. 17)", async () => {
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-06-01T00:00:00Z"),
          startTime: new Date("2026-06-01T08:00:00Z"),
          endTime: new Date("2026-06-01T16:00:00Z"),
          type: "WORK",
          note: "personal note",
          deletedAt: new Date(),
          salonId: data.salonId, // Phase 68b (issue #68)
        },
      });
      await clearEntryNotesForEmployee(app.prisma, data.employee.id);
      const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(after.note).toBeNull();
    });
  });

  describe("T12 createImportedTimeEntry", () => {
    it("creates a WORK/MANUAL entry", async () => {
      const created = await createImportedTimeEntry(app.prisma, {
        tenantId: data.tenant.id, // Issue #70 (70b-04): the Employee row lock carries the tenant
        employeeId: data.adminEmployee.id,
        date: new Date("2026-07-01T00:00:00Z"),
        startTime: new Date("2026-07-01T08:00:00Z"),
        endTime: new Date("2026-07-01T16:00:00Z"),
        breakMinutes: 30,
        note: null,
        salonId: data.salonId, // Phase 68b (issue #68)
      });
      expect(created.type).toBe("WORK");
      expect(created.source).toBe("MANUAL");
      // Issue #81 (D-03): an imported entry is unclassified and carries no share.
      expect(created.activityKind).toBe("UNSPECIFIED");
      expect(
        await app.prisma.timeEntryActivityShare.count({ where: { timeEntryId: created.id } }),
      ).toBe(0);
    });

    // Issue #70 (70b-04, I-21): the write is lock -> overlap re-check -> create, run in a
    // transaction by the caller; an overlapping interval is refused with the neutral text and
    // writes nothing, a second non-overlapping entry of the same day is created.
    it("refuses an overlapping interval of the same employee and accepts a second entry of the day", async () => {
      const day = new Date("2026-07-02T00:00:00Z");
      const row = (startHour: number, endHour: number) => ({
        tenantId: data.tenant.id,
        employeeId: data.adminEmployee.id,
        date: day,
        startTime: new Date(`2026-07-02T${String(startHour).padStart(2, "0")}:00:00Z`),
        endTime: new Date(`2026-07-02T${String(endHour).padStart(2, "0")}:00:00Z`),
        breakMinutes: 0,
        note: null,
        salonId: data.salonId,
      });
      await app.prisma.$transaction((tx) => createImportedTimeEntry(tx, row(8, 12)));
      await expect(
        app.prisma.$transaction((tx) => createImportedTimeEntry(tx, row(11, 14))),
      ).rejects.toThrow("Überschneidung mit einem bestehenden Eintrag dieses Tages.");
      await app.prisma.$transaction((tx) => createImportedTimeEntry(tx, row(13, 17)));
      expect(
        await app.prisma.timeEntry.count({
          where: { employeeId: data.adminEmployee.id, date: day, deletedAt: null },
        }),
      ).toBe(2);
    });
  });

  describe("T11 hardDeleteTimeDataForEmployee — Break before TimeEntry, and the rollback assertion", () => {
    it("a $transaction that throws AFTER the hard-delete leaves BOTH TimeEntry and Break intact", async () => {
      const user = await app.prisma.user.create({
        data: {
          email: `te-hd-rollback-${Date.now()}@test.de`,
          passwordHash: "x",
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          employeeNumber: `HD-RB-${Date.now()}`,
          firstName: "Rollback",
          lastName: "Test",
          hireDate: new Date("2024-01-01"),
        },
      });
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: employee.id,
          date: new Date("2026-08-01T00:00:00Z"),
          startTime: new Date("2026-08-01T08:00:00Z"),
          endTime: new Date("2026-08-01T16:00:00Z"),
          type: "WORK",
          salonId: data.salonId, // Phase 68b (issue #68)
        },
      });
      await app.prisma.break.create({
        data: {
          timeEntryId: entry.id,
          startTime: new Date("2026-08-01T12:00:00Z"),
          endTime: new Date("2026-08-01T12:30:00Z"),
        },
      });
      // Issue #81 (D-19): a share row goes with its entry (Cascade) on the DSGVO hard delete.
      await app.prisma.timeEntryActivityShare.create({
        data: { timeEntryId: entry.id, kind: "SETUP_CLEANING", minutes: 30 },
      });

      await expect(
        app.prisma.$transaction(async (tx) => {
          await hardDeleteTimeDataForEmployee(tx, employee.id);
          throw new Error("forced rollback");
        }),
      ).rejects.toThrow("forced rollback");

      const entryStillThere = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
      expect(entryStillThere, "TimeEntry must survive the rollback").not.toBeNull();
      const breakCount = await app.prisma.break.count({ where: { timeEntryId: entry.id } });
      expect(breakCount, "Break rows must survive the rollback").toBe(1);

      // Second half: the SAME call, run OUTSIDE a transaction, actually deletes both — Break
      // BEFORE TimeEntry (the onDelete:Restrict ordering invariant).
      await hardDeleteTimeDataForEmployee(app.prisma, employee.id);
      const entryGone = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
      expect(entryGone).toBeNull();
      const breakGone = await app.prisma.break.count({ where: { timeEntryId: entry.id } });
      expect(breakGone).toBe(0);
      const sharesGone = await app.prisma.timeEntryActivityShare.count({
        where: { timeEntryId: entry.id },
      });
      expect(sharesGone).toBe(0);

      await app.prisma.employee.delete({ where: { id: employee.id } });
      await app.prisma.user.delete({ where: { id: user.id } });
    });
  });

  describe("getRecordedWorkEntriesByIds (Issue #85, D-04)", () => {
    const day = (n: number) => new Date(`2026-09-${String(n).padStart(2, "0")}T00:00:00Z`);
    const ids: Record<string, string> = {};

    async function make(
      key: string,
      employeeId: string,
      salonId: string,
      date: Date,
      overrides: Record<string, unknown> = {},
    ) {
      const created = await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date,
          startTime: new Date(date.getTime() + 8 * 3_600_000),
          endTime: new Date(date.getTime() + 16 * 3_600_000),
          breakMinutes: 30,
          type: "WORK",
          salonId,
          ...overrides,
        },
      });
      ids[key] = created.id;
    }

    beforeAll(async () => {
      await make("closedA", data.employee.id, data.salonId, day(1));
      await make("closedB", data.employee.id, data.salonId, day(2));
      await make("open", data.employee.id, data.salonId, day(3), { endTime: null });
      await make("invalid", data.employee.id, data.salonId, day(4), { isInvalid: true });
      await make("deleted", data.employee.id, data.salonId, day(7), { deletedAt: new Date() });
      await make("overtime", data.employee.id, data.salonId, day(8), { type: "OVERTIME" });
      await make("foreign", otherTenantData.employee.id, otherTenantData.salonId, day(1));
    });

    it("returns the rows of two closed and one open entry with exactly the documented key set", async () => {
      const rows = await getRecordedWorkEntriesByIds(app.prisma, data.tenant.id, [
        ids.closedA,
        ids.closedB,
        ids.open,
      ]);
      expect(rows.map((r) => r.id).sort((a, b) => a.localeCompare(b))).toEqual(
        [ids.closedA, ids.closedB, ids.open].sort((a, b) => a.localeCompare(b)),
      );
      for (const row of rows) {
        expect(Object.keys(row).sort((a, b) => a.localeCompare(b))).toEqual(
          [
            "breakMinutes",
            "date",
            "employeeId",
            "endTime",
            "id",
            "isInvalid",
            "salonId",
            "startTime",
          ].sort((a, b) => a.localeCompare(b)),
        );
        expect(row.salonId).toBe(data.salonId);
        expect(row.employeeId).toBe(data.employee.id);
      }
      expect(rows.find((r) => r.id === ids.open)?.endTime).toBeNull();
    });

    it("returns an invalid entry with isInvalid true", async () => {
      const rows = await getRecordedWorkEntriesByIds(app.prisma, data.tenant.id, [ids.invalid]);
      expect(rows).toHaveLength(1);
      expect(rows[0].isInvalid).toBe(true);
    });

    it("never returns a soft-deleted or a non-WORK entry", async () => {
      const rows = await getRecordedWorkEntriesByIds(app.prisma, data.tenant.id, [
        ids.deleted,
        ids.overtime,
        ids.closedA,
      ]);
      expect(rows.map((r) => r.id)).toEqual([ids.closedA]);
    });

    it("never returns an entry of another tenant, whichever tenantId is passed", async () => {
      const own = await getRecordedWorkEntriesByIds(app.prisma, data.tenant.id, [
        ids.foreign,
        ids.closedA,
      ]);
      expect(own.map((r) => r.id)).toEqual([ids.closedA]);
      const theirs = await getRecordedWorkEntriesByIds(app.prisma, otherTenantData.tenant.id, [
        ids.foreign,
        ids.closedA,
      ]);
      expect(theirs.map((r) => r.id)).toEqual([ids.foreign]);
    });

    it("returns [] for an empty id list without issuing a query", async () => {
      const failing = {
        timeEntry: {
          findMany: () => {
            throw new Error("no query expected for an empty id list");
          },
        },
      } as never;
      expect(await getRecordedWorkEntriesByIds(failing, data.tenant.id, [])).toEqual([]);
    });

    it("handles 6001 ids in chunks without a Postgres parameter error", async () => {
      const many = [
        ids.closedA,
        ids.closedB,
        ids.open,
        ...Array.from({ length: 5998 }, () => randomUUID()),
      ];
      expect(many).toHaveLength(6001);
      const rows = await getRecordedWorkEntriesByIds(app.prisma, data.tenant.id, many);
      expect(rows.map((r) => r.id).sort((a, b) => a.localeCompare(b))).toEqual(
        [ids.closedA, ids.closedB, ids.open].sort((a, b) => a.localeCompare(b)),
      );
    });
  });
  describe("employeesWithValidWorkSince (Issue #588)", () => {
    const hire = new Date("2026-03-02T00:00:00Z");
    const at = (iso: string) => new Date(`${iso}T00:00:00Z`);
    const people: Record<string, string> = {};

    async function bareEmployee(tenantId: string, key: string, hireDate: Date): Promise<string> {
      const s = `ewvw-${key}-${randomUUID().slice(0, 8)}`;
      const user = await app.prisma.user.create({
        data: {
          email: `${s}@example.invalid`,
          passwordHash: "x",
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: s.slice(0, 20),
          firstName: "Person",
          lastName: key,
          hireDate,
        },
      });
      return employee.id;
    }

    async function entry(
      employeeId: string,
      salonId: string,
      date: Date,
      overrides: Record<string, unknown> = {},
    ) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date,
          startTime: new Date(date.getTime() + 8 * 3_600_000),
          endTime: new Date(date.getTime() + 16 * 3_600_000),
          breakMinutes: 30,
          type: "WORK",
          salonId,
          ...overrides,
        },
      });
    }

    beforeAll(async () => {
      for (const key of [
        "valid",
        "open",
        "invalid",
        "deleted",
        "overtime",
        "holiday",
        "dayBefore",
        "none",
        "late",
      ]) {
        people[key] = await bareEmployee(data.tenant.id, key, hire);
      }
      people.foreign = await bareEmployee(otherTenantData.tenant.id, "foreign", hire);
      const s = data.salonId;
      await entry(people.valid, s, hire); // closed valid WORK on the hire day
      await entry(people.open, s, hire, { endTime: null });
      await entry(people.invalid, s, hire, { isInvalid: true });
      await entry(people.deleted, s, hire, { deletedAt: new Date() });
      await entry(people.overtime, s, hire, { type: "OVERTIME" });
      await entry(people.holiday, s, hire, { type: "PUBLIC_HOLIDAY" });
      await entry(people.dayBefore, s, at("2026-03-01"));
      // Earlier invalid/open rows must not hide a later valid one: the latest VALID date decides.
      await entry(people.late, s, at("2026-03-03"), { isInvalid: true });
      await entry(people.late, s, at("2026-04-06"));
      await entry(people.foreign, otherTenantData.salonId, hire);
    });

    const from = (key: string) => ({ employeeId: people[key], fromDay: hire });

    it("contains a person with a closed valid WORK entry on the hire day", async () => {
      const set = await employeesWithValidWorkSince(app.prisma, data.tenant.id, [from("valid")]);
      expect([...set]).toEqual([people.valid]);
    });

    it("contains a person whose latest valid entry is after the hire day even when an invalid one lies between", async () => {
      const set = await employeesWithValidWorkSince(app.prisma, data.tenant.id, [from("late")]);
      expect(set.has(people.late)).toBe(true);
    });

    it("does not contain a person with only an open, invalid, soft-deleted, non-WORK or pre-hire entry, or none", async () => {
      const keys = ["open", "invalid", "deleted", "overtime", "holiday", "dayBefore", "none"];
      const set = await employeesWithValidWorkSince(app.prisma, data.tenant.id, keys.map(from));
      expect(set.size).toBe(0);
    });

    it("never contains a person of another tenant, whichever tenantId is passed", async () => {
      const own = await employeesWithValidWorkSince(app.prisma, data.tenant.id, [
        from("foreign"),
        from("valid"),
      ]);
      expect([...own]).toEqual([people.valid]);
      const theirs = await employeesWithValidWorkSince(app.prisma, otherTenantData.tenant.id, [
        from("foreign"),
        from("valid"),
      ]);
      expect([...theirs]).toEqual([people.foreign]);
    });

    it("compares each person against their own fromDay", async () => {
      const set = await employeesWithValidWorkSince(app.prisma, data.tenant.id, [
        { employeeId: people.valid, fromDay: at("2026-03-03") },
        { employeeId: people.late, fromDay: at("2026-04-06") },
      ]);
      expect([...set]).toEqual([people.late]);
    });

    it("returns an empty set for an empty list without issuing a query", async () => {
      const failing = {
        timeEntry: {
          groupBy: () => {
            throw new Error("no query expected for an empty list");
          },
        },
      } as never;
      expect((await employeesWithValidWorkSince(failing, data.tenant.id, [])).size).toBe(0);
    });

    it("reads more than one chunk of ids into one result", async () => {
      const filler = Array.from({ length: 5000 }, () => ({
        employeeId: randomUUID(),
        fromDay: hire,
      }));
      const persons = [...filler, from("valid"), from("late")];
      expect(persons.length).toBe(5002);
      const set = await employeesWithValidWorkSince(app.prisma, data.tenant.id, persons);
      expect([...set].sort((a, b) => a.localeCompare(b))).toEqual(
        [people.valid, people.late].sort((a, b) => a.localeCompare(b)),
      );
    });
  });
});
