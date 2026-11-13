// Issue #853-19 (prototype „Aufgaben“) - the context line of a leave task row:
// "Resturlaub danach 11 · niemand sonst abwesend". It is built from the same two reads the decision
// dialog already makes (`GET /leave/entitlements/:employeeId?year=` and `GET /leave/overlap`) and
// through the same text rules (`vacationBeforeAfter`, `formatDays`), so row and dialog never say
// different things about one request.
//
// Permissions: a fact the caller may not read is LEFT OUT, never guessed. The Resturlaub read is made
// only with `canReadEntitlement` (the page passes `leave-entitlement:read`); a refused or failed read
// leaves its part out, including "niemand sonst abwesend" (an empty list is a statement, a failed read
// is not one). The API stays the guard; the flag only avoids a request that would be refused.
//
// Request cost: both reads are cached per key - one entitlement read per person and year, one overlap
// read per period - and at most `FACT_READS_AT_ONCE` reads are in flight, so a list of rows costs at
// most one overlap read per distinct period plus one entitlement read per distinct person and year,
// and never a burst. The module has no store, `$api` or component import: the page passes the readers.
import { mapVacationBalance, type VacationEntitlementRow } from "$lib/leave/vacation-balance";
import { deriveVacationSummary } from "$lib/leave/vacation-summary";
import { formatDays, vacationBeforeAfter } from "$lib/leave/review-facts";
import type { LeaveOverlapEntry } from "$lib/leave/leave-review";

/** How many fact reads may be in flight at once. */
export const FACT_READS_AT_ONCE = 4;

/** At most this many colleagues are named in the line; the rest is a count. */
const NAMED_COLLEAGUES = 2;

/** What the context line reads of a leave request. */
export interface LeaveFactRequest {
  id: string;
  employeeId: string;
  typeCode: string;
  status: string;
  startDate: string;
  endDate: string;
  days: number | string;
}

/** The two reads, passed in by the page. */
export interface LeaveFactReaders {
  entitlements: (employeeId: string, year: string) => Promise<VacationEntitlementRow[]>;
  overlap: (startDate: string, endDate: string) => Promise<LeaveOverlapEntry[]>;
}

/** The sentence for the colleagues who are away in the same period. */
export function colleaguesSentence(names: readonly string[]): string {
  const unique = [...new Set(names)];
  if (unique.length === 0) return "niemand sonst abwesend";
  const shown = unique.slice(0, NAMED_COLLEAGUES);
  const rest = unique.length - shown.length;
  const list = shown.join(", ");
  return rest > 0 ? `auch abwesend: ${list} und ${rest} weitere` : `auch abwesend: ${list}`;
}

/** The parts joined to the one line; `null` when nothing is known. */
export function leaveContextLine(parts: {
  /** The Resturlaub after this request, `null` when it is not derivable or not readable. */
  remainingAfter: number | null;
  /** The colleagues away in the period, `null` when the read did not answer. */
  colleagues: readonly string[] | null;
}): string | null {
  const pieces: string[] = [];
  if (parts.remainingAfter !== null) {
    pieces.push(`Resturlaub danach ${formatDays(parts.remainingAfter)}`);
  }
  if (parts.colleagues !== null) pieces.push(colleaguesSentence(parts.colleagues));
  return pieces.length > 0 ? pieces.join(" · ") : null;
}

export interface LeaveContextLoader {
  /** The context line of one request, `null` when no part of it could be read. Never rejects. */
  load: (request: LeaveFactRequest) => Promise<string | null>;
}

/**
 * A loader with its own caches and its own read limit. One loader per page instance; it keeps
 * nothing across pages. A failed read is not cached, so a later row may try again.
 */
export function createLeaveContextLoader(
  readers: LeaveFactReaders,
  options: { canReadEntitlement: boolean },
): LeaveContextLoader {
  const entitlementReads = new Map<string, Promise<VacationEntitlementRow[] | null>>();
  const overlapReads = new Map<string, Promise<LeaveOverlapEntry[] | null>>();

  // A finished read hands its slot straight to the next waiting one, so the limit is never exceeded.
  let inFlight = 0;
  const waiting: Array<() => void> = [];
  async function limited<T>(read: () => Promise<T>): Promise<T> {
    if (inFlight >= FACT_READS_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
    else inFlight += 1;
    try {
      return await read();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else inFlight -= 1;
    }
  }

  function cached<T>(
    cache: Map<string, Promise<T | null>>,
    key: string,
    read: () => Promise<T>,
  ): Promise<T | null> {
    const hit = cache.get(key);
    if (hit) return hit;
    const started = limited(read).then(
      (value): T | null => value,
      (): T | null => {
        cache.delete(key);
        return null;
      },
    );
    cache.set(key, started);
    return started;
  }

  async function remainingAfter(request: LeaveFactRequest): Promise<number | null> {
    if (!options.canReadEntitlement || request.typeCode !== "VACATION") return null;
    const year = request.startDate.slice(0, 4);
    const rows = await cached(entitlementReads, `${request.employeeId}:${year}`, () =>
      readers.entitlements(request.employeeId, year),
    );
    if (!rows) return null;
    const balance = mapVacationBalance(rows.find((r) => r.typeCode === "VACATION"));
    const fact = vacationBeforeAfter({
      remaining: deriveVacationSummary(balance, 0).remaining,
      days: Number(request.days),
      status: request.status,
      startDate: request.startDate,
      endDate: request.endDate,
    });
    return fact?.after ?? null;
  }

  async function colleagues(request: LeaveFactRequest): Promise<string[] | null> {
    const rows = await cached(overlapReads, `${request.startDate}:${request.endDate}`, () =>
      readers.overlap(request.startDate, request.endDate),
    );
    if (!rows) return null;
    return rows.filter((o) => o.status === "APPROVED").map((o) => o.employeeName);
  }

  return {
    async load(request) {
      const [after, away] = await Promise.all([remainingAfter(request), colleagues(request)]);
      return leaveContextLine({ remainingAfter: after, colleagues: away });
    },
  };
}
