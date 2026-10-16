/**
 * Issue #92 (Phase 92b, D-05/D-06) — the TRAVEL value of the activity vocabulary. DB-free; every
 * instant is a fixed past instant. TRAVEL is the kind of a WHOLE travel entry between two salons,
 * never a share: the share kinds stay PRODUCTIVE and SETUP_CLEANING, and the one share validator
 * refuses a TRAVEL share with its own text.
 */
import { describe, it, expect } from "vitest";
import { activityMinutes, ACTIVITY_KIND_LABEL } from "..";
import { ACTIVITY_SHARE_KINDS } from "../activity-kind";
import { validateActivityState, TRAVEL_SHARE_BODY, type ActivityState } from "../activity-shares";

const d = (iso: string) => new Date(iso);

/** 12:00-12:30 travel entry: 30 minutes of presence, no break. */
const travelEntry = {
  startTime: d("2026-03-10T12:00:00.000Z"),
  endTime: d("2026-03-10T12:30:00.000Z"),
  breakMinutes: 0,
  activityKind: "TRAVEL" as const,
};

describe("TRAVEL in the activity vocabulary (D-05)", () => {
  it("has the display label „Fahrzeit zwischen Salons“", () => {
    expect(ACTIVITY_KIND_LABEL.TRAVEL).toBe("Fahrzeit zwischen Salons");
  });

  it("TRAVEL is never a share kind", () => {
    expect(ACTIVITY_SHARE_KINDS).toEqual(["PRODUCTIVE", "SETUP_CLEANING"]);
  });

  it("activityMinutes puts a closed 30-minute travel entry into TRAVEL and nowhere else", () => {
    expect(activityMinutes(travelEntry, [])).toEqual({
      UNSPECIFIED: 0,
      PRODUCTIVE: 0,
      SETUP_CLEANING: 0,
      TRAVEL: 30,
    });
  });

  it("an open travel entry contributes 0 for every kind", () => {
    expect(activityMinutes({ ...travelEntry, endTime: null }, [])).toEqual({
      UNSPECIFIED: 0,
      PRODUCTIVE: 0,
      SETUP_CLEANING: 0,
      TRAVEL: 0,
    });
  });
});

describe("validateActivityState refuses a TRAVEL share (D-06)", () => {
  const state = (over: Partial<ActivityState> = {}): ActivityState => ({
    kind: "PRODUCTIVE",
    shares: [],
    startTime: d("2026-03-10T08:00:00.000Z"),
    endTime: d("2026-03-10T17:00:00.000Z"),
    breakMinutes: 45,
    ...over,
  });
  const ctx = { sharesWritten: true, wasClosed: true };

  it("a share of kind TRAVEL is a 400 with the travel share text", () => {
    const result = validateActivityState(state({ shares: [{ kind: "TRAVEL", minutes: 10 }] }), ctx);
    expect(result).toEqual({ ok: false, status: 400, body: TRAVEL_SHARE_BODY });
    expect(TRAVEL_SHARE_BODY.error).toBe(
      "Fahrzeit ist kein Tätigkeitsanteil. Sie wird als eigener Eintrag zwischen zwei Salons erfasst.",
    );
  });

  it("the existing share rules are unchanged", () => {
    expect(
      validateActivityState(state({ shares: [{ kind: "UNSPECIFIED", minutes: 5 }] }), ctx),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      validateActivityState(
        state({
          shares: [
            { kind: "SETUP_CLEANING", minutes: 5 },
            { kind: "SETUP_CLEANING", minutes: 6 },
          ],
        }),
        ctx,
      ),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      validateActivityState(state({ shares: [{ kind: "PRODUCTIVE", minutes: 5 }] }), ctx),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      validateActivityState(state({ shares: [{ kind: "SETUP_CLEANING", minutes: 9999 }] }), ctx),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      validateActivityState(state({ shares: [{ kind: "SETUP_CLEANING", minutes: 60 }] }), ctx),
    ).toEqual({ ok: true });
  });
});
