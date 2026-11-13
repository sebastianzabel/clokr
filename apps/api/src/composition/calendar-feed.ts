/**
 * Issue #597 — „Mein Dienstplan“ als Kalender-Abo: the public ICS feed of ONE person.
 *
 * Composition layer: it owns no model and no business rule, it only reads each context through its
 * `index.ts` — the token through the Unterbau (`resolveCalendarFeedToken`), the shifts through
 * Schichtplanung, leave and imposed absences through Abwesenheiten, the holidays at the work
 * location through the Unterbau resolver (fed with the person's own work entries, Zeiterfassung).
 *
 * The secret is the `token` query parameter (a calendar app cannot send a header). The route has no
 * `requireAuth`; every invalid token answers one identical 404, the route logs at `warn` only (no
 * request line) and the token is redacted in the API's own request log (`app.ts`); the web proxy
 * logs the path only, never the query.
 *
 * Content is minimal (DSGVO Art. 5 Abs. 1 lit. c, Art. 9 for sick leave): shifts as „Schicht“ with
 * the salon as location and nothing else (no note, no label, no integration name, no colleague);
 * effective leave and imposed absences as all-day events, sick leave neutral as „Abwesend“;
 * public holidays at the work location. Window: 30 days back, 180 days ahead.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fromZonedTime } from "date-fns-tz";
import {
  accessContextForJob,
  employeeScopeFor,
  holidaysAtWorkLocation,
  listSalons,
  resolveCalendarFeedToken,
} from "../contexts/platform";
import { getShiftsInRange } from "../contexts/scheduling";
import {
  DISPLAY_NAME,
  addOneDay,
  generateICal,
  getAbsencesOverlapping,
  getActiveLeaveOverlapping,
  isSickLeaveTypeCode,
  withHalfDayMarker,
  type ICalEvent,
} from "../contexts/absence";
import { getWorkedEntriesInRange } from "../contexts/time-tracking";
import { getTenantTimezone, todayInTz } from "../contexts/working-time-account";

const NOT_FOUND = { error: "Kalender nicht gefunden" } as const;
const DAYS_BACK = 30;
const DAYS_AHEAD = 180;
const DAY_MS = 86_400_000;

const querySchema = z.object({ token: z.string().max(80) });

const day = (d: Date) => d.toISOString().slice(0, 10);

/** The summary of a leave row: vacation and other kinds by name, sick leave neutral. */
function leaveSummary(code: string | null | undefined, halfDay: boolean): string {
  if (!code || isSickLeaveTypeCode(code as Parameters<typeof isSickLeaveTypeCode>[0]))
    return withHalfDayMarker("Abwesend", halfDay);
  const name = (DISPLAY_NAME as Record<string, string | undefined>)[code] ?? "Abwesend";
  return withHalfDayMarker(name, halfDay);
}

export async function calendarFeedRoutes(app: FastifyInstance) {
  app.get("/dienstplan.ics", {
    // No request line at info level: the path is the secret.
    logLevel: "warn",
    config: { rateLimit: { max: 60, timeWindow: "1 hour" } },
    schema: {
      tags: ["Profil"],
      description:
        "Public ICS feed of one person's shifts, leave and holidays (the token query parameter is the secret)",
    },
    handler: async (req, reply) => {
      const parsed = querySchema.safeParse(req.query ?? {});
      if (!parsed.success) return reply.code(404).send(NOT_FOUND);
      const token = parsed.data.token;
      const feed = await resolveCalendarFeedToken(app.prisma, token);
      if (!feed) return reply.code(404).send(NOT_FOUND);

      const { tenantId, employeeId } = feed;
      const scope = employeeScopeFor(accessContextForJob(tenantId, "calendar-feed"), {
        employeeId,
      });
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const today = todayInTz(tz);
      const from = new Date(today.getTime() - DAYS_BACK * DAY_MS);
      const to = new Date(today.getTime() + DAYS_AHEAD * DAY_MS);
      const events: ICalEvent[] = [];

      if (feed.shifts) {
        const [shifts, salons] = await Promise.all([
          getShiftsInRange(app.prisma, scope, from, to),
          listSalons(app.prisma, tenantId, { includeInactive: true }),
        ]);
        const salonName = new Map(salons.map((s) => [s.id, s.name]));
        for (const s of shifts) {
          // A shift the approved leave displaces does not take place.
          if (s.conflictsWithLeave) continue;
          const d = day(s.date);
          const start = fromZonedTime(`${d}T${s.startTime}:00`, tz);
          let end = fromZonedTime(`${d}T${s.endTime}:00`, tz);
          if (end <= start) end = fromZonedTime(`${addOneDay(d)}T${s.endTime}:00`, tz);
          events.push({
            uid: `shift-${s.id}@clokr`,
            summary: "Schicht",
            dtstart: d,
            dtend: addOneDay(d),
            timed: { start, end },
            location: s.salonId ? salonName.get(s.salonId) : undefined,
            status: "CONFIRMED",
          });
        }
      }

      if (feed.leave) {
        const [leave, absences] = await Promise.all([
          getActiveLeaveOverlapping(app.prisma, scope, from, to),
          getAbsencesOverlapping(app.prisma, scope, from, to),
        ]);
        for (const l of leave) {
          events.push({
            uid: `leave-${l.id}@clokr`,
            summary: leaveSummary(l.leaveType?.code, l.halfDay),
            dtstart: day(l.startDate),
            dtend: addOneDay(day(l.endDate)),
            status: "CONFIRMED",
          });
        }
        for (const a of absences) {
          events.push({
            uid: `absence-${a.id}@clokr`,
            summary: leaveSummary(a.type, Boolean(a.halfDay)),
            dtstart: day(a.startDate),
            dtend: addOneDay(day(a.endDate)),
            status: "CONFIRMED",
          });
        }
      }

      // Public holidays at the person's work location of each day (§ 2 EFZG). A tenant without an
      // active salon has no resolvable work location: the feed then simply carries no holiday.
      try {
        const entries = await getWorkedEntriesInRange(app.prisma, scope, from, to);
        const byEmployee = await holidaysAtWorkLocation(
          app.prisma,
          tenantId,
          [employeeId],
          day(from),
          day(to),
          entries,
        );
        for (const [d, name] of byEmployee.get(employeeId) ?? []) {
          events.push({
            uid: `holiday-${d}@clokr`,
            summary: name,
            dtstart: d,
            dtend: addOneDay(d),
            status: "CONFIRMED",
            categories: "HOLIDAY",
          });
        }
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, "calendar feed: holidays not resolvable");
      }

      return reply
        .header("Content-Type", "text/calendar; charset=utf-8")
        .header("Cache-Control", "private, max-age=900")
        .header("Content-Disposition", 'inline; filename="clokr-dienstplan.ics"')
        .send(generateICal("Clokr – Mein Dienstplan", events));
    },
  });
}
