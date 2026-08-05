// Phase 85 (SS-01/SS-05/SS-07) — Shared Phorest wire shapes + sync contract.
// Consolidates the Phorest response/entry interfaces previously duplicated in
// plugins/scheduler.ts and routes/integrations.ts. Follows the services/clock/types.ts
// header-comment + named-export convention.
//
// WIRE FIDELITY (v3, CONFIRMED): the staff + worktimetable + appointment shapes below are
// the REAL Phorest "Third Party API" v3 wire-shape, captured from the OpenAPI spec at
// .planning/phases/85-phorest-shift-sync-produktionsreif/ref/phorest-openapi-v3.json
// (schemas DataPagedModelStaff / DataPagedModelWorkTimeTable / DataPagedModelAppointmentResponse
// / Staff / WorkTimeTable / WorkTimeSlot / AppointmentResponse). Staff live under
// `_embedded.staffs`; worktimetables under `_embedded.workTimeTables` with a NESTED
// `timeSlots[]` whose times are Joda LocalTime "HH:mm:ss" strings (NOT ISO datetimes) and
// whose dates are "yyyy-MM-dd"; appointments under `_embedded.appointments` with a SEPARATE
// `appointmentDate` "yyyy-MM-dd" + Joda LocalTime `startTime`/`endTime`. There is NO per-slot
// id on a worktimetable slot → the shift externalId stays the deterministic composite key,
// while an appointment carries a stable `appointmentId`.

// ── Phorest wire shapes ──────────────────────────────────────────────

export interface PhorestStaffItem {
  staffId: string;
  firstName: string;
  lastName: string;
  email?: string;
  archived?: boolean; // v3 Staff.archived — archived staff are skipped in the sync path
}

// v3 worktimetable is NESTED: DataPagedModelWorkTimeTable._embedded.workTimeTables[] where
// each WorkTimeTable groups a staff member's slots for the window.
export interface PhorestWorkTimeSlot {
  date: string; // "yyyy-MM-dd"
  startTime: string; // Joda LocalTime "HH:mm:ss" (NEVER an ISO datetime)
  endTime: string; // Joda LocalTime "HH:mm:ss"
  timeOffStartTime?: string; // LocalTime — break within a working slot (not modeled as a shift)
  timeOffEndTime?: string; // LocalTime
  type?: string; // v3 enum WORKING | NON_WORKING | NOT_SPECIFIED — only "WORKING" is kept (allow-list)
  custom?: unknown;
  branchId?: string;
  workActivityId?: string;
}

export interface PhorestWorkTimeTable {
  staffId: string;
  branchId?: string;
  timeSlots: PhorestWorkTimeSlot[];
}

// The FLAT per-slot item the sync consumes — produced by flattening workTimeTables[].timeSlots[]
// (extractWorkTimes). There is no slot-level id → phorestShiftKey() derives the deterministic
// composite `${staffId}|${date}|${startTime}|${endTime}`.
export interface PhorestWorkTimeItem {
  staffId: string;
  date?: string; // "yyyy-MM-dd" (from the slot)
  startTime?: string; // LocalTime "HH:mm:ss" (from the slot)
  endTime?: string; // LocalTime "HH:mm:ss" (from the slot)
}

// Phase 85 Plan 07 (SA-01/SA-02) — Phorest appointment wire shape, DSGVO-minimally modeled.
//
// CRITICAL: this interface deliberately models ONLY staffId + appointmentDate + start/end + the
// stable appointmentId. It does NOT model clientName / clientId / serviceName / price / notes or any
// other AppointmentResponse field the real payload ALSO carries — so the closed mapAppointment()
// literal that consumes it CANNOT read PII by construction, and a TypeScript reader of `a.clientName`
// would not compile. The DSGVO minimization is structural: the closed mapper is exactly what keeps
// the PII fields the confirmed v3 AppointmentResponse also carries out of the DB (see header note;
// source: ref/phorest-openapi-v3.json schema AppointmentResponse).
export interface PhorestAppointmentItem {
  // `appointmentId` is the confirmed v3 stable id → the externalId; phorestAppointmentKey() keeps a
  // deterministic composite fallback for the (spec-improbable) missing-id case.
  appointmentId?: string;
  staffId: string;
  appointmentDate?: string; // "yyyy-MM-dd" (the date lives in a SEPARATE field, NOT in startTime)
  startTime?: string; // Joda LocalTime "HH:mm:ss" (NOT an ISO datetime)
  endTime?: string; // Joda LocalTime "HH:mm:ss"
}

