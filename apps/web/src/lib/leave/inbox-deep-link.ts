// Issue #840 (D-840-05, T-840-30) - the receiver of the inbox deep links.
//
// `/inbox?request=<id>[&year=<YYYY>]` (a leave notification, the Anträge tab) opens the shared review
// dialog; `/inbox?section9=<id>` scrolls to one § 9 case. URL parameters are untrusted text: ids are
// reduced to a lowercase uuid, the year to a bounded 4-digit number, everything else becomes `null`.
// Reading a link has no effect of its own - the inbox only opens a row the API already listed for
// the caller (T-840-27).
import { normalizeEmployeeIdParam } from "$lib/breaks/deep-link";

export interface InboxDeepLink {
  /** Lowercase uuid of the leave request to open, or `null`. */
  requestId: string | null;
  /** Year whose list holds the request, or `null` (the current year's list is the default). */
  year: number | null;
  /** Lowercase uuid of the § 9 case to scroll to, or `null`. */
  section9Id: string | null;
}

/** How far from the current year a deep link may point (a request can start next year). */
const YEAR_WINDOW = 5;

function parseYear(raw: string | null, currentYear: number): number | null {
  if (raw === null || !/^\d{4}$/.test(raw)) return null;
  const year = Number(raw);
  return Math.abs(year - currentYear) <= YEAR_WINDOW ? year : null;
}

/** Reads the three inbox deep-link parameters. Pure; never throws. */
export function parseInboxDeepLink(params: URLSearchParams, currentYear: number): InboxDeepLink {
  try {
    return {
      requestId: normalizeEmployeeIdParam(params.get("request")),
      year: parseYear(params.get("year"), currentYear),
      section9Id: normalizeEmployeeIdParam(params.get("section9")),
    };
  } catch {
    return { requestId: null, year: null, section9Id: null };
  }
}
