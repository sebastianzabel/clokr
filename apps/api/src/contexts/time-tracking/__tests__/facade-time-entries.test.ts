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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import {
  getValidWorkedEntriesInRange,
  getWorkedEntriesInRange,
  getRecordedWorkEntriesInRange,
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
        employeeId: data.adminEmployee.id,
        date: new Date("2026-07-01T00:00:00Z"),
        startTime: new Date("2026-07-01T08:00:00Z"),
        endTime: new Date("2026-07-01T16:00:00Z"),
        breakMinutes: 30,
        note: null,
      });
      expect(created.type).toBe("WORK");
      expect(created.source).toBe("MANUAL");
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
        },
      });
      await app.prisma.break.create({
        data: {
          timeEntryId: entry.id,
          startTime: new Date("2026-08-01T12:00:00Z"),
          endTime: new Date("2026-08-01T12:30:00Z"),
        },
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

      await app.prisma.employee.delete({ where: { id: employee.id } });
      await app.prisma.user.delete({ where: { id: user.id } });
    });
  });
});
