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
  holidaysForSalon,
  reportPopulationWhere, // Issue #613: employed on the day and never anonymised
} from "../platform";
import { dateStrInTz, dayRangeUtc } from "../working-time-account";
import { getActiveLeaveOverlapping, getAbsencesOverlapping } from "../absence";
import { getShiftsInRange } from "../scheduling";
import { getRecordedWorkEntriesInRange } from "./facade/time-entries";
import {
  DAY_CLOSE_WINDOW_MINUTES,
  REMINDER_CLOCK_LINK,
  REMINDER_WINDOW_MINUTES,
  clampReminderOffset,
  dayCloseInstant,
  dayCloseLink,
  dayCloseReminderKey,
  decideDayClose,
  decideShiftEnd,
  decideShiftStart,
  exclusionFor,
  formatShiftTime,
  shiftInstantKey,
  shiftDaysOf,
  shiftInstants,
  shiftReminderKey,
  type DayRange,
  type ExclusionKind,
  type ReminderEntry,
  currentOpenPeriodStart,
  windowContains,
  type ReminderSkipReason,
} from "./shift-reminders";

const JOB = "shift-reminders";
/** The types of the dedupe read; each emit site below keeps its own literal (the registry scanner reads it). */
const START_TYPE = "REMINDER_SHIFT_START";
const END_TYPE = "REMINDER_SHIFT_END";
const DAY_CLOSE_TYPE = "REMINDER_DAY_CLOSE";
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Whether a shift-end reminder already told the person to clock out of THIS open period of the entry
 * (D-06, WR-01): the 10-hour `CLOCK_OUT_REMINDER` then stays silent. All of these must hold:
 * the notice is a `REMINDER_SHIFT_END` of the entry's person, created at or after the start of the
 * entry's current open period (a re-open starts a new one), and about a shift of the entry's own day
 * (an end notice for another day's shift says nothing about this entry). Any doubt answers false: a
 * duplicate reminder is acceptable, a suppressed one is not.
 */
export async function shiftEndNoticeCoversEntry(
  app: FastifyInstance,
  tenantId: string,
  entry: { employeeId: string; userId: string; date: Date; startTime: Date; updatedAt: Date },
): Promise<boolean> {
  const notices = await app.prisma.notification.findMany({
    where: {
      userId: entry.userId,
      type: END_TYPE,
      relatedType: "Shift",
      createdAt: { gte: currentOpenPeriodStart(entry) },
    },
    select: { relatedId: true },
  });
  const noticeShiftIds = new Set(
    notices.flatMap((n) => (n.relatedId === null ? [] : [n.relatedId])),
  );
  if (noticeShiftIds.size === 0) return false;
  const scope = accessContextForJob(tenantId, "clock-out-reminder");
  const shiftsOfDay = await getShiftsInRange(
    app.prisma,
    employeeScopeFor(scope, { employeeIds: [entry.employeeId] }),
    entry.date,
    entry.date,
  );
  return shiftsOfDay.some((shift) => noticeShiftIds.has(shift.id));
}

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
  // debug, not info: the job runs every five minutes on every pod (288 lines a day each)
  app.log.debug("Attendance checker: evaluating shift reminders (Feature 12)");
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
            reminderDayCloseTime: true,
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
  reminderDayCloseTime: string;
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

  // Tenant-local days {today - 1, today, today + 1}: an overnight shift of yesterday, a window that
  // crosses midnight and the next shift of an end that falls just before midnight are all seen. Day
  // keys by calendar arithmetic on noon UTC, never a 24 h step. A shift of tomorrow is read only as a
  // neighbour: its own windows are not open yet, so it is never a candidate.
  const today = dateStrInTz(now, tz);
  const dayKey = (daysAgo: number) =>
    new Date(new Date(`${today}T12:00:00Z`).getTime() - daysAgo * DAY_MS)
      .toISOString()
      .slice(0, 10);
  const yesterday = dayKey(1);
  const shiftFrom = new Date(`${yesterday}T00:00:00Z`); // @db.Date: calendar-day bounds (#493)
  const shiftTo = new Date(`${dayKey(-1)}T00:00:00Z`);

  const scope = accessContextForJob(tenantId, JOB);
  const shifts = await getShiftsInRange(app.prisma, employeeScopeFor(scope), shiftFrom, shiftTo);

  // Stage 1 (pure): the candidates per occasion, from the shifts alone.
  const parsed = shifts
    .map((shift) => ({ shift, ...shiftInstants(shift, tz) }))
    .filter((c) => !Number.isNaN(c.startUtc.getTime()) && !Number.isNaN(c.endUtc.getTime()));
  const offsetMs = offset * MINUTE_MS;
  const startCandidates = config.reminderShiftStartEnabled
    ? parsed.filter((c) =>
        windowContains(new Date(c.startUtc.getTime() + offsetMs), REMINDER_WINDOW_MINUTES, now),
      )
    : [];
  const endCandidates = config.reminderShiftEndEnabled
    ? parsed.filter((c) =>
        windowContains(new Date(c.endUtc.getTime() + offsetMs), REMINDER_WINDOW_MINUTES, now),
      )
    : [];
  // DAY_CLOSE: per (person, day) for each read day whose evening window contains `now` and that has
  // at least one shift ended by the evening time. The entry-dependent rules follow in stage 2.
  const dayCloseCandidates: {
    employeeId: string;
    day: string;
    closeUtc: Date;
    shifts: typeof parsed;
  }[] = [];
  if (config.reminderDayCloseEnabled) {
    for (const day of [yesterday, today]) {
      const closeUtc = dayCloseInstant(day, config.reminderDayCloseTime, tz);
      if (!windowContains(closeUtc, DAY_CLOSE_WINDOW_MINUTES, now)) continue;
      const byPerson = new Map<string, typeof parsed>();
      for (const c of parsed.filter((p) => p.day === day)) {
        const list = byPerson.get(c.shift.employeeId) ?? [];
        list.push(c);
        byPerson.set(c.shift.employeeId, list);
      }
      for (const [employeeId, personShifts] of byPerson) {
        // Pure pre-filter on the shifts alone; the entry rules run in stage 2.
        const pre = decideDayClose({
          day,
          closeUtc,
          now,
          shifts: personShifts.map((c) => ({
            endUtc: c.endUtc,
            conflictsWithLeave: c.shift.conflictsWithLeave,
          })),
          entries: [],
        });
        if (pre.send) dayCloseCandidates.push({ employeeId, day, closeUtc, shifts: personShifts });
      }
    }
  }
  const candidates = [
    ...startCandidates.map((c) => ({ employeeId: c.shift.employeeId, day: c.day })),
    ...endCandidates.map((c) => ({ employeeId: c.shift.employeeId, day: c.day })),
    ...dayCloseCandidates.map((c) => ({ employeeId: c.employeeId, day: c.day })),
  ];
  if (candidates.length === 0) return;

  // Stage 2: reads for the candidate persons only.
  const employeeIds = [...new Set(candidates.map((c) => c.employeeId))];

  // Population (D-05, P-609-09): one read per distinct candidate day. The recipient must be able to
  // log in (`user.isActive` is used here as a recipient lookup, not as a report population), be
  // employed on that day and never anonymised, and not exempt from time tracking. The recipient is
  // always the shift's own person.
  interface Person {
    userId: string;
    startOff: boolean;
    endOff: boolean;
    dayCloseOff: boolean;
  }
  const people = new Map<string, Map<string, Person>>();
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
      select: {
        id: true,
        userId: true,
        reminderShiftStartOff: true,
        reminderShiftEndOff: true,
        reminderDayCloseOff: true,
      },
    });
    people.set(
      day,
      new Map(
        rows.map((r) => [
          r.id,
          {
            userId: r.userId,
            startOff: r.reminderShiftStartOff,
            endOff: r.reminderShiftEndOff,
            dayCloseOff: r.reminderDayCloseOff,
          },
        ]),
      ),
    );
  }

  // Entries from two days before today through today: one day further back than the shifts' first
  // day (yesterday), so an entry clocked in before midnight (it carries the day before) is read,
  // and so is a still-open forgotten entry of an earlier day, which the decisions recognise and
  // ignore (WR-03).
  const entryFrom = new Date(`${dayKey(2)}T00:00:00Z`);
  const entries = await getRecordedWorkEntriesInRange(
    app.prisma,
    employeeScopeFor(scope, { employeeIds }),
    entryFrom,
    new Date(`${today}T00:00:00Z`),
  );
  // The entries as the kernel reads them: each carries its own tenant-local day (WR-03).
  const entriesOf = new Map<string, ReminderEntry[]>();
  for (const entry of entries) {
    const list = entriesOf.get(entry.employeeId) ?? [];
    list.push({
      startTime: entry.startTime,
      endTime: entry.endTime,
      isInvalid: entry.isInvalid,
      day: entry.date.toISOString().slice(0, 10),
    });
    entriesOf.set(entry.employeeId, list);
  }

  // Exclusions (AC-3, D-05, D-12): effective leave and imposed absences of the candidate persons
  // around the candidate days, and the holidays of the candidate shifts' salons - each read through
  // the owning context's facade. A PENDING request is not effective leave and does not silence.
  const candidateDays = [...new Set(candidates.map((c) => c.day))].sort((a, b) =>
    a.localeCompare(b),
  );
  const exclusionFrom = new Date(`${candidateDays[0]}T00:00:00Z`);
  const exclusionTo = new Date(`${candidateDays[candidateDays.length - 1]}T00:00:00Z`);
  const exclusionScope = employeeScopeFor(scope, { employeeIds });
  const [leaveRows, absenceRows] = await Promise.all([
    getActiveLeaveOverlapping(app.prisma, exclusionScope, exclusionFrom, exclusionTo),
    getAbsencesOverlapping(app.prisma, exclusionScope, exclusionFrom, exclusionTo),
  ]);
  const toRanges = (rows: { employeeId: string; startDate: Date; endDate: Date }[]) => {
    const byPerson = new Map<string, DayRange[]>();
    for (const r of rows) {
      const list = byPerson.get(r.employeeId) ?? [];
      list.push({
        startDay: r.startDate.toISOString().slice(0, 10),
        endDay: r.endDate.toISOString().slice(0, 10),
      });
      byPerson.set(r.employeeId, list);
    }
    return byPerson;
  };
  const leaveOf = toRanges(leaveRows);
  const absenceOf = toRanges(absenceRows);
  const holidaySalonDays = new Map<string, boolean>();
  const salonDayPairs = [
    ...startCandidates.map((c) => ({ salonId: c.shift.salonId, day: c.day })),
    ...endCandidates.map((c) => ({ salonId: c.shift.salonId, day: c.day })),
    ...dayCloseCandidates.flatMap((c) =>
      c.shifts.map((o) => ({ salonId: o.shift.salonId, day: c.day })),
    ),
  ];
  for (const { salonId, day } of salonDayPairs) {
    const key = `${salonId}|${day}`;
    if (holidaySalonDays.has(key)) continue;
    holidaySalonDays.set(
      key,
      (await holidaysForSalon(app.prisma, tenantId, salonId, day, day)).length > 0,
    );
  }
  const exclusionOf = (c: {
    shift: { employeeId: string; salonId: string; conflictsWithLeave: boolean };
    day: string;
  }): ExclusionKind | null =>
    exclusionFor(c.day, {
      leave: leaveOf.get(c.shift.employeeId) ?? [],
      absences: absenceOf.get(c.shift.employeeId) ?? [],
      holidayDays: holidaySalonDays.get(`${c.shift.salonId}|${c.day}`) === true ? [c.day] : [],
      flagged: c.shift.conflictsWithLeave,
    });

  // Every earlier START/END notice of these shifts, in any dismissal state (the dedupe key, D-06).
  const userIds = [
    ...new Set([...people.values()].flatMap((m) => [...m.values()].map((p) => p.userId))),
  ];
  const shiftIds = [...startCandidates, ...endCandidates].map((c) => c.shift.id);
  const dayRelatedIds = dayCloseCandidates.map((c) => `${c.employeeId}:${c.day}`);
  const notified = await app.prisma.notification.findMany({
    where: {
      userId: { in: userIds },
      OR: [
        { type: { in: [START_TYPE, END_TYPE] }, relatedType: "Shift", relatedId: { in: shiftIds } },
        { type: DAY_CLOSE_TYPE, relatedType: "EmployeeDay", relatedId: { in: dayRelatedIds } },
      ],
    },
    select: { userId: true, type: true, relatedId: true },
  });
  // The instant of every candidate shift per occasion: a notice of one shift also covers a second
  // shift of the same person that starts (or ends) at the identical instant ("exactly one reminder").
  const startInstantOf = new Map(startCandidates.map((c) => [c.shift.id, c.startUtc]));
  const endInstantOf = new Map(endCandidates.map((c) => [c.shift.id, c.endUtc]));
  const sent = new Set(
    notified.flatMap((n) => {
      if (n.relatedId === null) return [];
      if (n.type === DAY_CLOSE_TYPE) {
        const [employeeId = "", day = ""] = n.relatedId.split(":");
        return [dayCloseReminderKey(n.userId, employeeId, day)];
      }
      const keys = [shiftReminderKey(n.userId, n.type, n.relatedId)];
      const instant = (n.type === START_TYPE ? startInstantOf : endInstantOf).get(n.relatedId);
      if (instant !== undefined) keys.push(shiftInstantKey(n.userId, n.type, instant));
      return keys;
    }),
  );

  const skipped: SkipCounts = {};
  const skip = (reason: ReminderSkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  for (const candidate of startCandidates) {
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
      shiftDays: shiftDaysOf(candidate),
      offsetMinutes: offset,
      now,
      entries: entriesOf.get(shift.employeeId) ?? [],
      exclusion: exclusionOf(candidate),
    });
    if (!decision.send) {
      skip(decision.reason);
      continue;
    }
    const key = shiftReminderKey(userId, START_TYPE, shift.id);
    const instantKey = shiftInstantKey(userId, START_TYPE, candidate.startUtc);
    if (sent.has(key) || sent.has(instantKey)) {
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
    sent.add(instantKey);
  }

  for (const candidate of endCandidates) {
    const { shift } = candidate;
    const person = people.get(candidate.day)?.get(shift.employeeId);
    if (person === undefined) {
      skip("NOT_IN_POPULATION");
      continue;
    }
    if (person.endOff) {
      skip("PERSON_OFF");
      continue;
    }
    const { userId } = person;
    const decision = decideShiftEnd({
      startUtc: candidate.startUtc,
      endUtc: candidate.endUtc,
      shiftDays: shiftDaysOf(candidate),
      offsetMinutes: offset,
      now,
      entries: entriesOf.get(shift.employeeId) ?? [],
      // A shift that is not worked (flagged as a leave conflict, or silent that day) cannot follow
      // this one: the person is not expected to keep working for it (WR-04).
      otherShifts: parsed
        .filter(
          (o) =>
            o.shift.employeeId === shift.employeeId &&
            o.shift.id !== shift.id &&
            !o.shift.conflictsWithLeave &&
            exclusionOf(o) === null,
        )
        .map((o) => ({ startUtc: o.startUtc, endUtc: o.endUtc })),
      exclusion: exclusionOf(candidate),
    });
    if (!decision.send) {
      skip(decision.reason);
      continue;
    }
    const key = shiftReminderKey(userId, END_TYPE, shift.id);
    const instantKey = shiftInstantKey(userId, END_TYPE, candidate.endUtc);
    if (sent.has(key) || sent.has(instantKey)) {
      skip("ALREADY_NOTIFIED");
      continue;
    }
    await app.notify({
      userId,
      tenantId,
      type: "REMINDER_SHIFT_END",
      title: "Schichtende",
      message: `Deine Schicht endete um ${formatShiftTime(shift.endTime)}. Feierabend? Jetzt ausstempeln.`,
      link: REMINDER_CLOCK_LINK,
      relatedType: "Shift",
      relatedId: shift.id,
    });
    sent.add(key);
    sent.add(instantKey);
  }
  for (const candidate of dayCloseCandidates) {
    const { employeeId, day } = candidate;
    const person = people.get(day)?.get(employeeId);
    if (person === undefined) {
      skip("NOT_IN_POPULATION");
      continue;
    }
    if (person.dayCloseOff) {
      skip("PERSON_OFF");
      continue;
    }
    const { userId } = person;
    const decision = decideDayClose({
      day,
      closeUtc: candidate.closeUtc,
      now,
      shifts: candidate.shifts.map((c) => ({
        endUtc: c.endUtc,
        conflictsWithLeave: c.shift.conflictsWithLeave,
        exclusion: exclusionOf(c),
      })),
      entries: entriesOf.get(employeeId) ?? [],
    });
    if (!decision.send) {
      skip(decision.reason);
      continue;
    }
    const key = dayCloseReminderKey(userId, employeeId, day);
    if (sent.has(key)) {
      skip("ALREADY_NOTIFIED");
      continue;
    }
    await app.notify({
      userId,
      tenantId,
      type: "REMINDER_DAY_CLOSE",
      title: "Zeit fehlt",
      message: "Heute fehlt noch deine Zeit. Trag sie jetzt ein.",
      link: dayCloseLink(day),
      relatedType: "EmployeeDay",
      relatedId: `${employeeId}:${day}`,
    });
    sent.add(key);
  }
  app.log.debug({ tenantId, skipped }, "Shift reminders: occasions evaluated");
}
