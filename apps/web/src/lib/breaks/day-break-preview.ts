/**
 * day-break-preview.ts
 *
 * Issue #511 D-18 — the entry form asks the server kernel, the browser evaluates nothing. The
 * form's proposal (start, end, breaks) goes to `POST /api/v1/day-breaks/preview`, which runs the
 * same day-break kernel the save path uses together with the day's other closed entries and
 * returns the final findings. Nothing is stored and nothing is audited by that call.
 *
 * Two guarantees for the page: at most one request per pause in typing (the debounce), and an
 * outdated answer never replaces a newer one (a request id; the server answers in no fixed order).
 * A failed preview shows no finding and never blocks saving - the save itself reports the
 * findings it produced.
 *
 * Pure module: type imports only, the transport is injected, so it is unit-testable without a
 * mounted page (this repo's vitest setup does not mount route pages).
 */
import type { DayCheckWarning } from "./day-break-violation";

/** One break interval of the proposal, exactly as `POST /time-entries` takes it. */
export interface DayPreviewBreak {
  startTime: string;
  endTime: string;
}

/** The body of `POST /api/v1/day-breaks/preview`. */
export interface DayPreviewRequest {
  employeeId: string;
  /** "YYYY-MM-DD" calendar-day key of the entry. */
  date: string;
  /** The stored entry the proposal replaces (edit form); absent for a new entry. */
  entryId?: string;
  startTime: string;
  endTime: string;
  breaks: DayPreviewBreak[];
  /** Legacy break minutes without positions; only read by the server when there are no slots. */
  breakMinutes?: number;
}

/** The automatic break a NEW entry without any break would get on save (the server names it). */
export interface DayPreviewAutoBreak {
  start: string;
  end: string;
  minutes: number;
  segments?: Array<{ start: string; end: string }>;
}

/** The answer of the preview route. */
export interface DayPreviewResponse {
  warnings: DayCheckWarning[];
  autoBreakApplied: DayPreviewAutoBreak | null;
}

export interface BuildDayPreviewInput {
  employeeId: string;
  date: string;
  entryId?: string | null;
  startISO: string;
  /** Null while the entry is still running. */
  endISO: string | null;
  breaks: DayPreviewBreak[];
  breakMinutes?: number;
}

/**
 * The preview body for the form's current state, or null when there is nothing to evaluate: an
 * entry without an end, or one whose end is not after its start (the route rejects both, and a
 * half-typed time must not produce a request).
 */
export function buildDayPreviewRequest(input: BuildDayPreviewInput): DayPreviewRequest | null {
  if (input.endISO === null) return null;
  const start = Date.parse(input.startISO);
  const end = Date.parse(input.endISO);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  const body: DayPreviewRequest = {
    employeeId: input.employeeId,
    date: input.date,
    startTime: input.startISO,
    endTime: input.endISO,
    breaks: input.breaks,
  };
  if (input.entryId) body.entryId = input.entryId;
  if (input.breakMinutes !== undefined) body.breakMinutes = input.breakMinutes;
  return body;
}

export type DayPreviewPost = (path: string, body: DayPreviewRequest) => Promise<DayPreviewResponse>;

export type DayPreviewResultHandler = (
  warnings: DayCheckWarning[],
  autoBreakApplied: DayPreviewAutoBreak | null,
) => void;

export interface DayPreviewRunner {
  /**
   * Schedules a preview for `body` after the debounce delay; a call inside the delay replaces the
   * pending one. A null body cancels everything and reports "no findings" at once.
   */
  request(body: DayPreviewRequest | null, onResult: DayPreviewResultHandler): void;
  /** Cancels the pending call and drops any in-flight answer (page teardown). */
  dispose(): void;
}

const PREVIEW_PATH = "/day-breaks/preview";

/** Debounce in milliseconds (T-511-40). */
export const DAY_PREVIEW_DELAY_MS = 300;

export function createDayPreviewRunner(
  post: DayPreviewPost,
  delayMs: number = DAY_PREVIEW_DELAY_MS,
): DayPreviewRunner {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Monotonic: only the answer of the most recently ISSUED request may reach the caller.
  let latestId = 0;

  function cancelPending(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    request(body, onResult) {
      cancelPending();
      // Any call - also a null one - outdates everything issued before it.
      const id = ++latestId;
      if (body === null) {
        onResult([], null);
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        post(PREVIEW_PATH, body).then(
          (res) => {
            if (id !== latestId) return;
            onResult(
              Array.isArray(res?.warnings) ? res.warnings : [],
              res?.autoBreakApplied ?? null,
            );
          },
          () => {
            if (id !== latestId) return;
            onResult([], null);
          },
        );
      }, delayMs);
    },
    dispose() {
      cancelPending();
      latestId++;
    },
  };
}
