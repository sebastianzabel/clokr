// Issue #511 (D-18, A11) — POST /api/v1/day-breaks/preview.
//
// The entry form asks the server kernel which findings a PROPOSED entry would produce together with
// the day's other closed entries. The route evaluates and answers: it writes no TimeEntry, Break,
// DayBreak or DayBreakAck and no audit row. All data is real (single entries per employee and day
// satisfy the unique index); only the month lock is a SaldoSnapshot, as in the other day-break tests.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import crypto, { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../../../__tests__/setup";
import { normalizeRolePermissions, roleNameKey } from "../../../platform";
import { getTenantTimezone, monthRangeUtc } from "../../../working-time-account";

const PASSWORD = "test1234";
const DAY = "2026-05-12";
const OTHER_DAY = "2026-05-13";
const CLOSED_DAY = "2026-02-10";
const MONTH_CLOSED_MESSAGE = "Monat ist abgeschlossen und kann nicht bearbeitet werden";

interface PreviewWarning {
  code: string;
  severity: string;
  message: string;
  certainty?: string;
  legalBasis?: string;
  hint?: true;
  waived?: true;
}

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}
function at(hhmm: string, day = DAY): string {
  return `${day}T${hhmm}:00.000Z`;
}
function errorOf(res: { body: string }): string {
  return (JSON.parse(res.body) as { error: string }).error;
}
function slot(start: string, end: string, day = DAY) {
  return { startTime: at(start, day), endTime: at(end, day) };
}

