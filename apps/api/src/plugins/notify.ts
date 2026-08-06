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
};

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
          <h2 style="color:#2563eb">${title}</h2>
          <p>Hallo ${firstName},</p>
          <p>${message}</p>
          ${fullLink ? `<a href="${fullLink}" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Jetzt ansehen</a>` : ""}
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
          <p style="color:#9ca3af;font-size:12px">Diese E-Mail wurde automatisch von Clokr gesendet.</p>
        </div>`,
    });
  }

  app.decorate("notify", notify);
  app.decorate("dismissByRelated", dismissByRelated);
});
