/**
 * seed-demo.ts — RICH pseudonymized demo-data seed for the Clokr DEV stack.
 *
 * Purpose: populate a SINGLE demo tenant with enough realistic (but fully
 * pseudonymized / invented) data that every major screen looks populated AND plausible for
 * showcase SCREENSHOTS (Issue #577): every person's saldo stays within a few hours of zero, the
 * shift plan is filled, the tenant has two active salons with a Springerin, and the break check,
 * the leave inbox and the salon choice each have something to show.
 *
 * Run against an EMPTY database (drop+recreate schema, `prisma migrate deploy`,
 * then run this). It guards against a pre-existing demo tenant and bails early.
 *
 * PII SAFETY: every name here is invented. Do NOT put real people in this file.
 *
 * What makes the figures plausible (Issue #577):
 * - Tracking starts with the previous month for EVERY person: one zero pre-tracking snapshot per
 *   person for the month before it (see the snapshot block). Without it the saldo chain runs from
 *   hire dates years back with no recorded time — that produced the −1.398 h … −14.000 h saldi.
 * - Every person has recorded time for the previous month and the current month up to yesterday
 *   that follows their contract: fixed day hours, the Minijob's monthly budget, the Azubi's
 *   § 11 JArbSchG breaks and Berufsschule days, and for the two SHIFT_BASED persons the seeded
 *   roster. Statutory holidays (Niedersachsen) and approved leave / sick days are left free.
 * - The OvertimeAccount rows start at 0; the stored balance is the API's business, not the seed's.
 *
 * TIMEZONE NOTE: TimeEntry/Break timestamps are built as Berlin wall-clock times with the
 * offset of THAT day (CET/CEST, see berlinOffsetMinutes()). Shift times are plain "HH:mm"
 * strings and are TZ-agnostic.
 */

import { PrismaClient, type Prisma } from "../generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import bcrypt from "bcryptjs";
import { DEFAULT_SALON_OPENING_HOURS, createDefaultHomeAssignment } from "./default-salon";
import { ADMIN_EMAIL } from "./seed-credentials";
import { ensureSystemRoleAssignment } from "./seed-role-assignments";
import { demoMonthRangeUtc } from "./demo-month-bounds";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

const DEMO_PASSWORD = "demo1234";
const TENANT_SLUG = "demo-clokr";
const EMAIL_DOMAIN = "demo.clokr.de";
const DEMO_TZ = "Europe/Berlin"; // the TenantConfig default this seed relies on (schema.prisma)

// ── Enum unions (mirror schema.prisma exactly) ───────────────────────────────
type RoleT = "ADMIN" | "MANAGER" | "EMPLOYEE";
type SchedT = "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED";
type ClsT =
  "VOLLZEIT" | "TEILZEIT" | "MINIJOB" | "AZUBI" | "AUSHILFE" | "WERKSTUDENT" | "PRAKTIKANT";
type SalonKey = "MITTE" | "NORD";

// ── Date helpers (calendar math done at UTC midnight — DST-safe) ─────────────
const DAY_MS = 86_400_000;

const now = new Date();
const Y = now.getFullYear();
const M = now.getMonth(); // 0-based current month
const D = now.getDate();

// previous month
const prevRef = new Date(Y, M - 1, 1);
const PY = prevRef.getFullYear();
const PM = prevRef.getMonth();
const prevLastDay = new Date(Y, M, 0).getDate();
const curLastDay = new Date(Y, M + 1, 0).getDate();

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

const offsetFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: DEMO_TZ,
  timeZoneName: "shortOffset",
});
/** The Berlin UTC offset (minutes) in force at local noon of the given calendar day. */
function berlinOffsetMinutes(day: Date): number {
  const label =
    offsetFormat
      .formatToParts(new Date(day.getTime() + 12 * 3_600_000))
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  const match = /GMT([+-]\d+)(?::(\d+))?/.exec(label);
  if (!match) return 60;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  return hours * 60 + Math.sign(hours) * minutes;
}
/** UTC instant for the Berlin wall-clock time `minutesOfDay` on the given calendar day. */
function clockAt(day: Date, minutesOfDay: number): Date {
  return new Date(day.getTime() + (minutesOfDay - berlinOffsetMinutes(day)) * 60_000);
}
/** UTC instant for Berlin HH:MM on the given UTC-midnight calendar day. */
function clock(day: Date, hh: number, mm: number): Date {
  return clockAt(day, hh * 60 + mm);
}
/** noon UTC — safe for hireDate/validFrom/birthDate style Timestamptz/Date fields. */
function noon(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m, day, 12));
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** 0 = Monday … 6 = Sunday (the salon-assignment `weekdays` convention). */
const mondayIdx = (d: Date) => (d.getUTCDay() + 6) % 7;
const hm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const toMin = (text: string) => {
  const [h, m] = text.split(":").map(Number);
  return h * 60 + m;
};

