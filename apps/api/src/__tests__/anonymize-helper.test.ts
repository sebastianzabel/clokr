/**
 * Unit test for the extracted anonymizeEmployeeData helper.
 *
 * Exercises the helper directly (no HTTP route involved) to lock down the
 * DSGVO transformation contract. The route's test in employees.test.ts
 * remains the route-level smoke; THIS test pins the helper's behavior in
 * isolation so the batch script (anonymize-dump.ts) can rely on it.
 *
 * Assertions (per CLAUDE.md "DSGVO Employee Deletion = Anonymization"):
 *   1. Employee PII anonymized (firstName=Gelöscht, lastName=GELÖSCHT-XXX,
 *      nfcCardId=null)
 *   2. User deactivated + anonymized (email anonymized, passwordHash=ANONYMIZED,
 *      isActive=false)
 *   3. TimeEntry/LeaveRequest/Absence notes → null
 *   4. Absence documentPath → null
 *   5. Invitation/OtpToken/RefreshToken rows hard-deleted
 *   6. AuditLog rows for that userId → userId=null
 *   7. Retention-relevant row counts unchanged
 *      (TimeEntry, LeaveRequest, Absence, Schedule, OvertimeAccount)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { anonymizeEmployeeData } from "../utils/anonymize";

describe("anonymizeEmployeeData (helper)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  let employeeId: string;
  let userId: string;
  let timeEntryId: string;
  let leaveRequestId: string;
  let absenceId: string;
  let invitationId: string;
  let otpTokenId: string;
  let refreshTokenId: string;
  let auditLogId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "anon-helper");

    // Build one fully-loaded throwaway employee within the test tenant.
    const suffix = crypto.randomUUID().slice(0, 8);

    const user = await app.prisma.user.create({
      data: {
        email: `anon-target-${suffix}@test.local`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    userId = user.id;

    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId,
        firstName: "Max",
        lastName: "Mustermann",
        employeeNumber: `ANON-${suffix}`,
        hireDate: new Date("2024-01-01"),
        nfcCardId: `nfc-${suffix}`,
      },
    });
    employeeId = employee.id;

    // Sample TimeEntry with a non-null note
    const te = await app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date("2025-06-15"),
        startTime: new Date("2025-06-15T08:00:00Z"),
        endTime: new Date("2025-06-15T16:00:00Z"),
        note: "Persönliche Notiz mit PII",
      },
    });
    timeEntryId = te.id;

    // Sample LeaveRequest with a non-null note
    const lr = await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2025-07-01"),
        endDate: new Date("2025-07-05"),
        days: 5,
        status: "PENDING",
        note: "Krank gemeldet — vertraulich",
      },
    });
    leaveRequestId = lr.id;

    // Sample Absence with note + documentPath
    const ab = await app.prisma.absence.create({
      data: {
        employeeId,
        type: "SICK",
        startDate: new Date("2025-08-01"),
        endDate: new Date("2025-08-03"),
        days: 3,
        note: "Krankenhausaufenthalt",
        documentPath: `attests/2025/${suffix}.pdf`,
        createdBy: data.adminUser.id,
      },
    });
    absenceId = ab.id;

    // Schedule (WorkSchedule) — retention-relevant, must not be deleted
    await app.prisma.workSchedule.create({
      data: {
        employeeId,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });

    // OvertimeAccount — retention-relevant
    await app.prisma.overtimeAccount.create({
      data: { employeeId, balanceHours: 0 },
    });

    // Invitation
    const inv = await app.prisma.invitation.create({
      data: {
        employeeId,
        email: user.email,
        token: `inv-token-${suffix}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    invitationId = inv.id;

    // OtpToken
    const otp = await app.prisma.otpToken.create({
      data: {
        userId,
        code: await bcrypt.hash("123456", 10),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    otpTokenId = otp.id;

    // RefreshToken
    const rt = await app.prisma.refreshToken.create({
      data: {
        userId,
        token: `rt-${suffix}`,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });
    refreshTokenId = rt.id;

    // AuditLog owned by the target user (will be anonymized to userId=null)
    const log = await app.prisma.auditLog.create({
      data: {
        userId,
        action: "LOGIN",
        entity: "User",
        entityId: userId,
      },
    });
    auditLogId = log.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("anonymize-helper test cleanup failed:", err);
    }
  });

  it("anonymizes Employee PII (firstName, lastName, employeeNumber, nfcCardId) and preserves retention row counts", async () => {
    // Snapshot row counts before — assertions cover the test target only,
    // so we count for the target's employeeId/userId. Helper does NOT touch
    // other employees, so global counts would also work but per-employee
    // is a tighter assertion.
    const before = await collectCounts(app, employeeId, userId);

    await app.prisma.$transaction(async (tx) => {
      await anonymizeEmployeeData({ tx, employeeId });
    });

    // (1) Employee PII anonymized
    const emp = await app.prisma.employee.findUnique({ where: { id: employeeId } });
    expect(emp).not.toBeNull();
    expect(emp!.firstName).toBe("Gelöscht");
    expect(emp!.lastName).toMatch(/^GELÖSCHT-/);
    expect(emp!.employeeNumber).toMatch(/^GELÖSCHT-/);
    expect(emp!.nfcCardId).toBeNull();

    // (2) User deactivated + anonymized
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    expect(user).not.toBeNull();
    expect(user!.email).toMatch(/^deleted-[a-f0-9-]+@anonymized\.local$/);
    expect(user!.passwordHash).toBe("ANONYMIZED");
    expect(user!.isActive).toBe(false);

    // (3) Notes nulled
    const te = await app.prisma.timeEntry.findUnique({ where: { id: timeEntryId } });
    expect(te).not.toBeNull();
    expect(te!.note).toBeNull();

    const lr = await app.prisma.leaveRequest.findUnique({ where: { id: leaveRequestId } });
    expect(lr).not.toBeNull();
    expect(lr!.note).toBeNull();

    // (4) Absence note + documentPath nulled
    const ab = await app.prisma.absence.findUnique({ where: { id: absenceId } });
    expect(ab).not.toBeNull();
    expect(ab!.note).toBeNull();
    expect(ab!.documentPath).toBeNull();

    // (5) Auth tokens hard-deleted
    expect(await app.prisma.invitation.findUnique({ where: { id: invitationId } })).toBeNull();
    expect(await app.prisma.otpToken.findUnique({ where: { id: otpTokenId } })).toBeNull();
    expect(await app.prisma.refreshToken.findUnique({ where: { id: refreshTokenId } })).toBeNull();

    // (6) AuditLog row for that user → userId=null
    const log = await app.prisma.auditLog.findUnique({ where: { id: auditLogId } });
    expect(log).not.toBeNull();
    expect(log!.userId).toBeNull();

    // (7) Retention row counts unchanged (rows mutated in place, never deleted)
    const after = await collectCounts(app, employeeId, userId);
    expect(after.timeEntries).toBe(before.timeEntries);
    expect(after.leaveRequests).toBe(before.leaveRequests);
    expect(after.absences).toBe(before.absences);
    expect(after.schedules).toBe(before.schedules);
    expect(after.overtimeAccounts).toBe(before.overtimeAccounts);
  });

  /**
   * PII-residue tests (COMP-V1814-01)
   *
   * Proves all four residual PII vectors are eliminated after DSGVO anonymization:
   *   1. AuditLog oldValue/newValue JSON no longer contains the real email/name
   *   2. The ANONYMIZE audit row itself stores no clear-text email
   *   3. Notification.title/message → "ANONYMIZED"
   *   4. MinIO avatar + absence-document objects deleted (app.storage.delete spy)
   *
   * Uses the HTTP DELETE /:id route (not the bare helper) so that the MinIO
   * deletion path in employees.ts is also exercised.
   */
  describe("anonymize PII", () => {
    let piiEmployeeId: string;
    let piiUserId: string;
    let piiNotificationId: string;
    let piiRealEmail: string;
    let piiAvatarPath: string;
    let piiDocPath: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let deleteSpy: ReturnType<typeof vi.spyOn<any, "delete">>;

    beforeAll(async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      piiRealEmail = `pii-${suffix}@test.local`;
      piiAvatarPath = `avatars/pii/${suffix}.webp`;
      piiDocPath = `attests/pii/${suffix}.pdf`;

      // Create user + employee with PII
      const user = await app.prisma.user.create({
        data: {
          email: piiRealEmail,
          passwordHash: await bcrypt.hash("test1234", 10),
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      piiUserId = user.id;

      const employee = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: piiUserId,
          firstName: "Max",
          lastName: "Mustermann",
          employeeNumber: `PII-${suffix}`,
          hireDate: new Date("2024-01-01"),
          avatarPath: piiAvatarPath,
        },
      });
      piiEmployeeId = employee.id;

      // OvertimeAccount (required by findUnique include in DELETE route)
      await app.prisma.overtimeAccount.create({
        data: { employeeId: piiEmployeeId, balanceHours: 0 },
      });

      // Prior AuditLog row with PII in oldValue (entity=Employee) — the main PII vector
      await app.prisma.auditLog.create({
        data: {
          userId: piiUserId,
          action: "CREATE",
          entity: "Employee",
          entityId: piiEmployeeId,
          oldValue: { email: piiRealEmail, name: "Max Mustermann" },
          newValue: { email: piiRealEmail },
        },
      });

      // Notification with real name in title/message
      const notif = await app.prisma.notification.create({
        data: {
          userId: piiUserId,
          type: "LEAVE_REQUEST",
          title: `Hallo Max Mustermann (${piiRealEmail})`,
          message: `Ihr Antrag wurde bearbeitet — ${piiRealEmail}`,
        },
      });
      piiNotificationId = notif.id;

      // Absence with documentPath (pre-fetched + deleted by route after tx)
      await app.prisma.absence.create({
        data: {
          employeeId: piiEmployeeId,
          type: "SICK",
          startDate: new Date("2025-09-01"),
          endDate: new Date("2025-09-03"),
          days: 3,
          documentPath: piiDocPath,
          createdBy: data.adminUser.id,
        },
      });

      // Spy on app.storage.delete — prevents live MinIO calls and lets us assert paths
      deleteSpy = vi.spyOn(app.storage, "delete").mockResolvedValue(undefined);

      // Trigger anonymization via the HTTP route (exercises helper + MinIO deletion)
      await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${piiEmployeeId}`,
        headers: { Authorization: `Bearer ${data.adminToken}` },
      });
    });

    afterAll(() => {
      deleteSpy.mockRestore();
    });

    it("no AuditLog row for the employee retains clear-text email after anonymize PII", async () => {
      const rows = await app.prisma.auditLog.findMany({
        where: {
          OR: [
            { entity: "Employee", entityId: piiEmployeeId },
            { entity: "User", entityId: piiUserId },
          ],
        },
      });
      for (const row of rows) {
        const serialized =
          JSON.stringify(row.oldValue ?? "") + " " + JSON.stringify(row.newValue ?? "");
        expect(serialized).not.toContain(piiRealEmail);
      }
    });

    it("ANONYMIZE audit row stores no clear-text email after anonymize PII", async () => {
      const rows = await app.prisma.auditLog.findMany({
        where: { entity: "Employee", entityId: piiEmployeeId, action: "ANONYMIZE" },
      });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        const serialized =
          JSON.stringify(row.oldValue ?? "") + " " + JSON.stringify(row.newValue ?? "");
        expect(serialized).not.toContain(piiRealEmail);
      }
    });

    it("Notification title and message are ANONYMIZED after anonymize PII", async () => {
      const notif = await app.prisma.notification.findUnique({
        where: { id: piiNotificationId },
      });
      expect(notif).not.toBeNull();
      expect(notif!.title).toBe("ANONYMIZED");
      expect(notif!.message).toBe("ANONYMIZED");
    });

    it("app.storage.delete called for avatar and absence doc paths after anonymize PII", () => {
      expect(deleteSpy).toHaveBeenCalledWith(piiAvatarPath);
      expect(deleteSpy).toHaveBeenCalledWith(piiDocPath);
    });
  });
});

async function collectCounts(app: FastifyInstance, employeeId: string, userId: string) {
  const [timeEntries, leaveRequests, absences, schedules, overtimeAccounts] = await Promise.all([
    app.prisma.timeEntry.count({ where: { employeeId } }),
    app.prisma.leaveRequest.count({ where: { employeeId } }),
    app.prisma.absence.count({ where: { employeeId } }),
    app.prisma.workSchedule.count({ where: { employeeId } }),
    app.prisma.overtimeAccount.count({ where: { employeeId } }),
  ]);
  // userId is unused in the count query but kept in the signature to make
  // intent obvious at call sites (these counts SHOULD survive anonymization
  // of that user's employee record).
  void userId;
  return { timeEntries, leaveRequests, absences, schedules, overtimeAccounts };
}
