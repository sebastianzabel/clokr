/**
 * Issue #610 (Phase 610-04, Task 2, D-10 refined, P-610-18) - the pure re-couple decision.
 * DB-free: every instant is a fixed value, the day starts come from an injected function.
 */
import { describe, it, expect } from "vitest";
import {
  WIFI_HINT_LOOKBACK_DAYS,
  WIFI_HINT_SHIFT_DAYS,
  decideRecoupleHint,
  qualifyingDays,
  type RecoupleHintInput,
} from "../wifi-device-not-seen";

/** A day key's start as a UTC instant (the tenant zone is irrelevant to the pure rule). */
const dayStart = (day: string) => new Date(`${day}T00:00:00Z`);
const at = (iso: string) => new Date(iso);

describe("constants", () => {
  it("require three shift days inside a 28-day look-back", () => {
    expect(WIFI_HINT_SHIFT_DAYS).toBe(3);
    expect(WIFI_HINT_LOOKBACK_DAYS).toBe(28);
  });
});

describe("qualifyingDays", () => {
  const base = { today: "2026-11-02", lookbackStart: "2026-10-05" };

  it("keeps only days in BOTH sets, newest first", () => {
    const days = qualifyingDays({
      ...base,
      shiftDays: ["2026-10-30", "2026-10-28", "2026-10-29", "2026-10-27"],
      entryDays: ["2026-10-27", "2026-10-29", "2026-10-30", "2026-10-26"],
    });
    expect(days).toEqual(["2026-10-30", "2026-10-29", "2026-10-27"]);
  });

  it("drops today and the future (strictly before today)", () => {
    const days = qualifyingDays({
      ...base,
      shiftDays: ["2026-11-01", "2026-11-02", "2026-11-03"],
      entryDays: ["2026-11-01", "2026-11-02", "2026-11-03"],
    });
    expect(days).toEqual(["2026-11-01"]);
  });

  it("drops days before the look-back start and keeps the start day itself", () => {
    const days = qualifyingDays({
      ...base,
      shiftDays: ["2026-10-04", "2026-10-05", "2026-10-06"],
      entryDays: ["2026-10-04", "2026-10-05", "2026-10-06"],
    });
    expect(days).toEqual(["2026-10-06", "2026-10-05"]);
  });

  it("collapses duplicates (several shifts or entries on one day)", () => {
    const days = qualifyingDays({
      ...base,
      shiftDays: ["2026-10-30", "2026-10-30", "2026-10-29"],
      entryDays: ["2026-10-30", "2026-10-30", "2026-10-30", "2026-10-29"],
    });
    expect(days).toEqual(["2026-10-30", "2026-10-29"]);
  });

  it("is empty when a day has a shift but no entry, or the reverse", () => {
    expect(
      qualifyingDays({ ...base, shiftDays: ["2026-10-30"], entryDays: ["2026-10-29"] }),
    ).toEqual([]);
  });
});

describe("decideRecoupleHint", () => {
  // D1 > D2 > D3 > D4; S = start of D3.
  const D = ["2026-10-30", "2026-10-29", "2026-10-28", "2026-10-27"];
  const S = dayStart("2026-10-28");

  const world = (over: Partial<RecoupleHintInput> = {}): RecoupleHintInput => ({
    lastSeenAt: null,
    addedAt: at("2026-10-01T08:00:00Z"),
    qualifyingDaysDesc: D.slice(0, 3),
    dayStart,
    lastNoticeAt: null,
    tenantSignalAt: at("2026-10-31T08:00:00Z"),
    ...over,
  });

  it("hints when the device was never seen, was paired before S and the adapter is alive", () => {
    expect(decideRecoupleHint(world())).toEqual({ hint: true, sinceDay: "2026-10-28" });
  });

  it("uses the third-newest day even when a fourth qualifies", () => {
    expect(decideRecoupleHint(world({ qualifyingDaysDesc: D }))).toEqual({
      hint: true,
      sinceDay: "2026-10-28",
    });
  });

  it("does not hint with fewer than three qualifying days", () => {
    expect(decideRecoupleHint(world({ qualifyingDaysDesc: D.slice(0, 2) }))).toEqual({
      hint: false,
      reason: "FEWER_THAN_THREE_DAYS",
    });
    expect(decideRecoupleHint(world({ qualifyingDaysDesc: [] }))).toEqual({
      hint: false,
      reason: "FEWER_THAN_THREE_DAYS",
    });
  });

  it("does not hint when the device was seen at or after the start of the third day", () => {
    expect(decideRecoupleHint(world({ lastSeenAt: S }))).toEqual({
      hint: false,
      reason: "SEEN_IN_WINDOW",
    });
    expect(decideRecoupleHint(world({ lastSeenAt: at("2026-10-30T09:00:00Z") }))).toEqual({
      hint: false,
      reason: "SEEN_IN_WINDOW",
    });
  });

  it("hints when the last sighting is one millisecond before the start of the third day", () => {
    const justBefore = new Date(S.getTime() - 1);
    expect(decideRecoupleHint(world({ lastSeenAt: justBefore }))).toEqual({
      hint: true,
      sinceDay: "2026-10-28",
    });
  });

  it("does not hint for a device paired inside the window (pairing counts as a sign)", () => {
    expect(
      decideRecoupleHint(world({ lastSeenAt: at("2026-10-10T08:00:00Z"), addedAt: S })),
    ).toEqual({ hint: false, reason: "SEEN_IN_WINDOW" });
    expect(decideRecoupleHint(world({ addedAt: at("2026-10-30T08:00:00Z") }))).toEqual({
      hint: false,
      reason: "SEEN_IN_WINDOW",
    });
  });

  it("does not hint twice for the same episode (a notice after the last sign)", () => {
    expect(decideRecoupleHint(world({ lastNoticeAt: at("2026-10-31T09:20:00Z") }))).toEqual({
      hint: false,
      reason: "ALREADY_NOTIFIED",
    });
    // after a sighting that still lies before S: the notice is newer than max(lastSeenAt, addedAt)
    expect(
      decideRecoupleHint(
        world({
          lastSeenAt: at("2026-10-20T08:00:00Z"),
          lastNoticeAt: at("2026-10-21T09:20:00Z"),
        }),
      ),
    ).toEqual({ hint: false, reason: "ALREADY_NOTIFIED" });
  });

  it("re-arms the episode: seen again after the notice, then missing again", () => {
    expect(
      decideRecoupleHint(
        world({
          lastNoticeAt: at("2026-10-12T09:20:00Z"),
          lastSeenAt: at("2026-10-20T08:00:00Z"),
        }),
      ),
    ).toEqual({ hint: true, sinceDay: "2026-10-28" });
  });

  it("does not hint when the tenant signal is null or older than the third day (outage guard)", () => {
    expect(decideRecoupleHint(world({ tenantSignalAt: null }))).toEqual({
      hint: false,
      reason: "ADAPTER_SILENT",
    });
    expect(decideRecoupleHint(world({ tenantSignalAt: new Date(S.getTime() - 1) }))).toEqual({
      hint: false,
      reason: "ADAPTER_SILENT",
    });
  });

  it("accepts a tenant signal exactly at the start of the third day", () => {
    expect(decideRecoupleHint(world({ tenantSignalAt: S }))).toEqual({
      hint: true,
      sinceDay: "2026-10-28",
    });
  });
});
