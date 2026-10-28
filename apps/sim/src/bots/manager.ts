/**
 * Manager behaviour (Issue #715): plans shifts, reviews leave (four-eyes: managers never review a
 * request they filed), corrects the odd entry and closes months, sometimes late.
 */
import type { PersonSpec, SimTenantKey } from "../plan";
import { addDays, dayOfMonth, localIso, previousMonth } from "../tz";
import { BotContext } from "./context";
import {
  pickReviewer,
  planShiftEdits,
  planUnlocks,
  reviewVerdict,
  statusAfterReview,
} from "./decisions";
import { rosterFor } from "./schedule";

const PLAN_HORIZON_DAYS = 13;

function managersOf(ctx: BotContext, tenantKey: SimTenantKey): PersonSpec[] {
  const { plan, state } = ctx.tenant(tenantKey);
  return plan.persons.filter((p) => p.role === "MANAGER" && state.persons[p.key]?.created);
}

/** Managers who can review, then the admin (who files no requests), rotating by day. */
async function reviewers(ctx: BotContext, tenantKey: SimTenantKey) {
  const { state } = ctx.tenant(tenantKey);
  const sessions = [];
  const managers = managersOf(ctx, tenantKey);
  const offset = managers.length === 0 ? 0 : Number(ctx.day.replace(/-/g, "")) % managers.length;
  for (let i = 0; i < managers.length; i += 1) {
    sessions.push(await ctx.personSession(managers[(offset + i) % managers.length]));
  }
  sessions.push(await ctx.sessionFor(state.adminEmail, state.adminPassword));
  return sessions;
}

async function managerToken(ctx: BotContext, tenantKey: SimTenantKey): Promise<string> {
  return (await reviewers(ctx, tenantKey))[0].token;
}

/** Plans the roster of every shift-based person for the next two weeks. */
export async function planShifts(ctx: BotContext, tenantKey: SimTenantKey): Promise<void> {
  const { plan, state } = ctx.tenant(tenantKey);
  const through = addDays(ctx.day, PLAN_HORIZON_DAYS);
  const planned = ctx.progress.shiftsPlannedThrough[tenantKey];
  const from = planned && planned >= ctx.day ? addDays(planned, 1) : ctx.day;
  if (from > through) return;

  const token = await managerToken(ctx, tenantKey);
  const batch: {
    person: PersonSpec;
    day: string;
    shift: { start: string; end: string; salonIndex: number };
  }[] = [];
  for (const person of plan.persons) {
    if (person.scheduleType !== "SHIFT_BASED" || !state.persons[person.key]?.created) continue;
    if (state.persons[person.key].exited) continue;
    const roster = rosterFor(person, from, through, (day) => ctx.rng("roster", person.key, day));
    for (const [day, shift] of Object.entries(roster)) {
      if (day < person.hireDate) continue;
      batch.push({ person, day, shift });
    }
  }
  for (let i = 0; i < batch.length; i += 100) {
    const chunk = batch.slice(i, i + 100);
    const res = await ctx.call("shift.plan", () =>
      ctx.api.post(
        "/api/v1/shifts/bulk",
        {
          shifts: chunk.map(({ person, day, shift }) => ({
            employeeId: state.persons[person.key].employeeId,
            date: day,
            startTime: shift.start,
            endTime: shift.end,
            salonId: state.salonIds[shift.salonIndex],
          })),
        },
        token,
      ),
    );
    if (res && res.status < 300) {
      for (const { person, day, shift } of chunk) {
        (ctx.progress.shifts[person.key] ??= {})[day] = shift;
      }
    }
  }
  ctx.progress.shiftsPlannedThrough[tenantKey] = through;
}

interface ListedRequest {
  id: string;
  status: string;
  employeeId?: string;
}

/**
 * Approves or rejects what is pending, cancellation requests included (they sit in the same
 * list). Four eyes: nobody reviews a request they filed, and a cancellation is decided by neither
 * its filer nor the manager who approved the leave.
 */
