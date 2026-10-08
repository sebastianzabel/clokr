/**
 * Issue #80 (D-09e, D-10, D-11, D-13, D-18) — the next-day cron that tells managers about an
 * unacknowledged cross-salon § 4 ArbZG violation of a previous day, once per recipient, employee
 * and day.
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
import { CROSS_SALON_NOTICE_TITLE } from "../contexts/time-tracking/cross-salon-notice";

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

      await app.tryCrossSalonBreakCheck();

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

      await app.tryCrossSalonBreakCheck();

      const own = await app.prisma.notification.count({
        where: { userId: x.user.id, type: NOTIFICATION_TYPE },
      });
      expect(own).toBe(0);
    });

    it("sends once: a second run creates no further row", async () => {
      const x = await createEmployee("tracer-twice");
      const day = yesterday();
      twoSalonDay(x.employee.id, day);

      await app.tryCrossSalonBreakCheck();
      await app.tryCrossSalonBreakCheck();

      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(1);
    });
  });

  describe("redaction by the recipient's own reach (D-11, T-80-37)", () => {
    it("a manager covering only salon A gets the day total and the finding, nothing of salon B", async () => {
      const x = await createEmployee("redact-x");
      const day = yesterday();
      twoSalonDay(x.employee.id, day);

      await app.tryCrossSalonBreakCheck();

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

      await app.tryCrossSalonBreakCheck();

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

      await app.tryCrossSalonBreakCheck();

      expect(await notificationsFor(mgrC.user.id, x.employee.id, day)).toHaveLength(0);
      expect(await notificationsFor(mgrA.user.id, x.employee.id, day)).toHaveLength(1);
      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(1);
    });

    it("the employee never hears about their own day, even holding the permission over both salons", async () => {
      const x = await createEmployee("holder-x");
      await assignScopedRole(x.user.id, [salonA, salonB]);
      const day = yesterday();
      twoSalonDay(x.employee.id, day);

      await app.tryCrossSalonBreakCheck();

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

      await app.tryCrossSalonBreakCheck();
      await app.prisma.notification.updateMany({
        where: {
          userId: adminUserId,
          type: NOTIFICATION_TYPE,
          relatedId: `${x.employee.id}:${day}`,
        },
        data: { dismissedAt: new Date() },
      });
      await app.tryCrossSalonBreakCheck();

      const rows = await notificationsFor(adminUserId, x.employee.id, day);
      expect(rows).toHaveLength(1);
      expect(rows[0].dismissedAt).not.toBeNull();
    });

    it("a day two days ago (a missed run) is notified once", async () => {
      const x = await createEmployee("catchup-x");
      const day = daysAgoStrInTz(new Date(), 2, TZ);
      twoSalonDay(x.employee.id, day);

      await app.tryCrossSalonBreakCheck();
      await app.tryCrossSalonBreakCheck();

      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(1);
    });

    it("a day older than the catch-up window is not notified", async () => {
      const x = await createEmployee("old-x");
      const day = daysAgoStrInTz(new Date(), 5, TZ);
      twoSalonDay(x.employee.id, day);

      await app.tryCrossSalonBreakCheck();

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

      await app.tryCrossSalonBreakCheck();

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

      await app.tryCrossSalonBreakCheck();

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

      await app.tryCrossSalonBreakCheck();

      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(0);
    });

    it("a pure § 3 day (10.5 h across two salons, 45 min break recorded) produces nothing", async () => {
      const x = await createEmployee("section3-x");
      const day = yesterday();
      addRows(x.employee.id, [
        row(x.employee.id, day, salonA, "06:00", "11:00"),
        row(x.employee.id, day, salonB, "11:30", "17:45", 45),
      ]);

      await app.tryCrossSalonBreakCheck();

      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(0);
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

        await app.tryCrossSalonBreakCheck();

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
