import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

// ────────────────────────────────────────────────────────────────────────────
// End-to-end-ish coverage for the notification EMAIL dispatch path
// (apps/api/src/plugins/notify.ts -> sendEmailNotification()).
//
// The transporter is built inline inside notify.ts via a dynamic
// `await import("nodemailer")`, so we mock nodemailer.createTransport to capture
// sendMail calls without hitting a real SMTP server. This locks:
//   - the master switch gate (emailNotificationsEnabled)
//   - the per-type toggle gate (EMAIL_TYPE_MAP)
//   - the EMAIL_TYPE_MAP key fix (MISSING_ENTRIES now honors emailOnMissingEntries)
//
// notify() dispatches the email fire-and-forget, so positive assertions use
// vi.waitFor() and negative assertions flush a short delay before asserting.
// ────────────────────────────────────────────────────────────────────────────

const { sendMailMock } = vi.hoisted(() => ({ sendMailMock: vi.fn() }));

vi.mock("nodemailer", () => {
  const createTransport = vi.fn(() => ({ sendMail: sendMailMock }));
  // Cover both `mod.createTransport` and `mod.default.createTransport` access.
  return { default: { createTransport }, createTransport };
});

const SMTP_CONFIGURED = {
  smtpHost: "smtp.test.local",
  smtpPort: 587,
  smtpUser: "smtp-user",
  smtpPassword: "smtp-pass", // plaintext — decryptSafe() falls back to plaintext
  smtpFromEmail: "noreply@test.local",
  smtpFromName: "Clokr Test",
  smtpSecure: false,
};

// Wait long enough for the fire-and-forget dispatch (a few local-DB round-trips)
// to reach its early-return before asserting a NON-send.
const flush = () => new Promise((r) => setTimeout(r, 300));

