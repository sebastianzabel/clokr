/**
 * Issue #608 (D-03, P-608-05) - the device label is one value of a closed vocabulary. Pure.
 */
import { describe, it, expect } from "vitest";
import {
  DEVICE_LABEL_VOCABULARY,
  UNKNOWN_DEVICE_LABEL,
  deviceLabelFromUserAgent,
} from "../contexts/platform/push-device-label";

const KNOWN: Array<[string, string, string]> = [
  [
    "Chrome/Android",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    "Chrome auf Android",
  ],
  [
    "Samsung Internet/Android",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
    "Samsung Internet auf Android",
  ],
  [
    "Firefox/Android",
    "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0",
    "Firefox auf Android",
  ],
  [
    "Safari/iPhone",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Safari auf iPhone",
  ],
  [
    "Safari/iPad",
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Safari auf iPad",
  ],
  [
    // iPadOS 13+ reports "Macintosh" by default and the server has no touch hint, so this is
    // labelled as macOS. Documented limit, not a bug: the label is a display aid only.
    "Safari/iPadOS (desktop-class UA)",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Safari auf macOS",
  ],
  [
    "Chrome/Windows",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Chrome auf Windows",
  ],
  [
    "Edge/Windows",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    "Edge auf Windows",
  ],
  [
    "Firefox/Linux",
    "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Firefox auf Linux",
  ],
  [
    "Chrome/ChromeOS",
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Chrome auf ChromeOS",
  ],
  [
    "Opera/Windows",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
    "Opera auf Windows",
  ],
];

describe("deviceLabelFromUserAgent", () => {
  it.each(KNOWN)("labels %s", (_name, ua, expected) => {
    expect(deviceLabelFromUserAgent(ua)).toBe(expected);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["an unknown client", "curl/8.7.1"],
  ])("falls back to the unknown label for %s", (_name, ua) => {
    expect(deviceLabelFromUserAgent(ua)).toBe(UNKNOWN_DEVICE_LABEL);
  });

  it("only ever returns a value of the closed vocabulary", () => {
    for (const [, ua] of KNOWN)
      expect(DEVICE_LABEL_VOCABULARY).toContain(deviceLabelFromUserAgent(ua));
    expect(DEVICE_LABEL_VOCABULARY).toContain(UNKNOWN_DEVICE_LABEL);
  });
});
