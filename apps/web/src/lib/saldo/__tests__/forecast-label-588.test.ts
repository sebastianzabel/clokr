// Issue #588 (P-05, P-14, amendment 1) - the one forecast wording rule, every case.
import { describe, it, expect } from "vitest";
import {
  FORECAST_LABEL_CURRENT_MONTH,
  FORECAST_LABEL_SINCE_CLOSE,
  FORECAST_LABEL_SINCE_HIRE,
  FORECAST_LABEL_MIXED,
  forecastLabel,
  forecastColumnLabel,
  forecastCaption,
} from "../forecast-label";

describe("forecastLabel", () => {
  it("names the running month when exactly one month is unconfirmed, closed month or not", () => {
    expect(forecastLabel(1, true)).toBe("Laufender Monat (Prognose)");
    expect(forecastLabel(1, false)).toBe("Laufender Monat (Prognose)");
    expect(forecastLabel(1)).toBe(FORECAST_LABEL_CURRENT_MONTH);
  });
  it("names the Monatsabschluss when more than one month is unconfirmed and a month was closed", () => {
    expect(forecastLabel(2, true)).toBe("Seit Monatsabschluss (Prognose)");
    expect(forecastLabel(5, true)).toBe(FORECAST_LABEL_SINCE_CLOSE);
  });
  it("names the hire when no month was closed yet", () => {
    expect(forecastLabel(5, false)).toBe("Prognose (seit Eintritt)");
    expect(forecastLabel(2, false)).toBe(FORECAST_LABEL_SINCE_HIRE);
  });
  it("treats an unknown month count by the closed-month fact alone", () => {
    for (const n of [0, null, undefined]) {
      expect(forecastLabel(n, true)).toBe(FORECAST_LABEL_SINCE_CLOSE);
      expect(forecastLabel(n, false)).toBe(FORECAST_LABEL_SINCE_HIRE);
    }
  });
  it("treats an unknown closed-month fact as no closed month", () => {
    expect(forecastLabel(3)).toBe(FORECAST_LABEL_SINCE_HIRE);
    expect(forecastLabel(3, null)).toBe(FORECAST_LABEL_SINCE_HIRE);
    expect(forecastLabel(null, undefined)).toBe(FORECAST_LABEL_SINCE_HIRE);
  });
});

describe("forecastColumnLabel", () => {
  it("uses the shared label when every row agrees", () => {
    expect(
      forecastColumnLabel([
        { unconfirmedMonths: 1, hasClosedMonth: true },
        { unconfirmedMonths: 1, hasClosedMonth: false },
      ]),
    ).toBe(FORECAST_LABEL_CURRENT_MONTH);
    expect(
      forecastColumnLabel([
        { unconfirmedMonths: 3, hasClosedMonth: true },
        { unconfirmedMonths: 2, hasClosedMonth: true },
      ]),
    ).toBe(FORECAST_LABEL_SINCE_CLOSE);
    expect(forecastColumnLabel([{ unconfirmedMonths: 4, hasClosedMonth: false }])).toBe(
      FORECAST_LABEL_SINCE_HIRE,
    );
  });
  it("says „Seit Monatsabschluss“ for a mix of one-month and longer rows that all have a closed month", () => {
    expect(
      forecastColumnLabel([
        { unconfirmedMonths: 1, hasClosedMonth: true },
        { unconfirmedMonths: 3, hasClosedMonth: true },
      ]),
    ).toBe(FORECAST_LABEL_SINCE_CLOSE);
  });
  it("falls back to the neutral label when the rows cannot share one", () => {
    expect(
      forecastColumnLabel([
        { unconfirmedMonths: 3, hasClosedMonth: true },
        { unconfirmedMonths: 5, hasClosedMonth: false },
      ]),
    ).toBe(FORECAST_LABEL_MIXED);
    expect(
      forecastColumnLabel([
        { unconfirmedMonths: 1, hasClosedMonth: false },
        { unconfirmedMonths: 3, hasClosedMonth: true },
      ]),
    ).toBe(FORECAST_LABEL_MIXED);
  });
  it("claims nothing for an empty table", () => {
    expect(forecastColumnLabel([])).toBe(FORECAST_LABEL_MIXED);
  });
  it("reads rows with unknown facts like forecastLabel does", () => {
    expect(forecastColumnLabel([{}, { unconfirmedMonths: null }])).toBe(FORECAST_LABEL_SINCE_HIRE);
  });
});

describe("forecastCaption", () => {
  it("follows the same three cases", () => {
    expect(forecastCaption(1, true)).toBe("inkl. laufendem Monat");
    expect(forecastCaption(1, false)).toBe("inkl. laufendem Monat");
    expect(forecastCaption(2, true)).toBe("inkl. Zeitraum seit Monatsabschluss");
    expect(forecastCaption(null, true)).toBe("inkl. Zeitraum seit Monatsabschluss");
    expect(forecastCaption(6, false)).toBe("inkl. Zeitraum seit Eintritt");
    expect(forecastCaption(undefined)).toBe("inkl. Zeitraum seit Eintritt");
  });
});
