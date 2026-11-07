// Issue #835 — API calls of the leave planner. One function per endpoint; the API decides every
// write and every access, nothing here is an access decision.
import { api } from "$api/client";
import type {
  LeavePlanListItem,
  LimitExceptionInput,
  PlannerReadDto,
  PlannerWish,
  TakeoverResult,
  WishInput,
  WishPatch,
} from "./types";

const BASE = "/leave/plans";

const enc = encodeURIComponent;

/** The plans of one salon, optionally narrowed to a year. */
export async function listPlans(salonId: string, year?: number): Promise<LeavePlanListItem[]> {
  const query = `?salonId=${enc(salonId)}${year === undefined ? "" : `&year=${enc(String(year))}`}`;
  const res = await api.get<{ plans: LeavePlanListItem[] }>(`${BASE}${query}`);
  return res.plans;
}

/** The live planner read of one plan. */
export function getPlan(id: string): Promise<PlannerReadDto> {
  return api.get<PlannerReadDto>(`${BASE}/${enc(id)}`);
}

export async function openPlan(input: {
  salonId: string;
  year: number;
  deadline: string | null;
}): Promise<LeavePlanListItem> {
  const res = await api.post<{ plan: LeavePlanListItem }>(BASE, input);
  return res.plan;
}

export async function setDeadline(id: string, deadline: string | null): Promise<LeavePlanListItem> {
  const res = await api.patch<{ plan: LeavePlanListItem }>(`${BASE}/${enc(id)}`, { deadline });
  return res.plan;
}

export async function createWish(planId: string, input: WishInput): Promise<PlannerWish> {
  const res = await api.post<{ wish: PlannerWish }>(`${BASE}/${enc(planId)}/wishes`, input);
  return res.wish;
}

export async function updateWish(
  planId: string,
  wishId: string,
  patch: WishPatch,
): Promise<PlannerWish> {
  const res = await api.patch<{ wish: PlannerWish }>(
    `${BASE}/${enc(planId)}/wishes/${enc(wishId)}`,
    patch,
  );
  return res.wish;
}

/** Soft removal on the server: the wish stays traceable, it no longer counts. */
export function removeWish(planId: string, wishId: string): Promise<void> {
  return api.delete<void>(`${BASE}/${enc(planId)}/wishes/${enc(wishId)}`);
}

export function takeOver(
  planId: string,
  limitExceptions?: LimitExceptionInput[],
): Promise<TakeoverResult> {
  const body = limitExceptions && limitExceptions.length > 0 ? { limitExceptions } : {};
  return api.post<TakeoverResult>(`${BASE}/${enc(planId)}/takeover`, body);
}
