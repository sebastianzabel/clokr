import fp from "fastify-plugin";
import type { TenantConfig } from "@clokr/db";

interface NotifyParams {
  userId: string;
  type: string;
  title: string;
  message: string;
  link?: string;
  tenantId?: string; // Required for email dispatch
  relatedType?: string; // e.g. "LeaveRequest", "TimeEntry" — used for auto-dismiss
  relatedId?: string; // id of the related entity
}

/**
 * Map notification types to TenantConfig email toggle field names.
 *
 * Exported (Phase 92, Rule 3 deviation — see 92-01-SUMMARY.md) so the RED scaffold
 * in notifications.test.ts can assert on the map directly instead of racing the
 * fire-and-forget email dispatch inside notify(). Export-only change, no behavior
 * change: the map's contents are unchanged by this edit.
 */
export const EMAIL_TYPE_MAP: Record<string, keyof TenantConfig> = {
  LEAVE_REQUEST: "emailOnLeaveRequest",
  LEAVE_APPROVED: "emailOnLeaveDecision",
  LEAVE_REJECTED: "emailOnLeaveDecision",
  LEAVE_CANCELLED: "emailOnLeaveDecision",
  // NOTE: keys MUST match the exact `type` string passed to app.notify() at the
  // emit site — a mismatched key makes the per-type toggle silently ineffective
  // (the gate below is skipped, so the email sends regardless of the toggle).
  MISSING_ENTRIES: "emailOnMissingEntries", // emitted by attendance-checker.ts (plural)
  CLOCK_OUT_REMINDER: "emailOnClockOutReminder",
  MONTH_CLOSE_BLOCKED: "emailOnMonthClose", // emitted by auto-close-month.ts
  GAP_WARNING_EMPLOYEE: "emailOnMissingEntries",
  GAP_WARNING_MANAGER: "emailOnMissingEntries",
  BREAK_UNCONFIRMED: "emailOnMissingEntries", // Phase 92 (BREAK-06)
  BREAK_COMPLIANCE_ALERT: "emailOnMissingEntries", // Phase 92 (BREAK-06)
  // NOTE: emailOnOvertimeWarning has no matching notification type — no code path
  // emits an "overtime warning" via app.notify(), so there is nothing to gate here.
  // Intentionally omitted rather than mapping a type that is never emitted.
  //
  // SALDO-DISP-08 (verified 2026-08-18, Phase 97-02): confirms the note above is not an
  // oversight. All 34 notification types passed to app.notify() were enumerated and none
  // compares a saldo between two points in time; all ten cron registrations in
  // attendance-checker.ts were read and their notify call sites are unrelated;
  // CARRYOVER_EXPIRING (carryover-warning.ts) is the BUrlG vacation-day warning, not an
  // overtime signal. Nothing is suppressed here because nothing exists to suppress — see
  // docs/saldo-anzeige.md for the full decision record and evidence. Forward-looking rule:
  // if a day-over-day saldo notification is ever added, it must compare the confirmed
  // figure only and must exclude the open-month (Prognose) delta.
  //
  // Phase 96 (RETRO-16): RETRO_ENTRY_REQUESTED / RETRO_ENTRY_UPDATED /
  // RETRO_ENTRY_DECIDED / RETRO_ENTRY_WITHDRAWN (retro-entry-requests.ts,
  // time-entries.ts) are intentionally left OUT of this map — no existing
  // emailOn* toggle semantically fits "Zeitnachtrag" (the closest candidates,
  // emailOnMissingEntries and emailOnLeaveDecision, are both domain-mismatched:
  // one is about missing entries, the other about vacation). The in-app
  // notification still fires unconditionally for all four; a future phase can
  // add a dedicated toggle (e.g. emailOnRetroEntry) if email is desired.
  //
  // Phase 104-05: the four § 9 BUrlG (Krank im Urlaub) types are the same judgement,
  // made deliberately — no existing emailOn* toggle fits "§ 9 BUrlG credit outstanding".
  // Absence from THIS map is not enough to keep them in-app-only though (that was the
  // Phase 104 review finding CR-02): an unmapped type falls THROUGH the toggle gate and
  // IS emailed. The four types are therefore listed explicitly in
  // EMAIL_SUPPRESSED_TYPES below, which is the mechanism that actually enforces it.
};

