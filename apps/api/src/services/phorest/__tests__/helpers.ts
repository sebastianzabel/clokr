// Phase 85 — test seed/cleanup for the Phorest shift sync.
//
// Seeds a tenant + TenantConfig (with Phorest creds) + two employees + ONE PhorestStaffMapping.
// The staffId literals below MUST match fixtures/staff.json and fixtures/worktimetables.json.
//
// The unmapped employee (Max) has the SAME name + email as staff.json's "ph-staff-unmapped"
// but deliberately gets NO PhorestStaffMapping — this is the SS-01 negative-match fixture:
// the sync must ignore implicit name/email matching and rely only on explicit mapping.

import type { FastifyInstance } from "fastify";
import { vi } from "vitest";
import { leaveTypeFields } from "../../../contexts/absence/leave-type";
import { createTestSalon } from "../../../__tests__/setup"; // Phase 325 (issue #325), D-17
import type { PhorestSyncTarget } from "../types";
import staffFixture from "./fixtures/staff.json";

export const MAPPED_STAFF_ID = "ph-staff-mapped";
export const UNMAPPED_STAFF_ID = "ph-staff-unmapped";
// Phase 85.1.1 (D-02/D-05) — a SECOND genuinely-mapped employee for the two-mapped-same-run test.
// Do NOT repurpose Max/UNMAPPED_STAFF_ID — that fixture guards the SS-01 negative-match test.
export const MAPPED_STAFF_ID_2 = "ph-staff-mapped-2";
// Phase 65b (issue #65, D-23): the branch id of the seed salon's PHOREST coupling.
export const DEFAULT_TEST_BRANCH_ID = "branch-1";

