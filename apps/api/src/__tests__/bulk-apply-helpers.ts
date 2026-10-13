/**
 * Issue #568 — the shared two-step driver of the tenant-wide bulk apply of the default working time.
 *
 * `PUT /api/v1/settings/work` with the apply flag no longer works in one step: the server first
 * computes a preview (`POST /api/v1/settings/work/apply-defaults/preview`) and the apply must carry
 * that preview's fingerprint, the effective date and the selected employee ids. These helpers do
 * exactly what the admin dialog does, so a test exercises the real contract. No date math lives
 * here — that stays in `test-dates.ts`.
 */
import type { FastifyInstance } from "fastify";

export interface BulkContractValues {
  weeklyHours: number | null;
  mondayHours: number;
  tuesdayHours: number;
  wednesdayHours: number;
  thursdayHours: number;
  fridayHours: number;
  saturdayHours: number;
  sundayHours: number;
  workDays: number[];
  overtimeThreshold: number;
  allowOvertimePayout: boolean;
}

export interface BulkPreviewBody {
  effectiveFrom: string;
  earliestEffectiveFrom: string;
  latestEffectiveFrom: string;
  allowedEffectiveFrom: string[];
  fingerprint: string;
  proposed: BulkContractValues;
  candidates: Array<{
    employeeId: string;
    name: string;
    employeeNumber: string;
    category: "MATCHES_DEFAULTS" | "INDIVIDUAL" | "NO_CONTRACT";
    defaultSelected: boolean;
    before: (BulkContractValues & { type: string; validFrom: string }) | null;
    after: BulkContractValues;
  }>;
  nonCandidates: Array<{
    reason:
      | "FUTURE_CONTRACT"
      | "SAME_MONTH_MODEL_SWITCH"
      | "CONTRACT_AT_DATE_EXISTS"
      | "OTHER_SCHEDULE_TYPE"
      | "ALREADY_MATCHES_NEW";
    count: number;
    employees: Array<{ employeeId: string; name: string; employeeNumber: string }>;
  }>;
}

/** Calls the preview route; expects 200 and returns the parsed body. */
export async function previewBulkApply(
  app: FastifyInstance,
  token: string,
  args: { defaults: Record<string, unknown>; effectiveFrom?: string },
): Promise<BulkPreviewBody> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/settings/work/apply-defaults/preview",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      ...args.defaults,
      ...(args.effectiveFrom ? { effectiveFrom: args.effectiveFrom } : {}),
    },
  });
  if (res.statusCode !== 200) {
    throw new Error(`bulk-apply preview answered ${res.statusCode}: ${res.body}`);
  }
  return JSON.parse(res.body) as BulkPreviewBody;
}

/**
 * Runs the preview, then the apply with the preview's effective date and — unless overridden — its
 * fingerprint. `employeeIds: "defaultSelected"` selects what the dialog pre-ticks.
 */
export async function applyBulkDefaults(
  app: FastifyInstance,
  token: string,
  args: {
    defaults: Record<string, unknown>;
    effectiveFrom?: string;
    employeeIds: string[] | "defaultSelected";
    fingerprint?: string;
  },
) {
  const preview = await previewBulkApply(app, token, args);
  const ids =
    args.employeeIds === "defaultSelected"
      ? preview.candidates.filter((c) => c.defaultSelected).map((c) => c.employeeId)
      : args.employeeIds;
  const res = await app.inject({
    method: "PUT",
    url: "/api/v1/settings/work",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      ...args.defaults,
      applyToExisting: true,
      applyEmployeeIds: ids,
      previewFingerprint: args.fingerprint ?? preview.fingerprint,
      effectiveFrom: preview.effectiveFrom,
    },
  });
  return { res, preview };
}
