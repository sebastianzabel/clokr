/**
 * Issue #512 (DSGVO Art. 17 vs. Revisionssicherheit): the anonymization redacts, by TYPE, the
 * free text inside the AuditLog old/new values of the person - and only that: rows stay, who/when/
 * what and every figure stay, other persons are untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { anonymizeEmployeeData } from "../contexts/platform/anonymize";
import { redactAuditFreeTextOfPerson } from "../contexts/platform/audit-freetext-redaction";
import { SUPPORT_AUDIT_REDACTED } from "../contexts/platform/support-audit-redaction";

const TEXT = "Kundentermin bei Frau Beispiel";

describe("anonymization redacts free text in the AuditLog values (#512)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let target: { employeeId: string; userId: string };
  let other: { employeeId: string; userId: string };
  const rowIds: Record<string, string> = {};

  async function makePerson(label: string) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@test.local`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: "Max",
        lastName: label,
        employeeNumber: `${label}-${suffix}`,
        hireDate: new Date("2024-01-01"),
      },
    });
    return { employeeId: employee.id, userId: user.id };
  }

  async function seedAudit(person: { employeeId: string; userId: string }, tag: string) {
    // About the person: names the employee in the payload.
    const about = await app.prisma.auditLog.create({
      data: {
        userId: data.adminUser.id,
        action: "UPDATE",
        entity: "TimeEntry",
        entityId: crypto.randomUUID(),
        oldValue: { employeeId: person.employeeId, workingMinutes: 480, startTime: "08:00" },
        newValue: {
          employeeId: person.employeeId,
          workingMinutes: 450,
          startTime: "08:30",
          date: "2025-06-16",
          type: "WORK",
          auditReason: TEXT,
          actor: { type: "OPERATOR", operatorId: "op-1", note: "stamp kept" },
          breaks: [{ reason: TEXT, minutes: 30 }],
        },
      },
    });
    // Authored by the person: payload does not name the employee.
    const authored = await app.prisma.auditLog.create({
      data: {
        userId: person.userId,
        action: "UPDATE",
        entity: "LeaveRequest",
        entityId: crypto.randomUUID(),
        newValue: { status: "REJECTED", reviewNote: TEXT, days: 2 },
      },
    });
    rowIds[`${tag}-about`] = about.id;
    rowIds[`${tag}-authored`] = authored.id;
  }

  const read = (id: string) => app.prisma.auditLog.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "anon-512");
    target = await makePerson("target512");
    other = await makePerson("other512");
    await seedAudit(target, "target");
    await seedAudit(other, "other");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("anonymization-audit-freetext-512 cleanup failed:", err);
    }
  });

  it("negative control: before the anonymization the texts are stored", async () => {
    expect(JSON.stringify((await read(rowIds["target-about"])).newValue)).toContain(TEXT);
    expect(JSON.stringify((await read(rowIds["target-authored"])).newValue)).toContain(TEXT);
  });

  it("redacts text by type, keeps figures, ids, codes, times, actor and the rows", async () => {
    const rowsBefore = await app.prisma.auditLog.count();
    const result = await app.prisma.$transaction((tx) =>
      anonymizeEmployeeData({
        tx,
        employeeId: target.employeeId,
        exitDayIfUnset: new Date("2026-03-10T00:00:00Z"),
      }),
    );
    expect(result.auditRedaction.rowsRedacted).toBe(2);
    expect(await app.prisma.auditLog.count()).toBe(rowsBefore); // no row deleted

    const about = await read(rowIds["target-about"]);
    expect(about.userId).toBe(data.adminUser.id); // the actor is another user: who stays
    expect(about.oldValue).toEqual({
      employeeId: target.employeeId,
      workingMinutes: 480,
      startTime: "08:00",
    });
    expect(about.newValue).toEqual({
      employeeId: target.employeeId,
      workingMinutes: 450,
      startTime: "08:30",
      date: "2025-06-16",
      type: "WORK",
      auditReason: SUPPORT_AUDIT_REDACTED,
      actor: { type: "OPERATOR", operatorId: "op-1", note: "stamp kept" },
      breaks: [{ reason: SUPPORT_AUDIT_REDACTED, minutes: 30 }],
    });

    const authored = await read(rowIds["target-authored"]);
    expect(authored.userId).toBeNull(); // existing behaviour
    expect(authored.newValue).toEqual({
      status: "REJECTED",
      reviewNote: SUPPORT_AUDIT_REDACTED,
      days: 2,
    });
  });

  it("leaves another person's audit rows untouched", async () => {
    expect((await read(rowIds["other-about"])).newValue).toMatchObject({ auditReason: TEXT });
    expect((await read(rowIds["other-authored"])).newValue).toMatchObject({ reviewNote: TEXT });
  });

  it("is idempotent: a second run redacts nothing", async () => {
    const again = await app.prisma.$transaction((tx) =>
      redactAuditFreeTextOfPerson(tx, { employeeId: target.employeeId, userId: null }),
    );
    expect(again.rowsRedacted).toBe(0);
  });
});
