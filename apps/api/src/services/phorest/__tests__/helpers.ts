// Phase 85 — test seed/cleanup for the Phorest shift sync.
//
// Seeds a tenant + TenantConfig (with Phorest creds) + two employees + ONE PhorestStaffMapping.
// The staffId literals below MUST match fixtures/staff.json and fixtures/worktimetables.json.
//
// The unmapped employee (Max) has the SAME name + email as staff.json's "ph-staff-unmapped"
// but deliberately gets NO PhorestStaffMapping — this is the SS-01 negative-match fixture:
// the sync must ignore implicit name/email matching and rely only on explicit mapping.

import type { FastifyInstance } from "fastify";

export const MAPPED_STAFF_ID = "ph-staff-mapped";
export const UNMAPPED_STAFF_ID = "ph-staff-unmapped";
// Phase 85.1.1 (D-02/D-05) — a SECOND genuinely-mapped employee for the two-mapped-same-run test.
// Do NOT repurpose Max/UNMAPPED_STAFF_ID — that fixture guards the SS-01 negative-match test.
export const MAPPED_STAFF_ID_2 = "ph-staff-mapped-2";

export interface PhorestSeed {
  tenantId: string;
  mappedEmployeeId: string; // Erika — has a PhorestStaffMapping
  unmappedEmployeeId: string; // Max — name/email matches staff.json but NO mapping (SS-01)
  mappedEmployeeId2: string; // Bea — a second genuinely-mapped employee (85.1.1 two-mapped tests)
}

// The Phorest staff emails/names are NOT suffixed — the SS-01 negative-match test needs them to
// equal the static fixture entries so that an (incorrect) implicit match WOULD fire. That makes the
// User.email unique constraint global, so purge any leftovers from a crashed prior run first.
const FIXED_EMAILS = ["erika@salon.de", "max.beispiel@salon.de", "bea@salon.de"];

async function purgeFixedEmails(app: FastifyInstance): Promise<void> {
  const prisma = app.prisma;
  for (const email of FIXED_EMAILS) {
    const u = await prisma.user.findUnique({ where: { email } });
    if (!u) continue;
    const emp = await prisma.employee.findUnique({ where: { userId: u.id } });
    if (emp) {
      await prisma.phorestStaffMapping.deleteMany({ where: { employeeId: emp.id } });
      await prisma.shift.deleteMany({ where: { employeeId: emp.id } });
      await prisma.employee.delete({ where: { id: emp.id } });
    }
    await prisma.auditLog.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }
}

export async function seedPhorestTenant(app: FastifyInstance, suffix = ""): Promise<PhorestSeed> {
  const prisma = app.prisma;
  const s =
    (suffix ? suffix + "-" : "") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  await purgeFixedEmails(app);

  const tenant = await prisma.tenant.create({
    data: { name: `Phorest Test ${s}`, slug: `phorest-${s}`, federalState: "NIEDERSACHSEN" },
  });

  await prisma.tenantConfig.create({
    data: {
      tenantId: tenant.id,
      timezone: "Europe/Berlin",
      phorestBusinessId: "biz-1",
      phorestBranchId: "branch-1",
      phorestUsername: "user@salon.de",
      phorestPassword: "secret-pw", // decryptSafe tolerates plaintext
      phorestSyncWindowDays: 7,
    },
  });

  // Mapped employee — matches staff.json "ph-staff-mapped".
  const erikaUser = await prisma.user.create({
    data: { email: `erika@salon.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
  });
  const erika = await prisma.employee.create({
    data: {
      tenantId: tenant.id,
      userId: erikaUser.id,
      employeeNumber: `E-${s}`,
      firstName: "Erika",
      lastName: "Musterfrau",
      hireDate: new Date("2024-01-01"),
    },
  });

  // Unmapped-but-name/email-matchable employee — matches staff.json "ph-staff-unmapped".
  const maxUser = await prisma.user.create({
    data: { email: `max.beispiel@salon.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
  });
  const max = await prisma.employee.create({
    data: {
      tenantId: tenant.id,
      userId: maxUser.id,
      employeeNumber: `M-${s}`,
      firstName: "Max",
      lastName: "Beispiel",
      hireDate: new Date("2024-01-01"),
    },
  });

  // Second genuinely-mapped employee (85.1.1) — no static fixture email needed, this staffId is
  // only ever exercised via the per-test worktimetables-two-mapped.json fixture, not staff.json.
  const beaUser = await prisma.user.create({
    data: { email: `bea@salon.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
  });
  const bea = await prisma.employee.create({
    data: {
      tenantId: tenant.id,
      userId: beaUser.id,
      employeeNumber: `B-${s}`,
      firstName: "Bea",
      lastName: "Zweitfrau",
      hireDate: new Date("2024-01-01"),
    },
  });

  // EXPLICIT mapping ONLY for Erika + Bea. Max is intentionally left unmapped (SS-01).
  await prisma.phorestStaffMapping.create({
    data: { tenantId: tenant.id, phorestStaffId: MAPPED_STAFF_ID, employeeId: erika.id },
  });
  await prisma.phorestStaffMapping.create({
    data: { tenantId: tenant.id, phorestStaffId: MAPPED_STAFF_ID_2, employeeId: bea.id },
  });

  return {
    tenantId: tenant.id,
    mappedEmployeeId: erika.id,
    unmappedEmployeeId: max.id,
    mappedEmployeeId2: bea.id,
  };
}

// Phase 85.1 (D-06) — seed a single-day VOCATIONAL_SCHOOL Absence for the "BS gewinnt" tests.
// Mirrors the single-day-row invariant of vocational-school-generator.ts.
export async function seedVocationalSchoolAbsence(
  app: FastifyInstance,
  employeeId: string,
  dateStr: string,
): Promise<void> {
  await app.prisma.absence.create({
    data: {
      employeeId,
      type: "VOCATIONAL_SCHOOL",
      startDate: new Date(dateStr),
      endDate: new Date(dateStr),
      days: 1,
      createdBy: "SYSTEM",
    },
  });
}

export async function cleanupPhorestTenant(app: FastifyInstance, tenantId: string): Promise<void> {
  const prisma = app.prisma;
  const employees = await prisma.employee.findMany({
    where: { tenantId },
    select: { id: true, userId: true },
  });
  const employeeIds = employees.map((e) => e.id);
  const userIds = employees.map((e) => e.userId);

  // Delete in dependency order. PhorestStaffMapping.employee is onDelete: Restrict, so it MUST
  // be removed before the employees (unlike the shared cleanupTestData which does not know about it).
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.phorestStaffMapping.deleteMany({ where: { tenantId } });
  await prisma.phorestSyncRun.deleteMany({ where: { tenantId } });
  // Phase 86 — PhorestAppointment.employee is onDelete: Restrict, so it MUST be removed before the
  // employees (mirror the PhorestStaffMapping ordering above).
  await prisma.phorestAppointment.deleteMany({ where: { employeeId: { in: employeeIds } } });
  // Phase 85.1 — Absence.employee is onDelete: Restrict too (seedVocationalSchoolAbsence above).
  await prisma.absence.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.shift.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.employee.deleteMany({ where: { tenantId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenantConfig.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}
