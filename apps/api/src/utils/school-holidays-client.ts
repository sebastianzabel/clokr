// Phase 67.2 — OpenHolidays HTTP client.
//
// Used by plugins/school-holidays-sync.ts (cron + on-demand). Provides a typed,
// retried, timed-out fetch wrapper around the public OpenHolidays SchoolHolidays
// endpoint.
//
// Stale-cache fallback policy: callers MUST handle SchoolHolidaysApiError and keep
// the existing cache rows intact (do NOT delete-then-refetch). See RESEARCH §126-130
// and the sync plugin for the canonical pattern.
//
// API contract (verified live 2026-06-03, RESEARCH §72-96):
//   GET https://openholidaysapi.org/SchoolHolidays
//     ?countryIsoCode=DE
//     &subdivisionCode=DE-BY
//     &validFrom=2026-01-01
//     &validTo=2026-12-31
//     &languageIsoCode=DE
//   →  Array<{ id, startDate, endDate, type: "School", name[], subdivisions[] }>

export interface SchoolHolidayDTO {
  externalId: string; // OpenHolidays UUID
  startDate: Date; // UTC date-only (midnight Z)
  endDate: Date; // UTC date-only (midnight Z)
  name: string; // German name preferred from name[].language === "DE"
  subdivisionCode: string; // e.g. "DE-BY"
}

export type SchoolHolidaysApiErrorStatus = number | "TIMEOUT" | "NETWORK";

export class SchoolHolidaysApiError extends Error {
  public readonly status: SchoolHolidaysApiErrorStatus;
  constructor(status: SchoolHolidaysApiErrorStatus, message: string) {
    super(message);
    this.name = "SchoolHolidaysApiError";
    this.status = status;
  }
}

const BASE_URL = "https://openholidaysapi.org/SchoolHolidays";
const TIMEOUT_MS = 8_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 200; // 200ms → 400ms → 800ms

interface OpenHolidaysRow {
  id: string;
  startDate: string;
  endDate: string;
  type: string;
  name: Array<{ language: string; text: string }>;
  subdivisions: Array<{ code: string; shortName?: string }>;
}

/**
 * Determine if the error caught inside the retry loop is a transient (retryable)
 * failure. Only 5xx / TIMEOUT / NETWORK are retryable. 4xx is a permanent contract
 * error (wrong subdivision code, etc.) and must not be retried.
 */
function isRetryable(err: SchoolHolidaysApiError): boolean {
  if (err.status === "TIMEOUT" || err.status === "NETWORK") return true;
  return typeof err.status === "number" && err.status >= 500;
}

export async function fetchSchoolHolidays(
  subdivisionCode: string,
  fromYear: number,
  toYear: number,
): Promise<SchoolHolidayDTO[]> {
  const url = new URL(BASE_URL);
  url.searchParams.set("countryIsoCode", "DE");
  url.searchParams.set("subdivisionCode", subdivisionCode);
  url.searchParams.set("validFrom", `${fromYear}-01-01`);
  url.searchParams.set("validTo", `${toYear}-12-31`);
  url.searchParams.set("languageIsoCode", "DE");

  let lastErr: SchoolHolidaysApiError | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeoutHandle);

      // 4xx is a permanent client error — surface immediately.
      if (res.status >= 400 && res.status < 500) {
        const body = await res.text().catch(() => "");
        throw new SchoolHolidaysApiError(
          res.status,
          `OpenHolidays ${res.status}: ${body.slice(0, 200)}`,
        );
      }

      if (!res.ok) {
        // 5xx — collect and retry.
        const body = await res.text().catch(() => "");
        lastErr = new SchoolHolidaysApiError(
          res.status,
          `OpenHolidays ${res.status}: ${body.slice(0, 200)}`,
        );
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** attempt));
        }
        continue;
      }

      const json = (await res.json()) as OpenHolidaysRow[];
      return json
        .filter((row) => row.type === "School")
        .map((row) => ({
          externalId: row.id,
          startDate: new Date(`${row.startDate}T00:00:00Z`),
          endDate: new Date(`${row.endDate}T00:00:00Z`),
          name:
            row.name.find((n) => n.language === "DE")?.text ?? row.name[0]?.text ?? "Schulferien",
          subdivisionCode: row.subdivisions[0]?.code ?? subdivisionCode,
        }));
    } catch (err) {
      clearTimeout(timeoutHandle);

      let mapped: SchoolHolidaysApiError;
      if (err instanceof SchoolHolidaysApiError) {
        mapped = err;
      } else if ((err as Error).name === "AbortError") {
        mapped = new SchoolHolidaysApiError("TIMEOUT", "OpenHolidays request timed out");
      } else {
        mapped = new SchoolHolidaysApiError(
          "NETWORK",
          `OpenHolidays network error: ${(err as Error).message}`,
        );
      }

      // 4xx — bubble up immediately (no retry).
      if (!isRetryable(mapped)) {
        throw mapped;
      }

      lastErr = mapped;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** attempt));
      }
    }
  }

  throw (
    lastErr ?? new SchoolHolidaysApiError("NETWORK", "OpenHolidays request failed after retries")
  );
}
