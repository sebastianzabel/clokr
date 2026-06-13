/**
 * Helpers for the Phase 81 WorkEvent (VOCATIONAL_SCHOOL) E2E spec
 * (UI-V19-06, TEST-V19-03 partial).
 *
 * Mirrors apps/e2e/helpers/bs-pattern.ts:
 *  - same auth-header pattern + per-test BSPatternTenant-shaped contract
 *  - same E2E_API_BASE env-var convention (NOT API_URL — kept consistent
 *    with bs-pattern.ts and the Phase 73 fixture)
 *  - reuses createAzubiEmployee verbatim (re-exported below so spec has a
 *    single import path)
 *
 * This module MUST NOT import from "@playwright/test" — it is a pure HTTP
 * helper that the spec composes with test.beforeEach / test().
 */
import { createAzubiEmployee } from "./bs-pattern";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

/** Phase-73 tenant fixture shape consumed locally to stay parallel-worktree safe. */
export interface WorkEventVsTenant {
  tenantId: string;
  adminToken: string;
}

function authHeaders(t: WorkEventVsTenant): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${t.adminToken}`,
  };
}

/** Single row of the Phase-79 management GET /work-events response. */
export interface WorkEventRow {
  id: string;
  employeeId: string;
  type: string;
  source: string;
  date: string;
  workedMinutes: number;
  expectedMinutes: number | null;
}

/**
 * Seeds a VOCATIONAL_SCHOOL WorkEvent row via the Phase-79 POST endpoint.
 * Uses workedMinutes=480 / expectedMinutes=480 (8h) — typical Berufsschultag.
 */
export async function createWorkEventBs(
  tenant: WorkEventVsTenant,
  employeeId: string,
  date: string,
): Promise<WorkEventRow> {
  const res = await fetch(`${API_BASE}/api/v1/work-events`, {
    method: "POST",
    headers: authHeaders(tenant),
    body: JSON.stringify({
      employeeId,
      date,
      type: "VOCATIONAL_SCHOOL",
      source: "MANUAL",
      workedMinutes: 480,
      expectedMinutes: 480,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "<no body>");
    throw new Error(
      `createWorkEventBs: ${res.status} (tenant=${tenant.tenantId}, emp=${employeeId}, date=${date}) — ${detail}`,
    );
  }
  return (await res.json()) as WorkEventRow;
}

/**
 * GETs work-events for an employee in a date window. The Phase-79
 * management endpoint filters out soft-deleted rows (deletedAt: null),
 * so this doubles as the soft-delete assertion in the spec.
 */
export async function fetchWorkEventsForEmployee(
  tenant: WorkEventVsTenant,
  employeeId: string,
  from: string,
  to: string,
): Promise<WorkEventRow[]> {
  const url = new URL(`${API_BASE}/api/v1/work-events`);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("employeeId", employeeId);
  const res = await fetch(url.toString(), { headers: authHeaders(tenant) });
  if (!res.ok) {
    const detail = await res.text().catch(() => "<no body>");
    throw new Error(
      `fetchWorkEventsForEmployee: ${res.status} (tenant=${tenant.tenantId}, emp=${employeeId}) — ${detail}`,
    );
  }
  return (await res.json()) as WorkEventRow[];
}

// Re-export so the spec has a single import path.
export { createAzubiEmployee };
