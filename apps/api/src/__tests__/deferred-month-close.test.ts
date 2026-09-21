/**
 * Phase 292 (GitHub issue #292) — "Auto-Monatsabschluss stellt bei Lücken still und unbefristet
 * zurück". Four blocks, in the order the issue demands them:
 *
 *   A. THE MEASUREMENT. What counts as a gap, and why one missing clock-out blocks an employee
 *      for months while another employee with a missing clock-out closes normally.
 *   B. THE STATE. A deferred Monatsabschluss is queryable — four employees, four months.
 *   C. THE ESCALATION. Repeated, age-graded, deep-linked.
 *   D. THE TWO PROHIBITIONS. `closeMonthWithGapsAllowed=false` still closes nothing, and no
 *      end time is ever invented.
 *
 * No PII — fixtures use A/B/C/D/E initials only (memory feedback_no_pii_in_github).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import { monthRangeUtc } from "../contexts/working-time-account/timezone";
import { detectMonthGaps } from "../contexts/working-time-account/month-gap-check";
import {
  getDeferredMonthCloseState,
  severityForMonthsBehind,
} from "../contexts/working-time-account/deferred-month-close";

const TZ = "Europe/Berlin";
/** The instant the production measurement in issue #292 was taken. */
const MEASURED_NOW = new Date("2026-09-21T06:00:00.000Z");

type SchedInput = {
  type: "SHIFT_BASED" | "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS";
  validFrom: Date;
};

async function createTenant(app: FastifyInstance, slugPart: string, closeWithGaps = false) {
  const s = `${slugPart}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tenant = await app.prisma.tenant.create({
    data: { name: `D292 ${s}`, slug: `d292-${s}`, federalState: "NIEDERSACHSEN" },
  });
  await app.prisma.tenantConfig.create({
    data: {
      tenantId: tenant.id,
      defaultVacationDays: 30,
      timezone: TZ,
      retroEntryWindowDays: 10,
      closeMonthWithGapsAllowed: closeWithGaps,
    },
  });
  return { tenantId: tenant.id, s };
}

async function createEmployee(
  app: FastifyInstance,
  tenantId: string,
  opts: {
    key: string;
    role?: "ADMIN" | "MANAGER" | "EMPLOYEE";
    hireDate: Date;
    schedule: SchedInput;
    exempt?: boolean;
    password?: string;
  },
) {
  const uniq = `${opts.key}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const user = await app.prisma.user.create({
    data: {
      email: `d292-${uniq}@test.de`,
      passwordHash: await bcrypt.hash(opts.password ?? "test1234", 10),
      role: opts.role ?? "EMPLOYEE",
      isActive: true,
    },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `N-${uniq}`,
      firstName: opts.key.toUpperCase(),
      lastName: "T.",
      hireDate: opts.hireDate,
      isTimeTrackingExempt: opts.exempt ?? false,
    },
  });
  await app.prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
      type: opts.schedule.type,
      weeklyHours: 40,
      // SHIFT_BASED/FLEXTIME {day}Hours are placeholders (CLAUDE.md) — kept at the schema default.
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: opts.schedule.type === "SHIFT_BASED" ? 5 : null,
      validFrom: opts.schedule.validFrom,
    },
  });
  await app.prisma.overtimeAccount.create({
    data: { employeeId: employee.id, balanceHours: 0 },
  });
  return { employeeId: employee.id, userId: user.id, email: user.email };
}

/** Close a month by writing the snapshot the auto-closer would have written. */
async function seedClosedMonth(
  app: FastifyInstance,
  employeeId: string,
  year: number,
  month: number,
) {
  const { start, end } = monthRangeUtc(year, month, TZ);
  await app.prisma.saldoSnapshot.create({
    data: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: start,
      periodEnd: end,
      workedMinutes: 0,
      expectedMinutes: 0,
      balanceMinutes: 0,
      carryOver: 0,
      closedAt: new Date("2026-06-01T06:00:00.000Z"),
      closedBy: null,
      note: "Fixture",
    },
  });
}

