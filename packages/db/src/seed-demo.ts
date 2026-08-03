/**
 * seed-demo.ts — RICH pseudonymized demo-data seed for the Clokr DEV stack.
 *
 * Purpose: populate a SINGLE demo tenant with enough realistic (but fully
 * pseudonymized / invented) data that every major screen looks populated for
 * showcase SCREENSHOTS.
 *
 * Run against an EMPTY database (drop+recreate schema, `prisma migrate deploy`,
 * then run this). It guards against a pre-existing demo tenant and bails early.
 *
 * PII SAFETY: every name here is invented. Do NOT put real people in this file.
 *
 * TIMEZONE NOTE: TimeEntry/Break timestamps are built with the Berlin *summer*
 * offset (CEST, UTC+2) via clock(). The current + previous month at authoring
 * time are both in CEST, so this is correct for the demo window. Shift times are
 * plain "HH:mm" strings and are TZ-agnostic. If you ever run this in winter for a
 * winter month, adjust CEST_OFFSET_H accordingly.
 */

import { PrismaClient } from "../generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import bcrypt from "bcryptjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

const DEMO_PASSWORD = "demo1234";
const TENANT_SLUG = "demo-clokr";
const EMAIL_DOMAIN = "demo.clokr.de";

// ── Enum unions (mirror schema.prisma exactly) ───────────────────────────────
type RoleT = "ADMIN" | "MANAGER" | "EMPLOYEE";
type SchedT = "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED";
type ClsT =
  | "VOLLZEIT"
  | "TEILZEIT"
  | "MINIJOB"
  | "AZUBI"
  | "AUSHILFE"
  | "WERKSTUDENT"
  | "PRAKTIKANT";

// ── Date helpers (calendar math done at UTC midnight — DST-safe) ─────────────
const DAY_MS = 86_400_000;
const CEST_OFFSET_H = 2; // Berlin summer offset

const now = new Date();
const Y = now.getFullYear();
const M = now.getMonth(); // 0-based current month
const D = now.getDate();

// previous month
const prevRef = new Date(Y, M - 1, 1);
const PY = prevRef.getFullYear();
const PM = prevRef.getMonth();
const prevLastDay = new Date(Y, M, 0).getDate();

// next month
const nextRef = new Date(Y, M + 1, 1);
const NY = nextRef.getFullYear();
const NM = nextRef.getMonth();

/** UTC-midnight Date for a calendar (y, m, d) — matches Prisma @db.Date semantics. */
function d0(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m, day));
}
/** Add n calendar days to a UTC-midnight date. */
function addDays(base: Date, n: number): Date {
  return new Date(base.getTime() + n * DAY_MS);
}
/** UTC instant for Berlin-summer HH:MM on the given UTC-midnight calendar day. */
function clock(day: Date, hh: number, mm: number): Date {
  return new Date(day.getTime() + ((hh - CEST_OFFSET_H) * 60 + mm) * 60_000);
}
/** noon UTC — safe for hireDate/validFrom/birthDate style Timestamptz/Date fields. */
function noon(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m, day, 12));
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const isWeekdayUTC = (d: Date) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
function businessDays(from: Date, to: Date): number {
  let n = 0;
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
    if (isWeekdayUTC(new Date(t))) n++;
  }
  return n;
}

// current-week Monday (UTC calendar)
const todayUTC = d0(Y, M, D);
const jsDow = todayUTC.getUTCDay(); // 0=Sun..6=Sat
const monday = addDays(todayUTC, jsDow === 0 ? -6 : 1 - jsDow);

const stats: Record<string, number> = {};
const bump = (k: string, n = 1) => (stats[k] = (stats[k] ?? 0) + n);

// ── Employee specs ───────────────────────────────────────────────────────────
interface EmpSpec {
  handle: string;
  first: string;
  last: string;
  num: string;
  role: RoleT;
  cls: ClsT;
  sched: SchedT;
  weekly: number | null;
  monthly: number | null;
  // [mon, tue, wed, thu, fri, sat, sun]
  dayHours: [number, number, number, number, number, number, number];
  hire: [number, number, number];
  otBalance: number;
  nfc?: string;
  birth?: [number, number, number];
  requiresSupervision?: boolean;
  coverageWeight?: number;
}

const F = (h: number): [number, number, number, number, number, number, number] => [
  h,
  h,
  h,
  h,
  h,
  0,
  0,
];

