/**
 * Issue #609 (D-03 .. D-09, D-17; P-609-09 .. P-609-12) - the five-minute shift reminder job
 * (Feature 12 of the attendance checker).
 *
 * Reads only through the owning contexts' facades (shifts, recorded entries) and writes only
 * notices through `app.notify()`. It decides nothing about working time and writes no audit row: a
 * notice is no business mutation (the Feature 9/10/11 precedent). The recipient is always the
 * shift's own person, never a manager.
 *
 * Two stages. Stage 1 is pure and reads no further data: per shift the instants and the windows of
 * the ENABLED occasions give the candidates; a tenant without a candidate triggers no further read.
 * Stage 2 reads only for the candidate persons and days.
 */
import type { FastifyInstance } from "fastify";
import {
  ACTIVE_TENANT_WHERE, // Phase 88 (D-05a): a deactivated tenant is a suspended customer - no notices
  accessContextForJob,
  employeeScopeFor,
  reportPopulationWhere, // Issue #613: employed on the day and never anonymised
} from "../platform";
import { dateStrInTz, dayRangeUtc } from "../working-time-account";
import { getShiftsInRange } from "../scheduling";
import { getRecordedWorkEntriesInRange } from "./facade/time-entries";
import {
  REMINDER_CLOCK_LINK,
  clampReminderOffset,
  decideShiftStart,
  formatShiftTime,
  shiftInstants,
  shiftReminderKey,
  type ReminderSkipReason,
} from "./shift-reminders";

const JOB = "shift-reminders";
/** The type of the dedupe read; the emit site below keeps its own literal (the registry scanner reads it). */
const START_TYPE = "REMINDER_SHIFT_START";
const DAY_MS = 86_400_000;

/** Counts of the skip reasons of one tenant tick, for the debug log (ids never, only totals). */
type SkipCounts = Partial<Record<ReminderSkipReason, number>>;

/**
 * Evaluates the reminder occasions of every active tenant that has at least one switch on, at
 * `now` (a parameter so tests fix the clock; the cron passes nothing).
 */
export async function runShiftReminders(
  app: FastifyInstance,
  now: Date = new Date(),
): Promise<void> {
  app.log.info("Attendance checker: evaluating shift reminders (Feature 12)");
  try {
    const tenants = await app.prisma.tenant.findMany({
      where: {
        ...ACTIVE_TENANT_WHERE,
        config: {
          OR: [
            { reminderShiftStartEnabled: true },
            { reminderShiftEndEnabled: true },
            { reminderDayCloseEnabled: true },
          ],
        },
      },
      select: {
        id: true,
        config: {
          select: {
            timezone: true,
            reminderOffsetMinutes: true,
            reminderShiftStartEnabled: true,
            reminderShiftEndEnabled: true,
            reminderDayCloseEnabled: true,
          },
        },
      },
    });
    for (const tenant of tenants) {
      if (tenant.config === null) continue;
      try {
        await runTenant(app, tenant.id, tenant.config, now);
      } catch (err) {
        app.log.error({ err, tenantId: tenant.id }, "Shift reminders failed for a tenant");
      }
    }
  } catch (err) {
    app.log.error({ err }, "Shift reminders failed");
  }
}

interface TenantReminderConfig {
  timezone: string;
  reminderOffsetMinutes: number;
  reminderShiftStartEnabled: boolean;
  reminderShiftEndEnabled: boolean;
  reminderDayCloseEnabled: boolean;
}

