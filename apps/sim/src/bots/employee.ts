/**
 * Employee behaviour of one simulated day (Issue #715). Every person acts through the interface
 * their contract and channel give them: the web API with their own login, the NFC terminal key or
 * the WLAN presence source. Decisions come from seeded streams keyed by day and person.
 */
import type { PersonSpec, SimTenantKey } from "../plan";
import { macFor } from "../provision/index";
import { addDays, localIso, weekdayOf } from "../tz";
import { BotContext } from "./context";
import { blockedDay, minutesToHhmm, plannedDay, type PlannedDay } from "./schedule";

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

const RETRO_WINDOW_DAYS = 10;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

interface EntryPlan {
  start: string;
  end: string;
  breaks: { start: string; end: string }[];
  intent: "LONG_DAY" | "NO_BREAK" | null;
}

/** Turns the plan into what actually happened: late arrival, jitter, the odd bad day. */
export function realizeDay(
  planned: PlannedDay,
  traits: PersonSpec["traits"],
  minor: boolean,
  rng: ReturnType<BotContext["rng"]>,
): EntryPlan {
  let start = toMinutes(planned.start);
  let end = toMinutes(planned.end);
  if (rng.chance(traits.lateness)) start += rng.int(5, 25);
  end += rng.int(-10, 20);
  let intent: EntryPlan["intent"] = null;
  let breakMinutes = planned.breakMinutes;
  // Minors are never pushed past the statutory day: the intended findings are for adults.
  if (!minor && rng.chance(traits.violationProne)) {
    if (rng.chance(0.5)) {
      end = start + 10 * 60 + 40 + breakMinutes;
      intent = "LONG_DAY";
    } else if (end - start > 6 * 60 + 30) {
      breakMinutes = 0;
      intent = "NO_BREAK";
    }
  }
  const breaks: EntryPlan["breaks"] = [];
  if (breakMinutes > 0) {
    const breakStart = start + Math.floor((end - start) / 2) - 15;
    breaks.push({
      start: minutesToHhmm(breakStart),
      end: minutesToHhmm(breakStart + breakMinutes),
    });
  }
  return { start: minutesToHhmm(start), end: minutesToHhmm(end), breaks, intent };
}

async function recordSick(
  ctx: BotContext,
  person: PersonSpec,
  tenant: SimTenantKey,
  rng: ReturnType<BotContext["rng"]>,
) {
  const days = rng.int(1, 3);
  const res = await ctx.call("leave.sick", async () =>
    ctx.api.post<{ id: string }>(
      "/api/v1/leave/requests",
      {
        type: rng.chance(0.2) ? "SICK_CHILD" : "SICK",
        startDate: ctx.day,
        endDate: addDays(ctx.day, days - 1),
      },
      (await ctx.personSession(person)).token,
    ),
  );
  if (res?.status === 201) {
    (ctx.progress.leave[person.key] ??= []).push({
      id: res.body.id,
      start: ctx.day,
      end: addDays(ctx.day, days - 1),
      type: "SICK",
      status: "PENDING",
    });
  }
  void tenant;
}

async function requestVacation(
  ctx: BotContext,
  person: PersonSpec,
  rng: ReturnType<BotContext["rng"]>,
) {
  const start = addDays(ctx.day, rng.int(14, 45));
  const end = addDays(start, rng.int(0, 4));
  const res = await ctx.call("leave.vacation", async () =>
    ctx.api.post<{ id: string }>(
      "/api/v1/leave/requests",
      { type: "VACATION", startDate: start, endDate: end },
      (await ctx.personSession(person)).token,
    ),
  );
  if (res?.status === 201) {
    (ctx.progress.leave[person.key] ??= []).push({
      id: res.body.id,
      start,
      end,
      type: "VACATION",
      status: "PENDING",
    });
  }
}

