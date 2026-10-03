/**
 * Issue #468, finding 4 (D-08..D-11, A-1) — route suite for `GET/POST
 * /api/v1/leave/parental-reductions/:leaveRequestId` and `POST .../revoke`.
 *
 * Anchor: an APPROVED `LeaveRequest` of leave-type code `PARENTAL` (A-1 — Elternzeit is a
 * LeaveRequest in this codebase, not an Absence). Fixed dates throughout (no
 * `toISOString().slice(0,10)`-relative literals — this project's documented time-bomb fixture
 * shape); the system clock at the time this suite was written is 2026-10-03, so every fixture
 * year (2026/2027) is inside the real `currentYear..currentYear+1` window
 * `recalcVacationEntitlementsForContractChange` (#450) operates on — load-bearing for the
 * contract-change assertion below. Initials-only names (CLAUDE.md PII rule), own seeded tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { hasHumanVacationWrite } from "../contexts/absence/leave-days";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";

const PASSWORD = "test1234";

describe("Elternzeit-Kürzung (§ 17 Abs. 1 BEEG) — Issue #468, D-08..D-11", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let parentalTypeId: string;
  let vacationTypeId: string;
  let pEmployeeId: string;
  let pLeaveRequestId: string;

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createFixedEmployee(label: string, hireDate: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: "P",
        lastName: "PLR468",
        hireDate: new Date(hireDate),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        validFrom: new Date(hireDate),
      },
    });
    return { user, employee };
  }

  async function seedVacationRow(employeeId: string, leaveTypeId: string, year: number) {
    return app.prisma.leaveEntitlement.create({
      data: { employeeId, leaveTypeId, year, totalDays: 30, usedDays: 0, isAutoCalculated: true },
    });
  }

  function createHome(employeeId: string, salonId: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  /** Same idiom as `leave-decisions-salon-scope.test.ts` (Issue #91). */
  async function createScopedManager(
    label: string,
    permissions: string[],
    scope: { scopeType: "SALONS" | "PERSONS"; salonIds?: string[]; employeeIds?: string[] },
  ) {
    const { user } = await createFixedEmployee(label, "2020-01-01");
    const name = `PLR468 Scope ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
      },
    });
    return { user };
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "plr468");
    vacationTypeId = data.vacationType.id;

    const parentalType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("PARENTAL"), color: "#EC4899" },
    });
    parentalTypeId = parentalType.id;

    const { user: pUser, employee: pEmployee } = await createFixedEmployee("p", "2020-01-01");
    pEmployeeId = pEmployee.id;
    await seedVacationRow(pEmployeeId, vacationTypeId, 2026);
    await seedVacationRow(pEmployeeId, vacationTypeId, 2027);
    void pUser;

    const pRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId: pEmployeeId,
        leaveTypeId: parentalTypeId,
        startDate: new Date("2026-09-15"),
        endDate: new Date("2027-04-10"),
        days: 148,
        status: "APPROVED",
      },
    });
    pLeaveRequestId = pRequest.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("GET preview returns full months, proposed reduction and resulting total per touched year, writing nothing", async () => {
    const token = await login(data.adminUser.email);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/parental-reductions/${pLeaveRequestId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      leaveRequestId: string;
      years: Array<{
        year: number;
        months: number;
        regularDays: number;
        proposedReducedDays: number;
        currentTotalDays: number | null;
        resultingTotalDays: number | null;
        existing: unknown;
        committable: boolean;
      }>;
    };
    expect(body.leaveRequestId).toBe(pLeaveRequestId);
    const y2026 = body.years.find((y) => y.year === 2026);
    const y2027 = body.years.find((y) => y.year === 2027);
    expect(y2026).toMatchObject({
      months: 3,
      regularDays: 30,
      proposedReducedDays: 7,
      currentTotalDays: 30,
      resultingTotalDays: 23,
      existing: null,
      committable: true,
    });
    expect(y2027).toMatchObject({
      months: 3,
      regularDays: 30,
      proposedReducedDays: 7,
      currentTotalDays: 30,
      resultingTotalDays: 23,
      existing: null,
      committable: true,
    });

    // GET is read-only: both rows still 30 afterwards.
    const row2026 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: pEmployeeId,
          leaveTypeId: vacationTypeId,
          year: 2026,
        },
      },
    });
    const row2027 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: pEmployeeId,
          leaveTypeId: vacationTypeId,
          year: 2027,
        },
      },
    });
    expect(Number(row2026!.totalDays)).toBe(30);
    expect(Number(row2027!.totalDays)).toBe(30);
  });

  it("POST commits the 2026 reduction: entitlement reduced, reduction row created, audited, human-owned; 2027 untouched", async () => {
    const token = await login(data.adminUser.email);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${pLeaveRequestId}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ declaredAt: "2026-09-01", years: [2026] }),
    });
    expect(res.statusCode).toBe(201);

    const row2026 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: pEmployeeId,
          leaveTypeId: vacationTypeId,
          year: 2026,
        },
      },
    });
    const row2027 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: pEmployeeId,
          leaveTypeId: vacationTypeId,
          year: 2027,
        },
      },
    });
    expect(Number(row2026!.totalDays)).toBe(23);
    expect(Number(row2027!.totalDays)).toBe(30);

    const reductions = await app.prisma.parentalLeaveReduction.findMany({
      where: { leaveRequestId: pLeaveRequestId, year: 2026 },
    });
    expect(reductions).toHaveLength(1);
    expect(reductions[0]).toMatchObject({
      status: "ACTIVE",
      months: 3,
      createdBy: data.adminUser.id,
    });
    expect(Number(reductions[0].reducedDays)).toBe(7);
    expect(reductions[0].declaredAt.toISOString().slice(0, 10)).toBe("2026-09-01");

    const entitlementAudits = await app.prisma.auditLog.findMany({
      where: { entity: "LeaveEntitlement", entityId: row2026!.id, action: "UPDATE" },
    });
    const ourAudit = entitlementAudits.find(
      (a) => (a.newValue as Record<string, unknown> | null)?.leaveRequestId === pLeaveRequestId,
    );
    expect(ourAudit).toBeTruthy();
    expect(ourAudit!.oldValue).toMatchObject({ totalDays: 30 });
    const newVal = ourAudit!.newValue as Record<string, unknown>;
    expect(newVal.totalDays).toBe(23);
    expect(newVal.months).toBe(3);
    expect(newVal.declaredAt).toBe("2026-09-01");
    expect(Object.keys(newVal)).not.toContain("isAutoCalculated");

    const reductionAudit = await app.prisma.auditLog.findFirst({
      where: {
        entity: "ParentalLeaveReduction",
        entityId: reductions[0].id,
        action: "PARENTAL_LEAVE_REDUCTION_DECLARED",
      },
    });
    expect(reductionAudit).toBeTruthy();

    expect(await hasHumanVacationWrite(app.prisma, row2026!.id)).toBe(true);
  });

  it("a second identical POST for the already-reduced year answers 409 and writes no second row", async () => {
    const token = await login(data.adminUser.email);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${pLeaveRequestId}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ declaredAt: "2026-09-01", years: [2026] }),
    });
    expect(res.statusCode).toBe(409);

    const reductions = await app.prisma.parentalLeaveReduction.findMany({
      where: { leaveRequestId: pLeaveRequestId, year: 2026 },
    });
    expect(reductions).toHaveLength(1);
    const row2026 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: pEmployeeId,
          leaveTypeId: vacationTypeId,
          year: 2026,
        },
      },
    });
    expect(Number(row2026!.totalDays)).toBe(23);
  });

  it("a contract change (PUT /settings/work) leaves the human-owned 2026 row at 23 but recomputes the untouched auto 2027 row to 24", async () => {
    const token = await login(data.adminUser.email);
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${pEmployeeId}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({
        type: "FIXED_SCHEDULE",
        fridayHours: 0,
        weeklyHours: 32,
        validFrom: "2026-07-01",
      }),
    });
    expect(res.statusCode).toBe(200);

    const row2026 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: pEmployeeId,
          leaveTypeId: vacationTypeId,
          year: 2026,
        },
      },
    });
    const row2027 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: pEmployeeId,
          leaveTypeId: vacationTypeId,
          year: 2027,
        },
      },
    });
    expect(Number(row2026!.totalDays)).toBe(23);
    expect(Number(row2027!.totalDays)).toBe(24);
  });

  it("declaredAt in the future -> 400", async () => {
    const token = await login(data.adminUser.email);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${pLeaveRequestId}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ declaredAt: "2099-01-01", years: [2027] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("a requested year with zero full months -> 400", async () => {
    const token = await login(data.adminUser.email);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${pLeaveRequestId}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ declaredAt: "2026-09-01", years: [2030] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("a year without a VACATION row -> 409", async () => {
    const { employee: qEmployee } = await createFixedEmployee("q", "2020-01-01");
    const qRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId: qEmployee.id,
        leaveTypeId: parentalTypeId,
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        days: 365,
        status: "APPROVED",
      },
    });
    const token = await login(data.adminUser.email);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${qRequest.id}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ declaredAt: "2026-09-01", years: [2026] }),
    });
    expect(res.statusCode).toBe(409);
  });

  it("a VACATION request id -> 409 'Nur für Elternzeit-Anträge möglich.'", async () => {
    const token = await login(data.adminUser.email);
    const vacationRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId: pEmployeeId,
        leaveTypeId: vacationTypeId,
        startDate: new Date("2026-05-05"),
        endDate: new Date("2026-05-05"),
        days: 1,
        status: "APPROVED",
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/parental-reductions/${vacationRequest.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "Nur für Elternzeit-Anträge möglich." });
  });

  it("a PENDING PARENTAL request: GET -> 409, POST -> 409", async () => {
    const { employee: rEmployee } = await createFixedEmployee("r", "2020-01-01");
    await seedVacationRow(rEmployee.id, vacationTypeId, 2026);
    const rRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId: rEmployee.id,
        leaveTypeId: parentalTypeId,
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        days: 365,
        status: "PENDING",
      },
    });
    const token = await login(data.adminUser.email);
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/leave/parental-reductions/${rRequest.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(409);
    const postRes = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${rRequest.id}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ declaredAt: "2026-09-01", years: [2026] }),
    });
    expect(postRes.statusCode).toBe(409);
  });

  it("EMPLOYEE token -> 403 on GET and POST", async () => {
    const empToken = await login(data.empUser.email);
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/leave/parental-reductions/${pLeaveRequestId}`,
      headers: { authorization: `Bearer ${empToken}` },
    });
    expect(getRes.statusCode).toBe(403);
    const postRes = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${pLeaveRequestId}`,
      headers: { authorization: `Bearer ${empToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ declaredAt: "2026-09-01", years: [2026] }),
    });
    expect(postRes.statusCode).toBe(403);
  });

  it("a foreign-tenant real PARENTAL leave request and an unknown uuid answer byte-identical 404", async () => {
    const other = await seedTestData(app, "plr468-b");
    try {
      const otherParentalType = await app.prisma.leaveType.create({
        data: { tenantId: other.tenant.id, ...leaveTypeFields("PARENTAL"), color: "#EC4899" },
      });
      const otherRequest = await app.prisma.leaveRequest.create({
        data: {
          employeeId: other.employee.id,
          leaveTypeId: otherParentalType.id,
          startDate: new Date("2026-01-01"),
          endDate: new Date("2026-12-31"),
          days: 365,
          status: "APPROVED",
        },
      });
      const token = await login(data.adminUser.email);
      const foreignRes = await app.inject({
        method: "GET",
        url: `/api/v1/leave/parental-reductions/${otherRequest.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      const unknownRes = await app.inject({
        method: "GET",
        url: `/api/v1/leave/parental-reductions/00000000-0000-0000-0000-000000000000`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(foreignRes.statusCode).toBe(404);
      expect(unknownRes.statusCode).toBe(404);
      expect(foreignRes.body).toBe(unknownRes.body);
      expect(JSON.parse(foreignRes.body)).toEqual({ error: "Antrag nicht gefunden" });
    } finally {
      await cleanupTestData(app, other.tenant.id);
    }
  });

  // ── Task 2 (D-10/D-11): revocation, T-100-09/scope sweep for all three routes, 12-month case ──

  it("revoke restores the 2026 entitlement by the stored reducedDays, audits both rows, never deletes the reduction row", async () => {
    const token = await login(data.adminUser.email);
    const row2026Before = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: pEmployeeId,
          leaveTypeId: vacationTypeId,
          year: 2026,
        },
      },
    });
    expect(Number(row2026Before!.totalDays)).toBe(23);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${pLeaveRequestId}/revoke`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ year: 2026, reason: "Erklärung zurückgenommen" }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; totalDays: number };
    expect(body.status).toBe("REVOKED");
    expect(body.totalDays).toBe(30);

    const row2026After = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: pEmployeeId,
          leaveTypeId: vacationTypeId,
          year: 2026,
        },
      },
    });
    expect(Number(row2026After!.totalDays)).toBe(30);

    const reductions = await app.prisma.parentalLeaveReduction.findMany({
      where: { leaveRequestId: pLeaveRequestId, year: 2026 },
    });
    expect(reductions).toHaveLength(1); // never deleted
    expect(reductions[0].status).toBe("REVOKED");
    expect(reductions[0].revokedAt).toBeTruthy();
    expect(reductions[0].revokedBy).toBe(data.adminUser.id);

    // Both the commit-time AND the revoke-time audit reference the same reductionId in
    // newValue — order by createdAt desc to get the latest (the revoke) one.
    const entitlementAudit = await app.prisma.auditLog.findFirst({
      where: {
        entity: "LeaveEntitlement",
        entityId: row2026After!.id,
        action: "UPDATE",
        newValue: { path: ["parentalLeaveReductionId"], equals: reductions[0].id },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(entitlementAudit).toBeTruthy();
    expect(entitlementAudit!.oldValue).toMatchObject({ totalDays: 23 });
    expect((entitlementAudit!.newValue as Record<string, unknown>).totalDays).toBe(30);

    const revocationAudit = await app.prisma.auditLog.findFirst({
      where: {
        entity: "ParentalLeaveReduction",
        entityId: reductions[0].id,
        action: "PARENTAL_LEAVE_REDUCTION_REVOKED",
      },
    });
    expect(revocationAudit).toBeTruthy();
    expect(revocationAudit!.oldValue).toMatchObject({ status: "ACTIVE" });
  });

  it("a second revoke of the same reduction -> 409 'Die Kürzung ist bereits widerrufen.'", async () => {
    const token = await login(data.adminUser.email);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${pLeaveRequestId}/revoke`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ year: 2026, reason: "Erklärung zurückgenommen" }),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "Die Kürzung ist bereits widerrufen." });
  });

  it("revoke for a year with no declared reduction -> 404 'Keine Kürzung für {year} erklärt.'", async () => {
    const token = await login(data.adminUser.email);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${pLeaveRequestId}/revoke`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ year: 2027, reason: "Keine Kürzung vorhanden" }),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Keine Kürzung für 2027 erklärt." });
  });

  it("re-committing a REVOKED year -> 409 naming the revoked declaration (D-09 limit)", async () => {
    const token = await login(data.adminUser.email);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${pLeaveRequestId}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ declaredAt: "2026-09-01", years: [2026] }),
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toContain("bereits eine Kürzung erklärt");
    expect(body.error).toContain("widerrufen am");
  });

  it("revoke restores by the STORED reducedDays even after a manual PUT /settings/vacation edit in between", async () => {
    const { employee: sEmployee } = await createFixedEmployee("s", "2020-01-01");
    await seedVacationRow(sEmployee.id, vacationTypeId, 2029);
    const sRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId: sEmployee.id,
        leaveTypeId: parentalTypeId,
        startDate: new Date("2029-01-01"),
        endDate: new Date("2029-04-30"),
        days: 120,
        status: "APPROVED",
      },
    });
    const token = await login(data.adminUser.email);

    const commitRes = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${sRequest.id}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ declaredAt: "2026-09-01", years: [2029] }),
    });
    expect(commitRes.statusCode).toBe(201);
    const rowAfterCommit = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: sEmployee.id,
          leaveTypeId: vacationTypeId,
          year: 2029,
        },
      },
    });
    expect(Number(rowAfterCommit!.totalDays)).toBe(20); // 30 - parentalLeaveReducedDays(30, 4) = 30-20

    const reduction = await app.prisma.parentalLeaveReduction.findUniqueOrThrow({
      where: { leaveRequestId_year: { leaveRequestId: sRequest.id, year: 2029 } },
    });
    expect(Number(reduction.reducedDays)).toBe(10);

    // Manual edit in between — an admin raises the total to 25 (still >= statutory minimum).
    const editRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${sEmployee.id}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ year: 2029, totalDays: 25 }),
    });
    expect(editRes.statusCode).toBe(200);

    const revokeRes = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${sRequest.id}/revoke`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ year: 2029, reason: "Fehlbuchung korrigiert" }),
    });
    expect(revokeRes.statusCode).toBe(200);

    const rowAfterRevoke = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: sEmployee.id,
          leaveTypeId: vacationTypeId,
          year: 2029,
        },
      },
    });
    // 25 (the edited value) + 10 (the STORED reducedDays, not a recomputation) = 35.
    expect(Number(rowAfterRevoke!.totalDays)).toBe(35);
  });

  it("a 12-month Elternzeit reduces the entitlement to 0, which survives the #445 zero-placeholder heal and the #450 contract-change recompute", async () => {
    const { employee: tEmployee } = await createFixedEmployee("t", "2020-01-01");
    await seedVacationRow(tEmployee.id, vacationTypeId, 2027);
    const tRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId: tEmployee.id,
        leaveTypeId: parentalTypeId,
        startDate: new Date("2027-01-01"),
        endDate: new Date("2027-12-31"),
        days: 365,
        status: "APPROVED",
      },
    });
    const token = await login(data.adminUser.email);

    const commitRes = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${tRequest.id}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ declaredAt: "2026-09-01", years: [2027] }),
    });
    expect(commitRes.statusCode).toBe(201);

    const rowAfterCommit = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: tEmployee.id,
          leaveTypeId: vacationTypeId,
          year: 2027,
        },
      },
    });
    expect(Number(rowAfterCommit!.totalDays)).toBe(0);

    // #445 zero-placeholder heal: GET /settings/vacation must NOT heal this row back up.
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${tEmployee.id}?year=2027`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect((JSON.parse(getRes.body) as { totalDays: number }).totalDays).toBe(0);

    // #450 contract-change recompute (validFrom inside the recompute range) must also skip it.
    const putRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${tEmployee.id}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({
        type: "FIXED_SCHEDULE",
        fridayHours: 0,
        weeklyHours: 32,
        validFrom: "2027-03-01",
      }),
    });
    expect(putRes.statusCode).toBe(200);

    const rowAfterContractChange = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: tEmployee.id,
          leaveTypeId: vacationTypeId,
          year: 2027,
        },
      },
    });
    expect(Number(rowAfterContractChange!.totalDays)).toBe(0);
  });

  describe("T-100-09 sweep for POST commit and POST revoke (foreign tenant vs. unknown id, byte-identical)", () => {
    it("POST /:leaveRequestId", async () => {
      const other = await seedTestData(app, "plr468-c1");
      try {
        const otherParentalType = await app.prisma.leaveType.create({
          data: { tenantId: other.tenant.id, ...leaveTypeFields("PARENTAL"), color: "#EC4899" },
        });
        const otherRequest = await app.prisma.leaveRequest.create({
          data: {
            employeeId: other.employee.id,
            leaveTypeId: otherParentalType.id,
            startDate: new Date("2026-01-01"),
            endDate: new Date("2026-12-31"),
            days: 365,
            status: "APPROVED",
          },
        });
        const token = await login(data.adminUser.email);
        const payload = JSON.stringify({ declaredAt: "2026-09-01", years: [2026] });
        const foreignRes = await app.inject({
          method: "POST",
          url: `/api/v1/leave/parental-reductions/${otherRequest.id}`,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          payload,
        });
        const unknownRes = await app.inject({
          method: "POST",
          url: `/api/v1/leave/parental-reductions/11111111-1111-4111-8111-111111111111`,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          payload,
        });
        expect(foreignRes.statusCode).toBe(404);
        expect(foreignRes.body).toBe(unknownRes.body);

        const foreignAudits = await app.prisma.auditLog.count({
          where: { action: "CROSS_TENANT_ACCESS_DENIED", entityId: otherRequest.id },
        });
        expect(foreignAudits).toBe(1);
        const unknownAudits = await app.prisma.auditLog.count({
          where: {
            action: "CROSS_TENANT_ACCESS_DENIED",
            entityId: "11111111-1111-4111-8111-111111111111",
          },
        });
        expect(unknownAudits).toBe(0);
      } finally {
        await cleanupTestData(app, other.tenant.id);
      }
    });

    it("POST /:leaveRequestId/revoke", async () => {
      const other = await seedTestData(app, "plr468-c2");
      try {
        const otherParentalType = await app.prisma.leaveType.create({
          data: { tenantId: other.tenant.id, ...leaveTypeFields("PARENTAL"), color: "#EC4899" },
        });
        const otherRequest = await app.prisma.leaveRequest.create({
          data: {
            employeeId: other.employee.id,
            leaveTypeId: otherParentalType.id,
            startDate: new Date("2026-01-01"),
            endDate: new Date("2026-12-31"),
            days: 365,
            status: "APPROVED",
          },
        });
        const token = await login(data.adminUser.email);
        const payload = JSON.stringify({ year: 2026, reason: "T-100-09 Probe" });
        const foreignRes = await app.inject({
          method: "POST",
          url: `/api/v1/leave/parental-reductions/${otherRequest.id}/revoke`,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          payload,
        });
        const unknownRes = await app.inject({
          method: "POST",
          url: `/api/v1/leave/parental-reductions/22222222-2222-4222-8222-222222222222/revoke`,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          payload,
        });
        expect(foreignRes.statusCode).toBe(404);
        expect(foreignRes.body).toBe(unknownRes.body);
      } finally {
        await cleanupTestData(app, other.tenant.id);
      }
    });
  });

  it("a SALONS-scoped manager sees a Stammsalon-B employee's request identically to an unknown id, but a Stammsalon-A employee's request succeeds", async () => {
    const salonA = await app.prisma.salon.create({
      data: {
        tenantId: data.tenant.id,
        name: "PLR468 Salon A",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
        federalState: "NIEDERSACHSEN",
      },
    });
    const salonB = await app.prisma.salon.create({
      data: {
        tenantId: data.tenant.id,
        name: "PLR468 Salon B",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
        federalState: "NIEDERSACHSEN",
      },
    });
    const { employee: uEmployee } = await createFixedEmployee("u", "2020-01-01");
    await createHome(uEmployee.id, salonB.id);
    await seedVacationRow(uEmployee.id, vacationTypeId, 2026);
    const uRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId: uEmployee.id,
        leaveTypeId: parentalTypeId,
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        days: 365,
        status: "APPROVED",
      },
    });

    const { employee: vEmployee } = await createFixedEmployee("v", "2020-01-01");
    await createHome(vEmployee.id, salonA.id);
    await seedVacationRow(vEmployee.id, vacationTypeId, 2026);
    const vRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId: vEmployee.id,
        leaveTypeId: parentalTypeId,
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        days: 365,
        status: "APPROVED",
      },
    });

    const { user: scopedUser } = await createScopedManager(
      "plr468mgr",
      ["leave-entitlement:update:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const scopedToken = await login(scopedUser.email);

    const outOfScopeRes = await app.inject({
      method: "GET",
      url: `/api/v1/leave/parental-reductions/${uRequest.id}`,
      headers: { authorization: `Bearer ${scopedToken}` },
    });
    const unknownRes = await app.inject({
      method: "GET",
      url: `/api/v1/leave/parental-reductions/33333333-3333-4333-8333-333333333333`,
      headers: { authorization: `Bearer ${scopedToken}` },
    });
    expect(outOfScopeRes.statusCode).toBe(404);
    expect(outOfScopeRes.body).toBe(unknownRes.body);

    const scopeAudits = await app.prisma.auditLog.count({
      where: { action: "SCOPE_ACCESS_DENIED", entityId: uRequest.id },
    });
    expect(scopeAudits).toBe(1);

    const inScopeRes = await app.inject({
      method: "GET",
      url: `/api/v1/leave/parental-reductions/${vRequest.id}`,
      headers: { authorization: `Bearer ${scopedToken}` },
    });
    expect(inScopeRes.statusCode).toBe(200);
  });

  it("a manager WITHOUT leave-entitlement:update -> 403 on all three routes", async () => {
    const { user: noPermUser } = await createScopedManager(
      "plr468noperm",
      ["leave-request:approve:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [] },
    );
    const noPermToken = await login(noPermUser.email);

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/leave/parental-reductions/${pLeaveRequestId}`,
      headers: { authorization: `Bearer ${noPermToken}` },
    });
    expect(getRes.statusCode).toBe(403);

    const postRes = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${pLeaveRequestId}`,
      headers: { authorization: `Bearer ${noPermToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ declaredAt: "2026-09-01", years: [2026] }),
    });
    expect(postRes.statusCode).toBe(403);

    const revokeRes = await app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${pLeaveRequestId}/revoke`,
      headers: { authorization: `Bearer ${noPermToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ year: 2026, reason: "ohne Berechtigung" }),
    });
    expect(revokeRes.statusCode).toBe(403);
  });
});
