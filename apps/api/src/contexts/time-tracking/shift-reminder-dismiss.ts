/**
 * Issue #609 (IN-03) - a clock-in or clock-out answers the open shift reminder of the person.
 *
 * The START and END notices point at a Shift, not at a time entry, so `dismissByRelated("TimeEntry",
 * id)` (the CLOCK_OUT_REMINDER contract) cannot reach them. A successful clock-in soft-dismisses the
 * person's open `REMINDER_SHIFT_START` notices, a successful clock-out the open `REMINDER_SHIFT_END`
 * notices: the question they ask has been answered, and a stale "Jetzt einstempeln?" in the bell is
 * only clutter. The rows are kept (dismissed, never deleted), so the once-per-shift dedupe still
 * sees them.
 *
 * Reactive and best effort: it runs after the clock write is committed and never fails the clock.
 */
import type { FastifyInstance } from "fastify";

const START_TYPE = "REMINDER_SHIFT_START";
const END_TYPE = "REMINDER_SHIFT_END";

export type ClockDirection = "IN" | "OUT";

export async function dismissShiftReminderNotices(
  app: FastifyInstance,
  userId: string,
  direction: ClockDirection,
): Promise<void> {
  try {
    await app.prisma.notification.updateMany({
      where: {
        userId,
        type: direction === "IN" ? START_TYPE : END_TYPE,
        dismissedAt: null,
      },
      data: { dismissedAt: new Date() },
    });
  } catch (err) {
    app.log.warn(
      { err, userId, direction },
      "Failed to auto-dismiss shift reminders on clock event",
    );
  }
}
