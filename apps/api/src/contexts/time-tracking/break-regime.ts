/**
 * break-regime.ts — Issue #511 (D-01, D-02, D-05).
 *
 * The ONE home of every § 4 ArbZG and § 11 JArbSchG break threshold: the minimum length of a
 * Ruhepause, the longest stretch of work without one, the break duty per working-time band and the
 * minors' window. The day kernel, the auto-break placement, the message builders and the tests read
 * this table; nothing else states 15, 270, 360, 540 or 60 as a break rule.
 *
 * Boundaries are STRICT everywhere: a duty applies above its `overMin`, never at it (exactly six
 * hours of work need no break).
 *
 * For an employee under 18 on the work date § 11 JArbSchG replaces § 4 ArbZG (§ 18 Abs. 2 ArbZG).
 * Deciding that age is the caller's job — the kernel stays pure and receives the regime as input
 * (D-05), so this module imports nothing but the legal floors of the adult rule.
 */
import { ARBZG_FLOOR_OVER_6H, ARBZG_FLOOR_OVER_9H } from "./break-constants";

/** Which statute decides the breaks of a day. */
export type BreakRegime = "ARBZG_4" | "JARBSCHG_11";

/** The break rules of one regime. */
export interface BreakRegimeRules {
  regime: BreakRegime;
  /** A break segment shorter than this (epoch milliseconds) is not a Ruhepause (D-01). */
  minSegmentMs: number;
  /** The longest stretch of work in a row, in minutes; a longer block is a violation (D-03). */
  maxBlockMin: number;
  /** Break duty per working-time band, highest band first; a duty applies above `overMin`. */
  thresholds: ReadonlyArray<{ overMin: number; requiredMin: number }>;
  /** Minutes after the start / before the end in which no Ruhepause may lie; 0 = no window. */
  windowMin: number;
  /** True when a segment touching the first start or the last end of the day never counts (D-04). */
  excludeEdgeTouching: boolean;
  /**
   * Display text naming the provision of each rule. Never a control value: no code branches on
   * these strings (CLAUDE.md).
   */
  legalBasis: {
    sum: string;
    segment: string;
    block: string;
    window: string | null;
  };
}

const FIFTEEN_MINUTES_MS = 15 * 60_000;

export const BREAK_REGIMES: Readonly<Record<BreakRegime, BreakRegimeRules>> = {
  ARBZG_4: {
    regime: "ARBZG_4",
    minSegmentMs: FIFTEEN_MINUTES_MS,
    maxBlockMin: 360,
    thresholds: [
      { overMin: 540, requiredMin: ARBZG_FLOOR_OVER_9H },
      { overMin: 360, requiredMin: ARBZG_FLOOR_OVER_6H },
    ],
    windowMin: 0,
    excludeEdgeTouching: true,
    legalBasis: {
      sum: "§ 4 S. 1 ArbZG",
      segment: "§ 4 S. 2 ArbZG",
      block: "§ 4 S. 3 ArbZG",
      window: null,
    },
  },
  JARBSCHG_11: {
    regime: "JARBSCHG_11",
    minSegmentMs: FIFTEEN_MINUTES_MS,
    maxBlockMin: 270,
    thresholds: [
      { overMin: 360, requiredMin: 60 },
      { overMin: 270, requiredMin: 30 },
    ],
    windowMin: 60,
    excludeEdgeTouching: true,
    legalBasis: {
      sum: "§ 11 Abs. 1 S. 2 JArbSchG",
      segment: "§ 11 Abs. 1 S. 3 JArbSchG",
      block: "§ 11 Abs. 2 S. 2 JArbSchG",
      window: "§ 11 Abs. 2 S. 1 JArbSchG",
    },
  },
};

/** The break duty, in minutes, for `workMin` minutes of working time under `rules` (strict `>`). */
export function requiredBreakFor(rules: BreakRegimeRules, workMin: number): number {
  for (const band of rules.thresholds) {
    if (workMin > band.overMin) return band.requiredMin;
  }
  return 0;
}

/**
 * The regime for a day: JARBSCHG_11 when the employee is under 18 on the work date. The age
 * decision is the caller's (D-05) — the kernel never reads a birth date.
 */
export function breakRegimeFor(minorOnWorkDate: boolean): BreakRegime {
  return minorOnWorkDate ? "JARBSCHG_11" : "ARBZG_4";
}

/**
 * The lowest working-time band that triggers a break duty under any regime. Derived from the
 * table, never a literal: a caller that must pre-filter days by "could any break duty apply"
 * (the month-close funnel) reads this.
 */
export const LOWEST_BREAK_DUTY_MIN: number = Math.min(
  ...Object.values(BREAK_REGIMES).flatMap((rules) => rules.thresholds.map((band) => band.overMin)),
);
