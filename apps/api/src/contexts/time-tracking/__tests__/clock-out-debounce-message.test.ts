// Phase 307 Plan 02, Task 1 (D-03/D-05 corrected) — the message a DEBOUNCE_NOOP clock-out now
// carries in its 409 body. No database access needed: this is a pure function of (startTime, tz).
//
// The expected clock-open time in every case below is DERIVED from the same calculation the
// function itself uses (startTime + DOUBLE_TAP_DEBOUNCE_MS, formatted with timeStrInTz in the
// SAME timezone under test) — never a hardcoded clock-string. A hardcoded string would be a time
// bomb the moment DOUBLE_TAP_DEBOUNCE_MS changes (see project memory "API test time-bombs").
import { describe, it, expect } from "vitest";
import { buildClockOutDebounceMessage } from "../clock-out-debounce-message";
import { DOUBLE_TAP_DEBOUNCE_MS } from "../../../services/clock/thresholds";
import { timeStrInTz } from "../../working-time-account";

describe("clock-out-debounce-message — D-03/D-05 corrected: German message names reason AND time", () => {
  it("G1 (Europe/Berlin): message is German, names the reason (double-tap guard) and the derived open time", () => {
    const startTime = new Date("2026-09-22T10:15:00.000Z");
    const tz = "Europe/Berlin";
    const expectedOpenTime = timeStrInTz(
      new Date(startTime.getTime() + DOUBLE_TAP_DEBOUNCE_MS),
      tz,
    );
    const expectedStartTime = timeStrInTz(startTime, tz);

    const message = buildClockOutDebounceMessage(startTime, tz);

    expect(message).toMatch(/Ausstempeln/);
    expect(message).toMatch(/Doppeltipp/);
    expect(message).toContain(expectedOpenTime);
    expect(message).toContain(expectedStartTime);
  });

  it("G2 (America/New_York): a second, non-Berlin timezone genuinely shifts the times shown — the tenant timezone is used, not UTC", () => {
    const startTime = new Date("2026-09-22T10:15:00.000Z");
    const tz = "America/New_York";
    const expectedOpenTime = timeStrInTz(
      new Date(startTime.getTime() + DOUBLE_TAP_DEBOUNCE_MS),
      tz,
    );
    const expectedStartTime = timeStrInTz(startTime, tz);
    const utcOpenTime = timeStrInTz(new Date(startTime.getTime() + DOUBLE_TAP_DEBOUNCE_MS), "UTC");

    const message = buildClockOutDebounceMessage(startTime, tz);

    expect(message).toContain(expectedOpenTime);
    expect(message).toContain(expectedStartTime);
    // The genuinely distinguishing assertion: America/New_York and UTC disagree on the clock
    // string for this instant, and the message must show the TENANT's time, not UTC's.
    expect(expectedOpenTime).not.toBe(utcOpenTime);
    expect(message).not.toContain(utcOpenTime);
  });

  it("G3 (midnight crossing): start at 23:59:30 Europe/Berlin — the named open time lands on the following calendar day without the function stumbling", () => {
    // 2026-09-22T23:59:30 in Europe/Berlin (UTC+2, CEST) = 2026-09-22T21:59:30Z.
    const startTime = new Date("2026-09-22T21:59:30.000Z");
    const tz = "Europe/Berlin";
    const expectedOpenTime = timeStrInTz(
      new Date(startTime.getTime() + DOUBLE_TAP_DEBOUNCE_MS),
      tz,
    );
    const expectedStartTime = timeStrInTz(startTime, tz);

    // Sanity: the local start time really is just before midnight, so the +60s open time really
    // does cross into the next calendar day — otherwise this case would not test what it claims.
    expect(expectedStartTime).toBe("23:59");
    expect(expectedOpenTime).toBe("00:00");

    const message = buildClockOutDebounceMessage(startTime, tz);

    expect(message).toContain(expectedOpenTime);
    expect(message).toContain(expectedStartTime);
  });
});
