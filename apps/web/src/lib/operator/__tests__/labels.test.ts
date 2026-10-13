import { describe, expect, it } from "vitest";
import type { FederalState } from "@clokr/types";

import {
  FEDERAL_STATE_OPTIONS,
  describeLoadError,
  federalStateLabel,
  formatOperatorDate,
} from "../labels";

const ALL: FederalState[] = [
  "NIEDERSACHSEN",
  "BAYERN",
  "BERLIN",
  "BRANDENBURG",
  "BREMEN",
  "HAMBURG",
  "HESSEN",
  "MECKLENBURG_VORPOMMERN",
  "NORDRHEIN_WESTFALEN",
  "RHEINLAND_PFALZ",
  "SAARLAND",
  "SACHSEN",
  "SACHSEN_ANHALT",
  "SCHLESWIG_HOLSTEIN",
  "THUERINGEN",
  "BADEN_WUERTTEMBERG",
];

describe("operator labels", () => {
  it("covers exactly the 16 federal states, once each", () => {
    const values = FEDERAL_STATE_OPTIONS.map((o) => o.value);
    expect(values).toHaveLength(16);
    expect(new Set(values).size).toBe(16);
    expect([...values].sort((a, b) => a.localeCompare(b))).toEqual(
      [...ALL].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("uses the German labels of the admin system page", () => {
    expect(federalStateLabel("BADEN_WUERTTEMBERG")).toBe("Baden-Württemberg");
    expect(federalStateLabel("THUERINGEN")).toBe("Thüringen");
    expect(federalStateLabel("MECKLENBURG_VORPOMMERN")).toBe("Mecklenburg-Vorpommern");
    expect(federalStateLabel("NIEDERSACHSEN")).toBe("Niedersachsen");
  });

  it("sorts the options by their German label", () => {
    const labels = FEDERAL_STATE_OPTIONS.map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, "de")));
  });

  it("formats an ISO timestamp as dd.MM.yyyy", () => {
    expect(formatOperatorDate("2026-03-05T12:00:00.000Z")).toBe("05.03.2026");
  });
});

describe("describeLoadError", () => {
  const FALLBACK = "Mandanten konnten nicht geladen werden. Bitte erneut versuchen.";

  it("names a lost connection (fetch rejects with a TypeError)", () => {
    expect(describeLoadError(new TypeError("Failed to fetch"), FALLBACK)).toBe(
      "Keine Verbindung zum Server. Bitte erneut versuchen.",
    );
  });

  it("names a rate limit by status 429", () => {
    expect(describeLoadError({ status: 429 }, FALLBACK)).toBe(
      "Zu viele Anfragen. Bitte einen Moment warten und erneut versuchen.",
    );
  });

  it("names a server fault by any 5xx status", () => {
    for (const status of [500, 502, 503]) {
      expect(describeLoadError({ status }, FALLBACK)).toBe(
        "Der Server hat einen Fehler gemeldet. Bitte erneut versuchen.",
      );
    }
  });

  it("falls back for every other status and for unknown values", () => {
    expect(describeLoadError({ status: 404 }, FALLBACK)).toBe(FALLBACK);
    expect(describeLoadError(new Error("boom"), FALLBACK)).toBe(FALLBACK);
    expect(describeLoadError(null, FALLBACK)).toBe(FALLBACK);
  });

  it("ignores the message text: a message that says 429 does not change the outcome", () => {
    expect(describeLoadError({ status: 400, message: "429" }, FALLBACK)).toBe(FALLBACK);
  });
});
