/**
 * Issue #840 (D-840-01/02/03) — the ONE place the URL state of both absence areas is parsed and
 * written, and the ONE place the redirect targets of the old URLs are decided:
 *
 *   /team/leave?tab=uebersicht|antraege|planung&zoom=jahr|quartal|monat&datum=YYYY-MM-DD
 *               [&status=<STATUS>][&request=<uuid>]
 *   /leave?tab=kalender|antraege|team|planung&zoom=…&datum=…[&status=<STATUS>][&request=<uuid>]
 *
 * `salonId=<uuid>` and `year=<YYYY>` are read (the #835 planner deep link and the notification
 * links use them) but never written back: the page strips them after reading, so a shared link
 * carries the period (`datum`), not a one-off hint.
 *
 * Pure: no SvelteKit app-module import and no clock read — the caller passes `today` (a
 * tenant-local `YYYY-MM-DD`). The parsers never throw: an unknown value, an invalid day or a
 * hostile query falls back to its default or is dropped, because the URL only selects
 * presentation (T-840-05); the server validates every query it receives.
 *
 * Redirects (T-840-20, open redirect): a target is always one of the FIXED paths `/team/leave`,
 * `/leave` or `/inbox`. A path or URL is never taken from the query; only whitelisted parameters
 * are carried over, each re-validated (uuid, real `YYYY-MM-DD`, 4-digit year, enum) and dropped
 * when invalid.
 */
import { normalizeDateParam, normalizeEmployeeIdParam } from "$lib/breaks/deep-link";
import type { Zoom } from "./timeline-model";

export type TeamLeaveTab = "uebersicht" | "antraege" | "planung";
export type MyLeaveTab = "kalender" | "antraege" | "team" | "planung";

/** Request status filter of the Anträge tab; absent means „Alle“. */
export type LeaveStatusFilter =
  "PENDING" | "APPROVED" | "CANCELLATION_REQUESTED" | "REJECTED" | "CANCELLED";

/** What both areas read from the URL; the tab type differs per area. */
export interface LeaveAreaState<Tab extends string> {
  tab: Tab;
  zoom: Zoom;
  /** The anchor day of the period, a real calendar day `YYYY-MM-DD`. */
  datum: string;
  /** True only when the URL carried a valid `tab` (a deep link chose the tab on purpose). */
  explicitTab: boolean;
  /** Status filter of the Anträge tab, or `null` for „Alle“. */
  status: LeaveStatusFilter | null;
  /** A request to highlight (lowercase uuid), or `null`. */
  requestId: string | null;
  /** A salon deep link (lowercase uuid; presentation only), or `null`. */
  salonId: string | null;
  /** A deep-linked year (4 digits), or `null`; it only anchors the period when `datum` is absent. */
  year: number | null;
}

export type TeamLeaveState = LeaveAreaState<TeamLeaveTab>;
export type MyLeaveState = LeaveAreaState<MyLeaveTab>;

const TEAM_TABS: readonly TeamLeaveTab[] = ["uebersicht", "antraege", "planung"];
const MY_TABS: readonly MyLeaveTab[] = ["kalender", "antraege", "team", "planung"];
const ZOOMS: readonly Zoom[] = ["jahr", "quartal", "monat"];
const STATUSES: readonly LeaveStatusFilter[] = [
  "PENDING",
  "APPROVED",
  "CANCELLATION_REQUESTED",
  "REJECTED",
  "CANCELLED",
];

export const TEAM_DEFAULT_TAB: TeamLeaveTab = "uebersicht";
export const MY_DEFAULT_TAB: MyLeaveTab = "kalender";

/** Default zoom per tab (D-840-02): working views a quarter, the personal views a month. */
const TEAM_DEFAULT_ZOOM: Record<TeamLeaveTab, Zoom> = {
  uebersicht: "quartal",
  antraege: "quartal",
  planung: "quartal",
};
const MY_DEFAULT_ZOOM: Record<MyLeaveTab, Zoom> = {
  kalender: "monat",
  antraege: "monat",
  team: "monat",
  planung: "quartal",
};

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_RE = /^\d{4}$/;

