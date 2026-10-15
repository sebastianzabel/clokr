// Issue #89 (D-03) - the operator session clock. Pure helpers: the remaining time is always
// derived from the absolute expiry, never from a decrementing counter, because background tabs
// throttle timers.
import { describe, expect, it } from "vitest";

import {
  ANNOUNCE_30_SECONDS,
  ANNOUNCE_2_MINUTES,
  announcementFor,
  formatGrantRemaining,
  formatRemaining,
  remainingMs,
  sessionState,
} from "../countdown";

describe("remainingMs", () => {
  it("is expiresAt minus now", () => {
    expect(remainingMs(10_000, 4_000)).toBe(6_000);
  });

  it("is never negative", () => {
    expect(remainingMs(1_000, 5_000)).toBe(0);
    expect(remainingMs(5_000, 5_000)).toBe(0);
  });
});

describe("formatRemaining", () => {
  it("formats mm:ss zero-padded", () => {
    expect(formatRemaining(872_000)).toBe("14:32");
    expect(formatRemaining(5_000)).toBe("00:05");
    expect(formatRemaining(0)).toBe("00:00");
    expect(formatRemaining(900_000)).toBe("15:00");
  });

  it("rounds a partial second up, so 00:00 is shown only at expiry", () => {
    expect(formatRemaining(500)).toBe("00:01");
    expect(formatRemaining(1_000)).toBe("00:01");
    expect(formatRemaining(871_001)).toBe("14:32");
  });

  it("never shows a negative time", () => {
    expect(formatRemaining(-4_000)).toBe("00:00");
  });
});

describe("sessionState", () => {
  it("is normal above two minutes", () => {
    expect(sessionState(120_001)).toBe("normal");
    expect(sessionState(900_000)).toBe("normal");
  });

  it("is warning at two minutes and below, while time is left", () => {
    expect(sessionState(120_000)).toBe("warning");
    expect(sessionState(1)).toBe("warning");
  });

  it("is expired at zero and below", () => {
    expect(sessionState(0)).toBe("expired");
    expect(sessionState(-1)).toBe("expired");
  });
});

describe("announcementFor", () => {
  it("announces two minutes exactly once, on the crossing", () => {
    expect(announcementFor(121_000, 120_000)).toBe(ANNOUNCE_2_MINUTES);
    expect(announcementFor(120_000, 119_000)).toBeNull();
    expect(announcementFor(130_000, 129_000)).toBeNull();
  });

  it("announces 30 seconds exactly once, on the crossing", () => {
    expect(announcementFor(31_000, 30_000)).toBe(ANNOUNCE_30_SECONDS);
    expect(announcementFor(30_000, 29_000)).toBeNull();
    expect(announcementFor(60_000, 59_000)).toBeNull();
  });

  it("names the later threshold when a throttled tab jumps over both", () => {
    expect(announcementFor(130_000, 20_000)).toBe(ANNOUNCE_30_SECONDS);
  });

  it("says nothing at expiry", () => {
    expect(announcementFor(31_000, 0)).toBeNull();
    expect(announcementFor(5_000, 0)).toBeNull();
  });

  it("uses the UI-SPEC sentences", () => {
    expect(ANNOUNCE_2_MINUTES).toBe("Die Sitzung endet in 2 Minuten. Eingaben bitte abschließen.");
    expect(ANNOUNCE_30_SECONDS).toBe("Die Sitzung endet in 30 Sekunden.");
  });
});

describe("formatGrantRemaining (Issue #93)", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it("shows hours and minutes", () => {
    expect(formatGrantRemaining(3 * HOUR + 12 * MIN)).toBe("Noch 3 Std. 12 Min.");
    expect(formatGrantRemaining(24 * HOUR)).toBe("Noch 24 Std. 0 Min.");
  });

  it("drops the hours below one hour", () => {
    expect(formatGrantRemaining(12 * MIN)).toBe("Noch 12 Min.");
    expect(formatGrantRemaining(1 * MIN)).toBe("Noch 1 Min.");
  });

  it("says less than a minute under one minute and Abgelaufen at zero or below", () => {
    expect(formatGrantRemaining(59_999)).toBe("Weniger als 1 Min.");
    expect(formatGrantRemaining(1)).toBe("Weniger als 1 Min.");
    expect(formatGrantRemaining(0)).toBe("Abgelaufen");
    expect(formatGrantRemaining(-5_000)).toBe("Abgelaufen");
  });

  it("floors partial minutes so the figure never overstates the grant", () => {
    expect(formatGrantRemaining(3 * HOUR + 12 * MIN + 59_000)).toBe("Noch 3 Std. 12 Min.");
  });
});
