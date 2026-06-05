/**
 * NFC-terminal E2E helper — Plan 74-05.
 *
 * Two primitives the `nfc-punch.spec.ts` flow composes:
 *
 *   1. `bootstrapTerminal(tenant, opts?)` — provisions a TerminalApiKey
 *      and an Employee + nfcCardId inside the Phase 73 tenant fixture
 *      via the Plan 74-05 Task-1 endpoint
 *      `POST /api/v1/test/bootstrap-terminal`. Returns the raw API key
 *      EXACTLY ONCE — callers must hold it for the lifetime of the
 *      test; there is no read-back path.
 *
 *   2. `nfcPunch(apiKey, nfcCardId, ...)` — POSTs to
 *      `/api/v1/time-entries/nfc-punch` with `Authorization: Bearer
 *      ${apiKey}`. The endpoint is JWT-free and uses the separate
 *      Terminal-API-Key auth model (see `apps/api/src/routes/time-entries.ts`
 *      line 214+ + CLAUDE.md "Terminal API keys (separate model)").
 *      Returns the raw `{ status, body }` shape so spec tests can assert
 *      status codes for error paths (401, 403, 404).
 *
 * Why a thin wrapper and not `api.post(...)`? The `api` client at
 * `apps/web/src/lib/api/client.ts` is JWT-aware and auto-refreshes on
 * 401 — exactly the wrong behavior for terminal-device auth. Plain
 * `fetch` keeps the call shape identical to what a real Tauri NFC
 * client does in `apps/nfc-client/`.
 */
import type { TestTenant } from "../fixtures/tenant";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

export interface TerminalBootstrap {
  /** Raw `clk_…` key — use directly in `Authorization: Bearer`. */
  apiKey: string;
  /** TerminalApiKey row id (non-secret — safe to log). */
  apiKeyId: string;
  /** Employee row id created alongside the key. */
  employeeId: string;
  /** User row id backing the Employee (needed for deactivation flows). */
  userId: string;
  /** NFC card id assigned to the new employee. */
  nfcCardId: string;
}

export interface BootstrapTerminalOpts {
  /** Override the auto-generated `test-nfc-…` value if a deterministic card id is needed. */
  nfcCardId?: string;
}

export interface NfcPunchResponse {
  /** HTTP status — tests inspect this directly for error paths. */
  status: number;
  /** Parsed JSON body. Always an object on 2xx; on errors usually `{ error: "..." }`. */
  body: unknown;
}

function authHeaders(token: string): HeadersInit {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}

async function failFast(label: string, res: Response): Promise<never> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* swallow — body may be unreadable */
  }
  throw new Error(`${label} failed (HTTP ${res.status}): ${body}`);
}

/**
 * Provision a fresh Terminal API key + Employee inside the given test tenant.
 *
 * The raw key is returned ONCE and never persisted — callers MUST keep the
 * `TerminalBootstrap` in scope for the lifetime of the test that uses it.
 *
 * Implementation note: this endpoint is gated by `ALLOW_TEST_BOOTSTRAP` at
 * the plugin level (Plan 73-01 D-02). On int + prod the request returns 404
 * because the route never registers — this is the design (T-74-05-02).
 */
export async function bootstrapTerminal(
  tenant: TestTenant,
  opts: BootstrapTerminalOpts = {},
): Promise<TerminalBootstrap> {
  const res = await fetch(`${API_BASE}/api/v1/test/bootstrap-terminal`, {
    method: "POST",
    headers: authHeaders(tenant.adminToken),
    body: JSON.stringify({ tenantId: tenant.tenantId, ...opts }),
  });
  if (!res.ok) await failFast("bootstrapTerminal", res);
  return (await res.json()) as TerminalBootstrap;
}

/**
 * Send an NFC punch using a Terminal API key.
 *
 * Returns the raw status + body so the spec can assert specific error codes:
 *   - 401: missing/invalid/revoked API key ("Ungültiger oder widerrufener API Key")
 *   - 404: unknown nfcCardId ("Unbekannte Karte")
 *   - 403: deactivated employee ("Mitarbeiter ist deaktiviert")
 *   - 200: action="IN" (clock in) or action="OUT" (clock out)
 *   - 409: blocked by approved leave (BUrlG §8) — `{ error: "...", action: "BLOCKED" }`
 *
 * Locked-month errors surface via the OUT path's downstream lock check
 * (74-06 owns the canonical message); the helper itself does not interpret
 * the response — that's the spec's job.
 */
export async function nfcPunch(
  apiKey: string,
  nfcCardId: string,
): Promise<NfcPunchResponse> {
  const res = await fetch(`${API_BASE}/api/v1/time-entries/nfc-punch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ nfcCardId }),
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Some error paths may return empty bodies — keep `body` null and let
    // the caller decide. Status code is the source of truth.
  }
  return { status: res.status, body };
}

/**
 * Deactivate an employee (set `User.isActive=false`) — small admin helper
 * shared with the cancellation spec when future tests need the same flow.
 *
 * Uses `PATCH /api/v1/employees/:id/deactivate` (the dedicated endpoint,
 * not a generic PATCH on the employee — the dedicated path also revokes
 * refresh tokens + OTP tokens in one transaction, see
 * `apps/api/src/routes/employees.ts` line 567).
 */
export async function deactivateEmployee(
  tenant: TestTenant,
  employeeId: string,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/v1/employees/${employeeId}/deactivate`,
    {
      method: "PATCH",
      headers: authHeaders(tenant.adminToken),
      body: JSON.stringify({}),
    },
  );
  if (!res.ok) await failFast("deactivateEmployee", res);
}