/**
 * Notification types that must NEVER be emailed, regardless of tenant/user toggles.
 *
 * Phase 104 code review CR-02: the per-type gate below reads
 * `EMAIL_TYPE_MAP[type]` and only blocks when a mapping EXISTS and its toggle is off.
 * For an unmapped type the gate short-circuits and execution continues to the SMTP
 * send — i.e. absence from the map is opt-IN by default, the opposite of what the
 * Phase-104-05 comment above claimed. All four § 9 BUrlG types were therefore emailed
 * to any tenant with `emailNotificationsEnabled = true`:
 *
 *   - SECTION9_AU_PENDING_EMPLOYEE — names the employee's own sickness period
 *   - SECTION9_AU_PENDING_MANAGER  — fanned out to EVERY active ADMIN/MANAGER of the
 *                                    tenant, with the same sick date range
 *   - SECTION9_CREDIT_CONFIRMED    — confirms a sickness-during-leave credit
 *   - SECTION9_CREDIT_REJECTED     — carries the manager's free-text rejection reason
 *
 * That is Art. 9 DSGVO (health) material leaving the system over SMTP against an
 * explicitly documented decision that it would not. Suppression is an explicit
 * allow-nothing list rather than a flip of the default, so the email behaviour of
 * every other unmapped type (ACCOUNT_LOCKED, PENDING_LEAVE_REMINDER,
 * CARRYOVER_EXPIRING, VACATION_EXPIRY, UPCOMING_ABSENCE, OPEN_ENTRY_INVALIDATED,
 * RETRO_ENTRY_*) is unchanged by this fix.
 *
 * NOTE (open, owner decision): the RETRO_ENTRY_* types carry the same "no toggle fits"
 * comment as § 9 and are currently emailed by the same fall-through. They are NOT
 * suppressed here because — unlike § 9 — they carry no health-adjacent payload and
 * suppressing them would silently disable a shipped v1.9.10 notification path. If the
 * owner confirms they were never meant to be emailed, add them to this set.
 */
export const EMAIL_SUPPRESSED_TYPES: ReadonlySet<string> = new Set([
  "SECTION9_AU_PENDING_EMPLOYEE",
  "SECTION9_AU_PENDING_MANAGER",
  "SECTION9_CREDIT_CONFIRMED",
  "SECTION9_CREDIT_REJECTED",
]);

