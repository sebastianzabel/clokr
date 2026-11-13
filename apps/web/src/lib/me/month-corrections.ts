// Issue #599 (Phase 851): the own correction requests for a closed month - the client of
// /api/v1/month-corrections (Arbeitszeitkonto, PR #902). The booking rule lives in the API; the web only
// files a request, shows its status and maps the answer codes to what the person can do next.
import { api, ApiError } from "$api/client";

export type MonthCorrectionStatus = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";

export interface MonthCorrection {
  id: string;
  targetDate: string;
  startTime: string | null;
  endTime: string | null;
  breakMinutes: number | null;
  reason: string;
  status: MonthCorrectionStatus;
  isOwn: boolean;
  reviewNote: string | null;
  correctionMinutes: number | null;
  bookingDate: string | null;
  canWithdraw: boolean;
  createdAt: string;
}

export interface MonthCorrectionInput {
  targetDate: string;
  startTime?: string;
  endTime?: string;
  breakMinutes?: number;
  reason: string;
}

/** The one wording of a request's status (shown in the day sheet). */
export const MONTH_CORRECTION_STATUS_LABEL: Record<MonthCorrectionStatus, string> = {
  PENDING: "Korrekturanfrage wartet auf Entscheidung",
  APPROVED: "Korrektur genehmigt",
  REJECTED: "Korrektur abgelehnt",
  WITHDRAWN: "Korrekturanfrage zurückgezogen",
};

/** The own requests; an API that does not offer the route yet answers an empty list. */
export async function listOwnMonthCorrections(): Promise<MonthCorrection[]> {
  try {
    return await api.get<MonthCorrection[]>("/month-corrections?scope=own");
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return [];
    throw e;
  }
}

export function createMonthCorrection(input: MonthCorrectionInput): Promise<MonthCorrection> {
  return api.post<MonthCorrection>("/month-corrections", input);
}

/** The newest own request for one day, if any. */
export function correctionForDay(
  list: readonly MonthCorrection[],
  day: string,
): MonthCorrection | null {
  const ofDay = list.filter((c) => c.targetDate.slice(0, 10) === day);
  return ofDay.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null;
}

/** The answer code of a refused request (`{ error, code }`), or null. */
export function refusalCode(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const data = e.data as { code?: unknown } | undefined;
  return typeof data?.code === "string" ? data.code : null;
}
