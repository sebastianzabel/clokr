/**
 * place-auto-break.ts — Issue #511 (AK-4, D-17, D-19, D-20).
 *
 * The ONE placement of the automatic break. The AMOUNT is decided by the caller: adults keep the
 * tenant policy (`getEffectiveBreakDuration`, overrides and floors untouched, D-17), minors get at
 * least the § 11 JArbSchG minimum through `autoBreakAmountFor` (D-20). This module decides only
 * WHERE the minutes go so that the day kernel (`evaluateDayBreaks`) finds no Satz-2 / Satz-3 /
 * window finding in what the system wrote itself.
 *
 * Pure: no Prisma, no Fastify, no context import (in particular not working-time-account — the
 * time zone is a parameter and `date-fns-tz` is used directly, like the break-finding detector). All
 * arithmetic is in epoch milliseconds, so a DST day or a cross-midnight entry needs no special
 * case: the presence is `end − start` and nothing else.
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { BREAK_REGIMES, requiredBreakFor, type BreakRegime } from "./break-regime";

const MS_PER_MIN = 60_000;
/** Strict "HH:MM" (24 h); anything else is a malformed tenant setting. */
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** One placed break segment. */
export interface AutoBreakSegment {
  startTime: Date;
  endTime: Date;
}

/**
 * The configured break start as an instant: `hhmm` is wall-clock time in the TENANT zone on the
 * calendar day the entry starts (a cross-midnight entry keeps that anchor). Null for a missing or
 * malformed value — the caller then centres the break (T-511-11).
 *
 * The container runs in UTC; reading the setting in the server zone moved a "12:00" break by the
 * tenant's UTC offset (D-17).
 */
export function resolveDefaultBreakStart(input: {
  entryStart: Date;
  hhmm: string | null | undefined;
  tz: string;
}): Date | null {
  if (!input.hhmm) return null;
  const match = HHMM.exec(input.hhmm.trim());
  if (!match) return null;
  const hh = match[1].padStart(2, "0");
  const mm = match[2];
  const day = formatInTimeZone(input.entryStart, input.tz, "yyyy-MM-dd");
  const instant = fromZonedTime(`${day}T${hh}:${mm}:00`, input.tz);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * The amount of the automatic break in minutes.
 *
 * - `ARBZG_4`: the configured amount, unchanged for every input (D-17 — the saldo of an adult never
 *   moves because of the placement work).
 * - `JARBSCHG_11`: at least the statutory minimum for the presence — a tenant or employee setting
 *   below it never applies to a minor (§ 18 Abs. 2 ArbZG, § 11 JArbSchG). Presence is GROSS, the same
 *   convention `getEffectiveBreakDuration` uses for adults. The saldo effect (D-20) is limited to
 *   automatic breaks written from now on; stored breaks are never rewritten.
 */
export function autoBreakAmountFor(input: {
  configuredMin: number;
  presenceMin: number;
  regime: BreakRegime;
}): number {
  if (input.regime === "ARBZG_4") return input.configuredMin;
  return Math.max(
    input.configuredMin,
    requiredBreakFor(BREAK_REGIMES[input.regime], input.presenceMin),
  );
}

/**
 * Places the automatic break of `amountMin` minutes inside [start, end).
 *
 * Single segment (the normal case): the break start is the value nearest to the preferred one that
 * keeps both work blocks within the regime's longest block, a minute clear of the entry edges (a
 * segment touching them never counts, D-04) and, for minors, outside the window of § 11 Abs. 2
 * (D-05). The preferred start is the configured one when it lies strictly inside the entry, else
 * the middle of the entry (D-19).
 *
 * Several segments when one cannot keep every block within the limit (presence far above the limit):
 * the work is cut into equal blocks, each break at least the minimum segment long.
 *
 * The configured amount is never exceeded and never reduced below what is placed. When the amount
 * cannot make every block conformant (too few minutes for the needed segments) the minutes are
 * still placed as far as they carry and the kernel reports the remaining finding honestly. When no
 * placement exists at all the result is empty and the caller writes nothing (D-17).
 */
export function placeAutoBreak(input: {
  start: Date;
  end: Date;
  amountMin: number;
  preferredStart: Date | null;
  regime: BreakRegime;
}): AutoBreakSegment[] {
  const rules = BREAK_REGIMES[input.regime];
  const startMs = input.start.getTime();
  const presenceMs = input.end.getTime() - startMs;
  const breakMs = input.amountMin * MS_PER_MIN;
  const maxBlockMs = rules.maxBlockMin * MS_PER_MIN;
  const edgeMs = Math.max(MS_PER_MIN, rules.windowMin * MS_PER_MIN);

  if (!Number.isInteger(input.amountMin) || input.amountMin <= 0) return [];
  if (breakMs < rules.minSegmentMs) return [];
  if (presenceMs < breakMs + 2 * edgeMs) return [];

  const workMs = presenceMs - breakMs;

  // ── One segment ──────────────────────────────────────────────────────────────────────────
  if (workMs <= 2 * maxBlockMs) {
    const lowest = Math.max(edgeMs, workMs - maxBlockMs);
    const highest = Math.min(maxBlockMs, workMs - edgeMs);
    if (lowest > highest) return [];
    const preferredOffset =
      input.preferredStart &&
      input.preferredStart.getTime() > startMs &&
      input.preferredStart.getTime() < input.end.getTime()
        ? input.preferredStart.getTime() - startMs
        : workMs / 2;
    const offset = Math.min(highest, Math.max(lowest, preferredOffset));
    const segStart = Math.round(startMs + offset);
    return [{ startTime: new Date(segStart), endTime: new Date(segStart + breakMs) }];
  }

  // ── Several segments ─────────────────────────────────────────────────────────────────────
  let segmentCount = Math.ceil(workMs / maxBlockMs) - 1;
  const affordable = Math.floor(breakMs / rules.minSegmentMs);
  if (segmentCount > affordable) segmentCount = affordable;
  if (segmentCount < 1) return [];

  // Whole-minute segment lengths summing to exactly the amount; the remainder goes to the first.
  const baseMin = Math.floor(input.amountMin / segmentCount);
  const segmentMin = Array.from({ length: segmentCount }, () => baseMin);
  segmentMin[0] += input.amountMin - baseMin * segmentCount;

  // Equal work blocks; leftover milliseconds are spread one each over the first blocks so no
  // block exceeds ceil(work / blocks), which is within the limit whenever the work is.
  const blockCount = segmentCount + 1;
  const baseBlockMs = Math.floor(workMs / blockCount);
  const leftoverMs = workMs - baseBlockMs * blockCount;

  const segments: AutoBreakSegment[] = [];
  let cursor = startMs;
  for (let i = 0; i < segmentCount; i++) {
    cursor += baseBlockMs + (i < leftoverMs ? 1 : 0);
    const segEnd = cursor + segmentMin[i] * MS_PER_MIN;
    segments.push({ startTime: new Date(cursor), endTime: new Date(segEnd) });
    cursor = segEnd;
  }
  return segments;
}
