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
 * apps/api/src/contexts/platform/calculate-work-days.ts (normalizeWorkDays).
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
  // FLEXTIME + SHIFT_BASED weekly target (Prisma Decimal — arrives as a string
  // on the wire). Issue #164: FLEXTIME's Ø-Methode day rate is weeklyHours /
  // contractWorkDaysPerWeek, mirroring apps/api/src/contexts/working-time-account/timezone.ts's
  // avgWorkMinutesCore.
  weeklyHours?: number | string | null;
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
  // {day}Hours is authoritative data only for FIXED_SCHEDULE (CLAUDE.md); for
  // FLEXTIME, MONTHLY_HOURS and SHIFT_BASED it is a legacy placeholder while
  // workDays carries the contract, so a workDays-vs-hours divergence only means
  // something for FIXED_SCHEDULE. Positive check (not an exclusion list) so the
  // type enumeration exists in exactly one place (issue #142). An undefined
  // `type` is treated as "not known to be FIXED_SCHEDULE" and stays silent.
  if (s.type !== "FIXED_SCHEDULE") return;
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

// Contracted workdays per week — the divisor of the Ø-Methode (BAG 9 AZR 406/17).
// MUST use the same day-membership source as isWorkDay() above: workDays when
// non-empty, count({day}Hours > 0) otherwise. Mixing the two sources would make
// the ratio meaningless — the server states this explicitly in
// apps/api/src/contexts/working-time-account/timezone.ts:268-271, which this mirrors.
function contractWorkDaysPerWeek(s: WorkScheduleLike): number {
  if (hasNonEmptyWorkDays(s)) return s.workDays.length;
  return DAY_HOUR_KEYS.filter((k) => toNumber(s[k]) > 0).length;
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
  // FLEXTIME (issue #164): {day}Hours is a legacy 1/0 placeholder for this type
  // (CLAUDE.md "Schedule Types"; production evidence in issue #142), so returning
  // it here produced a 1:00 h daily Soll. The server's Soll for FLEXTIME is the
  // Ø-Methode rate — apps/api/src/contexts/working-time-account/timezone.ts:332-334 routes FLEXTIME to
  // avgWorkMinutesCore, which is weeklyHours × 60 × workdaysInRange ÷ workDaysPerWeek
  // (BAG 9 AZR 406/17). Per day that is weeklyHours ÷ workDaysPerWeek. weeklyHours > 0
  // is enforced for FLEXTIME on every write path (apps/api/src/contexts/platform/api/settings.ts:341-350);
  // the <= 0 guard mirrors avgWorkMinutesCore's own defensive return for legacy rows.
  //
  // Deliberately its own branch rather than the positive `type === "FIXED_SCHEDULE"`
  // check that maybeWarnDivergence uses one function above: MONTHLY_HOURS with a
  // budget, and an undefined type, both still return the {day}Hours value here and
  // are pinned by shipped assertions in __tests__/work-schedule.test.ts.
  if (schedule.type === "FLEXTIME") {
    const weekly = toNumber(schedule.weeklyHours);
    if (weekly <= 0) return 0;
    const perWeek = contractWorkDaysPerWeek(schedule);
    if (perWeek === 0) return 0;
    return weekly / perWeek;
  }
  return toNumber(schedule[DAY_HOUR_KEYS[date.getDay()]]);
}

/**
 * The calendar cell's Soll in whole minutes. Callers must use this instead of
 * `getDayExpectedHours(...) * 60`.
 *
 * FLEXTIME's Ø-Methode rate (weeklyHours ÷ workDaysPerWeek) is frequently not a
 * whole number of minutes — e.g. 38.5 h over 4 workdays is 577.5 min — and fmtMin()
 * formats with `minutes % 60`, so an unrounded value would render as "9:37.5".
 * The server rounds ONCE per range (avgWorkMinutesCore's Math.round); a per-cell
 * calendar can only round per day, which can differ from the server's month total
 * by at most 0.5 min per day. Every other schedule type keeps the exact
 * `hours × 60` it produced before, so FIXED_SCHEDULE is bit-for-bit unchanged.
 */
