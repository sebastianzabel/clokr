/**
 * Phase 76.3 (SALDO-V19-01) — Shared frontend helper for
 * working-day + per-day-expected-hours math across all calendar
 * surfaces (personal /time-entries, /team/time-entries, and the
 * admin /admin/employees/[id] detail view).
 *
 * Honors CONTEXT D-01..D-06 (locked):
 *   D-01: workDays (when present + non-empty) is authoritative
 *   D-02: backwards-compat fallback to *Hours > 0 for legacy rows
 *   D-03: SHIFT_BASED → 0 (Soll comes from Shift row);
 *         MONTHLY_HOURS + monthlyHours==null/0 → 0 (pure tracking)
 *   D-04: page-level decides whether to render +/- column when 0
 *   D-05: single source of truth — replaces three inline copies
 *   D-06: 2026-06-04 incident repro test in __tests__/work-schedule.test.ts is
 *         the architectural enforcement.
 *
 * Mirrors server-side semantics from
 * apps/api/src/utils/calculate-work-days.ts (normalizeWorkDays).
 * Backend uses getUTCDay() because all backend Date inputs are
 * pre-canonicalized to UTC midnight; this helper uses getDay() to
 * match existing frontend convention (the calendar pages already
 * use local-time Date objects throughout).
 *
 * NOTE on date utilities: this module deliberately avoids importing
 * from "date-fns". The package ships without type declarations in
 * some sub-versions installed across the monorepo (e.g. 4.2.0 lacks
 * the `.d.ts` files 4.1.0 ships), which trips `tsc --noEmit` even
 * though `svelte-check` tolerates it. Computing end-of-month and the
 * `yyyy-MM-dd` key inline is cheap and keeps this hot-path helper
 * dependency-free.
 */

// Inline last-day-of-month — equivalent to date-fns/endOfMonth, but
// returns a Date with time-of-day matching the input. We only compare
// using <= so the time component is irrelevant.
function lastDayOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

// Inline yyyy-MM-dd formatter — equivalent to date-fns/format(date, "yyyy-MM-dd").
// All three calendar pages already key holidays by this exact string.
function ymd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface WorkScheduleLike {
  type?: "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED";
  monthlyHours?: number | string | null;
  mondayHours: number | string;
  tuesdayHours: number | string;
  wednesdayHours: number | string;
  thursdayHours: number | string;
  fridayHours: number | string;
  saturdayHours: number | string;
  sundayHours: number | string;
  workDays?: number[];
}

// Day-index → *Hours field name. 0=Sun..6=Sat (matches getDay()).
const DAY_HOUR_KEYS = [
  "sundayHours",
  "mondayHours",
  "tuesdayHours",
  "wednesdayHours",
  "thursdayHours",
  "fridayHours",
  "saturdayHours",
] as const;

function toNumber(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v) || 0;
  return 0;
}

function hasNonEmptyWorkDays(s: WorkScheduleLike): s is WorkScheduleLike & { workDays: number[] } {
  return Array.isArray(s.workDays) && s.workDays.length > 0;
}

// One-shot divergence warner — emit at most once per schedule
// object reference to avoid render-loop log spam.
const warned = new WeakSet<object>();
function maybeWarnDivergence(s: WorkScheduleLike): void {
  if (!hasNonEmptyWorkDays(s)) return;
  if (s.type === "SHIFT_BASED" || s.type === "MONTHLY_HOURS") return;
  const fromHours = DAY_HOUR_KEYS.map((k, i) => (toNumber(s[k]) > 0 ? i : -1)).filter(
    (i) => i >= 0,
  );
  const setA = new Set(s.workDays);
  const setB = new Set(fromHours);
  const same = setA.size === setB.size && [...setA].every((d) => setB.has(d));
  if (same) return;
  if (warned.has(s as object)) return;
  warned.add(s as object);
  console.warn(
    "[work-schedule] WorkSchedule divergence: workDays and *Hours > 0 disagree. " +
      "workDays wins (per Phase 61). Inspect schedule via " +
      "scripts/audit-workdays-vs-day-hours.ts.",
    { workDays: s.workDays, fromHours },
  );
}

