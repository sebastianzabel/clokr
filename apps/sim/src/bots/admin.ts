/**
 * Admin behaviour (Issue #715): hires on the hire day, contract changes on the first of a month,
 * company holidays, exits and, three days after an exit, the DSGVO anonymization.
 */
import type { SimTenantKey } from "../plan";
import { createEmployee } from "../provision/tenant-api";
import { addDays, dayOfMonth, localIso } from "../tz";
import { BotContext } from "./context";

export async function adminDay(ctx: BotContext, tenantKey: SimTenantKey): Promise<void> {
  const { plan, state } = ctx.tenant(tenantKey);
  const admin = await ctx.sessionFor(state.adminEmail, state.adminPassword);
  const tz = ctx.config.tz;

  // Hires.
  for (const person of plan.persons) {
    const ids = state.persons[person.key];
    if (ids.created || person.hireDate > ctx.day) continue;
    const res = await ctx
      .call("admin.hire", async () => {
        const created = await createEmployee(
          ctx.api,
          admin.token,
          person,
          state.salonIds[person.homeSalonIndex],
          tz,
        );
        state.persons[person.key] = { ...created, created: true, exited: false, anonymized: false };
        return { status: 201, body: created, ms: 0 };
      })
      .catch(() => null);
    void res;
  }

  // Exits and, three days later, the anonymization.
  for (const person of plan.persons) {
    const ids = state.persons[person.key];
    if (!ids.created) continue;
    if (person.plannedExitDay === ctx.day && !ids.exited) {
      const res = await ctx.call("admin.exit", () =>
        ctx.api.patch(
          `/api/v1/employees/${ids.employeeId}`,
          { exitDate: localIso(ctx.day, "00:00", tz) },
          admin.token,
        ),
      );
      if (res?.status === 200) ids.exited = true;
    }
    if (
      ids.exited &&
      !ids.anonymized &&
      person.plannedExitDay &&
      addDays(person.plannedExitDay, 3) <= ctx.day
    ) {
      const res = await ctx.call("admin.anonymize", () =>
        ctx.api.delete(`/api/v1/employees/${ids.employeeId}`, admin.token),
      );
      if (res && res.status < 300) ids.anonymized = true;
    }
  }

  // First of the month: a contract change for a few full-time people, one company holiday.
  if (dayOfMonth(ctx.day) === 1) {
    const rng = ctx.rng("admin-contract", tenantKey);
    for (const person of plan.persons) {
      const ids = state.persons[person.key];
      if (!ids.created || ids.exited || person.scheduleType !== "FIXED_SCHEDULE") continue;
      if (person.classification !== "VOLLZEIT" || !rng.chance(0.05)) continue;
      const weeklyHours = ctx.progress.weeklyHours[person.key] === 36 ? 40 : 36;
      const perDay = weeklyHours / person.workDays.length;
      const hours = (d: number) => (person.workDays.includes(d) ? perDay : 0);
      const res = await ctx.call("admin.contract", () =>
        ctx.api.put(
          `/api/v1/settings/work/${ids.employeeId}`,
          {
            type: "FIXED_SCHEDULE",
            weeklyHours,
            sundayHours: hours(0),
            mondayHours: hours(1),
            tuesdayHours: hours(2),
            wednesdayHours: hours(3),
            thursdayHours: hours(4),
            fridayHours: hours(5),
            saturdayHours: hours(6),
            workDays: person.workDays,
            validFrom: ctx.day,
          },
          admin.token,
        ),
      );
      if (res?.status === 200) ctx.progress.weeklyHours[person.key] = weeklyHours;
    }
    const monthKey = `${tenantKey}|${ctx.day.slice(0, 7)}`;
    if (!ctx.progress.holidayMonths.includes(monthKey)) {
      const salonId = ctx.rng("holiday", tenantKey).pick(state.salonIds);
      await ctx.call("admin.holiday", () =>
        ctx.api.post(
          "/api/v1/holidays",
          { date: addDays(ctx.day, 14), name: "Sim Betriebsfeier", salonId },
          admin.token,
        ),
      );
      ctx.progress.holidayMonths.push(monthKey);
    }
  }
}
