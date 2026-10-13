// German reason texts of the operator console, keyed by the machine-readable `code` of an API
// answer (Issue #89, D-13, D-14a).
//
// Control flow and text choice both branch on the `code`, never on a German message: a known code
// renders the console's own sentence, an unknown code renders the server's `error` string, and a
// response without a code falls back to the status sentence (no connection, rate limit, server
// fault). The sentences are count-free on purpose (D-14a): they never name a number of rows, so a
// reason cannot leak how much data a tenant holds. The salon codes are added next to the tenant
// ones when the salon UI needs them.

/** Sentences for the tenant lifecycle codes (UI-SPEC "Reason texts"). */
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
};

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
  if (code === undefined && status === 404) code = "TENANT_NOT_FOUND";
  // Only an API answer carries a message worth showing; a stray runtime error would be English.
  const message =
    status !== undefined && typeof shaped?.message === "string" ? shaped.message : undefined;
  return reasonText(code, message, status, options);
}