describe("Notification email dispatch (notify.ts sendEmailNotification)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ne");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(() => {
    sendMailMock.mockReset();
    sendMailMock.mockResolvedValue({ messageId: "test-message-id" });
  });

  async function setConfig(patch: Record<string, unknown>) {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: patch,
    });
  }

  it("(a) sends email for LEAVE_REQUEST when fully configured", async () => {
    await setConfig({
      ...SMTP_CONFIGURED,
      emailNotificationsEnabled: true,
      emailOnLeaveRequest: true,
    });

    await app.notify({
      userId: data.adminUser.id,
      type: "LEAVE_REQUEST",
      title: "Neuer Urlaubsantrag",
      message: "Max Test hat einen Urlaubsantrag gestellt.",
      link: "/leave",
      tenantId: data.tenant.id,
    });

    await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(1));
    const arg = sendMailMock.mock.calls[0][0];
    expect(arg.to).toBe(data.adminUser.email);
    expect(arg.subject).toContain("Neuer Urlaubsantrag");
  });

  it("(b) does NOT send when emailNotificationsEnabled is off (master switch)", async () => {
    await setConfig({
      ...SMTP_CONFIGURED,
      emailNotificationsEnabled: false,
      emailOnLeaveRequest: true,
    });

    await app.notify({
      userId: data.adminUser.id,
      type: "LEAVE_REQUEST",
      title: "Neuer Urlaubsantrag",
      message: "Max Test hat einen Urlaubsantrag gestellt.",
      tenantId: data.tenant.id,
    });

    await flush();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("(c) does NOT send when the per-type toggle is off (master on)", async () => {
    await setConfig({
      ...SMTP_CONFIGURED,
      emailNotificationsEnabled: true,
      emailOnLeaveRequest: false,
    });

    await app.notify({
      userId: data.adminUser.id,
      type: "LEAVE_REQUEST",
      title: "Neuer Urlaubsantrag",
      message: "Max Test hat einen Urlaubsantrag gestellt.",
      tenantId: data.tenant.id,
    });

    await flush();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("(d) MISSING_ENTRIES now honors emailOnMissingEntries — OFF = no send", async () => {
    // Regression lock for the EMAIL_TYPE_MAP key fix (was MISSING_ENTRY, never matched).
    await setConfig({
      ...SMTP_CONFIGURED,
      emailNotificationsEnabled: true,
      emailOnMissingEntries: false,
    });

    await app.notify({
      userId: data.adminUser.id,
      type: "MISSING_ENTRIES",
      title: "Fehlende Zeiteinträge",
      message: "Es fehlen Zeiteinträge.",
      tenantId: data.tenant.id,
    });

    await flush();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("(d²) MISSING_ENTRIES sends when emailOnMissingEntries is ON", async () => {
    await setConfig({
      ...SMTP_CONFIGURED,
      emailNotificationsEnabled: true,
      emailOnMissingEntries: true,
    });

    await app.notify({
      userId: data.adminUser.id,
      type: "MISSING_ENTRIES",
      title: "Fehlende Zeiteinträge",
      message: "Es fehlen Zeiteinträge.",
      tenantId: data.tenant.id,
    });

    await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(1));
  });

  it("(e) does NOT send when SMTP is not configured (master + toggle on)", async () => {
    await setConfig({
      ...SMTP_CONFIGURED,
      emailNotificationsEnabled: true,
      emailOnLeaveRequest: true,
    });

    // Force the SMTP gate to fail deterministically, independent of any SMTP_* env
    // fallback that getSmtpConfig() would otherwise pick up.
    const spy = vi.spyOn(app.mailer, "getSmtpConfig").mockResolvedValue(null);
    try {
      await app.notify({
        userId: data.adminUser.id,
        type: "LEAVE_REQUEST",
        title: "Neuer Urlaubsantrag",
        message: "Max Test hat einen Urlaubsantrag gestellt.",
        tenantId: data.tenant.id,
      });

      await flush();
      expect(sendMailMock).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // ── Phase 104 code review CR-02 — § 9 BUrlG types are in-app only ──────────
  //
  // Before the fix, absence from EMAIL_TYPE_MAP short-circuited the per-type gate
  // (`if (toggleField && !config[toggleField]) return;`) and execution continued to
  // the SMTP send — so all four § 9 types WERE emailed, against the documented
  // Phase-104-05 decision to keep health-adjacent (Art. 9 DSGVO) payloads in-app.
  describe("§ 9 BUrlG notification types are never emailed (CR-02)", () => {
    const SECTION9_TYPES = [
      "SECTION9_AU_PENDING_EMPLOYEE",
      "SECTION9_AU_PENDING_MANAGER",
      "SECTION9_CREDIT_CONFIRMED",
      "SECTION9_CREDIT_REJECTED",
    ] as const;

    for (const type of SECTION9_TYPES) {
      it(`${type} creates the in-app notification but sends NO email`, async () => {
        // Every gate downstream is deliberately WIDE OPEN, so a send here can only
        // come from the missing suppression.
        await setConfig({
          ...SMTP_CONFIGURED,
          emailNotificationsEnabled: true,
          emailOnLeaveRequest: true,
          emailOnLeaveDecision: true,
          emailOnMissingEntries: true,
        });

        await app.notify({
          userId: data.adminUser.id,
          type,
          title: "§ 9 BUrlG",
          message: "Krankmeldung während genehmigten Urlaubs (16.09.2026 – 17.09.2026)",
          tenantId: data.tenant.id,
        });

        await flush();
        expect(sendMailMock).not.toHaveBeenCalled();

        // The in-app bell entry must still be created — suppression is email-only.
        const inApp = await app.prisma.notification.findFirst({
          where: { userId: data.adminUser.id, type },
          orderBy: { createdAt: "desc" },
        });
        expect(inApp).not.toBeNull();
      });
    }

    it("a NON-suppressed unmapped type still emails (the fix is a deny-list, not a default flip)", async () => {
      // PENDING_LEAVE_REMINDER is also absent from EMAIL_TYPE_MAP. Its email path is
      // load-bearing (v1.9.8 manager reminders) and must be untouched by CR-02.
      await setConfig({
        ...SMTP_CONFIGURED,
        emailNotificationsEnabled: true,
      });

      await app.notify({
        userId: data.adminUser.id,
        type: "PENDING_LEAVE_REMINDER",
        title: "Offene Urlaubsanträge",
        message: "Es liegen offene Urlaubsanträge vor.",
        tenantId: data.tenant.id,
      });

      await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(1));
    });
  });
});