export async function reviewLeave(ctx: BotContext, tenantKey: SimTenantKey): Promise<void> {
  const { plan } = ctx.tenant(tenantKey);
  const candidates = await reviewers(ctx, tenantKey);
  const token = candidates[0].token;
  const rng = ctx.rng("review", tenantKey);
  const pending = await ctx.call("leave.list", () =>
    ctx.api.get<ListedRequest[] | { items?: ListedRequest[] }>(
      "/api/v1/leave/requests?status=PENDING",
      token,
    ),
  );
  if (!pending || pending.status !== 200) return;
  const rows = Array.isArray(pending.body) ? pending.body : (pending.body.items ?? []);
  const records = new Map<string, { personKey: string; index: number }>();
  for (const person of plan.persons) {
    (ctx.progress.leave[person.key] ?? []).forEach((r, index) =>
      records.set(r.id, { personKey: person.key, index }),
    );
  }
  for (const row of rows) {
    const known = records.get(row.id);
    const record = known ? ctx.progress.leave[known.personKey][known.index] : undefined;
    const cancellation = row.status === "CANCELLATION_REQUESTED";
    const verdict = reviewVerdict(rng, cancellation);
    const reviewer = pickReviewer(candidates, {
      employeeIds: [row.employeeId],
      userIds: cancellation ? [record?.approvedBy] : [],
    });
    // Nobody may decide it (a small tenant): it stays open until somebody else is on duty.
    if (!reviewer) continue;
    const action = cancellation ? "leave.review-cancellation" : "leave.review";
    const res = await ctx.call(action, () =>
      ctx.api.patch(
        `/api/v1/leave/requests/${row.id}/review`,
        {
          status: verdict,
          reviewNote: verdict === "APPROVED" ? null : "Bot: Besetzung nicht möglich",
        },
        reviewer.token,
      ),
    );
    if (record && res && res.status === 200) {
      record.status = statusAfterReview(record.status, verdict);
      if (!cancellation && verdict === "APPROVED") record.approvedBy = reviewer.userId;
    }
  }
}

interface ListedRetro {
  id: string;
  employeeId: string;
}

/** Reviews the Zeitnachträge: approved mostly, sometimes rejected with the mandatory note. */
export async function reviewRetro(ctx: BotContext, tenantKey: SimTenantKey): Promise<void> {
  const candidates = await reviewers(ctx, tenantKey);
  const rng = ctx.rng("review-retro", tenantKey);
  const listed = await ctx.call("nachtrag.list", () =>
    ctx.api.get<ListedRetro[]>("/api/v1/retro-entry-requests?status=PENDING", candidates[0].token),
  );
  if (!listed || listed.status !== 200 || !Array.isArray(listed.body)) return;
  for (const row of listed.body) {
    const reviewer = pickReviewer(candidates, { employeeIds: [row.employeeId] });
    if (!reviewer) continue;
    const verdict = rng.chance(0.8) ? "APPROVED" : "REJECTED";
    await ctx.call(verdict === "APPROVED" ? "nachtrag.approve" : "nachtrag.reject", () =>
      ctx.api.patch(
        `/api/v1/retro-entry-requests/${row.id}/review`,
        {
          status: verdict,
          reviewNote: verdict === "REJECTED" ? "Bot: Zeiten nicht nachvollziehbar" : null,
        },
        reviewer.token,
      ),
    );
  }
}

interface WeekShift {
  id: string;
  employeeId: string;
  date: string;
  startTime: string;
  endTime: string;
}

/** Moves or withdraws a few shifts of next week (the product refuses edits in the past). */
export async function editShifts(ctx: BotContext, tenantKey: SimTenantKey): Promise<void> {
  const { plan, state } = ctx.tenant(tenantKey);
  const token = await managerToken(ctx, tenantKey);
  const week = await ctx.call("shift.week", () =>
    ctx.api.get<{ shifts?: WeekShift[] }>(
      `/api/v1/shifts/week?date=${addDays(ctx.realToday, 7)}`,
      token,
    ),
  );
  if (!week || week.status !== 200 || !Array.isArray(week.body.shifts)) return;
  const personOf = new Map<string, string>();
  for (const person of plan.persons) {
    const id = state.persons[person.key]?.employeeId;
    if (id) personOf.set(id, person.key);
  }
  const shifts = week.body.shifts
    .map((s) => ({ ...s, date: String(s.date).slice(0, 10) }))
    .filter((s) => s.date > ctx.realToday && personOf.has(s.employeeId));
  for (const edit of planShiftEdits(shifts, ctx.rng("shift-edit", tenantKey))) {
    const key = personOf.get(edit.shift.employeeId)!;
    if (edit.kind === "MOVE") {
      const res = await ctx.call("shift.edit", () =>
        ctx.api.put(
          `/api/v1/shifts/${edit.shift.id}`,
          { startTime: edit.startTime, endTime: edit.endTime },
          token,
        ),
      );
      const known = ctx.progress.shifts[key]?.[edit.shift.date];
      if (res?.status === 200 && known) {
        known.start = edit.startTime;
        known.end = edit.endTime;
      }
    } else {
      const res = await ctx.call("shift.withdraw", () =>
        ctx.api.delete(`/api/v1/shifts/${edit.shift.id}`, token),
      );
      if (res && res.status < 300 && ctx.progress.shifts[key]) {
        delete ctx.progress.shifts[key][edit.shift.date];
      }
    }
  }
}

