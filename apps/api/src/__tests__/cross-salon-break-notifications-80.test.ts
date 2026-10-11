/**
 * Issue #80 (D-09e, D-10, D-11, D-13, D-18) and Issue #511 (D-13) — the next-day cron that tells
 * managers about an unacknowledged § 4 ArbZG / § 11 JArbSchG break finding of a previous day, once
 * per recipient, employee and day: the cross-salon Satz-1 shortfall as
 * BREAK_CROSS_SALON_VIOLATION, every other finding (Satz 2 / Satz 3) as BREAK_PLACEMENT_VIOLATION.
 *
 * A multi-entry day cannot exist in the database while the partial unique index
 * `TimeEntry_employeeId_date_unique_not_deleted` holds, so the closed-WORK-entry read of the
 * facade (`getWorkedEntriesInRange`, T2) is mocked for the constructed days only: for the test
 * employee and day the constructed two-salon rows replace the real row; every other employee and
 * day delegates to the real implementation. Everything else is real: tenant, salons, employees,
 * role assignments, DayBreakAck rows, notifications.
 *
 * Fixture names are neutral labels, never person names.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import crypto, { randomUUID } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, cleanupTestData, createTestSalon } from "./setup";
import { daysAgoStrInTz } from "./test-dates";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";
import { evaluateDayBreaks } from "../contexts/time-tracking/day-break-rule";
import {
  CROSS_SALON_NOTICE_TITLE,
  BREAK_PLACEMENT_NOTICE_TITLE,
} from "../contexts/time-tracking/break-finding-notice";

// The transporter is built inline in the notify plugin through a dynamic import, so mocking
// nodemailer captures the real mail that would leave the server (subject and HTML body).
const { sendMailMock } = vi.hoisted(() => ({ sendMailMock: vi.fn() }));
vi.mock("nodemailer", () => {
  const createTransport = vi.fn(() => ({ sendMail: sendMailMock }));
  return { default: { createTransport }, createTransport };
});

vi.mock("../contexts/time-tracking/facade/time-entries", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../contexts/time-tracking/facade/time-entries")>();
  return { ...original, getWorkedEntriesInRange: vi.fn(original.getWorkedEntriesInRange) };
});

import { getWorkedEntriesInRange } from "../contexts/time-tracking/facade/time-entries";

const TZ = "Europe/Berlin";
const PASSWORD = "test1234";
const NOTIFICATION_TYPE = "BREAK_CROSS_SALON_VIOLATION";
const PLACEMENT_TYPE = "BREAK_PLACEMENT_VIOLATION";
const CLOCK_TIME = /\d{1,2}:\d{2}/;
const SMTP_CONFIGURED = {
  smtpHost: "smtp.test.local",
  smtpPort: 587,
  smtpUser: "smtp-user",
  smtpPassword: "smtp-pass",
  smtpFromEmail: "noreply@test.local",
  smtpFromName: "Clokr Test",
  smtpSecure: false,
};
const MANAGER_PERMISSIONS = ["time-entry:update:ZUGEWIESEN", "time-entry:read:ZUGEWIESEN"];

type T2Row = Awaited<ReturnType<typeof getWorkedEntriesInRange>>[number];

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** A tenant-local wall-clock time on `day` as the UTC instant the database stores. */
function localInstant(day: string, hhmm: string): Date {
  return fromZonedTime(`${day}T${hhmm}:00`, TZ);
}