// ── Statutory holidays (Niedersachsen) ───────────────────────────────────────
// The API computes statutory holidays itself (they are never stored); the seed only needs to
// know them to leave those days free of recorded time and shifts, as a real salon would.
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return d0(year, month - 1, day);
}
const holidayCache = new Map<number, Set<string>>();
function isHoliday(day: Date): boolean {
  const year = day.getUTCFullYear();
  let set = holidayCache.get(year);
  if (!set) {
    const easter = easterSunday(year);
    set = new Set(
      [
        d0(year, 0, 1),
        addDays(easter, -2), // Karfreitag
        addDays(easter, 1), // Ostermontag
        d0(year, 4, 1),
        addDays(easter, 39), // Christi Himmelfahrt
        addDays(easter, 50), // Pfingstmontag
        d0(year, 9, 3),
        d0(year, 9, 31), // Reformationstag (Niedersachsen)
        d0(year, 11, 25),
        d0(year, 11, 26),
      ].map(iso),
    );
    holidayCache.set(year, set);
  }
  return set.has(iso(day));
}

// current-week Monday (UTC calendar)
const todayUTC = d0(Y, M, D);
const monday = addDays(todayUTC, -mondayIdx(todayUTC));

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
  home: SalonKey;
  /** A Springerin's second salon on fixed weekdays (0 = Monday … 6 = Sunday). */
  deployment?: { salon: SalonKey; weekdays: number[] };
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
    home: "MITTE",
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
    home: "MITTE",
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
    home: "NORD",
    nfc: "NFC-DEMO-003",
  },
  {
    // SHIFT_BASED: the weekdays come from the roster; {day}Hours are placeholders (CLAUDE.md)
    handle: "aylin",
    first: "Aylin",
    last: "Kaya",
    num: "004",
    role: "EMPLOYEE",
    cls: "VOLLZEIT",
    sched: "SHIFT_BASED",
    weekly: 40,
    monthly: null,
    dayHours: F(8),
    hire: [2021, 8, 1],
    home: "MITTE",
    nfc: "NFC-DEMO-004",
  },
  {
    handle: "tobias",
    first: "Tobias",
    last: "Frei",
    num: "005",
    role: "EMPLOYEE",
    cls: "VOLLZEIT",
    sched: "SHIFT_BASED",
    weekly: 40,
    monthly: null,
    dayHours: F(8),
    hire: [2022, 0, 10],
    home: "MITTE",
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
    home: "NORD",
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
    home: "NORD",
  },
  {
    // Minijob, monthly hours (works Tue + Thu mornings)
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
    home: "MITTE",
    coverageWeight: 0.5,
  },
  {
    // Azubi (< 18 → § 11 JArbSchG breaks); Berufsschule every Thursday
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
    home: "MITTE",
    birth: [2009, 4, 20],
    requiresSupervision: true,
    coverageWeight: 0.5,
  },
  {
    // Springerin: Stammsalon Nord, Thursdays and Fridays in the other salon
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
    home: "NORD",
    deployment: { salon: "MITTE", weekdays: [3, 4] },
  },
];

const SPEC: Record<string, EmpSpec> = Object.fromEntries(EMPLOYEES.map((s) => [s.handle, s]));
const HANDLE_INDEX: Record<string, number> = Object.fromEntries(
  EMPLOYEES.map((s, i) => [s.handle, i]),
);

/** Days a person's contract (not the roster) makes a working day: Mon–Fri for SHIFT_BASED and
 *  the Minijob (their `workDays`), else the days with day hours. */
function isContractDay(handle: string, day: Date): boolean {
  if (isHoliday(day)) return false;
  const s = SPEC[handle];
  if (s.sched === "SHIFT_BASED" || s.sched === "MONTHLY_HOURS") return mondayIdx(day) < 5;
  return s.dayHours[mondayIdx(day)] > 0;
}

/** The n-th contract day of a person before today (n = 1 is the most recent). */
function pastContractDay(handle: string, n: number): Date {
  let found = 0;
  for (let day = addDays(todayUTC, -1); ; day = addDays(day, -1)) {
    if (isContractDay(handle, day) && ++found === n) return day;
  }
}

