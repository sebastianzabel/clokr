// Issue #610 (D-11, P-610-20): the pure decisions of the pairing page.
import { describe, expect, it, vi } from "vitest";
import { readable } from "svelte/store";

// `$api/client` pulls in `$stores/auth` and with it `$app/environment`, which the vitest config does
// not alias (same replacement as lib/api/__tests__/presence.test.ts).
vi.mock("$stores/auth", () => ({
  authStore: {
    ...readable({ accessToken: null, refreshToken: null, user: null }),
    logout: vi.fn(),
    setTokens: vi.fn(),
  },
}));

import { ApiError } from "$api/client";
import {
  CONSENT_TEXT,
  INVALID_CODE_TEXT,
  deviceLabelText,
  isWellFormedPairingCode,
  macTailLabel,
  pairingFailure,
} from "../pairing-view";

describe("isWellFormedPairingCode", () => {
  it("accepts exactly 64 lowercase hex characters", () => {
    expect(isWellFormedPairingCode("0123456789abcdef".repeat(4))).toBe(true);
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["63 characters", "a".repeat(63)],
    ["65 characters", "a".repeat(65)],
    ["uppercase", "A".repeat(64)],
    ["non-hex", "g".repeat(64)],
    ["with a space", `${"a".repeat(63)} `],
    ["with a line break", `${"a".repeat(64)}\n`],
  ])("refuses %s", (_label, code) => {
    expect(isWellFormedPairingCode(code as string | null)).toBe(false);
  });
});

describe("labels", () => {
  it("shows the device address tail with an ellipsis", () => {
    expect(macTailLabel("ab:cd")).toBe("…:ab:cd");
  });

  it("names a device without a hostname", () => {
    expect(deviceLabelText(null)).toBe("Unbekanntes Gerät");
    expect(deviceLabelText("")).toBe("Unbekanntes Gerät");
    expect(deviceLabelText("Pixel 8")).toBe("Pixel 8");
  });

  it("states purpose, legal basis and withdrawal in the consent text", () => {
    expect(CONSENT_TEXT).toContain("Art. 6 Abs. 1 lit. a DSGVO");
    expect(CONSENT_TEXT).toContain("§ 26 BDSG");
    expect(CONSENT_TEXT).toContain("im Profil widerrufen");
    // Review IN-03: the persisted last-detection time is named in the consent text.
    expect(CONSENT_TEXT).toContain("Zeitpunkt, zu dem es zuletzt erkannt wurde");
  });
});

describe("pairingFailure", () => {
  it("maps a 404 to the scan-again case, with the server's message", () => {
    const err = new ApiError(404, "Der Code ist abgelaufen.", { code: "PAIRING_CODE_INVALID" });
    expect(pairingFailure(err)).toEqual({ kind: "invalid", message: "Der Code ist abgelaufen." });
  });

  it("falls back to the fixed text when the 404 carries no message", () => {
    expect(pairingFailure(new ApiError(404, ""))).toEqual({
      kind: "invalid",
      message: INVALID_CODE_TEXT,
    });
  });

  it("maps a 409 with the taken code to the taken case", () => {
    const err = new ApiError(409, "Dieses Gerät ist bereits einer anderen Person zugeordnet.", {
      code: "PRESENCE_DEVICE_TAKEN",
    });
    expect(pairingFailure(err)).toEqual({
      kind: "taken",
      message: "Dieses Gerät ist bereits einer anderen Person zugeordnet.",
    });
  });

  it("decides by status and code, never by the message text", () => {
    // A 409 without the taken code is no "taken" case, whatever the text says.
    expect(pairingFailure(new ApiError(409, "Dieses Gerät ist bereits zugeordnet", {}))).toEqual({
      kind: "error",
    });
    expect(pairingFailure(new ApiError(500, "PAIRING_CODE_INVALID"))).toEqual({ kind: "error" });
  });

  it("maps anything else, including a network error, to a retryable error", () => {
    expect(pairingFailure(new TypeError("Failed to fetch"))).toEqual({ kind: "error" });
    expect(pairingFailure(null)).toEqual({ kind: "error" });
  });
});
