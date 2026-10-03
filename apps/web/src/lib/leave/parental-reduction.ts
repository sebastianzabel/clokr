/**
 * Issue #468 (D-12, amended by A-2) — web-side types and visibility rule for the
 * Elternzeit-Kürzung (BEEG) action in the manager/admin leave request list.
 *
 * Pure, dependency-free module (no imports from $api, $stores, svelte, or any component) — same
 * convention as `storno.ts` / `vacation-balance.ts` in this directory, so the visibility rule and
 * the number formatting are unit-testable without mounting `team/leave/+page.svelte`.
 *
 * The response types below mirror `apps/api/src/contexts/absence/parental-leave-reduction.ts`
 * and `apps/api/src/contexts/absence/api/parental-leave-reductions.ts` (plan 04's SUMMARY is the
 * authoritative source for the actual shapes — read it before changing anything here).
 */

import { hasPermission, type PermissionHolder } from "$lib/permissions";

/** Same permission `PUT /settings/vacation/:employeeId` already uses (D-11) — the server is
 *  authoritative; this is only the web-side gating convenience (T-468-22: cosmetic). */
export const PARENTAL_REDUCTION_PERMISSION = "leave-entitlement:update:ZUGEWIESEN";

/** D-12: shown only when the server's declaration would actually be legally effective. */
export const PARENTAL_REDUCTION_HINT =
  "Die Kürzung wirkt nur, wenn sie dem Mitarbeiter gegenüber erklärt wurde (§ 17 Abs. 1 BEEG).";

export interface ParentalReductionYearExisting {
  id: string;
  status: "ACTIVE" | "REVOKED";
  months: number;
  reducedDays: number;
  /** YYYY-MM-DD. */
  declaredAt: string;
  /** Full ISO datetime, or `null` while still ACTIVE. */
  revokedAt: string | null;
}

/** One calendar year's preview line — T-468-23: every number here comes straight from the
 *  server preview; this module (and the dialog built on it) computes none of them itself. */
export interface ParentalReductionYearPreview {
  year: number;
  months: number;
  regularDays: number;
  proposedReducedDays: number;
  currentTotalDays: number | null;
  resultingTotalDays: number | null;
  existing: ParentalReductionYearExisting | null;
  committable: boolean;
}

export interface ParentalReductionPreview {
  leaveRequestId: string;
  startDate: string;
  endDate: string;
  years: ParentalReductionYearPreview[];
}

/** One committed year, as returned by `POST /leave/parental-reductions/:leaveRequestId`. */
export interface ParentalReductionCommitted {
  year: number;
  months: number;
  reducedDays: number;
  totalDays: number;
}

export interface ParentalReductionCommitResponse {
  reductions: ParentalReductionCommitted[];
  warnings: string[];
}

/** `POST /leave/parental-reductions/:leaveRequestId/revoke` response. */
export interface ParentalReductionRevokeResponse {
  id: string;
  leaveRequestId: string;
  year: number;
  months: number;
  reducedDays: number;
  status: "ACTIVE" | "REVOKED";
  revokedAt: string | null;
  revokedBy: string | null;
  totalDays: number;
}

/** The minimal request shape the visibility rule needs — matches the page's own `LeaveRequest`
 *  row (a subset, so the page never has to build a separate object just to call this). */
export interface ParentalReductionCandidate {
  typeCode: string;
  status: string;
}

/**
 * A-2: the row action "Elternzeit-Kürzung erklären" is shown exactly for an APPROVED `PARENTAL`
 * request, and only to a holder of {@link PARENTAL_REDUCTION_PERMISSION}. Every other type,
 * every other status, and every user without the permission gets `false` — the server enforces
 * the real gate (T-468-22); this is cosmetic only.
 */
export function showsParentalReductionAction(
  request: ParentalReductionCandidate,
  user: PermissionHolder | null | undefined,
): boolean {
  return (
    request.typeCode === "PARENTAL" &&
    request.status === "APPROVED" &&
    hasPermission(user, PARENTAL_REDUCTION_PERMISSION)
  );
}

/**
 * Formats a day count the German way (decimal comma, no trailing zeros) — no existing helper in
 * `lib/leave/` does this (grepped; `vacation-balance.ts`'s `formatGermanDate` is a date, not a
 * number formatter), so this is a new, minimal one. `30` -> `"30"`, `7.5` -> `"7,5"`.
 */
export function formatDays(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return rounded.toString().replace(".", ",");
}