async function runTenant(
  app: FastifyInstance,
  tenantId: string,
  config: TenantReminderConfig,
  now: Date,
): Promise<void> {
  const tz = config.timezone;
  const offset = clampReminderOffset(config.reminderOffsetMinutes);

  // Tenant-local days {today - 1, today}: an overnight shift of yesterday and a window that crosses
  // midnight are both seen. Day keys by calendar arithmetic on noon UTC, never a 24 h step.
  const today = dateStrInTz(now, tz);
  const dayKey = (daysAgo: number) =>
    new Date(new Date(`${today}T12:00:00Z`).getTime() - daysAgo * DAY_MS)
      .toISOString()
      .slice(0, 10);
  const yesterday = dayKey(1);
  const shiftFrom = new Date(`${yesterday}T00:00:00Z`); // @db.Date: calendar-day bounds (#493)
  const shiftTo = new Date(`${today}T00:00:00Z`);

  const scope = accessContextForJob(tenantId, JOB);
  const shifts = await getShiftsInRange(app.prisma, employeeScopeFor(scope), shiftFrom, shiftTo);

  // Stage 1 (pure): the START candidates.
  const candidates = config.reminderShiftStartEnabled
    ? shifts
        .map((shift) => ({ shift, ...shiftInstants(shift, tz) }))
        .filter(
          (c) =>
            !Number.isNaN(c.startUtc.getTime()) &&
            decideShiftStart({ startUtc: c.startUtc, offsetMinutes: offset, now, entries: [] })
              .send,
        )
    : [];
  if (candidates.length === 0) return;

  // Stage 2: reads for the candidate persons only.
  const employeeIds = [...new Set(candidates.map((c) => c.shift.employeeId))];

  // Population (D-05, P-609-09): one read per distinct candidate day. The recipient must be able to
  // log in (`user.isActive` is used here as a recipient lookup, not as a report population), be
  // employed on that day and never anonymised, and not exempt from time tracking. The recipient is
  // always the shift's own person.
  const people = new Map<string, Map<string, { userId: string; startOff: boolean }>>();
  for (const day of new Set(candidates.map((c) => c.day))) {
    const range = dayRangeUtc(day, tz);
    const rows = await app.prisma.employee.findMany({
      where: {
        tenantId,
        id: { in: employeeIds },
        isTimeTrackingExempt: false,
        user: { isActive: true },
        AND: [reportPopulationWhere(range.start, range.end)],
      },
      select: { id: true, userId: true, reminderShiftStartOff: true },
    });
    people.set(
      day,
      new Map(rows.map((r) => [r.id, { userId: r.userId, startOff: r.reminderShiftStartOff }])),
    );
  }

  // One day further back than the shifts: an entry started before midnight belongs to the day before.
  const entryFrom = new Date(`${dayKey(2)}T00:00:00Z`);
  const entries = await getRecordedWorkEntriesInRange(
    app.prisma,
    employeeScopeFor(scope, { employeeIds }),
    entryFrom,
    shiftTo,
  );
  const entriesOf = new Map<string, typeof entries>();
  for (const entry of entries) {
    const list = entriesOf.get(entry.employeeId) ?? [];
    list.push(entry);
    entriesOf.set(entry.employeeId, list);
  }

  // Every earlier START notice of these shifts, in any dismissal state (the dedupe key, D-06).
  const userIds = [
    ...new Set([...people.values()].flatMap((m) => [...m.values()].map((p) => p.userId))),
  ];
  const notified = await app.prisma.notification.findMany({
    where: {
      userId: { in: userIds },
      type: START_TYPE,
      relatedType: "Shift",
      relatedId: { in: candidates.map((c) => c.shift.id) },
    },
    select: { userId: true, type: true, relatedId: true },
  });
  const sent = new Set(
    notified.flatMap((n) =>
      n.relatedId === null ? [] : [shiftReminderKey(n.userId, n.type, n.relatedId)],
    ),
  );

  const skipped: SkipCounts = {};
  const skip = (reason: ReminderSkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  for (const candidate of candidates) {
    const { shift } = candidate;
    const person = people.get(candidate.day)?.get(shift.employeeId);
    if (person === undefined) {
      skip("NOT_IN_POPULATION");
      continue;
    }
    if (person.startOff) {
      skip("PERSON_OFF");
      continue;
    }
    const { userId } = person;
    const decision = decideShiftStart({
      startUtc: candidate.startUtc,
      offsetMinutes: offset,
      now,
      entries: entriesOf.get(shift.employeeId) ?? [],
    });
    if (!decision.send) {
      skip(decision.reason);
      continue;
    }
    const key = shiftReminderKey(userId, START_TYPE, shift.id);
    if (sent.has(key)) {
      skip("ALREADY_NOTIFIED");
      continue;
    }
    await app.notify({
      userId,
      tenantId,
      type: "REMINDER_SHIFT_START",
      title: "Schicht begonnen",
      message: `Deine Schicht hat um ${formatShiftTime(shift.startTime)} begonnen. Jetzt einstempeln?`,
      link: REMINDER_CLOCK_LINK,
      relatedType: "Shift",
      relatedId: shift.id,
    });
    sent.add(key);
  }
  app.log.debug({ tenantId, skipped }, "Shift reminders: start occasion evaluated");
}
