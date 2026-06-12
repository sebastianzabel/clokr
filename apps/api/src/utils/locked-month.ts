// Phase 79 Plan 01 Task 1 — Shared locked-month gate (API-V19-03).
//
// Extracts the inline pattern repeated across time-entries.ts:790-812 and
// vocational-school.ts:231-247 into a single source of truth. Consumed by
// Plans 79-02 / 79-03 / 79-04 (WorkEvent POST / PATCH / DELETE + BC proxy).
//
// A calendar month is "locked" when a SaldoSnapshot row exists with
// (employeeId, periodType="MONTHLY", periodStart=monthStart) AND superseded=false.
// Superseded snapshots (Phase 76.6 TZ-duplicate cleanup pattern) do NOT lock the
// month — they are excluded from production findFirst/findMany via
// `where: { superseded: false }`. Never hard-deleted (Revisionssicherheit).
//
// ── REVISION (B2) — string-parsed month resolution ────────────────────────────
// The helper signature accepts `dateString: string` (YYYY-MM-DD) — NOT a Date.
// Year/month are parsed DIRECTLY from the string. This is byte-identical with
// the existing inline gate at time-entries.ts:794 which uses local-time month
// extraction. Parsing the string avoids any TZ-edge divergence that UTC Date
// math could introduce — e.g. `dateString="2026-02-28"` with
// `tz="America/Los_Angeles"` MUST resolve to February regardless of internal
// Date construction.

import type { PrismaClient } from "@clokr/db";
import { monthRangeUtc } from "./timezone";

/**
 * German error string surfaced to API clients when a write is rejected because
 * the target month is closed. Single source of truth — route handlers and BC
 * proxies pull from this constant so messages cannot drift.
 *
 * Exact wording matches the existing inline gate at
 * `apps/api/src/routes/time-entries.ts:811` for byte-identical UX.
 */
export const LOCKED_MONTH_ERROR_DE = "Monat ist abgeschlossen und kann nicht bearbeitet werden";

/**
 * Thrown by `assertMonthNotLocked` when the target month is locked. Route
 * handlers catch this and map it to HTTP 403 with `LOCKED_MONTH_ERROR_DE` as
 * the response body's `error` field.
 *
 * `statusCode = 403` is part of the shape so a generic error mapper can map
 * status code without per-error-class knowledge.
 */
export class LockedMonthError extends Error {
  readonly statusCode = 403 as const;

  constructor() {
    super(LOCKED_MONTH_ERROR_DE);
    this.name = "LockedMonthError";
    Object.setPrototypeOf(this, LockedMonthError.prototype);
  }
}

/**
 * Throw `LockedMonthError` if the calendar month of `dateString` is locked for
 * `employeeId`. Resolves to `void` otherwise.
 *
 * A month is "locked" when a `SaldoSnapshot` row exists with
 *   (employeeId, periodType="MONTHLY", periodStart=monthStart)
 * AND `superseded === false`. Superseded snapshots are NOT authoritative.
 *
 * Mirrors the inline pattern in `time-entries.ts:790-812` and
 * `vocational-school.ts:231-247`. Single source of truth so Plans 79-02 /
 * 79-03 / 79-04 cannot drift.
 *
 * REVISION (B2): `dateString` is parsed DIRECTLY (split("-")) — no `new Date()`
 * is constructed for month extraction. This guarantees byte-identical month
 * resolution with the legacy inline gate regardless of timezone.
 *
 * @param prisma     PrismaClient (or test client)
 * @param employeeId Employee whose month is checked
 * @param dateString Date in YYYY-MM-DD format
 * @param tz         Tenant timezone (e.g. "Europe/Berlin") — passed to
 *                   monthRangeUtc to compute the canonical monthStart
 * @throws LockedMonthError if the month is locked
 */
export async function assertMonthNotLocked(
  prisma: PrismaClient,
  employeeId: string,
  dateString: string,
  tz: string,
): Promise<void> {
  // REVISION (B2): parse year/month from the YYYY-MM-DD string directly. Do
  // NOT construct a Date for month extraction — that would diverge from the
  // existing inline gate at time-entries.ts:794 at TZ edges. The string is the
  // canonical source of truth for which calendar month is being mutated.
  const parts = dateString.split("-");
  if (parts.length !== 3) {
    throw new Error(`assertMonthNotLocked: dateString must be YYYY-MM-DD, got: ${dateString}`);
  }
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`assertMonthNotLocked: invalid dateString: ${dateString}`);
  }

  const { start: monthStart } = monthRangeUtc(year, month, tz);

  const snapshot = await prisma.saldoSnapshot.findUnique({
    where: {
      employeeId_periodType_periodStart: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: monthStart,
      },
    },
    select: { id: true, superseded: true },
  });

  if (snapshot && !snapshot.superseded) {
    throw new LockedMonthError();
  }
}
