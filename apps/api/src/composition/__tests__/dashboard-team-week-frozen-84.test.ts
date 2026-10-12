/**
 * Issue #84 (AC-6, D-12) — neutrality pin for `GET /api/v1/dashboard/team-week` of a one-salon
 * tenant.
 *
 * The literal below was captured on the UNCHANGED tree (commit a0258a8d) BEFORE the team-week
 * handler gained an optional `salonId` (84-03). It pins every per-day field of every row —
 * date, status, workedHours, reason, leaveTypeCode, absenceType, shift, isWorkday, expectedHours —
 * plus weekStart / weekEnd / weekDays. A later failure means the unfiltered response changed:
 * investigate the production change, never re-capture the literal. The literal deliberately holds
 * no `salonId` and no `workedElsewhere` key — those are additions of the filtered mode only.
 *
 * Fixed clock: Wed 2026-06-17T10:00:00Z (CEST, 12:00 local). Only `Date` is faked. Week under
 * test: Mon 15.06. - Sun 21.06.2026 (Niedersachsen has no statutory holiday in it).
 *
 * Covered statuses: present, clocked_in, missing, absent (vacation and sick leave), requested,
 * holiday (manual PublicHoliday of the salon), scheduled (future workday, with a planned shift)
 * and none (weekend).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  reissueTokenNow,
} from "../../__tests__/setup";
import { leaveTypeFields } from "../../contexts/absence/leave-type";

const FAKE_NOW = new Date("2026-06-17T10:00:00Z");

const EXPECTED = {
  weekStart: "2026-06-15",
  weekEnd: "2026-06-21",
  weekDays: [
    "2026-06-15",
    "2026-06-16",
    "2026-06-17",
    "2026-06-18",
    "2026-06-19",
    "2026-06-20",
    "2026-06-21",
  ],
  team: [
    {
      name: "Admin Test",
      days: [
        {
          date: "2026-06-15",
          status: "missing",
          workedHours: 0,
          reason: null,
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: true,
          expectedHours: 8,
        },
        {
          date: "2026-06-16",
          status: "missing",
          workedHours: 0,
          reason: null,
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: true,
          expectedHours: 8,
        },
        {
          date: "2026-06-17",
          status: "scheduled",
          workedHours: 0,
          reason: null,
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: true,
          expectedHours: 8,
        },
        {
          date: "2026-06-18",
          status: "holiday",
          workedHours: 0,
          reason: "Hausfeiertag tw84f",
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: true,
          expectedHours: 8,
        },
        {
          date: "2026-06-19",
          status: "scheduled",
          workedHours: 0,
          reason: null,
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: true,
          expectedHours: 8,
        },
        {
          date: "2026-06-20",
          status: "none",
          workedHours: 0,
          reason: null,
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: false,
          expectedHours: 0,
        },
        {
          date: "2026-06-21",
          status: "none",
          workedHours: 0,
          reason: null,
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: false,
          expectedHours: 0,
        },
      ],
    },
    {
      name: "Fixed Tw84f",
      days: [
        {
          date: "2026-06-15",
          status: "absent",
          workedHours: 0,
          reason: "Urlaub",
          leaveTypeCode: "VACATION",
          absenceType: null,
          shift: null,
          isWorkday: true,
          expectedHours: 8,
        },
        {
          date: "2026-06-16",
          status: "absent",
          workedHours: 0,
          reason: "Krankmeldung",
          leaveTypeCode: "SICK",
          absenceType: null,
          shift: null,
          isWorkday: true,
          expectedHours: 8,
        },
        {
          date: "2026-06-17",
          status: "requested",
          workedHours: 0,
          reason: "Antrag: Urlaub",
          leaveTypeCode: "VACATION",
          absenceType: null,
          shift: null,
          isWorkday: true,
          expectedHours: 8,
        },
        {
          date: "2026-06-18",
          status: "holiday",
          workedHours: 0,
          reason: "Hausfeiertag tw84f",
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: true,
          expectedHours: 8,
        },
        {
          date: "2026-06-19",
          status: "scheduled",
          workedHours: 0,
          reason: null,
          leaveTypeCode: null,
          absenceType: null,
          shift: {
            startTime: "09:00",
            endTime: "17:00",
            label: "Frueh tw84f",
            color: null,
          },
          isWorkday: true,
          expectedHours: 8,
        },
        {
          date: "2026-06-20",
          status: "none",
          workedHours: 0,
          reason: null,
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: false,
          expectedHours: 0,
        },
        {
          date: "2026-06-21",
          status: "none",
          workedHours: 0,
          reason: null,
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: false,
          expectedHours: 0,
        },
      ],
    },
    {
      name: "Max Test",
      days: [
        {
          date: "2026-06-15",
          status: "present",
          workedHours: 8,
          reason: null,
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: true,
          expectedHours: 8,
        },
        {
          date: "2026-06-16",
          status: "missing",
          workedHours: 0,
          reason: null,
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: true,
          expectedHours: 8,
        },
        {
          date: "2026-06-17",
          status: "clocked_in",
          workedHours: 0,
          reason: null,
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: true,
          expectedHours: 8,
        },
        {
          date: "2026-06-18",
          status: "holiday",
          workedHours: 0,
          reason: "Hausfeiertag tw84f",
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: true,
          expectedHours: 8,
        },
        {
          date: "2026-06-19",
          status: "scheduled",
          workedHours: 0,
          reason: null,
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: true,
          expectedHours: 8,
        },
        {
          date: "2026-06-20",
          status: "none",
          workedHours: 0,
          reason: null,
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: false,
          expectedHours: 0,
        },
        {
          date: "2026-06-21",
          status: "none",
          workedHours: 0,
          reason: null,
          leaveTypeCode: null,
          absenceType: null,
          shift: null,
          isWorkday: false,
          expectedHours: 0,
        },
      ],
    },
  ],
};

describe("Issue #84 — team-week frozen pre-84 response (one-salon tenant)", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let fixedEmployeeId = "";

  function day(date: string) {
    return new Date(`${date}T00:00:00Z`);
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "tw84f");
    const prisma = app.prisma;

    // ── Seeded employee: Mon present (closed), Tue missing (no entry), Wed clocked in (open) ──
    await prisma.timeEntry.create({
      data: {
        employeeId: d.employee.id,
        date: day("2026-06-15"),
        startTime: new Date("2026-06-15T06:00:00Z"),
        endTime: new Date("2026-06-15T14:30:00Z"),
        breakMinutes: 30,
        type: "WORK",
        source: "MANUAL",
        salonId: d.salonId,
      },
    });
    await prisma.timeEntry.create({
      data: {
        employeeId: d.employee.id,
        date: day("2026-06-17"),
        startTime: new Date("2026-06-17T06:00:00Z"),
        endTime: null,
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
        salonId: d.salonId,
      },
    });

    // ── Admin employee: one INVALID closed entry on Monday (never counts as worked time) ──
    await prisma.timeEntry.create({
      data: {
        employeeId: d.adminEmployee.id,
        date: day("2026-06-15"),
        startTime: new Date("2026-06-15T07:00:00Z"),
        endTime: new Date("2026-06-15T09:00:00Z"),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
        isInvalid: true,
        salonId: d.salonId,
      },
    });

    // ── Second employee on a FIXED_SCHEDULE Mon-Fri 8 h contract ──
    const passwordHash = await bcrypt.hash("test1234", 10);
    const stamp = Date.now().toString(36);
    const user = await prisma.user.create({
      data: {
        email: `fixed-tw84f-${stamp}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await prisma.employee.create({
      data: {
        tenantId: d.tenant.id,
        userId: user.id,
        employeeNumber: `FX-tw84f-${stamp}`,
        firstName: "Fixed",
        lastName: "Tw84f",
        hireDate: new Date("2025-01-01T00:00:00Z"),
      },
    });
    fixedEmployeeId = employee.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });

    const vacationType = await prisma.leaveType.findFirstOrThrow({
      where: { tenantId: d.tenant.id, code: "VACATION" },
    });
    const sickType = await prisma.leaveType.create({
      data: { tenantId: d.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    const leave = (
      leaveTypeId: string,
      date: string,
      status: "APPROVED" | "PENDING",
    ): Parameters<typeof prisma.leaveRequest.create>[0] => ({
      data: {
        employeeId: employee.id,
        leaveTypeId,
        startDate: day(date),
        endDate: day(date),
        days: 1,
        status,
        ...(status === "APPROVED" ? { reviewedBy: d.adminUser.id, reviewedAt: new Date() } : {}),
      },
    });
    await prisma.leaveRequest.create(leave(vacationType.id, "2026-06-15", "APPROVED"));
    await prisma.leaveRequest.create(leave(sickType.id, "2026-06-16", "APPROVED"));
    await prisma.leaveRequest.create(leave(vacationType.id, "2026-06-17", "PENDING"));

    // Thursday: a manual holiday of the (only) salon.
    await prisma.publicHoliday.create({
      data: {
        tenantId: d.tenant.id,
        salonId: d.salonId,
        date: day("2026-06-18"),
        name: "Hausfeiertag tw84f",
        federalState: "NIEDERSACHSEN",
        year: 2026,
      },
    });

    // Friday: a planned shift, so the pinned `shift` object is non-null once.
    await prisma.shift.create({
      data: {
        employeeId: employee.id,
        salonId: d.salonId,
        date: day("2026-06-19"),
        startTime: "09:00",
        endTime: "17:00",
        label: "Frueh tw84f",
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("dashboard-team-week-frozen-84 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("answers the frozen pre-84 literal for ?date=2026-06-17", async () => {
    vi.useFakeTimers({ now: FAKE_NOW, toFake: ["Date"] });
    let body: {
      weekStart: string;
      weekEnd: string;
      weekDays: string[];
      team: Array<{ id: string; name: string; days: unknown[] }>;
    };
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/team-week?date=2026-06-17",
        headers: { authorization: `Bearer ${reissueTokenNow(app, d.adminToken)}` },
      });
      expect(res.statusCode).toBe(200);
      body = JSON.parse(res.body);
    } finally {
      vi.useRealTimers();
    }

    // The three fixture employees are identified by id; the literal carries neither the id nor the
    // employee number (the number embeds a per-run timestamp).
    const idByName: Record<string, string> = {
      "Admin Test": d.adminEmployee.id,
      "Max Test": d.employee.id,
      "Fixed Tw84f": fixedEmployeeId,
    };
    for (const row of body.team) {
      expect(row.id).toBe(idByName[row.name]);
    }

    const team = [...body.team]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => ({ name: row.name, days: row.days }));
    expect({
      weekStart: body.weekStart,
      weekEnd: body.weekEnd,
      weekDays: body.weekDays,
      team,
    }).toEqual(EXPECTED);
  });
});
