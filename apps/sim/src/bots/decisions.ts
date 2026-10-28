/**
 * Pure decision logic of the cancellation, Zeitnachtrag, shift-edit and unlock behaviours
 * (Issue #715). Nothing here calls the API: the bots feed in what they know and act on the answer,
 * so the rules can be tested without a server.
 */
import type { Rng } from "../rng";
import type { LeaveRecord } from "./context";

/** Days a manual entry may lie in the past before the product demands a Zeitnachtrag. */
export const RETRO_WINDOW_DAYS = 10;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** True once a day lies strictly beyond the retro window (a plain manual entry is refused). */
export function beyondRetroWindow(day: string, today: string): boolean {
  return daysBetween(day, today) > RETRO_WINDOW_DAYS;
}

/** A leave request that can still be withdrawn: future, requested or granted, not yet cancelling. */
export function cancellableLeave(
  records: readonly LeaveRecord[],
  day: string,
  closedMonth: (month: string) => boolean,
): LeaveRecord | null {
  return (
    records.find(
      (r) =>
        r.type === "VACATION" &&
        (r.status === "PENDING" || r.status === "APPROVED") &&
        r.start > day &&
        !closedMonth(r.start.slice(0, 7)) &&
        !closedMonth(r.end.slice(0, 7)),
    ) ?? null
  );
}

export function wantsToCancel(rng: Rng, chance = 0.05): boolean {
  return rng.chance(chance);
}

export interface ReviewerCandidate {
  userId: string;
  employeeId: string;
}

/**
 * The first candidate who is none of the forbidden people. Four eyes: nobody reviews their own
 * request, and a cancellation is approved by neither its filer nor the original approver.
 */
export function pickReviewer<T extends ReviewerCandidate>(
  candidates: readonly T[],
  forbidden: {
    employeeIds?: readonly (string | undefined)[];
    userIds?: readonly (string | undefined)[];
  },
): T | null {
  return (
    candidates.find(
      (c) =>
        !(forbidden.employeeIds ?? []).includes(c.employeeId) &&
        !(forbidden.userIds ?? []).includes(c.userId),
    ) ?? null
  );
}

export type ReviewVerdict = "APPROVED" | "REJECTED";

/** Approval odds: a cancellation is granted more often than a fresh request. */
export function reviewVerdict(rng: Rng, cancellation: boolean): ReviewVerdict {
  return rng.chance(cancellation ? 0.8 : 0.85) ? "APPROVED" : "REJECTED";
}

/** What a leave record becomes after the manager's verdict on it. */
export function statusAfterReview(
  current: LeaveRecord["status"],
  verdict: ReviewVerdict,
): LeaveRecord["status"] {
  if (current === "CANCELLATION_REQUESTED")
    return verdict === "APPROVED" ? "CANCELLED" : "APPROVED";
  return verdict;
}

/** A booking an employee left out on purpose and files as a Zeitnachtrag once the window is over. */
export interface PendingNachtrag {
  person: string;
  day: string;
  start: string;
  end: string;
  breaks: { start: string; end: string }[];
  intent: "LONG_DAY" | "NO_BREAK" | null;
  salonIndex: number;
}

export function forgetsToBook(rng: Rng, channel: string): boolean {
  return channel === "WEB" && rng.chance(0.03);
}

export function nachtragDue(pending: readonly PendingNachtrag[], person: string, today: string) {
  return pending.filter((p) => p.person === person && beyondRetroWindow(p.day, today));
}

/** A replayed day beyond the window: about half of the missing entries are filed late, the rest stay unrecorded. */
export function replayFilesNachtrag(rng: Rng): boolean {
  return rng.chance(0.5);
}

export interface ListedShift {
  id: string;
  employeeId: string;
  date: string;
  startTime: string;
  endTime: string;
}

export type ShiftEdit =
  | { kind: "MOVE"; shift: ListedShift; startTime: string; endTime: string }
  | { kind: "DELETE"; shift: ListedShift };

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Which shifts the manager touches: a few moved by half an hour, a few withdrawn. */
export function planShiftEdits(
  shifts: readonly ListedShift[],
  rng: Rng,
  max = 12,
  chance = 0.03,
): ShiftEdit[] {
  const edits: ShiftEdit[] = [];
  for (const shift of shifts) {
    if (edits.length >= max) break;
    if (!rng.chance(chance)) continue;
    if (rng.chance(0.3)) {
      edits.push({ kind: "DELETE", shift });
    } else {
      const delta = rng.chance(0.5) ? 30 : -30;
      edits.push({
        kind: "MOVE",
        shift,
        startTime: toHhmm(toMin(shift.startTime) + delta),
        endTime: toHhmm(toMin(shift.endTime) + delta),
      });
    }
  }
  return edits;
}

/** Closed months of the previous month the admin may unlock again (a few per day, then re-closed). */
export function planUnlocks(
  candidates: readonly string[],
  rng: Rng,
  max = 2,
  chance = 0.02,
): string[] {
  const chosen: string[] = [];
  for (const key of candidates) {
    if (chosen.length >= max) break;
    if (rng.chance(chance)) chosen.push(key);
  }
  return chosen;
}
