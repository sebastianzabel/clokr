/**
 * Demo Data Reset Script
 *
 * Deletes all employees except admin, resets admin to 2026-01-01,
 * and creates 5 realistic employees with time entries, leave requests,
 * and absences from 2026-01-01 through 2026-04-10 (last workday).
 *
 * Run:
 *   DATABASE_URL="postgresql://clokr:password@localhost:5432/clokr" \
 *   pnpm --filter @clokr/db tsx src/reset-demo.ts
 */

import { PrismaClient } from "../generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import bcrypt from "bcryptjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

// ── Constants ─────────────────────────────────────────────────────────────────

const HIRE_DATE_STR = "2026-01-01";
const LAST_ENTRY_STR = "2026-04-10"; // Last Friday before today (Sun 2026-04-12)

// DST 2026: clocks spring forward on 2026-03-29 02:00 CET → 03:00 CEST
const DST_START_UTC = new Date("2026-03-29T01:00:00.000Z");

// Niedersachsen public holidays in this period
const HOLIDAYS_2026 = new Set(["2026-01-01", "2026-04-03", "2026-04-06"]);

// ── Date utilities ────────────────────────────────────────────────────────────

function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

function dateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

/** Convert a Berlin local time to UTC, accounting for DST. */
function berlinToUTC(date: Date, hour: number, min: number): Date {
  const offset = date >= DST_START_UTC ? 2 : 1; // UTC+1 (CET) or UTC+2 (CEST)
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour - offset, min, 0, 0)
  );
}

/**
 * Get all workdays between from and to (inclusive).
 * @param workDows - Array of day-of-week numbers to include (0=Sun…6=Sat). null = Mon–Fri.
 * @param skipDates - ISO date strings to skip (vacation, sick days, etc.)
 */
function getWorkdays(
  from: string,
  to: string,
  skipDates: string[] = [],
  workDows: number[] | null = null
): Date[] {
  const skip = new Set(skipDates);
  const result: Date[] = [];
  let cur = parseDate(from);
  const end = parseDate(to);

  while (cur <= end) {
    const dow = cur.getUTCDay();
    const allowed = workDows !== null ? workDows.includes(dow) : dow >= 1 && dow <= 5;
    if (allowed && !HOLIDAYS_2026.has(dateStr(cur)) && !skip.has(dateStr(cur))) {
      result.push(new Date(cur));
    }
    cur = addDays(cur, 1);
  }
  return result;
}

// ── Employee pattern types ────────────────────────────────────────────────────

interface DayPattern {
  startH: number;
  startM: number;
  endH: number;
  endM: number;
  breakMin: number;
}

type DowMap = Record<number, DayPattern>; // key: 1=Mon…5=Fri

interface EmployeeDef {
  num: string;
  firstName: string;
  lastName: string;
  email: string;
  role: "EMPLOYEE" | "MANAGER" | "ADMIN";
  weeklyHours: number;
  scheduleHours: {
    mondayHours: number;
    tuesdayHours: number;
    wednesdayHours: number;
    thursdayHours: number;
    fridayHours: number;
    saturdayHours: number;
    sundayHours: number;
  };
  patterns: DowMap;
  workDows: number[];
  skipDates: string[];
  vacation: { startDate: string; endDate: string; days: number } | null;
  pendingVacation: { startDate: string; endDate: string; days: number } | null;
  sickPeriods: { startDate: string; endDate: string; days: number }[];
  entitlement: { totalDays: number; carriedOverDays: number; usedDays: number };
  nfcCardId?: string;
}

// ── Employee definitions ──────────────────────────────────────────────────────

