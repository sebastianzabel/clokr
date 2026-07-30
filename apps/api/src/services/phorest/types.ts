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

// Phase 86 (SA-01/SA-02) — Phorest appointment wire shape, DSGVO-minimally modeled.
//
// CRITICAL: this interface deliberately models ONLY staffId + start/end + an optional stable id.
// It does NOT model clientName / clientId / serviceName / price or any other appointment field —
// so the closed mapAppointment() literal that consumes it CANNOT read PII by construction, and a
// TypeScript reader of `a.clientName` would not compile. The DSGVO minimization is structural.
// Wire shape is ASSUMED (inherits the 85-05 owner-recording gate) — see the header note above.
export interface PhorestAppointmentItem {
  // `appointmentId` is OPTIONAL: if the real Phorest response carries a stable per-appointment id
  // it becomes the externalId; otherwise phorestAppointmentKey() falls back to a deterministic composite.
  appointmentId?: string;
  staffId: string;
  startTime?: string; // ISO datetime
  endTime?: string; // ISO datetime
}

export interface PhorestApiResponse {
  totalElements?: unknown;
  _embedded?: {
    staff?: PhorestStaffItem[];
    staffWorkTimeTables?: PhorestWorkTimeItem[];
    appointments?: PhorestAppointmentItem[];
  };
  staff?: PhorestStaffItem[];
  staffWorkTimeTables?: PhorestWorkTimeItem[];
  appointments?: PhorestAppointmentItem[];
  // Spring-HATEOAS pagination envelope (ASSUMED, Open Question 2). `page.number` is the
  // zero-based current page, `page.totalPages` the count. `_links.next` is the fallback
  // has-more indicator. Kept here so the 85-05 owner-recording gate can pin the exact keys.
  page?: { size?: number; totalElements?: number; totalPages?: number; number?: number };
  _links?: { next?: { href?: string } | null };
  [key: string]: unknown;
}

// ── Pagination (GATE 2 — exhaust all pages before diffing) ───────────
//
// The worktimetables endpoint is paginated. A page-1-only read must NEVER drive a
// soft-cancel of a page-2 shift, so the sync loops until the page set is exhausted.
// The exact paging keys are ASSUMED (Open Question 2) and centralised here so the
// 85-05 gate pins them in one place.

/** Worktimetable page size requested per page (Phorest `size` param). */
export const PHOREST_PAGE_SIZE = 200;

/** Extract the worktimetable entries from a (possibly paged) Phorest response. */
export function extractWorkTimes(data: PhorestApiResponse): PhorestWorkTimeItem[] {
  const entries =
    data._embedded?.staffWorkTimeTables ??
    data.staffWorkTimeTables ??
    (Array.isArray(data) ? (data as PhorestWorkTimeItem[]) : []);
  return Array.isArray(entries) ? entries : [];
}

/**
 * True when another worktimetables page must be fetched. Prefers the explicit Spring
 * `page` envelope (`number < totalPages - 1`); falls back to a `_links.next` HATEOAS
 * link; final fallback treats a FULL page (entries === requested size) as "there may be
 * more". A short/empty page with no envelope means the read is complete.
 */
export function phorestHasMorePages(
  data: PhorestApiResponse,
  currentPage: number,
  pageEntryCount: number,
  requestedSize: number,
): boolean {
  const p = data.page;
  if (p && typeof p.totalPages === "number") {
    const num = typeof p.number === "number" ? p.number : currentPage;
    return num < p.totalPages - 1;
  }
  if (data._links?.next?.href) return true;
  // No pagination envelope at all → single-page response unless the page came back full.
  return pageEntryCount >= requestedSize;
}

// ── Shared sync contract (RESEARCH Pattern 1) ────────────────────────

export interface SyncOpts {
  startDate?: string; // "yyyy-MM-dd" — manual override; default = today (tenant TZ)
  endDate?: string; // default = today + tenantConfig.phorestSyncWindowDays
  actorUserId?: string; // req.user.sub (manual) | undefined (cron = SYSTEM)
}

export interface SyncResult {
  runId: string;
  // SUSPECT (Plan 02, GATE 3): an HTTP-200 fetch whose in-window set is empty while the DB
  // still holds active PHOREST shifts in that window — treated as a likely wrong-branchId /
  // dropped-connection read, so ZERO shifts are cancelled and the run is flagged, not SUCCESS.
  status: "SUCCESS" | "ERROR" | "SUSPECT";
  created: number;
  updated: number;
  cancelled: number; // count of shifts soft-cancelled by windowed reconciliation (Plan 02)
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

// ── Appointment sync contract (Phase 86, SA-01/SA-02/SA-03) ──────────

/** Extract the appointment entries from a (possibly paged) Phorest response. Mirrors extractWorkTimes. */
export function extractAppointments(data: PhorestApiResponse): PhorestAppointmentItem[] {
  const entries =
    data._embedded?.appointments ??
    data.appointments ??
    (Array.isArray(data) ? (data as PhorestAppointmentItem[]) : []);
  return Array.isArray(entries) ? entries : [];
}

/**
 * Stable externalId for a Phorest appointment — a non-load-bearing idempotency/debug key (with
 * hard-replace it is a nice-to-have, not the reconcile key). Uses the Phorest appointmentId when
 * present, else a deterministic composite `${staffId}|${date}|${startTime}|${endTime}` (mirror
 * phorestShiftKey). Reads ONLY staff + start/end — never any customer/service field.
 */
export function phorestAppointmentKey(a: PhorestAppointmentItem): string {
  if (a.appointmentId) return a.appointmentId;
  const date = a.startTime ? a.startTime.split("T")[0] : "";
  return `${a.staffId}|${date}|${a.startTime ?? ""}|${a.endTime ?? ""}`;
}

export interface AppointmentSyncOpts {
  actorUserId?: string; // req.user.sub (manual) | undefined (cron = SYSTEM)
  runId?: string; // the shift run to record appointment counters onto (SA-03 shared run)
  horizonDays?: number; // override the forward window; default = tenantConfig.phorestAppointmentHorizonDays
}

export interface AppointmentSyncResult {
  status: "SUCCESS" | "ERROR";
  appointmentsStored: number;
  appointmentsRemoved: number;
  error?: string;
}