export function isWorkDay(schedule: WorkScheduleLike | null | undefined, date: Date): boolean {
  if (!schedule) return false;
  const dow = date.getDay();
  if (hasNonEmptyWorkDays(schedule)) {
    maybeWarnDivergence(schedule);
    return schedule.workDays.includes(dow);
  }
  // Legacy fallback (D-02)
  return toNumber(schedule[DAY_HOUR_KEYS[dow]]) > 0;
}

export function getDayExpectedHours(
  schedule: WorkScheduleLike | null | undefined,
  date: Date,
): number {
  if (!schedule) return 0;
  if (!isWorkDay(schedule, date)) return 0;
  if (schedule.type === "SHIFT_BASED") return 0; // D-03
  if (schedule.type === "MONTHLY_HOURS") {
    const mh = toNumber(schedule.monthlyHours);
    if (mh === 0) return 0; // D-03 / D-04
  }
  return toNumber(schedule[DAY_HOUR_KEYS[date.getDay()]]);
}

export function countWorkingDaysInMonth(
  schedule: WorkScheduleLike | null | undefined,
  monthStart: Date,
  excludeHolidays?: string[],
): number {
  if (!schedule) return 0;
  const exclude = new Set(excludeHolidays ?? []);
  let count = 0;
  const end = lastDayOfMonth(monthStart);
  const cur = new Date(monthStart);
  while (cur <= end) {
    if (isWorkDay(schedule, cur) && !exclude.has(ymd(cur))) {
      count++;
    }
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/**
 * Item C (v1.8.24) — MONTHLY_HOURS header SOLL = the FLAT full-month budget, drift-free.
 *
 * The header must show the flat monthly budget (e.g. 15:00 for a 15h Minijobber), NOT the
 * per-working-day distribution sum round(budget/workingDays) × workingDays, which drifts (e.g.
 * round(900/23)×23 = 897 = 14:57). Semantics (owner-decided):
 *   - Tenant holiday-deduction flag OFF (default) → exactly monthlyBudgetMinutes (no drift).
 *   - Flag ON → subtract holiday days that fall on configured workdays, at the FLAT daily rate
 *     round(budget/totalWorkdays) (matches the backend isMonthlyHoursDeduction path), computed
 *     from the budget (not by summing rounded per-day values), so a no-holiday month stays exact.
 *
 * @param schedule            the MONTHLY_HOURS work schedule (workDays / *Hours drive workday detection)
 * @param monthStart          any Date within the target calendar month (local time)
 * @param monthlyBudgetMinutes monthlyHours × 60 (caller resolves; 0 → returns 0)
 * @param holidayDeduction    the tenant monthlyHoursHolidayDeduction flag
 * @param holidayDateStrings  yyyy-MM-dd keys of public holidays (any range; filtered to this month)
 */
export function monthlyBudgetSollMinutes(
  schedule: WorkScheduleLike | null | undefined,
  monthStart: Date,
  monthlyBudgetMinutes: number,
  holidayDeduction: boolean,
  holidayDateStrings: Iterable<string>,
): number {
  if (!schedule || monthlyBudgetMinutes <= 0) return 0;
  if (!holidayDeduction) return monthlyBudgetMinutes; // flat budget — no working-day drift

  const totalWorkdays = countWorkingDaysInMonth(schedule, monthStart);
  if (totalWorkdays <= 0) return monthlyBudgetMinutes;
  const dailyRate = Math.round(monthlyBudgetMinutes / totalWorkdays);

  let holidayWorkdays = 0;
  for (const dateStr of holidayDateStrings) {
    const d = new Date(dateStr + "T12:00:00");
    if (
      d.getFullYear() === monthStart.getFullYear() &&
      d.getMonth() === monthStart.getMonth() &&
      isWorkDay(schedule, d)
    ) {
      holidayWorkdays++;
    }
  }
  return Math.max(0, monthlyBudgetMinutes - holidayWorkdays * dailyRate);
}
