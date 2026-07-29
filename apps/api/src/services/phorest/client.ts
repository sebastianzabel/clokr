// Phase 85 — Phorest HTTP client (promoted from the route-private phorestFetch in
// routes/integrations.ts). Basic-Auth wrapper around the Phorest third-party API.
// Mirrors utils/school-holidays-client.ts for the typed *ApiError status-tagging so
// Plan 03's "Verbindung testen" can distinguish auth (401/403) from unreachable
// (TIMEOUT/NETWORK) — SS-02, Pitfall 6.

import type { PhorestApiResponse } from "./types";

export type PhorestApiErrorStatus = number | "TIMEOUT" | "NETWORK";

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
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new PhorestApiError("TIMEOUT", "Phorest request timed out");
    }
    throw new PhorestApiError("NETWORK", `Phorest network error: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new PhorestApiError(res.status, `Phorest API error ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<PhorestApiResponse>;
}
