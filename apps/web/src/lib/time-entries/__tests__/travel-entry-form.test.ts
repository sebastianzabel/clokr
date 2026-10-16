// Issue #92 (Phase 92b-05, D-06/D-08) — the pure presentation of a trip between two salons.
//
// The server decides whether a trip is recordable (anchoring, salons, day breaks, overlap, month
// lock); this module only shapes the request and the labels. In particular the payload NEVER
// carries an entry kind, a break or an activity share (T-92b-24): the kind is derived server-side
// from `travelToSalonId` and is immutable.
import { describe, expect, it } from "vitest";

import {
  TRAVEL_TEXTS,
  isTravelRow,
  travelArrivalOptions,
  travelFormMode,
  travelPayload,
  travelRouteLabel,
} from "../travel-entry-form";

const TRAVEL = { activityKind: "TRAVEL" };
const ORDINARY = { activityKind: "UNSPECIFIED" };

describe("isTravelRow", () => {
  it("is true only for the kind TRAVEL", () => {
    expect(isTravelRow(TRAVEL)).toBe(true);
    expect(isTravelRow(ORDINARY)).toBe(false);
    expect(isTravelRow({ activityKind: "PRODUCTIVE" })).toBe(false);
    expect(isTravelRow({ activityKind: "SETUP_CLEANING" })).toBe(false);
  });

  it("is false for a row that carries no kind at all", () => {
    expect(isTravelRow({})).toBe(false);
    expect(isTravelRow({ activityKind: null })).toBe(false);
    expect(isTravelRow(null)).toBe(false);
    expect(isTravelRow(undefined)).toBe(false);
  });
});

describe("travelRouteLabel", () => {
  it("names the departure and the arrival salon from the served display names", () => {
    expect(
      travelRouteLabel({ salonName: "Salon Nordstadt", travelToSalonName: "Salon Südstadt" }),
    ).toBe("Salon Nordstadt → Salon Südstadt");
  });

  it("falls back to „anderer Salon“ on exactly the side whose name is absent", () => {
    expect(travelRouteLabel({ salonName: null, travelToSalonName: "Salon Südstadt" })).toBe(
      "anderer Salon → Salon Südstadt",
    );
    expect(travelRouteLabel({ salonName: "Salon Nordstadt", travelToSalonName: null })).toBe(
      "Salon Nordstadt → anderer Salon",
    );
    expect(travelRouteLabel({})).toBe("anderer Salon → anderer Salon");
  });
});

describe("travelPayload", () => {
  const base = {
    date: "2026-10-12",
    start: "2026-10-12T10:00:00.000Z",
    end: "2026-10-12T10:30:00.000Z",
    fromSalonId: "salon-a",
    toSalonId: "salon-b",
  };

  it("carries exactly the six keys of a trip - Von is salonId, Nach is travelToSalonId", () => {
    expect(travelPayload(base)).toEqual({
      date: "2026-10-12",
      startTime: "2026-10-12T10:00:00.000Z",
      endTime: "2026-10-12T10:30:00.000Z",
      salonId: "salon-a",
      travelToSalonId: "salon-b",
    });
    expect(Object.keys(travelPayload(base)).sort()).toEqual(
      ["date", "endTime", "salonId", "startTime", "travelToSalonId"].sort(),
    );
  });

  it("adds the note only when one is given (null clears it on an edit)", () => {
    expect(Object.keys(travelPayload({ ...base, note: "Stau" }))).toContain("note");
    expect(travelPayload({ ...base, note: "Stau" }).note).toBe("Stau");
    expect(travelPayload({ ...base, note: null }).note).toBeNull();
    expect("note" in travelPayload({ ...base, note: undefined })).toBe(false);
  });

  it("never carries a kind, a break, a break total or an activity share", () => {
    const keys = Object.keys(travelPayload({ ...base, note: "x" })).join(",");
    for (const forbidden of ["kind", "Kind", "break", "Break", "share", "Share", "activity"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("travelFormMode", () => {
  it("offers the switch on a NEW entry where salon options exist", () => {
    expect(travelFormMode(true, null)).toBe("offer");
  });

  it("is the travel form when a travel row is edited", () => {
    expect(travelFormMode(true, TRAVEL)).toBe("travel");
  });

  it("never offers the switch when editing any other row (the kind is immutable)", () => {
    expect(travelFormMode(true, ORDINARY)).toBe("none");
    expect(travelFormMode(true, {})).toBe("none");
  });

  it("is none without salon options, for a new entry and for an edit alike", () => {
    expect(travelFormMode(false, null)).toBe("none");
    expect(travelFormMode(false, TRAVEL)).toBe("none");
    expect(travelFormMode(false, ORDINARY)).toBe("none");
  });
});

describe("travelArrivalOptions", () => {
  const OPTIONS = [
    { id: "salon-b", name: "Salon Südstadt" },
    { id: "salon-a", name: "Salon Nordstadt" },
  ];

  it("returns the offered salons sorted by name, without touching the input", () => {
    expect(travelArrivalOptions(OPTIONS, null).map((s) => s.id)).toEqual(["salon-a", "salon-b"]);
    expect(OPTIONS.map((s) => s.id)).toEqual(["salon-b", "salon-a"]);
  });

  it("adds the edited trip's own arrival salon when the reach no longer lists it", () => {
    const out = travelArrivalOptions(OPTIONS, {
      travelToSalonId: "salon-z",
      travelToSalonName: "Salon Altstadt",
    });
    expect(out.map((s) => s.id)).toEqual(["salon-z", "salon-a", "salon-b"]);
  });

  it("adds nothing when the arrival salon is listed already or its name was not served", () => {
    expect(
      travelArrivalOptions(OPTIONS, {
        travelToSalonId: "salon-a",
        travelToSalonName: "Salon Nordstadt",
      }),
    ).toHaveLength(2);
    expect(
      travelArrivalOptions(OPTIONS, { travelToSalonId: "salon-z", travelToSalonName: null }),
    ).toHaveLength(2);
  });
});

describe("TRAVEL_TEXTS", () => {
  it("states the switch, the labels and the hint in German", () => {
    expect(TRAVEL_TEXTS.switchLabel).toBe("Fahrzeit zwischen Salons");
    expect(TRAVEL_TEXTS.from).toBe("Von Salon");
    expect(TRAVEL_TEXTS.to).toBe("Nach Salon");
    expect(TRAVEL_TEXTS.editTitle).toBe("Fahrzeit bearbeiten");
    expect(TRAVEL_TEXTS.badge).toBe("Fahrzeit");
    expect(TRAVEL_TEXTS.hint).toBe(
      "Erfassen Sie die Fahrt ab dem Verlassen des ersten Salons. Der Weg von oder nach Hause ist keine Arbeitszeit.",
    );
  });
});
