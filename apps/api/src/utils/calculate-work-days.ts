/**
 * Phase 49.5 — workDays-aware Urlaubsverbrauch.
 * Phase 61 (v1.6.5) — extracted from routes/leave.ts to enable unit testing
 * without Fastify/DB. Algorithm verified correct per .planning/phases/
 * 61-calculate-work-days-audit/61-AUDIT.md.
 *
 * `workDays` is required — callers MUST load the employee's WorkSchedule and
 * pass workDays explicitly (or the tenant default as a fallback). See
 * `resolveWorkDays` in routes/leave.ts for the resolution chain.
 *
 * Semantics:
 *   - halfDay=true → returns 0.5 regardless of range, workDays, or holidays.
 *     (The leave UI is responsible for only emitting halfDay on single-day
 *     workday requests; the algorithm is intentionally permissive.)
 *   - Otherwise iterates inclusive [start..end], counting each day whose
 *     UTC day-of-week is in `workDays` and whose UTC `YYYY-MM-DD` key is NOT
 *     in `holidays`.
 *
 * TZ correctness note (Phase 61): the original (leave.ts) used `getDay()` /
 * `setDate(+1)` which are LOCAL-time methods. In production those agree with
 * UTC because Node runs with TZ=UTC, but when this code is exercised under a
 * non-UTC TZ (developer machines, CI runners not pinned to UTC) the local
 * DST boundary at Mar/Oct can produce off-by-one results. The extracted
 * version uses `getUTCDay()` / `getUTCFullYear()` / `setUTCDate(+1)` so the
 * algorithm is TZ-safe by construction. Behavior under TZ=UTC is identical
 * to the original.
 */
export function calculateWorkDays(
  start: Date,
  end: Date,
  halfDay: boolean,
  workDays: number[],
  holidays: Set<string> = new Set(),
): number {
  if (halfDay) return 0.5;
  const workDaySet = new Set(workDays);
  let days = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getUTCDay();
    const yyyy = cur.getUTCFullYear();
    const mm = String(cur.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(cur.getUTCDate()).padStart(2, "0");
    const ds = `${yyyy}-${mm}-${dd}`;
    if (workDaySet.has(dow) && !holidays.has(ds)) days++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

// ── Phase 61: WorkSchedule.workDays normalization ─────────────────────────
//
// Background: an employee's 2026-05-27 data corruption traced to WorkSchedule
// rows storing workDays=[1,2,3,4,5] (Mo-Fr) even though her mondayHours=0.
// Root cause was that none of the 4 WorkSchedule write paths in the API
// derive workDays from per-day-hours — they trust either an explicit body
// value or the schema default [1,2,3,4,5]. See 61-AUDIT.md §C.
//
// These helpers close that gap. They are exported and applied at every
// WorkSchedule create/update site so the invariant
//   workDays = { d ∈ [0..6] | {day}Hours[d] > 0 }
// holds for every new row.

/**
 * Coerce a Prisma Decimal | number | string | { toNumber: () => number }
 * value to a plain JS number. Mirrors the existing pattern in routes/leave.ts
 * (resolveWorkDays) which uses `Number(ws.sundayHours)`.
 */
function toNumber(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  if (typeof v === "object" && v !== null && "toNumber" in v) {
    const tn = (v as { toNumber: () => number }).toNumber;
    if (typeof tn === "function") return tn.call(v);
  }
  return Number(v);
}

/**
 * Per-day-hour value accepted by deriveWorkDaysFromPerDayHours / normalizeWorkDays.
 * Allows callers to pass through Zod-parsed numbers, raw DB strings, or Prisma
 * Decimal objects without manual coercion.
 */
type PerDayHourValue = number | string | { toNumber: () => number };

/** Shape of the per-day-hours columns used by WorkSchedule. */
export interface PerDayHours {
  mondayHours: PerDayHourValue;
  tuesdayHours: PerDayHourValue;
  wednesdayHours: PerDayHourValue;
  thursdayHours: PerDayHourValue;
  fridayHours: PerDayHourValue;
  saturdayHours: PerDayHourValue;
  sundayHours: PerDayHourValue;
}

/**
 * Returns the sorted set of weekday indices (0=Sun..6=Sat) where the
 * corresponding `{day}Hours` value is strictly > 0. Accepts plain numbers,
 * Prisma Decimal objects (.toNumber()), or numeric strings.
 *
 * Examples:
 *   { mondayHours: 8, ..., fridayHours: 8, sat/sun: 0 } → [1,2,3,4,5]
 *   { mondayHours: 0, tue-fri: 8, sat/sun: 0 }          → [2,3,4,5] (Anna)
 *   all-zero                                            → []
 */
export function deriveWorkDaysFromPerDayHours(hours: PerDayHours): number[] {
  const fields: Array<[number, number]> = [
    [0, toNumber(hours.sundayHours)],
    [1, toNumber(hours.mondayHours)],
    [2, toNumber(hours.tuesdayHours)],
    [3, toNumber(hours.wednesdayHours)],
    [4, toNumber(hours.thursdayHours)],
    [5, toNumber(hours.fridayHours)],
    [6, toNumber(hours.saturdayHours)],
  ];
  return fields
    .filter(([, h]) => h > 0)
    .map(([d]) => d)
    .sort((a, b) => a - b);
}

/**
 * Returns true iff `arr` equals the literal Mo-Fr default `[1,2,3,4,5]`.
 * Order-sensitive: callers always pass sorted arrays (Zod schema doesn't
 * reorder, but the input is conventionally sorted).
 */
function isLiteralMoFr(arr: number[]): boolean {
  if (arr.length !== 5) return false;
  const expected = [1, 2, 3, 4, 5];
  for (let i = 0; i < 5; i++) if (arr[i] !== expected[i]) return false;
  return true;
}

/**
 * Combine an optional explicit `workDays` input with per-day-hours and an
 * optional fallback to produce the final value for WorkSchedule.workDays.
 *
 * Precedence:
 *   1. explicit non-empty AND not the literal [1,2,3,4,5] default → use as-is
 *      (admin deliberately chose something other than Mo-Fr; trust them).
 *   2. otherwise derive from per-day-hours; if derive yields a non-empty set,
 *      use that.
 *   3. fall back to:
 *        - the explicit array (non-empty even if it's literal Mo-Fr — caller
 *          gave us something, use it), OR
 *        - the optional tenant-level `fallback`, OR
 *        - `[1, 2, 3, 4, 5]`.
 *
 * The literal-Mo-Fr-override rule (case 1) is what fixes Anna's bug: a UI
 * that sends `workDays: [1,2,3,4,5]` (the schema default) AND
 * `mondayHours: 0` is interpreted as "caller didn't think about workDays,
 * derive from hours" rather than "caller wants Mo-Fr counted as workdays".
 */
export function normalizeWorkDays(
  explicit: number[] | undefined,
  hours: PerDayHours,
  fallback?: number[],
): number[] {
  const derived = deriveWorkDaysFromPerDayHours(hours);

  // 1. caller sent a non-default explicit value → trust them
  if (explicit && explicit.length > 0 && !isLiteralMoFr(explicit)) {
    return explicit;
  }

  // 2. derive from per-day-hours when it gives us something meaningful
  if (derived.length > 0) return derived;

  // 3. fall back to explicit (if non-empty), tenant fallback, or legacy default
  if (explicit && explicit.length > 0) return explicit;
  if (fallback && fallback.length > 0) return fallback;
  return [1, 2, 3, 4, 5];
}
