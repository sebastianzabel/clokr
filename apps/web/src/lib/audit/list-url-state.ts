// Issue #583 (Phase 854, D-854-10/-19, T-854-59) - the URL schema and the query of the Protokoll list.
// The filters live in the URL through `urlState()` with an allow-list: `from`/`to` (a calendar day that
// exists), `employeeId` (a uuid), `entity` (a code the label vocabulary knows) and `page`. Every other key
// of the URL is left alone, and a malformed value falls back instead of reaching the API (which validates
// again). A day is a tenant-local calendar day `YYYY-MM-DD`; the API converts it (plan 854-06).
//
// `from` has no stored default: an empty `from` means „the last 30 days“, resolved by `effectiveFilters()`
// at read time, so the URL stays short and a link keeps meaning „recent“ instead of freezing a date.
import { oneOf, int, pattern, type StateParser } from "$lib/table/url-state";

import { AUDIT_ENTITY_CODES } from "./labels";

/** The default look-back of the list, in days (the period ends today). */
export const DEFAULT_PERIOD_DAYS = 30;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a calendar day that exists (rejects 2026-02-31). */
export function isRealDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** A calendar day or "" (no value). */
function day(): StateParser<string> {
  const valid = (raw: unknown): raw is string => typeof raw === "string" && isRealDay(raw);
  return {
    fallback: "",
    parse: (raw) => (valid(raw) ? raw : ""),
    serialise: (value) => (valid(value) ? value : null),
  };
}

export const listUrlSchema = {
  from: day(),
  to: day(),
  employeeId: pattern(UUID, ""),
  entity: oneOf(["", ...AUDIT_ENTITY_CODES], ""),
  page: int({ min: 1, max: 100_000 }, 1),
};

/** What the URL carries. */
export interface AuditListState {
  from: string;
  to: string;
  employeeId: string;
  entity: string;
  page: number;
}

/** `YYYY-MM-DD` of a Date in the browser's local calendar (the web has no tenant-local „today“ helper). */
export function localDay(now: Date = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${mm}-${dd}`;
}

/** The calendar day `days` after (negative: before) `iso`. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Calendar days from `from` to `to`, both inclusive. */
export function inclusiveDays(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

/** The longest period the CSV export accepts (the API refuses more, plan 854-06). */
export const EXPORT_MAX_DAYS = 366;

/** The default `from`: today minus the look-back, so the period holds `DEFAULT_PERIOD_DAYS` days incl. today. */
export function defaultFrom(today: string): string {
  return addDays(today, -(DEFAULT_PERIOD_DAYS - 1));
}

/** The filters the page shows and queries with: an empty `from` is the default look-back. */
export function effectiveFilters(state: AuditListState, today: string): AuditListState {
  return { ...state, from: state.from || defaultFrom(today) };
}

/** A sentence for an impossible period, or null. */
export function periodProblem(filters: Pick<AuditListState, "from" | "to">): string | null {
  if (filters.from && filters.to && filters.to < filters.from) {
    return "Das Enddatum liegt vor dem Startdatum.";
  }
  return null;
}

/** A sentence when the period is too long to export, or null. `to` defaults to `today`. */
export function exportProblem(filters: Pick<AuditListState, "from" | "to">, today: string) {
  const to = filters.to || today;
  if (filters.from && to >= filters.from && inclusiveDays(filters.from, to) > EXPORT_MAX_DAYS) {
    return `Der Export umfasst höchstens ${EXPORT_MAX_DAYS} Tage. Wähle einen kürzeren Zeitraum.`;
  }
  return null;
}

/**
 * The query string (no leading "?") of the list read and of the CSV export - the SAME filters, so the file
 * holds exactly what the list shows. `paging` adds `page` and `limit` (the list only).
 */
export function auditQuery(
  filters: AuditListState,
  options: { today: string; paging?: { page: number; limit: number } },
): string {
  const params = new URLSearchParams();
  const effective = effectiveFilters(filters, options.today);
  params.set("from", effective.from);
  // The export needs a bounded period; for the list an open end is simply „until now“.
  if (effective.to) params.set("to", effective.to);
  if (effective.employeeId) params.set("employeeId", effective.employeeId);
  if (effective.entity) params.set("entity", effective.entity);
  if (options.paging) {
    params.set("page", String(options.paging.page));
    params.set("limit", String(options.paging.limit));
  }
  return params.toString();
}

/** Same as `auditQuery` for the export: `to` is always present (today when the URL has none). */
export function auditExportQuery(filters: AuditListState, today: string): string {
  return auditQuery({ ...filters, to: filters.to || today }, { today });
}