async function bookEntry(
  ctx: BotContext,
  person: PersonSpec,
  tenantKey: SimTenantKey,
  salonId: string,
  entry: EntryPlan,
  rng: ReturnType<BotContext["rng"]>,
) {
  const tenant = ctx.tenant(tenantKey).state;
  const day = ctx.day;
  const tz = ctx.config.tz;

  // NFC users sometimes only tap in and forget to tap out: an open entry the system has to deal with.
  // A terminal tap is stamped with the server clock, so it can only happen on the real day.
  if (
    day === ctx.realToday &&
    person.channel === "NFC" &&
    person.nfcCardId &&
    rng.chance(person.traits.forgetsClockOut * 4)
  ) {
    const res = await ctx.call("clock.nfc", () =>
      ctx.api.request("POST", "/api/v1/time-entries/nfc-punch", {
        token: tenant.terminalKey ?? "",
        body: { nfcCardId: person.nfcCardId },
      }),
    );
    if (res?.status === 200)
      ctx.intend({ tenant: tenantKey, person: person.key, kind: "OPEN_ENTRY" });
    return;
  }

  if (person.channel === "WIFI") {
    const mac = macFor(ctx.config.seed, person.key);
    const send = (eventType: "connected" | "disconnected", at: string) =>
      ctx.call("clock.wifi", () =>
        ctx.api.request("POST", "/api/v1/presence/events", {
          token: tenant.presenceKey ?? "",
          body: { mac, eventType, timestamp: localIso(day, at, tz), adapter: "fritzbox" },
        }),
      );
    const inRes = await send("connected", entry.start);
    const outRes = await send("disconnected", entry.end);
    if (inRes?.status === 200 && outRes?.status === 200) {
      if (entry.intent) ctx.intend({ tenant: tenantKey, person: person.key, kind: entry.intent });
      else if (entry.breaks.length > 0) await addBreakByHand(ctx, person, tenantKey, entry);
      return;
    }
    // A refused presence event (for instance an unknown device) falls back to the web path below.
  }

  // The product refuses a manual entry older than its retro window (10 days; older ones need a
  // Zeitnachtrag). A replay of older days therefore has no web entries; this is counted, not hidden.
  if (daysBetween(day, ctx.realToday) > RETRO_WINDOW_DAYS - 1) {
    const skipped = (ctx.log.actions["entry.skipped-retro"] ??= {
      ok: 0,
      refused: 0,
      error: 0,
      totalMs: 0,
      maxMs: 0,
    });
    skipped.ok += 1;
    return;
  }
  const session = await ctx.personSession(person);
  const res = await ctx.call("entry.web", () =>
    ctx.api.post<{ entry?: { id: string } }>(
      "/api/v1/time-entries",
      {
        date: day,
        startTime: localIso(day, entry.start, tz),
        endTime: localIso(day, entry.end, tz),
        breaks: entry.breaks.map((b) => ({
          startTime: localIso(day, b.start, tz),
          endTime: localIso(day, b.end, tz),
        })),
        salonId,
        source: "MANUAL",
      },
      session.token,
    ),
  );
  if (res?.status === 201) {
    if (entry.intent) ctx.intend({ tenant: tenantKey, person: person.key, kind: entry.intent });
    const id = res.body.entry?.id;
    if (id) {
      // The sample feeds the isolation probes of the OTHER tenant, so it holds chain entries only.
      if (tenantKey === "chain" && ctx.progress.sampleEntryIds.length < 40) {
        ctx.progress.sampleEntryIds.push(id);
      }
      ctx.createdEntries.push({ id, endTime: localIso(day, entry.end, tz), tenant: tenantKey });
    }
  }
}

/**
 * A WLAN entry carries presence only. The person adds their break by hand afterwards, like any
 * employee does; where that is impossible (a replayed day beyond the retro window) the missing
 * break is a deliberate state of the simulation and recorded as an intent.
 */
async function addBreakByHand(
  ctx: BotContext,
  person: PersonSpec,
  tenantKey: SimTenantKey,
  entry: EntryPlan,
): Promise<void> {
  const day = ctx.day;
  const noBreak = () => ctx.intend({ tenant: tenantKey, person: person.key, kind: "NO_BREAK" });
  if (daysBetween(day, ctx.realToday) > RETRO_WINDOW_DAYS - 1) return noBreak();
  const session = await ctx.personSession(person);
  const listed = await ctx.call("entry.find", () =>
    ctx.api.get<{ id: string; source?: string }[]>(
      `/api/v1/time-entries?from=${day}&to=${day}`,
      session.token,
    ),
  );
  const rows = listed?.status === 200 && Array.isArray(listed.body) ? listed.body : [];
  const target = rows.find((r) => r.source === "WIFI") ?? rows[0];
  const slot = entry.breaks[0];
  if (!target) return noBreak();
  const res = await ctx.call("entry.break", () =>
    ctx.api.post(
      `/api/v1/time-entries/${target.id}/breaks`,
      {
        startTime: localIso(day, slot.start, ctx.config.tz),
        endTime: localIso(day, slot.end, ctx.config.tz),
      },
      session.token,
    ),
  );
  if (!res || res.status >= 300) noBreak();
}

/** One person's day. */
export async function employeeDay(
  ctx: BotContext,
  tenantKey: SimTenantKey,
  basePerson: PersonSpec,
): Promise<void> {
  const person = {
    ...basePerson,
    weeklyHours: ctx.progress.weeklyHours[basePerson.key] ?? basePerson.weeklyHours,
  };
  const { state } = ctx.tenant(tenantKey);
  const ids = state.persons[person.key];
  if (!ids?.created || ids.exited) return;
  const rng = ctx.rng("employee", person.key);
  const leave = ctx.progress.leave[person.key] ?? [];
  const blocked = blockedDay(person, ctx.day, leave);

  const planned = blocked
    ? null
    : plannedDay(person, ctx.day, ctx.progress.shifts[person.key]?.[ctx.day], rng);

  if (planned && rng.chance(person.traits.sickness)) {
    await recordSick(ctx, person, tenantKey, rng);
    return;
  }
  if (rng.chance(person.traits.vacationAppetite)) await requestVacation(ctx, person, rng);
  if (!planned) return;
  // Not yet hired on this day (a pending hire is created by the admin bot on the hire day).
  if (person.hireDate > ctx.day) return;

  const entry = realizeDay(planned, person.traits, person.kind === "MINOR", rng);
  await bookEntry(ctx, person, tenantKey, state.salonIds[planned.salonIndex], entry, rng);
}

export { weekdayOf };
