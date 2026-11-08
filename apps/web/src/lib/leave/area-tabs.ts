/**
 * Issue #840 (D-840-01/02) — the ONE place the URL state of `/team/leave` is parsed and written:
 *
 *   /team/leave?tab=uebersicht|antraege|planung&zoom=jahr|quartal|monat&datum=YYYY-MM-DD
 *
 * Pure: no SvelteKit app-module import and no clock read — the page passes `today` (a
 * tenant-local `YYYY-MM-DD`). The parser never throws: an unknown value, an invalid day or a
 * hostile query falls back to its default, because the URL only selects presentation (T-840-05);
 * the server validates every query it receives. Tracer subset of plan 840-02, completed in 840-07.
 */
import type { Zoom } from "./timeline-model";

export type TeamLeaveTab = "uebersicht" | "antraege" | "planung";

export interface TeamLeaveState {
  tab: TeamLeaveTab;
  zoom: Zoom;
  /** The anchor day of the period, a real calendar day `YYYY-MM-DD`. */
  datum: string;
  /** True only when the URL carried a valid `tab` (a deep link chose the tab on purpose). */
  explicitTab: boolean;
}

const TABS: readonly TeamLeaveTab[] = ["uebersicht", "antraege", "planung"];
const ZOOMS: readonly Zoom[] = ["jahr", "quartal", "monat"];

export const DEFAULT_TAB: TeamLeaveTab = "uebersicht";
export const DEFAULT_ZOOM: Zoom = "quartal";

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar day in the `YYYY-MM-DD` shape (2026-02-30 is not one). */
function isRealDay(value: string): boolean {
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Tab, zoom and anchor day from the query; every unknown or invalid value takes its default. */
export function parseTeamLeaveState(params: URLSearchParams, today: string): TeamLeaveState {
  const tabParam = params.get("tab");
  const zoomParam = params.get("zoom");
  const datumParam = params.get("datum");
  const tab = TABS.find((t) => t === tabParam);
  const zoom = ZOOMS.find((z) => z === zoomParam);
  return {
    tab: tab ?? DEFAULT_TAB,
    zoom: zoom ?? DEFAULT_ZOOM,
    datum: datumParam !== null && isRealDay(datumParam) ? datumParam : today,
    explicitTab: tab !== undefined,
  };
}

/** The query string (without `?`) for a state, keys in the stable order tab, zoom, datum. */
export function teamLeaveSearch(state: TeamLeaveState): string {
  return `tab=${state.tab}&zoom=${state.zoom}&datum=${state.datum}`;
}
