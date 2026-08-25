import fp from "fastify-plugin";
import { resolveEmailPolicy } from "../utils/notification-email-policy";

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
    // Fail-closed gate (quick-260825-k3g) — checked FIRST, ahead of the tenant master
    // switch, so a missing registration surfaces even for tenants that have email
    // switched off (that is where a new type is most likely to be added and least
    // likely to be noticed). See apps/api/src/utils/notification-email-policy.ts —
    // the single source of truth this resolves against.
    const policy = resolveEmailPolicy(type);
    if (!policy) {
      app.log.warn(
        { tenantId, type },
        "Notification email suppressed: type has no entry in the email policy registry " +
          "(fail-closed) — add one in apps/api/src/utils/notification-email-policy.ts",
      );
      return;
    }
    if (policy.email === "never") {
      app.log.debug({ tenantId, type }, "Notification email skipped: policy is 'never'");
      return;
    }

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
    if (policy.email === "toggle" && !config[policy.field]) return;

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
