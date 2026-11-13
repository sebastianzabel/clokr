/**
 * Issue #285 / #286 / #287 — the audit rows of PUT /settings/work, PUT /settings/smtp and
 * PUT /settings/leave-types/:id carry exactly the CHANGED fields with their before and after
 * value (no hand-kept field list), and the SMTP password never appears in clear text.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, soleAuditRow } from "./setup";
import { changedFieldsAudit, MASKED_VALUE } from "../utils/audit-diff";

describe("changedFieldsAudit", () => {
  it("records only changed keys, normalises Decimal-like values and masks secrets", () => {
    const d = changedFieldsAudit(
      { a: 1, b: "x", c: { toNumber: () => 25 }, s: undefined },
      { a: 1, b: "y", c: "25", s: "changed" },
      { maskedKeys: ["s"] },
    );
    expect(d.oldValue).toEqual({ b: "x", s: MASKED_VALUE, sChanged: true });
    expect(d.newValue).toEqual({ b: "y", s: MASKED_VALUE, sChanged: true });
  });
});

describe("settings audit before/after (#285, #286, #287)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const auth = () => ({ authorization: `Bearer ${data.adminToken}` });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sad285");
  });
  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  it("PUT /settings/work: oldValue/newValue hold exactly the changed fields", async () => {
    const seed = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: auth(),
      payload: { defaultBreakOver6h: 35, defaultBreakOver9h: 50, federalState: "BAYERN" },
    });
    expect(seed.statusCode).toBe(200);
    const cfg = await app.prisma.tenantConfig.findUniqueOrThrow({
      where: { tenantId: data.tenant.id },
    });
    const known = (
      await app.prisma.auditLog.findMany({
        where: { entity: "TenantConfig", entityId: cfg.id, action: "UPDATE" },
        select: { id: true },
      })
    ).map((r) => r.id);

    // Sent: one changed, one identical, one changed Tenant field.
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: auth(),
      payload: { defaultBreakOver6h: 40, defaultBreakOver9h: 50, federalState: "HESSEN" },
    });
    expect(res.statusCode).toBe(200);
    const row = await soleAuditRow(app.prisma, {
      where: {
        entity: "TenantConfig",
        entityId: cfg.id,
        action: "UPDATE",
        id: { notIn: known },
      },
    });
    expect(row.oldValue).toEqual({ defaultBreakOver6h: 35, federalState: "BAYERN" });
    expect(row.newValue).toEqual({
      defaultBreakOver6h: 40,
      federalState: "HESSEN",
      appliedCount: 0,
    });
  });

  it("PUT /settings/smtp: changed fields only, password masked, never in clear text", async () => {
    const base = {
      smtpHost: "smtp.old.test",
      smtpPort: 587,
      smtpUser: "u",
      smtpFromEmail: "a@old.test",
      smtpFromName: "Old",
      smtpSecure: false,
    };
    const first = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/smtp",
      headers: auth(),
      payload: { ...base, smtpPassword: "first-secret-pw" },
    });
    expect(first.statusCode).toBe(200);
    const known = (
      await app.prisma.auditLog.findMany({
        where: { entity: "TenantConfig", entityId: data.tenant.id, action: "UPDATE" },
        select: { id: true },
      })
    ).map((r) => r.id);

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/smtp",
      headers: auth(),
      payload: {
        ...base,
        smtpHost: "smtp.new.test",
        smtpSecure: true,
        smtpPassword: "second-secret-pw",
      },
    });
    expect(res.statusCode).toBe(200);
    const row = await soleAuditRow(app.prisma, {
      where: {
        entity: "TenantConfig",
        entityId: data.tenant.id,
        action: "UPDATE",
        id: { notIn: known },
      },
    });
    expect(row.oldValue).toEqual({
      smtpHost: "smtp.old.test",
      smtpSecure: false,
      smtpPassword: MASKED_VALUE,
      smtpPasswordChanged: true,
    });
    expect(row.newValue).toEqual({
      smtpHost: "smtp.new.test",
      smtpSecure: true,
      smtpPassword: MASKED_VALUE,
      smtpPasswordChanged: true,
    });
    const serialized = JSON.stringify([row.oldValue, row.newValue]);
    expect(serialized).not.toContain("secret-pw");
    const stored = await app.prisma.tenantConfig.findUniqueOrThrow({
      where: { tenantId: data.tenant.id },
    });
    expect(serialized).not.toContain(stored.smtpPassword ?? "never-matches");

    // No password sent: no password key at all.
    const known2 = [...known, row.id];
    const noPw = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/smtp",
      headers: auth(),
      payload: { ...base, smtpHost: "smtp.new.test", smtpSecure: true, smtpPort: 465 },
    });
    expect(noPw.statusCode).toBe(200);
    const row2 = await soleAuditRow(app.prisma, {
      where: {
        entity: "TenantConfig",
        entityId: data.tenant.id,
        action: "UPDATE",
        id: { notIn: known2 },
      },
    });
    expect(row2.oldValue).toEqual({ smtpPort: 587 });
    expect(row2.newValue).toEqual({ smtpPort: 465 });
  });

  it("PUT /settings/leave-types/:id: audited with before/after of the changed fields", async () => {
    const type = await app.prisma.leaveType.findFirstOrThrow({
      where: { tenantId: data.tenant.id },
    });
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/leave-types/${type.id}`,
      headers: auth(),
      payload: {
        allowHalfDay: !type.allowHalfDay,
        leadTimeDays: 7,
        color: type.color,
      },
    });
    expect(res.statusCode).toBe(200);
    const row = await soleAuditRow(app.prisma, {
      where: { entity: "LeaveType", entityId: type.id, action: "UPDATE" },
    });
    expect(row.oldValue).toEqual({
      allowHalfDay: type.allowHalfDay,
      leadTimeDays: type.leadTimeDays,
    });
    expect(row.newValue).toEqual({ allowHalfDay: !type.allowHalfDay, leadTimeDays: 7 });
  });
});
