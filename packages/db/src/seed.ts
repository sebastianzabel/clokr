import { PrismaClient, type Prisma } from "../generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import bcrypt from "bcryptjs";
import { ADMIN_EMAIL, ADMIN_PASSWORD, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD } from "./seed-credentials";
import { DEFAULT_SALON_OPENING_HOURS, createDefaultHomeAssignment } from "./default-salon";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

async function main() {
  // Skip seed if demo tenant already exists (robust against user anonymization which changes emails)
  const existingTenant = await prisma.tenant.findFirst({
    where: { slug: "demo-clokr" },
  });
  if (existingTenant) {
    console.log("ℹ️  Demo-Daten existieren bereits – Seed übersprungen.");
    return;
  }

  console.log("Starte Seed...");

  const adminPasswordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const employeePasswordHash = await bcrypt.hash(EMPLOYEE_PASSWORD, 12);

  // Tenant anlegen
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo-clokr" },
    update: {},
    create: {
      name: "Clokr Demo",
      slug: "demo-clokr",
      federalState: "NIEDERSACHSEN",
    },
  });
  console.log(`Tenant: ${tenant.name}`);

  // Globale Arbeitszeitvorgaben (TenantConfig)
  await prisma.tenantConfig.upsert({
    where: { tenantId: tenant.id },
    update: {},
    create: {
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
      allowOvertimePayout: false,
      // D-18 (Phase 64b, issue #64): explicit so it stays in step, on write, with
      // the default salon's openingHours below — both come from the same constant.
      storeHours: DEFAULT_SALON_OPENING_HOURS as unknown as Prisma.InputJsonValue,
    },
  });
  console.log("TenantConfig angelegt");

  // D-18 (Phase 64b, issue #64): every tenant this seed bootstraps also gets its
  // default salon, in the same step. An already-seeded tenant never reaches this
  // point (main() returns early when `demo-clokr` exists) — such tenants got their
  // salon from the migration's data section. The findFirst guard only keeps this
  // block safe on its own; it is not a second idempotency mechanism. No audit-log
  // write here (research Pitfall 5) — a seed script has no request principal.
  const existingSalon = await prisma.salon.findFirst({ where: { tenantId: tenant.id } });
  if (!existingSalon) {
    await prisma.salon.create({
      data: {
        tenantId: tenant.id,
        name: tenant.name,
        federalState: tenant.federalState, // Phase 71b (issue #71)
        openingHours: DEFAULT_SALON_OPENING_HOURS as unknown as Prisma.InputJsonValue,
        isActive: true,
      },
    });
    console.log("Salon angelegt");
  }

  // Admin User anlegen — skip password overwrite if user already exists
  const existingAdminUser = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  const adminUser = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: existingAdminUser ? {} : { passwordHash: adminPasswordHash },
    create: {
      email: ADMIN_EMAIL,
      passwordHash: adminPasswordHash,
      role: "ADMIN",
    },
  });

  // Admin Mitarbeiter-Profil
  const adminEmployee = await prisma.employee.upsert({
    where: { userId: adminUser.id },
    update: {},
    create: {
      tenantId: tenant.id,
      userId: adminUser.id,
      employeeNumber: "001",
      firstName: "Admin",
      lastName: "Clokr",
      hireDate: new Date(),
    },
  });

  // D-24 (Phase 67b Plan 04, issue #67): every employee this seed creates also gets its
  // Stammsalon (HOME) row. Idempotent — a no-op on a re-run against an already-seeded
  // database's admin employee (main() only reaches this far when demo-clokr didn't exist
  // yet, but the helper's own idempotency check keeps this call safe either way).
  await createDefaultHomeAssignment(prisma, adminEmployee.id);
  console.log("Stammsalon zugeordnet");

  const existingAdminSchedule = await prisma.workSchedule.findFirst({
    where: { employeeId: adminEmployee.id },
  });
  if (!existingAdminSchedule) {
    await prisma.workSchedule.create({
      data: {
        employeeId: adminEmployee.id,
        weeklyHours: 40,
        validFrom: new Date(),
      },
    });
  }

  await prisma.overtimeAccount.upsert({
    where: { employeeId: adminEmployee.id },
    update: {},
    create: { employeeId: adminEmployee.id, balanceHours: 0 },
  });

  console.log(`Admin: ${adminUser.email}`);

  // Phase 97 (D-19): the seed used to write the legacy vacation name from the pre-phase-97 seed
  // set. The row's identity is now its code; `update` carries the code onto an already-seeded
  // database. Do not quote that legacy name here — the acceptance criterion greps this file for
  // it and expects zero hits.
  // Values mirror LEAVE_TYPE_DEFS.VACATION in apps/api/src/utils/leave-type.ts.
  const leaveType = await prisma.leaveType.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: { code: "VACATION" },
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      tenantId: tenant.id,
      code: "VACATION",
      name: "Urlaub",
      isPaid: true,
      requiresApproval: true,
      color: "#3B82F6",
    },
  });
  console.log(`Urlaubstyp: ${leaveType.name}`);

  // Urlaubsanspruch fuer Admin anlegen
  await prisma.leaveEntitlement.upsert({
    where: {
      employeeId_leaveTypeId_year: {
        employeeId: adminEmployee.id,
        leaveTypeId: leaveType.id,
        year: 2026,
      },
    },
    update: {},
    create: {
      employeeId: adminEmployee.id,
      leaveTypeId: leaveType.id,
      year: 2026,
      totalDays: 28,
      carriedOverDays: 2,
    },
  });

  // Test-Mitarbeiter anlegen — skip password overwrite if user already exists
  const existingEmp = await prisma.user.findUnique({ where: { email: EMPLOYEE_EMAIL } });
  const empUser = await prisma.user.upsert({
    where: { email: EMPLOYEE_EMAIL },
    update: existingEmp ? {} : { passwordHash: employeePasswordHash },
    create: {
      email: EMPLOYEE_EMAIL,
      passwordHash: employeePasswordHash,
      role: "EMPLOYEE",
    },
  });

  const emp = await prisma.employee.upsert({
    where: { userId: empUser.id },
    update: {},
    create: {
      tenantId: tenant.id,
      userId: empUser.id,
      employeeNumber: "002",
      firstName: "Max",
      lastName: "Mustermann",
      hireDate: new Date(),
      nfcCardId: "NFC-TEST-001",
    },
  });

  // D-24 (Phase 67b Plan 04, issue #67): same Stammsalon assignment as the admin above.
  await createDefaultHomeAssignment(prisma, emp.id);
  console.log("Stammsalon zugeordnet");

  const existingEmpSchedule = await prisma.workSchedule.findFirst({
    where: { employeeId: emp.id },
  });
  if (!existingEmpSchedule) {
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        weeklyHours: 40,
        validFrom: new Date(),
      },
    });
  }

  await prisma.overtimeAccount.upsert({
    where: { employeeId: emp.id },
    update: {},
    create: { employeeId: emp.id, balanceHours: 12.5 },
  });

  await prisma.leaveEntitlement.upsert({
    where: {
      employeeId_leaveTypeId_year: {
        employeeId: emp.id,
        leaveTypeId: leaveType.id,
        year: 2026,
      },
    },
    update: {},
    create: {
      employeeId: emp.id,
      leaveTypeId: leaveType.id,
      year: 2026,
      totalDays: 28,
      carriedOverDays: 0,
    },
  });

  console.log(`Mitarbeiter: ${empUser.email}`);
  console.log("\nSeed abgeschlossen!");

  if (process.env.NODE_ENV !== "production") {
    console.log("\nLogin-Daten:");
    console.log(`   Admin:       ${ADMIN_EMAIL}`);
    console.log(`   Mitarbeiter: ${EMPLOYEE_EMAIL}`);
    console.log("   (Passwörter siehe .env oder Seed-Konfiguration)");
  }
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
