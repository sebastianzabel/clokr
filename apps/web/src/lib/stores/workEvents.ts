// Phase 82 (UI-V19-07 + UI-V19-08 + UI-V19-09) — typed fetch namespace
// for /work-events* endpoints. NOT a reactive singleton — each consumer
// page holds the response in page-local $state (avoids cross-page state
// leakage that re-introduces v1.8.12 class of bug at the frontend layer).
//
// - loadMine: structurally cannot accept an employeeId param (signature blocks it).
//   Server-side enforcement (Phase 79) ignores any such param even if forged.
// - loadByEmployee: management endpoint, requireRole("ADMIN","MANAGER")
//   enforced server-side. Frontend NEVER branches on role before calling.
//
// Param ordering for loadByEmployee is (employeeId, from, to) — matches the
// /work-events route's query schema and the API's URL convention.
import { api } from "$api/client";
import type { WorkEventListMine, WorkEventListTenant } from "@clokr/types";

export const workEvents = {
  async loadMine(from: string, to: string): Promise<WorkEventListMine> {
    return api.get<WorkEventListMine>(`/work-events/mine?from=${from}&to=${to}`);
  },
  async loadByEmployee(employeeId: string, from: string, to: string): Promise<WorkEventListTenant> {
    return api.get<WorkEventListTenant>(
      `/work-events?employeeId=${employeeId}&from=${from}&to=${to}`,
    );
  },
};
