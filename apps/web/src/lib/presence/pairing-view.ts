// Issue #610 (D-11, P-610-20): the pure decisions and texts of the pairing page. The component
// presents them; nothing here touches the DOM, the router or the network.
import { ApiError } from "$api/client";

/** A pairing code is 64 lowercase hex characters (256 bits); anything else cannot be a code. */
const WELL_FORMED_CODE = /^[0-9a-f]{64}$/;

export const MISSING_CODE_TEXT =
  "Kein gültiger Kopplungscode. Bitte scanne den QR-Code im Salon erneut.";
export const INVALID_CODE_TEXT =
  "Dieser Code ist abgelaufen oder bereits benutzt. Bitte scanne den QR-Code im Salon erneut.";
export const REPLACES_DEVICE_TEXT = "Dein bisher gekoppeltes Handy wird ersetzt.";
export const ALREADY_PAIRED_TEXT = "Dieses Handy ist bereits mit deinem Konto gekoppelt.";
export const SUCCESS_TEXT = "Fertig! Dein Handy ist gekoppelt.";
export const ERROR_TEXT = "Das hat nicht geklappt.";
export const UNKNOWN_DEVICE_TEXT = "Unbekanntes Gerät";

/** Purpose, legal basis and the way out, shown above the one button (one tap = consent). */
export const CONSENT_TEXT =
  "Mit dem Koppeln willigst du ein, dass Clokr dein Handy im Salon-WLAN erkennt, damit dein " +
  "Kommen und Gehen automatisch erfasst wird. Dafür speichern wir die Adresse deines Handys und " +
  "den Zeitpunkt, zu dem es zuletzt erkannt wurde. Grundlage ist deine Einwilligung " +
  "(Art. 6 Abs. 1 lit. a DSGVO, § 26 BDSG). Du kannst sie jederzeit im Profil widerrufen; " +
  "dann werden alle deine Geräte entfernt.";

export function isWellFormedPairingCode(code: string | null | undefined): code is string {
  return typeof code === "string" && WELL_FORMED_CODE.test(code);
}

/** The tail the server shows ("ab:cd") as the person sees it on the phone's own address. */
export function macTailLabel(macTail: string): string {
  return `…:${macTail}`;
}

export function deviceLabelText(label: string | null | undefined): string {
  return label ? label : UNKNOWN_DEVICE_TEXT;
}

export type PairingFailure =
  { kind: "invalid"; message: string } | { kind: "taken"; message: string } | { kind: "error" };

function errorCode(err: ApiError): string | null {
  const data = err.data;
  if (typeof data !== "object" || data === null) return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * What a failed pairing request means for the person. The case is decided by the status and the
 * error code, never by the message text; the message is only what is shown.
 */
export function pairingFailure(err: unknown): PairingFailure {
  if (err instanceof ApiError) {
    if (err.status === 404) return { kind: "invalid", message: err.message || INVALID_CODE_TEXT };
    if (err.status === 409 && errorCode(err) === "PRESENCE_DEVICE_TAKEN") {
      return { kind: "taken", message: err.message };
    }
  }
  return { kind: "error" };
}