/** The most recent past contract day of a person that falls on the given weekday (0 = Monday). */
function pastContractWeekday(handle: string, weekday: number): Date {
  for (let day = addDays(todayUTC, -1); ; day = addDays(day, -1)) {
    if (mondayIdx(day) === weekday && isContractDay(handle, day)) return day;
  }
}

/** Number of a person's contract days in [from, to] — the priced day count of a leave request. */
function contractDaysBetween(handle: string, from: Date, to: Date): number {
  let n = 0;
  for (let day = from; day <= to; day = addDays(day, 1)) if (isContractDay(handle, day)) n++;
  return n;
}

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
      // Phase 566 (D-10): the demo shows every module and several salons, so it books all four
      // modules with a salon quota of 5. Spelled out because packages/db cannot import the API
      // constants; tenant-provisioning-88.test.ts pins these values.
      bookedModules: ["CHAIN", "INTEGRATIONS", "HARDWARE_CLOCK", "ANALYTICS"],
      salonQuota: 5,
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
      phorestUsername: "demo-integration@demo.clokr.de",
      // phorestPassword intentionally left null/unset
      phorestAutoSync: true,
      phorestSyncWindowDays: 7,
      phorestPrepMinutes: 10,
      phorestWrapupMinutes: 5,
      phorestAppointmentHorizonDays: 90,
      // Issue #563: no opening hours on TenantConfig — the hours live only on the salons created below.
    },
  });
  bump("tenantConfig");

  // ── Salons (D-18, Phase 64b, issue #64; second salon Issue #577) ───────────
  // Every tenant this seed bootstraps gets its default salon, in the same step, name = tenant
  // name, hours = DEFAULT_SALON_OPENING_HOURS (Issue #563: opening hours live only on the salon).
  // Issue #577 adds a second active salon so the salon choice, the header salon selection and a
  // Springerin are demonstrable. No audit-log write here (research Pitfall 5) — a seed script
  // has no request principal. This seed only ever runs against a fresh tenant (the early-return
  // guard above bails when TENANT_SLUG already exists), so no idempotency check is needed.
  const salon = await prisma.salon.create({
    data: {
      tenantId: tenant.id,
      name: tenant.name,
      federalState: tenant.federalState, // Phase 71b (issue #71)
      openingHours: DEFAULT_SALON_OPENING_HOURS as unknown as Prisma.InputJsonValue,
      isActive: true,
    },
  });
  const salonNord = await prisma.salon.create({
    data: {
      tenantId: tenant.id,
      name: "Clokr Demo Nord",
      federalState: tenant.federalState,
      openingHours: DEFAULT_SALON_OPENING_HOURS as unknown as Prisma.InputJsonValue,
      isActive: true,
    },
  });
  bump("salon", 2);
  const salonIdOf: Record<SalonKey, string> = { MITTE: salon.id, NORD: salonNord.id };

  /** The salon a person works in on a day: the Springerin's deployment weekdays, else HOME. */
  const salonOfDay = (handle: string, day: Date): string => {
    const s = SPEC[handle];
    if (s.deployment?.weekdays.includes(mondayIdx(day))) return salonIdOf[s.deployment.salon];
    return salonIdOf[s.home];
  };

  // Phase 65b (issue #65): the demo tenant's Phorest branch lives on its demo salon's coupling.
  await prisma.salonCoupling.create({
    data: {
      tenantId: tenant.id,
      salonId: salon.id,
      provider: "PHOREST",
      externalBranchId: "demo-branch-0001",
    },
  });
  bump("salonCoupling");

  // ── Employees + Users + WorkSchedule + OvertimeAccount ─────────────────────
  for (const s of EMPLOYEES) {
    // Issue #343: the admin's address comes from the shared ADMIN_EMAIL constant (not the
    // per-employee EMAIL_DOMAIN pattern) so reset-demo.ts can find the admin after this seed.
    const user = await prisma.user.create({
      data: {
        email:
          s.handle === "admin"
            ? ADMIN_EMAIL
            : `${s.first.toLowerCase()}.${s.last.toLowerCase()}@${EMAIL_DOMAIN}`,
        passwordHash,
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

    // Issue #539 (D-09): permissions come only from stored role assignments, so every demo
    // user holds its seeded role's system role as one - the role lives only in the stored assignment.
    await ensureSystemRoleAssignment(prisma, {
      tenantId: tenant.id,
      userId: user.id,
      role: s.role,
    });

    // D-24 (Phase 67b Plan 04, issue #67): every demo employee gets its Stammsalon (HOME) row
    // from its tenant-local hire day — the default salon through the shared helper, the second
    // salon directly (Issue #577). The Springerin additionally gets a DEPLOYMENT row for her
    // weekdays in the other salon. No audit-log write here (research Pitfall 5).
    if (s.home === "MITTE") {
      await createDefaultHomeAssignment(prisma, employee.id);
    } else {
      await prisma.employeeSalonAssignment.create({
        data: {
          tenantId: tenant.id,
          employeeId: employee.id,
          salonId: salonIdOf[s.home],
          kind: "HOME",
          validFrom: d0(s.hire[0], s.hire[1], s.hire[2]),
        },
      });
    }
    bump("employeeSalonAssignment");
    if (s.deployment) {
      await prisma.employeeSalonAssignment.create({
        data: {
          tenantId: tenant.id,
          employeeId: employee.id,
          salonId: salonIdOf[s.deployment.salon],
          kind: "DEPLOYMENT",
          validFrom: d0(s.hire[0], s.hire[1], s.hire[2]),
          weekdays: s.deployment.weekdays,
        },
      });
      bump("employeeSalonAssignment");
    }

    const [mo, tu, we, th, fr, sa, su] = s.dayHours;
    const workDays = [1, 2, 3, 4, 5, 6, 0].filter((_, i) => s.dayHours[i] > 0);
    const shiftBased = s.sched === "SHIFT_BASED";
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
        // SHIFT_BASED (Phase 107 D-01, Issue #481): the contractual weekly day count and the
        // required "übliche Arbeitstage" Angabe (0 = Sunday … 6 = Saturday, like workDays).
        contractWorkDaysPerWeek: shiftBased ? 5 : null,
        usualWorkDays: shiftBased ? [1, 2, 3, 4, 5] : [],
        validFrom: noon(s.hire[0], s.hire[1], s.hire[2]),
      },
    });
    bump("workSchedule");

    await prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: 0 },
    });
    bump("overtimeAccount");

    emp[s.handle] = { empId: employee.id, userId: user.id, spec: s };
  }

  const adminUserId = emp.admin.userId;

  // ── LeaveTypes ─────────────────────────────────────────────────────────────
  // Phase 97 (D-19/D-22): code is the identity now; name is display text. The vacation row's
  // legacy seed spelling is replaced by the canonical name — the acceptance criteria grep this
  // file for that legacy spelling and expect zero hits. Values mirror LEAVE_TYPE_DEFS in
  // apps/api/src/utils/leave-type.ts. Variable names stay so the rest of this file is unchanged.
  const jahresurlaub = await prisma.leaveType.create({
    data: {
      tenantId: tenant.id,
      code: "VACATION",
      name: "Urlaub",
      isPaid: true,
      requiresApproval: true,
      color: "#3B82F6",
      allowHalfDay: true,
    },
  });
  const sonderurlaub = await prisma.leaveType.create({
    data: {
      tenantId: tenant.id,
      code: "SPECIAL",
      name: "Sonderurlaub",
      isPaid: true,
      requiresApproval: true,
      color: "#8B5CF6",
      allowHalfDay: true,
    },
  });
  await prisma.leaveType.create({
    data: {
      tenantId: tenant.id,
      code: "UNPAID",
      name: "Unbezahlter Urlaub",
      isPaid: false,
      requiresApproval: true,
      color: "#6B7280",
      allowHalfDay: false,
    },
  });
  const krankmeldung = await prisma.leaveType.create({
    data: {
      tenantId: tenant.id,
      code: "SICK",
      name: "Krankmeldung",
      isPaid: true,
      requiresApproval: false,
      color: "#EF4444",
      allowHalfDay: true,
    },
  });
  const kinderkrank = await prisma.leaveType.create({
    data: {
      tenantId: tenant.id,
      code: "SICK_CHILD",
      name: "Kinderkrank",
      isPaid: true,
      requiresApproval: false,
      color: "#F97316",
      allowHalfDay: true,
    },
  });
  bump("leaveType", 5);

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
  // ADR 0001: requested absences (vacation, special leave, SICK, SICK_CHILD) are LeaveRequest
  // rows; only VOCATIONAL_SCHOOL is an imposed Absence (below). Every date is relative to the
  // machine clock, so the past ones are placed on the person's own past contract days.
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
      note: "Herbsturlaub",
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
      reviewer: "jonas",
      note: "Kurzurlaub",
    },
    // Three open requests (Issue #577): two in the default salon, one in Nord.
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
      handle: "sara",
      start: addDays(todayUTC, 21),
      end: addDays(todayUTC, 22),
      status: "PENDING",
      note: "Familienbesuch",
    },
    {
      handle: "david",
      start: addDays(todayUTC, 3),
      end: addDays(todayUTC, 4),
      status: "CANCELLATION_REQUESTED",
      reviewer: "admin",
      note: "Storno gewünscht — Termin verschoben",
    },
    {
      handle: "mira",
      start: addDays(todayUTC, 20),
      end: addDays(todayUTC, 20),
      status: "APPROVED",
      reviewer: "lena",
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
    {
      handle: "aylin",
      start: d0(PY, PM, 20),
      end: d0(PY, PM, 22),
      status: "APPROVED",
      reviewer: "admin",
      note: "Grippaler Infekt",
      typeId: krankmeldung.id,
    },
    {
      handle: "tobias",
      start: d0(PY, PM, 6),
      end: d0(PY, PM, 6),
      status: "APPROVED",
      reviewer: "admin",
      note: "Krank",
      typeId: krankmeldung.id,
    },
    {
      handle: "sara",
      start: pastContractDay("sara", 2),
      end: pastContractDay("sara", 2),
      status: "APPROVED",
      reviewer: "admin",
      note: "Kind krank (halber Tag)",
      typeId: kinderkrank.id,
      halfDay: true,
    },
    {
      handle: "mira",
      start: pastContractDay("mira", 7),
      end: pastContractDay("mira", 6),
      status: "APPROVED",
      reviewer: "admin",
      note: "Umzug (Sonderurlaub)",
      typeId: sonderurlaub.id,
    },
  ];

  // Approved the day after the period ends — but never in the future. "Genehmigt am" is an
  // audit-trail-shaped field in an audit-proof product and it is on screen.
  const reviewedAtFor = (end: Date): Date => {
    const nextDay = addDays(end, 1);
    return nextDay > todayUTC ? todayUTC : nextDay;
  };

  /** handle → iso day → share of the day covered by effective leave (1 or 0.5). */
  const leaveShare: Record<string, Map<string, number>> = {};
  for (const lr of leaveReqs) {
    const days = lr.halfDay ? 0.5 : contractDaysBetween(lr.handle, lr.start, lr.end);
    const reviewerId = lr.reviewer ? emp[lr.reviewer].userId : null;
    const reviewed = lr.status !== "PENDING";
    const typeId = lr.typeId ?? jahresurlaub.id;
    await prisma.leaveRequest.create({
      data: {
        employeeId: emp[lr.handle].empId,
        leaveTypeId: typeId,
        startDate: lr.start,
        endDate: lr.end,
        days,
        halfDay: lr.halfDay ?? false,
        status: lr.status,
        note: lr.note,
        reviewedBy: reviewed ? reviewerId : null,
        reviewedAt: reviewed
          ? lr.end < todayUTC
            ? reviewedAtFor(lr.end)
            : addDays(todayUTC, -2)
          : null,
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
      const share = (leaveShare[lr.handle] ??= new Map());
      for (let day = lr.start; day <= lr.end; day = addDays(day, 1)) {
        share.set(iso(day), lr.halfDay ? 0.5 : 1);
      }
      if (typeId === jahresurlaub.id) {
        usedByHandle[lr.handle] = (usedByHandle[lr.handle] ?? 0) + days;
      }
    }
  }
  const leaveShareOn = (handle: string, day: Date) => leaveShare[handle]?.get(iso(day)) ?? 0;

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

  // ── Absences (imposed only — Berufsschule) ──────────────────────────────────
  // VOCATIONAL_SCHOOL is imposed (BBiG § 15/§ 17), not requested, so it stays on the Absence side
  // per ADR 0001. Felix: recurring pattern + concrete rows on every Thursday of the previous and
  // the current month (no recorded time on those days — the § 15 credit covers them).
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

  const schoolDays = new Set<string>();
  for (let day = d0(PY, PM, 1); day <= d0(Y, M, curLastDay); day = addDays(day, 1)) {
    if (mondayIdx(day) !== 3 || isHoliday(day)) continue;
    schoolDays.add(iso(day));
    await prisma.absence.create({
      data: {
        employeeId: emp.felix.empId,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: day,
        endDate: day,
        days: 1,
        halfDay: false,
        note: "Berufsschule",
        createdBy: adminUserId,
      },
    });
    bump("absence");
  }

  // ── Day plans: one source for recorded time AND the shift plan ─────────────
  // A plan is the start and the net working minutes of a person's normal day; the break follows
  // the person's regime (§ 4 ArbZG; § 11 JArbSchG for the Azubi under 18).
  const tFruh = await prisma.shiftTemplate.create({
    data: {
      tenantId: tenant.id,
      name: "Frühschicht",
      startTime: "08:00",
      endTime: "16:30",
      color: "#F59E0B",
    },
  });
  const tSpat = await prisma.shiftTemplate.create({
    data: {
      tenantId: tenant.id,
      name: "Spätschicht",
      startTime: "11:30",
      endTime: "20:00",
      color: "#3B82F6",
    },
  });
  const tTag = await prisma.shiftTemplate.create({
    data: {
      tenantId: tenant.id,
      name: "Tagschicht",
      startTime: "09:00",
      endTime: "17:30",
      color: "#10B981",
    },
  });
  bump("shiftTemplate", 3);
  type Tpl = typeof tFruh;

  /** SHIFT_BASED roster: alternating early/late weeks, Mon–Fri, never on a holiday or leave day. */
  const rosterTemplate = (handle: string, day: Date): Tpl | null => {
    if (SPEC[handle].sched !== "SHIFT_BASED") return null;
    if (!isContractDay(handle, day) || leaveShareOn(handle, day) > 0) return null;
    const week = Math.floor((addDays(day, -mondayIdx(day)).getTime() / DAY_MS + 3) / 7);
    const early = (week + (handle === "aylin" ? 0 : 1)) % 2 === 0;
    return early ? tFruh : tSpat;
  };

  interface DayPlan {
    start: number; // minutes since local midnight
    net: number; // net working minutes
    tpl?: Tpl;
  }
  const dayPlan = (handle: string, day: Date): DayPlan | null => {
    const s = SPEC[handle];
    if (!isContractDay(handle, day)) return null;
    if (handle === "felix" && schoolDays.has(iso(day))) return null;
    if (s.sched === "SHIFT_BASED") {
      const tpl = rosterTemplate(handle, day);
      return tpl ? { start: toMin(tpl.startTime), net: 8 * 60, tpl } : null;
    }
    if (s.sched === "MONTHLY_HOURS") {
      return mondayIdx(day) === 1 || mondayIdx(day) === 3 ? { start: 9 * 60, net: 285 } : null;
    }
    const hours = s.dayHours[mondayIdx(day)];
    return { start: handle === "david" ? 7 * 60 + 30 : 9 * 60, net: hours * 60 };
  };
  const minor = (handle: string) => handle === "felix";
  const breakFor = (handle: string, net: number): number => {
    if (minor(handle)) return net > 6 * 60 ? 60 : net > 270 ? 30 : 0;
    return net > 9 * 60 ? 45 : net > 6 * 60 ? 30 : 0;
  };

  // ── TimeEntries (+ Breaks) for every person ────────────────────────────────
  // Issue #577 break findings: the Springerin's split day (two salons, a 30-minute gap that is
  // either travel or a break → "Klärung nötig") and one long day with a 15-minute break (§ 4).
  const ninaSplitDay = iso(pastContractWeekday("nina", 2)); // a Wednesday in Nord
  const davidShortBreakDay = iso(pastContractDay("david", 2));

  interface Block {
    start: number;
    end: number;
    salonId: string;
    breaks: Array<[number, number]>;
  }
  async function writeEntry(handle: string, day: Date, b: Block, locked: boolean) {
    const breakMinutes = b.breaks.reduce((sum, [from, to]) => sum + (to - from), 0);
    await prisma.timeEntry.create({
      data: {
        employeeId: emp[handle].empId,
        date: day,
        startTime: clockAt(day, b.start),
        endTime: clockAt(day, b.end),
        breakMinutes,
        type: "WORK",
        source: "MANUAL",
        isLocked: locked,
        lockedAt: locked ? addDays(todayUTC, -1) : null,
        createdBy: emp[handle].userId,
        salonId: b.salonId, // Phase 68b (issue #68): the salon the person worked in that day
        breaks: {
          create: b.breaks.map(([from, to]) => ({
            startTime: clockAt(day, from),
            endTime: clockAt(day, to),
          })),
        },
      },
    });
    bump("timeEntry");
    bump("break", b.breaks.length);
  }

  /** The recorded blocks of a normal day: the plan, a small deterministic deviation, the break
   *  after four hours, half a day on a half-day leave. */
  function blocksFor(handle: string, day: Date): Block[] {
    const plan = dayPlan(handle, day);
    if (!plan) return [];
    const share = leaveShareOn(handle, day);
    if (share >= 1) return [];
    const salonId = salonOfDay(handle, day);
    if (handle === "nina" && iso(day) === ninaSplitDay) {
      return [
        { start: 8 * 60, end: 12 * 60, salonId: salonIdOf.NORD, breaks: [] },
        { start: 12 * 60 + 30, end: 16 * 60 + 30, salonId: salonIdOf.MITTE, breaks: [] },
      ];
    }
    if (handle === "david" && iso(day) === davidShortBreakDay) {
      return [
        { start: 7 * 60 + 30, end: 17 * 60 + 45, salonId, breaks: [[12 * 60, 12 * 60 + 15]] },
      ];
    }
    const net = share > 0 ? plan.net / 2 : plan.net;
    // -10 … +15 minutes, deterministic per person and day, so saldi differ a little. The Azubi
    // keeps the plan exactly (§ 8 JArbSchG: at most 8 hours a day).
    const deviation = minor(handle)
      ? 0
      : Math.min(
          [-10, 0, 5, 10, 15][(day.getUTCDate() + HANDLE_INDEX[handle]) % 5],
          10 * 60 - net, // never above the § 3 ArbZG daily cap of 10 hours
        );
    const worked = net + deviation;
    const pause = breakFor(handle, worked); // the break follows the time actually worked
    // the break in the middle of the day, on a quarter hour: no block longer than § 4 Satz 3
    // ArbZG / § 11 Abs. 2 JArbSchG allow
    const breakStart = plan.start + Math.round(net / 2 / 15) * 15;
    return [
      {
        start: plan.start,
        end: plan.start + worked + pause,
        salonId,
        breaks: pause > 0 ? [[breakStart, breakStart + pause]] : [],
      },
    ];
  }

  async function genEntries(handle: string, from: Date, to: Date, locked: boolean) {
    for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
      const day = new Date(t);
      for (const block of blocksFor(handle, day)) await writeEntry(handle, day, block, locked);
    }
  }

  const prevFrom = d0(PY, PM, 1);
  const prevTo = d0(PY, PM, prevLastDay);
  const curFrom = d0(Y, M, 1);
  const curTo = D > 1 ? d0(Y, M, D - 1) : null; // up to yesterday

  for (const { handle } of EMPLOYEES) {
    await genEntries(handle, prevFrom, prevTo, false); // prev month: the real closer locks it
    if (curTo) await genEntries(handle, curFrom, curTo, false);
  }

  // Lena "currently clocked in" today (open entry) — only if today is one of her workdays
  if (isContractDay("lena", todayUTC) && leaveShareOn("lena", todayUTC) === 0) {
    await prisma.timeEntry.create({
      data: {
        employeeId: emp.lena.empId,
        date: todayUTC,
        startTime: clock(todayUTC, 9, 2),
        endTime: null,
        breakMinutes: 0,
        type: "WORK",
        source: "NFC",
        createdBy: emp.lena.userId,
        salonId: salon.id, // Phase 68b (issue #68): every demo employee's HOME salon
      },
    });
    bump("timeEntry");
  }

  // ── SaldoSnapshot (pre-tracking marker, zero) ──────────────────────────────
  // Issue #595 (D-05, P-06): the seed does not invent a closed month. packages/db cannot run the
  // saldo kernel (it cannot import apps/api), so the seed states only what it can state
  // truthfully: tracking starts with the previous month. That is the product's own pre-tracking
  // pattern — one zero snapshot (all four figures 0) for the month BEFORE the previous one,
  // stored in the TZ-converted convention the closer writes. Issue #577: EVERY person gets it —
  // a person without a chain head accrues Soll from the hire date with no recorded time, which
  // is where the −1.398 h … −14.000 h saldi came from. The previous month itself is closed by the
  // real closer: apps/api/scripts/demo-close-previous-month.ts right after seeding (see
  // packages/db/README.md), or the running API's next 06:00 auto-close.
  const preTrackingYear = PM === 0 ? PY - 1 : PY;
  const preTrackingMonth = PM === 0 ? 12 : PM; // 1-based month before the previous one
  const preTrackingBounds = demoMonthRangeUtc(preTrackingYear, preTrackingMonth, DEMO_TZ);
  for (const { handle } of EMPLOYEES) {
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: emp[handle].empId,
        periodType: "MONTHLY",
        periodStart: preTrackingBounds.start,
        periodEnd: preTrackingBounds.end,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: prevFrom,
        closedBy: adminUserId,
        note: "Vor Erfassungsbeginn (Demo)",
        superseded: false,
      },
    });
    bump("saldoSnapshot");
  }

  // ── Shifts ─────────────────────────────────────────────────────────────────
  // SHIFT_BASED persons: the roster from the previous month to two weeks ahead — their recorded
  // time above follows it, so the § 615 saldo stays near zero. Everybody else: the current and
  // the next week, from the same day plans, so the shift plan shows the whole team.
  const shiftFrom = prevFrom;
  const shiftTo = addDays(monday, 13);
  for (const { handle } of EMPLOYEES) {
    if (handle === "admin") continue;
    const from = SPEC[handle].sched === "SHIFT_BASED" ? shiftFrom : monday;
    for (let day = from; day <= shiftTo; day = addDays(day, 1)) {
      const plan = dayPlan(handle, day);
      if (!plan || leaveShareOn(handle, day) > 0) continue;
      const end = plan.start + plan.net + breakFor(handle, plan.net);
      const tpl =
        plan.tpl ??
        (plan.start === toMin(tTag.startTime) && end === toMin(tTag.endTime) ? tTag : null);
      await prisma.shift.create({
        data: {
          employeeId: emp[handle].empId,
          templateId: tpl?.id ?? null,
          salonId: salonOfDay(handle, day), // Phase 325 (issue #325)
          date: day,
          startTime: hm(plan.start),
          endTime: hm(end),
          label: tpl?.name ?? null,
          origin: "MANUAL",
          createdBy: adminUserId,
        },
      });
      bump("shift");
    }
  }

  // A couple of PHOREST-origin shifts (imported) on Saturday of next week
  const saturday = addDays(monday, 12);
  const phorestShifts = [
    { handle: "aylin", start: "10:00", end: "16:00", key: "phorest-demo-shift-0001" },
    { handle: "tobias", start: "12:00", end: "18:00", key: "phorest-demo-shift-0002" },
  ];
  for (const ps of phorestShifts) {
    await prisma.shift.create({
      data: {
        employeeId: emp[ps.handle].empId,
        salonId: salon.id, // Phase 325 (issue #325)
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
      salonId: salon.id, // Phase 65b (issue #65): the salon whose branch the run synced
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
      salonId: salon.id, // Phase 65b (issue #65): the salon whose branch the run synced
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
          salonId: salon.id, // Phase 325 (issue #325)
          date: ad,
          startTime: a.start,
          endTime: a.end,
          externalId: `phorest-demo-appt-${String(apptKey++).padStart(4, "0")}`,
        },
      });
      bump("phorestAppointment");
    }
  }

  // ── PublicHoliday ──────────────────────────────────────────────────────────
  // Statutory holidays are computed by the API and never stored (CLAUDE.md "Public Holidays");
  // PublicHoliday rows are manual additions per salon. One local example in the second salon.
  const cityFestival = d0(NY, NM, 20);
  await prisma.publicHoliday.create({
    data: {
      tenantId: tenant.id,
      salonId: salonNord.id, // Phase 71b (issue #71)
      date: cityFestival,
      name: "Stadtteilfest (Salon geschlossen)",
      federalState: "NIEDERSACHSEN",
      year: cityFestival.getUTCFullYear(),
    },
  });
  bump("publicHoliday");

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
      type: "LEAVE_REQUEST",
      title: "Neuer Urlaubsantrag",
      message: "Sara Lindner hat einen Urlaubsantrag gestellt.",
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
  console.log(`   Admin:       ${ADMIN_EMAIL}`);
  console.log(`   Manager:     lena.vogel@${EMAIL_DOMAIN} · jonas.berg@${EMAIL_DOMAIN}`);
  console.log(`   Springerin:  nina.adler@${EMAIL_DOMAIN} (Salonwahl beim Einstempeln)`);
  console.log(`   Passwort:    ${DEMO_PASSWORD}`);
  console.log(`   Tenant:      Clokr Demo GmbH (slug: ${TENANT_SLUG})`);
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