/**
 * Escape HTML-significant characters before interpolating a value into the notification
 * email body.
 *
 * Phase 104 code review WR-07: the body is built with raw template interpolation
 * (`<p>${message}</p>`), and Phase 104 introduced the first USER-SUPPLIED free text into a
 * message — the manager's § 9 rejection reason (`z.string().trim().min(1)`, no character
 * restriction). A reason containing `<a href="https://evil.example">…</a>` or
 * `<img src=x onerror=…>` was delivered as live HTML inside a Clokr-branded message: a
 * manager→employee phishing primitive. The in-app bell was never affected (Svelte escapes),
 * so this is an email-only exposure — but every interpolated value is escaped here now,
 * including title/firstName/link, so no future emit site has to remember.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

declare module "fastify" {
  interface FastifyInstance {
    notify: (params: NotifyParams) => Promise<void>;
    dismissByRelated: (relatedType: string, relatedId: string, type?: string) => Promise<number>;
  }
}

export const notifyPlugin = fp(async (app) => {
  const appUrl = (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");

  async function notify({
    userId,
    type,
    title,
    message,
    link,
    tenantId,
    relatedType,
    relatedId,
  }: NotifyParams) {
    // 1. Always create in-app notification
    await app.prisma.notification.create({
      data: { userId, type, title, message, link, relatedType, relatedId },
    });

    // 2. Attempt email dispatch (fire-and-forget)
    if (tenantId) {
      sendEmailNotification({ userId, type, title, message, link, tenantId }).catch((err) => {
        app.log.warn({ err, userId, type }, "Failed to send notification email");
      });
    }
  }

  async function dismissByRelated(
    relatedType: string,
    relatedId: string,
    type?: string,
  ): Promise<number> {
    const { count } = await app.prisma.notification.updateMany({
      where: { relatedType, relatedId, dismissedAt: null, ...(type ? { type } : {}) },
      data: { dismissedAt: new Date() },
    });
    return count;
  }

  async function sendEmailNotification({
    userId,
    type,
    title,
    message,
    link,
    tenantId,
  }: Required<Pick<NotifyParams, "userId" | "type" | "title" | "message" | "tenantId">> & {
    link?: string;
  }) {
    // Check tenant master switch
    const config = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
    if (!config?.emailNotificationsEnabled) {
      // Observability: this is the most common reason a notification produces a
      // bell entry but no email. Debug level, no PII (tenantId + type only).
      app.log.debug(
        { tenantId, type },
        "Notification email skipped: emailNotificationsEnabled is off for tenant",
      );
      return;
    }

    // Hard suppression (Phase 104 review CR-02) — must be checked BEFORE the toggle
    // gate below, because that gate short-circuits for unmapped types and would let
    // health-adjacent § 9 BUrlG payloads through to SMTP. See EMAIL_SUPPRESSED_TYPES.
    if (EMAIL_SUPPRESSED_TYPES.has(type)) {
      app.log.debug(
        { tenantId, type },
        "Notification email skipped: type is in-app only (EMAIL_SUPPRESSED_TYPES)",
      );
      return;
    }

    // Check per-type toggle
    const toggleField = EMAIL_TYPE_MAP[type];
    if (toggleField && !config[toggleField]) return;

    // Check user opt-in
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.emailNotifications) return;

    // Check SMTP configured
    const smtpConfig = await app.mailer.getSmtpConfig(tenantId);
    if (!smtpConfig) {
      // Observability: master switch + toggles were on, but SMTP is not set up
      // (neither per-tenant DB config nor SMTP_* env). Debug level, no PII.
      app.log.debug(
        { tenantId, type },
        "Notification email skipped: SMTP not configured for tenant",
      );
      return;
    }

    // Get user's name
    const employee = await app.prisma.employee.findFirst({ where: { userId } });
    const firstName = employee?.firstName ?? "Nutzer";

    // Build full link
    const fullLink = link ? (link.startsWith("http") ? link : `${appUrl}${link}`) : null;

    // Send via nodemailer
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: smtpConfig.smtpHost,
      port: smtpConfig.smtpPort,
      secure: smtpConfig.smtpSecure,
      auth: { user: smtpConfig.smtpUser, pass: smtpConfig.smtpPassword },
    });

    await transporter.sendMail({
      from: `"${smtpConfig.smtpFromName}" <${smtpConfig.smtpFromEmail}>`,
      to: user.email,
      subject: `${title} – Clokr`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
          <h2 style="color:#2563eb">${escapeHtml(title)}</h2>
          <p>Hallo ${escapeHtml(firstName)},</p>
          <p>${escapeHtml(message)}</p>
          ${fullLink ? `<a href="${escapeHtml(fullLink)}" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Jetzt ansehen</a>` : ""}
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
          <p style="color:#9ca3af;font-size:12px">Diese E-Mail wurde automatisch von Clokr gesendet.</p>
        </div>`,
    });
  }

  app.decorate("notify", notify);
  app.decorate("dismissByRelated", dismissByRelated);
});
