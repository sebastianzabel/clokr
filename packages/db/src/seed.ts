import { PrismaClient } from "../generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

// Einfaches bcrypt-ähnliches Hash für Seed (ohne bcrypt dependency im db package)
// Wir nutzen einen festen Hash für "admin1234" – nur für Dev!
// Generiert mit: bcrypt.hashSync("admin1234", 12)
const ADMIN_PASSWORD_HASH = "$2a$12$Ueek/KvgJbd3YjYSzydoMeerrFf2nKJoDdhHgzV05hYcS9ZTRArm2";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("🌱 Starte Seed...");

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
  console.log(`✅ Tenant: ${tenant.name}`);

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
  console.log("✅ TenantConfig angelegt");

  // Admin User anlegen
  const adminUser = await prisma.user.upsert({
    where: { email: "admin@clokr.de" },
    update: {},
    create: {
      email: "admin@clokr.de",
      passwordHash: ADMIN_PASSWORD_HASH,
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
      hireDate: new Date("2020-01-01"),
    },
  });

  await prisma.workSchedule.upsert({
    where: { employeeId: adminEmployee.id },
    update: {},
    create: {
      employeeId: adminEmployee.id,
      weeklyHours: 40,
      validFrom: new Date("2020-01-01"),
    },
  });

  await prisma.overtimeAccount.upsert({
    where: { employeeId: adminEmployee.id },
    update: {},
    create: { employeeId: adminEmployee.id, balanceHours: 0 },
  });

  console.log(`✅ Admin: ${adminUser.email} / Passwort: admin1234`);

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
  console.log(`✅ Urlaubstyp: ${leaveType.name}`);

  // Urlaubsanspruch für Admin anlegen
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

  // Test-Mitarbeiter anlegen
  const empUser = await prisma.user.upsert({
    where: { email: "max@clokr.de" },
    update: {},
    create: {
      email: "max@clokr.de",
      passwordHash: ADMIN_PASSWORD_HASH, // gleicher Hash, Passwort: admin1234
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
      hireDate: new Date("2022-03-01"),
      nfcCardId: "NFC-TEST-001",
    },
  });

  await prisma.workSchedule.upsert({
    where: { employeeId: emp.id },
    update: {},
    create: {
      employeeId: emp.id,
      weeklyHours: 40,
      validFrom: new Date("2022-03-01"),
    },
  });

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

  console.log(`✅ Mitarbeiter: ${empUser.email} / Passwort: admin1234`);
  console.log("\n🎉 Seed abgeschlossen!");
  console.log("\n📋 Login-Daten:");
  console.log("   Admin:       admin@clokr.de  /  admin1234");
  console.log("   Mitarbeiter: max@clokr.de    /  admin1234");
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