describe("Issue #511 — POST /api/v1/day-breaks/preview", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  async function createScopedUser(label: string, permissions: string[], salonIds: string[]) {
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
        lastName: "DayBreakPreviewTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    const name = `DayBreakPreview ${crypto.randomBytes(3).toString("hex")}`;
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
    return { token: await login(user.email) };
  }

  function preview(token: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/day-breaks/preview",
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  function proposal(
    employeeId: string,
    start: string,
    end: string,
    breaks: Array<{ startTime: string; endTime: string }> = [],
    extra: Record<string, unknown> = {},
  ) {
    return { employeeId, date: DAY, ...slot(start, end), breaks, ...extra };
  }

  async function warningsOf(token: string, body: Record<string, unknown>) {
    const res = await preview(token, body);
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { warnings: PreviewWarning[] }).warnings;
  }

  async function seedEntry(
    employeeId: string,
    day: string,
    start: string,
    end: string,
    salonId = salonA,
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: dateOf(day),
        startTime: new Date(at(start, day)),
        endTime: new Date(at(end, day)),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
        salonId,
      },
    });
  }

  async function writeCounts() {
    return {
      entries: await app.prisma.timeEntry.count(),
      breaks: await app.prisma.break.count(),
      dayBreaks: await app.prisma.dayBreak.count(),
      acks: await app.prisma.dayBreakAck.count(),
      audits: await app.prisma.auditLog.count(),
    };
  }

  async function cleanDays() {
    const ids = [data.employee.id, data.adminEmployee.id];
    await app.prisma.break.deleteMany({ where: { timeEntry: { employeeId: { in: ids } } } });
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: { in: ids } } });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "daybreakpreview-511");
    dataB = await seedTestData(app, "daybreakpreview-511-b");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Zweiter Salon" })).id;
  });

  afterAll(async () => {
    try {
      await cleanDays();
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, dataB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(cleanDays);

  describe("evaluation through the kernel", () => {
    it("an EIGENE caller previews the own new entry 08:00-15:00: a break at 14:01 leaves 6:01 h at a stretch (BREAK_TOO_LATE), a break at 14:00 does not", async () => {
      const late = await warningsOf(
        data.empToken,
        proposal(data.employee.id, "08:00", "15:00", [slot("14:01", "14:31")]),
      );
      expect(late.map((w) => w.code)).toContain("BREAK_TOO_LATE");
      for (const w of late) expect(w.message.length).toBeGreaterThan(10);

      const exact = await warningsOf(
        data.empToken,
        proposal(data.employee.id, "08:00", "15:00", [slot("14:00", "14:30")]),
      );
      expect(exact.map((w) => w.code)).not.toContain("BREAK_TOO_LATE");
    });

    it("an entry without any break answers the Satz-1 shortfall and the Satz-3 finding with server messages", async () => {
      const w = await warningsOf(data.empToken, proposal(data.employee.id, "08:00", "15:00"));
      const codes = w.map((x) => x.code);
      expect(codes).toContain("BREAK_TOO_SHORT");
      expect(codes).toContain("BREAK_TOO_LATE");
    });

    it("with entryId the proposal REPLACES that stored entry; without it the stored entry counts as well", async () => {
      const stored = await seedEntry(data.employee.id, DAY, "08:00", "15:00");
      const replacing = await warningsOf(
        data.empToken,
        proposal(data.employee.id, "08:00", "12:00", [], { entryId: stored.id }),
      );
      expect(replacing).toEqual([]);

      // Control: the same proposal as a NEW entry sits next to the stored one (11 h in total).
      const added = await warningsOf(data.empToken, proposal(data.employee.id, "08:00", "12:00"));
      expect(added.map((w) => w.code)).toContain("MAX_DAILY_EXCEEDED");
    });

    it("an isTimeTrackingExempt employee gets no warnings (§ 18 ArbZG); the control without the flag does", async () => {
      const body = proposal(data.employee.id, "08:00", "15:00");
      expect((await warningsOf(data.adminToken, body)).length).toBeGreaterThan(0);
      await app.prisma.employee.update({
        where: { id: data.employee.id },
        data: { isTimeTrackingExempt: true },
      });
      try {
        expect(await warningsOf(data.adminToken, body)).toEqual([]);
      } finally {
        await app.prisma.employee.update({
          where: { id: data.employee.id },
          data: { isTimeTrackingExempt: false },
        });
      }
    });
  });

  describe("no side effects (T-511-18)", () => {
    it("row counts of TimeEntry, Break, DayBreak, DayBreakAck and AuditLog are identical after every kind of preview call", async () => {
      const stored = await seedEntry(data.employee.id, OTHER_DAY, "08:00", "12:00");
      await app.prisma.break.create({
        data: {
          timeEntryId: stored.id,
          startTime: new Date(at("10:00", OTHER_DAY)),
          endTime: new Date(at("10:15", OTHER_DAY)),
        },
      });
      const before = await writeCounts();
      expect(before.entries).toBeGreaterThan(0);
      expect(before.breaks).toBeGreaterThan(0);

      await warningsOf(
        data.empToken,
        proposal(data.employee.id, "08:00", "17:00", [slot("12:00", "12:30")]),
      );
      await warningsOf(
        data.adminToken,
        proposal(data.employee.id, "08:00", "15:00", [], { date: OTHER_DAY, entryId: stored.id }),
      );
      expect(
        (await preview(data.empToken, proposal(data.adminEmployee.id, "08:00", "09:00")))
          .statusCode,
      ).toBe(403);
      expect(
        (await preview(data.adminToken, proposal(randomUUID(), "08:00", "09:00"))).statusCode,
      ).toBe(404);
      expect(
        (
          await preview(data.adminToken, {
            ...proposal(data.employee.id, "08:00", "09:00"),
            date: CLOSED_DAY,
          })
        ).statusCode,
      ).toBe(200);

      expect(await writeCounts()).toEqual(before);
    });
  });

  describe("authorization and tenant binding (T-511-16, T-511-19)", () => {
    it("an EIGENE caller naming another employee is 403", async () => {
      const res = await preview(data.empToken, proposal(data.adminEmployee.id, "08:00", "15:00"));
      expect(res.statusCode).toBe(403);
    });

    it("a caller holding neither time-entry:create nor time-entry:update is 403; create alone cannot preview WITH an entryId", async () => {
      const none = await createScopedUser("prev-none", ["employee:read:ZUGEWIESEN"], [salonA]);
      expect(
        (await preview(none.token, proposal(data.employee.id, "08:00", "15:00"))).statusCode,
      ).toBe(403);

      const createOnly = await createScopedUser(
        "prev-create",
        ["time-entry:create:ZUGEWIESEN"],
        [salonA, salonB],
      );
      const ok = await preview(createOnly.token, proposal(data.employee.id, "08:00", "15:00"));
      expect(ok.statusCode).toBe(200);
      const withEntry = await preview(
        createOnly.token,
        proposal(data.employee.id, "08:00", "15:00", [], { entryId: randomUUID() }),
      );
      expect(withEntry.statusCode).toBe(403);
    });

    it("a foreign tenant's employee and an unknown uuid answer byte-identically (404)", async () => {
      const foreign = await preview(data.adminToken, proposal(dataB.employee.id, "08:00", "15:00"));
      const unknown = await preview(data.adminToken, proposal(randomUUID(), "08:00", "15:00"));
      expect(foreign.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(foreign.statusCode);
      expect(unknown.body).toBe(foreign.body);
      expect(errorOf(foreign)).toBe("Mitarbeiter nicht gefunden");
    });

    it("a manager whose scope misses a salon of the day gets the entry-404 and NO SCOPE_ACCESS_DENIED audit row; a covering manager gets 200", async () => {
      // The employee's stored entry of the day lies in salon B.
      await seedEntry(data.employee.id, DAY, "08:00", "10:00", salonB);
      const onlyA = await createScopedUser(
        "prev-mgr-a",
        ["time-entry:create:ZUGEWIESEN", "time-entry:update:ZUGEWIESEN"],
        [salonA],
      );
      const auditsBefore = await app.prisma.auditLog.count({
        where: { action: "SCOPE_ACCESS_DENIED" },
      });
      const denied = await preview(
        onlyA.token,
        proposal(data.employee.id, "12:00", "15:00", [], { salonId: salonA }),
      );
      expect(denied.statusCode).toBe(404);
      expect(errorOf(denied)).toBe("Eintrag nicht gefunden");
      expect(await app.prisma.auditLog.count({ where: { action: "SCOPE_ACCESS_DENIED" } })).toBe(
        auditsBefore,
      );

      const both = await createScopedUser(
        "prev-mgr-ab",
        ["time-entry:create:ZUGEWIESEN", "time-entry:update:ZUGEWIESEN"],
        [salonA, salonB],
      );
      const ok = await preview(
        both.token,
        proposal(data.employee.id, "12:00", "15:00", [], { salonId: salonA }),
      );
      expect(ok.statusCode).toBe(200);
    });

    it("an explicit salon of another tenant is the write route's 404", async () => {
      const res = await preview(
        data.adminToken,
        proposal(data.employee.id, "08:00", "15:00", [], { salonId: dataB.salonId }),
      );
      expect(res.statusCode).toBe(404);
      expect(errorOf(res)).toBe("Salon nicht gefunden");
    });
  });

  describe("guards and validation", () => {
    it("a closed month is 403 with the month-closed wording", async () => {
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
        const res = await preview(data.adminToken, {
          employeeId: data.employee.id,
          date: CLOSED_DAY,
          ...slot("08:00", "15:00", CLOSED_DAY),
          breaks: [],
        });
        expect(res.statusCode).toBe(403);
        expect(errorOf(res)).toBe(MONTH_CLOSED_MESSAGE);
      } finally {
        await app.prisma.saldoSnapshot.delete({ where: { id: snapshot.id } });
      }
    });

    it("more than 20 breaks and an end that is not after the start are 400", async () => {
      const many = Array.from({ length: 21 }, () => slot("10:00", "10:01"));
      expect(
        (await preview(data.empToken, proposal(data.employee.id, "08:00", "15:00", many)))
          .statusCode,
      ).toBe(400);
      expect(
        (await preview(data.empToken, proposal(data.employee.id, "15:00", "08:00"))).statusCode,
      ).toBe(400);
      expect(
        (await preview(data.empToken, proposal(data.employee.id, "15:00", "15:00"))).statusCode,
      ).toBe(400);
      expect(
        (
          await preview(
            data.empToken,
            proposal(data.employee.id, "08:00", "15:00", [slot("12:30", "12:00")]),
          )
        ).statusCode,
      ).toBe(400);
      // Control: exactly 20 breaks are accepted.
      const twenty = Array.from({ length: 20 }, (_, i) =>
        slot(`10:${String(i * 2).padStart(2, "0")}`, `10:${String(i * 2 + 1).padStart(2, "0")}`),
      );
      expect(
        (await preview(data.empToken, proposal(data.employee.id, "08:00", "15:00", twenty)))
          .statusCode,
      ).toBe(200);
    });

    it("an unauthenticated request is 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/day-breaks/preview",
        payload: proposal(data.employee.id, "08:00", "15:00"),
      });
      expect(res.statusCode).toBe(401);
    });
  });
  // ── The preview applies the automatic break the save would place (new entries only) ──────────
  // `POST /time-entries` places an automatic break when the tenant has autoBreakEnabled and the
  // caller sent no break slots and no break minutes. Without the same decision here the form would
  // warn about a missing break that the save itself prevents. The decision is `planAutoBreak` /
  // `autoBreakAppliesOnCreate` - the very functions the POST uses, not a copy. The PUT route places
  // no automatic break (no call to the plan in the edit handler), so an edit is never simulated.
  describe("automatic break of a new entry", () => {
    interface PreviewAnswer {
      warnings: PreviewWarning[];
      autoBreakApplied: {
        start: string;
        end: string;
        minutes: number;
        segments: Array<{ start: string; end: string }>;
      } | null;
    }

    async function answerOf(token: string, body: Record<string, unknown>): Promise<PreviewAnswer> {
      const res = await preview(token, body);
      expect(res.statusCode, res.body).toBe(200);
      return JSON.parse(res.body) as PreviewAnswer;
    }

    async function setAutoBreak(enabled: boolean) {
      await app.prisma.tenantConfig.update({
        where: { tenantId: data.tenant.id },
        data: {
          autoBreakEnabled: enabled,
          defaultBreakStart: null,
          // The POST control below writes into the past.
          retroEntryWindowDays: 3650,
        },
      });
    }

    afterEach(async () => {
      await setAutoBreak(false);
      await app.prisma.employee.update({
        where: { id: data.employee.id },
        data: { birthDate: null },
      });
    });

    it("a new 08:00-17:00 entry without breaks is not warned about a missing break when the save would place one", async () => {
      await setAutoBreak(true);

      const answer = await answerOf(data.empToken, proposal(data.employee.id, "08:00", "17:00"));

      const codes = answer.warnings.map((w) => w.code);
      expect(codes).not.toContain("BREAK_TOO_SHORT");
      expect(codes).not.toContain("BREAK_TOO_LATE");
      expect(answer.autoBreakApplied).not.toBeNull();
      expect(answer.autoBreakApplied!.minutes).toBeGreaterThan(0);
      expect(answer.autoBreakApplied!.segments.length).toBeGreaterThan(0);
      expect(answer.autoBreakApplied!.start).toBe(answer.autoBreakApplied!.segments[0].start);
      expect(answer.autoBreakApplied!.end).toBe(
        answer.autoBreakApplied!.segments[answer.autoBreakApplied!.segments.length - 1].end,
      );
    });

    it("reports exactly the break the save then writes", async () => {
      await setAutoBreak(true);
      const answer = await answerOf(data.empToken, proposal(data.employee.id, "08:00", "17:00"));

      // The control: the real POST of the same proposal on another day (no configured start, so
      // the placement depends only on the entry's own times).
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: OTHER_DAY,
          startTime: at("08:00", OTHER_DAY),
          endTime: at("17:00", OTHER_DAY),
          breakMinutes: 0,
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const written = await app.prisma.break.findMany({
        where: { timeEntry: { employeeId: data.employee.id, date: dateOf(OTHER_DAY) } },
        orderBy: { startTime: "asc" },
      });
      expect(written.length, "anti-vacuity: the save placed a break").toBeGreaterThan(0);

      const dayShift = dateOf(OTHER_DAY).getTime() - dateOf(DAY).getTime();
      expect(
        answer.autoBreakApplied!.segments.map((g) => [
          new Date(g.start).getTime() + dayShift,
          new Date(g.end).getTime() + dayShift,
        ]),
      ).toEqual(written.map((b) => [b.startTime.getTime(), b.endTime.getTime()]));
      const stored = await app.prisma.timeEntry.findFirstOrThrow({
        where: { employeeId: data.employee.id, date: dateOf(OTHER_DAY) },
      });
      expect(answer.autoBreakApplied!.minutes).toBe(stored.breakMinutes);
    });

    it("with autoBreakEnabled off the findings stay and no automatic break is reported", async () => {
      await setAutoBreak(false);

      const answer = await answerOf(data.empToken, proposal(data.employee.id, "08:00", "17:00"));

      const codes = answer.warnings.map((w) => w.code);
      expect(codes).toContain("BREAK_TOO_SHORT");
      expect(codes).toContain("BREAK_TOO_LATE");
      expect(answer.autoBreakApplied).toBeNull();
    });

    it("explicit break slots or break minutes switch the simulation off (the save places none)", async () => {
      await setAutoBreak(true);

      const withSlot = await answerOf(
        data.empToken,
        proposal(data.employee.id, "08:00", "17:00", [slot("14:30", "14:45")]),
      );
      expect(withSlot.autoBreakApplied).toBeNull();
      expect(
        withSlot.warnings.map((w) => w.code),
        "the 15 min slot is a real Satz-1 shortfall",
      ).toContain("BREAK_TOO_SHORT");

      const withMinutes = await answerOf(
        data.empToken,
        proposal(data.employee.id, "08:00", "17:00", [], { breakMinutes: 10 }),
      );
      expect(withMinutes.autoBreakApplied).toBeNull();
      expect(withMinutes.warnings.map((w) => w.code)).toContain("BREAK_TOO_SHORT");
    });

    it("an edit (entryId) is never simulated: the PUT route places no automatic break", async () => {
      await setAutoBreak(true);
      const stored = await seedEntry(data.employee.id, DAY, "08:00", "17:00");

      const answer = await answerOf(
        data.empToken,
        proposal(data.employee.id, "08:00", "17:00", [], { entryId: stored.id }),
      );
      expect(answer.autoBreakApplied).toBeNull();
      expect(answer.warnings.map((w) => w.code)).toContain("BREAK_TOO_SHORT");

      // The claim behind it, measured on the real edit route: it writes no Break row.
      const put = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${stored.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { endTime: at("17:30"), reason: "Korrektur Endzeit" },
      });
      expect(put.statusCode, put.body).toBe(200);
      expect(await app.prisma.break.count({ where: { timeEntryId: stored.id } })).toBe(0);
    });

    it("a minor gets the automatic break amount of § 11 JArbSchG in the preview, too", async () => {
      await setAutoBreak(true);
      await app.prisma.employee.update({
        where: { id: data.employee.id },
        data: { birthDate: new Date("2010-03-01T00:00:00.000Z") },
      });

      const answer = await answerOf(data.empToken, proposal(data.employee.id, "08:00", "13:00"));

      expect(answer.autoBreakApplied?.minutes, "5 h presence: 30 min for a minor").toBe(30);
      expect(answer.warnings.map((w) => w.code)).not.toContain("BREAK_TOO_SHORT");
    });

    it("writes nothing and audits nothing while simulating", async () => {
      await setAutoBreak(true);
      const stored = await seedEntry(data.employee.id, OTHER_DAY, "08:00", "12:00");
      await app.prisma.break.create({
        data: {
          timeEntryId: stored.id,
          startTime: new Date(at("10:00", OTHER_DAY)),
          endTime: new Date(at("10:15", OTHER_DAY)),
        },
      });
      const before = await writeCounts();
      expect(before.entries).toBeGreaterThan(0);
      expect(before.breaks).toBeGreaterThan(0);

      const answer = await answerOf(data.empToken, proposal(data.employee.id, "08:00", "17:00"));
      expect(answer.autoBreakApplied, "anti-vacuity: the simulation ran").toBeTruthy();

      expect(await writeCounts()).toEqual(before);
    });
  });
});
