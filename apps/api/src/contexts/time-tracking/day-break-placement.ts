/**
 * day-break-placement.ts — Issue #511 (D-01 .. D-09, D-22a).
 *
 * § 4 Satz 2 and Satz 3 ArbZG — and, for minors, the § 11 JArbSchG rules that replace § 4 — decided
 * on the D-22 interval view of the day kernel (`day-break-rule.ts`). The function runs AFTER the
 * minute sums and never changes them: the saldo, `totalBreakMin` and the Phase-80 warnings are
 * untouched, the result is an additive field of the evaluation (D-10).
 *
 *   - Rest periods: every placed break segment, plus the same-salon gaps above two hours as
 *     separator-only candidates (D-16), touching or overlapping candidates coalesced into one
 *     period (D-22a A1), then classified: a period touching the first start or the last end of the
 *     day is EDGE (D-04), one shorter than the rule's minimum is TOO_SHORT (D-01), one inside the
 *     minors' window is OUTSIDE_WINDOW (D-05); every other period is a Ruhepause (QUALIFYING).
 *   - Blocks: the day's work period minus the qualifying periods and the separators. Short
 *     interruptions never split a block (D-03).
 *
 * Every comparison is made in integer epoch milliseconds, never in float minutes, so a break of
 * 14 min 59.999 s can never become 15:00 (D-01). Nothing in here rounds.
 *
 * The module is pure: it reads the kernel's own view and the rules table, nothing else. It does not
 * import from the kernel file, not even a type: the kernel imports this module, and the input shapes
 * below are structural, so the kernel's own segment and gap types fit without an import cycle.
 */
import { requiredBreakFor, type BreakRegime, type BreakRegimeRules } from "./break-regime";

/** What a placement finding reports. */
export type PlacementCode =
  "BREAK_SEGMENT_TOO_SHORT" | "BREAK_TOO_LATE" | "BREAK_OUTSIDE_WINDOW" | "BREAK_POSITION_UNKNOWN";

/** How certain a finding is (D-07); the position-unknown hint carries none. */
export type PlacementCertainty = "VIOLATION" | "UNCLEAR";

/** One coalesced rest period of the day and how it was classified. */
export interface RestPeriod {
  startTime: Date;
  endTime: Date;
  /** QUALIFYING counts as a Ruhepause; the others are not counted and split nothing. */
  status: "QUALIFYING" | "TOO_SHORT" | "EDGE" | "OUTSIDE_WINDOW";
  /** True when the period contains a same-salon gap above two hours: it always ends a block (D-16). */
  separator: boolean;
  /** Minutes of the period that are part of the day's `totalBreakMin`. */
  countedMin: number;
  /** Minutes of the period that exist only as the best-case free remainder of a cross-salon gap (D-07). */
  freeRemainderMin: number;
}

/** One maximal working stretch between the qualifying rest periods. */
export interface PlacementBlock {
  startTime: Date;
  endTime: Date;
  /** Wall-clock length, exact. */
  minutes: number;
  /** Unplaced (sum-only) break minutes of the entries the block touches; the position is unknowable. */
  positionUnknownBreakMinutes: number;
}

/** One finding of the placement evaluation. */
export interface PlacementFinding {
  code: PlacementCode;
  /** Null only for the position-unknown hint, which is never a violation (D-06). */
  certainty: PlacementCertainty | null;
  /** Display text of the provision, never a control value. */
  legalBasis: string;
  intervals: { startTime: Date; endTime: Date }[];
  /** BREAK_SEGMENT_TOO_SHORT: how many periods were not counted, by reason. */
  nonCounted?: { tooShort: number; edge: number; outsideWindow: number };
  /** BREAK_TOO_LATE: the longest offending block in exact minutes. */
  longestBlockMin?: number;
  /** The break duty that applies to the day's compliance working time. */
  requiredMin?: number;
  /** The minutes of qualifying rest periods. */
  qualifyingMin?: number;
}