const EMPLOYEES: EmployeeDef[] = [
  // ── 1. Lena Berger — slight minus saldo ───────────────────────────────────
  {
    num: "002",
    firstName: "Lena",
    lastName: "Berger",
    email: "lena.berger@clokr.de",
    role: "EMPLOYEE",
    weeklyHours: 40,
    scheduleHours: { mondayHours: 8, tuesdayHours: 8, wednesdayHours: 8, thursdayHours: 8, fridayHours: 8, saturdayHours: 0, sundayHours: 0 },
    // Mon/Tue/Thu: 8h | Wed: 7:30h | Fri: 7h → avg ~7:42h/day (deficit ~-8h over period)
    patterns: {
      1: { startH: 8, startM: 0, endH: 16, endM: 30, breakMin: 30 }, // 8:00h
      2: { startH: 8, startM: 0, endH: 16, endM: 30, breakMin: 30 }, // 8:00h
      3: { startH: 8, startM: 0, endH: 16, endM: 0,  breakMin: 30 }, // 7:30h
      4: { startH: 8, startM: 0, endH: 16, endM: 30, breakMin: 30 }, // 8:00h
      5: { startH: 8, startM: 0, endH: 15, endM: 30, breakMin: 30 }, // 7:00h
    },
    workDows: [1, 2, 3, 4, 5],
    skipDates: [
      "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", // KW8 vacation
    ],
    vacation: { startDate: "2026-02-16", endDate: "2026-02-20", days: 5 },
    pendingVacation: null,
    sickPeriods: [],
    entitlement: { totalDays: 28, carriedOverDays: 0, usedDays: 5 },
  },

  // ── 2. Markus Klein — clear overtime ──────────────────────────────────────
  {
    num: "003",
    firstName: "Markus",
    lastName: "Klein",
    email: "markus.klein@clokr.de",
    role: "EMPLOYEE",
    weeklyHours: 40,
    scheduleHours: { mondayHours: 8, tuesdayHours: 8, wednesdayHours: 8, thursdayHours: 8, fridayHours: 8, saturdayHours: 0, sundayHours: 0 },
    // Consistently 9h+ → ~+35h overtime over period
    patterns: {
      1: { startH: 7, startM: 30, endH: 17, endM: 0,  breakMin: 30 }, // 9:00h
      2: { startH: 7, startM: 30, endH: 17, endM: 0,  breakMin: 30 }, // 9:00h
      3: { startH: 7, startM: 30, endH: 17, endM: 30, breakMin: 30 }, // 9:30h
      4: { startH: 7, startM: 30, endH: 17, endM: 0,  breakMin: 30 }, // 9:00h
      5: { startH: 7, startM: 30, endH: 16, endM: 30, breakMin: 30 }, // 8:30h
    },
    workDows: [1, 2, 3, 4, 5],
    skipDates: [],
    vacation: null,
    pendingVacation: null,
    sickPeriods: [],
    entitlement: { totalDays: 28, carriedOverDays: 0, usedDays: 0 },
    nfcCardId: "NFC-MARKUS-001",
  },

  // ── 3. Sarah Weber — part-time 30h, MANAGER, Mon–Thu ──────────────────────
  {
    num: "004",
    firstName: "Sarah",
    lastName: "Weber",
    email: "sarah.weber@clokr.de",
    role: "MANAGER",
    weeklyHours: 30,
    scheduleHours: { mondayHours: 7.5, tuesdayHours: 7.5, wednesdayHours: 7.5, thursdayHours: 7.5, fridayHours: 0, saturdayHours: 0, sundayHours: 0 },
    // 7:30h per day Mon–Thu (slightly on target)
    patterns: {
      1: { startH: 8, startM: 30, endH: 16, endM: 15, breakMin: 15 }, // 7:30h
      2: { startH: 8, startM: 30, endH: 16, endM: 15, breakMin: 15 }, // 7:30h
      3: { startH: 8, startM: 30, endH: 16, endM: 15, breakMin: 15 }, // 7:30h
      4: { startH: 8, startM: 30, endH: 16, endM: 15, breakMin: 15 }, // 7:30h
    },
    workDows: [1, 2, 3, 4], // Mon–Thu only
    skipDates: [
      "2026-01-19", "2026-01-20", "2026-01-21", // Vacation KW4 Mon–Wed
      "2026-03-05",                               // Sick Thu
    ],
    vacation: { startDate: "2026-01-19", endDate: "2026-01-21", days: 3 },
    pendingVacation: null,
    sickPeriods: [{ startDate: "2026-03-05", endDate: "2026-03-05", days: 1 }],
    entitlement: { totalDays: 22, carriedOverDays: 0, usedDays: 3 },
  },

  // ── 4. Thomas Richter — 2-week sick leave in February ─────────────────────
  {
    num: "005",
    firstName: "Thomas",
    lastName: "Richter",
    email: "thomas.richter@clokr.de",
    role: "EMPLOYEE",
    weeklyHours: 40,
    scheduleHours: { mondayHours: 8, tuesdayHours: 8, wednesdayHours: 8, thursdayHours: 8, fridayHours: 8, saturdayHours: 0, sundayHours: 0 },
    // Slightly below 8h/day → mild minus even without sick days
    patterns: {
      1: { startH: 8, startM: 0, endH: 16, endM: 15, breakMin: 30 }, // 7:45h
      2: { startH: 8, startM: 0, endH: 16, endM: 15, breakMin: 30 }, // 7:45h
      3: { startH: 8, startM: 0, endH: 16, endM: 15, breakMin: 30 }, // 7:45h
      4: { startH: 8, startM: 0, endH: 16, endM: 15, breakMin: 30 }, // 7:45h
      5: { startH: 8, startM: 0, endH: 16, endM: 0,  breakMin: 30 }, // 7:30h
    },
    workDows: [1, 2, 3, 4, 5],
    skipDates: [
      // KW6–KW7 sick (Mon 09.02 – Fri 20.02 = 10 workdays)
      "2026-02-09", "2026-02-10", "2026-02-11", "2026-02-12", "2026-02-13",
      "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20",
    ],
    vacation: null,
    pendingVacation: null,
    sickPeriods: [{ startDate: "2026-02-09", endDate: "2026-02-20", days: 10 }],
    entitlement: { totalDays: 28, carriedOverDays: 0, usedDays: 0 },
    nfcCardId: "NFC-THOMAS-001",
  },

  // ── 5. Julia Hoffmann — MANAGER, overtime, approved + pending vacation ────
  {
    num: "006",
    firstName: "Julia",
    lastName: "Hoffmann",
    email: "julia.hoffmann@clokr.de",
    role: "MANAGER",
    weeklyHours: 40,
    scheduleHours: { mondayHours: 8, tuesdayHours: 8, wednesdayHours: 8, thursdayHours: 8, fridayHours: 8, saturdayHours: 0, sundayHours: 0 },
    // 8:45–9h regular → ~+12h overtime (net, after vacation reduction)
    patterns: {
      1: { startH: 7, startM: 45, endH: 17, endM: 15, breakMin: 45 }, // 8:45h
      2: { startH: 7, startM: 45, endH: 17, endM: 30, breakMin: 45 }, // 9:00h
      3: { startH: 7, startM: 45, endH: 17, endM: 15, breakMin: 45 }, // 8:45h
      4: { startH: 7, startM: 45, endH: 17, endM: 30, breakMin: 45 }, // 9:00h
      5: { startH: 7, startM: 45, endH: 16, endM: 30, breakMin: 45 }, // 8:00h
    },
    workDows: [1, 2, 3, 4, 5],
    skipDates: [
      "2026-03-23", "2026-03-24", "2026-03-25", "2026-03-26", "2026-03-27", // KW13 vacation
    ],
    vacation: { startDate: "2026-03-23", endDate: "2026-03-27", days: 5 },
    pendingVacation: { startDate: "2026-04-27", endDate: "2026-05-01", days: 5 },
    sickPeriods: [],
    entitlement: { totalDays: 28, carriedOverDays: 3, usedDays: 5 },
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Clokr Demo Data Reset ===\n");

  // ── Locate tenant & admin ────────────────────────────────────────────────

  const adminUser = await prisma.user.findUnique({ where: { email: "admin@clokr.de" } });
  if (!adminUser) throw new Error("Admin user not found.");

  const adminEmp = await prisma.employee.findUnique({ where: { userId: adminUser.id } });
  if (!adminEmp) throw new Error("Admin employee profile not found.");

  const tenant = await prisma.tenant.findUnique({ where: { id: adminEmp.tenantId } });
  if (!tenant) throw new Error("Admin tenant not found.");

  console.log(`Target tenant: "${tenant.name}" (${tenant.slug}, id: ${tenant.id})\n`);

  // ── Ensure leave type exists in the correct tenant ──────────────────────

  const leaveType = await prisma.leaveType.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: "Jahresurlaub" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Jahresurlaub",
      isPaid: true,
      requiresApproval: true,
      color: "#3B82F6",
    },
  });

  // ── Clean up wrongly-placed employees from other tenants ─────────────────

  const wrongTenantEmps = await prisma.employee.findMany({
    where: {
      tenantId: { not: tenant.id },
      user: { email: { in: EMPLOYEES.map((e) => e.email) } },
    },
    select: { id: true, userId: true },
  });

  if (wrongTenantEmps.length > 0) {
    const ids = wrongTenantEmps.map((e) => e.id);
    const uids = wrongTenantEmps.map((e) => e.userId);
    await prisma.timeEntry.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.absence.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.employee.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: uids } } });
    console.log(`Cleaned up ${ids.length} employees from wrong tenant.\n`);
  }

  // ── Delete all non-admin employees ──────────────────────────────────────

  console.log("Deleting non-admin employees and users...");

  const empsToDelete = await prisma.employee.findMany({
    where: { tenantId: tenant.id, userId: { not: adminUser.id } },
    select: { id: true, userId: true },
  });

  if (empsToDelete.length > 0) {
    const empIds = empsToDelete.map((e) => e.id);
    const userIds = empsToDelete.map((e) => e.userId);

    // Delete Restrict-guarded relations first
    await prisma.timeEntry.deleteMany({ where: { employeeId: { in: empIds } } }); // Breaks cascade
    await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: empIds } } });
    await prisma.absence.deleteMany({ where: { employeeId: { in: empIds } } });
    await prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: empIds } } });

    // Delete employees (WorkSchedule, OvertimeAccount, LeaveEntitlement, etc. cascade)
    await prisma.employee.deleteMany({ where: { id: { in: empIds } } });

    // Delete user accounts (Notification, RefreshToken, OtpToken cascade)
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });

    console.log(`  Deleted ${empIds.length} employees.\n`);
  } else {
    console.log("  No non-admin employees found.\n");
  }

  // ── Reset admin employee ─────────────────────────────────────────────────

  console.log("Resetting admin (Admin Clokr)...");

  // Clear existing time entries (Breaks cascade)
  await prisma.timeEntry.deleteMany({ where: { employeeId: adminEmp.id } });
  await prisma.leaveRequest.deleteMany({ where: { employeeId: adminEmp.id } });
  await prisma.leaveEntitlement.deleteMany({ where: { employeeId: adminEmp.id } });
  await prisma.absence.deleteMany({ where: { employeeId: adminEmp.id } });
  await prisma.saldoSnapshot.deleteMany({ where: { employeeId: adminEmp.id } });

  // Reset work schedule
  await prisma.workSchedule.deleteMany({ where: { employeeId: adminEmp.id } });
  await prisma.workSchedule.create({
    data: {
      employeeId: adminEmp.id,
      weeklyHours: 40,
      mondayHours: 8, tuesdayHours: 8, wednesdayHours: 8,
      thursdayHours: 8, fridayHours: 8, saturdayHours: 0, sundayHours: 0,
      validFrom: parseDate(HIRE_DATE_STR),
    },
  });

  // Reset overtime account
  await prisma.overtimeAccount.upsert({
    where: { employeeId: adminEmp.id },
    update: { balanceHours: 0 },
    create: { employeeId: adminEmp.id, balanceHours: 0 },
  });

  // Update hireDate
  await prisma.employee.update({
    where: { id: adminEmp.id },
    data: { hireDate: parseDate(HIRE_DATE_STR) },
  });

  // Leave entitlement
  await prisma.leaveEntitlement.create({
    data: {
      employeeId: adminEmp.id,
      leaveTypeId: leaveType.id,
      year: 2026,
      totalDays: 28,
      carriedOverDays: 2,
      usedDays: 0,
    },
  });

  // Admin time entries: Mo–Fr, always 7:45h net, random start times per day
  // Deterministic variation based on day-of-year so it looks natural but is reproducible
  const adminDays = getWorkdays(HIRE_DATE_STR, LAST_ENTRY_STR);
  await prisma.timeEntry.createMany({
    data: adminDays.map((day) => {
      // Simple hash of the date for deterministic "randomness"
      const seed = day.getUTCDate() * 31 + day.getUTCMonth() * 7;
      // Start between 07:45 and 09:45 in 15-min steps (9 options)
      const startOffsetMins = (seed % 9) * 15; // 0,15,30,...,120 min after 07:45
      const startTotalMins = 7 * 60 + 45 + startOffsetMins;
      const startH = Math.floor(startTotalMins / 60);
      const startM = startTotalMins % 60;
      // Break: 0 or 30 min (odd seed days get a break)
      const breakMin = seed % 3 === 0 ? 30 : 0;
      // End = start + 7h45m + break
      const endTotalMins = startTotalMins + 7 * 60 + 45 + breakMin;
      const endH = Math.floor(endTotalMins / 60);
      const endM = endTotalMins % 60;
      return {
        employeeId: adminEmp.id,
        date: day,
        startTime: berlinToUTC(day, startH, startM),
        endTime: berlinToUTC(day, endH, endM),
        breakMinutes: breakMin,
        type: "WORK" as const,
        source: "MANUAL" as const,
        createdBy: adminUser.id,
      };
    }),
  });

  console.log(`  hireDate → 2026-01-01 | ${adminDays.length} Einträge (7:45h/Tag variabel → -5h/Monat)\n`);

  // ── Create new employees ─────────────────────────────────────────────────

  const password = await bcrypt.hash("DemoPass1234!", 12);

  for (const def of EMPLOYEES) {
    console.log(`Creating ${def.firstName} ${def.lastName} (${def.num})...`);

    // User account
    const user = await prisma.user.create({
      data: { email: def.email, passwordHash: password, role: def.role },
    });

    // Employee profile
    const emp = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        employeeNumber: def.num,
        firstName: def.firstName,
        lastName: def.lastName,
        hireDate: parseDate(HIRE_DATE_STR),
        ...(def.nfcCardId ? { nfcCardId: def.nfcCardId } : {}),
      },
    });

    // Work schedule
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        weeklyHours: def.weeklyHours,
        ...def.scheduleHours,
        validFrom: parseDate(HIRE_DATE_STR),
      },
    });

    // Overtime account
    await prisma.overtimeAccount.create({
      data: { employeeId: emp.id, balanceHours: 0 },
    });

    // Leave entitlement
    await prisma.leaveEntitlement.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: leaveType.id,
        year: 2026,
        totalDays: def.entitlement.totalDays,
        carriedOverDays: def.entitlement.carriedOverDays,
        usedDays: def.entitlement.usedDays,
      },
    });

    // Approved vacation leave request
    if (def.vacation) {
      await prisma.leaveRequest.create({
        data: {
          employeeId: emp.id,
          leaveTypeId: leaveType.id,
          startDate: parseDate(def.vacation.startDate),
          endDate: parseDate(def.vacation.endDate),
          days: def.vacation.days,
          status: "APPROVED",
          reviewedBy: adminUser.id,
          reviewedAt: new Date("2026-01-08T10:00:00.000Z"),
          reviewNote: "Genehmigt.",
        },
      });
    }

    // Pending vacation leave request (Julia only)
    if (def.pendingVacation) {
      await prisma.leaveRequest.create({
        data: {
          employeeId: emp.id,
          leaveTypeId: leaveType.id,
          startDate: parseDate(def.pendingVacation.startDate),
          endDate: parseDate(def.pendingVacation.endDate),
          days: def.pendingVacation.days,
          status: "PENDING",
        },
      });
    }

    // Sick absences
    for (const sick of def.sickPeriods) {
      await prisma.absence.create({
        data: {
          employeeId: emp.id,
          type: "SICK",
          startDate: parseDate(sick.startDate),
          endDate: parseDate(sick.endDate),
          days: sick.days,
          createdBy: adminUser.id,
        },
      });
    }

    // Time entries
    const workdays = getWorkdays(HIRE_DATE_STR, LAST_ENTRY_STR, def.skipDates, def.workDows);

    await prisma.timeEntry.createMany({
      data: workdays
        .map((day) => {
          const dow = day.getUTCDay();
          const p = def.patterns[dow];
          if (!p) return null;
          return {
            employeeId: emp.id,
            date: day,
            startTime: berlinToUTC(day, p.startH, p.startM),
            endTime: berlinToUTC(day, p.endH, p.endM),
            breakMinutes: p.breakMin,
            type: "WORK" as const,
            source: "MANUAL" as const,
            createdBy: adminUser.id,
          };
        })
        .filter(Boolean) as {
          employeeId: string;
          date: Date;
          startTime: Date;
          endTime: Date;
          breakMinutes: number;
          type: "WORK";
          source: "MANUAL";
          createdBy: string;
        }[],
    });

    const details: string[] = [];
    if (def.vacation) details.push(`Urlaub ${def.vacation.startDate}–${def.vacation.endDate} (APPROVED)`);
    if (def.pendingVacation) details.push(`Urlaub ${def.pendingVacation.startDate}–${def.pendingVacation.endDate} (PENDING)`);
    for (const s of def.sickPeriods) details.push(`Krank ${s.startDate}–${s.endDate}`);

    console.log(`  → ${workdays.length} Zeiteinträge | ${details.join(" | ") || "keine Abwesenheiten"}`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log("\n=== Fertig! ===\n");
  console.log("Login-Daten (Passwort: DemoPass1234!):");
  console.log("  admin@clokr.de          Admin Clokr       (ADMIN)");
  console.log("  lena.berger@clokr.de    Lena Berger       (EMPLOYEE) – leichtes Minus ~-10h");
  console.log("  markus.klein@clokr.de   Markus Klein      (EMPLOYEE) – deutliche Überstunden ~+35h");
  console.log("  sarah.weber@clokr.de    Sarah Weber       (MANAGER)  – Teilzeit 30h Mo–Do, ausgeglichen");
  console.log("  thomas.richter@clokr.de Thomas Richter    (EMPLOYEE) – 2 Wochen krank Feb, leichtes Minus");
  console.log("  julia.hoffmann@clokr.de Julia Hoffmann    (MANAGER)  – Überstunden ~+12h, offener Urlaubsantrag");
  console.log("\nAdmin-Passwort: admin1234");
}

main()
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
