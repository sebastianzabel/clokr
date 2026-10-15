/**
 * Issue #93 (Phase 93b-04, Task 1) — the three allow-list facade reads behind the operator's support
 * month view: `getEntriesForSupportMonth` and `getDayBreaksForSupportMonth` (Zeiterfassung) and
 * `getLeaveRequestsForSupportMonth` (Abwesenheiten).
 *
 * What is proven here (D-05(2), Art. 5 (1) (c) DSGVO):
 *   - every returned row carries EXACTLY the allow-listed keys (recursively) — a free-text note, a
 *     waived-break reason, a creator or reviewer id, an attest field, a special-leave rule or an
 *     overtime-comp figure is never selected, so it cannot leak by a later DTO mistake;
 *   - the tenant binds through the employee: another tenant's id, or another tenant's employee under
 *     the caller's tenant id, returns nothing;
 *   - the month bounds are calendar days (`@db.Date`, Issue #493): the previous month's last day is out,
 *     the month's last day is in;
 *   - soft-deleted time entries ARE returned, with their `deletedAt` (the named carve-out: tracing a
 *     disappeared entry is the core of support); soft-deleted day breaks and leave requests are not.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { getEntriesForSupportMonth, getDayBreaksForSupportMonth } from "../contexts/time-tracking";
import { getLeaveRequestsForSupportMonth } from "../contexts/absence";

const byKey = (a: string, b: string) => a.localeCompare(b);

/** Every key at every depth of a JSON-like value, as dotted paths (array indices collapsed). */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => keyPaths(item, prefix));
  }
  // A Date and a Prisma Decimal are leaves, not objects with keys of their own.
  const isLeaf =
    value instanceof Date || typeof (value as { toFixed?: unknown } | null)?.toFixed === "function";
  if (value !== null && typeof value === "object" && !isLeaf) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      return [path, ...keyPaths(child, path)];
    });
  }
  return [];
}

function uniquePaths(value: unknown): string[] {
  return [...new Set(keyPaths(value))].sort(byKey);
}

const ENTRY_PATHS = [
  "breakMinutes",
  "breakStatus",
  "breaks",
  "breaks.endTime",
  "breaks.startTime",
  "date",
  "deletedAt",
  "endTime",
  "id",
  "invalidReasonCode",
  "isInvalid",
  "isLocked",
  "salon",
  "salon.id",
  "salon.name",
  "source",
  "startTime",
  "type",
].sort(byKey);

const DAY_BREAK_PATHS = ["date", "endTime", "id", "startTime"].sort(byKey);

const LEAVE_PATHS = [
  "days",
  "daysProvisional",
  "endDate",
  "halfDay",
  "id",
  "leaveType",
  "leaveType.code",
  "leaveType.name",
  "startDate",
  "status",
].sort(byKey);