/** The additive result of the placement evaluation (D-10). */
export interface PlacementEvaluation {
  regime: BreakRegime;
  restPeriods: RestPeriod[];
  blocks: PlacementBlock[];
  /**
   * The Satz-1 compliance figure (D-02): a separate derived number, never the saldo. A segment that
   * is not a Ruhepause counts as working time here; only qualifying minutes satisfy the duty.
   */
  compliance: {
    workMin: number;
    qualifyingMin: number;
    unplacedMin: number;
    requiredMin: number;
    shortfall: boolean;
  };
  findings: PlacementFinding[];
  /** True when the position of sum-only breaks decides the result and cannot be known (D-06). */
  positionUnknown: boolean;
}

/** One break of the day as the kernel's interval view reports it (structural twin of the kernel type). */
export interface PlacementSegment {
  source: string;
  entryId: string | null;
  startTime: Date | null;
  endTime: Date | null;
  minutes: number;
}

/** One gap between consecutive entries as the kernel's interval view reports it. */
export interface PlacementGap {
  startTime: Date;
  endTime: Date;
  crossSalon: boolean;
  countsAsBreak: boolean;
}

/** What the evaluation reads: the kernel's own interval view plus two scalars. */
export interface PlacementInput {
  rows: ReadonlyArray<{ id: string; startTime: Date; endTime: Date }>;
  breakSegments: readonly PlacementSegment[];
  gaps: readonly PlacementGap[];
  netWorkedMin: number;
  /** The kernel's Satz-1 minute-sum shortfall; when true, BREAK_TOO_SHORT already reports it. */
  legacyBreakShortfall: boolean;
}

interface Candidate {
  start: number;
  end: number;
  countedMin: number;
  freeMin: number;
  separator: boolean;
}

interface CaseResult {
  restPeriods: RestPeriod[];
  blocks: PlacementBlock[];
  compliance: PlacementEvaluation["compliance"];
  nonCounted: { tooShort: number; edge: number; outsideWindow: number };
  findings: PlacementFinding[];
}

const MS_PER_MIN = 60_000;

