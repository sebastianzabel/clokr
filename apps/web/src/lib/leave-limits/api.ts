// Issue #836 — API calls of the leave-limit admin page. The API decides every write; nothing here
// is an access decision.
import { api } from "$api/client";
import type { LeaveLimitRuleBody, LeaveLimitRuleDto, LeaveLimitRulesResponse } from "./types";

const BASE = "/leave/limits";

/** Lists the rules of one salon (plus the all-salons rules), or every rule in reach for `null`. */
export function fetchLeaveLimitRules(salonId: string | null): Promise<LeaveLimitRulesResponse> {
  const query = salonId ? `?salonId=${encodeURIComponent(salonId)}` : "";
  return api.get<LeaveLimitRulesResponse>(`${BASE}${query}`);
}

export function createLeaveLimitRule(body: LeaveLimitRuleBody): Promise<LeaveLimitRuleDto> {
  return api.post<LeaveLimitRuleDto>(BASE, body);
}

export function updateLeaveLimitRule(
  id: string,
  body: LeaveLimitRuleBody,
): Promise<LeaveLimitRuleDto> {
  return api.put<LeaveLimitRuleDto>(`${BASE}/${encodeURIComponent(id)}`, body);
}

/** Soft removal: the rule stays traceable, it no longer applies. */
export function removeLeaveLimitRule(id: string): Promise<void> {
  return api.delete<void>(`${BASE}/${encodeURIComponent(id)}`);
}