describe("Support month facade reads (Issue #93, D-05(2))", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;

  const firstDay = new Date("2026-03-01T00:00:00Z");
  const lastDay = new Date("2026-03-31T00:00:00Z");

  // Fresh random markers per run: they stand in for the excluded free text.
  const noteMarker = `note-${randomUUID()}`;
  const waivedMarker = `waived-${randomUUID()}`;
  const leaveNoteMarker = `lnote-${randomUUID()}`;
  const reviewNoteMarker = `rnote-${randomUUID()}`;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sup-facade");
    other = await seedTestData(app, "sup-facade-other");

    const entry = (employeeId: string, salonId: string, day: string, extra = {}) =>
      app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: new Date(`${day}T00:00:00Z`),
          startTime: new Date(`${day}T08:00:00Z`),
          endTime: new Date(`${day}T16:00:00Z`),
          type: "WORK",
          salonId,
          ...extra,
        },
      });

    // March 10: a full entry with a note, a waived-break reason, a creator and one Break row.
    const full = await entry(data.employee.id, data.salonId, "2026-03-10", {
      note: noteMarker,
      breakWaivedReason: waivedMarker,
      createdBy: randomUUID(),
      breakMinutes: 30,
      breakStatus: "WAIVED",
    });
    await app.prisma.break.create({
      data: {
        timeEntryId: full.id,
        startTime: new Date("2026-03-10T12:00:00Z"),
        endTime: new Date("2026-03-10T12:30:00Z"),
      },
    });
    // March 11: soft-deleted entry.
    await entry(data.employee.id, data.salonId, "2026-03-11", { deletedAt: new Date() });
    // February 28 (previous month's last day), late evening instant, and March 31 (this month's last day).
    await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date("2026-02-28T00:00:00Z"),
        startTime: new Date("2026-02-28T20:00:00Z"),
        endTime: new Date("2026-02-28T23:00:00Z"),
        type: "WORK",
        salonId: data.salonId,
      },
    });
    await entry(data.employee.id, data.salonId, "2026-03-31");
    // The other tenant's employee has an entry in the same month.
    await entry(other.employee.id, other.salonId, "2026-03-12", { note: noteMarker });

    // Day breaks: one live, one soft-deleted, one in another month.
    const dayBreak = (day: string, extra = {}) =>
      app.prisma.dayBreak.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(`${day}T00:00:00Z`),
          startTime: new Date(`${day}T12:00:00Z`),
          endTime: new Date(`${day}T12:20:00Z`),
          createdBy: randomUUID(),
          ...extra,
        },
      });
    await dayBreak("2026-03-10");
    await dayBreak("2026-03-12", { deletedAt: new Date(), deletedBy: randomUUID() });
    await dayBreak("2026-04-02");

    // Leave: one overlapping the month start (from February), one deleted, one outside.
    const leave = (start: string, end: string, extra = {}) =>
      app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date(`${start}T00:00:00Z`),
          endDate: new Date(`${end}T00:00:00Z`),
          days: 3,
          status: "APPROVED",
          note: leaveNoteMarker,
          reviewNote: reviewNoteMarker,
          reviewedBy: randomUUID(),
          attestPresent: true,
          attestValidFrom: new Date(`${start}T00:00:00Z`),
          attestValidTo: new Date(`${end}T00:00:00Z`),
          overtimeCompMinutes: 60,
          ...extra,
        },
      });
    await leave("2026-02-26", "2026-03-02");
    await leave("2026-03-16", "2026-03-18", { status: "PENDING" });
    await leave("2026-03-20", "2026-03-21", { deletedAt: new Date() });
    await leave("2026-05-04", "2026-05-06");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, other.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("getEntriesForSupportMonth", () => {
    it("returns the month's entries with exactly the allow-listed keys at every depth", async () => {
      const rows = await getEntriesForSupportMonth(
        app.prisma,
        data.tenant.id,
        data.employee.id,
        firstDay,
        lastDay,
      );
      expect(rows.length).toBe(3);
      expect(uniquePaths(rows)).toEqual(ENTRY_PATHS);
      const text = JSON.stringify(rows);
      expect(text).not.toContain(noteMarker);
      expect(text).not.toContain(waivedMarker);
    });

    it("orders by date and carries the break rows of the entry", async () => {
      const rows = await getEntriesForSupportMonth(
        app.prisma,
        data.tenant.id,
        data.employee.id,
        firstDay,
        lastDay,
      );
      const days = rows.map((row) => row.date.toISOString().slice(0, 10));
      expect(days).toEqual(["2026-03-10", "2026-03-11", "2026-03-31"]);
      expect(rows[0].breaks).toHaveLength(1);
      expect(rows[0].breakStatus).toBe("WAIVED");
      expect(rows[0].salon.id).toBe(data.salonId);
    });

    it("includes the soft-deleted entry with its deletedAt (named carve-out)", async () => {
      const rows = await getEntriesForSupportMonth(
        app.prisma,
        data.tenant.id,
        data.employee.id,
        firstDay,
        lastDay,
      );
      const deleted = rows.filter((row) => row.deletedAt !== null);
      expect(deleted).toHaveLength(1);
      expect(deleted[0].date.toISOString().slice(0, 10)).toBe("2026-03-11");
    });

    it("uses calendar-day bounds: previous month's last day out, this month's last day in", async () => {
      const rows = await getEntriesForSupportMonth(
        app.prisma,
        data.tenant.id,
        data.employee.id,
        firstDay,
        lastDay,
      );
      const days = rows.map((row) => row.date.toISOString().slice(0, 10));
      expect(days).not.toContain("2026-02-28");
      expect(days).toContain("2026-03-31");
    });

    it("returns nothing for another tenant's id or another tenant's employee", async () => {
      expect(
        await getEntriesForSupportMonth(
          app.prisma,
          other.tenant.id,
          data.employee.id,
          firstDay,
          lastDay,
        ),
      ).toEqual([]);
      expect(
        await getEntriesForSupportMonth(
          app.prisma,
          data.tenant.id,
          other.employee.id,
          firstDay,
          lastDay,
        ),
      ).toEqual([]);
      expect(
        await getEntriesForSupportMonth(
          app.prisma,
          randomUUID(),
          data.employee.id,
          firstDay,
          lastDay,
        ),
      ).toEqual([]);
    });
  });

  describe("getDayBreaksForSupportMonth", () => {
    it("returns the live day breaks of the month with exactly id, date, startTime, endTime", async () => {
      const rows = await getDayBreaksForSupportMonth(
        app.prisma,
        data.tenant.id,
        data.employee.id,
        firstDay,
        lastDay,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].date.toISOString().slice(0, 10)).toBe("2026-03-10");
      expect(uniquePaths(rows)).toEqual(DAY_BREAK_PATHS);
    });

    it("returns nothing across tenants", async () => {
      expect(
        await getDayBreaksForSupportMonth(
          app.prisma,
          other.tenant.id,
          data.employee.id,
          firstDay,
          lastDay,
        ),
      ).toEqual([]);
      expect(
        await getDayBreaksForSupportMonth(
          app.prisma,
          data.tenant.id,
          other.employee.id,
          firstDay,
          lastDay,
        ),
      ).toEqual([]);
    });
  });

  describe("getLeaveRequestsForSupportMonth", () => {
    it("returns the non-deleted requests overlapping the month, every status, allow-listed keys only", async () => {
      const rows = await getLeaveRequestsForSupportMonth(
        app.prisma,
        data.tenant.id,
        data.employee.id,
        firstDay,
        lastDay,
      );
      expect(rows.map((row) => row.status)).toEqual(["APPROVED", "PENDING"]);
      expect(rows[0].startDate.toISOString().slice(0, 10)).toBe("2026-02-26");
      expect(uniquePaths(rows)).toEqual(LEAVE_PATHS);
      const text = JSON.stringify(rows);
      expect(text).not.toContain(leaveNoteMarker);
      expect(text).not.toContain(reviewNoteMarker);
    });

    it("returns nothing across tenants", async () => {
      expect(
        await getLeaveRequestsForSupportMonth(
          app.prisma,
          other.tenant.id,
          data.employee.id,
          firstDay,
          lastDay,
        ),
      ).toEqual([]);
      expect(
        await getLeaveRequestsForSupportMonth(
          app.prisma,
          data.tenant.id,
          other.employee.id,
          firstDay,
          lastDay,
        ),
      ).toEqual([]);
    });
  });
});
