import { PrismaClient } from "../generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import bcrypt from "bcryptjs";

const ADMIN_EMAIL = "admin@clokr.de";
const ADMIN_PASSWORD = "admin1234";
const EMPLOYEE_EMAIL = "max@clokr.de";
const EMPLOYEE_PASSWORD = "mitarbeiter5678";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

async function main() {
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
    },
  });
  console.log("TenantConfig angelegt");

  // Admin User anlegen — skip password overwrite if user already exists
  const existingAdmin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  const adminUser = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: existingAdmin ? {} : { passwordHash: adminPasswordHash },
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

  // Urlaubs-Typ anlegen
  const leaveType = await prisma.leaveType.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      tenantId: tenant.id,
      name: "Jahresurlaub",
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
