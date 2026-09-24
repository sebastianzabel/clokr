/**
 * Phase 74b code review, WR-05 — the batch anonymizer records the role assignments it removes.
 *
 * `anonymizeEmployeeData` hard-deletes every `RoleAssignment` of the anonymized user (D-22) and
 * returns the removed rows. The route audits each one; the batch script used to discard them, so
 * the deletions left no audit trace. This file exercises the script's exported helpers against the
 * test database: the sweep must collect the removed rows, and the ANONYMIZATION_RUN summary must
 * list them.
 *
 * Importing `../anonymize-dump` is side-effect-free (run-guard) — it opens no connection and
 * anonymizes nothing by itself. The sweep here only ever touches this file's own fixture employee.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import { roleNameKey, normalizeRolePermissions } from "../../src/contexts/platform/access-role";
import { anonymizeEmployeesForRun, buildRunSummary } from "../anonymize-dump";

const ROW_COUNTS = {
  timeEntries: 0,
  leaveRequests: 0,
  absences: 0,
  schedules: 0,
  overtimeAccounts: 0,
};

describe("anonymize-dump records removed role assignments (Phase 74b review, WR-05)", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenant = await seedTestData(app, "74b-anon-dump");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenant.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("the sweep collects every assignment anonymizeEmployeeData removed, and the run summary lists them with their D-12 values", async () => {
    const suffix = crypto.randomBytes(4).toString("hex");
    const user = await app.prisma.user.create({
      data: {
        email: `anon-dump-${suffix}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: tenant.tenant.id,
        userId: user.id,
        employeeNumber: `AD-${suffix}`,
        firstName: "Stapellauf",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    const roleName = `Stapelrolle ${suffix}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: tenant.tenant.id,
        name: roleName,
        nameKey: roleNameKey(roleName),
        permissions: normalizeRolePermissions(["time-entry:read:ZUGEWIESEN"]),
      },
    });
    const tenantWide = await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenant.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    const personScoped = await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenant.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: "PERSONS",
        salonIds: [],
        employeeIds: [tenant.employee.id],
      },
    });

    const batch = await anonymizeEmployeesForRun(app.prisma, [employee.id]);

    expect(batch.failedEmployeeId).toBeNull();
    expect(batch.anonymizedCount).toBe(1);
    expect(await app.prisma.roleAssignment.count({ where: { userId: user.id } })).toBe(0);
    const expectedRows = [tenantWide, personScoped].map((row) => ({
      id: row.id,
      userId: user.id,
      accessRoleId: role.id,
      roleName,
      scopeType: row.scopeType,
      salonIds: row.salonIds,
      employeeIds: row.employeeIds,
    }));
    expect(batch.removedRoleAssignments).toEqual(expectedRows);

    const summary = buildRunSummary({
      sourceRowCounts: ROW_COUNTS,
      targetRowCounts: ROW_COUNTS,
      durationMs: 1,
      batch,
    });
    expect(summary.removedRoleAssignmentCount).toBe(2);
    expect(summary.removedRoleAssignments).toEqual(expectedRows);
    expect(summary.error).toBeUndefined();
  });

  it("a failed employee stops the sweep and contributes no removed assignment (its transaction rolled back)", async () => {
    const unknownEmployeeId = "00000000-0000-4000-8000-000000000574";

    const batch = await anonymizeEmployeesForRun(app.prisma, [unknownEmployeeId]);

    expect(batch.anonymizedCount).toBe(0);
    expect(batch.failedEmployeeId).toBe(unknownEmployeeId);
    expect(batch.removedRoleAssignments).toEqual([]);
    const summary = buildRunSummary({
      sourceRowCounts: ROW_COUNTS,
      targetRowCounts: ROW_COUNTS,
      durationMs: 1,
      batch,
    });
    expect(summary.removedRoleAssignmentCount).toBe(0);
    expect(summary.error).toContain(unknownEmployeeId);
  });
});