/** True for a real calendar day in the exact `YYYY-MM-DD` shape (2026-02-30 is not one). */
function isRealDay(value: string): boolean {
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** A 4-digit year from 1000 on (below that `Date.UTC` would read it as 19xx), else `null`. */
function parseYear(raw: string | null): number | null {
  if (raw === null || !YEAR_RE.test(raw)) return null;
  const year = Number(raw);
  return year >= 1000 ? year : null;
}

/** A lowercase uuid or `null`; the same shape check the other deep links use. */
function normalizeUuid(raw: string | null): string | null {
  return normalizeEmployeeIdParam(raw);
}

function parseDay(raw: string | null): string | null {
  return raw !== null && isRealDay(raw) ? raw : null;
}

function parseStatus(raw: string | null): LeaveStatusFilter | null {
  return STATUSES.find((s) => s === raw) ?? null;
}

/** The anchor day: a valid `datum`, else the first day (or today) of a deep-linked year, else today. */
function anchorDay(datum: string | null, year: number | null, today: string): string {
  if (datum !== null) return datum;
  if (year === null) return today;
  return Number(today.slice(0, 4)) === year ? today : `${String(year).padStart(4, "0")}-01-01`;
}

function parseAreaState<Tab extends string>(
  params: URLSearchParams,
  today: string,
  tabs: readonly Tab[],
  defaultTab: Tab,
  defaultZoom: Record<Tab, Zoom>,
): LeaveAreaState<Tab> {
  const tabParam = params.get("tab");
  const zoomParam = params.get("zoom");
  const tab = tabs.find((t) => t === tabParam);
  const zoom = ZOOMS.find((z) => z === zoomParam);
  const effectiveTab = tab ?? defaultTab;
  return {
    tab: effectiveTab,
    zoom: zoom ?? defaultZoom[effectiveTab],
    datum: anchorDay(parseDay(params.get("datum")), parseYear(params.get("year")), today),
    explicitTab: tab !== undefined,
    status: parseStatus(params.get("status")),
    requestId: normalizeUuid(params.get("request")),
    salonId: normalizeUuid(params.get("salonId")),
    year: parseYear(params.get("year")),
  };
}

/** Tab, zoom, anchor day and filters of `/team/leave`; every unknown or invalid value is a default. */
export function parseTeamLeaveState(params: URLSearchParams, today: string): TeamLeaveState {
  return parseAreaState(params, today, TEAM_TABS, TEAM_DEFAULT_TAB, TEAM_DEFAULT_ZOOM);
}

/** Tab, zoom, anchor day and filters of `/leave` (Mein Bereich). */
export function parseMyLeaveState(params: URLSearchParams, today: string): MyLeaveState {
  return parseAreaState(params, today, MY_TABS, MY_DEFAULT_TAB, MY_DEFAULT_ZOOM);
}

/**
 * The query string (without `?`) for a state, keys in the stable order tab, zoom, datum, status,
 * request. `status` and `request` appear only when set; `salonId` and `year` are never written.
 */
function areaSearch(state: LeaveAreaState<string>): string {
  const parts = [`tab=${state.tab}`, `zoom=${state.zoom}`, `datum=${state.datum}`];
  if (state.status !== null) parts.push(`status=${state.status}`);
  if (state.requestId !== null) parts.push(`request=${state.requestId}`);
  return parts.join("&");
}

export function teamLeaveSearch(state: TeamLeaveState): string {
  return areaSearch(state);
}

export function myLeaveSearch(state: MyLeaveState): string {
  return areaSearch(state);
}

// ── Redirect targets of the old URLs (D-840-03) ──────────────────────────────────────────────

const TEAM_LEAVE_PATH = "/team/leave";
const MY_LEAVE_PATH = "/leave";
const INBOX_PATH = "/inbox";

/** Whitelist of the parameters a redirect may carry over (everything else is dropped). */
export const REDIRECT_CARRIED_PARAMS = [
  "salonId",
  "year",
  "create",
  "employeeId",
  "date",
  "status",
  "request",
  "tab",
  "zoom",
  "datum",
] as const;

/** The carried parameters in the order they are written; every value already re-validated. */
interface CarriedParams {
  tab: string | null;
  zoom: Zoom | null;
  datum: string | null;
  status: LeaveStatusFilter | null;
  request: string | null;
  salonId: string | null;
  year: number | null;
  create: boolean;
  employeeId: string | null;
  date: string | null;
}

/** Reads and re-validates every whitelisted parameter; `tab` is checked against `tabs`. */
function carriedParams(params: URLSearchParams, tabs: readonly string[]): CarriedParams {
  const tabParam = params.get("tab");
  const zoomParam = params.get("zoom");
  const create = params.get("create") === "1";
  return {
    tab: tabs.find((t) => t === tabParam) ?? null,
    zoom: ZOOMS.find((z) => z === zoomParam) ?? null,
    datum: parseDay(params.get("datum")),
    status: parseStatus(params.get("status")),
    request: normalizeUuid(params.get("request")),
    salonId: normalizeUuid(params.get("salonId")),
    year: parseYear(params.get("year")),
    // The create link is `create=1` plus a person and a day; the two values are only meaningful
    // together with it, so without `create=1` they are dropped.
    create,
    employeeId: create ? normalizeEmployeeIdParam(params.get("employeeId")) : null,
    date: create ? normalizeDateParam(params.get("date")) : null,
  };
}

/** `path?k=v&…` from a FIXED path and validated values, in the stable key order. */
function targetOf(path: string, p: CarriedParams): string {
  const parts: string[] = [];
  const push = (key: string, value: string | number | null) => {
    if (value !== null) parts.push(`${key}=${encodeURIComponent(String(value))}`);
  };
  push("tab", p.tab);
  push("zoom", p.zoom);
  push("datum", p.datum);
  push("status", p.status);
  push("request", p.request);
  push("salonId", p.salonId);
  push("year", p.year);
  if (p.create) push("create", "1");
  push("employeeId", p.employeeId);
  push("date", p.date);
  return `${path}?${parts.join("&")}`;
}

const LEGACY_VIEW_TAB: Record<string, { tab: TeamLeaveTab; status?: LeaveStatusFilter }> = {
  approvals: { tab: "antraege", status: "PENDING" },
  calendar: { tab: "uebersicht" },
  list: { tab: "antraege" },
};

/**
 * The new home of an old `/team/leave` URL, or `null` when the URL needs no redirect (also the
 * loop guard: a target never carries `view` or `section9`, and a `request` link that names its
 * tab is final).
 *
 * - `section9=<uuid>` → `/inbox?section9=<uuid>` (the § 9 cases live in the inbox)
 * - `view=approvals|calendar|list` → the tab of the same meaning; an explicit valid `tab` wins
 * - `request=<uuid>` without a valid `tab` → the Anträge tab with that row highlighted
 *
 * `create`, `employeeId`, `date` and the other whitelisted parameters are carried unchanged.
 */
export function teamLeaveRedirect(params: URLSearchParams): string | null {
  const section9 = normalizeUuid(params.get("section9"));
  if (section9 !== null) return `${INBOX_PATH}?section9=${section9}`;

  const carried = carriedParams(params, TEAM_TABS);
  const viewParam = params.get("view");
  const legacyView = Object.hasOwn(LEGACY_VIEW_TAB, viewParam ?? "")
    ? LEGACY_VIEW_TAB[viewParam as string]
    : undefined;

  if (legacyView !== undefined) {
    const explicitTab = carried.tab !== null;
    return targetOf(TEAM_LEAVE_PATH, {
      ...carried,
      tab: carried.tab ?? legacyView.tab,
      // The PENDING filter belongs to the approvals view; it never overrides an explicit filter
      // and never rides along when the caller chose another tab on purpose.
      status: carried.status ?? (explicitTab ? null : (legacyView.status ?? null)),
    });
  }

  if (carried.request !== null && carried.tab === null) {
    return targetOf(TEAM_LEAVE_PATH, { ...carried, tab: "antraege" });
  }

  return null;
}

/** `/teamcal` is the Übersicht tab at month zoom; a valid salon, anchor day and year are carried. */
export function teamcalRedirect(params: URLSearchParams): string {
  const carried = carriedParams(params, TEAM_TABS);
  return targetOf(TEAM_LEAVE_PATH, {
    tab: "uebersicht",
    zoom: "monat",
    datum: carried.datum,
    status: null,
    request: null,
    salonId: carried.salonId,
    year: carried.year,
    create: false,
    employeeId: null,
    date: null,
  });
}

/**
 * `/leave/planung` is the Planung tab of the team area for a caller who may manage plans, else of
 * Mein Bereich (the web check is presentation; the API decides every read and write). The salon
 * deep link and the year are carried, so the #835 notification link keeps working.
 */
export function planungRedirect(params: URLSearchParams, canManage: boolean): string {
  const carried = carriedParams(params, []);
  return targetOf(canManage ? TEAM_LEAVE_PATH : MY_LEAVE_PATH, {
    tab: "planung",
    zoom: carried.zoom,
    datum: carried.datum,
    status: null,
    request: null,
    salonId: carried.salonId,
    year: carried.year,
    create: false,
    employeeId: null,
    date: null,
  });
}
