/**
 * Issue #92 (Phase 92b-02) — pure proofs of the travel write rule: the anchor rule T3, the orphan
 * detection behind the neighbour check T6 and the shape classification. No database.
 *
 * The anchor rule: a travel entry is anchored when the closed non-travel WORK entry that ends last
 * at or before its start lies in the DEPARTURE salon and the non-travel WORK entry that starts first
 * at or after its end lies in the ARRIVAL salon. A pending Zeitnachtrag (RETRO_APPROVAL_PENDING) is
 * not yet a recorded statement and never anchors; any other invalid row is recorded attendance and
 * does.
 */
import { describe, it, expect } from "vitest";
import {
  classifyTravelWrite,
  TRAVEL_KIND_DERIVED_CODE,
  TRAVEL_NOT_BETWEEN_SALON_ENTRIES_CODE,
  TRAVEL_SALONS_REQUIRED_CODE,
  TRAVEL_SAME_SALON_CODE,
  TRAVEL_SHAPE_CODE,
  travelRowsOrphanedBy,
  validateTravelAnchors,
  type TravelDayRow,
} from "../travel-entry";

const DAY = "2026-10-12";
const at = (hhmm: string): Date => new Date(`${DAY}T${hhmm}:00.000Z`);

let seq = 0;
function row(
  partial: Partial<TravelDayRow> & { startTime: Date; endTime: Date | null; salonId: string },
): TravelDayRow {
  seq += 1;
  return {
    id: partial.id ?? `row-${String(seq).padStart(3, "0")}`,
    type: "WORK",
    activityKind: "UNSPECIFIED",
    travelToSalonId: null,
    invalidReasonCode: null,
    ...partial,
  };
}

const SALON_A = "salon-a";
const SALON_B = "salon-b";
const SALON_C = "salon-c";

const entryA = () =>
  row({ id: "entry-a", startTime: at("08:00"), endTime: at("12:00"), salonId: SALON_A });
const entryB = () =>
  row({ id: "entry-b", startTime: at("12:30"), endTime: at("14:30"), salonId: SALON_B });
const candidate = {
  startTime: at("12:00"),
  endTime: at("12:30"),
  salonId: SALON_A,
  travelToSalonId: SALON_B,
};

describe("validateTravelAnchors (T3)", () => {
  it("accepts a predecessor in the departure salon and a closed successor in the arrival salon", () => {
    expect(validateTravelAnchors([entryA(), entryB()], candidate)).toEqual({ ok: true });
  });

  it("accepts an OPEN successor in the arrival salon (a running clock-in is a real entry)", () => {
    const openB = row({ id: "entry-b", startTime: at("12:30"), endTime: null, salonId: SALON_B });
    expect(validateTravelAnchors([entryA(), openB], candidate)).toEqual({ ok: true });
  });

  it("accepts gaps before and after the travel entry", () => {
    const early = row({
      id: "entry-a",
      startTime: at("08:00"),
      endTime: at("11:00"),
      salonId: SALON_A,
    });
    const late = row({
      id: "entry-b",
      startTime: at("13:30"),
      endTime: at("15:00"),
      salonId: SALON_B,
    });
    expect(validateTravelAnchors([early, late], candidate)).toEqual({ ok: true });
  });

  it("ignores other travel rows when it picks the neighbours", () => {
    const otherTravel = row({
      id: "travel-x",
      startTime: at("11:00"),
      endTime: at("11:10"),
      salonId: SALON_C,
      activityKind: "TRAVEL",
      travelToSalonId: SALON_A,
    });
    expect(validateTravelAnchors([entryA(), otherTravel, entryB()], candidate)).toEqual({
      ok: true,
    });
  });

  it("ignores a pending Zeitnachtrag row: the neighbour behind it decides", () => {
    const pending = row({
      id: "entry-p",
      startTime: at("12:30"),
      endTime: at("13:00"),
      salonId: SALON_C,
      invalidReasonCode: "RETRO_APPROVAL_PENDING",
    });
    const lateB = row({
      id: "entry-b",
      startTime: at("13:00"),
      endTime: at("14:30"),
      salonId: SALON_B,
    });
    expect(validateTravelAnchors([entryA(), pending, lateB], candidate)).toEqual({ ok: true });
  });

  it("a pending row alone is no successor", () => {
    const pendingB = row({
      id: "entry-p",
      startTime: at("12:30"),
      endTime: at("14:30"),
      salonId: SALON_B,
      invalidReasonCode: "RETRO_APPROVAL_PENDING",
    });
    const verdict = validateTravelAnchors([entryA(), pendingB], candidate);
    expect(verdict.ok).toBe(false);
  });

  it("counts a row invalid for another reason (missing clock-out) as an anchor", () => {
    const invalidB = row({
      id: "entry-b",
      startTime: at("12:30"),
      endTime: at("14:30"),
      salonId: SALON_B,
      invalidReasonCode: "MISSING_CLOCK_OUT",
    });
    expect(validateTravelAnchors([entryA(), invalidB], candidate)).toEqual({ ok: true });
  });

  it("excludes the candidate's own id", () => {
    const self = row({
      id: "travel-self",
      startTime: at("12:00"),
      endTime: at("12:30"),
      salonId: SALON_A,
      activityKind: "TRAVEL",
      travelToSalonId: SALON_B,
    });
    expect(
      validateTravelAnchors([entryA(), self, entryB()], { ...candidate, id: "travel-self" }),
    ).toEqual({ ok: true });
  });

  it.each([
    ["no predecessor", () => [entryB()]],
    ["no successor", () => [entryA()]],
    [
      "a predecessor in another salon",
      () => [
        row({ id: "entry-a", startTime: at("08:00"), endTime: at("12:00"), salonId: SALON_C }),
        entryB(),
      ],
    ],
    [
      "a successor in another salon",
      () => [
        entryA(),
        row({ id: "entry-b", startTime: at("12:30"), endTime: at("14:30"), salonId: SALON_C }),
      ],
    ],
    [
      "an OPEN predecessor",
      () => [
        row({ id: "entry-a", startTime: at("08:00"), endTime: null, salonId: SALON_A }),
        entryB(),
      ],
    ],
  ])("refuses %s with TRAVEL_NOT_BETWEEN_SALON_ENTRIES", (_label, rows) => {
    const verdict = validateTravelAnchors(rows(), candidate);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.status).toBe(409);
      expect(verdict.body.code).toBe(TRAVEL_NOT_BETWEEN_SALON_ENTRIES_CODE);
    }
  });
});

