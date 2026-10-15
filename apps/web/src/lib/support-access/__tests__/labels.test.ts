// Issue #93 (Phase 93b-10) — the German labels of the tenant's support-access page. Display only:
// every map is keyed by the control value the API sends, and the instants are shown in the TENANT's
// time zone from the API, never the browser's.
import { describe, expect, it } from "vitest";

import {
  CATEGORY_LABELS,
  ENDED_BY_LABELS,
  STATUS_LABELS,
  categoryLabel,
  endedByLabel,
  formatInZone,
  formatMonth,
  formatReadWindow,
  statusBadgeClass,
  statusLabel,
} from "../labels";

describe("support-access labels", () => {
  it("names the three statuses", () => {
    expect(STATUS_LABELS).toEqual({ ACTIVE: "Aktiv", EXPIRED: "Abgelaufen", ENDED: "Beendet" });
    expect(statusLabel("ACTIVE")).toBe("Aktiv");
    expect(statusLabel("EXPIRED")).toBe("Abgelaufen");
    expect(statusLabel("ENDED")).toBe("Beendet");
  });

  it("names the four read categories", () => {
    expect(CATEGORY_LABELS).toEqual({
      EMPLOYEES: "Mitarbeitende",
      EMPLOYEE_MONTH: "Monatsansicht",
      CONTRACTS: "Verträge",
      AUDIT_LOG: "Änderungsprotokoll",
    });
    expect(categoryLabel("EMPLOYEE_MONTH")).toBe("Monatsansicht");
  });

  it("names who ended an access", () => {
    expect(ENDED_BY_LABELS).toEqual({
      OPERATOR: "durch den Betreiber",
      TENANT: "durch Ihre Verwaltung",
    });
    expect(endedByLabel("TENANT")).toBe("durch Ihre Verwaltung");
    expect(endedByLabel(null)).toBe("");
  });

  it("shows an unknown control value raw, never hides it and never throws", () => {
    expect(statusLabel("SUSPENDED")).toBe("SUSPENDED");
    expect(categoryLabel("UNKNOWN")).toBe("UNKNOWN");
    expect(endedByLabel("SYSTEM")).toBe("SYSTEM");
  });

  it("gives every known status a badge recipe from app.css and an unknown one the neutral badge", () => {
    expect(statusBadgeClass("ACTIVE")).toMatch(/^badge badge-[a-z]+$/);
    expect(statusBadgeClass("EXPIRED")).toMatch(/^badge badge-[a-z]+$/);
    expect(statusBadgeClass("ENDED")).toMatch(/^badge badge-[a-z]+$/);
    const classes = new Set(["ACTIVE", "EXPIRED", "ENDED"].map(statusBadgeClass));
    expect(classes.size).toBe(3);
    expect(statusBadgeClass("SUSPENDED")).toBe("badge badge-gray");
  });
});

describe("formatInZone", () => {
  // 2026-07-01T22:30:00Z is 00:30 on 2 July in Berlin (summer time) and 18:30 on 1 July in New York.
  const instant = "2026-07-01T22:30:00.000Z";

  it("uses the zone it is given: the same instant gives two different strings", () => {
    const berlin = formatInZone(instant, "Europe/Berlin");
    const newYork = formatInZone(instant, "America/New_York");
    expect(berlin).not.toBe(newYork);
    expect(berlin).toBe("02.07.2026, 00:30");
    expect(newYork).toBe("01.07.2026, 18:30");
  });

  it("never follows the browser zone", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Auckland";
      expect(formatInZone(instant, "Europe/Berlin")).toBe("02.07.2026, 00:30");
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("returns the raw value for an unparseable instant or an unknown zone", () => {
    expect(formatInZone("not-a-date", "Europe/Berlin")).toBe("not-a-date");
    expect(formatInZone(instant, "Not/AZone")).toBe(instant);
  });

  it("returns an em dash for a missing instant", () => {
    expect(formatInZone(null, "Europe/Berlin")).toBe("—");
  });
});

describe("formatMonth and formatReadWindow", () => {
  it("writes a stored month in German", () => {
    expect(formatMonth("2026-09")).toBe("September 2026");
    expect(formatMonth("2026-03")).toBe("März 2026");
    expect(formatMonth(null)).toBe("");
    expect(formatMonth("garbage")).toBe("garbage");
  });

  it("writes a stored window from the audit-log read", () => {
    expect(formatReadWindow({ from: "2026-09-01", to: "2026-09-30", page: 1 })).toBe(
      "01.09.2026 – 30.09.2026",
    );
    expect(formatReadWindow({ from: "2026-09-01" })).toBe("ab 01.09.2026");
    expect(formatReadWindow({ to: "2026-09-30" })).toBe("bis 30.09.2026");
    expect(formatReadWindow({ page: 2 })).toBe("");
    expect(formatReadWindow(null)).toBe("");
  });

  it("ignores a window value that is not a calendar day", () => {
    expect(formatReadWindow({ from: "<b>x</b>", to: 5 })).toBe("");
  });
});
