/**
 * Issue #614 (AC-614-3, D-05) — a CLOSED month is a legal record (§ 147 AO, Monatsabschluss): the
 * anonymization must not move a single figure of it. For an employee with a closed month before
 * the anonymization this file proves, by comparing a capture taken BEFORE with one taken AFTER the
 * `DELETE /api/v1/employees/:id` call:
 *
 *   1. every SaldoSnapshot row (ids and every value) and no new row for a closed month;
 *   2. the month figures of `computeMonthReportFigures` (the report source, #451 D-03);
 *   3. the DATEV rows of that month for the person's personnel number (the number is kept, D-03);
 *   4. the LeaveEntitlement rows of past years;
 *   5. the leave rows lying in the closed month (status, dates, days) — the exit reports them as
 *      skipped (CLOSED_MONTH) instead of touching them.
 *
 * It also walks every audit row the anonymization wrote for the person's rows and proves none
 * carries a note, a name or an e-mail address (the phase-wide no-free-text property).
 *
 * The fixture is built so the exit WOULD touch closed-month rows without the protection: the
 * stored exit date lies inside the closed month (D-01 keeps it), one approved vacation spans it
 * (the shortening would remove a day of the closed month) and one lies wholly after it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import iconv from "iconv-lite";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  configureDatevKanzlei,
  seedEntitlementYears,
  grantSystemRole,
  soleAuditRow,
} from "./setup";
import {
  computeMonthReportFigures,
  getTenantTimezone,
  todayInTz,
} from "../contexts/working-time-account";
import { DATEV_BWD_SATZ_ID } from "../composition/reports";

// Named offsets of a Bewegungsdaten row (Satz-ID + 12 values), as in datev-month-boundary-493.
const F_PNR = 1;
const F_LOHNART = 5;
const F_STUNDEN = 6;
const F_TAGE = 7;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const utcMidnight = (iso: string) => new Date(`${iso}T00:00:00Z`);
/** First date on or after `from` whose UTC weekday is `weekday` (0 = Sunday). */
const onOrAfter = (from: Date, weekday: number) =>
  addDays(from, (weekday - from.getUTCDay() + 7) % 7);

const NOTE = "Notiz-Zebra-614-closed";
const FIRST_NAME = "Closed614";
const LAST_NAME = "Fixture614";

