// Issue #610 (Phase 610-01, D-04/D-05/D-06/D-09, P-610-03/04/05/08) — constants and pure helpers of the
// WLAN pairing code. No database access here; `presence-pairing.ts` owns the transactions.
//
// The raw code is 32 random bytes as 64 lowercase hex characters. It exists only in the issuer's 201
// response (and in the phone's redirect): it is never stored, logged or audited — only its SHA-256 is.

import { createHash, randomBytes } from "crypto";

/** A pairing code lives at most five minutes (AC-2); `expiresAt = now + TTL`, never longer. */
export const PAIRING_CODE_TTL_MS = 5 * 60_000;

/** The one wire format of a code: exactly 64 lowercase hex characters. */
export const PAIRING_CODE_PATTERN = /^[0-9a-f]{64}$/;

/** At most this many code points of the adapter-chosen hostname are kept (display only). */
export const PAIRING_HOSTNAME_MAX_CODE_POINTS = 64;

/** ONE refusal body for every invalid-code state (D-06): malformed, unknown, another tenant, expired,
 * consumed, source inactive/revoked/deleted, caller not an active person. No oracle between them. */
export const PAIRING_CODE_INVALID_ERROR = {
  error:
    "Dieser Kopplungscode ist ungültig oder abgelaufen. Bitte scanne den QR-Code im Salon erneut.",
  code: "PAIRING_CODE_INVALID",
} as const;

/** 409 when the MAC already belongs to ANOTHER person of the tenant (D-07). Never names that person. */
export const PRESENCE_DEVICE_TAKEN_ERROR = {
  error:
    "Dieses Gerät ist bereits einer anderen Person zugeordnet. Bitte wende dich an deine Leitung.",
  code: "PRESENCE_DEVICE_TAKEN",
} as const;

/** A fresh code: 32 random bytes, 64 lowercase hex characters. */
export function generatePairingCode(): string {
  return randomBytes(32).toString("hex");
}

/** SHA-256 hex of a code — the only form that is stored. */
export function hashPairingCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/**
 * Display-only hostname hygiene (research Pitfall 12): strips Unicode control and format characters
 * (BEL, bidi overrides, zero-width, line breaks …), collapses whitespace, trims and keeps at most 64
 * code points. An empty result is `null`. The value is never rendered as HTML.
 */
export function sanitizeHostname(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[\t\n\r\v\f]/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned === "") return null;
  const points = Array.from(cleaned);
  const cut =
    points.length > PAIRING_HOSTNAME_MAX_CODE_POINTS
      ? points.slice(0, PAIRING_HOSTNAME_MAX_CODE_POINTS).join("").trim()
      : cleaned;
  return cut === "" ? null : cut;
}

/** The last two octets of a normalised MAC ("aa:bb:cc:dd:ee:ff" → "ee:ff") — all the person is shown. */
export function macTail(mac: string): string {
  return mac.split(":").slice(-2).join(":");
}
