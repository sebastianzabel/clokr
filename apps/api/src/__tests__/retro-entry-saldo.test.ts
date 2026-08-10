/**
 * Phase 96 Plan 04 — RETRO-15: saldo/reports exclusion + ArbZG inclusion contract (VERIFY-ONLY).
 *
 * Proves — by assertion against UNCHANGED production code, not by re-implementation — that a
 * pending Nachtrag TimeEntry (isInvalid=true, created via the 96-02 entry-first POST branch):
 *
 *   - stays EXCLUDED from GET /overtime/:employeeId balance and GET /reports/monthly totals
 *     (D-04 — the ~9 pre-existing `isInvalid: false` filters already cover it; see
 *     month-saldo.ts:172, close-employee-month.ts callers, reports.ts:569/891/1003,
 *     overtime.ts (computeOvertimeBalanceHours), recalculate-snapshots.ts:172, presence.ts:145).
 *   - stays INCLUDED in checkArbZG's early warning at submission (D-03 — apps/api/src/utils/arbzg.ts
 *     is byte-identical, it filters only `deletedAt`). Proven ONLY through the entry-first
 *     POST /time-entries 201 response's `warnings` field — NEVER via a direct checkArbZG(...)
 *     call, per the plan's explicit instruction (a direct call could pass even if the endpoint
 *     never actually surfaced the warning to the client).
 *   - once APPROVED (D-05), needs no ArbZG re-run — the isInvalid flag flip alone releases the
 *     hours into saldo/reports.
 *   - once REJECTED (soft-delete), disappears from ArbZG too — proven by a same-day resubmission
 *     no longer tripping the warning the original (now soft-deleted) entry caused.
 *
 * Also pins the accepted month-close-over-pending limitation (see this phase's deferred-items.md
 * for the full write-up): a month CAN close/lock while a Nachtrag is still PENDING (the lock step
 * has no isInvalid exclusion); POST /overtime/unlock-month is the documented, tested recovery.
 * No completeness gate is built — this is a deliberate Phase-96 scope decision, not a bug.
 *
 * Zero production code is modified by this plan — every assertion below targets EXISTING
 * behavior. If any assertion here had failed (a real leak of pending time into saldo, or a
 * missing ArbZG warning), the correct response would have been a CHECKPOINT, not a silent fix.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { dateStrInTz } from "../utils/timezone";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TZ = "Europe/Berlin";

// Frozen "now" so all date arithmetic is deterministic (mirrors retro-entry-first.test.ts).
// Berlin: 2024-04-15 00:00 (Monday). Every target date below is derived as an OFFSET from
// this anchor via daysAgoInTz — never a hardcoded absolute calendar date — so nothing here
// can "expire" as real wall-clock time moves forward.
const FROZEN_NOW = new Date("2024-04-14T22:00:00.000Z");

// TenantConfig.retroEntryWindowDays default (retro-config.ts DEFAULT_WINDOW_DAYS).
const WINDOW_DAYS = 10;

function daysAgoInTz(now: Date, n: number): string {
  return dateStrInTz(new Date(now.getTime() - n * 24 * 60 * 60 * 1000), TZ);
}

/** "YYYY-MM-01" for the calendar month a "YYYY-MM-DD" date string falls in — used so the
 * close-month employee's hireDate lands in the SAME month as its Nachtrag target date,
 * which keeps POST /overtime/close-month's sequential "prior months must be closed" rule
 * a no-op (the target month IS the employee's first month). */
function firstOfMonthStr(dateStr: string): string {
  return `${dateStr.slice(0, 7)}-01`;
}

type ArbZGWarningLike = { code: string };

// ── Seed helpers (mirrors retro-entry-first.test.ts's seedEntryFirstTenant/mkUser) ─────────

