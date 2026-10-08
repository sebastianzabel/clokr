// Issue #80 (D-06, D-08, D-13, D-14, D-17, D-18) — POST / DELETE /api/v1/day-breaks/acks.
//
// A multi-entry day cannot exist in the database while the partial unique index
// `TimeEntry_employeeId_date_unique_not_deleted` holds, so the day lookup `findEntriesOfDay` is
// mocked for the constructed days only and delegates to the real implementation for every other
// date (same harness as `day-breaks.test.ts`). Everything else is real: employees, salons, role
// assignments, the month lock, DayBreakAck rows and the audit log.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import bcrypt from "bcryptjs";
import crypto, { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { TimeEntry } from "@clokr/db";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../../../__tests__/setup";
import { normalizeRolePermissions, roleNameKey } from "../../../platform";
import { getTenantTimezone, monthRangeUtc } from "../../../working-time-account";

vi.mock("../../day-entries", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../day-entries")>();
  return { ...original, findEntriesOfDay: vi.fn(original.findEntriesOfDay) };
});

import { findEntriesOfDay } from "../../day-entries";
import { checkArbZG } from "../../arbzg";

const PASSWORD = "test1234";
const DAY = "2026-03-10"; // constructed two-salon day
const LOCKED_DAY = "2026-03-11"; // constructed day with a locked entry
const CLOSED_DAY = "2026-02-10"; // constructed day inside a closed month
const mockedLookup = vi.mocked(findEntriesOfDay);

const SELF_ACK_MESSAGE = "Eigene Pausenverstöße können nicht selbst quittiert werden.";
const NO_VIOLATION_MESSAGE = "Für diesen Tag liegt kein salonübergreifender Pausenverstoß vor.";
const ALREADY_ACKED_MESSAGE = "Der Pausenverstoß dieses Tages ist bereits quittiert.";
const MONTH_CLOSED_MESSAGE = "Monat ist abgeschlossen und kann nicht bearbeitet werden";
const ENTRY_LOCKED_MESSAGE = "Eintrag ist gesperrt und kann nicht bearbeitet werden";
const REASON = "Kundentermin ohne Unterbrechung";

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}
function at(hhmm: string, day = DAY): string {
  return `${day}T${hhmm}:00.000Z`;
}
function errorOf(res: { body: string }): string {
  return (JSON.parse(res.body) as { error: string }).error;
}