/**
 * The admin unlocks a closed previous month now and then (an unlock needs a reason); the month is
 * closed again right away by `closeMonths`. The checker is told which months were touched.
 */
export async function unlockMonths(ctx: BotContext, tenantKey: SimTenantKey): Promise<void> {
  const { plan, state } = ctx.tenant(tenantKey);
  const { year, month } = previousMonth(ctx.day);
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const candidates = plan.persons
    .filter((p) => ctx.progress.closedMonths[`${tenantKey}|${p.key}|${monthKey}`])
    .map((p) => p.key);
  const chosen = planUnlocks(candidates, ctx.rng("unlock", tenantKey));
  if (chosen.length === 0) return;
  const admin = await ctx.sessionFor(state.adminEmail, state.adminPassword);
  for (const personKey of chosen) {
    const employeeId = state.persons[personKey].employeeId;
    const res = await ctx.call("month.unlock", () =>
      ctx.api.post(
        "/api/v1/overtime/unlock-month",
        { employeeId, year, month, reason: "Bot: Korrektur nach Rückfrage" },
        admin.token,
      ),
    );
    if (res?.status === 200) {
      ctx.progress.unlocks.push({ tenant: tenantKey, employeeId, month: monthKey, date: ctx.day });
      delete ctx.progress.closedMonths[`${tenantKey}|${personKey}|${monthKey}`];
    }
  }
}

/** The manager notices a wrong end time now and then and corrects it with a reason. */
export async function correctEntries(ctx: BotContext, tenantKey: SimTenantKey): Promise<void> {
  const rng = ctx.rng("correct", tenantKey);
  const token = await managerToken(ctx, tenantKey);
  for (const entry of ctx.createdEntries.filter((e) => e.tenant === tenantKey)) {
    if (!rng.chance(0.04)) continue;
    const end = new Date(new Date(entry.endTime).getTime() + 15 * 60_000).toISOString();
    await ctx.call("entry.correct", () =>
      ctx.api.put(
        `/api/v1/time-entries/${entry.id}`,
        { endTime: end, reason: "Bot: Korrektur der Endzeit" },
        token,
      ),
    );
  }
}

/** Closes the previous month for everyone, starting on a seeded day of the month (so sometimes late). */
export async function closeMonths(ctx: BotContext, tenantKey: SimTenantKey): Promise<void> {
  const { plan, state } = ctx.tenant(tenantKey);
  const { year, month } = previousMonth(ctx.day);
  const closeFrom = ctx.rng("close-day", tenantKey, `${year}-${month}`).int(2, 7);
  if (dayOfMonth(ctx.day) < closeFrom) return;
  const token = await managerToken(ctx, tenantKey);
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  for (const person of plan.persons) {
    const ids = state.persons[person.key];
    if (!ids?.created || ids.anonymized) continue;
    const key = `${tenantKey}|${person.key}|${monthKey}`;
    if (ctx.progress.closedMonths[key]) continue;
    // Nobody closes a month before the person was employed.
    if (person.hireDate > `${monthKey}-31`) continue;
    const res = await ctx.call(
      "month.close",
      () =>
        ctx.api.post(
          "/api/v1/overtime/close-month",
          { employeeId: ids.employeeId, year, month, confirmGaps: true },
          token,
        ),
      [200, 201],
    );
    // A definite answer (done or a business refusal) is not retried; a server error is.
    if (res && res.status < 500) ctx.progress.closedMonths[key] = true;
  }
}

export { localIso };
