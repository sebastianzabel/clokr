/**
 * Bulk apply of the tenant default working time — preview client (Issue #568, D-07).
 *
 * The server is the authority: it computes the candidate set, the fingerprint and the allowed
 * effective dates (`allowedEffectiveFrom`). The browser only chooses inside that preview and
 * never computes the tenant-timezone date rule itself (O5).
 */
import { api, ApiError } from "$api/client";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ContractValues {
  weeklyHours: number | null;
  mondayHours: number;
  tuesdayHours: number;
  wednesdayHours: number;
  thursdayHours: number;
  fridayHours: number;
  saturdayHours: number;
  sundayHours: number;
  /** Weekday indices, 0 = Sunday .. 6 = Saturday. */
  workDays: number[];
  overtimeThreshold: number;
  allowOvertimePayout: boolean;
}

export type BulkApplyCategory = "MATCHES_DEFAULTS" | "INDIVIDUAL" | "NO_CONTRACT";

export type BulkApplyReason =
  | "FUTURE_CONTRACT"
  | "SAME_MONTH_MODEL_SWITCH"
  | "CONTRACT_AT_DATE_EXISTS"
  | "OTHER_SCHEDULE_TYPE"
  | "ALREADY_MATCHES_NEW";

export interface BulkApplyCandidate {
  employeeId: string;
  name: string;
  employeeNumber: string;
  category: BulkApplyCategory;
  defaultSelected: boolean;
  before: (ContractValues & { type: string; validFrom: string }) | null;
  after: ContractValues;
}

export interface BulkApplyNonCandidateGroup {
  reason: BulkApplyReason;
  count: number;
  employees: { employeeId: string; name: string; employeeNumber: string }[];
}

export interface BulkApplyPreview {
  effectiveFrom: string;
  earliestEffectiveFrom: string;
  latestEffectiveFrom: string;
  allowedEffectiveFrom: string[];
  fingerprint: string;
  proposed: ContractValues;
  candidates: BulkApplyCandidate[];
  nonCandidates: BulkApplyNonCandidateGroup[];
}

/** The proposed working-time defaults the preview classifies against (same keys as the PUT). */
export interface BulkApplyPreviewRequest {
  defaultWeeklyHours: number;
  defaultMondayHours: number;
  defaultTuesdayHours: number;
  defaultWednesdayHours: number;
  defaultThursdayHours: number;
  defaultFridayHours: number;
  defaultSaturdayHours: number;
  defaultSundayHours: number;
  overtimeThreshold: number;
  allowOvertimePayout: boolean;
  effectiveFrom?: string;
}

/** What the admin confirmed in the dialog; sent with the PUT of the defaults. */
export interface BulkApplySelection {
  applyEmployeeIds: string[];
  previewFingerprint: string;
  effectiveFrom: string;
}

/** The control code of the API when the preview no longer matches the stored state. */
const STALE_PREVIEW_CODE = "BULK_APPLY_PREVIEW_STALE";

/** True only for the stale-preview 409 — the UI then reloads the preview. */
export function isStalePreviewError(err: unknown): err is ApiError {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const data = err.data as { code?: unknown } | undefined;
  return data?.code === STALE_PREVIEW_CODE;
}

export function fetchBulkApplyPreview(body: BulkApplyPreviewRequest) {
  return api.post<BulkApplyPreview>("/settings/work/apply-defaults/preview", body);
}
