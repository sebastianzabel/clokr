/**
 * Issue #84 — the decisions behind the dashboard's Team block. Pure, no `$app/*` import, so it is
 * directly mountable in `vitest` (the dashboard page itself is not — see `week-progress.ts`).
 *
 * Presentation only: the salon filter narrows what the server returns, it never widens a reach
 * (#82 D-05). Every `salonId` is validated by the API; a rejected one answers 404, which the page
 * shows as a calm empty state (`isTeamSalonRejected`, D-16).
 *
 * The page sums nothing across salons: every figure arrives aggregated from the team endpoints
 * (D-07/D-08). What this module adds is the decision WHETHER to filter (D-11), which series and
 * notes a response allows (D-05/D-12) and the German wording that goes with them. Control flow
 * reads the response CODES (`workedBasis`, `sollUnavailableReason`), never a display string.
 */
import { format } from "date-fns";
import { de } from "date-fns/locale";
import { ApiError } from "$api/client";
import { selectedSalonId, showSalonOptions, type SalonContextState } from "$stores/salon-context";

/**
 * What the #64 rule and the selection need from the store. Derived from `showSalonOptions` so this
 * module never names the rule's input itself (salon-context-wiring-82.test.ts: one owner).
 */
type TeamContextState = Parameters<typeof showSalonOptions>[0] &
  Pick<SalonContextState, "salons" | "selection">;

/** One month of `GET /dashboard/team-trend` (Issue #84, D-07). */
export interface TeamTrendMonth {
  /** "YYYY-MM" */
  month: string;
  workedMinutes: number;
  /** null when the Soll is not available (see `sollUnavailableReason`). */
  shouldMinutes: number | null;
  sickDays: number;
}

export interface TeamTrendResponse {
  salonId: string | null;
  /** ACCOUNT = the working-time account's Ist; SALON_ENTRIES = closed valid entries of one salon. */
  workedBasis: "ACCOUNT" | "SALON_ENTRIES";
  sollUnavailableReason: "NO_PERMISSION" | "SALON_FILTER" | null;
  months: TeamTrendMonth[];
}

export interface TeamUpcomingLeaveItem {
  id: string;
  employeeId: string;
  employeeName: string;
  startDate: string;
  endDate: string;
  days: number;
  leaveTypeName: string;
  leaveTypeCode: string;
}

/** `GET /dashboard/team-upcoming-leave` (Issue #84, D-08). */
export interface TeamUpcomingLeaveResponse {
  salonId: string | null;
  items: TeamUpcomingLeaveItem[];
}

export const TEAM_SOLL_NOT_ATTRIBUTABLE_NOTE =
  "Das Soll ist eine Vertragsgröße der Person und lässt sich keinem Salon zuordnen.";

export const TEAM_SALDO_NOT_ATTRIBUTABLE_NOTE =
  "Der Saldo ist eine Vertragsgröße der Person und lässt sich keinem Salon zuordnen. Ohne Salonfilter sehen Sie hier den Verlauf über alle Salons.";

/**
 * D-11: the dashboard sends a `salonId` only while the header offers salon options. The store
 * preselects the sole reachable salon, so `selectedSalonId()` alone would put a one-salon tenant
 * into filtered mode and hide its Soll — this guard is the only place that decision is made.
 */
export function teamSalonFilter(state: TeamContextState): string | null {
  return showSalonOptions(state) ? selectedSalonId(state) : null;
}

/** Appends `salonId` to a request path; no salon leaves the path untouched. */
export function withSalonId(path: string, salonId: string | null): string {
  if (salonId === null) return path;
  return `${path}${path.includes("?") ? "&" : "?"}salonId=${encodeURIComponent(salonId)}`;
}

export interface TeamTrendView {
  months: { month: string; label: string }[];
  workedHours: number[];
  /** null: the Soll series is not drawn. */
  shouldHours: number[] | null;
  sickDays: number[];
  workedSeriesLabel: string;
  chartSub: string;
  /** Shown below the Arbeitsstunden chart when the Soll is not attributable to a salon. */
  sollNote: string | null;
  /** Shown instead of the Überstunden-Trend chart under a salon filter. */
  trendNote: string | null;
}

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return format(new Date(year, monthNumber - 1, 1), "MMM yy", { locale: de });
}

function toHours(minutes: number): number {
  return +(minutes / 60).toFixed(1);
}

/** D-05/D-12: which series and notes a team-trend response allows. */
export function teamTrendView(resp: TeamTrendResponse): TeamTrendView {
  const salonEntries = resp.workedBasis === "SALON_ENTRIES";
  const shouldMinutes = resp.months.map((m) => m.shouldMinutes);
  const hasSoll =
    resp.sollUnavailableReason === null && shouldMinutes.every((value) => value !== null);
  return {
    months: resp.months.map((m) => ({ month: m.month, label: monthLabel(m.month) })),
    workedHours: resp.months.map((m) => toHours(m.workedMinutes)),
    shouldHours: hasSoll ? shouldMinutes.map((value) => toHours(value as number)) : null,
    sickDays: resp.months.map((m) => m.sickDays),
    workedSeriesLabel: salonEntries ? "Erfasste Arbeitszeit im Salon (h)" : "Ist (h)",
    chartSub: salonEntries ? "Erfasste Arbeitszeit im Salon · Letzte 6 Monate" : "Letzte 6 Monate",
    sollNote:
      resp.sollUnavailableReason === "SALON_FILTER" ? TEAM_SOLL_NOT_ATTRIBUTABLE_NOTE : null,
    trendNote:
      resp.sollUnavailableReason === "SALON_FILTER" ? TEAM_SALDO_NOT_ATTRIBUTABLE_NOTE : null,
  };
}

/** D-16: shown instead of the Team block when the server rejects the selected salon (404). */
export const TEAM_SALON_UNAVAILABLE_TEXT =
  "Für diesen Salon liegt keine Teamansicht vor. Wählen Sie in der Kopfleiste „Alle Salons“ oder einen anderen Salon.";

/**
 * D-01: what the Team divider says the figures refer to — null while no salon options are shown
 * (as before #84). The salon name is display only and never compared.
 */
export function teamViewLabel(state: TeamContextState): string | null {
  if (!showSalonOptions(state)) return null;
  const salonId = teamSalonFilter(state);
  if (salonId === null) return "Alle Salons";
  return state.salons.find((salon) => salon.id === salonId)?.name ?? "Alle Salons";
}

/**
 * D-16: every rejection cause of a `salonId` (foreign, unknown, inactive, out of reach) answers the
 * same 404; any other failure keeps its usual handling.
 */
export function isTeamSalonRejected(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export interface UpcomingLeaveCard {
  id: string;
  employeeName: string;
  startDate: string;
  endDate: string;
  days: number;
  type: string;
}

/** Maps the server items of `team-upcoming-leave` to the card's shape. */
export function upcomingFromResponse(items: TeamUpcomingLeaveItem[]): UpcomingLeaveCard[] {
  return items.map((item) => ({
    id: item.id,
    employeeName: item.employeeName,
    startDate: item.startDate,
    endDate: item.endDate,
    days: item.days,
    type: item.leaveTypeName,
  }));
}