export interface PhorestApiResponse {
  totalElements?: unknown;
  _embedded?: {
    // v3 envelope keys (CONFIRMED) — the ONLY keys the reconciled sync/config paths read.
    staffs?: PhorestStaffItem[];
    workTimeTables?: PhorestWorkTimeTable[];
    appointments?: PhorestAppointmentItem[];
  };
  staffs?: PhorestStaffItem[];
  appointments?: PhorestAppointmentItem[];
  // Spring-HATEOAS pagination envelope (CONFIRMED v3, PageMetadata). `page.number` is the
  // zero-based current page, `page.totalPages` the count. `_links.next` is the fallback
  // has-more indicator.
  page?: { size?: number; totalElements?: number; totalPages?: number; number?: number };
  _links?: { next?: { href?: string } | null };
  [key: string]: unknown;
}

// ── Pagination (GATE 2 — exhaust all pages before diffing) ───────────
//
// The worktimetables endpoint is paginated. A page-1-only read must NEVER drive a
// soft-cancel of a page-2 shift, so the sync loops until the page set is exhausted.
// The paging keys are the CONFIRMED v3 Spring-HATEOAS `page{size,totalElements,totalPages,number}`
// envelope (from the OpenAPI spec — closes RESEARCH Open Question 2) and are centralised here.

/** Worktimetable page size requested per page (Phorest `size` param). */
export const PHOREST_PAGE_SIZE = 200;

/**
 * Flatten the NESTED v3 worktimetable envelope into a FLAT PhorestWorkTimeItem[] the sync
 * consumes: for each `_embedded.workTimeTables[]` and each of its `timeSlots[]`, emit one item
 * carrying the parent table's `staffId` plus the slot's `date`/`startTime`/`endTime`. Only slots
 * whose `type === "WORKING"` are KEPT (allow-list) — NON_WORKING, NOT_SPECIFIED, and any
 * unknown/absent type are days off, not shifts. Slot times are Joda LocalTime "HH:mm:ss" — passed
 * through verbatim here; the sync slices them to "HH:mm".
 */
export function extractWorkTimes(data: PhorestApiResponse): PhorestWorkTimeItem[] {
  const tables = data._embedded?.workTimeTables;
  if (!Array.isArray(tables)) return [];
  const items: PhorestWorkTimeItem[] = [];
  for (const table of tables) {
    const slots = table?.timeSlots;
    if (!Array.isArray(slots)) continue;
    for (const slot of slots) {
      // ALLOW-LIST (WR-01): keep ONLY confirmed working slots. The v3 WorkTimeSlot.type enum is
      // WORKING | NON_WORKING | NOT_SPECIFIED — a deny-list on "NON_WORKING" alone would let a
      // NOT_SPECIFIED slot (or an absent/unknown/future type) fall through as a phantom working
      // shift onto the §615 roster (inflated Soll / false undertime). extractWorkTimes drops `type`
      // entirely, so this is the ONLY filter point — non-working types are days off, not shifts.
      if (slot?.type !== "WORKING") continue;
      items.push({
        staffId: table.staffId,
        date: slot.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
      });
    }
  }
  return items;
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
  // Phase 85.1 (D-06/D-08): count of Phorest worktime slots skipped because the employee has an
  // active VOCATIONAL_SCHOOL absence that day ("BS gewinnt") — the shift is neither created nor
  // adopted, and the day is protected from soft-cancel/replace.
  skippedVocationalSchool: number;
  // Phase 85.1 (D-08/D-11): count of shifts soft-deleted by the Phorest-master replace pass
  // (deletedReason "PHOREST_REPLACED") because a Phorest-covered day's roster no longer includes
  // them — distinct from `cancelled` (PHOREST_REMOVED windowed reconcile of origin=PHOREST rows).
  replaced: number;
  // Phase 95 (SHIFT-02): count of active PHOREST shifts NOT soft-cancelled because the employee has
  // an active, not-yet-APPROVED leave (status PENDING | CANCELLATION_REQUESTED) on that day — the
  // "pending-leave gewinnt" protection, mirroring skippedVocationalSchool. IN-MEMORY ONLY: no
  // PhorestSyncRun DB column is written for it this phase (per 95-CONTEXT open question — the
  // per-day app.audit() row is sufficient observability; a persisted counter is an additive
  // migration deferred until the owner wants sync-run history for it). Not touched by finalizeRun.
  protectedPendingLeave: number;
  error?: string;
}

/**
 * Stable externalId for a Phorest worktimetable slot — the idempotency key for upsert (SS-07).
 * The v3 WorkTimeSlot has NO id, so the key is always the deterministic composite
 * `${staffId}|${date}|${startTime}|${endTime}` (CONFIRMS RESEARCH OQ1). `date` is "yyyy-MM-dd"
 * and start/end are the raw LocalTime "HH:mm:ss" slot values.
 */
export function phorestShiftKey(wt: PhorestWorkTimeItem): string {
  return `${wt.staffId}|${wt.date ?? ""}|${wt.startTime ?? ""}|${wt.endTime ?? ""}`;
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
  return `${a.staffId}|${a.appointmentDate ?? ""}|${a.startTime ?? ""}|${a.endTime ?? ""}`;
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
