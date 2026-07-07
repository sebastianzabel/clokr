import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";
import { withAdvisoryLock, ADVISORY_LOCK_KEYS } from "../utils/with-advisory-lock";

/**
 * Token expiry cleanup scheduler: hard-deletes expired RefreshToken and OtpToken
 * rows daily. These tables grow unbounded without periodic cleanup because tokens
 * are created on every login but only soft-checked (expiresAt) at read time.
 *
 * Hard-delete is correct here: RefreshToken and OtpToken are explicitly listed as
 * "hard-deleted (not retention-relevant)" in CLAUDE.md under DSGVO Employee Deletion.
 *
 * Advisory lock TOKEN_CLEANUP (1013n) ensures only one replica runs cleanup per
 * cron window when multiple API replicas are deployed.
 *
 * Schedule: 02:00 daily (Europe/Berlin)
 */
export const tokenCleanupPlugin = fp(async (app) => {
  const tasks: ScheduledTask[] = [];

  async function purgeExpiredTokens() {
    const now = new Date();
    const [rt, otp] = await Promise.all([
      app.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: now } } }),
      app.prisma.otpToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    ]);
    app.log.info(`Token-Cleanup: ${rt.count} RefreshTokens, ${otp.count} OtpTokens gelöscht`);
  }

  const task = cron.schedule(
    "0 2 * * *",
    () => {
      withAdvisoryLock(
        app.prisma,
        ADVISORY_LOCK_KEYS.TOKEN_CLEANUP,
        () => purgeExpiredTokens(),
        app.log,
      ).catch((err) => app.log.error({ err }, "Token-Cleanup fehlgeschlagen"));
    },
    { timezone: "Europe/Berlin", noOverlap: true },
  );
  tasks.push(task);
  app.log.info("Token-Cleanup: Tägliche Bereinigung geplant (02:00)");

  // Expose for direct invocation in tests and manual triggers
  app.decorate("purgeExpiredTokens", purgeExpiredTokens);

  app.addHook("onClose", () => {
    tasks.forEach((t) => void t.stop());
  });
});

declare module "fastify" {
  interface FastifyInstance {
    purgeExpiredTokens?: () => Promise<void>;
  }
}