export interface PhorestSeed {
  tenantId: string;
  mappedEmployeeId: string; // Erika — has a PhorestStaffMapping
  unmappedEmployeeId: string; // Max — name/email matches staff.json but NO mapping (SS-01)
  mappedEmployeeId2: string; // Bea — a second genuinely-mapped employee (85.1.1 two-mapped tests)
  salonId: string; // Phase 325 (issue #325), D-17 — the tenant's default salon
  // Phase 65b (issue #65, D-23): the seed salon's coupling as a sync target (branch-1).
  target: PhorestSyncTarget;
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
      phorestUsername: "user@salon.de",
      phorestPassword: "secret-pw", // decryptSafe tolerates plaintext
      phorestSyncWindowDays: 7,
    },
  });

  // Phase 325 (issue #325), D-17: the required Shift/PhorestAppointment salonId FK needs this
  // tenant's default salon — created right after TenantConfig, mirroring seedTestData's own order.
  const salon = await createTestSalon(prisma, tenant.id, { name: tenant.name });
  // Phase 65b (issue #65, D-23): the branch lives on the salon's coupling, not on TenantConfig.
  await prisma.salonCoupling.create({
    data: {
      tenantId: tenant.id,
      salonId: salon.id,
      provider: "PHOREST",
      externalBranchId: DEFAULT_TEST_BRANCH_ID,
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
    salonId: salon.id,
    target: { salonId: salon.id, externalBranchId: DEFAULT_TEST_BRANCH_ID },
  };
}

/**
 * Phase 65b (issue #65): add a further salon to a seeded tenant plus its PHOREST coupling to
 * `externalBranchId`. Default `createdAt` = now + 60 s so it sorts AFTER the seed's salon in
 * listSalons order; `isActive: false` creates a deactivated (but coupled) salon.
 */
export async function addCoupledSalon(
  app: FastifyInstance,
  tenantId: string,
  externalBranchId: string,
  overrides?: { name?: string; isActive?: boolean; createdAt?: Date },
): Promise<{ salonId: string; target: PhorestSyncTarget }> {
  const salon = await createTestSalon(app.prisma, tenantId, {
    name: overrides?.name ?? `Salon ${externalBranchId}`,
    isActive: overrides?.isActive,
    createdAt: overrides?.createdAt ?? new Date(Date.now() + 60_000),
  });
  await app.prisma.salonCoupling.create({
    data: { tenantId, salonId: salon.id, provider: "PHOREST", externalBranchId },
  });
  return { salonId: salon.id, target: { salonId: salon.id, externalBranchId } };
}

export interface PhorestBranchRoute {
  staff?: unknown;
  worktimetables?: unknown;
  appointments?: unknown;
  status?: number; // when set, EVERY request to this branch answers this (non-ok) status
}

const EMPTY_WORKTIMETABLES = {
  _embedded: { workTimeTables: [] },
  page: { size: 200, totalElements: 0, totalPages: 1, number: 0 },
};
const EMPTY_APPOINTMENTS = {
  _embedded: { appointments: [] },
  page: { size: 200, totalElements: 0, totalPages: 1, number: 0 },
};

/**
 * Phase 65b (issue #65): a per-branch Phorest fetch mock. The branch id is parsed from
 * `/branch/<id>/` in the URL; the route answers `status` when given, else the worktimetable body
 * for worktimetable URLs, the appointment body for `/appointment`, otherwise the staff body.
 * Every requested URL is appended to the returned array FIRST; an unknown branch id then THROWS
 * (phorestFetch turns that into a NETWORK error on the run), so a fetch for an uncoupled or
 * inactive salon is visible both in the URL list and as an unexpected run row.
 */
export function mockPhorestByBranch(routes: Record<string, PhorestBranchRoute>): string[] {
  const requested: string[] = [];
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = url.toString();
    requested.push(u);
    const branch = /\/branch\/([^/]+)\//.exec(u)?.[1];
    const route = branch !== undefined ? routes[branch] : undefined;
    if (!route) throw new Error(`mockPhorestByBranch: unknown branch in ${u}`);
    if (route.status !== undefined) {
      return new Response("upstream unavailable", { status: route.status });
    }
    let body: unknown;
    if (u.includes("worktimetable")) body = route.worktimetables ?? EMPTY_WORKTIMETABLES;
    else if (u.includes("/appointment")) body = route.appointments ?? EMPTY_APPOINTMENTS;
    else body = route.staff ?? staffFixture;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return requested;
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

// Phase 95 (SHIFT-02) — seed a (multi-day) LeaveRequest for the pending-leave-protection tests.
// LeaveRequest.leaveTypeId is required (schema.prisma, onDelete: Restrict), so we find-or-create a
// minimal "Urlaub" LeaveType for the tenant first (reusing the @@unique([tenantId, name])).
// `startStr`/`endStr` are inclusive "yyyy-MM-dd" (LeaveRequest.startDate/endDate are @db.Date).
export async function seedPendingLeaveRequest(
  app: FastifyInstance,
  employeeId: string,
  startStr: string,
  endStr: string,
  status: "PENDING" | "CANCELLATION_REQUESTED" | "APPROVED" = "PENDING",
  deletedAt: Date | null = null,
): Promise<void> {
  const prisma = app.prisma;
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { tenantId: true },
  });
  if (!emp) throw new Error(`seedPendingLeaveRequest: employee ${employeeId} not found`);

  // LeaveRequest.leaveTypeId is required (schema.prisma, onDelete: Restrict), so we find-or-create
  // a minimal vacation LeaveType for the tenant first. Phase 97: resolved by code, not by name.
  let leaveType = await prisma.leaveType.findFirst({
    where: { tenantId: emp.tenantId, code: "VACATION" },
  });
  if (!leaveType) {
    leaveType = await prisma.leaveType.create({
      data: { tenantId: emp.tenantId, ...leaveTypeFields("VACATION") },
    });
  }

  const start = new Date(startStr);
  const end = new Date(endStr);
  // Inclusive calendar-day span (UTC midnight @db.Date → exact day arithmetic).
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;

  await prisma.leaveRequest.create({
    data: {
      employeeId,
      leaveTypeId: leaveType.id,
      startDate: start,
      endDate: end,
      days,
      status,
      deletedAt,
      createdAt: new Date(),
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
  // Phase 95 — LeaveRequest.employee + LeaveRequest.leaveType are BOTH onDelete: Restrict, so the
  // requests must be removed before the employees, and the LeaveType before the tenant.
  await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.leaveType.deleteMany({ where: { tenantId } });
  await prisma.shift.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.employee.deleteMany({ where: { tenantId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenantConfig.deleteMany({ where: { tenantId } });
  // Phase 65b (issue #65): SalonCoupling -> Salon is onDelete: Restrict (the runs, also Restrict
  // onto Salon, are already gone above), so the couplings go before the salons.
  await prisma.salonCoupling.deleteMany({ where: { tenantId } });
  // Phase 325 (issue #325): Shift/PhorestAppointment -> Salon is onDelete: Restrict, so the salon
  // must be removed after those deletes above and before the tenant delete below.
  await prisma.salon.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}
