import { describe, it, expect } from "vitest";
import { normalizeDateParam, resolveFocusTarget } from "../deep-link";

// Phase 112 (GitHub issue #115) — receiver-side hardening. A `?date=` param is untrusted text;
// before this module it went straight into `new Date(param + "T12:00:00")` and then into
// date-fns `format()` and MonthBar's Intl.DateTimeFormat().format(), both of which THROW
// RangeError on an Invalid Date. apps/web/src has no <svelte:boundary>, so the page just went
// blank.

describe("normalizeDateParam", () => {
  it("Test 1: the exact value that shipped broken is reduced to a plain day", () => {
    expect(normalizeDateParam("2026-08-05T00:00:00.000Z")).toBe("2026-08-05");
  });

  it("Test 2: an already-plain day is idempotent", () => {
    expect(normalizeDateParam("2026-08-05")).toBe("2026-08-05");
  });

  it("Test 3: empty-ish inputs yield null", () => {
    expect(normalizeDateParam(null)).toBeNull();
    expect(normalizeDateParam(undefined)).toBeNull();
    expect(normalizeDateParam("")).toBeNull();
  });

  it("Test 4: junk yields null", () => {
    expect(normalizeDateParam("nonsense")).toBeNull();
  });

  it("Test 5: a non-zero-padded day yields null — no emitter in this repo produces it", () => {
    expect(normalizeDateParam("2026-8-5")).toBeNull();
  });

  it("Test 6: the Date probe is load-bearing — shape-valid but unreal days are rejected", () => {
    // Both match /^\d{4}-\d{2}-\d{2}$/, so only the probe can reject them.
    expect(normalizeDateParam("2026-13-01")).toBeNull();
    expect(normalizeDateParam("2026-02-30")).toBeNull();
  });

  it("Test 7: crash guard — every ACCEPTED value survives the destination's own computation", () => {
    const inputs = [
      "2026-08-05T00:00:00.000Z",
      "2026-08-05",
      "2025-11-04",
      "2024-02-29", // real leap day
      "2026-12-31",
    ];
    for (const raw of inputs) {
      const day = normalizeDateParam(raw);
      expect(day).not.toBeNull();
      // Reproduces time-entries/+page.svelte's own expression.
      expect(Number.isNaN(new Date(day + "T12:00:00").getTime())).toBe(false);
    }
  });
});

describe("resolveFocusTarget", () => {
  const entries = [
    { id: "e1", date: "2026-08-05T00:00:00.000Z" },
    { id: "e2", date: "2026-08-06T00:00:00.000Z" },
    { id: "e3", date: "2026-08-06T00:00:00.000Z" },
  ];

  it("Test 8: a highlight id matching a loaded entry resolves to that entry", () => {
    expect(resolveFocusTarget(entries, "e1", null)).toEqual({
      entryId: "e1",
      day: "2026-08-05",
    });
  });

  it("Test 9: the returned day is normalized, never the full ISO instant", () => {
    const target = resolveFocusTarget(entries, "e2", null);
    expect(target.day).toBe("2026-08-06");
    expect(target.day).not.toMatch(/T/);
  });

  it("Test 10: an unknown highlight id falls back to the first entry on the given day", () => {
    expect(resolveFocusTarget(entries, "does-not-exist", "2026-08-06")).toEqual({
      entryId: "e2",
      day: "2026-08-06",
    });
  });

  it("Test 11: an unknown highlight id with no entry on that day keeps the day, focuses nothing", () => {
    expect(resolveFocusTarget(entries, "does-not-exist", "2026-08-09")).toEqual({
      entryId: null,
      day: "2026-08-09",
    });
  });

  it("Test 12: an unknown highlight id and no day resolves to nothing", () => {
    expect(resolveFocusTarget(entries, "does-not-exist", null)).toEqual({
      entryId: null,
      day: null,
    });
  });

  it("Test 13: a null highlight id with a day focuses the first entry on that day", () => {
    expect(resolveFocusTarget(entries, null, "2026-08-05")).toEqual({
      entryId: "e1",
      day: "2026-08-05",
    });
  });

  it("Test 14: an empty entries list never throws", () => {
    expect(resolveFocusTarget([], null, "2026-08-05")).toEqual({
      entryId: null,
      day: "2026-08-05",
    });
    expect(resolveFocusTarget(null, "e1", null)).toEqual({ entryId: null, day: null });
    expect(resolveFocusTarget(undefined, null, null)).toEqual({ entryId: null, day: null });
  });

  it("Test 15: highlight wins over day when the two point at different entries", () => {
    const target = resolveFocusTarget(entries, "e1", "2026-08-06");
    expect(target.entryId).toBe("e1");
    expect(target.day).toBe("2026-08-05");
  });
});
