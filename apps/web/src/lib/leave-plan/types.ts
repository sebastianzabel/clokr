// Issue #835 — the leave planner's API contract, mirrored field for field from
// `apps/api/src/contexts/absence/leave-plan/` (planner-read.ts, day-load.ts, forecast.ts,
// takeover.ts). The web image cannot import API code, so this file is the display-side copy; the
// API decides every rule and every access, nothing here is an access decision.

/** The stored plan as the open, list and deadline routes answer it. */
export interface LeavePlanListItem {
  id: string;
  salonId: string;
  year: number;
  deadline: string | null;
  status: "OPEN" | "TAKEN_OVER";
  openedAt: string;
  takenOverAt: string | null;
}

export interface PlannerRow {
  /** `MASKED`: a foreign absence outside the reader's reach — "abwesend", nothing else (#840). */
  kind: "LEAVE" | "ABSENCE" | "COMPANY_SHUTDOWN" | "MASKED";
  state: "GESETZT" | "BEANTRAGT" | "ABWESEND";
  startDate: string;
  endDate: string;
  halfDay: boolean;
  /** `null` when the reader may not learn the type (a colleague's row, a sick code). */
  typeCode: string | null;
}

export interface PlannerWish {
  id: string;
  planId: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  /** A wish of another open plan that touches the person's days in this salon (read-only). */
  foreignPlan: boolean;
  /** An unlinked wish over a leave row of the same person. */
  conflict: boolean;
  leaveRequestId: string | null;
  leaveRequestStatus: string | null;
  refusalCode: string | null;
  refusalMessage: string | null;
  editable: boolean;
  createdAt: string;
}

export interface PlannerForecast {
  entitlementBasis: "STORED" | "COMPUTED";
  remainingDays: number;
  pendingDays: number;
  wishDays: number;
  forecastDays: number;
  forecastNegative: boolean;
}

export interface PlannerPerson {
  employeeId: string;
  firstName: string;
  lastName: string;
  homeRanges: Array<{ from: string; to: string }>;
  rows: PlannerRow[];
  wishes: PlannerWish[];
  /** `null` outside the reader's entitlement reach. */
  forecast: PlannerForecast | null;
}

export interface PlannerDayLimit {
  ruleId: string;
  ruleName: string | null;
  groupKey: string;
  max: number;
  count: number;
  exceeded: boolean;
}

/** One day with at least one person on counted or wished leave. */
export interface PlannerDay {
  day: string;
  count: number;
  /** `null` unless the reader has the manage or approve reach over the salon. */
  limits: PlannerDayLimit[] | null;
}

export interface PlannerHoliday {
  date: string;
  name: string;
}

export interface PlannerReadDto {
  plan: {
    id: string;
    salonId: string;
    year: number;
    deadline: string | null;
    status: "OPEN" | "TAKEN_OVER";
    openedAt: string;
    takenOverAt: string | null;
    deadlinePassed: boolean;
    deadlineLocksWishes: boolean;
    partiallyTakenOver: boolean;
    /**
     * The wishes a takeover can still turn into a request or approve, counted by the server with the
     * takeover's own close rule (D-835-38); `null` for a reader who may not take the plan over.
     */
    openWishCount: number | null;
  };
  /** The plan salon (D-840-25): the personal planner draws its closed days from `openingHours`. */
  salon: { id: string; name: string; openingHours: unknown };
  viewer: {
    employeeId: string | null;
    canManage: boolean;
    canWishOwn: boolean;
    ownEditLocked: boolean;
  };
  persons: PlannerPerson[];
  holidays: PlannerHoliday[];
  dayLoad: PlannerDay[];
}

export type TakeoverPendingReason = "OWN_WISH" | "OUTSIDE_APPROVE_REACH" | "APPROVAL_REFUSED";

export interface TakeoverResult {
  created: Array<{ wishId: string; employeeId: string; leaveRequestId: string }>;
  pending: Array<{
    wishId: string;
    employeeId: string;
    leaveRequestId: string;
    reason: TakeoverPendingReason;
  }>;
  refused: Array<{ wishId: string; employeeId: string; code: string; error: string }>;
  planStatus: "OPEN" | "TAKEN_OVER";
}

/** A calendar range of whole days, `YYYY-MM-DD`, both bounds inclusive. */
export interface DayRange {
  startDate: string;
  endDate: string;
}

export interface WishInput {
  /** Only a manager names another person; omitted = the caller's own wish. */
  employeeId?: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
}

export type WishPatch = Partial<Pick<WishInput, "startDate" | "endDate" | "halfDay">>;

export interface LimitExceptionInput {
  wishId: string;
  reason: string;
}
