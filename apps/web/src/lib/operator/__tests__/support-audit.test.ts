// Issue #93 (D-05(4), D-17, T-93b-39) - the pure helpers of the support protocol view: the window
// the client mirrors from the API (at most 92 calendar days), the query values, the flattening of a
// redacted old/new value into key/value rows and the actor label of a row.
import { describe, expect, it } from "vitest";

import {
  AUDIT_MAX_WINDOW_DAYS,
  AUDIT_REDACTED_MARKER,
  auditActor,
  dayFromQuery,
  defaultAuditWindow,
  flattenAuditValue,
  pageFromQuery,
  windowError,
  windowLength,
} from "../support-audit";

describe("audit window", () => {
  it("defaults to the last 30 days up to today in the browser's zone", () => {
    expect(defaultAuditWindow(new Date(2026, 9, 15, 12, 0))).toEqual({
      from: "2026-09-15",
      to: "2026-10-15",
    });
  });

  it("counts both ends of a window", () => {
    expect(windowLength("2026-10-01", "2026-10-01")).toBe(1);
    expect(windowLength("2026-10-01", "2026-10-31")).toBe(31);
    expect(windowLength("2026-10-31", "2026-10-01")).toBe(-29);
    expect(windowLength("2026-10-01", "")).toBeNull();
    expect(windowLength("2026-02-30", "2026-03-01")).toBeNull();
  });

  it("accepts exactly 92 days and refuses 93", () => {
    expect(AUDIT_MAX_WINDOW_DAYS).toBe(92);
    expect(windowError("2026-07-01", "2026-09-30")).toBeNull();
    expect(windowError("2026-07-01", "2026-10-01")).toBe(
      "Der Zeitraum darf höchstens 92 Tage umfassen.",
    );
  });

  it("names an end before the beginning and a missing day", () => {
    expect(windowError("2026-10-02", "2026-10-01")).toBe("Das Ende liegt vor dem Beginn.");
    expect(windowError("", "2026-10-01")).toBe("Bitte Beginn und Ende des Zeitraums angeben.");
    expect(windowError("2026-10-01", "")).toBe("Bitte Beginn und Ende des Zeitraums angeben.");
  });
});

describe("query values", () => {
  it("takes a real calendar day only", () => {
    expect(dayFromQuery("2026-10-15")).toBe("2026-10-15");
    expect(dayFromQuery("2026-02-30")).toBeNull();
    expect(dayFromQuery("15.10.2026")).toBeNull();
    expect(dayFromQuery(null)).toBeNull();
  });

  it("takes a positive whole page number, otherwise the first page", () => {
    expect(pageFromQuery("3")).toBe(3);
    expect(pageFromQuery("0")).toBe(1);
    expect(pageFromQuery("-2")).toBe(1);
    expect(pageFromQuery("1.5")).toBe(1);
    expect(pageFromQuery("abc")).toBe(1);
    expect(pageFromQuery(null)).toBe(1);
  });
});

describe("flattenAuditValue", () => {
  it("yields no row for a missing value", () => {
    expect(flattenAuditValue(null)).toEqual([]);
    expect(flattenAuditValue(undefined)).toEqual([]);
  });

  it("flattens objects and arrays into key paths and marks the redaction marker", () => {
    const rows = flattenAuditValue({
      minutes: 30,
      locked: false,
      note: AUDIT_REDACTED_MARKER,
      breaks: [{ start: "2026-09-02T10:00:00.000Z" }],
      gone: null,
      empty: {},
    });
    expect(rows).toEqual([
      { path: "minutes", text: "30", redacted: false },
      { path: "locked", text: "Nein", redacted: false },
      { path: "note", text: AUDIT_REDACTED_MARKER, redacted: true },
      { path: "breaks[0].start", text: "2026-09-02T10:00:00.000Z", redacted: false },
      { path: "gone", text: "–", redacted: false },
      { path: "empty", text: "leer", redacted: false },
    ]);
  });

  it("renders a top-level primitive as one row without a key", () => {
    expect(flattenAuditValue("CREATE")).toEqual([{ path: "", text: "CREATE", redacted: false }]);
    expect(flattenAuditValue(AUDIT_REDACTED_MARKER)).toEqual([
      { path: "", text: AUDIT_REDACTED_MARKER, redacted: true },
    ]);
    expect(flattenAuditValue(true)).toEqual([{ path: "", text: "Ja", redacted: false }]);
  });

  it("keeps a marker-looking key as a key, never as a redaction", () => {
    expect(flattenAuditValue({ [AUDIT_REDACTED_MARKER]: 1 })).toEqual([
      { path: AUDIT_REDACTED_MARKER, text: "1", redacted: false },
    ]);
  });
});

describe("auditActor", () => {
  it("labels an operator row Betreiber by the actor type code", () => {
    expect(
      auditActor({ userId: null, newValue: { actor: { type: "OPERATOR", operatorId: "op-1" } } }),
    ).toEqual({ kind: "operator", text: "Betreiber" });
  });

  it("labels a row with a user as Benutzer and one without anyone as System", () => {
    expect(auditActor({ userId: "user-1", newValue: { minutes: 1 } })).toEqual({
      kind: "user",
      text: "Benutzer",
    });
    expect(auditActor({ userId: null, newValue: null })).toEqual({
      kind: "system",
      text: "System",
    });
  });

  it("does not take a display string for an operator", () => {
    expect(auditActor({ userId: null, newValue: { actor: { type: "Betreiber" } } }).kind).toBe(
      "system",
    );
  });
});
