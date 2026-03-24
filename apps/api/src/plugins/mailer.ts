import fp from "fastify-plugin";
import nodemailer, { Transporter } from "nodemailer";
import { config } from "../config";

interface SmtpConfig {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  smtpFromEmail: string;
  smtpFromName: string;
  smtpSecure: boolean;
}

export interface MailerService {
  sendInvitation(params: { to: string; firstName: string; token: string }): Promise<void>;
  sendOtp(params: { to: string; firstName: string; code: string }): Promise<void>;
  sendTestMail(to: string, smtpOverride?: Partial<SmtpConfig>): Promise<void>;
  getSmtpConfig(tenantId: string): Promise<SmtpConfig | null>;
}

declare module "fastify" {
  interface FastifyInstance {
    mailer: MailerService;
  }
}

function createTransporter(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    auth: { user: cfg.smtpUser, pass: cfg.smtpPassword },
  });
}

export const mailerPlugin = fp(async (app) => {
  const appUrl = (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");

  async function getSmtpConfig(tenantId: string): Promise<SmtpConfig | null> {
    // DB-Config hat Vorrang, Env-Vars als Fallback
    const dbCfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });

    const host      = dbCfg?.smtpHost      ?? process.env.SMTP_HOST;
    const port      = dbCfg?.smtpPort      ?? (process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : undefined);
    const user      = dbCfg?.smtpUser      ?? process.env.SMTP_USER;
    const password  = dbCfg?.smtpPassword  ?? process.env.SMTP_PASSWORD;
    const fromEmail = dbCfg?.smtpFromEmail ?? process.env.SMTP_FROM_EMAIL;
    const fromName  = dbCfg?.smtpFromName  ?? process.env.SMTP_FROM_NAME ?? "Clokr";
    const secure    = dbCfg?.smtpSecure    ?? (process.env.SMTP_SECURE === "true");

    if (!host || !port || !user || !password || !fromEmail) return null;

    return { smtpHost: host, smtpPort: port, smtpUser: user, smtpPassword: password, smtpFromEmail: fromEmail, smtpFromName: fromName, smtpSecure: secure };
  }

  async function sendInvitation({ to, firstName, token }: { to: string; firstName: string; token: string }) {
    // Tenant aus E-Mail-Adresse ermitteln → ersten Tenant nehmen
    const tenant = await app.prisma.tenant.findFirst();
    if (!tenant) throw new Error("Kein Tenant gefunden");

    const cfg = await getSmtpConfig(tenant.id);
    if (!cfg) throw new Error("SMTP nicht konfiguriert");

    const link = `${appUrl}/einladung?token=${token}`;
    const transporter = createTransporter(cfg);

    await transporter.sendMail({
      from: `"${cfg.smtpFromName}" <${cfg.smtpFromEmail}>`,
      to,
      subject: "Willkommen bei Clokr – Konto aktivieren",
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
          <h2 style="color:#6d28d9">Willkommen, ${firstName}!</h2>
          <p>Sie wurden zu <strong>Clokr</strong> eingeladen.</p>
          <p>Bitte klicken Sie auf den folgenden Link, um Ihr Passwort zu setzen und Ihr Konto zu aktivieren. Der Link ist <strong>24 Stunden</strong> gültig.</p>
          <a href="${link}" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#6d28d9;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Konto aktivieren</a>
          <p style="color:#666;font-size:13px">Falls der Button nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:<br><a href="${link}">${link}</a></p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
          <p style="color:#9ca3af;font-size:12px">Diese E-Mail wurde automatisch gesendet. Bitte nicht antworten.</p>
        </div>`,
    });
  }

  async function sendOtp({ to, firstName, code }: { to: string; firstName: string; code: string }) {
    const tenant = await app.prisma.tenant.findFirst();
    if (!tenant) throw new Error("Kein Tenant gefunden");

    const cfg = await getSmtpConfig(tenant.id);
    if (!cfg) throw new Error("SMTP nicht konfiguriert");

    const transporter = createTransporter(cfg);

    await transporter.sendMail({
      from: `"${cfg.smtpFromName}" <${cfg.smtpFromEmail}>`,
      to,
      subject: "Ihr Anmeldecode – Clokr",
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
          <h2 style="color:#6d28d9">Hallo, ${firstName}!</h2>
          <p>Ihr Anmeldecode für <strong>Clokr</strong> lautet:</p>
          <div style="text-align:center;margin:24px 0">
            <span style="display:inline-block;font-size:36px;font-weight:700;letter-spacing:10px;color:#1f2937;background:#f3f4f6;padding:16px 32px;border-radius:8px">${code}</span>
          </div>
          <p style="color:#666">Dieser Code ist <strong>10 Minuten</strong> gültig.</p>
          <p style="color:#9ca3af;font-size:12px">Falls Sie sich nicht angemeldet haben, ignorieren Sie diese E-Mail.</p>
        </div>`,
    });
  }

  async function sendTestMail(to: string, smtpOverride?: Partial<SmtpConfig>) {
    const tenant = await app.prisma.tenant.findFirst();
    if (!tenant) throw new Error("Kein Tenant gefunden");

    const baseCfg = await getSmtpConfig(tenant.id);
    const cfg = baseCfg ? { ...baseCfg, ...smtpOverride } : (smtpOverride as SmtpConfig);
    if (!cfg?.smtpHost) throw new Error("SMTP nicht konfiguriert");

    const transporter = createTransporter(cfg);
    await transporter.sendMail({
      from: `"${cfg.smtpFromName}" <${cfg.smtpFromEmail}>`,
      to,
      subject: "SMTP-Testverbindung erfolgreich",
      html: `<p>Die SMTP-Verbindung von <strong>Clokr</strong> wurde erfolgreich getestet.</p>`,
    });
  }

  app.decorate("mailer", { sendInvitation, sendOtp, sendTestMail, getSmtpConfig });
});
