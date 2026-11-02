import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";
import { withAdvisoryLock, ADVISORY_LOCK_KEYS } from "../../../utils/with-advisory-lock";
import { purgeStalePairingCodes } from "../../time-tracking"; // Issue #610

/**
 * Token expiry cleanup scheduler: hard-deletes expired RefreshToken and OtpToken
 * rows daily. These tables grow unbounded without periodic cleanup because tokens
 * are created on every login but only soft-checked (expiresAt) at read time.
 *
 * Hard-delete is correct here: RefreshToken and OtpToken are explicitly listed as
 * "hard-deleted (not retention-relevant)" in CLAUDE.md under DSGVO Employee Deletion.
 *
 * WLAN pairing codes (Issue #610, D-04) join the same group: a code names a device address and
 * is a one-time token, so every code older than a day (consumed or not) is hard-deleted, through
 * the time-tracking facade (the table belongs to Zeiterfassung).
 *
 * Advisory lock TOKEN_CLEANUP (1013n) ensures only one replica runs cleanup per
 * cron window when multiple API replicas are deployed.
 *
 * Schedule: 02:00 daily (Europe/Berlin)
 */
/** A pairing code is kept for one day after its creation (consumed or not), then hard-deleted. */
const PAIRING_CODE_RETENTION_MS = 24 * 60 * 60 * 1000;

export const tokenCleanupPlugin = fp(async (app) => {
  const tasks: ScheduledTask[] = [];

  async function purgeExpiredTokens() {
    const now = new Date();
    const pairingCodeCutoff = new Date(now.getTime() - PAIRING_CODE_RETENTION_MS);
    const [rt, otp, pairingCodes] = await Promise.all([
      app.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: now } } }),
      app.prisma.otpToken.deleteMany({ where: { expiresAt: { lt: now } } }),
      purgeStalePairingCodes(app.prisma, pairingCodeCutoff),
    ]);
    app.log.info(
      `Token cleanup: deleted ${rt.count} refresh tokens, ${otp.count} OTP tokens, ${pairingCodes} pairing codes`,
    );
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
