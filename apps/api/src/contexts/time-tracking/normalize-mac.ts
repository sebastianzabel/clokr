/**
 * Normalizes any MAC address format to lowercase colon-separated form.
 * Accepts: "AA:BB:CC:DD:EE:FF", "aa-bb-cc-dd-ee-ff", "AABBCCDDEEFF"
 * Returns: "aa:bb:cc:dd:ee:ff" (always 17 chars)
 * Throws:  Error("Ungültige MAC-Adresse: <raw>") for non-hex input or wrong byte count.
 */
export function normalizeMac(raw: string): string {
  // Strip all non-hex characters (colons, dashes, spaces)
  const hex = raw.replace(/[^0-9a-fA-F]/g, "");

  // Validate: exactly 12 hex chars = 6 bytes
  if (hex.length !== 12) {
    throw new Error(`Ungültige MAC-Adresse: ${raw}`);
  }

  // Split into bytes and join with colons
  return hex.toLowerCase().match(/.{2}/g)!.join(":");
}