async function seedShift(app: FastifyInstance, employeeId: string, dateStr: string) {
  await app.prisma.shift.create({
    data: {
      employeeId,
      date: new Date(`${dateStr}T00:00:00Z`),
      startTime: "09:00",
      endTime: "17:00",
    },
  });
}

async function seedEntry(
  app: FastifyInstance,
  employeeId: string,
  dateStr: string,
  opts: { open?: boolean; isInvalid?: boolean } = {},
) {
  return app.prisma.timeEntry.create({
    data: {
      employeeId,
      date: new Date(`${dateStr}T00:00:00Z`),
      startTime: new Date(`${dateStr}T07:00:00Z`),
      endTime: opts.open ? null : new Date(`${dateStr}T15:30:00Z`),
      breakMinutes: 30,
      type: "WORK",
      isInvalid: opts.isInvalid ?? false,
    },
  });
}

async function scheduleRowFor(app: FastifyInstance, employeeId: string) {
  const row = await app.prisma.workSchedule.findFirst({
    where: { employeeId },
    orderBy: { validFrom: "desc" },
  });
  return row as unknown as Record<string, unknown>;
}

// ── Block A — the measurement ────────────────────────────────────────────────────────────────

describe("Phase 292 A — Messung: was genau zählt als Lücke im Monatsabschluss", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let shiftEmp: string;
  let fixedEmp: string;
  let flexEmp: string;

  const HIRE = new Date("2026-01-01T00:00:00Z");

  beforeAll(async () => {
    app = await getTestApp();
    ({ tenantId } = await createTenant(app, "meas"));

    shiftEmp = (
      await createEmployee(app, tenantId, {
        key: "a",
        hireDate: HIRE,
        schedule: { type: "SHIFT_BASED", validFrom: HIRE },
      })
    ).employeeId;
    fixedEmp = (
      await createEmployee(app, tenantId, {
        key: "b",
        hireDate: HIRE,
        schedule: { type: "FIXED_SCHEDULE", validFrom: HIRE },
      })
    ).employeeId;
    flexEmp = (
      await createEmployee(app, tenantId, {
        key: "c",
        hireDate: HIRE,
        schedule: { type: "FLEXTIME", validFrom: HIRE },
      })
    ).employeeId;

    // SHIFT_BASED: two rostered days, two unrostered days.
    await seedShift(app, shiftEmp, "2026-05-04"); // Mo — open entry, rostered
    await seedShift(app, shiftEmp, "2026-05-05"); // Tu — closed but INVALID entry, rostered
    await seedShift(app, shiftEmp, "2026-05-06"); // We — no entry at all, rostered
    await seedEntry(app, shiftEmp, "2026-05-04", { open: true });
    await seedEntry(app, shiftEmp, "2026-05-05", { isInvalid: true });
    await seedEntry(app, shiftEmp, "2026-05-11", { open: true }); // Mo — NOT rostered

    // FIXED_SCHEDULE Mo-Fr: an open entry on an obligated workday.
    await seedEntry(app, fixedEmp, "2026-05-04", { open: true });
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("deferred-month-close A cleanup:", err);
    }
  });

  it("M1: eine fehlende Ausstempelung auf einem GEPLANTEN Tag IST eine Lücke", async () => {
    const res = await detectMonthGaps(app.prisma, {
      tenantId,
      employeeId: shiftEmp,
      hireDate: HIRE,
      schedule: await scheduleRowFor(app, shiftEmp),
      month: { year: 2026, month: 5 },
      tz: TZ,
      stateCode: "NI",
    });
    expect(res.gapRuleApplies).toBe(true);
    // 05-04 carries a TimeEntry — but it has no endTime, and the Monatsabschluss reads the
    // CLOSED-entry set (facade T2, `endTime: { not: null }`). The day is therefore a gap.
    expect(res.gapDates).toContain("2026-05-04");
  });

  it("M2: dieselbe fehlende Ausstempelung auf einem NICHT geplanten Tag ist KEINE Lücke — das erklärt den fünften Fall", async () => {
    const res = await detectMonthGaps(app.prisma, {
      tenantId,
      employeeId: shiftEmp,
      hireDate: HIRE,
      schedule: await scheduleRowFor(app, shiftEmp),
      month: { year: 2026, month: 5 },
      tz: TZ,
      stateCode: "NI",
    });
    // 2026-05-11 has an open entry too, but no roster shift — for SHIFT_BASED the roster, never
    // {day}Hours, decides which days are expected. A missing clock-out therefore blocks the
    // Monatsabschluss only when its day is ALSO an expected day.
    expect(res.gapDates).not.toContain("2026-05-11");
  });

  it("M3: ein GESCHLOSSENER, aber isInvalid-Eintrag zählt als Eintrag — keine Lücke", async () => {
    const res = await detectMonthGaps(app.prisma, {
      tenantId,
      employeeId: shiftEmp,
      hireDate: HIRE,
      schedule: await scheduleRowFor(app, shiftEmp),
      month: { year: 2026, month: 5 },
      tz: TZ,
      stateCode: "NI",
    });
    expect(res.gapDates).not.toContain("2026-05-05");
    // …while the rostered day with no entry at all of course is one.
    expect(res.gapDates).toContain("2026-05-06");
    // Exactly the two: the open-entry day and the no-entry day.
    expect([...res.gapDates].sort()).toEqual(["2026-05-04", "2026-05-06"]);
  });

  it("M4: FIXED_SCHEDULE — fehlende Ausstempelung auf einem Pflicht-Wochentag ist eine Lücke", async () => {
    const res = await detectMonthGaps(app.prisma, {
      tenantId,
      employeeId: fixedEmp,
      hireDate: HIRE,
      schedule: await scheduleRowFor(app, fixedEmp),
      month: { year: 2026, month: 5 },
      tz: TZ,
      stateCode: "NI",
    });
    expect(res.gapRuleApplies).toBe(true);
    expect(res.gapDates).toContain("2026-05-04");
  });

  it("M5: FLEXTIME kennt gar keine Tageslücke — auch ohne einen einzigen Zeiteintrag", async () => {
    const res = await detectMonthGaps(app.prisma, {
      tenantId,
      employeeId: flexEmp,
      hireDate: HIRE,
      schedule: await scheduleRowFor(app, flexEmp),
      month: { year: 2026, month: 5 },
      tz: TZ,
      stateCode: "NI",
    });
    // This is why the deferral state must NOT be keyed on "has gaps": a FLEXTIME employee can
    // sit unclosed for months without a single gap ever being reported for them.
    expect(res.gapRuleApplies).toBe(false);
    expect(res.gapDates).toEqual([]);
  });
});

