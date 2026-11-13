/**
 * Invariants that compare the data with what the bots deliberately did (Issue #715): ArbZG and
 * break findings may exist where, and only where, a bot produced them on purpose; the second
 * tenant's isolation probes must all have been answered identically; the bots must never have
 * seen a server error.
 */
import type { Intent } from "../bots/context";
import { addDays } from "../tz";
import { result } from "./invariants-db";
import type { CheckContext, Finding, Invariant } from "./types";

/** Is a finding of this person on this day explained by a deliberate bot action? */
export function isIntended(intents: readonly Intent[], person: string, day: string): boolean {
  const previous = addDays(day, -1);
  return intents.some((i) => i.person === person && (i.date === day || i.date === previous));
}

interface DayRow {
  employee: string;
  day: string;
  minutes: string | number;
}

export const arbzgOnlyWhereIntended: Invariant = {
  id: "arbzg.only-intended",
  title: "ArbZG and break findings exist only where a bot caused them",
  async run(ctx: CheckContext) {
    const personOf = new Map<string, string>();
    for (const tenant of ["chain", "small"] as const) {
      const state = ctx.state.tenants[tenant];
      for (const [key, ids] of Object.entries(state?.persons ?? {}))
        personOf.set(ids.employeeId, key);
    }
    const since = addDays(ctx.today, -62);
    const longDays = await ctx.db.query<DayRow>(
      `SELECT "employeeId" AS employee, to_char("date", 'YYYY-MM-DD') AS day,
              sum(extract(epoch FROM ("endTime" - "startTime")) / 60 - "breakMinutes") AS minutes
         FROM "TimeEntry"
        WHERE "deletedAt" IS NULL AND "endTime" IS NOT NULL AND "type" = 'WORK' AND "date" >= $1::date
        GROUP BY "employeeId", "date"
       HAVING sum(extract(epoch FROM ("endTime" - "startTime")) / 60 - "breakMinutes") > 600`,
      [since],
    );
    const noBreak = await ctx.db.query<DayRow>(
      `SELECT "employeeId" AS employee, to_char("date", 'YYYY-MM-DD') AS day,
              extract(epoch FROM ("endTime" - "startTime")) / 60 AS minutes
         FROM "TimeEntry"
        WHERE "deletedAt" IS NULL AND "endTime" IS NOT NULL AND "type" = 'WORK' AND "date" >= $1::date
          AND extract(epoch FROM ("endTime" - "startTime")) / 60 > 360 AND "breakMinutes" < 30`,
      [since],
    );
    const examinedRes = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM "TimeEntry" WHERE "deletedAt" IS NULL AND "endTime" IS NOT NULL AND "date" >= $1::date`,
      [since],
    );
    const findings: Finding[] = [];
    const check = (rows: DayRow[], kind: string) => {
      for (const row of rows) {
        const person = personOf.get(row.employee);
        if (person && isIntended(ctx.progress.intents, person, row.day)) continue;
        findings.push({
          invariant: "arbzg.only-intended",
          key: `arbzg:${kind}:${row.employee}:${row.day}`,
          group: `arbzg:${kind}`,
          message: `Employee ${row.employee} has an unplanned ${kind} finding on ${row.day} (${Math.round(Number(row.minutes))} min).`,
        });
      }
    };
    check(longDays.rows, "over-10h-day");
    check(noBreak.rows, "missing-break");
    return result(arbzgOnlyWhereIntended, Number(examinedRes.rows[0]?.n ?? 0), findings);
  },
};

export const tenantIsolationProbes: Invariant = {
  id: "tenant.isolation",
  title: "Foreign ids answer exactly like unknown ids",
  async run(ctx: CheckContext) {
    const findings: Finding[] = [];
    let examined = 0;
    for (const log of ctx.dayLogs) {
      for (const probe of log.isolation) {
        examined += 1;
        if (probe.identical && probe.foreignStatus === 404) continue;
        findings.push({
          invariant: "tenant.isolation",
          key: `isolation:${log.date}:${probe.probe}`,
          group: `isolation:${probe.probe}`,
          message: `${probe.probe} on ${log.date}: foreign id answered ${probe.foreignStatus}, unknown id ${probe.unknownStatus}${probe.identical ? "" : " (bodies differ)"}.`,
        });
      }
    }
    return result(tenantIsolationProbes, examined, findings);
  },
};

export const noServerErrors: Invariant = {
  id: "api.no-server-errors",
  title: "The bots never met a server error",
  async run(ctx: CheckContext) {
    const findings: Finding[] = [];
    let examined = 0;
    for (const log of ctx.dayLogs) {
      examined += Object.values(log.actions).reduce((n, a) => n + a.ok + a.refused + a.error, 0);
      const byAction = new Map<string, number>();
      for (const a of log.anomalies)
        byAction.set(`${a.action}:${a.status}`, (byAction.get(`${a.action}:${a.status}`) ?? 0) + 1);
      for (const [what, n] of byAction) {
        findings.push({
          invariant: "api.no-server-errors",
          key: `server-error:${log.date}:${what}`,
          group: `server-error:${what}`,
          message: `On ${log.date} the action ${what.split(":")[0]} met status ${what.split(":")[1]} ${n} time(s).`,
        });
      }
    }
    return result(noServerErrors, examined, findings);
  },
};

export const RULE_INVARIANTS: Invariant[] = [
  arbzgOnlyWhereIntended,
  tenantIsolationProbes,
  noServerErrors,
];