const EMPLOYEES: EmpSpec[] = [
  {
    handle: "admin",
    first: "Admin",
    last: "Demo",
    num: "001",
    role: "ADMIN",
    cls: "VOLLZEIT",
    sched: "FIXED_SCHEDULE",
    weekly: 40,
    monthly: null,
    dayHours: F(8),
    hire: [2019, 0, 15],
    otBalance: 0,
    nfc: "NFC-DEMO-001",
  },
  {
    handle: "lena",
    first: "Lena",
    last: "Vogel",
    num: "002",
    role: "MANAGER",
    cls: "VOLLZEIT",
    sched: "FIXED_SCHEDULE",
    weekly: 40,
    monthly: null,
    dayHours: F(8),
    hire: [2020, 2, 1],
    otBalance: 12.5,
    nfc: "NFC-DEMO-002",
  },
  {
    handle: "jonas",
    first: "Jonas",
    last: "Berg",
    num: "003",
    role: "MANAGER",
    cls: "VOLLZEIT",
    sched: "FIXED_SCHEDULE",
    weekly: 40,
    monthly: null,
    dayHours: F(8),
    hire: [2021, 5, 1],
    otBalance: 30.0,
    nfc: "NFC-DEMO-003",
  },
  {
    handle: "aylin",
    first: "Aylin",
    last: "Kaya",
    num: "004",
    role: "EMPLOYEE",
    cls: "VOLLZEIT",
    sched: "FIXED_SCHEDULE",
    weekly: 40,
    monthly: null,
    dayHours: F(8),
    hire: [2021, 8, 1],
    otBalance: -4.0,
    nfc: "NFC-DEMO-004",
  },
  {
    handle: "tobias",
    first: "Tobias",
    last: "Frei",
    num: "005",
    role: "EMPLOYEE",
    cls: "VOLLZEIT",
    sched: "FIXED_SCHEDULE",
    weekly: 40,
    monthly: null,
    dayHours: F(8),
    hire: [2022, 0, 10],
    otBalance: 6.25,
  },
  {
    // part-time 20h Mo–Wed
    handle: "sara",
    first: "Sara",
    last: "Lindner",
    num: "006",
    role: "EMPLOYEE",
    cls: "TEILZEIT",
    sched: "FIXED_SCHEDULE",
    weekly: 20,
    monthly: null,
    dayHours: [7, 7, 6, 0, 0, 0, 0],
    hire: [2022, 3, 1],
    otBalance: 0,
    coverageWeight: 0.5,
  },
  {
    // 4-day week Mo–Thu 10h
    handle: "david",
    first: "David",
    last: "Kern",
    num: "007",
    role: "EMPLOYEE",
    cls: "VOLLZEIT",
    sched: "FIXED_SCHEDULE",
    weekly: 40,
    monthly: null,
    dayHours: [10, 10, 10, 10, 0, 0, 0],
    hire: [2023, 1, 1],
    otBalance: -18.75,
  },
  {
    // Minijob, monthly hours
    handle: "mira",
    first: "Mira",
    last: "Sommer",
    num: "008",
    role: "EMPLOYEE",
    cls: "MINIJOB",
    sched: "MONTHLY_HOURS",
    weekly: null,
    monthly: 40,
    dayHours: [0, 0, 0, 0, 0, 0, 0],
    hire: [2023, 9, 1],
    otBalance: 0,
    coverageWeight: 0.5,
  },
  {
    // Azubi (< 18 → JArbSchG); vocational school
    handle: "felix",
    first: "Felix",
    last: "Braun",
    num: "009",
    role: "EMPLOYEE",
    cls: "AZUBI",
    sched: "FIXED_SCHEDULE",
    weekly: 40,
    monthly: null,
    dayHours: F(8),
    hire: [2024, 7, 1],
    otBalance: 0,
    birth: [2009, 4, 20],
    requiresSupervision: true,
    coverageWeight: 0.5,
  },
  {
    handle: "nina",
    first: "Nina",
    last: "Adler",
    num: "010",
    role: "EMPLOYEE",
    cls: "VOLLZEIT",
    sched: "FIXED_SCHEDULE",
    weekly: 40,
    monthly: null,
    dayHours: F(8),
    hire: [2024, 10, 1],
    otBalance: 3.5,
  },
];

// handle → { employee, user }
const emp: Record<string, { empId: string; userId: string; spec: EmpSpec }> = {};