// ── Block B — the state ──────────────────────────────────────────────────────────────────────

describe("Phase 292 B — der zurückgestellte Monatsabschluss ist ein abfragbarer Zustand", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let otherTenantId: string;
  let adminEmail: string;
  let plainEmail: string;
  let empA: string;
  let empD: string;
  let empE: string;

  const HIRE = new Date("2026-01-01T00:00:00Z");

  beforeAll(async () => {
    app = await getTestApp();
    ({ tenantId } = await createTenant(app, "state"));

    // The recipient/admin is §18-exempt so it does not itself appear in the state.
    const admin = await createEmployee(app, tenantId, {
      key: "adm",
      role: "ADMIN",
      hireDate: HIRE,
      schedule: { type: "FIXED_SCHEDULE", validFrom: HIRE },
      exempt: true,
    });
    adminEmail = admin.email;

    // A, B, C — SHIFT_BASED, last closed month = April 2026, one rostered May day each.
    const withGap: string[] = [];
    for (const [key, day] of [
      ["a", "2026-05-04"],
      ["b", "2026-05-05"],
      ["c", "2026-05-06"],
    ] as const) {
      const e = await createEmployee(app, tenantId, {
        key,
        hireDate: HIRE,
        schedule: { type: "SHIFT_BASED", validFrom: HIRE },
      });
      withGap.push(e.employeeId);
      for (const m of [1, 2, 3, 4]) await seedClosedMonth(app, e.employeeId, 2026, m);
      await seedShift(app, e.employeeId, day);
    }
    empA = withGap[0];
    // A's rostered day carries an entry that was never clocked out — the measured case.
    await seedEntry(app, empA, "2026-05-04", { open: true });

    // D — FLEXTIME, same backlog, but no gap rule at all: overdue WITHOUT gaps.
    const d = await createEmployee(app, tenantId, {
      key: "d",
      hireDate: HIRE,
      schedule: { type: "FLEXTIME", validFrom: HIRE },
    });
    empD = d.employeeId;
    for (const m of [1, 2, 3, 4]) await seedClosedMonth(app, empD, 2026, m);

    // E — the control: closed through August, must NOT appear.
    const e5 = await createEmployee(app, tenantId, {
      key: "e",
      hireDate: HIRE,
      schedule: { type: "FIXED_SCHEDULE", validFrom: HIRE },
    });
    empE = e5.employeeId;
    for (const m of [1, 2, 3, 4, 5, 6, 7, 8]) await seedClosedMonth(app, empE, 2026, m);

    // A plain EMPLOYEE, used to prove the route is manager-only.
    const plain = await createEmployee(app, tenantId, {
      key: "plain",
      role: "EMPLOYEE",
      hireDate: HIRE,
      schedule: { type: "FIXED_SCHEDULE", validFrom: HIRE },
      exempt: true,
    });
    plainEmail = plain.email;

    // A second tenant, fully closed — proves the state is tenant-scoped.
    ({ tenantId: otherTenantId } = await createTenant(app, "other"));
    const foreign = await createEmployee(app, otherTenantId, {
      key: "x",
      hireDate: HIRE,
      schedule: { type: "FIXED_SCHEDULE", validFrom: HIRE },
    });
    for (const m of [1, 2, 3, 4]) await seedClosedMonth(app, foreign.employeeId, 2026, m);
  }, 180_000);

  afterAll(async () => {
    for (const t of [tenantId, otherTenantId]) {
      try {
        await cleanupTestData(app, t);
      } catch (err) {
        console.error("deferred-month-close B cleanup:", err);
      }
    }
  });

  it("S1: vier Mitarbeiter, vier Monate Rückstand — der gemessene Produktionsfall wird als Zustand erkannt", async () => {
    const state = await getDeferredMonthCloseState(app.prisma, tenantId, {
      now: MEASURED_NOW,
      detailed: true,
    });

    expect(state.employeeCount).toBe(4);
    expect(state.oldestOpenMonth).toEqual({ year: 2026, month: 5 });
    // May, June, July and August are all past their day-10 window on 2026-09-21.
    expect(state.monthsBehind).toBe(4);
    expect(state.severity).toBe("CRITICAL");
    // A, B and C each contribute exactly one gap day; D contributes none (FLEXTIME).
    expect(state.gapCount).toBe(3);

    const ids = state.employees.map((e) => e.employeeId);
    expect(ids).toContain(empA);
    expect(ids).toContain(empD);
    expect(ids).not.toContain(empE); // the control, closed through August
    for (const e of state.employees) {
      expect(e.monthsBehind).toBe(4);
      expect(e.oldestOpenMonth).toEqual({ year: 2026, month: 5 });
    }
  }, 120_000);

  it("S2: der Weg zur Behebung ist kurz — die konkreten Lückentage stehen im Zustand", async () => {
    const state = await getDeferredMonthCloseState(app.prisma, tenantId, {
      now: MEASURED_NOW,
      detailed: true,
    });
    const rowA = state.employees.find((e) => e.employeeId === empA);
    expect(rowA?.reason).toBe("GAPS");
    expect(rowA?.gapDates).toEqual(["2026-05-04"]);
  }, 120_000);

  it("S3: ein Mitarbeiter ohne Tageslücken-Regel (FLEXTIME) wird trotzdem gemeldet — der Zustand hängt nicht an 'hat Lücken'", async () => {
    const state = await getDeferredMonthCloseState(app.prisma, tenantId, {
      now: MEASURED_NOW,
      detailed: true,
    });
    const rowD = state.employees.find((e) => e.employeeId === empD);
    expect(rowD).toBeDefined();
    expect(rowD?.gapCount).toBe(0);
    expect(rowD?.reason).toBe("UNKNOWN");
  }, 120_000);

  it("S4: die Dringlichkeit wächst mit dem Alter", () => {
    expect(severityForMonthsBehind(0)).toBe("NONE");
    expect(severityForMonthsBehind(1)).toBe("INFO");
    expect(severityForMonthsBehind(2)).toBe("WARNING");
    expect(severityForMonthsBehind(3)).toBe("CRITICAL");
    expect(severityForMonthsBehind(4)).toBe("CRITICAL");
  });

  it("S5: im Juni 2026 wäre derselbe Mandant erst EIN Monat im Rückstand (INFO) — das Alter ist echt gemessen, nicht konstant", async () => {
    const state = await getDeferredMonthCloseState(app.prisma, tenantId, {
      now: new Date("2026-06-21T06:00:00.000Z"),
      detailed: false,
    });
    expect(state.monthsBehind).toBe(1);
    expect(state.severity).toBe("INFO");
    expect(state.oldestOpenMonth).toEqual({ year: 2026, month: 5 });
  }, 120_000);

  it("S6: der Zustand ist mandantengebunden — der zweite Mandant ist sauber", async () => {
    const state = await getDeferredMonthCloseState(app.prisma, otherTenantId, {
      now: MEASURED_NOW,
      detailed: true,
    });
    // The foreign tenant's employee is closed through April and its May..August months are open
    // too — but it must never appear in THIS tenant's state, and vice versa.
    const thisTenant = await getDeferredMonthCloseState(app.prisma, tenantId, {
      now: MEASURED_NOW,
      detailed: false,
    });
    const foreignIds = new Set(state.employees.map((e) => e.employeeId));
    for (const e of thisTenant.employees) expect(foreignIds.has(e.employeeId)).toBe(false);
  }, 120_000);

  it("S7: GET /overtime/close-month/deferred liefert den Zustand; EMPLOYEE darf nicht", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: adminEmail, password: "test1234" },
    });
    const token = JSON.parse(loginRes.body).accessToken as string;
    expect(token).toBeTruthy();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/overtime/close-month/deferred?detailed=true",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.employeeCount).toBe(4);
    expect(body.oldestOpenMonth).toEqual({ year: 2026, month: 5 });
    expect(body.severity).toBe("CRITICAL");

    // An employee-role token must not read the tenant-wide state.
    const empLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: plainEmail, password: "test1234" },
    });
    const empToken = JSON.parse(empLogin.body).accessToken as string;
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/v1/overtime/close-month/deferred",
      headers: { authorization: `Bearer ${empToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
  }, 120_000);
});

// ── Block C — the escalation ─────────────────────────────────────────────────────────────────

describe("Phase 292 C — wiederholte, mit dem Alter wachsende Eskalation", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let managerUserId: string;

  const HIRE = new Date("2026-01-01T00:00:00Z");
  const REMINDER_SOURCE = readFileSync(
    join(
      __dirname,
      "..",
      "contexts",
      "working-time-account",
      "plugins",
      "deferred-month-close-reminder.ts",
    ),
    "utf-8",
  );

  beforeAll(async () => {
    app = await getTestApp();
    ({ tenantId } = await createTenant(app, "esc"));

    const mgr = await createEmployee(app, tenantId, {
      key: "mgr",
      role: "MANAGER",
      hireDate: HIRE,
      schedule: { type: "FIXED_SCHEDULE", validFrom: HIRE },
      exempt: true,
    });
    managerUserId = mgr.userId;

    const e = await createEmployee(app, tenantId, {
      key: "a",
      hireDate: HIRE,
      schedule: { type: "SHIFT_BASED", validFrom: HIRE },
    });
    for (const m of [1, 2, 3, 4]) await seedClosedMonth(app, e.employeeId, 2026, m);
    await seedShift(app, e.employeeId, "2026-05-04");
    await seedEntry(app, e.employeeId, "2026-05-04", { open: true });
  }, 180_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("deferred-month-close C cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("E1: die Kadenz ist wöchentlich (Mo), nicht täglich — und steht so im Code", () => {
    expect(REMINDER_SOURCE.length).toBeGreaterThan(1000); // the file was really read
    expect(REMINDER_SOURCE).toContain("cron.schedule(");
    expect(REMINDER_SOURCE).toContain('"0 7 * * 1"');
    // A daily schedule here would recreate exactly the habituation the issue names.
    expect(REMINDER_SOURCE).not.toContain('"0 7 * * *"');
    expect(REMINDER_SOURCE).not.toContain('"0 6 * * *"');
  });

  it("E2: die Meldung nennt Mitarbeiterzahl, ältesten Monat, Lückenzahl und verlinkt genau diesen Monat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MEASURED_NOW);
    try {
      await app.remindDeferredMonthClose();
    } finally {
      vi.useRealTimers();
    }

    const notifs = await app.prisma.notification.findMany({
      where: { userId: managerUserId, type: "MONTH_CLOSE_DEFERRED" },
      orderBy: { createdAt: "asc" },
    });
    expect(notifs.length).toBe(1);
    const n = notifs[0];
    expect(n.title).toContain("Dringend"); // 4 months behind → CRITICAL
    expect(n.title).toContain("Mai 2026");
    expect(n.message).toContain("1 Mitarbeiter");
    expect(n.message).toContain("4 Monate Rückstand");
    expect(n.message).toContain("2026-05-04"); // the concrete gap day
    expect(n.message).toContain("§ 16 Abs. 2 ArbZG");
    // Short path from the message to the gap days: the link names the blocked month itself.
    expect(n.link).toBe("/admin/month-close?year=2026&month=5");
  }, 120_000);

  it("E3: sie wiederholt sich, solange der Zustand anhält — ein weggeklickter Hinweis bleibt nicht weggeklickt", async () => {
    await app.prisma.notification.updateMany({
      where: { userId: managerUserId, type: "MONTH_CLOSE_DEFERRED" },
      data: { dismissedAt: new Date(), read: true },
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T06:00:00.000Z")); // the following Monday
    try {
      await app.remindDeferredMonthClose();
    } finally {
      vi.useRealTimers();
    }

    const open = await app.prisma.notification.findMany({
      where: { userId: managerUserId, type: "MONTH_CLOSE_DEFERRED", dismissedAt: null },
    });
    expect(open.length).toBe(1);
  }, 120_000);
});

// ── Block D — the two prohibitions ───────────────────────────────────────────────────────────

describe("Phase 292 D — closeMonthWithGapsAllowed=false schliesst nichts und erfindet keine Endzeiten", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;
  let openEntryId: string;
  let riegelManagerUserId: string;

  const HIRE = new Date("2026-01-01T00:00:00Z");

  beforeAll(async () => {
    app = await getTestApp();
    ({ tenantId } = await createTenant(app, "riegel", false));

    // Deliberately § 18 ArbZG-EXEMPT: that is the normal shape for the person who runs the
    // Monatsabschluss, and before Phase 292 such a manager was silently not a notification
    // recipient at all (recipients were filtered out of the non-exempt employee list).
    const mgr = await createEmployee(app, tenantId, {
      key: "mgr",
      role: "ADMIN",
      hireDate: HIRE,
      schedule: { type: "FIXED_SCHEDULE", validFrom: HIRE },
      exempt: true,
    });
    riegelManagerUserId = mgr.userId;

    const e = await createEmployee(app, tenantId, {
      key: "a",
      hireDate: HIRE,
      schedule: { type: "SHIFT_BASED", validFrom: HIRE },
    });
    empId = e.employeeId;
    for (const m of [1, 2, 3, 4]) await seedClosedMonth(app, empId, 2026, m);
    await seedShift(app, empId, "2026-05-04");
    await seedShift(app, empId, "2026-05-05");
    const open = await seedEntry(app, empId, "2026-05-04", { open: true });
    openEntryId = open.id;
    // 2026-05-05 is rostered and has NO entry at all — a hard gap.
  }, 180_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("deferred-month-close D cleanup:", err);
    }
    await closeTestApp();
    vi.useRealTimers();
  });

  it("P1: der Monat bleibt offen, die fehlende Endzeit bleibt fehlend, es entsteht kein Eintrag", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MEASURED_NOW); // 21.09. — May is long past its day-10 window
    try {
      await app.tryAutoCloseMonth();
    } finally {
      vi.useRealTimers();
    }

    const { start: mayStart } = monthRangeUtc(2026, 5, TZ);
    const maySnap = await app.prisma.saldoSnapshot.findFirst({
      where: {
        employeeId: empId,
        periodType: "MONTHLY",
        periodStart: mayStart,
        superseded: false,
      },
    });
    expect(maySnap, "Mai darf mit Lücken NICHT automatisch geschlossen werden").toBeNull();

    // …and no later month may have been closed over the blocked one either.
    const { start: juneStart } = monthRangeUtc(2026, 6, TZ);
    const juneSnap = await app.prisma.saldoSnapshot.findFirst({
      where: {
        employeeId: empId,
        periodType: "MONTHLY",
        periodStart: juneStart,
        superseded: false,
      },
    });
    expect(juneSnap).toBeNull();

    // No end time was invented for the open entry.
    const open = await app.prisma.timeEntry.findUnique({ where: { id: openEntryId } });
    expect(open?.endTime).toBeNull();

    // And no entry was fabricated for the entry-less rostered day.
    const fabricated = await app.prisma.timeEntry.findFirst({
      where: { employeeId: empId, date: new Date("2026-05-05T00:00:00Z") },
    });
    expect(fabricated).toBeNull();

    // The month's entries must also not have been locked — locking is part of closing.
    expect(open?.isLocked).toBe(false);
  }, 180_000);

  it("P2: die tägliche Meldung nennt jetzt den ÄLTESTEN blockierten Monat und verlinkt ihn — nicht den Vormonat", async () => {
    const notifs = await app.prisma.notification.findMany({
      where: { userId: riegelManagerUserId, type: "MONTH_CLOSE_BLOCKED" },
    });
    expect(notifs.length).toBe(1);
    // Before Phase 292 the title named `prevMonth` — "August 2026" for a May-blocked employee
    // measured in September, i.e. a month that closed fine.
    expect(notifs[0].title).toContain("Mai 2026");
    expect(notifs[0].title).not.toContain("August 2026");
    expect(notifs[0].link).toBe("/admin/month-close?year=2026&month=5");
  }, 120_000);

  it("P3: ein zweiter Lauf mit unverändertem Zustand erzeugt KEINE zweite Meldung — kein tägliches Rauschen", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T06:00:00.000Z")); // the next morning
    try {
      await app.tryAutoCloseMonth();
    } finally {
      vi.useRealTimers();
    }

    const notifs = await app.prisma.notification.findMany({
      where: { userId: riegelManagerUserId, type: "MONTH_CLOSE_BLOCKED" },
    });
    expect(
      notifs.length,
      "unveränderter blockierter Zustand darf keine zweite tägliche Meldung erzeugen",
    ).toBe(1);
  }, 180_000);
});
