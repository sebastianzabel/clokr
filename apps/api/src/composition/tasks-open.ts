/**
 * Issue #853 (D-853-21a, D-853-22) — the open tasks of the Aufgaben work queue that no
 * reach-correct notification carries.
 *
 * Read-only composition, no business rule: the missing clock-outs are found by Zeiterfassung's
 * own facade read, and WHICH of them the caller may see is decided by the Unterbau's per-entry
 * reach rule (`scopedTimeEntryIds`, Issue #85) — never re-derived here. The break findings stay
 * on the #85 notices (their recipient selection is proven reach-correct); § 3/§ 5 ArbZG checks
 * are save-time warnings without a stored open item, and an unconfirmed automatic break is the
 * employee's own task, so neither is a manager task of this endpoint.
 *
 * No write, no audit row, no new permission key: gated by `time-entry:read:ZUGEWIESEN`, the
 * permission the underlying read already requires.
 */
import { FastifyInstance } from "fastify";
import {
  requirePermission,
  accessContextFromRequest,
  resolveAccessReach,
  scopedTimeEntryIds, // Issue #85 (D-04) — the one per-entry scope resolver
} from "../contexts/platform";
import { findMissingClockOutEntries } from "../contexts/time-tracking";
import {
  addDaysUtc,
  dateStrInTz,
  getTenantTimezone,
  timeStrInTz,
  todayInTz,
} from "../contexts/working-time-account";

/** How many tenant-local days before today a missing clock-out stays a task. */
export const OPEN_TASKS_WINDOW_DAYS = 62;

/** The task type of a missing clock-out; the identifier is a control value, the label is display. */
export const TASK_TYPE_MISSING_CLOCK_OUT = "ausstempeln";

export interface OpenTask {
  type: string;
  id: string;
  employeeId: string;
  personName: string;
  day: string;
  startTime?: string;
  label: string;
  link: string;
}

export async function tasksOpenRoutes(app: FastifyInstance) {
  app.get("/", {
    schema: {
      tags: ["Aufgaben"],
      security: [{ bearerAuth: [] }],
      description:
        "Open tasks of the caller's reach that no notification carries: today only the missing clock-outs (open work entries of the last 62 tenant-local days before today, type ausstempeln). Only entries inside the caller's time-entry:read reach are returned; types lists the task types this endpoint can answer. Read-only.",
    },
    preHandler: requirePermission("time-entry:read:ZUGEWIESEN"),
    handler: async (req) => {
      const tenantId = req.user.tenantId;
      const tz = await getTenantTimezone(app.prisma, tenantId);

      // Calendar-day bounds for the `@db.Date` column (Issue #493): [today - 62, today).
      const today = todayInTz(tz);
      const since = addDaysUtc(today, -OPEN_TASKS_WINDOW_DAYS);

      const candidates = await findMissingClockOutEntries(app.prisma, tenantId, {
        before: today,
        since,
      });

      // Issue #85 (D-04): the entry decides. A whole-tenant reach is "all"; a scoped reach names
      // the in-scope entry ids, and a candidate outside them is never returned.
      const reach = await resolveAccessReach(
        app.prisma,
        accessContextFromRequest(req),
        "time-entry:read:ZUGEWIESEN",
      );
      const inScope = await scopedTimeEntryIds(
        app.prisma,
        tenantId,
        reach,
        since,
        addDaysUtc(today, -1),
      );
      const allowed = inScope === "all" ? null : new Set(inScope);

      const tasks: OpenTask[] = candidates
        .filter((entry) => allowed === null || allowed.has(entry.id))
        .map((entry) => {
          const day = dateStrInTz(entry.date, "UTC");
          return {
            type: TASK_TYPE_MISSING_CLOCK_OUT,
            id: entry.id,
            employeeId: entry.employeeId,
            personName: `${entry.employee.firstName} ${entry.employee.lastName}`,
            day,
            startTime: timeStrInTz(entry.startTime, tz),
            label: "Ausstempeln fehlt",
            link: `/team/zeiten?employeeId=${encodeURIComponent(entry.employeeId)}&date=${day}`,
          };
        });

      return { types: [TASK_TYPE_MISSING_CLOCK_OUT], tasks };
    },
  });
}
