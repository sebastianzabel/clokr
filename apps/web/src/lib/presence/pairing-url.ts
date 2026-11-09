// Issue #610 (Phase 610-06, P-610-22, D-13 revised): the URL a salon QR code points at. The admin
// types the LAN address of the FRITZ!Box adapter and its pairing port; the page builds
// `http://<ip>:<port>/koppeln` from it. Only a private IPv4 literal is accepted, so a printed code
// can never send a phone to a host outside the salon network. The address is browser state only:
// it is neither stored nor sent anywhere.

/** The adapter's default pairing port (PAIRING_PORT in the adapter). */
export const DEFAULT_PAIRING_PORT = "8766";

export type PairingUrlRefusal = "NOT_PRIVATE" | "INVALID_ADDRESS" | "INVALID_PORT";

export type PairingUrlResult = { ok: true; url: string } | { ok: false; reason: PairingUrlRefusal };

// Four decimal octets; a leading zero is refused because several stacks read "01" as octal.
const OCTET = "(0|[1-9][0-9]{0,2})";
const DOTTED_QUAD = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
const PORT = /^[1-9][0-9]{0,4}$/;

function privateOctets(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

export function pairingUrlFor(address: string, port: string): PairingUrlResult {
  const match = DOTTED_QUAD.exec(address.trim());
  if (!match) return { ok: false, reason: "INVALID_ADDRESS" };
  const octets = match.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return { ok: false, reason: "INVALID_ADDRESS" };
  if (!privateOctets(octets)) return { ok: false, reason: "NOT_PRIVATE" };

  const trimmedPort = port.trim();
  if (!PORT.test(trimmedPort) || Number(trimmedPort) > 65535) {
    return { ok: false, reason: "INVALID_PORT" };
  }
  return { ok: true, url: `http://${octets.join(".")}:${trimmedPort}/koppeln` };
}

/** The German field text for a refusal (display only; the reason is the control value). */
export function pairingUrlMessage(reason: PairingUrlRefusal): string {
  switch (reason) {
    case "NOT_PRIVATE":
      return "Bitte gib die Adresse des Adapters im Salon-WLAN ein (z. B. 192.168.178.20).";
    case "INVALID_ADDRESS":
      return "Das ist keine gültige IP-Adresse. Eine IP-Adresse besteht aus vier Zahlen, z. B. 192.168.178.20.";
    case "INVALID_PORT":
      return "Der Port muss eine Zahl zwischen 1 und 65535 sein.";
  }
}
