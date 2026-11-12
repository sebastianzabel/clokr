/**
 * Issue #599 — correction requests for a day of a CLOSED month (Arbeitszeitkonto).
 *
 * Covers: the request rules (closed month only, own day, one pending per day), the four-eyes lock,
 * the booking (journal row + request booking in ONE transaction, closed month and its snapshot
 * untouched), the saldo effect through the core (`accountCorrections`), reject / withdraw, the
 * on-behalf path within reach, the identical 404, the audit rows and the anonymization of the texts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, auditRowsFor } from "./setup";
import { computeOvertimeBalanceBreakdown } from "../contexts/working-time-account/overtime-balance";
import {
  closeEmployeeMonth,
  type CloseMonthInput,
} from "../contexts/working-time-account/close-employee-month";
import { clearMonthCorrectionTextsForEmployee } from "../contexts/working-time-account";
import {
  getTenantTimezone,
  monthRangeUtc,
  todayInTz,
} from "../contexts/working-time-account/timezone";

type Seed = Awaited<ReturnType<typeof seedTestData>>;

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("Issue #599 — month correction requests", () => {
  let app: FastifyInstance;
  let data: Seed;
  let closedDay: string; // a weekday-agnostic day of the closed month
  let openDay: string; // a past day of an open month (or today-1)

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "mcr599");
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    const today = todayInTz(tz);
    const closedMonth = addMonths(today, -2);
    closedDay = iso(
      new Date(Date.UTC(closedMonth.getUTCFullYear(), closedMonth.getUTCMonth(), 10)),
    );
    const yesterday = new Date(today.getTime() - 86_400_000);
    openDay = iso(yesterday);
    // Close the month two months ago for the employee (a stored, active MONTHLY snapshot).
    const range = monthRangeUtc(closedMonth.getUTCFullYear(), closedMonth.getUTCMonth() + 1, tz);
    const lastDay = new Date(
      Date.UTC(closedMonth.getUTCFullYear(), closedMonth.getUTCMonth() + 1, 0),
    );
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        // The TZ-converted convention: the UTC date part of the local month start (#595).
        periodStart: new Date(`${iso(range.start)}T00:00:00Z`),
        periodEnd: lastDay,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  const post = (url: string, token: string, payload?: object) =>
    app.inject({
      method: "POST",
      url: `/api/v1/month-corrections${url}`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload ?? {},
    });
  const get = (url: string, token: string) =>
    app.inject({
      method: "GET",
      url: `/api/v1/month-corrections${url}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it("refuses a day of an open month with MONTH_NOT_CLOSED", async () => {
    const res = await post("/", data.empToken, {
      targetDate: openDay,
      reason: "Ich habe vergessen auszustempeln.",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("MONTH_NOT_CLOSED");
  });

  it("validates the times and the reason", async () => {
    const half = await post("/", data.empToken, {
      targetDate: closedDay,
      startTime: "08:00",
      reason: "Ich habe vergessen auszustempeln.",
    });
    expect(half.statusCode).toBe(400);
    const short = await post("/", data.empToken, { targetDate: closedDay, reason: "kurz" });
    expect(short.statusCode).toBe(400);
  });

  let requestId: string;

  it("creates a request for an own day of a closed month, audited, deciders notified", async () => {
    const res = await post("/", data.empToken, {
      targetDate: closedDay,
      startTime: "08:00",
      endTime: "16:30",
      breakMinutes: 30,
      reason: "Ich habe vergessen auszustempeln.",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    requestId = body.id;
    expect(body).toMatchObject({
      status: "PENDING",
      targetDate: closedDay,
      proposedWorkingMinutes: 480,
      recordedWorkingMinutes: 0,
      suggestedCorrectionMinutes: 480,
      isOwn: true,
      canDecide: false,
      canWithdraw: true,
    });
    const audits = await auditRowsFor(app, "MonthCorrectionRequest", requestId);
    expect(audits.map((a) => a.action)).toEqual(["CREATE"]);
    const notices = await app.prisma.notification.findMany({
      where: { relatedId: requestId, type: "MONTH_CORRECTION_REQUESTED" },
    });
    expect(notices.map((n) => n.userId)).toContain(data.adminUser.id);
    expect(notices.map((n) => n.userId)).not.toContain(data.employee.userId);
  });

  it("refuses a second pending request for the same day", async () => {
    const res = await post("/", data.empToken, {
      targetDate: closedDay,
      reason: "Noch einmal derselbe Tag.",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("MONTH_CORRECTION_PENDING_EXISTS");
  });

  it("lists own and team requests; the employee has no team list", async () => {
    const own = await get("/?scope=own", data.empToken);
    expect(own.statusCode).toBe(200);
    expect(own.json().map((r: { id: string }) => r.id)).toEqual([requestId]);
    const team = await get("/?scope=team", data.adminToken);
    expect(team.statusCode).toBe(200);
    const row = team.json().find((r: { id: string }) => r.id === requestId);
    expect(row).toMatchObject({ canDecide: true, isOwn: false });
    expect((await get("/?scope=team", data.empToken)).statusCode).toBe(403);
  });

  it("four eyes: the person concerned cannot decide (403 SELF_DECISION_FORBIDDEN)", async () => {
    const res = await post(`/${requestId}/approve`, data.empToken, {
      correctionMinutes: 480,
      reviewNote: "selbst genehmigt",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("SELF_DECISION_FORBIDDEN");
  });

  it("an unknown id and a foreign tenant's id answer the identical 404", async () => {
    const other = await seedTestData(app, "mcr599b");
    try {
      const unknown = await get("/00000000-0000-4000-8000-000000000599", other.adminToken);
      const foreign = await get(`/${requestId}`, other.adminToken);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(unknown.body);
      const foreignApprove = await post(`/${requestId}/approve`, other.adminToken, {
        correctionMinutes: 60,
        reviewNote: "fremd",
      });
      expect(foreignApprove.statusCode).toBe(404);
    } finally {
      await cleanupTestData(app, other.tenant.id);
    }
  });

  it("approval books in the running month: journal row, booking day today, snapshot untouched", async () => {
    const snapshotBefore = await app.prisma.saldoSnapshot.findFirstOrThrow({
      where: { employeeId: data.employee.id },
    });
    const res = await post(`/${requestId}/approve`, data.adminToken, {
      correctionMinutes: 480,
      reviewNote: "Passt, Schicht war im Plan.",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    expect(body).toMatchObject({
      status: "APPROVED",
      correctionMinutes: 480,
      bookingDate: iso(todayInTz(tz)),
    });
    const txn = await app.prisma.overtimeTransaction.findUniqueOrThrow({
      where: { id: body.overtimeTransactionId },
    });
    expect(txn.type).toBe("CORRECTION");
    expect(Number(txn.hours)).toBe(8);
    expect(txn.referenceMonth).toBe(closedDay.slice(0, 7));
    const snapshotAfter = await app.prisma.saldoSnapshot.findFirstOrThrow({
      where: { employeeId: data.employee.id },
    });
    expect(snapshotAfter).toEqual(snapshotBefore);
    const actions = (await auditRowsFor(app, "MonthCorrectionRequest", requestId)).map(
      (a) => a.action,
    );
    expect(actions).toEqual(["CREATE", "UPDATE"]);
    const txnAudit = await auditRowsFor(app, "OvertimeTransaction", txn.id);
    expect(txnAudit).toHaveLength(1);
    const decided = await app.prisma.notification.findMany({
      where: { relatedId: requestId, type: "MONTH_CORRECTION_DECIDED" },
    });
    expect(decided.map((n) => n.userId)).toEqual([data.employee.userId]);
  });

  it("a decided request is not decided twice (409 MONTH_CORRECTION_NOT_PENDING)", async () => {
    const res = await post(`/${requestId}/reject`, data.adminToken, { reviewNote: "doch nicht" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("MONTH_CORRECTION_NOT_PENDING");
  });

  it("the booked minutes move the live saldo once the booking day lies before today", async () => {
    const before = await computeOvertimeBalanceBreakdown(app, data.employee.id);
    // Time shift: the booking day is today, which the live saldo never includes (#438). Move it to
    // yesterday (an open month: the closed month is two months back) to observe the effect.
    await app.prisma.monthCorrectionRequest.update({
      where: { id: requestId },
      data: { bookingDate: new Date(`${openDay}T00:00:00Z`) },
    });
    const after = await computeOvertimeBalanceBreakdown(app, data.employee.id);
    expect(before).not.toBeNull();
    expect(Math.round((after!.totalHours - before!.totalHours) * 60)).toBe(480);
  });

  it("reject and withdraw: status changes, nothing is booked", async () => {
    const day = closedDay.slice(0, 8) + "11";
    const a = await post("/", data.empToken, { targetDate: day, reason: "Pause falsch erfasst." });
    expect(a.statusCode).toBe(201);
    const rej = await post(`/${a.json().id}/reject`, data.adminToken, {
      reviewNote: "Pause war korrekt.",
    });
    expect(rej.statusCode).toBe(200);
    expect(rej.json()).toMatchObject({ status: "REJECTED", overtimeTransactionId: null });

    const b = await post("/", data.empToken, { targetDate: day, reason: "Pause falsch erfasst." });
    expect(b.statusCode).toBe(201);
    expect((await post(`/${b.json().id}/withdraw`, data.adminToken)).statusCode).toBe(404);
    const w = await post(`/${b.json().id}/withdraw`, data.empToken);
    expect(w.statusCode).toBe(200);
    expect(w.json().status).toBe("WITHDRAWN");
  });

  it("on behalf: an admin files for the employee; the filer cannot decide it", async () => {
    const day = closedDay.slice(0, 8) + "12";
    const res = await post("/", data.adminToken, {
      employeeId: data.employee.id,
      targetDate: day,
      reason: "Im Auftrag eingetragen, Zettel liegt vor.",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().employeeId).toBe(data.employee.id);
    const self = await post(`/${res.json().id}/approve`, data.adminToken, {
      correctionMinutes: 30,
      reviewNote: "selbst",
    });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe("SELF_DECISION_FORBIDDEN");
    // An employee's employeeId is ignored without the ZUGEWIESEN reach: it files for themself.
    const own = await post("/", data.empToken, {
      employeeId: data.adminEmployee.id,
      targetDate: day,
      reason: "Versuch für eine andere Person.",
    });
    expect(own.statusCode).toBe(409); // own day 12 already has the on-behalf pending request
    expect(own.json().code).toBe("MONTH_CORRECTION_PENDING_EXISTS");
  });

  it("anonymization replaces the reason and clears the review note; rows stay", async () => {
    const counts = await app.prisma.$transaction((tx) =>
      clearMonthCorrectionTextsForEmployee(tx, data.employee.id),
    );
    expect(counts.monthCorrectionReasons).toBeGreaterThanOrEqual(3);
    const rows = await app.prisma.monthCorrectionRequest.findMany({
      where: { employeeId: data.employee.id },
    });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      expect(r.reason).toBe("Gelöscht (Anonymisierung)");
      expect(r.reviewNote).toBeNull();
    }
    expect(rows.find((r) => r.id === requestId)?.correctionMinutes).toBe(480);
  });
});

describe("Issue #599 — the saldo core folds accountCorrections into the balance only", () => {
  const base: CloseMonthInput = {
    employeeId: "e",
    monthStart: new Date("2026-10-31T23:00:00Z"),
    monthEnd: new Date("2026-11-30T22:59:59Z"),
    monthFirstDay: new Date("2026-11-01T00:00:00Z"),
    monthLastDay: new Date("2026-11-30T00:00:00Z"),
    tz: "Europe/Berlin",
    carryOverIn: 100,
    schedule: {
      type: "FIXED_SCHEDULE",
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
    },
    hireDate: new Date("2024-01-01T00:00:00Z"),
    exitDate: null,
    isTimeTrackingExempt: false,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    entries: [],
    shifts: [],
    approvedLeave: [],
    absences: [],
    holidayDateStrings: new Set(),
    tenantConfig: null,
  };

  it("adds only the corrections booked inside the window; Soll and Ist stay", () => {
    const plain = closeEmployeeMonth(base);
    const withCorrections = closeEmployeeMonth({
      ...base,
      accountCorrections: [
        { date: new Date("2026-11-05T00:00:00Z"), minutes: 90 },
        { date: new Date("2026-11-30T00:00:00Z"), minutes: -30 },
        { date: new Date("2026-10-31T00:00:00Z"), minutes: 1000 }, // before the window
        { date: new Date("2026-12-01T00:00:00Z"), minutes: 1000 }, // after the window
      ],
    });
    expect(withCorrections.accountCorrectionMinutes).toBe(60);
    expect(withCorrections.balanceMinutes).toBe(plain.balanceMinutes + 60);
    expect(withCorrections.carryOverOut).toBe(plain.carryOverOut + 60);
    expect(withCorrections.expectedMinutes).toBe(plain.expectedMinutes);
    expect(withCorrections.workedMinutes).toBe(plain.workedMinutes);
    expect(plain.accountCorrectionMinutes).toBe(0);
  });
});
