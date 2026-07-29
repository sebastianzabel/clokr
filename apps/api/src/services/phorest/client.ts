// Phase 85 — Phorest HTTP client (promoted from the route-private phorestFetch in
// routes/integrations.ts). Basic-Auth wrapper around the Phorest third-party API.
// Mirrors utils/school-holidays-client.ts for the typed *ApiError status-tagging so
// Plan 03's "Verbindung testen" can distinguish auth (401/403) from unreachable
// (TIMEOUT/NETWORK) — SS-02, Pitfall 6.

import type { PhorestApiResponse } from "./types";

export type PhorestApiErrorStatus = number | "TIMEOUT" | "NETWORK";

/** Per-request timeout (ms). Bounds a hung upstream so it can't hold the sync's advisory lock. */
const PHOREST_FETCH_TIMEOUT_MS = 15_000;

export class PhorestApiError extends Error {
  public readonly status: PhorestApiErrorStatus;
  constructor(status: PhorestApiErrorStatus, message: string) {
    super(message);
    this.name = "PhorestApiError";
    this.status = status;
  }
}

/**
 * Fetch a Phorest endpoint with Basic-Auth (`global/{username}`). Throws a typed
 * PhorestApiError on any failure:
 *   - non-ok HTTP → status = the HTTP code
 *   - AbortError  → status = "TIMEOUT"
 *   - other throw → status = "NETWORK"
 */
export async function phorestFetch(
  baseUrl: string,
  path: string,
  username: string,
  password: string,
  query?: Record<string, string>,
): Promise<PhorestApiResponse> {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }

  const auth = Buffer.from(`global/${username}:${password}`).toString("base64");

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
      // Bounded timeout so a hung upstream can't stall the sync while it holds the per-tenant
      // advisory lock (cron noOverlap + lock would otherwise starve that tenant's sync). This
      // also makes the TIMEOUT classification below reachable instead of dead code.
      signal: AbortSignal.timeout(PHOREST_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout aborts with a DOMException named "TimeoutError"; a manual/other abort
    // surfaces as "AbortError". Both map to the typed TIMEOUT status (SS-02).
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new PhorestApiError("TIMEOUT", "Phorest request timed out");
    }
    throw new PhorestApiError("NETWORK", `Phorest network error: ${(err as Error).message}`);
  }

  if (!res.ok) {
    // Build the surfaced message from the STATUS only — never embed the raw upstream body.
    // This message flows into PhorestSyncRun.error, the admin API response, and logs; echoing
    // the body could leak upstream internals (mirror the scrubbing in POST /phorest/test, T-85-11).
    await res.text().catch(() => ""); // drain the body, do not embed it
    throw new PhorestApiError(res.status, `Phorest API error ${res.status}`);
  }

  return res.json() as Promise<PhorestApiResponse>;
}
