import fp from "fastify-plugin";
import type { TenantConfig } from "@clokr/db";

interface NotifyParams {
  userId: string;
  type: string;
  title: string;
  message: string;
  link?: string;
  tenantId?: string; // Required for email dispatch
}

/** Map notification types to TenantConfig email toggle field names. */
const EMAIL_TYPE_MAP: Record<string, keyof TenantConfig> = {
  LEAVE_REQUEST: "emailOnLeaveRequest",
  LEAVE_APPROVED: "emailOnLeaveDecision",
  LEAVE_REJECTED: "emailOnLeaveDecision",
  LEAVE_CANCELLED: "emailOnLeaveDecision",
  OVERTIME_WARNING: "emailOnOvertimeWarning",
  MISSING_ENTRY: "emailOnMissingEntries",
  CLOCK_OUT_REMINDER: "emailOnClockOutReminder",
  MONTH_CLOSED: "emailOnMonthClose",
};

declare module "fastify" {
  interface FastifyInstance {
    notify: (params: NotifyParams) => Promise<void>;
  }
}

export const notifyPlugin = fp(async (app) => {
  const appUrl = (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");

  async function notify({ userId, type, title, message, link, tenantId }: NotifyParams) {
    // 1. Always create in-app notification
    await app.prisma.notification.create({
      data: { userId, type, title, message, link },
    });

    // 2. Attempt email dispatch (fire-and-forget)
    if (tenantId) {
      sendEmailNotification({ userId, type, title, message, link, tenantId }).catch((err) => {
        app.log.warn({ err, userId, type }, "Failed to send notification email");
      });
    }
  }

  async function sendEmailNotification({
    userId,
    type,
    title,
    message,
    link,
    tenantId,
  }: Required<Pick<NotifyParams, "userId" | "type" | "title" | "message" | "tenantId">> & { link?: string }) {
    // Check tenant master switch
    const config = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
    if (!config?.emailNotificationsEnabled) return;

    // Check per-type toggle
    const toggleField = EMAIL_TYPE_MAP[type];
    if (toggleField && !config[toggleField]) return;

    // Check user opt-in
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.emailNotifications) return;

    // Check SMTP configured
    const smtpConfig = await app.mailer.getSmtpConfig(tenantId);
    if (!smtpConfig) return;

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
});
