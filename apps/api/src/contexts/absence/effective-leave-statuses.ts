/**
 * Issue #446 (D-01) — THE single definition of "leave that counts".
 *
 * CLAUDE.md § Leave Cancellation Flow step 2: a leave stays active — calendar, time-tracking
 * block AND saldo — until its cancellation is itself approved. `PENDING` is never in this set: a
 * merely-requested day never reduces Soll (only an approved absence, or one whose approved
 * cancellation is itself still pending, does). Every status filter in the API that means "leave
 * that counts" uses this tuple; any copy of it outside the API must be pinned to this file by a
 * test.
 *
 * This file deliberately carries no runtime import (only a type-only one) so it can never join
 * the absence/scheduling/time-tracking/working-time-account import cycle
 * (`measure-context-boundary-imports.ts --cycles --check 22`).
 */
import type { LeaveRequestStatus } from "@clokr/db";

export const EFFECTIVE_LEAVE_STATUSES = [
  "APPROVED",
  "CANCELLATION_REQUESTED",
] as const satisfies readonly LeaveRequestStatus[];

export type EffectiveLeaveStatus = (typeof EFFECTIVE_LEAVE_STATUSES)[number];