describe("Issue #80 — next-day cross-salon § 4 notification (Feature 10)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonA: string;
  let salonB: string;
  let salonC = "";
  let adminUserId: string;
  let adminEmail: string;
  let mgrA: Awaited<ReturnType<typeof createScopedManager>>;
  let mgrAB: Awaited<ReturnType<typeof createScopedManager>>;
  let mgrC: Awaited<ReturnType<typeof createScopedManager>>;
  let seq = 0;
  const salonName: Record<string, string> = {};
  /** employeeId -> constructed T2 rows (replace the employee's real rows on those days). */
  const constructed = new Map<string, T2Row[]>();

  const yesterday = () => daysAgoStrInTz(new Date(), 1, TZ);

  function row(
    employeeId: string,
    day: string,
    salonId: string,
    start: string,
    end: string,
    breakMinutes = 0,
  ): T2Row {
    return {
      id: randomUUID(),
      employeeId,
      date: dateOf(day),
      startTime: localInstant(day, start),
      endTime: localInstant(day, end),
      breakMinutes,
      breakStatus: "CONFIRMED",
      isLocked: false,
      salonId,
    } as T2Row;
  }

  function addRows(employeeId: string, rows: T2Row[]): T2Row[] {
    constructed.set(employeeId, [...(constructed.get(employeeId) ?? []), ...rows]);
    return rows;
  }

  /** 8 h net across two salons with a 30 min travel gap: a § 4 shortfall (08:00-12:00 A, 12:30-16:30 B). */
  function twoSalonDay(employeeId: string, day: string): T2Row[] {
    return addRows(employeeId, [
      row(employeeId, day, salonA, "08:00", "12:00"),
      row(employeeId, day, salonB, "12:30", "16:30"),
    ]);
  }

  async function createUser(label: string, role: "EMPLOYEE" | "ADMIN" | "MANAGER" = "EMPLOYEE") {
    const s = `${label}-${++seq}-${Date.now().toString(36)}`;
    return app.prisma.user.create({
      data: {
        email: `csbn-${s}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        role,
        isActive: true,
      },
    });
  }

  async function createEmployee(
    label: string,
    opts: { role?: "EMPLOYEE" | "ADMIN"; exempt?: boolean } = {},
  ) {
    const user = await createUser(label, opts.role ?? "EMPLOYEE");
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `CSBN-${label}-${seq}-${Date.now().toString(36)}`.slice(0, 30),
        firstName: "Fixture",
        lastName: label,
        hireDate: new Date("2024-01-01T00:00:00Z"),
        isTimeTrackingExempt: opts.exempt ?? false,
      },
    });
    return { user, employee };
  }

  /** A manager holding the update/read ZUGEWIESEN permissions over exactly `salonIds`. */
  async function createScopedManager(label: string, salonIds: string[]) {
    const { user, employee } = await createEmployee(label);
    await assignScopedRole(user.id, salonIds);
    return { user, employee };
  }

  async function assignScopedRole(userId: string, salonIds: string[]) {
    const name = `CSBN ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(MANAGER_PERMISSIONS),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId,
        userId,
        accessRoleId: role.id,
        scopeType: "SALONS",
        salonIds,
        employeeIds: [],
      },
    });
  }

  function notificationsFor(userId: string, employeeId: string, day: string) {
    return app.prisma.notification.findMany({
      where: {
        userId,
        type: NOTIFICATION_TYPE,
        relatedType: "EmployeeDay",
        relatedId: `${employeeId}:${day}`,
      },
    });
  }

  function notificationsOfType(type: string, userId: string, employeeId: string, day: string) {
    return app.prisma.notification.findMany({
      where: { userId, type, relatedType: "EmployeeDay", relatedId: `${employeeId}:${day}` },
    });
  }

  /**
   * A real single-salon entry of `day` (salon A) with real Break rows — the Break rows hang on a
   * persisted entry id, so this day is NOT constructed through the mocked facade read.
   */
  async function realDay(
    employeeId: string,
    day: string,
    start: string,
    end: string,
    breaks: [string, string][],
    breakMinutes = 30,
  ) {
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: dateOf(day),
        startTime: localInstant(day, start),
        endTime: localInstant(day, end),
        breakMinutes,
        breakStatus: "CONFIRMED",
        type: "WORK",
        salonId: salonA,
      },
    });
    for (const [bStart, bEnd] of breaks) {
      await app.prisma.break.create({
        data: {
          timeEntryId: entry.id,
          startTime: localInstant(day, bStart),
          endTime: localInstant(day, bEnd),
        },
      });
    }
    return entry;
  }

  /**
   * A cross-salon day whose only finding is Satz 3: entry A (real, salon A, 08:00-16:00, Break
   * 14:30-15:00 = 6 h 30 min before it) plus a constructed entry B (salon B, 16:00-16:30). The
   * recorded 30 min meet Satz 1, so the day is a PLACEMENT finding spread over two salons.
   */
  async function crossSalonPlacementDay(employeeId: string, day: string) {
    const entry = await realDay(employeeId, day, "08:00", "16:00", [["14:30", "15:00"]]);
    addRows(employeeId, [
      { ...row(employeeId, day, salonA, "08:00", "16:00", 30), id: entry.id },
      row(employeeId, day, salonB, "16:00", "16:30"),
    ]);
  }

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = `csbn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const tenant = await prisma.tenant.create({
      data: { name: `CrossSalonNotify ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    salonName.A = "Salon Alpha";
    salonName.B = "Salon Beta";
    salonName.C = "Salon Gamma";
    salonA = (await createTestSalon(prisma, tenantId, { name: salonName.A })).id;
    salonB = (await createTestSalon(prisma, tenantId, { name: salonName.B })).id;
    salonC = (await createTestSalon(prisma, tenantId, { name: salonName.C })).id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
    });
    // The tenant-wide holder: an ADMIN with no stored assignment resolves through the system role.
    const admin = await createEmployee("admin", { role: "ADMIN", exempt: true });
    adminUserId = admin.user.id;
    adminEmail = admin.user.email;
    mgrA = await createScopedManager("mgr-a", [salonA]);
    mgrAB = await createScopedManager("mgr-ab", [salonA, salonB]);
    mgrC = await createScopedManager("mgr-c", [salonC]);

    const actual = await vi.importActual<
      typeof import("../contexts/time-tracking/facade/time-entries")
    >("../contexts/time-tracking/facade/time-entries");
    vi.mocked(getWorkedEntriesInRange).mockImplementation(async (db, scope, from, to) => {
      const real = await actual.getWorkedEntriesInRange(db, scope, from, to);
      const inScope = (id: string) =>
        scope.kind === "employee"
          ? scope.employeeId === id
          : scope.kind === "employees"
            ? scope.employeeIds.includes(id)
            : true;
      const extra: T2Row[] = [];
      for (const [employeeId, rows] of constructed) {
        if (!inScope(employeeId)) continue;
        for (const r of rows) if (r.date >= from && r.date <= to) extra.push(r);
      }
      if (extra.length === 0) return real;
      const replaced = real.filter(
        (r) =>
          !extra.some(
            (c) => c.employeeId === r.employeeId && c.date.getTime() === r.date.getTime(),
          ),
      );
      return [...replaced, ...extra];
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("cross-salon-break-notifications-80 cleanup:", err);
    }
    await closeTestApp();
  });

  beforeEach(() => {
    constructed.clear();
  });

  describe("tracer: tenant-wide manager, full detail, once (D-09e, D-10, D-13)", () => {
    it("notifies the tenant-wide manager about yesterday's violation with salons, times and a deep link", async () => {
      const x = await createEmployee("tracer-x");
      const day = yesterday();
      twoSalonDay(x.employee.id, day);

      await app.tryBreakFindingCheck();

      const rows = await notificationsFor(adminUserId, x.employee.id, day);
      expect(rows).toHaveLength(1);
      const n = rows[0];
      expect(n.type).toBe(NOTIFICATION_TYPE);
      expect(n.relatedType).toBe("EmployeeDay");
      expect(n.relatedId).toBe(`${x.employee.id}:${day}`);
      expect(n.link).toBe(`/team/time-entries?employeeId=${x.employee.id}&date=${day}`);
      expect(n.message.startsWith("Fixture tracer-x:")).toBe(true);
      expect(n.message).toContain("salonübergreifend");
      expect(n.message).toContain(salonName.A);
      expect(n.message).toContain(salonName.B);
      expect(n.message).toContain("08:00");
      expect(n.message).toContain("16:30");
    });

    it("never notifies the employee about their own day", async () => {
      const x = await createEmployee("tracer-self");
      const day = yesterday();
      twoSalonDay(x.employee.id, day);

      await app.tryBreakFindingCheck();

      const own = await app.prisma.notification.count({
        where: { userId: x.user.id, type: NOTIFICATION_TYPE },
      });
      expect(own).toBe(0);
    });

    it("sends once: a second run creates no further row", async () => {
      const x = await createEmployee("tracer-twice");
      const day = yesterday();
      twoSalonDay(x.employee.id, day);

      await app.tryBreakFindingCheck();
      await app.tryBreakFindingCheck();

      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(1);
    });
  });

  describe("redaction by the recipient's own reach (D-11, T-80-37)", () => {
    it("a manager covering only salon A gets the day total and the finding, nothing of salon B", async () => {
      const x = await createEmployee("redact-x");
      const day = yesterday();
      twoSalonDay(x.employee.id, day);

      await app.tryBreakFindingCheck();

      const [n] = await notificationsFor(mgrA.user.id, x.employee.id, day);
      expect(n, "the salon-A manager is a recipient").toBeDefined();
      expect(n.message).toBe(
        `Fixture redact-x: Am ${germanDate(day)} insgesamt 8 h ohne 30 Min Pause, salonübergreifend.`,
      );
      expect(n.title).toBe(CROSS_SALON_NOTICE_TITLE);
      // Byte level over every user-visible field and the link: neither salon's name or id, and no
      // clock time at all (salon B's 12:30/16:30 and salon A's own 08:00/12:00 alike).
      const visible = [
        n.title,
        n.message,
        n.link ?? "",
        n.type,
        n.relatedType ?? "",
        n.relatedId ?? "",
      ].join("\n");
      for (const forbidden of [
        salonName.A,
        salonName.B,
        salonName.C,
        salonA,
        salonB,
        salonC,
        "12:30",
        "16:30",
        "08:00",
        "12:00",
      ]) {
        expect(visible, `redacted notification must not contain "${forbidden}"`).not.toContain(
          forbidden,
        );
      }
      // The clock-time pattern runs over the text fields only: relatedId is "<uuid>:<date>" and a
      // uuid can end in digits right before its colon.
      expect([n.title, n.message, n.link ?? ""].join("\n")).not.toMatch(CLOCK_TIME);
    });

    it("a manager covering salons A and B gets the full text with both salons and the times", async () => {
      const x = await createEmployee("full-x");
      const day = yesterday();
      twoSalonDay(x.employee.id, day);

      await app.tryBreakFindingCheck();

      const [n] = await notificationsFor(mgrAB.user.id, x.employee.id, day);
      expect(n).toBeDefined();
      expect(n.message).toBe(
        `Fixture full-x: Am ${germanDate(day)} insgesamt 8 h ohne 30 Min Pause, salonübergreifend ` +
          `(${salonName.A} 08:00–12:00, ${salonName.B} 12:30–16:30).`,
      );
    });

    it("a manager covering only salon C receives nothing, while the covering recipients do", async () => {
      const x = await createEmployee("outside-x");
      const day = yesterday();
      twoSalonDay(x.employee.id, day);

      await app.tryBreakFindingCheck();

      expect(await notificationsFor(mgrC.user.id, x.employee.id, day)).toHaveLength(0);
      expect(await notificationsFor(mgrA.user.id, x.employee.id, day)).toHaveLength(1);
      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(1);
    });

    it("the employee never hears about their own day, even holding the permission over both salons", async () => {
      const x = await createEmployee("holder-x");
      await assignScopedRole(x.user.id, [salonA, salonB]);
      const day = yesterday();
      twoSalonDay(x.employee.id, day);

      await app.tryBreakFindingCheck();

      const own = await app.prisma.notification.count({
        where: { userId: x.user.id, type: NOTIFICATION_TYPE },
      });
      expect(own).toBe(0);
      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(1);
    });
  });

  describe("dedup and catch-up (D-10)", () => {
    it("a dismissed notification is not re-created by the next run", async () => {
      const x = await createEmployee("dismiss-x");
      const day = yesterday();
      twoSalonDay(x.employee.id, day);

      await app.tryBreakFindingCheck();
      await app.prisma.notification.updateMany({
        where: {
          userId: adminUserId,
          type: NOTIFICATION_TYPE,
          relatedId: `${x.employee.id}:${day}`,
        },
        data: { dismissedAt: new Date() },
      });
      await app.tryBreakFindingCheck();

      const rows = await notificationsFor(adminUserId, x.employee.id, day);
      expect(rows).toHaveLength(1);
      expect(rows[0].dismissedAt).not.toBeNull();
    });

    it("a day two days ago (a missed run) is notified once", async () => {
      const x = await createEmployee("catchup-x");
      const day = daysAgoStrInTz(new Date(), 2, TZ);
      twoSalonDay(x.employee.id, day);

      await app.tryBreakFindingCheck();
      await app.tryBreakFindingCheck();

      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(1);
    });

    it("a day older than the catch-up window is not notified", async () => {
      const x = await createEmployee("old-x");
      const day = daysAgoStrInTz(new Date(), 5, TZ);
      twoSalonDay(x.employee.id, day);

      await app.tryBreakFindingCheck();

      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(0);
    });
  });

  describe("only § 4 findings notify (D-17, D-18)", () => {
    it("a day with a CURRENT acknowledgement produces nothing", async () => {
      const x = await createEmployee("acked-x");
      const day = yesterday();
      const rows = twoSalonDay(x.employee.id, day);
      const { snapshot } = evaluateDayBreaks({
        rows: rows.map((r) => ({
          id: r.id,
          startTime: r.startTime,
          endTime: r.endTime!,
          breakMinutes: r.breakMinutes,
          breakStatus: r.breakStatus,
          salonId: r.salonId,
        })),
        dayBreaks: [],
        acks: [],
      });
      await app.prisma.dayBreakAck.create({
        data: {
          employeeId: x.employee.id,
          date: dateOf(day),
          reason: "Kundentermin ohne Unterbrechung",
          snapshot: { ...snapshot },
          acknowledgedBy: adminUserId,
        },
      });

      await app.tryBreakFindingCheck();

      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(0);
    });

    it("a STALE acknowledgement does not silence the day", async () => {
      const x = await createEmployee("stale-x");
      const day = yesterday();
      twoSalonDay(x.employee.id, day);
      await app.prisma.dayBreakAck.create({
        data: {
          employeeId: x.employee.id,
          date: dateOf(day),
          reason: "Kundentermin ohne Unterbrechung",
          snapshot: { entryIds: [], salonIds: [], netWorkedMin: 1, totalBreakMin: 0 },
          acknowledgedBy: adminUserId,
        },
      });

      await app.tryBreakFindingCheck();

      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(1);
    });

    it("a same-salon two-entry day with a shortfall produces nothing", async () => {
      const x = await createEmployee("same-salon-x");
      const day = yesterday();
      // 7 h 50 min net with a 10 min gap in ONE salon: a § 4 shortfall, but not cross-salon.
      addRows(x.employee.id, [
        row(x.employee.id, day, salonA, "08:00", "12:00"),
        row(x.employee.id, day, salonA, "12:10", "16:00"),
      ]);

      await app.tryBreakFindingCheck();

      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(0);
    });

    it("a pure § 3 day (10.5 h across two salons, 45 min break recorded) produces nothing", async () => {
      const x = await createEmployee("section3-x");
      const day = yesterday();
      addRows(x.employee.id, [
        row(x.employee.id, day, salonA, "06:00", "11:00"),
        row(x.employee.id, day, salonB, "11:30", "17:45", 45),
      ]);

      await app.tryBreakFindingCheck();

      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(0);
    });
  });

  describe("Issue #511 (D-13) — Satz 2 / Satz 3 findings notify as BREAK_PLACEMENT_VIOLATION", () => {
    it("notifies the tenant-wide manager about a single-salon Satz-3 day with the full finding text", async () => {
      const x = await createEmployee("place-x");
      const day = yesterday();
      // 08:00-16:00 with a 30 min break at 14:30: 6 h 30 min at a stretch before it.
      await realDay(x.employee.id, day, "08:00", "16:00", [["14:30", "15:00"]]);

      await app.tryBreakFindingCheck();

      const rows = await notificationsOfType(PLACEMENT_TYPE, adminUserId, x.employee.id, day);
      expect(rows).toHaveLength(1);
      const n = rows[0];
      expect(n.title).toBe(BREAK_PLACEMENT_NOTICE_TITLE);
      expect(n.link).toBe(`/team/time-entries?employeeId=${x.employee.id}&date=${day}`);
      expect(n.message.startsWith(`Fixture place-x: Am ${germanDate(day)} § 4`)).toBe(true);
      expect(n.message).toContain("08:00–14:30");
      // The cross-salon type is NOT used for a single-salon day.
      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(0);
      console.info(`[511-06 full placement notice] ${n.title} | ${n.message}`);
    });

    it("a partial-reach manager gets the redacted text: no clock time, no salon, no entry id", async () => {
      const x = await createEmployee("place-redact");
      const day = yesterday();
      await crossSalonPlacementDay(x.employee.id, day);

      await app.tryBreakFindingCheck();

      const [partial] = await notificationsOfType(PLACEMENT_TYPE, mgrA.user.id, x.employee.id, day);
      expect(partial, "the salon-A manager covers one of the two entries").toBeDefined();
      expect(partial.title).toBe(BREAK_PLACEMENT_NOTICE_TITLE);
      expect(partial.message.startsWith(`Fixture place-redact: Am ${germanDate(day)} § 4`)).toBe(
        true,
      );
      const visible = [partial.title, partial.message, partial.link ?? ""].join("\n");
      expect(visible).not.toMatch(CLOCK_TIME);
      for (const forbidden of [salonName.A, salonName.B, salonA, salonB]) {
        expect(visible, `redacted notification must not contain "${forbidden}"`).not.toContain(
          forbidden,
        );
      }
      console.info(`[511-06 redacted placement notice] ${partial.title} | ${partial.message}`);

      // The A+B manager and the tenant-wide manager cover the whole day: full text with the range.
      const [full] = await notificationsOfType(PLACEMENT_TYPE, mgrAB.user.id, x.employee.id, day);
      expect(full.message).toContain("08:00–14:30");
      // A manager outside both salons is not a recipient.
      expect(
        await notificationsOfType(PLACEMENT_TYPE, mgrC.user.id, x.employee.id, day),
      ).toHaveLength(0);
    });

    it("sends once, never to the employee, and a dismissed notice is not re-created", async () => {
      const x = await createEmployee("place-once");
      await assignScopedRole(x.user.id, [salonA]);
      const day = yesterday();
      await realDay(x.employee.id, day, "08:00", "16:00", [["14:30", "15:00"]]);

      await app.tryBreakFindingCheck();
      await app.tryBreakFindingCheck();
      expect(
        await notificationsOfType(PLACEMENT_TYPE, adminUserId, x.employee.id, day),
      ).toHaveLength(1);

      await app.prisma.notification.updateMany({
        where: { userId: adminUserId, type: PLACEMENT_TYPE, relatedId: `${x.employee.id}:${day}` },
        data: { dismissedAt: new Date() },
      });
      await app.tryBreakFindingCheck();
      const rows = await notificationsOfType(PLACEMENT_TYPE, adminUserId, x.employee.id, day);
      expect(rows).toHaveLength(1);
      expect(rows[0].dismissedAt).not.toBeNull();

      // x holds the permission over salon A and hears about other employees' days, never their own.
      const own = await app.prisma.notification.count({
        where: {
          userId: x.user.id,
          type: { in: [PLACEMENT_TYPE, NOTIFICATION_TYPE] },
          relatedId: `${x.employee.id}:${day}`,
        },
      });
      expect(own).toBe(0);
      expect(
        await notificationsOfType(PLACEMENT_TYPE, mgrA.user.id, x.employee.id, day),
      ).toHaveLength(1);
    });

    it("an existing cross-salon notice for the day blocks a placement notice (A10)", async () => {
      const x = await createEmployee("place-a10-pre");
      const day = yesterday();
      await realDay(x.employee.id, day, "08:00", "16:00", [["14:30", "15:00"]]);
      await app.prisma.notification.create({
        data: {
          userId: adminUserId,
          type: NOTIFICATION_TYPE,
          title: CROSS_SALON_NOTICE_TITLE,
          message: "vorhanden",
          relatedType: "EmployeeDay",
          relatedId: `${x.employee.id}:${day}`,
          dismissedAt: new Date(),
        },
      });

      await app.tryBreakFindingCheck();

      expect(
        await notificationsOfType(PLACEMENT_TYPE, adminUserId, x.employee.id, day),
      ).toHaveLength(0);
      // The other recipients were not told yet and still get theirs.
      expect(
        await notificationsOfType(PLACEMENT_TYPE, mgrA.user.id, x.employee.id, day),
      ).toHaveLength(1);
    });

    it("an existing placement notice for the day blocks a cross-salon notice (A10)", async () => {
      const x = await createEmployee("place-a10-post");
      const day = yesterday();
      twoSalonDay(x.employee.id, day);
      await app.prisma.notification.create({
        data: {
          userId: adminUserId,
          type: PLACEMENT_TYPE,
          title: BREAK_PLACEMENT_NOTICE_TITLE,
          message: "vorhanden",
          relatedType: "EmployeeDay",
          relatedId: `${x.employee.id}:${day}`,
        },
      });

      await app.tryBreakFindingCheck();

      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(0);
      expect(await notificationsFor(mgrA.user.id, x.employee.id, day)).toHaveLength(1);
    });

    it("a cross-salon Satz-1 day keeps the cross-salon type and produces no placement notice", async () => {
      const x = await createEmployee("place-cross");
      const day = yesterday();
      twoSalonDay(x.employee.id, day);

      await app.tryBreakFindingCheck();

      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(1);
      expect(
        await notificationsOfType(PLACEMENT_TYPE, adminUserId, x.employee.id, day),
      ).toHaveLength(0);
    });

    it("a hint-only day (stored break sum, no placed break) notifies nobody (A5)", async () => {
      const x = await createEmployee("place-hint");
      const day = yesterday();
      await realDay(x.employee.id, day, "08:00", "16:30", [], 30);

      await app.tryBreakFindingCheck();

      expect(
        await app.prisma.notification.count({
          where: { type: PLACEMENT_TYPE, relatedId: `${x.employee.id}:${day}` },
        }),
      ).toBe(0);
    });

    it("a day with a current acknowledgement notifies nobody", async () => {
      const x = await createEmployee("place-acked");
      const day = yesterday();
      const entry = await realDay(x.employee.id, day, "08:00", "16:00", [["14:30", "15:00"]]);
      const breaks = await app.prisma.break.findMany({ where: { timeEntryId: entry.id } });
      const { snapshot } = evaluateDayBreaks({
        rows: [
          {
            id: entry.id,
            startTime: entry.startTime,
            endTime: entry.endTime!,
            breakMinutes: entry.breakMinutes,
            breakStatus: entry.breakStatus,
            salonId: entry.salonId,
            breaks,
          },
        ],
        dayBreaks: [],
        acks: [],
      });
      await app.prisma.dayBreakAck.create({
        data: {
          employeeId: x.employee.id,
          date: dateOf(day),
          reason: "Kundentermin ohne Unterbrechung",
          snapshot: { ...snapshot },
          acknowledgedBy: adminUserId,
        },
      });

      await app.tryBreakFindingCheck();

      expect(
        await app.prisma.notification.count({
          where: { type: PLACEMENT_TYPE, relatedId: `${x.employee.id}:${day}` },
        }),
      ).toBe(0);
    });

    it("a minor's 4 h 31 min block is notified under § 11 JArbSchG; the same day of an adult is not", async () => {
      const day = yesterday();
      const minor = await createEmployee("place-minor");
      const adult = await createEmployee("place-adult");
      const sixteen = new Date(dateOf(day));
      sixteen.setUTCFullYear(sixteen.getUTCFullYear() - 16);
      await app.prisma.employee.update({
        where: { id: minor.employee.id },
        data: { birthDate: sixteen },
      });
      // 08:00-14:00, 30 min break at 12:31: 4 h 31 min before it (limit 4 h 30 min for a minor).
      for (const e of [minor, adult]) {
        await realDay(e.employee.id, day, "08:00", "14:00", [["12:31", "13:01"]]);
      }

      await app.tryBreakFindingCheck();

      const [n] = await notificationsOfType(PLACEMENT_TYPE, adminUserId, minor.employee.id, day);
      expect(n, "the minor's day is a finding").toBeDefined();
      expect(n.message).toContain("JArbSchG");
      expect(
        await notificationsOfType(PLACEMENT_TYPE, adminUserId, adult.employee.id, day),
      ).toHaveLength(0);
    });
  });

  describe("Issue #511 (D-13) — the placement mail (T-511-29)", () => {
    it("carries the neutral placement subject; the partial-reach manager's mail holds no time or salon", async () => {
      await app.prisma.tenantConfig.update({
        where: { tenantId },
        data: { ...SMTP_CONFIGURED, emailNotificationsEnabled: true, emailOnMissingEntries: true },
      });
      try {
        sendMailMock.mockReset();
        sendMailMock.mockResolvedValue({ messageId: "test-message-id" });
        const x = await createEmployee("place-mail");
        const day = yesterday();
        await crossSalonPlacementDay(x.employee.id, day);

        await app.tryBreakFindingCheck();

        const notified = await app.prisma.notification.count({
          where: { type: PLACEMENT_TYPE, relatedId: `${x.employee.id}:${day}` },
        });
        expect(notified).toBeGreaterThanOrEqual(3);
        await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(notified));
        const mailTo = (email: string) =>
          sendMailMock.mock.calls
            .map((c) => c[0] as { to: string; subject: string; html: string })
            .filter((m) => m.to === email);

        const [partial] = mailTo(mgrA.user.email);
        expect(partial.subject).toBe(`${BREAK_PLACEMENT_NOTICE_TITLE} – Clokr`);
        expect(partial.subject).not.toMatch(CLOCK_TIME);
        for (const forbidden of [salonName.A, salonName.B, salonA, salonB, "14:30", "08:00"]) {
          expect(partial.html, `mail must not contain "${forbidden}"`).not.toContain(forbidden);
        }
        const [full] = mailTo(adminEmail);
        expect(full.subject).toBe(`${BREAK_PLACEMENT_NOTICE_TITLE} – Clokr`);
        expect(full.html).toContain("08:00–14:30");
      } finally {
        await app.prisma.tenantConfig.update({
          where: { tenantId },
          data: { emailNotificationsEnabled: false, emailOnMissingEntries: false },
        });
      }
    });
  });

  describe("the mail (T-80-38)", () => {
    it("carries the neutral subject, and the salon-A manager's mail holds nothing of salon B", async () => {
      await app.prisma.tenantConfig.update({
        where: { tenantId },
        data: { ...SMTP_CONFIGURED, emailNotificationsEnabled: true, emailOnMissingEntries: true },
      });
      try {
        sendMailMock.mockReset();
        sendMailMock.mockResolvedValue({ messageId: "test-message-id" });
        const x = await createEmployee("mail-x");
        const day = yesterday();
        twoSalonDay(x.employee.id, day);

        await app.tryBreakFindingCheck();

        // One mail per notification: the tenant-wide admin, the A+B manager and the A-only manager,
        // plus any earlier fixture user who holds the permission over both salons.
        const notified = await app.prisma.notification.count({
          where: { type: NOTIFICATION_TYPE, relatedId: `${x.employee.id}:${day}` },
        });
        expect(notified).toBeGreaterThanOrEqual(3);
        await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(notified));
        const mailTo = (email: string) =>
          sendMailMock.mock.calls
            .map((c) => c[0] as { to: string; subject: string; html: string })
            .filter((m) => m.to === email);

        const redactedMails = mailTo(mgrA.user.email);
        expect(redactedMails).toHaveLength(1);
        const redacted = redactedMails[0];
        expect(redacted.subject).toBe(`${CROSS_SALON_NOTICE_TITLE} – Clokr`);
        expect(redacted.html).toContain(
          `Fixture mail-x: Am ${germanDate(day)} insgesamt 8 h ohne 30 Min Pause, salonübergreifend.`,
        );
        for (const forbidden of [
          salonName.A,
          salonName.B,
          salonA,
          salonB,
          "12:30",
          "16:30",
          "08:00",
        ]) {
          expect(redacted.html, `mail must not contain "${forbidden}"`).not.toContain(forbidden);
          expect(redacted.subject).not.toContain(forbidden);
        }
        expect(redacted.subject).not.toMatch(CLOCK_TIME);

        const adminMails = mailTo(adminEmail);
        expect(adminMails).toHaveLength(1);
        expect(adminMails[0].subject).toBe(`${CROSS_SALON_NOTICE_TITLE} – Clokr`);
        expect(adminMails[0].html).toContain(salonName.B);
        expect(adminMails[0].html).toContain("12:30");
      } finally {
        await app.prisma.tenantConfig.update({
          where: { tenantId },
          data: { emailNotificationsEnabled: false, emailOnMissingEntries: false },
        });
      }
    });
  });
});

/** "2026-03-10" -> "10.03.2026". */
function germanDate(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}.${m}.${y}`;
}