async function mkUser(
  app: FastifyInstance,
  tenantId: string,
  s: string,
  role: "ADMIN" | "EMPLOYEE",
  idx: string,
  hireDateStr: string,
) {
  const prisma = app.prisma;
  const email = `${role.toLowerCase()}-${idx}-${s}@resaldo.test`;
  const user = await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash("pwTest123", 4), role, isActive: true },
  });
  const emp = await prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `${role[0]}-${idx}-${s}`,
      firstName: role,
      lastName: "RetroSaldo",
      hireDate: new Date(hireDateStr),
      classification: "VOLLZEIT",
    },
  });
  // FIXED_SCHEDULE (the "was FIXED_WEEKLY" default type), 40h/week Mon-Fri 8h — matches
  // the plan's "FIXED_WEEKLY employee" wording (see schema.prisma ScheduleType comment).
  await prisma.workSchedule.create({
    data: {
      employeeId: emp.id,
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      validFrom: new Date(hireDateStr),
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

  const loginRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: "pwTest123" },
  });
  const { accessToken } = JSON.parse(loginRes.body);
  return { user, emp, token: accessToken as string };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("RETRO-15: pending Nachtrag excluded from saldo/reports, included in ArbZG (VERIFY, no production code change)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;

  // saldoEmp: exercises balance/report/ArbZG exclusion-inclusion + approve/reject.
  let saldoEmpId: string;
  let saldoEmpToken: string;

  // closeEmp: exercises the month-close-over-pending known limitation, isolated from
  // saldoEmp so closing its month never interacts with the balance assertions above.
  let closeEmpId: string;
  let closeEmpToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    const now = FROZEN_NOW;
    const s = `resaldo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

    const tenant = await app.prisma.tenant.create({
      data: { name: `RetroSaldo ${s}`, slug: `resaldo-${s}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await app.prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
    });

    const admin = await mkUser(app, tenantId, s, "ADMIN", "a", daysAgoInTz(now, 400));
    adminToken = admin.token;

    // ~3 months of history before the earliest target date used below — enough runway for
    // GET /overtime's live per-month computation, small enough to stay fast.
    const saldoEmp = await mkUser(app, tenantId, s, "EMPLOYEE", "e1", daysAgoInTz(now, 90));
    saldoEmpId = saldoEmp.emp.id;
    saldoEmpToken = saldoEmp.token;

    const closeTargetDate = daysAgoInTz(now, WINDOW_DAYS + 43);
    const closeEmp = await mkUser(
      app,
      tenantId,
      s,
      "EMPLOYEE",
      "e2",
      firstOfMonthStr(closeTargetDate),
    );
    closeEmpId = closeEmp.emp.id;
    closeEmpToken = closeEmp.token;
  });

  afterAll(async () => {
    try {
      // Local cleanup first (mirrors retro-entry-first.test.ts): TimeEntry (frees the
      // retroRequestId FK), then RetroEntryRequest — BEFORE cleanupTestData() deletes the
      // employees. cleanupTestData() does not delete RetroEntryRequest rows itself
      // (pre-existing gap, logged in this phase's deferred-items.md during 96-02).
      await app.prisma.timeEntry.deleteMany({ where: { employee: { tenantId } } });
      await app.prisma.retroEntryRequest.deleteMany({ where: { employee: { tenantId } } });
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("retro-entry-saldo cleanup:", err);
    }
    await closeTestApp();
    vi.useRealTimers();
  });

  // ── RETRO-15 exclusion + inclusion + approve-release ────────────────────────

  describe("RETRO-15 pending exclusion (saldo/reports) + ArbZG inclusion (POST response) + approve-release", () => {
    it("pending entry leaves GET /overtime balance and GET /reports/monthly totals unchanged; ArbZG warning present in the POST 201 response while pending; approval releases the hours into saldo + reports", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 15);
        const [y, m] = targetDate.split("-").map(Number);

        const balanceBeforeRes = await app.inject({
          method: "GET",
          url: `/api/v1/overtime/${saldoEmpId}`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(balanceBeforeRes.statusCode).toBe(200);
        const balanceBefore = JSON.parse(balanceBeforeRes.body).balanceHours;

        const reportBeforeRes = await app.inject({
          method: "GET",
          url: `/api/v1/reports/monthly?employeeId=${saldoEmpId}&year=${y}&month=${m}`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(reportBeforeRes.statusCode).toBe(200);
        const workedHoursBefore = JSON.parse(reportBeforeRes.body).rows[0].workedHours;
        expect(
          workedHoursBefore,
          "fresh employee has 0 worked hours this month before any entry",
        ).toBe(0);

        const createRes = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${saldoEmpToken}` },
          payload: {
            employeeId: saldoEmpId,
            date: targetDate,
            startTime: `${targetDate}T07:00:00.000Z`,
            endTime: `${targetDate}T19:00:00.000Z`, // 12h net, 0 break -> trips §3 MAX_DAILY_EXCEEDED
            breakMinutes: 0,
            reason: "RETRO-15: langer Nachtrag-Tag zur Saldo/ArbZG-Verifikation",
          },
        });
        expect(createRes.statusCode, "entry-first pending create must return 201").toBe(201);
        const createBody = JSON.parse(createRes.body);
        expect(createBody.entry?.isInvalid, "pending entry must be isInvalid=true").toBe(true);
        const requestId = createBody.entry.retroRequestId as string;
        expect(requestId, "coupled RetroEntryRequest id must be present").toBeTruthy();

        // D-03 (RETRO-15): ArbZG inclusion proven ONLY via the POST 201 response's `warnings`
        // field — arbzg.ts is unchanged and is NEVER called directly in this test file.
        expect(Array.isArray(createBody.warnings)).toBe(true);
        expect(
          (createBody.warnings as ArbZGWarningLike[]).some((w) => w.code === "MAX_DAILY_EXCEEDED"),
          "a still-pending entry must already trip the §3 daily-max ArbZG warning at submission",
        ).toBe(true);

        const balanceAfterCreateRes = await app.inject({
          method: "GET",
          url: `/api/v1/overtime/${saldoEmpId}`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        const balanceAfterCreate = JSON.parse(balanceAfterCreateRes.body).balanceHours;
        expect(balanceAfterCreate, "D-04: a pending entry must NOT move the overtime balance").toBe(
          balanceBefore,
        );

        const reportAfterCreateRes = await app.inject({
          method: "GET",
          url: `/api/v1/reports/monthly?employeeId=${saldoEmpId}&year=${y}&month=${m}`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        const workedHoursAfterCreate = JSON.parse(reportAfterCreateRes.body).rows[0].workedHours;
        expect(
          workedHoursAfterCreate,
          "D-04: a pending entry must NOT appear in the reports total",
        ).toBe(workedHoursBefore);

        // ── Approve (D-05): no ArbZG re-run — the isInvalid flag flip alone releases it ──
        const approveRes = await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${requestId}/review`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { status: "APPROVED", reviewNote: "Freigegeben (RETRO-15 Verifikation)" },
        });
        expect(approveRes.statusCode, "approve-release must succeed").toBe(200);

        const balanceAfterApproveRes = await app.inject({
          method: "GET",
          url: `/api/v1/overtime/${saldoEmpId}`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        const balanceAfterApprove = JSON.parse(balanceAfterApproveRes.body).balanceHours;
        expect(
          balanceAfterApprove,
          "released entry must now count toward the overtime balance",
        ).toBeGreaterThan(balanceAfterCreate);

        const reportAfterApproveRes = await app.inject({
          method: "GET",
          url: `/api/v1/reports/monthly?employeeId=${saldoEmpId}&year=${y}&month=${m}`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        const workedHoursAfterApprove = JSON.parse(reportAfterApproveRes.body).rows[0].workedHours;
        expect(
          workedHoursAfterApprove,
          "released entry's 12 net hours must now appear in the reports total",
        ).toBe(12);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reject: balance stays unchanged (already excluded); soft-delete removes the day from ArbZG, proven by a same-day resubmission no longer tripping the warning", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 16);

        const balanceBeforeRes = await app.inject({
          method: "GET",
          url: `/api/v1/overtime/${saldoEmpId}`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        const balanceBefore = JSON.parse(balanceBeforeRes.body).balanceHours;

        const createRes = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${saldoEmpToken}` },
          payload: {
            employeeId: saldoEmpId,
            date: targetDate,
            startTime: `${targetDate}T07:00:00.000Z`,
            endTime: `${targetDate}T19:00:00.000Z`, // 12h -> trips MAX_DAILY_EXCEEDED while pending
            breakMinutes: 0,
            reason: "RETRO-15: wird abgelehnt (Reject-Verifikation)",
          },
        });
        expect(createRes.statusCode).toBe(201);
        const createBody = JSON.parse(createRes.body);
        expect(
          (createBody.warnings as ArbZGWarningLike[]).some((w) => w.code === "MAX_DAILY_EXCEEDED"),
          "pending entry trips the daily-max warning before rejection",
        ).toBe(true);
        const requestId = createBody.entry.retroRequestId as string;

        const balanceAfterCreateRes = await app.inject({
          method: "GET",
          url: `/api/v1/overtime/${saldoEmpId}`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(JSON.parse(balanceAfterCreateRes.body).balanceHours).toBe(balanceBefore);

        const rejectRes = await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${requestId}/review`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { status: "REJECTED", reviewNote: "Nicht plausibel (RETRO-15 Verifikation)" },
        });
        expect(rejectRes.statusCode).toBe(200);

        const rejectedEntry = await app.prisma.timeEntry.findFirst({
          where: { retroRequestId: requestId },
        });
        expect(
          rejectedEntry?.deletedAt,
          "coupled entry must be soft-deleted, never hard-deleted",
        ).not.toBeNull();

        const balanceAfterRejectRes = await app.inject({
          method: "GET",
          url: `/api/v1/overtime/${saldoEmpId}`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(
          JSON.parse(balanceAfterRejectRes.body).balanceHours,
          "balance stays unchanged after reject (was already excluded while pending)",
        ).toBe(balanceBefore);

        // Day is free again (the partial unique index filters deletedAt:null only) — resubmit
        // a normal 7.5h day. If the rejected 12h entry were still silently counted by ArbZG,
        // the day's total would be 19.5h and MAX_DAILY_EXCEEDED would fire again below.
        const resubmitRes = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${saldoEmpToken}` },
          payload: {
            employeeId: saldoEmpId,
            date: targetDate,
            startTime: `${targetDate}T08:00:00.000Z`,
            endTime: `${targetDate}T16:00:00.000Z`,
            breakMinutes: 30,
            reason: "RETRO-15: korrigierte Neuvorlage nach Ablehnung",
          },
        });
        expect(resubmitRes.statusCode, "day must be free for a fresh submission after reject").toBe(
          201,
        );
        const resubmitBody = JSON.parse(resubmitRes.body);
        expect(
          (resubmitBody.warnings as ArbZGWarningLike[]).some(
            (w) => w.code === "MAX_DAILY_EXCEEDED",
          ),
          "the rejected/soft-deleted entry's hours must no longer contribute to this day's ArbZG total",
        ).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── RETRO-15 known-limitation: month-close-over-pending + unlock-month recovery ──

  describe("RETRO-15 known-limitation: month closes over pending, unlock-month recovers", () => {
    it("close-month locks the still-pending coupled entry (review 403 while locked); unlock-month un-sticks it (review then succeeds)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 43);
        const [closeYear, closeMonth] = targetDate.split("-").map(Number);

        // Self-submit (closeEmpToken), NOT adminToken: a manager/admin creating for a
        // DIFFERENT employee sets isCorrectionByManager=true, which EXEMPTS the create from
        // the retro-window guard entirely — the entry would never become pending at all.
        const createRes = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${closeEmpToken}` },
          payload: {
            employeeId: closeEmpId,
            date: targetDate,
            startTime: `${targetDate}T08:00:00.000Z`,
            endTime: `${targetDate}T16:00:00.000Z`,
            breakMinutes: 30,
            reason: "RETRO-15: pending Nachtrag vor Monatsabschluss",
          },
        });
        expect(createRes.statusCode).toBe(201);
        const createBody = JSON.parse(createRes.body);
        const requestId = createBody.entry.retroRequestId as string;
        const entryId = createBody.entry.id as string;
        expect(createBody.entry.isInvalid).toBe(true);
        expect(createBody.entry.isLocked, "entry starts unlocked").toBe(false);

        const closeRes = await app.inject({
          method: "POST",
          url: "/api/v1/overtime/close-month",
          headers: { authorization: `Bearer ${adminToken}` },
          payload: {
            employeeId: closeEmpId,
            year: closeYear,
            month: closeMonth,
            confirmGaps: true,
          },
        });
        expect(
          closeRes.statusCode,
          "close-month must succeed even with a still-pending Nachtrag in range",
        ).toBe(201);

        const lockedEntry = await app.prisma.timeEntry.findUnique({ where: { id: entryId } });
        expect(
          lockedEntry?.isLocked,
          "KNOWN LIMITATION: month-close locks the pending entry too (the lock step's updateMany has no isInvalid exclusion)",
        ).toBe(true);
        expect(lockedEntry?.isInvalid, "entry is still pending, only now also locked").toBe(true);

        const blockedApproveRes = await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${requestId}/review`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { status: "APPROVED", reviewNote: "Versuch waehrend gesperrt" },
        });
        expect(
          blockedApproveRes.statusCode,
          "D-09: a locked coupled entry must 403 on review, never silently release",
        ).toBe(403);

        const unlockRes = await app.inject({
          method: "POST",
          url: "/api/v1/overtime/unlock-month",
          headers: { authorization: `Bearer ${adminToken}` },
          payload: {
            employeeId: closeEmpId,
            year: closeYear,
            month: closeMonth,
            reason: "RETRO-15: Monat wieder oeffnen fuer ausstehenden Nachtrag",
          },
        });
        expect(unlockRes.statusCode, "ADMIN unlock-month is the documented recovery path").toBe(
          200,
        );

        const unlockedEntry = await app.prisma.timeEntry.findUnique({ where: { id: entryId } });
        expect(unlockedEntry?.isLocked, "unlock-month un-sticks the pending entry too").toBe(false);

        const approveAfterUnlockRes = await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${requestId}/review`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { status: "APPROVED", reviewNote: "Freigegeben nach Entsperren" },
        });
        expect(
          approveAfterUnlockRes.statusCode,
          "review succeeds again once the month is unlocked",
        ).toBe(200);

        const releasedEntry = await app.prisma.timeEntry.findUnique({ where: { id: entryId } });
        expect(releasedEntry?.isInvalid, "entry is finally released").toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