export function getDayExpectedMinutes(
  schedule: WorkScheduleLike | null | undefined,
  date: Date,
): number {
  const hours = getDayExpectedHours(schedule, date);
  return schedule?.type === "FLEXTIME" ? Math.round(hours * 60) : hours * 60;
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

// ── Phase 107 (D-22..D-26, issue #94) — Arbeitstage/Woche field decision ──
//
// The employee form (admin/employees/[id]/+page.svelte) renders exactly one
// Arbeitstage/Woche variant per ScheduleType, inside that type's own {#if}
// branch. This function is the single, pure, testable specification of that
// mapping — the template's four branches (FIXED_SCHEDULE / FLEXTIME /
// MONTHLY_HOURS / the SHIFT_BASED {:else} catch-all) must stay in sync with
// it. Deliberately NOT wired into the template's {#if} conditions (Plan 02
// Task 3): the four variants render entirely different markup (disabled
// input / chip group / nothing / plain input), so routing the template
// through this function would not reduce duplication, only add a layer —
// its value here is a pinning test against regression, not reuse.
export type ArbeitstageFieldVariant = "count" | "derived" | "chips" | "none";

export function arbeitstageFieldVariant(
  type: WorkScheduleLike["type"] | undefined,
): ArbeitstageFieldVariant {
  switch (type) {
    case "FIXED_SCHEDULE":
      return "derived"; // D-24: disabled, count of {day}Hours > 0
    case "FLEXTIME":
      return "chips"; // D-25: Mo-So weekday selector, writes workDays
    case "MONTHLY_HOURS":
      return "none"; // D-26: no field at all
    case "SHIFT_BASED":
    default:
      return "count"; // D-23 (mirrors the template's own {:else} catch-all default)
  }
}

/**
 * Phase 107 (D-02/D-23) — the exact workDays/contractWorkDaysPerWeek slice of
 * buildSchedulePayload() (admin/employees/[id]/+page.svelte's PUT body
 * builder), extracted so it is unit-testable without mounting the component
 * and so the component itself consumes the tested implementation rather than
 * a parallel copy. SHIFT_BASED omits workDays entirely from the payload
 * (defence in depth — the server freezes it regardless, D-02) and is the
 * only type that ever sends a non-null contractWorkDaysPerWeek.
 */
export function buildContractWorkDaysPayload(
  type: WorkScheduleLike["type"] | undefined,
  workDays: number[],
  contractWorkDaysPerWeek: number | null,
): { workDays?: number[]; contractWorkDaysPerWeek: number | null } {
  return {
    ...(type === "SHIFT_BASED" ? {} : { workDays }),
    contractWorkDaysPerWeek: type === "SHIFT_BASED" ? contractWorkDaysPerWeek : null,
  };
}

/**
 * Phase 436 Plan 02 (D-06) — the SHIFT_BASED "übliche Arbeitstage" payload slice, mirroring
 * buildContractWorkDaysPayload's pattern. A non-SHIFT_BASED type never carries an Angabe
 * (server-side D-02 mirror) — always emits []. Values follow the 0=So..6=Sa convention, the
 * SAME convention as usualWorkDays/workDays elsewhere in this codebase (do NOT reuse
 * BS_WEEKDAY_LABELS, which indexes 0=Mo — Pitfall 2).
 */
export function buildUsualWorkDaysPayload(
  type: WorkScheduleLike["type"] | undefined,
  usualWorkDays: number[],
): { usualWorkDays: number[] } {
  if (type !== "SHIFT_BASED") return { usualWorkDays: [] };
  return { usualWorkDays: [...new Set(usualWorkDays)].sort((a, b) => a - b) };
}

/**
 * Phase 436 Plan 02 (D-06) — how many more weekdays must be ticked to reach the contract day
 * count. Purely advisory (the server is authoritative, T-436-08): an empty list is always valid
 * ("keine Angabe"), and a null/unknown contract count means there is nothing to compare against.
 */
export function usualWorkDaysShortfall(
  usualWorkDays: number[],
  contractWorkDaysPerWeek: number | null,
): number {
  if (usualWorkDays.length === 0) return 0;
  if (contractWorkDaysPerWeek == null) return 0;
  return Math.max(0, contractWorkDaysPerWeek - usualWorkDays.length);
}

// Minimal shape both MONTHLY_HOURS display helpers below need — a schedule's
// own workDays only. Looser than WorkScheduleLike so callers that only have
// the workDays slice (e.g. tests, or a narrower fetch) can use it directly.
type MonthlyHoursScheduleLike = { workDays?: number[] } | null | undefined;

/**
 * Issue #433 (D-05) — display-only mirror of the server's MONTHLY_HOURS workday set
 * (apps/api/src/contexts/working-time-account/timezone.ts's monthlyHoursWorkDays). The authoritative
 * month Soll is always the server's `monthSollMinutes` (plan 05) — this function only decides
 * which calendar cells render as "workday" cells. Resolution order: the schedule's own non-empty
 * `workDays`, else a non-empty `defaultWorkDays` (TenantConfig.defaultWorkDays), else Mo–Fr.
 * NEVER derived from the legacy `{day}Hours` placeholder (CLAUDE.md — `{day}Hours` is authoritative
 * data only for FIXED_SCHEDULE).
 */
export function monthlyHoursWorkDays(
  schedule: MonthlyHoursScheduleLike,
  defaultWorkDays?: number[] | null,
): number[] {
  if (schedule && Array.isArray(schedule.workDays) && schedule.workDays.length > 0) {
    return schedule.workDays;
  }
  if (Array.isArray(defaultWorkDays) && defaultWorkDays.length > 0) {
    return defaultWorkDays;
  }
  return [1, 2, 3, 4, 5];
}

/**
 * Issue #433 (D-06) — display-only mirror of the server's MONTHLY_HOURS Ø day rate
 * (apps/api/src/contexts/working-time-account/timezone.ts's monthlyHoursMinutesCore). Per-day Soll for a
 * MONTHLY_HOURS calendar cell: `round(monthlyBudgetMinutes ÷ workdays of the FULL calendar month)`.
 * Holidays are deliberately NOT excluded from the denominator (D-06) — unlike the retired
 * holiday-deduction switch, a holiday elsewhere in the month never changes this rate. The
 * authoritative month Soll remains the server's `monthSollMinutes`; per-cell rounding means the
 * sum of cells can differ from the server total by up to 0.5 min per day (same note as the
 * FLEXTIME helper above).
 *
 * @param schedule             the MONTHLY_HOURS schedule's workDays (see monthlyHoursWorkDays)
 * @param monthStart           any Date within the target calendar month (local time)
 * @param monthlyBudgetMinutes monthlyHours × 60 (caller resolves; <= 0 → returns 0)
 * @param defaultWorkDays      TenantConfig.defaultWorkDays — the D-05 fallback tier
 */
export function monthlyHoursDailyRateMinutes(
  schedule: MonthlyHoursScheduleLike,
  monthStart: Date,
  monthlyBudgetMinutes: number,
  defaultWorkDays?: number[] | null,
): number {
  if (!schedule || monthlyBudgetMinutes <= 0) return 0;

  const daySet = new Set(monthlyHoursWorkDays(schedule, defaultWorkDays));
  const end = lastDayOfMonth(monthStart);
  const cur = new Date(monthStart);
  let count = 0;
  while (cur <= end) {
    if (daySet.has(cur.getDay())) count++;
    cur.setDate(cur.getDate() + 1);
  }
  if (count <= 0) return 0;
  return Math.round(monthlyBudgetMinutes / count);
}
