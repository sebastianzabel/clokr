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
//   - the per-type toggle gate, resolved through NOTIFICATION_EMAIL_POLICY
//   - the historical key fix (MISSING_ENTRIES now honors emailOnMissingEntries)
//   - the fail-closed gate for unregistered types (quick-260825-k3g)
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
    // Regression lock for the historical key fix (was MISSING_ENTRY, never matched).
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

  // ── Phase 104 code review WR-07 — free text is escaped in the email body ───
  //
  // Phase 104 introduced the first USER-SUPPLIED free text into a notification message:
  // the manager's § 9 rejection reason. The body is raw template interpolation, so a
  // reason containing markup was delivered as live HTML inside a Clokr-branded email.
  it("(f) HTML in title/message/link is escaped, never delivered as live markup", async () => {
    await setConfig({
      ...SMTP_CONFIGURED,
      emailNotificationsEnabled: true,
      emailOnLeaveRequest: true,
    });

    await app.notify({
      userId: data.adminUser.id,
      type: "LEAVE_REQUEST",
      title: '<img src=x onerror="alert(1)">',
      message:
        'Die eingereichte AU wurde abgelehnt: <a href="https://evil.example">Jetzt handeln</a>.',
      link: '/leave?x="evil"',
      tenantId: data.tenant.id,
    });

    await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(1));
    const html = sendMailMock.mock.calls[0][0].html as string;

    // No attacker-controlled tag survives as markup...
    expect(html).not.toContain("<img");
    expect(html).not.toContain('<a href="https://evil.example"');
    // The escaped text still reads "onerror=&quot;..." — what must NOT survive is the
    // unescaped attribute form that a mail client would parse.
    expect(html).not.toContain('onerror="');
    // ...and the text is still readable, just escaped.
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("Die eingereichte AU wurde abgelehnt:");
    // The legitimate Clokr CTA link is still a real anchor.
    expect(html).toContain('style="display:inline-block');
  });

  // ── Phase 104 code review CR-02 — § 9 BUrlG types are in-app only ──────────
  //
  // Before the fix, absence from the old two-list mechanism (a per-type toggle map
  // plus a side-car deny-list) could short-circuit the per-type gate and let execution
  // continue to the SMTP send — so all four § 9 types WERE emailed, against the
  // documented Phase-104-05 decision to keep health-adjacent (Art. 9 DSGVO) payloads
  // in-app. quick-260825-k3g superseded that deny-list with the single exhaustive
  // NOTIFICATION_EMAIL_POLICY registry; the four § 9 types now carry an explicit
  // `{ email: "never" }` policy.
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

    it("PENDING_LEAVE_REMINDER still emails — it carries an explicit 'always' policy", async () => {
      // PENDING_LEAVE_REMINDER has no emailOn* toggle. Its email path is load-bearing
      // (v1.9.8 manager reminders) and must be untouched by CR-02 or by the fail-closed
      // registry rewrite: it now resolves to { email: "always" }, not "unmapped".
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

  // ── quick-260825-k3g — fail-closed gate ────────────────────────────────────
  describe("Fail-closed gate: an unregistered type is never emailed", () => {
    it("does NOT send for an unregistered type and logs a warning naming the registry", async () => {
      await setConfig({
        ...SMTP_CONFIGURED,
        emailNotificationsEnabled: true,
        emailOnLeaveRequest: true,
        emailOnLeaveDecision: true,
        emailOnMissingEntries: true,
        emailOnClockOutReminder: true,
        emailOnMonthClose: true,
        emailOnRetroEntry: true,
      });

      const warnSpy = vi.spyOn(app.log, "warn");
      try {
        await app.notify({
          userId: data.adminUser.id,
          type: "__UNREGISTERED_QUICK_TEST_TYPE__",
          title: "Unregistrierter Typ",
          message: "Dieser Typ existiert nicht in der Registry.",
          tenantId: data.tenant.id,
        });

        await flush();
        expect(sendMailMock).not.toHaveBeenCalled();

        const warnCall = warnSpy.mock.calls.find((call) =>
          String(call[1] ?? "").includes("notification-email-policy"),
        );
        expect(
          warnCall,
          "expected app.log.warn to be called with a message naming the registry",
        ).toBeDefined();

        // Fail-closed is email-only — the in-app bell entry must still be created.
        const inApp = await app.prisma.notification.findFirst({
          where: { userId: data.adminUser.id, type: "__UNREGISTERED_QUICK_TEST_TYPE__" },
          orderBy: { createdAt: "desc" },
        });
        expect(inApp).not.toBeNull();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // ── quick-260825-k3g — emailOnRetroEntry toggle ────────────────────────────
  describe("RETRO_ENTRY_* types ride the new emailOnRetroEntry toggle", () => {
    it("does NOT send when emailOnRetroEntry is false (master on)", async () => {
      await setConfig({
        ...SMTP_CONFIGURED,
        emailNotificationsEnabled: true,
        emailOnRetroEntry: false,
      });

      await app.notify({
        userId: data.adminUser.id,
        type: "RETRO_ENTRY_REQUESTED",
        title: "Neuer Zeitnachtrag",
        message: "Ein Zeitnachtrag wartet auf Genehmigung.",
        tenantId: data.tenant.id,
      });

      await flush();
      expect(sendMailMock).not.toHaveBeenCalled();
    });

    it("sends exactly once when emailOnRetroEntry is true", async () => {
      await setConfig({
        ...SMTP_CONFIGURED,
        emailNotificationsEnabled: true,
        emailOnRetroEntry: true,
      });

      await app.notify({
        userId: data.adminUser.id,
        type: "RETRO_ENTRY_REQUESTED",
        title: "Neuer Zeitnachtrag",
        message: "Ein Zeitnachtrag wartet auf Genehmigung.",
        tenantId: data.tenant.id,
      });

      await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(1));
    });
  });

  // ── quick-260825-k3g — behaviour-preservation lock for the 7 'always' types ─
  describe("'always' types survive every emailOn* toggle being off", () => {
    const ALWAYS_TYPES = [
      "ACCOUNT_LOCKED",
      "PENDING_LEAVE_REMINDER",
      "CARRYOVER_EXPIRING",
      "VACATION_EXPIRY",
      "UPCOMING_ABSENCE",
      "OPEN_ENTRY_INVALIDATED",
      "SHIFT_LEAVE_CONFLICT",
    ] as const;

    for (const type of ALWAYS_TYPES) {
      it(`${type} still sends exactly one email with every emailOn* toggle off`, async () => {
        await setConfig({
          ...SMTP_CONFIGURED,
          emailNotificationsEnabled: true,
          emailOnLeaveRequest: false,
          emailOnLeaveDecision: false,
          emailOnMissingEntries: false,
          emailOnClockOutReminder: false,
          emailOnMonthClose: false,
          emailOnRetroEntry: false,
        });

        await app.notify({
          userId: data.adminUser.id,
          type,
          title: "Immer-Zustelltyp",
          message: `Test für ${type}.`,
          tenantId: data.tenant.id,
        });

        await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(1));
      });
    }
  });
});