/** Merges touching or overlapping candidates in start order (D-22a A1). */
function coalesce(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Candidate[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
      last.countedMin += c.countedMin;
      last.freeMin += c.freeMin;
      last.separator = last.separator || c.separator;
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

/** One evaluation of the day with a given set of extra, best-case free spans (D-07). */
function runCase(
  input: PlacementInput,
  rules: BreakRegimeRules,
  extraFree: ReadonlyArray<readonly [number, number]>,
): CaseResult {
  const workStart = Math.min(...input.rows.map((r) => r.startTime.getTime()));
  const workEnd = Math.max(...input.rows.map((r) => r.endTime.getTime()));

  const candidates: Candidate[] = [];
  let unplacedMin = 0;
  const unplacedByEntry = new Map<string, number>();
  for (const seg of input.breakSegments) {
    if (seg.source === "unplaced-entry-break" || seg.startTime === null || seg.endTime === null) {
      unplacedMin += seg.minutes;
      if (seg.entryId !== null) {
        unplacedByEntry.set(seg.entryId, (unplacedByEntry.get(seg.entryId) ?? 0) + seg.minutes);
      }
      continue;
    }
    candidates.push({
      start: seg.startTime.getTime(),
      end: seg.endTime.getTime(),
      countedMin: seg.minutes,
      freeMin: 0,
      separator: false,
    });
  }
  for (const gap of input.gaps) {
    // A same-salon gap above two hours ends a block but adds nothing to the Satz-1 figure (D-16).
    if (!gap.crossSalon && !gap.countsAsBreak) {
      candidates.push({
        start: gap.startTime.getTime(),
        end: gap.endTime.getTime(),
        countedMin: 0,
        freeMin: 0,
        separator: true,
      });
    }
  }
  for (const [start, end] of extraFree) {
    candidates.push({
      start,
      end,
      countedMin: 0,
      freeMin: (end - start) / MS_PER_MIN,
      separator: false,
    });
  }

  const nonCounted = { tooShort: 0, edge: 0, outsideWindow: 0 };
  const restPeriods: RestPeriod[] = [];
  for (const p of coalesce(candidates)) {
    let status: RestPeriod["status"] = "QUALIFYING";
    if (!p.separator) {
      // Order matters: an edge segment is not an interruption at all (D-04), a short one is no
      // Ruhepause (D-01), and only then does the minors' window apply (D-05).
      if (rules.excludeEdgeTouching && (p.start <= workStart || p.end >= workEnd)) {
        status = "EDGE";
        nonCounted.edge += 1;
      } else if (p.end - p.start < rules.minSegmentMs) {
        status = "TOO_SHORT";
        nonCounted.tooShort += 1;
      } else if (
        rules.windowMin > 0 &&
        (p.start < workStart + rules.windowMin * MS_PER_MIN ||
          p.end > workEnd - rules.windowMin * MS_PER_MIN)
      ) {
        // A separator bypasses the window on purpose (D-22a A9): a split shift is not a Ruhepause
        // candidate inside the window rule.
        status = "OUTSIDE_WINDOW";
        nonCounted.outsideWindow += 1;
      }
    }
    restPeriods.push({
      startTime: new Date(p.start),
      endTime: new Date(p.end),
      status,
      separator: p.separator,
      countedMin: p.countedMin,
      freeRemainderMin: p.freeMin,
    });
  }

  // Blocks: the work period minus the qualifying periods and the separators (D-03).
  const blocks: PlacementBlock[] = [];
  const pushBlock = (start: number, end: number): void => {
    let pu = 0;
    for (const r of input.rows) {
      if (r.startTime.getTime() < end && start < r.endTime.getTime()) {
        pu += unplacedByEntry.get(r.id) ?? 0;
      }
    }
    blocks.push({
      startTime: new Date(start),
      endTime: new Date(end),
      minutes: (end - start) / MS_PER_MIN,
      positionUnknownBreakMinutes: pu,
    });
  };
  let cursor = workStart;
  for (const p of restPeriods) {
    if (!p.separator && p.status !== "QUALIFYING") continue;
    const s = p.startTime.getTime();
    if (s > cursor) pushBlock(cursor, s);
    cursor = Math.max(cursor, p.endTime.getTime());
  }
  if (workEnd > cursor) pushBlock(cursor, workEnd);

  // The Satz-1 compliance figure (D-02).
  let workMin = input.netWorkedMin;
  let qualifyingMin = 0;
  for (const p of restPeriods) {
    if (p.separator || p.status === "QUALIFYING")
      qualifyingMin += p.countedMin + p.freeRemainderMin;
    else workMin += p.countedMin;
  }
  const requiredMin = requiredBreakFor(rules, workMin);
  const shortfall = requiredMin > 0 && qualifyingMin + unplacedMin < requiredMin;
  const compliance = { workMin, qualifyingMin, unplacedMin, requiredMin, shortfall };

  const findings: PlacementFinding[] = [];

  // Satz 3: no more than maxBlockMin in a row. A block that carries sum-only break minutes has an
  // unknowable position, so it is never a violation here (D-06).
  const limitMs = rules.maxBlockMin * MS_PER_MIN;
  const tooLate = blocks.filter(
    (b) =>
      b.endTime.getTime() - b.startTime.getTime() > limitMs && b.positionUnknownBreakMinutes === 0,
  );
  if (tooLate.length > 0) {
    findings.push({
      code: "BREAK_TOO_LATE",
      certainty: "VIOLATION",
      legalBasis: rules.legalBasis.block,
      intervals: tooLate.map((b) => ({ startTime: b.startTime, endTime: b.endTime })),
      longestBlockMin: Math.max(...tooLate.map((b) => b.minutes)),
    });
  }

  return { restPeriods, blocks, compliance, nonCounted, findings };
}

/**
 * Evaluates § 4 Satz 2/3 ArbZG (or § 11 JArbSchG) on the kernel's interval view. `rules` is a
 * parameter so a test can pass a mutated rule set and prove the boundary matrix notices.
 */
export function evaluatePlacement(
  input: PlacementInput,
  rules: BreakRegimeRules,
): PlacementEvaluation {
  if (input.rows.length === 0) {
    return {
      regime: rules.regime,
      restPeriods: [],
      blocks: [],
      compliance: {
        workMin: 0,
        qualifyingMin: 0,
        unplacedMin: 0,
        requiredMin: 0,
        shortfall: false,
      },
      findings: [],
      positionUnknown: false,
    };
  }
  const run = runCase(input, rules, []);
  return {
    regime: rules.regime,
    restPeriods: run.restPeriods,
    blocks: run.blocks,
    compliance: run.compliance,
    findings: run.findings,
    positionUnknown: false,
  };
}