describe("Issue #80 — /api/v1/day-breaks/acks", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  const constructedDays = new Map<string, TimeEntry[]>();

  function row(
    employeeId: string,
    day: string,
    salonId: string,
    start: string,
    end: string,
    opts: { isLocked?: boolean } = {},
  ): TimeEntry {
    return {
      id: randomUUID(),
      employeeId,
      date: dateOf(day),
      startTime: new Date(at(start, day)),
      endTime: new Date(at(end, day)),
      breakMinutes: 0,
      type: "WORK",
      source: "MANUAL",
      note: null,
      isLocked: opts.isLocked ?? false,
      lockedAt: null,
      isInvalid: false,
      invalidReason: null,
      invalidReasonCode: null,
      deletedAt: null,
      createdAt: new Date("2026-03-10T20:00:00.000Z"),
      updatedAt: new Date("2026-03-10T20:00:00.000Z"),
      createdBy: null,
      breakStatus: "CONFIRMED",
      breakWaivedReason: null,
      retroRequestId: null,
      salonId,
    } as unknown as TimeEntry;
  }

  /** 8 h net across two salons with a 30 min travel gap: a § 4 shortfall (30 min required). */
  function twoSalonDay(employeeId: string, day = DAY, opts: { isLocked?: boolean } = {}) {
    constructedDays.set(`${employeeId}:${day}`, [
      row(employeeId, day, salonA, "08:00", "12:00", opts),
      row(employeeId, day, salonB, "12:30", "16:30", opts),
    ]);
  }

  /** 11 h net across two salons: § 4 shortfall AND over the § 3 cap of 10 h. */
  function elevenHourDay(employeeId: string, day = DAY) {
    constructedDays.set(`${employeeId}:${day}`, [
      row(employeeId, day, salonA, "08:00", "13:00"),
      row(employeeId, day, salonB, "13:30", "19:30"),
    ]);
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  async function createScopedManager(label: string, permissions: string[], salonIds: string[]) {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "DayBreakAckTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    const name = `DayBreakAck ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: "SALONS",
        salonIds,
        employeeIds: [],
      },
    });
    return { token: await login(user.email), email: user.email, userId: user.id };
  }

  function postAck(token: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/day-breaks/acks",
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  function ackBody(employeeId: string, day = DAY, reason = REASON) {
    return { employeeId, date: day, reason };
  }

  function delAck(
    token: string,
    id: string,
    body: Record<string, unknown> = { reason: "Quittung war irrtümlich" },
  ) {
    return app.inject({
      method: "DELETE",
      url: `/api/v1/day-breaks/acks/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  /** A stored acknowledgement whose snapshot matches the constructed two-salon day. */
  async function seedAck(employeeId: string, day = DAY) {
    return app.prisma.dayBreakAck.create({
      data: {
        employeeId,
        date: dateOf(day),
        reason: REASON,
        snapshot: { entryIds: [], salonIds: [], netWorkedMin: 0, totalBreakMin: 0 },
        acknowledgedBy: data.adminUser.id,
      },
    });
  }

  async function seedDayBreak(employeeId: string, day: string, start: string, end: string) {
    return app.prisma.dayBreak.create({
      data: {
        employeeId,
        date: dateOf(day),
        startTime: new Date(at(start, day)),
        endTime: new Date(at(end, day)),
        createdBy: data.adminUser.id,
      },
    });
  }

  async function closeMonth(employeeId: string, year: number, month: number) {
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    const { start, end } = monthRangeUtc(year, month, tz);
    return app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: start,
        periodEnd: end,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
        closedBy: "test-system",
        superseded: false,
      },
    });
  }

  /** A cron-style cross-salon notification row, as `attendance-checker` writes it. */
  async function seedViolationNotice(
    userId: string,
    employeeId: string,
    day: string,
    type = "BREAK_CROSS_SALON_VIOLATION",
  ) {
    return app.prisma.notification.create({
      data: {
        userId,
        type,
        title: "Pausenverstoß",
        message: "x",
        relatedType: "EmployeeDay",
        relatedId: `${employeeId}:${day}`,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "daybreakacks-80");
    dataB = await seedTestData(app, "daybreakacks-80-b");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Zweiter Salon" })).id;

    const actual = await vi.importActual<typeof import("../../day-entries")>("../../day-entries");
    mockedLookup.mockImplementation(async (db, params) => {
      const constructed = constructedDays.get(
        `${params.employeeId}:${params.date.toISOString().slice(0, 10)}`,
      );
      return constructed ?? actual.findEntriesOfDay(db, params);
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, dataB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    constructedDays.clear();
    const ids = [data.employee.id, data.adminEmployee.id, dataB.employee.id];
    await app.prisma.notification.deleteMany({
      where: {
        relatedType: "EmployeeDay",
        OR: ids.map((id) => ({ relatedId: { startsWith: `${id}:` } })),
      },
    });
    await app.prisma.dayBreakAck.deleteMany({ where: { employeeId: { in: ids } } });
    await app.prisma.dayBreak.deleteMany({ where: { employeeId: { in: ids } } });
  });

  // ── Task 1: POST /acks ────────────────────────────────────────────────────

  describe("POST /acks — acknowledge a cross-salon § 4 violation (D-08, D-13, D-14, D-17, D-18)", () => {
    it("a tenant-wide manager acknowledges the A+B day: 201, the day's snapshot is stored, one audit row in the same write", async () => {
      twoSalonDay(data.employee.id);
      const res = await postAck(data.adminToken, ackBody(data.employee.id));
      expect(res.statusCode).toBe(201);
      const { acknowledgement } = JSON.parse(res.body) as {
        acknowledgement: { id: string; employeeId: string; reason: string };
      };
      expect(acknowledgement.employeeId).toBe(data.employee.id);
      expect(acknowledgement.reason).toBe(REASON);

      const rows = await app.prisma.dayBreakAck.findMany({
        where: { employeeId: data.employee.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].acknowledgedBy).toBe(data.adminUser.id);
      expect(rows[0].deletedAt).toBeNull();
      expect(rows[0].date.toISOString().slice(0, 10)).toBe(DAY);
      const entryIds = constructedDays
        .get(`${data.employee.id}:${DAY}`)!
        .map((e) => e.id)
        .sort();
      expect(rows[0].snapshot).toEqual({
        entryIds,
        salonIds: [salonA, salonB].sort(),
        netWorkedMin: 480,
        totalBreakMin: 0,
      });

      const audits = await app.prisma.auditLog.findMany({
        where: { action: "DAY_BREAK_ACK", entityId: acknowledgement.id },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].entity).toBe("DayBreakAck");
      expect(audits[0].userId).toBe(data.adminUser.id);
      const newValue = audits[0].newValue as Record<string, unknown>;
      expect(newValue.employeeId).toBe(data.employee.id);
      expect(newValue.date).toBe(DAY);
      expect(newValue.reason).toBe(REASON);
      expect(newValue.snapshot).toEqual(rows[0].snapshot);
    });

    it("dismisses the BREAK_CROSS_SALON_VIOLATION notices of exactly that employee day for every recipient", async () => {
      twoSalonDay(data.employee.id);
      const manager = await createScopedManager(
        "ack-notice-peer",
        ["time-entry:update:ZUGEWIESEN"],
        [salonA, salonB],
      );
      const mine = await seedViolationNotice(data.adminUser.id, data.employee.id, DAY);
      const peer = await seedViolationNotice(manager.userId, data.employee.id, DAY);
      const otherDay = await seedViolationNotice(data.adminUser.id, data.employee.id, "2026-03-12");
      const otherEmployee = await seedViolationNotice(
        data.adminUser.id,
        data.adminEmployee.id,
        DAY,
      );
      const otherType = await seedViolationNotice(
        data.adminUser.id,
        data.employee.id,
        DAY,
        "BREAK_COMPLIANCE_ALERT",
      );

      expect((await postAck(data.adminToken, ackBody(data.employee.id))).statusCode).toBe(201);

      const rows = await app.prisma.notification.findMany({
        where: { id: { in: [mine.id, peer.id, otherDay.id, otherEmployee.id, otherType.id] } },
      });
      const dismissed = (id: string) => rows.find((r) => r.id === id)?.dismissedAt;
      expect(dismissed(mine.id)).not.toBeNull();
      expect(dismissed(peer.id)).not.toBeNull();
      expect(dismissed(otherDay.id)).toBeNull();
      expect(dismissed(otherEmployee.id)).toBeNull();
      expect(dismissed(otherType.id)).toBeNull();
    });

    it("a rejected acknowledgement leaves the notices untouched", async () => {
      // same-salon day: 409, nothing acknowledged
      constructedDays.set(`${data.employee.id}:${DAY}`, [
        row(data.employee.id, DAY, salonA, "08:00", "12:00"),
        row(data.employee.id, DAY, salonA, "12:30", "16:30"),
      ]);
      const notice = await seedViolationNotice(data.adminUser.id, data.employee.id, DAY);
      expect((await postAck(data.adminToken, ackBody(data.employee.id))).statusCode).toBe(409);
      const stored = await app.prisma.notification.findUniqueOrThrow({ where: { id: notice.id } });
      expect(stored.dismissedAt).toBeNull();
    });

    it("D-17: afterwards checkArbZG reports the finding as a waived cross-salon warning; the § 3 cap stays an error", async () => {
      twoSalonDay(data.employee.id);
      const before = await checkArbZG(app.prisma, data.employee.id, dateOf(DAY));
      const shortBefore = before.find((w) => w.code === "BREAK_TOO_SHORT");
      expect(shortBefore?.waived).toBeUndefined();

      expect((await postAck(data.adminToken, ackBody(data.employee.id))).statusCode).toBe(201);
      const after = await checkArbZG(app.prisma, data.employee.id, dateOf(DAY));
      const shortAfter = after.find((w) => w.code === "BREAK_TOO_SHORT");
      expect(shortAfter).toMatchObject({ severity: "warning", waived: true, crossSalon: true });

      // 11 h variant: acknowledgeable (§ 4 shortfall), but MAX_DAILY_EXCEEDED is never downgraded
      elevenHourDay(data.employee.id, "2026-03-13");
      expect(
        (await postAck(data.adminToken, ackBody(data.employee.id, "2026-03-13"))).statusCode,
      ).toBe(201);
      const eleven = await checkArbZG(app.prisma, data.employee.id, dateOf("2026-03-13"));
      const max = eleven.find((w) => w.code === "MAX_DAILY_EXCEEDED");
      expect(max?.severity).toBe("error");
      expect(max?.waived).toBeUndefined();
      expect(eleven.find((w) => w.code === "BREAK_TOO_SHORT")?.waived).toBe(true);
    });

    it("a caller holding only time-entry:update:EIGENE is 403 Forbidden", async () => {
      twoSalonDay(data.employee.id);
      const res = await postAck(data.empToken, ackBody(data.employee.id));
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toBe("Forbidden");
      expect(await app.prisma.dayBreakAck.count({ where: { employeeId: data.employee.id } })).toBe(
        0,
      );
    });

    it("D-14: a manager acknowledging the own day is 403 with the self-acknowledgement wording", async () => {
      twoSalonDay(data.adminEmployee.id);
      const res = await postAck(data.adminToken, ackBody(data.adminEmployee.id));
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toBe(SELF_ACK_MESSAGE);
      expect(
        await app.prisma.dayBreakAck.count({ where: { employeeId: data.adminEmployee.id } }),
      ).toBe(0);
    });
  });

  // ── Task 2: negative matrix of POST and the revoke route ──────────────────

  describe("POST /acks — guards (D-08, D-13, D-17, D-18)", () => {
    it("D-18: a same-salon multi-entry day with a shortfall is 409 (no cross-salon violation)", async () => {
      constructedDays.set(`${data.employee.id}:${DAY}`, [
        row(data.employee.id, DAY, salonA, "08:00", "12:00"),
        row(data.employee.id, DAY, salonA, "12:10", "17:00"),
      ]);
      const res = await postAck(data.adminToken, ackBody(data.employee.id));
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toBe(NO_VIOLATION_MESSAGE);
    });

    it("D-18: a cross-salon day without a § 4 shortfall (recorded day break) is 409", async () => {
      twoSalonDay(data.employee.id);
      await seedDayBreak(data.employee.id, DAY, "12:00", "12:30");
      const res = await postAck(data.adminToken, ackBody(data.employee.id));
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toBe(NO_VIOLATION_MESSAGE);
    });

    it("D-18: a cross-salon 10.5 h day with its 45 min break (a pure § 3 finding) is 409 and stays an error", async () => {
      constructedDays.set(`${data.employee.id}:${DAY}`, [
        row(data.employee.id, DAY, salonA, "07:00", "12:00"),
        row(data.employee.id, DAY, salonB, "12:45", "18:15"),
      ]);
      await seedDayBreak(data.employee.id, DAY, "12:00", "12:45");
      const res = await postAck(data.adminToken, ackBody(data.employee.id));
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toBe(NO_VIOLATION_MESSAGE);
      const warnings = await checkArbZG(app.prisma, data.employee.id, dateOf(DAY));
      expect(warnings.find((w) => w.code === "MAX_DAILY_EXCEEDED")?.severity).toBe("error");
      expect(await app.prisma.dayBreakAck.count({ where: { employeeId: data.employee.id } })).toBe(
        0,
      );
    });

    it("a second acknowledgement while the first is current is 409", async () => {
      twoSalonDay(data.employee.id);
      expect((await postAck(data.adminToken, ackBody(data.employee.id))).statusCode).toBe(201);
      const again = await postAck(data.adminToken, ackBody(data.employee.id));
      expect(again.statusCode).toBe(409);
      expect(errorOf(again)).toBe(ALREADY_ACKED_MESSAGE);
      expect(await app.prisma.dayBreakAck.count({ where: { employeeId: data.employee.id } })).toBe(
        1,
      );
    });

    it("D-17: once the day's facts change the acknowledgement is stale — the violation is back and a new one is accepted", async () => {
      twoSalonDay(data.employee.id);
      expect((await postAck(data.adminToken, ackBody(data.employee.id))).statusCode).toBe(201);
      const waived = await checkArbZG(app.prisma, data.employee.id, dateOf(DAY));
      expect(waived.find((w) => w.code === "BREAK_TOO_SHORT")?.waived).toBe(true);

      // the second entry now ends 15 minutes later: net working time changes
      constructedDays.set(`${data.employee.id}:${DAY}`, [
        row(data.employee.id, DAY, salonA, "08:00", "12:00"),
        row(data.employee.id, DAY, salonB, "12:30", "16:45"),
      ]);
      const stale = await checkArbZG(app.prisma, data.employee.id, dateOf(DAY));
      const short = stale.find((w) => w.code === "BREAK_TOO_SHORT");
      expect(short?.waived).toBeUndefined();

      const fresh = await postAck(data.adminToken, ackBody(data.employee.id, DAY, "Neuer Stand"));
      expect(fresh.statusCode).toBe(201);
      expect(await app.prisma.dayBreakAck.count({ where: { employeeId: data.employee.id } })).toBe(
        2,
      );
      const after = await checkArbZG(app.prisma, data.employee.id, dateOf(DAY));
      expect(after.find((w) => w.code === "BREAK_TOO_SHORT")?.waived).toBe(true);
    });

    it("a foreign tenant's employee and a random uuid answer identically (404)", async () => {
      const foreign = await postAck(data.adminToken, ackBody(dataB.employee.id));
      const unknown = await postAck(data.adminToken, ackBody(randomUUID()));
      expect(foreign.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(foreign.statusCode);
      expect(unknown.body).toBe(foreign.body);
      expect(errorOf(foreign)).toBe("Mitarbeiter nicht gefunden");
    });

    it("D-13: a manager scoped on salon A only: 404 plus SCOPE_ACCESS_DENIED; scoped on A and B: 201", async () => {
      twoSalonDay(data.employee.id);
      const partial = await createScopedManager(
        "ack-mgr-a",
        ["time-entry:update:ZUGEWIESEN"],
        [salonA],
      );
      const denied = await postAck(partial.token, ackBody(data.employee.id));
      expect(denied.statusCode).toBe(404);
      expect(errorOf(denied)).toBe("Eintrag nicht gefunden");
      expect(
        await app.prisma.auditLog.count({
          where: {
            action: "SCOPE_ACCESS_DENIED",
            entity: "EmployeeDay",
            entityId: `${data.employee.id}:${DAY}`,
          },
        }),
      ).toBe(1);
      expect(await app.prisma.dayBreakAck.count({ where: { employeeId: data.employee.id } })).toBe(
        0,
      );

      const full = await createScopedManager(
        "ack-mgr-ab",
        ["time-entry:update:ZUGEWIESEN"],
        [salonA, salonB],
      );
      expect((await postAck(full.token, ackBody(data.employee.id))).statusCode).toBe(201);
    });

    it("a closed month is 403 with the entry wording", async () => {
      twoSalonDay(data.employee.id, CLOSED_DAY);
      const snapshot = await closeMonth(data.employee.id, 2026, 2);
      try {
        const res = await postAck(data.adminToken, ackBody(data.employee.id, CLOSED_DAY));
        expect(res.statusCode).toBe(403);
        expect(errorOf(res)).toBe(MONTH_CLOSED_MESSAGE);
        expect(
          await app.prisma.dayBreakAck.count({ where: { employeeId: data.employee.id } }),
        ).toBe(0);
      } finally {
        await app.prisma.saldoSnapshot.delete({ where: { id: snapshot.id } });
      }
    });

    it("a locked entry of the day is 409", async () => {
      twoSalonDay(data.employee.id, LOCKED_DAY, { isLocked: true });
      const res = await postAck(data.adminToken, ackBody(data.employee.id, LOCKED_DAY));
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toBe(ENTRY_LOCKED_MESSAGE);
    });

    it("a missing or blank reason is 400 and nothing is stored", async () => {
      twoSalonDay(data.employee.id);
      expect(
        (await postAck(data.adminToken, { employeeId: data.employee.id, date: DAY })).statusCode,
      ).toBe(400);
      const blank = await postAck(data.adminToken, ackBody(data.employee.id, DAY, "   "));
      expect(blank.statusCode).toBe(400);
      expect(blank.body).toContain("Begründung ist erforderlich");
      expect(await app.prisma.dayBreakAck.count({ where: { employeeId: data.employee.id } })).toBe(
        0,
      );
    });

    it("80-AC5: acknowledging writes no TimeEntry and no Break row", async () => {
      twoSalonDay(data.employee.id);
      const entries = await app.prisma.timeEntry.count({ where: { employeeId: data.employee.id } });
      const breaks = await app.prisma.break.count({
        where: { timeEntry: { employeeId: data.employee.id } },
      });
      expect((await postAck(data.adminToken, ackBody(data.employee.id))).statusCode).toBe(201);
      expect(await app.prisma.timeEntry.count({ where: { employeeId: data.employee.id } })).toBe(
        entries,
      );
      expect(
        await app.prisma.break.count({ where: { timeEntry: { employeeId: data.employee.id } } }),
      ).toBe(breaks);
    });
  });

  describe("DELETE /acks/:id — revoke with a reason (D-06, D-14, T-100-09)", () => {
    it("another full-scope manager revokes with a reason: 204, row kept with deletedAt/deletedBy, one audit row with before/after, the violation is back, a second revoke is 404", async () => {
      twoSalonDay(data.employee.id);
      const created = await postAck(data.adminToken, ackBody(data.employee.id));
      const ackId = (JSON.parse(created.body) as { acknowledgement: { id: string } })
        .acknowledgement.id;
      const manager = await createScopedManager(
        "ack-revoker",
        ["time-entry:update:ZUGEWIESEN"],
        [salonA, salonB],
      );

      const res = await delAck(manager.token, ackId, { reason: "Quittung war irrtümlich" });
      expect(res.statusCode).toBe(204);

      const stored = await app.prisma.dayBreakAck.findUniqueOrThrow({ where: { id: ackId } });
      expect(stored.deletedAt).not.toBeNull();
      expect(stored.deletedBy).not.toBeNull();
      expect(stored.reason).toBe(REASON); // the original reason is kept (soft delete)

      const audits = await app.prisma.auditLog.findMany({
        where: { action: "DAY_BREAK_ACK_REVOKE", entityId: ackId },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].entity).toBe("DayBreakAck");
      const oldValue = audits[0].oldValue as Record<string, unknown>;
      expect(oldValue.employeeId).toBe(data.employee.id);
      expect(oldValue.date).toBe(DAY);
      expect(oldValue.reason).toBe(REASON);
      expect(oldValue.snapshot).toEqual(stored.snapshot);
      const newValue = audits[0].newValue as Record<string, unknown>;
      expect(newValue.auditReason).toBe("Quittung war irrtümlich");
      expect(newValue.deletedAt).toBeTruthy();

      const warnings = await checkArbZG(app.prisma, data.employee.id, dateOf(DAY));
      const short = warnings.find((w) => w.code === "BREAK_TOO_SHORT");
      expect(short?.severity).toBe("warning"); // 8 h net: the > 6 h branch is a warning anyway
      expect(short?.waived).toBeUndefined();

      const again = await delAck(manager.token, ackId);
      expect(again.statusCode).toBe(404);
      expect(errorOf(again)).toBe("Quittung nicht gefunden");
    });

    it("a revoke does not resurrect the dismissed notices: the acknowledged day stays dismissed and nothing new is created", async () => {
      twoSalonDay(data.employee.id);
      const notice = await seedViolationNotice(data.adminUser.id, data.employee.id, DAY);
      const created = await postAck(data.adminToken, ackBody(data.employee.id));
      const ackId = (JSON.parse(created.body) as { acknowledgement: { id: string } })
        .acknowledgement.id;
      const before = await app.prisma.notification.findUniqueOrThrow({ where: { id: notice.id } });
      expect(before.dismissedAt).not.toBeNull();

      const manager = await createScopedManager(
        "ack-revoke-notice",
        ["time-entry:update:ZUGEWIESEN"],
        [salonA, salonB],
      );
      expect((await delAck(manager.token, ackId)).statusCode).toBe(204);

      const rows = await app.prisma.notification.findMany({
        where: {
          type: "BREAK_CROSS_SALON_VIOLATION",
          relatedType: "EmployeeDay",
          relatedId: `${data.employee.id}:${DAY}`,
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(notice.id);
      expect(rows[0].dismissedAt?.getTime()).toBe(before.dismissedAt?.getTime());
    });

    it("on an 11 h day the revoke turns the downgraded § 4 finding back into an error", async () => {
      elevenHourDay(data.employee.id);
      const created = await postAck(data.adminToken, ackBody(data.employee.id));
      expect(created.statusCode).toBe(201);
      const ackId = (JSON.parse(created.body) as { acknowledgement: { id: string } })
        .acknowledgement.id;
      const waived = await checkArbZG(app.prisma, data.employee.id, dateOf(DAY));
      expect(waived.find((w) => w.code === "BREAK_TOO_SHORT")?.severity).toBe("warning");

      expect((await delAck(data.adminToken, ackId)).statusCode).toBe(204);
      const back = await checkArbZG(app.prisma, data.employee.id, dateOf(DAY));
      expect(back.find((w) => w.code === "BREAK_TOO_SHORT")?.severity).toBe("error");
    });

    it("a missing or blank reason is 400 before any lookup", async () => {
      twoSalonDay(data.employee.id);
      const ack = await seedAck(data.employee.id);
      expect((await delAck(data.adminToken, ack.id, {})).statusCode).toBe(400);
      const blank = await delAck(data.adminToken, ack.id, { reason: "   " });
      expect(blank.statusCode).toBe(400);
      expect(blank.body).toContain("Begründung ist erforderlich");
      expect((await delAck(data.adminToken, randomUUID(), {})).statusCode).toBe(400);
      expect(
        (await app.prisma.dayBreakAck.findUniqueOrThrow({ where: { id: ack.id } })).deletedAt,
      ).toBeNull();
    });

    it("T-100-09: a foreign tenant's real ack id and an unknown id answer byte-identically; the cross-tenant audit exists only for the real one", async () => {
      const foreignAck = await seedAck(dataB.employee.id);
      const unknownId = randomUUID();
      const foreign = await delAck(data.adminToken, foreignAck.id);
      const unknown = await delAck(data.adminToken, unknownId);
      expect(foreign.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(foreign.statusCode);
      expect(unknown.body).toBe(foreign.body);
      expect(errorOf(foreign)).toBe("Quittung nicht gefunden");
      expect(
        await app.prisma.auditLog.count({
          where: {
            action: "CROSS_TENANT_ACCESS_DENIED",
            entity: "DayBreakAck",
            entityId: foreignAck.id,
          },
        }),
      ).toBe(1);
      expect(
        await app.prisma.auditLog.count({
          where: { action: "CROSS_TENANT_ACCESS_DENIED", entityId: unknownId },
        }),
      ).toBe(0);
      expect(
        (await app.prisma.dayBreakAck.findUniqueOrThrow({ where: { id: foreignAck.id } }))
          .deletedAt,
      ).toBeNull();
    });

    it("a caller holding only time-entry:update:EIGENE is 403 Forbidden", async () => {
      const ack = await seedAck(data.employee.id);
      const res = await delAck(data.empToken, ack.id);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toBe("Forbidden");
    });

    it("D-14: revoking the acknowledgement of the caller's OWN day is 403", async () => {
      const own = await seedAck(data.adminEmployee.id);
      const res = await delAck(data.adminToken, own.id);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toBe(SELF_ACK_MESSAGE);
      expect(
        (await app.prisma.dayBreakAck.findUniqueOrThrow({ where: { id: own.id } })).deletedAt,
      ).toBeNull();
    });

    it("D-13: a manager scoped on salon A only gets the ack-not-found 404 plus SCOPE_ACCESS_DENIED; on A and B: 204", async () => {
      twoSalonDay(data.employee.id);
      const ack = await seedAck(data.employee.id);
      const partial = await createScopedManager(
        "ack-del-a",
        ["time-entry:update:ZUGEWIESEN"],
        [salonA],
      );
      const scopeDenials = () =>
        app.prisma.auditLog.count({
          where: {
            action: "SCOPE_ACCESS_DENIED",
            entity: "EmployeeDay",
            entityId: `${data.employee.id}:${DAY}`,
          },
        });
      const deniedBefore = await scopeDenials();
      const denied = await delAck(partial.token, ack.id);
      expect(denied.statusCode).toBe(404);
      // identical to an unknown id: no within-tenant oracle on acknowledgements out of scope
      const unknown = await delAck(partial.token, randomUUID());
      expect(denied.body).toBe(unknown.body);
      expect(errorOf(denied)).toBe("Quittung nicht gefunden");
      expect(await scopeDenials()).toBe(deniedBefore + 1);
      expect(
        (await app.prisma.dayBreakAck.findUniqueOrThrow({ where: { id: ack.id } })).deletedAt,
      ).toBeNull();

      const full = await createScopedManager(
        "ack-del-ab",
        ["time-entry:update:ZUGEWIESEN"],
        [salonA, salonB],
      );
      expect((await delAck(full.token, ack.id)).statusCode).toBe(204);
    });

    it("a closed month is 403 and a locked entry of the day is 409", async () => {
      twoSalonDay(data.employee.id, CLOSED_DAY);
      const closedAck = await seedAck(data.employee.id, CLOSED_DAY);
      const snapshot = await closeMonth(data.employee.id, 2026, 2);
      try {
        const res = await delAck(data.adminToken, closedAck.id);
        expect(res.statusCode).toBe(403);
        expect(errorOf(res)).toBe(MONTH_CLOSED_MESSAGE);
        expect(
          (await app.prisma.dayBreakAck.findUniqueOrThrow({ where: { id: closedAck.id } }))
            .deletedAt,
        ).toBeNull();
      } finally {
        await app.prisma.saldoSnapshot.delete({ where: { id: snapshot.id } });
      }

      twoSalonDay(data.employee.id, LOCKED_DAY, { isLocked: true });
      const lockedAck = await seedAck(data.employee.id, LOCKED_DAY);
      const locked = await delAck(data.adminToken, lockedAck.id);
      expect(locked.statusCode).toBe(409);
      expect(errorOf(locked)).toBe(ENTRY_LOCKED_MESSAGE);
    });

    it("there is no update route — PATCH and PUT answer 404", async () => {
      const ack = await seedAck(data.employee.id);
      for (const method of ["PATCH", "PUT"] as const) {
        const res = await app.inject({
          method,
          url: `/api/v1/day-breaks/acks/${ack.id}`,
          headers: { authorization: `Bearer ${data.adminToken}` },
          payload: { reason: "geändert" },
        });
        expect(res.statusCode).toBe(404);
      }
    });
  });
});