describe("travelRowsOrphanedBy (T6)", () => {
  const travel = () =>
    row({
      id: "travel-1",
      startTime: at("12:00"),
      endTime: at("12:30"),
      salonId: SALON_A,
      activityKind: "TRAVEL",
      travelToSalonId: SALON_B,
    });

  it("returns nothing for an anchored day and for a day without travel", () => {
    expect(travelRowsOrphanedBy([entryA(), travel(), entryB()])).toEqual([]);
    expect(travelRowsOrphanedBy([entryA(), entryB()])).toEqual([]);
  });

  it("returns exactly the travel id after the arrival row is removed", () => {
    expect(travelRowsOrphanedBy([entryA(), travel()])).toEqual(["travel-1"]);
  });

  it("returns the id after the arrival row moved into another salon", () => {
    const movedB = { ...entryB(), salonId: SALON_C };
    expect(travelRowsOrphanedBy([entryA(), travel(), movedB])).toEqual(["travel-1"]);
  });

  it("returns the id after a row of another salon was inserted between the travel row and its arrival row", () => {
    const between = row({
      id: "entry-c",
      startTime: at("12:30"),
      endTime: at("12:45"),
      salonId: SALON_C,
    });
    const lateB = row({
      id: "entry-b",
      startTime: at("13:00"),
      endTime: at("14:30"),
      salonId: SALON_B,
    });
    expect(travelRowsOrphanedBy([entryA(), travel(), between, lateB])).toEqual(["travel-1"]);
  });

  it("an inserted row of the arrival salon keeps the trip anchored", () => {
    const between = row({
      id: "entry-c",
      startTime: at("12:30"),
      endTime: at("12:45"),
      salonId: SALON_B,
    });
    const lateB = row({
      id: "entry-b",
      startTime: at("13:00"),
      endTime: at("14:30"),
      salonId: SALON_B,
    });
    expect(travelRowsOrphanedBy([entryA(), travel(), between, lateB])).toEqual([]);
  });

  it("a pending Zeitnachtrag row is no arrival anchor", () => {
    const pendingB = {
      ...entryB(),
      invalidReasonCode: "RETRO_APPROVAL_PENDING" as const,
    };
    expect(travelRowsOrphanedBy([entryA(), travel(), pendingB])).toEqual(["travel-1"]);
  });

  it("lists several orphans in id order", () => {
    const t2 = { ...travel(), id: "travel-0", startTime: at("12:05"), endTime: at("12:20") };
    expect(travelRowsOrphanedBy([entryA(), travel(), t2])).toEqual(["travel-0", "travel-1"]);
  });
});

describe("classifyTravelWrite", () => {
  const base = {
    salonId: SALON_A,
    travelToSalonId: SALON_B,
    endTime: "2026-10-12T12:30:00.000Z",
  };

  it("an ordinary body (also one with activityKind PRODUCTIVE) is not travel", () => {
    expect(classifyTravelWrite({ salonId: SALON_A })).toEqual({ ok: true, travel: false });
    expect(classifyTravelWrite({ salonId: SALON_A, activityKind: "PRODUCTIVE" })).toEqual({
      ok: true,
      travel: false,
    });
  });

  it("a well-formed travel body is travel", () => {
    expect(classifyTravelWrite(base)).toEqual({
      ok: true,
      travel: true,
      travelToSalonId: SALON_B,
    });
  });

  it.each([
    [{ ...base, activityKind: "TRAVEL" }, 400, TRAVEL_KIND_DERIVED_CODE],
    [{ ...base, salonId: undefined }, 400, TRAVEL_SALONS_REQUIRED_CODE],
    [{ ...base, travelToSalonId: SALON_A }, 400, TRAVEL_SAME_SALON_CODE],
    [{ ...base, endTime: null }, 400, TRAVEL_SHAPE_CODE],
    [{ ...base, breakMinutes: 15 }, 400, TRAVEL_SHAPE_CODE],
    [{ ...base, breaks: [{}] }, 400, TRAVEL_SHAPE_CODE],
    [{ ...base, activityKind: "PRODUCTIVE" }, 400, TRAVEL_SHAPE_CODE],
    [{ ...base, activityShares: [{}] }, 400, TRAVEL_SHAPE_CODE],
  ])("refuses %j with %i %s", (body, status, code) => {
    const verdict = classifyTravelWrite(body);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.status).toBe(status);
      expect(verdict.body.code).toBe(code);
    }
  });
});