async function main() {
  const existing = await prisma.tenant.findFirst({ where: { slug: TENANT_SLUG } });
  if (existing) {
    console.log("ℹ️  Demo-Tenant existiert bereits – seed-demo übersprungen.");
    return;
  }

  console.log("Starte RICH Demo-Seed…");
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  // ── Tenant ────────────────────────────────────────────────────────────────
  const tenant = await prisma.tenant.create({
    data: {
      name: "Clokr Demo GmbH",
      slug: TENANT_SLUG,
      federalState: "NIEDERSACHSEN",
    },
  });
  bump("tenant");

  // ── TenantConfig (incl. Phorest showcase fields) ───────────────────────────
  await prisma.tenantConfig.create({
    data: {
      tenantId: tenant.id,
      defaultWeeklyHours: 40,
      defaultMondayHours: 8,
      defaultTuesdayHours: 8,
      defaultWednesdayHours: 8,
      defaultThursdayHours: 8,
      defaultFridayHours: 8,
      defaultSaturdayHours: 0,
      defaultSundayHours: 0,
      overtimeThreshold: 60,
      allowOvertimePayout: true,
      defaultVacationDays: 30,
      emailNotificationsEnabled: true,
      // Phorest integration (demo placeholders — NO real credentials)
      phorestBusinessId: "demo-business-0001",
      phorestBranchId: "demo-branch-0001",
      phorestUsername: "demo-integration@demo.clokr.de",
      // phorestPassword intentionally left null/unset
      phorestAutoSync: true,
      phorestSyncWindowDays: 7,
      phorestPrepMinutes: 10,
      phorestWrapupMinutes: 5,
      phorestAppointmentHorizonDays: 90,
    },
  });
  bump("tenantConfig");

  // ── Employees + Users + WorkSchedule + OvertimeAccount ─────────────────────
  for (const s of EMPLOYEES) {
    const user = await prisma.user.create({
      data: {
        email: `${s.first.toLowerCase()}.${s.last.toLowerCase()}@${EMAIL_DOMAIN}`,
        passwordHash,
        role: s.role,
        isActive: true,
        lastLoginAt: addDays(todayUTC, -1),
      },
    });
    bump("user");

    const employee = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        employeeNumber: s.num,
        firstName: s.first,
        lastName: s.last,
        nfcCardId: s.nfc ?? null,
        classification: s.cls,
        coverageWeight: s.coverageWeight ?? 1.0,
        requiresSupervision: s.requiresSupervision ?? false,
        hireDate: noon(s.hire[0], s.hire[1], s.hire[2]),
        birthDate: s.birth ? d0(s.birth[0], s.birth[1], s.birth[2]) : null,
      },
    });
    bump("employee");

    const [mo, tu, we, th, fr, sa, su] = s.dayHours;
    const workDays = [1, 2, 3, 4, 5, 6, 0].filter((_, i) => s.dayHours[i] > 0);
    await prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: s.sched,
        weeklyHours: s.weekly,
        monthlyHours: s.monthly,
        mondayHours: mo,
        tuesdayHours: tu,
        wednesdayHours: we,
        thursdayHours: th,
        fridayHours: fr,
        saturdayHours: sa,
        sundayHours: su,
        // MONTHLY_HOURS has no daily targets → keep a sensible default work-week
        workDays: workDays.length > 0 ? workDays : [1, 2, 3, 4, 5],
        validFrom: noon(s.hire[0], s.hire[1], s.hire[2]),
      },
    });
    bump("workSchedule");

    const account = await prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: s.otBalance },
    });
    bump("overtimeAccount");

    // one ACCRUAL transaction per account referencing the previous month
    await prisma.overtimeTransaction.create({
      data: {
        overtimeAccountId: account.id,
        hours: Math.round(s.otBalance * 100) / 100,
        type: "ACCRUAL",
        description: "Monatsabschluss Übertrag",
        referenceMonth: `${PY}-${String(PM + 1).padStart(2, "0")}`,
      },
    });
    bump("overtimeTransaction");

    emp[s.handle] = { empId: employee.id, userId: user.id, spec: s };
  }

  const adminUserId = emp.admin.userId;

  // ── LeaveTypes ─────────────────────────────────────────────────────────────
  const jahresurlaub = await prisma.leaveType.create({
    data: {
      tenantId: tenant.id,
      name: "Jahresurlaub",
      isPaid: true,
      requiresApproval: true,
      color: "#3B82F6",
      allowHalfDay: true,
    },
  });
  const sonderurlaub = await prisma.leaveType.create({
    data: {
      tenantId: tenant.id,
      name: "Sonderurlaub",
      isPaid: true,
      requiresApproval: true,
      color: "#8B5CF6",
      allowHalfDay: true,
    },
  });
  const unbezahlt = await prisma.leaveType.create({
    data: {
      tenantId: tenant.id,
      name: "Unbezahlter Urlaub",
      isPaid: false,
      requiresApproval: true,
      color: "#6B7280",
      allowHalfDay: false,
    },
  });
  bump("leaveType", 3);

  // ── SpecialLeaveRules (Admin settings richness) ────────────────────────────
  await prisma.specialLeaveRule.createMany({
    data: [
      {
        tenantId: tenant.id,
        name: "Hochzeit",
        reason: "Eigene Eheschließung",
        defaultDays: 1,
        isStatutory: true,
        requiresProof: false,
        isActive: true,
      },
      {
        tenantId: tenant.id,
        name: "Umzug",
        reason: "Wohnungswechsel aus betrieblichem Anlass",
        defaultDays: 1,
        isStatutory: false,
        requiresProof: false,
        isActive: true,
      },
      {
        tenantId: tenant.id,
        name: "Geburt eines Kindes",
        reason: "Geburt des eigenen Kindes",
        defaultDays: 1,
        isStatutory: true,
        requiresProof: true,
        isActive: true,
      },
    ],
  });
  bump("specialLeaveRule", 3);

  // ── LeaveEntitlement (Jahresurlaub, current year) ──────────────────────────
  const entitlementCfg: Record<string, { total: number; carried: number; auto?: boolean }> = {
    admin: { total: 30, carried: 0 },
    lena: { total: 30, carried: 3 },
    jonas: { total: 30, carried: 5 },
    aylin: { total: 30, carried: 2 },
    tobias: { total: 30, carried: 0 },
    sara: { total: 18, carried: 1, auto: true },
    david: { total: 24, carried: 0, auto: true },
    mira: { total: 20, carried: 0, auto: true },
    felix: { total: 30, carried: 0 },
    nina: { total: 30, carried: 0 },
  };
  const usedByHandle: Record<string, number> = {};

  // ── LeaveRequests ──────────────────────────────────────────────────────────
  interface LR {
    handle: string;
    start: Date;
    end: Date;
    status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "CANCELLATION_REQUESTED";
    reviewer?: string; // handle
    note: string;
    typeId?: string;
    halfDay?: boolean;
  }
  const leaveReqs: LR[] = [
    {
      handle: "lena",
      start: d0(PY, PM, 10),
      end: d0(PY, PM, 14),
      status: "APPROVED",
      reviewer: "admin",
      note: "Sommerurlaub",
    },
    {
      handle: "jonas",
      start: d0(NY, NM, 7),
      end: d0(NY, NM, 11),
      status: "APPROVED",
      reviewer: "admin",
      note: "Familienurlaub",
    },
    {
      handle: "nina",
      start: d0(NY, NM, 12),
      end: d0(NY, NM, 15),
      status: "APPROVED",
      reviewer: "lena",
      note: "Kurzurlaub",
    },
    {
      handle: "aylin",
      start: addDays(todayUTC, 7),
      end: addDays(todayUTC, 9),
      status: "PENDING",
      note: "Urlaubsantrag",
    },
    {
      handle: "tobias",
      start: addDays(todayUTC, 14),
      end: addDays(todayUTC, 15),
      status: "PENDING",
      note: "Brückentage",
    },
    {
      handle: "david",
      start: addDays(todayUTC, 3),
      end: addDays(todayUTC, 4),
      status: "CANCELLATION_REQUESTED",
      reviewer: "admin",
      note: "Storno gewünscht — Projekt-Deadline",
    },
    {
      handle: "mira",
      start: addDays(todayUTC, 20),
      end: addDays(todayUTC, 20),
      status: "APPROVED",
      reviewer: "jonas",
      note: "Sonderurlaub",
      typeId: sonderurlaub.id,
    },
    {
      handle: "sara",
      start: d0(PY, PM, 25),
      end: d0(PY, PM, 25),
      status: "REJECTED",
      reviewer: "jonas",
      note: "Zu kurzfristig",
    },
  ];

  for (const lr of leaveReqs) {
    const days = lr.halfDay ? 0.5 : businessDays(lr.start, lr.end);
    const reviewerId = lr.reviewer ? emp[lr.reviewer].userId : null;
    const reviewed = lr.status !== "PENDING";
    await prisma.leaveRequest.create({
      data: {
        employeeId: emp[lr.handle].empId,
        leaveTypeId: lr.typeId ?? jahresurlaub.id,
        startDate: lr.start,
        endDate: lr.end,
        days,
        halfDay: lr.halfDay ?? false,
        status: lr.status,
        note: lr.note,
        reviewedBy: reviewed ? reviewerId : null,
        reviewedAt: reviewed ? addDays(todayUTC, -2) : null,
        reviewNote:
          lr.status === "REJECTED"
            ? "Abgelehnt"
            : lr.status === "APPROVED"
              ? "Genehmigt"
              : lr.status === "CANCELLATION_REQUESTED"
                ? "Ursprünglich genehmigt"
                : null,
        cancellationRequestedBy:
          lr.status === "CANCELLATION_REQUESTED" ? emp[lr.handle].userId : null,
      },
    });
    bump("leaveRequest");
    if (lr.status === "APPROVED" || lr.status === "CANCELLATION_REQUESTED") {
      // count against Jahresurlaub only
      if ((lr.typeId ?? jahresurlaub.id) === jahresurlaub.id) {
        usedByHandle[lr.handle] = (usedByHandle[lr.handle] ?? 0) + days;
      }
    }
  }

  for (const [handle, cfg] of Object.entries(entitlementCfg)) {
    await prisma.leaveEntitlement.create({
      data: {
        employeeId: emp[handle].empId,
        leaveTypeId: jahresurlaub.id,
        year: Y,
        totalDays: cfg.total,
        usedDays: usedByHandle[handle] ?? 0,
        carriedOverDays: cfg.carried,
        isAutoCalculated: cfg.auto ?? false,
      },
    });
    bump("leaveEntitlement");
  }

  // ── Absences ───────────────────────────────────────────────────────────────
  // NOTE: AbsenceType has no VACATION member — real vacation lives in LeaveRequest.
  // The "multi-day non-sick absence" requirement is fulfilled by Mira's SPECIAL_LEAVE below.
  const aylinSick = { from: d0(PY, PM, 20), to: d0(PY, PM, 22) };
  const tobiasSick = { from: d0(PY, PM, 6), to: d0(PY, PM, 6) };

  await prisma.absence.create({
    data: {
      employeeId: emp.aylin.empId,
      type: "SICK",
      source: "MANUAL",
      startDate: aylinSick.from,
      endDate: aylinSick.to,
      days: businessDays(aylinSick.from, aylinSick.to),
      halfDay: false,
      note: "Grippaler Infekt",
      createdBy: adminUserId,
    },
  });
  await prisma.absence.create({
    data: {
      employeeId: emp.tobias.empId,
      type: "SICK",
      source: "MANUAL",
      startDate: tobiasSick.from,
      endDate: tobiasSick.to,
      days: 1,
      halfDay: false,
      note: "Krank",
      createdBy: adminUserId,
    },
  });
  await prisma.absence.create({
    data: {
      employeeId: emp.sara.empId,
      type: "SICK_CHILD",
      source: "MANUAL",
      startDate: d0(Y, M, 2),
      endDate: d0(Y, M, 2),
      days: 0.5,
      halfDay: true,
      note: "Kind krank (halber Tag)",
      createdBy: adminUserId,
    },
  });
  await prisma.absence.create({
    data: {
      employeeId: emp.mira.empId,
      type: "SPECIAL_LEAVE",
      source: "MANUAL",
      startDate: d0(Y, M, 4),
      endDate: d0(Y, M, 5),
      days: businessDays(d0(Y, M, 4), d0(Y, M, 5)),
      halfDay: false,
      note: "Umzug (Sonderurlaub)",
      createdBy: adminUserId,
    },
  });
  bump("absence", 4);

  // Felix vocational-school (Berufsschule) — recurring pattern + concrete rows.
  // daysOfWeek encoding in the pattern model: 0=Mo..6=So → Thursday = 3.
  await prisma.employeeVocationalSchoolPattern.create({
    data: {
      employeeId: emp.felix.empId,
      daysOfWeek: [3],
      blockWeeks: [],
      validFrom: noon(2024, 7, 1),
      isActive: true,
      respectSchoolHolidays: true,
    },
  });
  bump("vocationalSchoolPattern");

  // concrete BS Absence rows on Thursdays in prev + current month (source PATTERN)
  const bsThursdays: Date[] = [];
  for (const [yy, mm, last] of [
    [PY, PM, prevLastDay],
    [Y, M, new Date(Y, M + 1, 0).getDate()],
  ] as const) {
    let count = 0;
    for (let day = 1; day <= last && count < 2; day++) {
      const dd = d0(yy, mm, day);
      if (dd.getUTCDay() === 4) {
        bsThursdays.push(dd);
        count++;
      }
    }
  }
  for (const dd of bsThursdays) {
    await prisma.absence.create({
      data: {
        employeeId: emp.felix.empId,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: dd,
        endDate: dd,
        days: 1,
        halfDay: false,
        note: "Berufsschule",
        createdBy: adminUserId,
      },
    });
    bump("absence");
  }

  // ── TimeEntries (+ Breaks) for 5 employees ─────────────────────────────────
  // skip sets: dates already covered by leave/sick for that employee
  const skip: Record<string, Set<string>> = {
    lena: new Set<string>(),
    jonas: new Set<string>(),
    aylin: new Set<string>(),
    tobias: new Set<string>(),
    david: new Set<string>(),
  };
  // Lena's approved prev-month vacation (10..14)
  for (let day = 10; day <= 14; day++) skip.lena.add(iso(d0(PY, PM, day)));
  // Aylin sick 20..22
  for (let day = 20; day <= 22; day++) skip.aylin.add(iso(d0(PY, PM, day)));
  // Tobias sick 6
  skip.tobias.add(iso(d0(PY, PM, 6)));

  interface EntryShape {
    startH: number;
    startM: number;
    endH: number;
    endM: number;
    breakMin: number;
    breakStartH: number;
    breakEndH: number;
    breakEndM: number;
  }
  function shapeFor(handle: string, day: Date): EntryShape {
    // deterministic variation so saldi differ across days/employees
    const v = day.getUTCDate() % 4; // 0..3
    if (handle === "david") {
      // 10h day, 45min break
      return {
        startH: 7,
        startM: 30,
        endH: 18,
        endM: 15 + (v - 1) * 10,
        breakMin: 45,
        breakStartH: 12,
        breakEndH: 12,
        breakEndM: 45,
      };
    }
    // standard 8h day, 30min break, small variation
    return {
      startH: 8,
      startM: 0,
      endH: 16,
      endM: 30 + (v - 1) * 15,
      breakMin: 30,
      breakStartH: 12,
      breakEndH: 12,
      breakEndM: 30,
    };
  }

  async function genEntries(
    handle: string,
    from: Date,
    to: Date,
    workDayJs: Set<number>,
    locked: boolean,
  ) {
    for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
      const day = new Date(t);
      if (!workDayJs.has(day.getUTCDay())) continue;
      if (skip[handle]?.has(iso(day))) continue;
      const sh = shapeFor(handle, day);
      await prisma.timeEntry.create({
        data: {
          employeeId: emp[handle].empId,
          date: day,
          startTime: clock(day, sh.startH, sh.startM),
          endTime: clock(day, sh.endH, sh.endM),
          breakMinutes: sh.breakMin,
          type: "WORK",
          source: "MANUAL",
          isLocked: locked,
          lockedAt: locked ? addDays(todayUTC, -1) : null,
          createdBy: emp[handle].userId,
          breaks: {
            create: [
              {
                startTime: clock(day, sh.breakStartH, 0),
                endTime: clock(day, sh.breakEndH, sh.breakEndM),
              },
            ],
          },
        },
      });
      bump("timeEntry");
      bump("break");
    }
  }

  const workWeek = new Set([1, 2, 3, 4, 5]); // Mo–Fri
  const davidDays = new Set([1, 2, 3, 4]); // Mo–Thu

  const entryEmps: Array<[string, Set<number>]> = [
    ["lena", workWeek],
    ["jonas", workWeek],
    ["aylin", workWeek],
    ["tobias", workWeek],
    ["david", davidDays],
  ];

  const prevFrom = d0(PY, PM, 1);
  const prevTo = d0(PY, PM, prevLastDay);
  const curFrom = d0(Y, M, 1);
  const curTo = D > 1 ? d0(Y, M, D - 1) : null; // up to yesterday

  for (const [handle, wd] of entryEmps) {
    await genEntries(handle, prevFrom, prevTo, wd, true); // prev month = closed → locked
    if (curTo) await genEntries(handle, curFrom, curTo, wd, false);
  }

  // Lena "currently clocked in" today (open entry) — only if today is a workday
  if (workWeek.has(todayUTC.getUTCDay()) && !skip.lena.has(iso(todayUTC))) {
    await prisma.timeEntry.create({
      data: {
        employeeId: emp.lena.empId,
        date: todayUTC,
        startTime: clock(todayUTC, 8, 5),
        endTime: null,
        breakMinutes: 0,
        type: "WORK",
        source: "NFC",
        createdBy: emp.lena.userId,
      },
    });
    bump("timeEntry");
  }

  // ── SaldoSnapshot (closed previous month) ──────────────────────────────────
  const snapDelta: Record<string, number> = {
    lena: 45,
    jonas: 120,
    aylin: -30,
    tobias: 15,
    david: -90,
  };
  for (const [handle, wd] of entryEmps) {
    // count worked days actually generated (minus skips)
    let workdaysExpected = 0;
    for (let t = prevFrom.getTime(); t <= prevTo.getTime(); t += DAY_MS) {
      if (wd.has(new Date(t).getUTCDay())) workdaysExpected++;
    }
    const dailyMin = handle === "david" ? 600 : 480;
    const expected = workdaysExpected * dailyMin;
    const balance = snapDelta[handle] ?? 0;
    const worked = expected + balance;
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: emp[handle].empId,
        periodType: "MONTHLY",
        periodStart: prevFrom,
        periodEnd: prevTo,
        workedMinutes: worked,
        expectedMinutes: expected,
        balanceMinutes: balance,
        carryOver: balance,
        closedAt: addDays(todayUTC, -1),
        closedBy: adminUserId,
        note: "Monatsabschluss (Demo)",
        superseded: false,
      },
    });
    bump("saldoSnapshot");
  }

  // ── ShiftTemplates + Shifts (current week) ─────────────────────────────────
  const tFruh = await prisma.shiftTemplate.create({
    data: {
      tenantId: tenant.id,
      name: "Frühschicht",
      startTime: "06:00",
      endTime: "14:00",
      color: "#F59E0B",
    },
  });
  const tSpat = await prisma.shiftTemplate.create({
    data: {
      tenantId: tenant.id,
      name: "Spätschicht",
      startTime: "14:00",
      endTime: "22:00",
      color: "#3B82F6",
    },
  });
  const tTag = await prisma.shiftTemplate.create({
    data: {
      tenantId: tenant.id,
      name: "Tagschicht",
      startTime: "09:00",
      endTime: "17:00",
      color: "#10B981",
    },
  });
  bump("shiftTemplate", 3);

  const shiftPlan: Array<{
    handle: string;
    tpl: { id: string; name: string; startTime: string; endTime: string };
  }> = [
    { handle: "lena", tpl: tTag },
    { handle: "jonas", tpl: tTag },
    { handle: "aylin", tpl: tFruh },
    { handle: "tobias", tpl: tSpat },
    { handle: "nina", tpl: tTag },
  ];
  for (let dowIdx = 0; dowIdx < 5; dowIdx++) {
    const shiftDay = addDays(monday, dowIdx);
    for (const p of shiftPlan) {
      await prisma.shift.create({
        data: {
          employeeId: emp[p.handle].empId,
          templateId: p.tpl.id,
          date: shiftDay,
          startTime: p.tpl.startTime,
          endTime: p.tpl.endTime,
          label: p.tpl.name,
          origin: "MANUAL",
          createdBy: adminUserId,
        },
      });
      bump("shift");
    }
  }

  // A couple of PHOREST-origin shifts (imported) on Saturday of the current week
  const saturday = addDays(monday, 5);
  const phorestShifts = [
    { handle: "aylin", start: "10:00", end: "16:00", key: "phorest-demo-shift-0001" },
    { handle: "tobias", start: "12:00", end: "18:00", key: "phorest-demo-shift-0002" },
  ];
  for (const ps of phorestShifts) {
    await prisma.shift.create({
      data: {
        employeeId: emp[ps.handle].empId,
        date: saturday,
        startTime: ps.start,
        endTime: ps.end,
        label: "Phorest Termin",
        origin: "PHOREST",
        externalId: ps.key,
        createdBy: null,
      },
    });
    bump("shift");
  }

  // ── PhorestStaffMapping ────────────────────────────────────────────────────
  const mappings = [
    { handle: "lena", staffId: "phorest-staff-1001" },
    { handle: "jonas", staffId: "phorest-staff-1002" },
    { handle: "aylin", staffId: "phorest-staff-1003" },
    { handle: "tobias", staffId: "phorest-staff-1004" },
  ];
  for (const m of mappings) {
    await prisma.phorestStaffMapping.create({
      data: {
        tenantId: tenant.id,
        phorestStaffId: m.staffId,
        employeeId: emp[m.handle].empId,
      },
    });
    bump("phorestStaffMapping");
  }

  // ── PhorestSyncRun (history) ───────────────────────────────────────────────
  await prisma.phorestSyncRun.create({
    data: {
      tenantId: tenant.id,
      startedAt: new Date(addDays(todayUTC, -1).getTime() + 3 * 3_600_000),
      finishedAt: new Date(addDays(todayUTC, -1).getTime() + 3 * 3_600_000 + 42_000),
      status: "SUCCESS",
      created: 8,
      updated: 3,
      cancelled: 1,
      unmapped: 0,
      skippedVocationalSchool: 1,
      replaced: 2,
      appointmentsStored: 14,
      appointmentsRemoved: 2,
    },
  });
  await prisma.phorestSyncRun.create({
    data: {
      tenantId: tenant.id,
      startedAt: new Date(todayUTC.getTime() + 3 * 3_600_000),
      finishedAt: new Date(todayUTC.getTime() + 3 * 3_600_000 + 37_000),
      status: "SUCCESS",
      created: 5,
      updated: 6,
      cancelled: 0,
      unmapped: 1,
      skippedVocationalSchool: 0,
      replaced: 0,
      appointmentsStored: 11,
      appointmentsRemoved: 0,
    },
  });
  bump("phorestSyncRun", 2);

  // ── PhorestAppointment (busy-window cache, DSGVO-minimal) ──────────────────
  const apptDays = [monday, addDays(monday, 1), addDays(monday, 2)];
  const apptSpecs = [
    { handle: "lena", start: "10:00", end: "11:30" },
    { handle: "aylin", start: "13:00", end: "14:00" },
    { handle: "tobias", start: "15:30", end: "16:30" },
  ];
  let apptKey = 1;
  for (const ad of apptDays) {
    for (const a of apptSpecs) {
      await prisma.phorestAppointment.create({
        data: {
          employeeId: emp[a.handle].empId,
          date: ad,
          startTime: a.start,
          endTime: a.end,
          externalId: `phorest-demo-appt-${String(apptKey++).padStart(4, "0")}`,
        },
      });
      bump("phorestAppointment");
    }
  }

  // ── PublicHolidays (current year, Niedersachsen) ───────────────────────────
  const holidays: Array<[number, number, string]> = [
    [0, 1, "Neujahr"],
    [3, 18, "Karfreitag"], // approximate; demo only
    [4, 1, "Tag der Arbeit"],
    [9, 3, "Tag der Deutschen Einheit"],
    [9, 31, "Reformationstag"],
    [11, 25, "1. Weihnachtstag"],
    [11, 26, "2. Weihnachtstag"],
  ];
  for (const [mm, dd, name] of holidays) {
    await prisma.publicHoliday.create({
      data: {
        tenantId: tenant.id,
        date: d0(Y, mm, dd),
        name,
        federalState: "NIEDERSACHSEN",
        year: Y,
      },
    });
    bump("publicHoliday");
  }

  // ── Notifications (unread → badges) ────────────────────────────────────────
  const notifications = [
    {
      userId: adminUserId,
      type: "LEAVE_REQUEST",
      title: "Neuer Urlaubsantrag",
      message: "Aylin Kaya hat einen Urlaubsantrag gestellt.",
      link: "/admin/vacation",
      relatedType: "LeaveRequest",
    },
    {
      userId: emp.lena.userId,
      type: "LEAVE_REQUEST",
      title: "Neuer Urlaubsantrag",
      message: "Tobias Frei hat Brückentage beantragt.",
      link: "/admin/vacation",
      relatedType: "LeaveRequest",
    },
    {
      userId: emp.jonas.userId,
      type: "MONTH_CLOSED",
      title: "Monatsabschluss fällig",
      message: "Der Vormonat kann jetzt abgeschlossen werden.",
      link: "/admin/month-close",
      relatedType: null,
    },
    {
      userId: adminUserId,
      type: "OVERTIME_WARNING",
      title: "Überstunden-Warnung",
      message: "David Kern liegt deutlich im Minus (-18,75 h).",
      link: "/admin/overtime",
      relatedType: "Employee",
    },
    {
      userId: adminUserId,
      type: "LEAVE_REQUEST",
      title: "Stornierung angefragt",
      message: "David Kern möchte einen genehmigten Urlaub stornieren.",
      link: "/admin/vacation",
      relatedType: "LeaveRequest",
    },
  ];
  for (const n of notifications) {
    await prisma.notification.create({
      data: {
        userId: n.userId,
        type: n.type,
        title: n.title,
        message: n.message,
        link: n.link,
        read: false,
        relatedType: n.relatedType,
      },
    });
    bump("notification");
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n✅ Demo-Seed abgeschlossen. Erzeugte Datensätze:");
  for (const k of Object.keys(stats).sort()) {
    console.log(`   ${k.padEnd(24)} ${stats[k]}`);
  }
  console.log("\n🔑 Demo-Login (alle Nutzer, Passwort identisch):");
  console.log(`   Admin:    admin.demo@${EMAIL_DOMAIN}`);
  console.log(`   Manager:  lena.vogel@${EMAIL_DOMAIN} · jonas.berg@${EMAIL_DOMAIN}`);
  console.log(`   Passwort: ${DEMO_PASSWORD}`);
  console.log(`   Tenant:   Clokr Demo GmbH (slug: ${TENANT_SLUG})`);
}

main()
  .catch((e) => {
    console.error("❌ Demo-Seed fehlgeschlagen:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
