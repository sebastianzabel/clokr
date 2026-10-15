// German reason texts of the operator console, keyed by the machine-readable `code` of an API
// answer (Issue #89, D-13, D-14a).
//
// Control flow and text choice both branch on the `code`, never on a German message: a known code
// renders the console's own sentence, an unknown code renders the server's `error` string, and a
// response without a code falls back to the status sentence (no connection, rate limit, server
// fault). The sentences are count-free on purpose (D-14a): they never name a number of rows, so a
// reason cannot leak how much data a tenant holds.

/** Sentences for the tenant lifecycle and salon codes (UI-SPEC "Reason texts"). */
export const REASON_TEXTS: Readonly<Record<string, string>> = {
  TENANT_DEACTIVATED:
    "Der Mandant ist deaktiviert. Änderungen sind erst nach der Reaktivierung möglich.",
  TENANT_IN_USE: "Der Mandant ist bereits in Benutzung. Eine neue Einladung ist nicht nötig.",
  NO_PENDING_INVITATION: "Es gibt keine offene Einladung.",
  ALREADY_DEACTIVATED: "Der Mandant ist bereits deaktiviert.",
  NOT_DEACTIVATED: "Der Mandant ist nicht deaktiviert.",
  SLUG_TAKEN: "Dieser Kurzname ist bereits vergeben.",
  EMAIL_TAKEN: "Diese E-Mail-Adresse wird bereits verwendet.",
  // The tenant routes answer an unknown id with a bare 404 and no code; `failureText()` maps that
  // status to this key so the sentence still comes from this module.
  TENANT_NOT_FOUND: "Mandant nicht gefunden.",
  // Salon codes. The salon routes answer an unknown salon with a bare 404 as well, so the salon
  // callers pass `notFoundCode: SALON_NOT_FOUND` to `failureText()`.
  FEDERAL_STATE_IN_USE:
    "Das Bundesland ist durch Zeiteinträge oder Zuordnungen festgelegt. Ein Umzug ist ein neuer Salon.",
  HOME_SALON_IN_USE:
    "Der Salon ist noch Stammsalon von Mitarbeitenden. Die Mitarbeitenden müssen zuerst einem anderen Stammsalon zugeordnet werden.",
  LAST_ACTIVE_SALON:
    "Das ist der letzte aktive Salon des Mandanten. Ein Mandant braucht mindestens einen aktiven Salon.",
  ALREADY_INACTIVE: "Der Salon ist bereits deaktiviert.",
  ALREADY_ACTIVE: "Der Salon ist bereits aktiv.",
  SALON_ALREADY_COUPLED: "Der Salon ist bereits gekoppelt.",
  BRANCH_ALREADY_COUPLED: "Diese Filialkennung ist bereits einem anderen Salon zugeordnet.",
  SALON_INACTIVE: "Deaktivierte Salons können nicht gekoppelt werden.",
  SALON_NOT_FOUND: "Salon nicht gefunden.",
  // Package refusals (Phase 566). The server sentence addresses the tenant ("Ihr Anbieter schaltet
  // das frei"); the console words its own, chosen by code, and points to the "Pakete" section.
  SALON_QUOTA_REACHED:
    "Salon-Kontingent erreicht. Erst im Abschnitt „Pakete“ das Ketten-Paket buchen oder das Kontingent erhöhen.",
  MODULE_NOT_BOOKED: "Das nötige Zusatzmodul ist nicht gebucht. Erst im Abschnitt „Pakete“ buchen.",
};

/** Key a salon caller passes as `notFoundCode` so a code-less 404 reads as a missing salon. */
export const SALON_NOT_FOUND = "SALON_NOT_FOUND";

/**
 * Sentences that differ by the place the action was started from. The resend dialog says only
 * that the tenant is deactivated: the button is hidden for a deactivated tenant, so this answer
 * can only follow a deactivation that happened in the meantime.
 */
export const RESEND_REASON_TEXTS: Readonly<Record<string, string>> = {
  TENANT_DEACTIVATED: "Der Mandant ist deaktiviert.",
};

export const CONNECTION_TEXT = "Keine Verbindung zum Server. Bitte erneut versuchen.";
export const RATE_LIMIT_TEXT = "Zu viele Anfragen. Bitte einen Moment warten und erneut versuchen.";
export const SERVER_FAULT_TEXT = "Der Server hat einen Fehler gemeldet. Bitte erneut versuchen.";
export const GENERIC_TEXT = "Die Aktion konnte nicht ausgeführt werden. Bitte erneut versuchen.";

export interface ReasonOptions {
  /** Sentences that win over `REASON_TEXTS` for the same code. */
  overrides?: Readonly<Record<string, string>>;
  /** The key a code-less 404 maps to (`failureText` only); defaults to `TENANT_NOT_FOUND`. */
  notFoundCode?: string;
}

/**
 * The sentence for a failed action. `status` 0 stands for "no answer at all" (network failure).
 * Order: a known code, then the server's own string for an unknown code, then the status
 * sentences, then the server string of a code-less answer, then a generic sentence.
 */
export function reasonText(
  code: string | undefined,
  serverError: string | undefined,
  status?: number,
  options: ReasonOptions = {},
): string {
  const server = serverError?.trim() ? serverError.trim() : undefined;

  if (code !== undefined) {
    const known = options.overrides?.[code] ?? REASON_TEXTS[code];
    if (known !== undefined) return known;
    if (server !== undefined) return server;
  }

  if (status === 0) return CONNECTION_TEXT;
  if (status === 429) return RATE_LIMIT_TEXT;
  if (status !== undefined && status >= 500) return SERVER_FAULT_TEXT;
  return server ?? GENERIC_TEXT;
}

/**
 * `reasonText()` for a thrown value: an `OperatorApiError` (read structurally, so this module
 * stays free of the client), a `TypeError` from a failed fetch, anything else.
 */
export function failureText(error: unknown, options: ReasonOptions = {}): string {
  if (error instanceof TypeError) return reasonText(undefined, undefined, 0, options);
  const shaped = error as
    { status?: unknown; code?: unknown; message?: unknown } | null | undefined;
  const status = typeof shaped?.status === "number" ? shaped.status : undefined;
  let code = typeof shaped?.code === "string" ? shaped.code : undefined;
  if (code === undefined && status === 404) code = options.notFoundCode ?? "TENANT_NOT_FOUND";
  // Only an API answer carries a message worth showing; a stray runtime error would be English.
  const message =
    status !== undefined && typeof shaped?.message === "string" ? shaped.message : undefined;
  return reasonText(code, message, status, options);
}
