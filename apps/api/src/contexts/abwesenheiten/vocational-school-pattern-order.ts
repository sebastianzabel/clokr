// Phase 103 Plan 05 (DISCRETION-MUSTERHISTORIE) — shared BS-pattern resolution order
// plus pure ambiguity detection.
//
// Two distinct problems live here, on purpose:
//
//   1. WHICH ROW WINS A TIE. `EmployeeVocationalSchoolPattern` allows multiple
//      `isActive: true` rows per employee (the multi-pattern model — weekday +
//      block-week combinations — is deliberate, see
//      routes/vocational-school-pattern.ts's own doc comment). Every single-winner
//      lookup ("which pattern applies on date D") picks the "most recent" row via
//      `orderBy: { validFrom: "desc" }`. When two rows share the same `validFrom`
//      (the measured real-world case in 103-BEFUND.md § "Zweiter Befund" — two rows,
//      `validFrom` identical, `createdAt` 41 days apart) Postgres offers NO ordering
//      guarantee for the remaining ties, so the "winner" can flip between two
//      identical requests. `BS_PATTERN_ORDER_BY` is the one shared total order used by
//      every such site, so the same row wins every time, everywhere.
//
//   2. WHERE THE ACTIVE SET ITSELF IS AMBIGUOUS. A tiebreak cannot repair a case where
//      two active patterns BOTH genuinely claim the same calendar day — that could be
//      a legitimate weekday + block-week union (correct, must stay additive) or an
//      unclosed superseded pattern (a data bug). The generator cannot tell those apart
//      from the data alone, so it must not silently collapse to one winner.
//      `findAmbiguousClaimDates()` instead makes the overlap VISIBLE — a retroactive
//      preview lists every date more than one active pattern claims, without deciding
//      for the operator which one is "right".
//
// `patternClaimsDate()` (and the small calendar-math helpers below it) are
// intentionally NOT imported from `vocational-school-generator.ts` — that file would
// need to import `BS_PATTERN_ORDER_BY` from here, and the reverse import would create
// a cycle. The duplicated helpers are pure one-line calendar math (UTC day arithmetic,
// ISO week numbering) with no business logic to drift; `patternClaimsDate` itself is
// exported as the SINGLE definition of "does this pattern structurally claim this day"
// so ambiguity detection never re-implements the weekday/block-week/validity predicate
// a second time.

import type { Prisma } from "@clokr/db";

export const BS_PATTERN_ORDER_BY = [
  { validFrom: "desc" },
  { createdAt: "desc" },
  { id: "desc" },
] satisfies Prisma.EmployeeVocationalSchoolPatternOrderByWithRelationInput[];
// Why all three keys:
//   - `validFrom` is the semantic key — "most recently effective pattern" is what every
//     caller actually means by "current".
//   - `createdAt` breaks the tie that is ACTUALLY OBSERVED in prod (103-BEFUND.md
//     § "Zweiter Befund": two rows, identical `validFrom`, `createdAt` 41 days apart —
//     the later save is the one that reflects the admin's real intent).
//   - `id` is the final total-order guarantee. Postgres gives no ordering guarantee
//     across any remaining tie (two rows saved in the very same PUT transaction can
//     share `createdAt` to the millisecond); without a final unique tiebreaker the
//     "winner" can still flip between two identical requests.

// ── Pure claim predicate + calendar helpers (DB-free, unit-testable) ────────────

/** UTC date (00:00:00.000Z) for the calendar day of `d`. Mirrors the generator's own. */
function dateOnlyUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDaysUtc(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/** JS-native getUTCDay (0=Sun..6=Sat) → schema convention (0=Mo..6=So). */
function dowMondayBased(d: Date): number {
  const native = d.getUTCDay();
  return native === 0 ? 6 : native - 1;
}

/** ISO 8601 week number + ISO week year for a date. Mirrors the generator's own. */
function isoWeekOf(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The minimal shape needed to decide "does this pattern structurally claim this day".
 * A structural subset of the Prisma `EmployeeVocationalSchoolPattern` row — callers
 * pass the real row directly (extra fields are ignored).
 */
export interface PatternClaimShape {
  dayOfWeek: number | null;
  daysOfWeek: number[];
  blockWeeks: number[];
  blockYear: number | null;
  validFrom: Date;
  validUntil: Date | null;
}

/**
 * True when `pattern` structurally claims `date`: `date` falls inside the pattern's
 * own `validFrom`/`validUntil` window AND either its weekday set (`daysOfWeek`, with
 * the legacy single-value `dayOfWeek` fallback) or its block-week set (`blockWeeks`
 * restricted to Mo-Fr, matched against `blockYear`) includes `date`.
 *
 * Pure and DB-free. Does NOT consider `isActive` — callers are expected to have
 * already filtered to active rows before calling this (matches every existing
 * single-winner query's `where: { isActive: true, ... }` shape).
 */
export function patternClaimsDate(pattern: PatternClaimShape, date: Date): boolean {
  const d = dateOnlyUtc(date);
  const patternStart = dateOnlyUtc(pattern.validFrom);
  if (d < patternStart) return false;
  if (pattern.validUntil && d > dateOnlyUtc(pattern.validUntil)) return false;

  const weekdaySet = new Set<number>(pattern.daysOfWeek);
  if (weekdaySet.size === 0 && pattern.dayOfWeek != null) {
    weekdaySet.add(pattern.dayOfWeek);
  }
  if (weekdaySet.size > 0 && weekdaySet.has(dowMondayBased(d))) return true;

  if (pattern.blockWeeks.length > 0 && pattern.blockYear != null) {
    const iso = isoWeekOf(d);
    const dow = dowMondayBased(d);
    const isWeekday = dow >= 0 && dow <= 4; // Blockunterricht is Mo-Fr only (BBiG §15 Abs.1 Nr.3)
    if (isWeekday && iso.year === pattern.blockYear && pattern.blockWeeks.includes(iso.week)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns every ISO date (ascending, deduped) inside `[windowStart, windowEnd]` that
 * two or more of the given (already-loaded, already `isActive: true`-filtered) patterns
 * structurally claim per `patternClaimsDate()`.
 *
 * This is deliberately NOT a resolution — it does not decide which pattern "wins" an
 * overlapping day. A legitimate weekday + non-overlapping block-week combination
 * produces `[]` here (their claimed days never intersect); an unclosed superseded
 * pattern that still overlaps a newer one shows up here so an operator can see it
 * instead of the generator silently unioning both. Pure and DB-free — callers own
 * fetching the pattern rows.
 */
export function findAmbiguousClaimDates(
  patterns: PatternClaimShape[],
  windowStart: Date,
  windowEnd: Date,
): string[] {
  if (patterns.length < 2) return [];

  const start = dateOnlyUtc(windowStart);
  const end = dateOnlyUtc(windowEnd);
  const dayCount = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (dayCount < 0) return [];

  const out: string[] = [];
  for (let i = 0; i <= dayCount; i++) {
    const date = addDaysUtc(start, i);
    let claimants = 0;
    for (const p of patterns) {
      if (patternClaimsDate(p, date)) {
        claimants++;
        if (claimants >= 2) break;
      }
    }
    if (claimants >= 2) out.push(toIsoDate(date));
  }
  return out;
}
