// Issue #80 (D-02, D-05, D-06, D-21) — POST /api/v1/day-breaks (DELETE and D-19 follow in Task 2).
//
// A multi-entry day cannot exist in the database while the partial unique index
// `TimeEntry_employeeId_date_unique_not_deleted` holds, so the day lookup `findEntriesOfDay` is
// mocked for the constructed days only and delegates to the real implementation for every other
// date. Everything else is real: employees, salons, role assignments, the month lock, DayBreak
// rows and the audit log. Against real data (one entry per day) every create is a 409 — that is the
// production reality today and is asserted too.

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
const REAL_DAY = "2026-03-12"; // one real entry in the database
const CLOSED_DAY = "2026-02-10"; // constructed day inside a closed month
const mockedLookup = vi.mocked(findEntriesOfDay);

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}
function at(hhmm: string, day = DAY): string {
  return `${day}T${hhmm}:00.000Z`;
}

describe("Issue #80 — /api/v1/day-breaks", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  let realEntryId: string;
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

  function twoSalonDay(employeeId: string, day = DAY, opts: { isLocked?: boolean } = {}) {
    constructedDays.set(`${employeeId}:${day}`, [
      row(employeeId, day, salonA, "08:00", "12:00", opts),
      row(employeeId, day, salonB, "12:30", "16:30", opts),
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
        lastName: "DayBreakTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    const name = `DayBreak ${crypto.randomBytes(3).toString("hex")}`;
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
    return { token: await login(user.email), email: user.email };
  }

  function post(token: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/day-breaks",
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  function gapBreak(employeeId: string, day = DAY, start = "12:00", end = "12:30") {
    return { employeeId, date: day, startTime: at(start, day), endTime: at(end, day) };
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "daybreaks-80");
    dataB = await seedTestData(app, "daybreaks-80-b");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Zweiter Salon" })).id;

    const actual = await vi.importActual<typeof import("../../day-entries")>("../../day-entries");
    mockedLookup.mockImplementation(async (db, params) => {
      const constructed = constructedDays.get(
        `${params.employeeId}:${params.date.toISOString().slice(0, 10)}`,
      );
      return constructed ?? actual.findEntriesOfDay(db, params);
    });

    const real = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: dateOf(REAL_DAY),
        startTime: new Date(at("08:00", REAL_DAY)),
        endTime: new Date(at("16:00", REAL_DAY)),
        salonId: salonA,
      },
    });
    realEntryId = real.id;
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
    await app.prisma.dayBreak.deleteMany({
      where: { employeeId: { in: [data.employee.id, dataB.employee.id] } },
    });
  });

  // ── Task 1: POST ──────────────────────────────────────────────────────────

  describe("POST / — create a gap break (D-02, D-05, D-06)", () => {
    it("the owner records a break in the real gap: 201, one row, one audit row in the same write", async () => {
      twoSalonDay(data.employee.id);
      const res = await post(data.empToken, gapBreak(data.employee.id));
      expect(res.statusCode).toBe(201);
      const { dayBreak } = JSON.parse(res.body) as {
        dayBreak: { id: string; employeeId: string; startTime: string; endTime: string };
      };
      expect(dayBreak.employeeId).toBe(data.employee.id);
      expect(dayBreak.startTime).toBe(at("12:00"));
      expect(dayBreak.endTime).toBe(at("12:30"));

      const rows = await app.prisma.dayBreak.findMany({ where: { employeeId: data.employee.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].createdBy).toBe(data.empUser.id);
      expect(rows[0].deletedAt).toBeNull();
      expect(rows[0].date.toISOString().slice(0, 10)).toBe(DAY);

      const audits = await app.prisma.auditLog.findMany({
        where: { action: "DAY_BREAK_CREATE", entityId: dayBreak.id },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].entity).toBe("DayBreak");
      expect(audits[0].userId).toBe(data.empUser.id);
      const newValue = audits[0].newValue as Record<string, string>;
      expect(newValue.employeeId).toBe(data.employee.id);
      expect(newValue.date).toBe(DAY);
      expect(newValue.startTime).toBe(at("12:00"));
      expect(newValue.endTime).toBe(at("12:30"));
    });

    it("80-AC3: after the break is recorded, checkArbZG reports no § 4 violation for the 4 h + 4 h day", async () => {
      twoSalonDay(data.employee.id);
      const before = await checkArbZG(app.prisma, data.employee.id, dateOf(DAY));
      expect(before.some((w) => w.code === "BREAK_TOO_SHORT")).toBe(true);

      const res = await post(data.empToken, gapBreak(data.employee.id));
      expect(res.statusCode).toBe(201);

      const after = await checkArbZG(app.prisma, data.employee.id, dateOf(DAY));
      expect(after.some((w) => w.code === "BREAK_TOO_SHORT")).toBe(false);
    });

    it("production reality (P-8): against the real database one entry per day leaves no gap, so every request is 409", async () => {
      const res = await post(data.empToken, gapBreak(data.employee.id, REAL_DAY, "12:00", "12:30"));
      expect(res.statusCode).toBe(409);
      expect((JSON.parse(res.body) as { error: string }).error).toBe(
        "Die Pause muss vollständig in einer Lücke zwischen zwei abgeschlossenen Einträgen dieses Tages liegen.",
      );
      expect(await app.prisma.dayBreak.count({ where: { employeeId: data.employee.id } })).toBe(0);
    });

    it("80-AC5: the call writes no TimeEntry — count and updatedAt of every real entry are unchanged", async () => {
      twoSalonDay(data.employee.id);
      const countBefore = await app.prisma.timeEntry.count({
        where: { employeeId: data.employee.id },
      });
      const realBefore = await app.prisma.timeEntry.findUniqueOrThrow({
        where: { id: realEntryId },
      });
      const breaksBefore = await app.prisma.break.count({ where: { timeEntryId: realEntryId } });

      expect((await post(data.empToken, gapBreak(data.employee.id))).statusCode).toBe(201);
      expect(
        (await post(data.empToken, gapBreak(data.employee.id, REAL_DAY, "12:00", "12:30")))
          .statusCode,
      ).toBe(409);

      expect(await app.prisma.timeEntry.count({ where: { employeeId: data.employee.id } })).toBe(
        countBefore,
      );
      const realAfter = await app.prisma.timeEntry.findUniqueOrThrow({
        where: { id: realEntryId },
      });
      expect(realAfter.updatedAt.getTime()).toBe(realBefore.updatedAt.getTime());
      expect(await app.prisma.break.count({ where: { timeEntryId: realEntryId } })).toBe(
        breaksBefore,
      );
    });
  });

  // ── Task 2: negative paths of POST ────────────────────────────────────────

  describe("POST / — guards", () => {
    it("a reversed interval is 400", async () => {
      twoSalonDay(data.employee.id);
      const res = await post(data.empToken, gapBreak(data.employee.id, DAY, "12:30", "12:00"));
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as { error: string }).error).toBe(
        "Pausenende muss nach Pausenbeginn liegen",
      );
    });

    it("an interval overlapping an entry is 409 with the gap message", async () => {
      twoSalonDay(data.employee.id);
      const res = await post(data.empToken, gapBreak(data.employee.id, DAY, "11:45", "12:15"));
      expect(res.statusCode).toBe(409);
      expect((JSON.parse(res.body) as { error: string }).error).toContain("Lücke");
    });

    it("an interval overlapping an existing day break is 409 with the overlap message", async () => {
      twoSalonDay(data.employee.id);
      expect(
        (await post(data.empToken, gapBreak(data.employee.id, DAY, "12:00", "12:20"))).statusCode,
      ).toBe(201);
      const res = await post(data.empToken, gapBreak(data.employee.id, DAY, "12:10", "12:30"));
      expect(res.statusCode).toBe(409);
      expect((JSON.parse(res.body) as { error: string }).error).toBe(
        "Die Pause überschneidet sich mit einer bereits erfassten Tagespause.",
      );
    });

    it("a user whose role lacks time-entry:update is 403", async () => {
      twoSalonDay(data.employee.id);
      const reader = await createScopedManager(
        "db-reader",
        ["time-entry:read:ZUGEWIESEN"],
        [salonA, salonB],
      );
      const res = await post(reader.token, gapBreak(data.employee.id));
      expect(res.statusCode).toBe(403);
      expect((JSON.parse(res.body) as { error: string }).error).toBe("Kein Zugriff");
    });

    it("an EIGENE caller naming another employee is 403 Kein Zugriff", async () => {
      twoSalonDay(data.adminEmployee.id);
      const res = await post(data.empToken, gapBreak(data.adminEmployee.id));
      expect(res.statusCode).toBe(403);
      expect((JSON.parse(res.body) as { error: string }).error).toBe("Kein Zugriff");
    });

    it("a ZUGEWIESEN caller: a foreign tenant's employee and a random uuid answer identically (404)", async () => {
      const foreign = await post(data.adminToken, gapBreak(dataB.employee.id));
      const unknown = await post(data.adminToken, gapBreak(randomUUID()));
      expect(foreign.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(foreign.statusCode);
      expect(unknown.body).toBe(foreign.body);
      expect((JSON.parse(foreign.body) as { error: string }).error).toBe(
        "Mitarbeiter nicht gefunden",
      );
    });

    it("a manager scoped on salon A only cannot record on an A+B day of another employee: 404 plus SCOPE_ACCESS_DENIED", async () => {
      twoSalonDay(data.employee.id);
      const mgr = await createScopedManager("db-mgr-a", ["time-entry:update:ZUGEWIESEN"], [salonA]);
      const res = await post(mgr.token, gapBreak(data.employee.id));
      expect(res.statusCode).toBe(404);
      expect((JSON.parse(res.body) as { error: string }).error).toBe("Eintrag nicht gefunden");
      const audits = await app.prisma.auditLog.findMany({
        where: {
          action: "SCOPE_ACCESS_DENIED",
          entity: "EmployeeDay",
          entityId: `${data.employee.id}:${DAY}`,
        },
      });
      expect(audits).toHaveLength(1);
      expect(await app.prisma.dayBreak.count({ where: { employeeId: data.employee.id } })).toBe(0);
    });

    it("a partially scoped manager gets the same 404 for an empty day, without an audit row (no day-has-entries oracle)", async () => {
      const mgr = await createScopedManager("db-mgr-e", ["time-entry:update:ZUGEWIESEN"], [salonA]);
      const emptyDay = "2026-03-20";
      const res = await post(mgr.token, gapBreak(data.employee.id, emptyDay));
      expect(res.statusCode).toBe(404);
      expect((JSON.parse(res.body) as { error: string }).error).toBe("Eintrag nicht gefunden");
      expect(
        await app.prisma.auditLog.count({
          where: { action: "SCOPE_ACCESS_DENIED", entityId: `${data.employee.id}:${emptyDay}` },
        }),
      ).toBe(0);
    });

    it("a manager scoped on salon A and B may record on the A+B day: 201", async () => {
      twoSalonDay(data.employee.id);
      const mgr = await createScopedManager(
        "db-mgr-ab",
        ["time-entry:update:ZUGEWIESEN"],
        [salonA, salonB],
      );
      const res = await post(mgr.token, gapBreak(data.employee.id));
      expect(res.statusCode).toBe(201);
    });

    it("a closed month is 403 with the entry wording", async () => {
      twoSalonDay(data.employee.id, CLOSED_DAY);
      const tz = await getTenantTimezone(app.prisma, data.tenant.id);
      const { start, end } = monthRangeUtc(2026, 2, tz);
      const snapshot = await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: data.employee.id,
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
      try {
        const res = await post(data.empToken, gapBreak(data.employee.id, CLOSED_DAY));
        expect(res.statusCode).toBe(403);
        expect((JSON.parse(res.body) as { error: string }).error).toBe(
          "Monat ist abgeschlossen und kann nicht bearbeitet werden",
        );
      } finally {
        await app.prisma.saldoSnapshot.delete({ where: { id: snapshot.id } });
      }
    });

    it("a locked entry of the day is 409", async () => {
      twoSalonDay(data.employee.id, LOCKED_DAY, { isLocked: true });
      const res = await post(data.empToken, gapBreak(data.employee.id, LOCKED_DAY));
      expect(res.statusCode).toBe(409);
      expect((JSON.parse(res.body) as { error: string }).error).toBe(
        "Eintrag ist gesperrt und kann nicht bearbeitet werden",
      );
    });
  });
});