describe("Issue #614 — closed months are sum-identical through the anonymization (AC-614-3)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let today: Date;
  let lastYear: number;
  let lastMonth: number; // 1-12
  let weekdays: Date[]; // the first seven Mon-Fri days of last month

  const auth = () => ({ authorization: `Bearer ${data.adminToken}` });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "anon-closed-614");
    await configureDatevKanzlei(app, data.tenant.id);
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    today = todayInTz(tz);
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    lastYear = first.getUTCFullYear();
    lastMonth = first.getUTCMonth() + 1;
    weekdays = [];
    for (let day = first; weekdays.length < 7; day = addDays(day, 1)) {
      if (day.getUTCDay() >= 1 && day.getUTCDay() <= 5) weekdays.push(day);
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("anonymization-closed-months-614 test cleanup failed:", err);
    }
  });

  /** Decoded Bewegungsdaten rows of the company DATEV export of a month. */
  async function datevRows(year: number, month: number): Promise<string[][]> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/datev?year=${year}&month=${month}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    return iconv
      .decode(res.rawPayload, "win1252")
      .split("[Bewegungsdaten]")[1]
      .split("\r\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => l.split(";"))
      .filter((f) => f[0] === String(DATEV_BWD_SATZ_ID));
  }

  /** The person's cells, sorted by Lohnart: `[lohnart, stunden, tage]`. */
  async function datevCells(pnr: string) {
    return (await datevRows(lastYear, lastMonth))
      .filter((r) => r[F_PNR] === pnr)
      .map((r) => [Number(r[F_LOHNART]), r[F_STUNDEN], r[F_TAGE]] as const)
      .sort((a, b) => a[0] - b[0]);
  }

  /** Plain-JSON copy so Decimal / Date compare by value. */
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  it("snapshots, month figures, DATEV cells, past entitlements and the closed-month leave rows are identical; the exit reports the rows it left alone; no audit row carries free text", async () => {
    // ── Fixture ────────────────────────────────────────────────────────────────────────────
    const suffix = crypto.randomUUID().slice(0, 8);
    const email = `closed614-${suffix}@example.invalid`;
    const user = await app.prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const hireDate = utcMidnight(`${isoDay(weekdays[0]).slice(0, 7)}-01`);
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: FIRST_NAME,
        lastName: LAST_NAME,
        employeeNumber: `C614-${suffix}`,
        hireDate,
      },
    });
    await grantSystemRole(app.prisma, {
      tenantId: data.tenant.id,
      userId: user.id,
      role: "EMPLOYEE",
    });
    await app.prisma.workSchedule.create({
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
        validFrom: hireDate,
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    // The previous year's row makes the "past years" comparison non-vacuous in every month.
    const thisYear = today.getUTCFullYear();
    await seedEntitlementYears(app, {
      employeeId: employee.id,
      leaveTypeId: data.vacationType.id,
      years: [thisYear - 1, thisYear, thisYear + 1],
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "test1234" },
    });
    expect(login.statusCode).toBe(200);
    const token = JSON.parse(login.body).accessToken as string;

    // Next month, through the API: an approved vacation and a pending request (both end up after the exit).
    const nextMonday = onOrAfter(
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 8)),
      1,
    );
    const apiRequests: string[] = [];
    for (const [start, end, approve] of [
      [nextMonday, addDays(nextMonday, 2), true],
      [addDays(nextMonday, 7), addDays(nextMonday, 9), false],
    ] as const) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "VACATION", startDate: isoDay(start), endDate: isoDay(end), note: NOTE },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = JSON.parse(created.body).id as string;
      apiRequests.push(id);
      if (approve) {
        const reviewed = await app.inject({
          method: "PATCH",
          url: `/api/v1/leave/requests/${id}/review`,
          headers: auth(),
          payload: { status: "APPROVED" },
        });
        expect(reviewed.statusCode, reviewed.body).toBe(200);
      }
    }

    // Last month: three worked days, a vacation spanning the exit day, a vacation after it.
    // Written directly — the past is not creatable through the API.
    const [w1, w2, w3, w4, w5, w6, w7] = weekdays;
    const timeEntryIds: string[] = [];
    for (const day of [w1, w2, w3]) {
      const row = await app.prisma.timeEntry.create({
        data: {
          employeeId: employee.id,
          date: day,
          startTime: new Date(`${isoDay(day)}T08:00:00Z`),
          endTime: new Date(`${isoDay(day)}T16:00:00Z`),
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
          salonId: data.salonId,
          note: NOTE,
        },
      });
      timeEntryIds.push(row.id);
    }
    const spanning = await app.prisma.leaveRequest.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: w4,
        endDate: w5,
        days: 2,
        status: "APPROVED",
        reviewedBy: "system",
        reviewedAt: new Date(),
        note: NOTE,
      },
    });
    const afterExit = await app.prisma.leaveRequest.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: w6,
        endDate: w7,
        days: 2,
        status: "APPROVED",
        reviewedBy: "system",
        reviewedAt: new Date(),
        note: NOTE,
      },
    });
    // D-01 keeps a stored exit date: the exit day lies INSIDE the month about to be closed.
    await app.prisma.employee.update({ where: { id: employee.id }, data: { exitDate: w4 } });

    const closed = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-month",
      headers: auth(),
      payload: { employeeId: employee.id, year: lastYear, month: lastMonth, confirmGaps: true },
    });
    expect(closed.statusCode, closed.body).toBe(201);

    // ── Capture BEFORE ─────────────────────────────────────────────────────────────────────
    const snapshotsBefore = plain(
      await app.prisma.saldoSnapshot.findMany({
        where: { employeeId: employee.id },
        orderBy: [{ periodStart: "asc" }, { id: "asc" }],
      }),
    );
    expect(snapshotsBefore.length).toBeGreaterThan(0);
    const figuresBefore = await computeMonthReportFigures(app, employee.id, lastYear, lastMonth);
    expect(figuresBefore.confirmed).toBe(true);
    const datevBefore = await datevCells(employee.employeeNumber);
    expect(datevBefore.length).toBeGreaterThan(0);
    const pastEntitlements = () =>
      app.prisma.leaveEntitlement
        .findMany({
          where: { employeeId: employee.id, year: { lt: thisYear } },
          orderBy: [{ year: "asc" }, { id: "asc" }],
        })
        .then(plain);
    const entitlementsBefore = await pastEntitlements();
    expect(entitlementsBefore.length).toBeGreaterThan(0);
    const leaveInClosedMonth = () =>
      app.prisma.leaveRequest
        .findMany({
          where: { id: { in: [spanning.id, afterExit.id] } },
          select: { id: true, status: true, startDate: true, endDate: true, days: true },
          orderBy: { id: "asc" },
        })
        .then(plain);
    const leaveBefore = await leaveInClosedMonth();
    const auditIdsBefore = new Set(
      (await app.prisma.auditLog.findMany({ select: { id: true } })).map((r) => r.id),
    );

    // ── The anonymization ──────────────────────────────────────────────────────────────────
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/employees/${employee.id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);

    // ── (1) snapshots ──────────────────────────────────────────────────────────────────────
    const snapshotsAfter = plain(
      await app.prisma.saldoSnapshot.findMany({
        where: { employeeId: employee.id },
        orderBy: [{ periodStart: "asc" }, { id: "asc" }],
      }),
    );
    // Same ids, same values, same superseded flags — and no new row for the closed month (or older).
    const closedMonthStart = utcMidnight(`${lastYear}-${String(lastMonth).padStart(2, "0")}-01`);
    expect(snapshotsAfter.filter((s) => new Date(s.periodStart) <= closedMonthStart)).toEqual(
      snapshotsBefore.filter((s) => new Date(s.periodStart) <= closedMonthStart),
    );
    expect(snapshotsAfter.slice(0, snapshotsBefore.length)).toEqual(snapshotsBefore);

    // ── (2) report figures, (3) DATEV, (4) past entitlements, (5) closed-month leave ───────
    expect(await computeMonthReportFigures(app, employee.id, lastYear, lastMonth)).toEqual(
      figuresBefore,
    );
    expect(await datevCells(employee.employeeNumber)).toEqual(datevBefore);
    expect(await pastEntitlements()).toEqual(entitlementsBefore);
    expect(await leaveInClosedMonth()).toEqual(leaveBefore);

    // The exit reported what it left alone instead of touching it.
    const ended = (
      await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: employee.id, action: "ANONYMIZE" },
      })
    ).newValue as {
      absencesEnded: { cancelled: number; shortened: number; deleted: number };
      skipped: Array<{ entity: string; id: string; reason: string }>;
    };
    expect(ended.skipped).toContainEqual({
      entity: "LeaveRequest",
      id: spanning.id,
      reason: "CLOSED_MONTH",
    });
    expect(ended.skipped).toContainEqual({
      entity: "LeaveRequest",
      id: afterExit.id,
      reason: "CLOSED_MONTH",
    });
    // The two next-month requests are after the exit and outside any closed month: cancelled.
    expect(ended.absencesEnded.cancelled).toBe(apiRequests.length);

    // ── Phase-wide: no audit row of the run carries free text ──────────────────────────────
    const entitlementIds = (
      await app.prisma.leaveEntitlement.findMany({
        where: { employeeId: employee.id },
        select: { id: true },
      })
    ).map((r) => r.id);
    const rows = (
      await app.prisma.auditLog.findMany({
        where: {
          entityId: {
            in: [
              employee.id,
              spanning.id,
              afterExit.id,
              ...apiRequests,
              ...timeEntryIds,
              ...entitlementIds,
            ],
          },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    ).filter((r) => !auditIdsBefore.has(r.id));
    // The walked set is not empty: the anonymization, both cancellations and the entitlement bookings.
    expect(rows.length).toBeGreaterThanOrEqual(1 + apiRequests.length);
    expect(rows.some((r) => r.action === "ANONYMIZE")).toBe(true);
    expect(rows.filter((r) => r.action === "CANCEL")).toHaveLength(apiRequests.length);
    for (const row of rows) {
      const text = JSON.stringify(row.oldValue) + JSON.stringify(row.newValue);
      for (const secret of [NOTE, FIRST_NAME, LAST_NAME, email]) {
        expect(text, `${row.action} ${row.entity} audit carries "${secret}"`).not.toContain(secret);
      }
    }

    // The PII sweep still nulls the notes of the rows the exit left alone.
    const notes = await app.prisma.leaveRequest.findMany({
      where: { id: { in: [spanning.id, afterExit.id, ...apiRequests] } },
      select: { note: true },
    });
    expect(notes.every((n) => n.note === null)).toBe(true);
    const entryNotes = await app.prisma.timeEntry.findMany({
      where: { id: { in: timeEntryIds } },
      select: { note: true },
    });
    expect(entryNotes.every((n) => n.note === null)).toBe(true);
  });
});
