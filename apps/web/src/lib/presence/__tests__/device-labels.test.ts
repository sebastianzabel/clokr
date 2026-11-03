// Issue #610 (D-12, P-610-21): how the profile words a coupled device.
import { describe, expect, it } from "vitest";

import { lastSeenLabel, pairedViaLabel } from "../device-labels";

describe("pairedViaLabel", () => {
  it("names the way a device was coupled", () => {
    expect(pairedViaLabel("QR")).toBe("über QR-Code gekoppelt");
    expect(pairedViaLabel("MANUAL")).toBe("manuell eingetragen");
  });
});

describe("lastSeenLabel", () => {
  it("says a device that was never recognised has not been", () => {
    expect(lastSeenLabel(null)).toBe("noch nicht erkannt");
  });

  it("puts the formatted moment after the fixed words", () => {
    expect(lastSeenLabel("2026-11-02T10:00:00.000Z", () => "02.11.2026, 11:00")).toBe(
      "zuletzt erkannt am 02.11.2026, 11:00",
    );
  });

  it("formats German day.month.year, hour:minute by default", () => {
    expect(lastSeenLabel("2026-11-02T10:00:00.000Z")).toMatch(
      /^zuletzt erkannt am \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/,
    );
  });

  it("does not throw on an unreadable timestamp", () => {
    expect(lastSeenLabel("not-a-date")).toBe("noch nicht erkannt");
  });
});
