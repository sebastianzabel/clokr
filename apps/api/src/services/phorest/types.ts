// Phase 85 (SS-01/SS-05/SS-07) — Shared Phorest wire shapes + sync contract.
// Consolidates the Phorest response/entry interfaces previously duplicated in
// plugins/scheduler.ts and routes/integrations.ts. Follows the services/clock/types.ts
// header-comment + named-export convention.
//
// NOTE ON WIRE FIDELITY: the wire shapes below are ASSUMED, derived from the existing
// (never-run-against-live) code. Open Questions 1-3 (RESEARCH) — stable entry id, exact
// endpoint path/params, time/TZ format — remain unresolved until an owner-recorded Phorest
// response is captured (the 85-05 gate). Do not trust live sync until then.

// ── Phorest wire shapes ──────────────────────────────────────────────

export interface PhorestStaffItem {
  staffId: string;
  firstName: string;
  lastName: string;
  email?: string;
}

export interface PhorestWorkTimeItem {
  // `id` is OPTIONAL: if the real Phorest response carries a stable per-entry id it becomes
  // the externalId; otherwise phorestShiftKey() falls back to a deterministic composite.
  id?: string;
  staffId: string;
  date?: string; // ISO date "yyyy-MM-dd" (may be absent — then derived from startTime)
  startTime?: string; // ISO datetime
  endTime?: string; // ISO datetime
}

export interface PhorestApiResponse {
  totalElements?: unknown;
  _embedded?: { staff?: PhorestStaffItem[]; staffWorkTimeTables?: PhorestWorkTimeItem[] };
  staff?: PhorestStaffItem[];
  staffWorkTimeTables?: PhorestWorkTimeItem[];
  [key: string]: unknown;
}

// ── Shared sync contract (RESEARCH Pattern 1) ────────────────────────

export interface SyncOpts {
  startDate?: string; // "yyyy-MM-dd" — manual override; default = today (tenant TZ)
  endDate?: string; // default = today + tenantConfig.phorestSyncWindowDays
  actorUserId?: string; // req.user.sub (manual) | undefined (cron = SYSTEM)
}

export interface SyncResult {
  runId: string;
  status: "SUCCESS" | "ERROR";
  created: number;
  updated: number;
  cancelled: number; // always 0 in Plan 01 — windowed soft-cancel is Plan 02
  unmapped: number; // count of worktime entries whose staffId has no explicit mapping
  unmappedStaff: { phorestStaffId: string; name?: string }[]; // deduplicated, for the UI warning
  error?: string;
}

/**
 * Stable externalId for a Phorest worktimetable entry — the idempotency key for upsert (SS-07).
 * Uses the Phorest entry id when present (Open Question 1), else a deterministic composite
 * `${staffId}|${date}|${startTime}|${endTime}` (Pitfall 3). The exact key is pinned by the
 * 85-05 owner-recording gate; until then the composite path applies.
 */
export function phorestShiftKey(wt: PhorestWorkTimeItem): string {
  if (wt.id) return wt.id;
  const date = wt.date ?? (wt.startTime ? wt.startTime.split("T")[0] : "");
  return `${wt.staffId}|${date}|${wt.startTime ?? ""}|${wt.endTime ?? ""}`;
}
