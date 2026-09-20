// Phase 255 (GitHub issue #255) — the shared data shapes and the ONE named decision behind the
// BUrlG § 7 notice in the unified absence review dialog (LeaveReviewDialog.svelte).
//
// The function at the bottom of this file exists as a named export, not an inline `{#if}`
// condition in the component, precisely because inline conditions rot into comments while a
// named, exported function stays a live assertion that a test can pin (D-09). See
// apps/web/src/lib/leave/__tests__/leave-review.test.ts for the exhaustive proof over all ten
// CalendarTypeCode members.
//
// ── The set, and the deliberate mismatch it carries (D-07, corrected 2026-09-20) ──────────────
//
// The notice fires for VACATION and SPECIAL (Sonderurlaub) — owner decision, 2026-09-20, verbatim
// "01 ja sonderurlaub zählt dazu" in answer to O-01. This plan text was written BEFORE that
// decision landed and has since been updated throughout; do not read an earlier VACATION-only
// version of this file as the target.
//
// This is NOT the same boundary the server enforces. The server treats exclusively
// `code === "VACATION"` as the entitlement-consuming type — contingent, carry-over (Übertrag) and
// forfeiture (Verfall) hang on that comparison alone
// (apps/api/src/contexts/absence/facade/entitlements.ts:62,179, leave-self-heal.ts:78,98,
// api/leave.ts:517,1054,1166,1226,1539,1887,1939). The notice therefore does NOT describe the
// same thing the backend calculates: it is a reminder to decide a request promptly, not a claim
// that this request consumes vacation contingent.
//
// Whoever later narrows this set back to VACATION-only "to align display with the calculation"
// would be REVERSING an owner decision, not fixing an inconsistency. If that alignment is ever
// wanted, it is a new owner decision, not a silent cleanup.
import type { CalendarTypeCode } from "./team-calendar-visibility";

export type LeaveRequestStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "CANCELLED"
  | "CANCELLATION_REQUESTED";

/**
 * The subset of `GET /leave/requests`' response both /team/leave and /inbox need to render the
 * shared review dialog. `attestValidFrom`/`attestValidTo` are `string | null` because the API
 * handler serialises them as `r.attestValidFrom?.toISOString().split("T")[0] ?? null` — never a
 * `Date` on the wire.
 */
export interface LeaveReviewRequest {
  id: string;
  employeeId: string;
  typeCode: CalendarTypeCode;
  employee: { firstName: string; lastName: string };
  startDate: string;
  endDate: string;
  days: number;
  halfDay: boolean;
  status: LeaveRequestStatus;
  note: string | null;
  attestPresent: boolean;
  attestValidFrom: string | null;
  attestValidTo: string | null;
}

/**
 * A row from `GET /leave/overlap`. `typeCode`/`typeName` are `null` when the server masks the
 * caller from the absence type (Phase 262, D-01) — not a data error, and never "fixed away" by
 * falling back to anything other than the neutral chip label.
 */
export interface LeaveOverlapEntry {
  id: string;
  employeeName: string;
  typeCode: string | null;
  typeName: string | null;
  startDate: string;
  endDate: string;
  status: LeaveRequestStatus;
}

/**
 * Does the BUrlG § 7 reminder apply to this absence type? Bound to `typeCode` — never to
 * `leaveType.name` or a display label (D-08, CLAUDE.md § Context Boundaries: "Never use a new
 * display string as a control value").
 */
export function showsBurlgSection7Notice(typeCode: CalendarTypeCode): boolean {
  return typeCode === "VACATION" || typeCode === "SPECIAL";
}
