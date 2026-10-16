/**
 * Issue #81 (D-02/D-04/D-05) — the activity vocabulary, the per-kind kernel and the ONE share
 * validator. DB-free; every instant is a fixed past instant. Everything is imported through the
 * context's public surface or the flat module itself, never through a foreign context.
 *
 * This is the shared unit file of the phase: later plans append the cases of `isActivityOnlyPut`
 * and `materializeRemainder` here.
 *
 * Amended 2026-10-16 for #92 (Phase 92b, D-05): the vocabulary has a fourth value, TRAVEL (the kind
 * of a whole travel entry between two salons, never a share). The label map and every full
 * `activityMinutes()` result object gain TRAVEL (label „Fahrzeit zwischen Salons“, minutes 0 for
 * these non-travel entries); the share-kind list is unchanged. Case count unchanged.
 *
 * Amended 2026-10-16 for #92 (Phase 92b-02): `ActivityPutExisting` gains the stored destination
 * `travelToSalonId` (required, so no caller can forget it); the `isActivityOnlyPut` fixture row
 * carries `travelToSalonId: null`. No expectation changes; case count unchanged.
 */
import { describe, it, expect } from "vitest";
import { entryDurations } from "..";
import { activityMinutes, ACTIVITY_KIND_LABEL } from "..";
import { ACTIVITY_SHARE_KINDS, activityKindSchema, activitySharesSchema } from "../activity-kind";
import {
  activitySharesCreate,
  activitySharesReplace,
  isActivityOnlyPut,
  materializeRemainder,
  mergeActivityWrite,
  validateActivityState,
  type ActivityState,
} from "../activity-shares";

const d = (iso: string) => new Date(iso);

const START = d("2026-03-10T08:00:00.000Z");
const END = d("2026-03-10T17:00:00.000Z");

/** 08:00-17:00 with a 45 min break: 540 presence, 495 working. */
const closed = (over: Partial<ActivityState> = {}): ActivityState => ({
  kind: "PRODUCTIVE",
  shares: [],
  startTime: START,
  endTime: END,
  breakMinutes: 45,
  ...over,
});

const ctx = { sharesWritten: true, wasClosed: true };

describe("vocabulary (D-02)", () => {
  it("labels are exactly the four display texts", () => {
    expect(ACTIVITY_KIND_LABEL).toEqual({
      UNSPECIFIED: "nicht angegeben",
      PRODUCTIVE: "Produktive Zeit am Kunden",
      SETUP_CLEANING: "Rüst-, Reinigungs- und Vorbereitungszeit",
      TRAVEL: "Fahrzeit zwischen Salons",
    });
  });

  it("only PRODUCTIVE and SETUP_CLEANING can carry a share", () => {
    expect(ACTIVITY_SHARE_KINDS).toEqual(["PRODUCTIVE", "SETUP_CLEANING"]);
  });

  it("activityKindSchema accepts the three kinds and nothing else", () => {
    expect(activityKindSchema.safeParse("UNSPECIFIED").success).toBe(true);
    expect(activityKindSchema.safeParse("PRODUCTIVE").success).toBe(true);
    expect(activityKindSchema.safeParse("SETUP_CLEANING").success).toBe(true);
    expect(activityKindSchema.safeParse("Produktive Zeit am Kunden").success).toBe(false);
    expect(activityKindSchema.safeParse(null).success).toBe(false);
  });

  it("activitySharesSchema accepts [] and one share, rejects 3 items, 0 and fractional minutes, an unknown kind", () => {
    expect(activitySharesSchema.safeParse([]).success).toBe(true);
    expect(activitySharesSchema.safeParse([{ kind: "SETUP_CLEANING", minutes: 60 }]).success).toBe(
      true,
    );
    const three = [
      { kind: "PRODUCTIVE", minutes: 1 },
      { kind: "SETUP_CLEANING", minutes: 1 },
      { kind: "UNSPECIFIED", minutes: 1 },
    ];
    expect(activitySharesSchema.safeParse(three).success).toBe(false);
    expect(activitySharesSchema.safeParse([{ kind: "SETUP_CLEANING", minutes: 0 }]).success).toBe(
      false,
    );
    expect(activitySharesSchema.safeParse([{ kind: "SETUP_CLEANING", minutes: 1.5 }]).success).toBe(
      false,
    );
    expect(activitySharesSchema.safeParse([{ kind: "BREAK", minutes: 5 }]).success).toBe(false);
  });
});

describe("activityMinutes (D-04)", () => {
  const entry = { startTime: START, endTime: END, breakMinutes: 45 };

  it("08:00-17:00, 45 min break, PRODUCTIVE with a SETUP_CLEANING share of 60: 435 / 60 / 0", () => {
    expect(
      activityMinutes({ ...entry, activityKind: "PRODUCTIVE" }, [
        { kind: "SETUP_CLEANING", minutes: 60 },
      ]),
    ).toEqual({ PRODUCTIVE: 435, SETUP_CLEANING: 60, UNSPECIFIED: 0, TRAVEL: 0 });
  });

  it("the same entry unclassified (legacy) is 495 UNSPECIFIED", () => {
    expect(activityMinutes({ ...entry, activityKind: "UNSPECIFIED" }, [])).toEqual({
      PRODUCTIVE: 0,
      SETUP_CLEANING: 0,
      UNSPECIFIED: 495,
      TRAVEL: 0,
    });
  });

  it("an open entry contributes 0 for every kind, also with dormant shares", () => {
    expect(
      activityMinutes(
        { startTime: START, endTime: null, breakMinutes: 45, activityKind: "PRODUCTIVE" },
        [{ kind: "SETUP_CLEANING", minutes: 60 }],
      ),
    ).toEqual({ PRODUCTIVE: 0, SETUP_CLEANING: 0, UNSPECIFIED: 0, TRAVEL: 0 });
  });

  it("an UNSPECIFIED entry keeps the remainder under UNSPECIFIED next to two shares", () => {
    expect(
      activityMinutes({ ...entry, activityKind: "UNSPECIFIED" }, [
        { kind: "PRODUCTIVE", minutes: 120 },
        { kind: "SETUP_CLEANING", minutes: 30 },
      ]),
    ).toEqual({ PRODUCTIVE: 120, SETUP_CLEANING: 30, UNSPECIFIED: 345, TRAVEL: 0 });
  });

  it("millisecond precision: the three kinds add up to entryDurations().workingMinutes", () => {
    const ms = {
      startTime: d("2026-03-10T07:58:20.000Z"),
      endTime: d("2026-03-10T16:31:00.000Z"),
      breakMinutes: 37,
    };
    const result = activityMinutes({ ...ms, activityKind: "PRODUCTIVE" }, [
      { kind: "SETUP_CLEANING", minutes: 60 },
    ]);
    const sum = result.PRODUCTIVE + result.SETUP_CLEANING + result.UNSPECIFIED;
    expect(sum).toBeCloseTo(entryDurations(ms).workingMinutes, 9);
    expect(result.SETUP_CLEANING).toBe(60);
  });

  it("shares above the working minutes are reported as-is: the own kind goes below zero, never clamped", () => {
    const result = activityMinutes({ ...entry, activityKind: "PRODUCTIVE" }, [
      { kind: "SETUP_CLEANING", minutes: 500 },
    ]);
    expect(result.PRODUCTIVE).toBe(-5);
    expect(result.SETUP_CLEANING).toBe(500);
  });
});

describe("validateActivityState — kind rules (400)", () => {
  it("rejects an UNSPECIFIED share", () => {
    const r = validateActivityState(
      closed({ shares: [{ kind: "UNSPECIFIED", minutes: 10 }] }),
      ctx,
    );
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it.each([0, -1, 1.5])("rejects a share of %s minutes", (minutes) => {
    const r = validateActivityState(closed({ shares: [{ kind: "SETUP_CLEANING", minutes }] }), ctx);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects a duplicate kind", () => {
    const r = validateActivityState(
      closed({
        kind: "UNSPECIFIED",
        shares: [
          { kind: "SETUP_CLEANING", minutes: 10 },
          { kind: "SETUP_CLEANING", minutes: 20 },
        ],
      }),
      ctx,
    );
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects a share of the entry's own kind", () => {
    const r = validateActivityState(
      closed({ kind: "PRODUCTIVE", shares: [{ kind: "PRODUCTIVE", minutes: 10 }] }),
      ctx,
    );
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("accepts no shares at all", () => {
    expect(validateActivityState(closed(), ctx)).toEqual({ ok: true });
  });
});

describe("validateActivityState — open entries (409)", () => {
  const open = (shares: ActivityState["shares"]) => closed({ endTime: null, shares });
  const share = [{ kind: "SETUP_CLEANING" as const, minutes: 30 }];

  it("shares written now on an open entry → 409", () => {
    const r = validateActivityState(open(share), { sharesWritten: true, wasClosed: false });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("a closed entry being reopened with shares → 409", () => {
    const r = validateActivityState(open(share), { sharesWritten: false, wasClosed: true });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("dormant shares on an already-open entry with nothing written → ok (contribute 0)", () => {
    expect(validateActivityState(open(share), { sharesWritten: false, wasClosed: false })).toEqual({
      ok: true,
    });
  });

  it("empty shares on an open entry → ok", () => {
    expect(validateActivityState(open([]), { sharesWritten: true, wasClosed: true })).toEqual({
      ok: true,
    });
  });
});

describe("validateActivityState — the sum rule (D-05)", () => {
  const SUM_MESSAGE = "Die zugeordnete Tätigkeitszeit übersteigt die Arbeitszeit des Eintrags.";

  it("a share of exactly the working minutes (495 on 495) is fine", () => {
    expect(
      validateActivityState(closed({ shares: [{ kind: "SETUP_CLEANING", minutes: 495 }] }), ctx),
    ).toEqual({ ok: true });
  });

  it("496 on 495 → 409 with the exact message and the limit", () => {
    const r = validateActivityState(
      closed({ shares: [{ kind: "SETUP_CLEANING", minutes: 496 }] }),
      ctx,
    );
    expect(r).toEqual({
      ok: false,
      status: 409,
      body: { error: SUM_MESSAGE, maxShareMinutes: 495 },
    });
  });

  it("500 on 495 → 409, never clamped", () => {
    const r = validateActivityState(
      closed({ shares: [{ kind: "SETUP_CLEANING", minutes: 500 }] }),
      ctx,
    );
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("working 495.6 (millisecond precision): 495 is fine, 496 → 409 with limit 495", () => {
    const ms = closed({ endTime: d("2026-03-10T17:00:36.000Z") });
    expect(
      validateActivityState({ ...ms, shares: [{ kind: "SETUP_CLEANING", minutes: 495 }] }, ctx),
    ).toEqual({ ok: true });
    expect(
      validateActivityState({ ...ms, shares: [{ kind: "SETUP_CLEANING", minutes: 496 }] }, ctx),
    ).toEqual({ ok: false, status: 409, body: { error: SUM_MESSAGE, maxShareMinutes: 495 } });
  });

  it("float noise at the boundary does not reject (exact 495.0000000001 style sums)", () => {
    // 08:00:00.001 -> 17:00:00.001 keeps presence exactly 540; the epsilon guards the division.
    const s = closed({
      startTime: d("2026-03-10T08:00:00.001Z"),
      endTime: d("2026-03-10T17:00:00.001Z"),
      shares: [{ kind: "SETUP_CLEANING", minutes: 495 }],
    });
    expect(validateActivityState(s, ctx)).toEqual({ ok: true });
  });

  it("a negative working time allows no share and reports limit 0", () => {
    const r = validateActivityState(
      closed({ breakMinutes: 600, shares: [{ kind: "SETUP_CLEANING", minutes: 1 }] }),
      ctx,
    );
    expect(r).toMatchObject({ ok: false, status: 409, body: { maxShareMinutes: 0 } });
  });
});

describe("mergeActivityWrite", () => {
  const existing = {
    activityKind: "PRODUCTIVE" as const,
    activityShares: [{ kind: "SETUP_CLEANING" as const, minutes: 45 }],
  };

  it("a body without activity fields keeps the stored kind and shares", () => {
    expect(mergeActivityWrite({}, existing)).toEqual({
      kind: "PRODUCTIVE",
      shares: [{ kind: "SETUP_CLEANING", minutes: 45 }],
      sharesWritten: false,
    });
  });

  it("activityShares [] clears the shares and counts as written", () => {
    expect(mergeActivityWrite({ activityShares: [] }, existing)).toEqual({
      kind: "PRODUCTIVE",
      shares: [],
      sharesWritten: true,
    });
  });

  it("a kind alone keeps the stored shares (a collision is the validator's job)", () => {
    const merged = mergeActivityWrite({ activityKind: "SETUP_CLEANING" }, existing);
    expect(merged).toEqual({
      kind: "SETUP_CLEANING",
      shares: [{ kind: "SETUP_CLEANING", minutes: 45 }],
      sharesWritten: false,
    });
    expect(
      validateActivityState(
        { ...closed(), kind: merged.kind, shares: merged.shares },
        { sharesWritten: merged.sharesWritten, wasClosed: true },
      ),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("without a stored entry (create) the kind defaults to UNSPECIFIED and shares to []", () => {
    expect(mergeActivityWrite({}, null)).toEqual({
      kind: "UNSPECIFIED",
      shares: [],
      sharesWritten: false,
    });
    expect(
      mergeActivityWrite(
        { activityKind: "PRODUCTIVE", activityShares: [{ kind: "SETUP_CLEANING", minutes: 5 }] },
        null,
      ),
    ).toEqual({
      kind: "PRODUCTIVE",
      shares: [{ kind: "SETUP_CLEANING", minutes: 5 }],
      sharesWritten: true,
    });
  });
});

describe("nested-write builders", () => {
  const shares = [{ kind: "SETUP_CLEANING" as const, minutes: 60 }];

  it("activitySharesCreate builds a create list", () => {
    expect(activitySharesCreate(shares)).toEqual({
      create: [{ kind: "SETUP_CLEANING", minutes: 60 }],
    });
  });

  it("activitySharesReplace deletes the stored rows and creates the new list in one nested write", () => {
    expect(activitySharesReplace(shares)).toEqual({
      deleteMany: {},
      create: [{ kind: "SETUP_CLEANING", minutes: 60 }],
    });
    expect(activitySharesReplace([])).toEqual({ deleteMany: {}, create: [] });
  });
});

describe("isActivityOnlyPut (D-20)", () => {
  const stored = {
    date: d("2026-03-10T00:00:00.000Z"),
    startTime: START,
    endTime: END,
    note: null as string | null,
    type: "WORK",
    salonId: "salon-1",
    travelToSalonId: null as string | null,
  };
  const act = { activityKind: "PRODUCTIVE" as const };

  it("an activity field alone is activity-only", () => {
    expect(isActivityOnlyPut(act, stored)).toBe(true);
    expect(isActivityOnlyPut({ activityShares: [] }, stored)).toBe(true);
  });

  it("a body without any activity field is never activity-only", () => {
    expect(isActivityOnlyPut({}, stored)).toBe(false);
    expect(isActivityOnlyPut({ note: "x" }, stored)).toBe(false);
  });

  it("breakMinutes, breaks and grantId confirm a break or consume a grant, even when equal", () => {
    expect(isActivityOnlyPut({ ...act, breakMinutes: 45 }, stored)).toBe(false);
    expect(isActivityOnlyPut({ ...act, breaks: [] }, stored)).toBe(false);
    expect(isActivityOnlyPut({ ...act, grantId: "g" }, stored)).toBe(false);
  });

  it("scalars count only when they differ from the stored value", () => {
    expect(isActivityOnlyPut({ ...act, date: "2026-03-10" }, stored)).toBe(true);
    expect(isActivityOnlyPut({ ...act, date: "2026-03-11" }, stored)).toBe(false);
    expect(isActivityOnlyPut({ ...act, startTime: "2026-03-10T08:00:00Z" }, stored)).toBe(true);
    expect(isActivityOnlyPut({ ...act, startTime: "2026-03-10T08:30:00Z" }, stored)).toBe(false);
    expect(isActivityOnlyPut({ ...act, endTime: "2026-03-10T17:00:00.000Z" }, stored)).toBe(true);
    expect(isActivityOnlyPut({ ...act, endTime: "2026-03-10T16:00:00.000Z" }, stored)).toBe(false);
    expect(isActivityOnlyPut({ ...act, type: "WORK" }, stored)).toBe(true);
    expect(isActivityOnlyPut({ ...act, type: "OVERTIME" }, stored)).toBe(false);
    expect(isActivityOnlyPut({ ...act, salonId: "salon-1" }, stored)).toBe(true);
    expect(isActivityOnlyPut({ ...act, salonId: "salon-2" }, stored)).toBe(false);
  });

  it("endTime null reopens a closed entry, so it is not activity-only; null on an open one is", () => {
    expect(isActivityOnlyPut({ ...act, endTime: null }, stored)).toBe(false);
    expect(isActivityOnlyPut({ ...act, endTime: null }, { ...stored, endTime: null })).toBe(true);
  });

  it("note null against a stored null is unchanged, a different note is not", () => {
    expect(isActivityOnlyPut({ ...act, note: null }, stored)).toBe(true);
    expect(isActivityOnlyPut({ ...act, note: "x" }, stored)).toBe(false);
    expect(isActivityOnlyPut({ ...act, note: null }, { ...stored, note: "x" })).toBe(false);
    expect(isActivityOnlyPut({ ...act, note: "x" }, { ...stored, note: "x" })).toBe(true);
  });
});

describe("materializeRemainder (D-07)", () => {
  const morning = (over: Partial<ActivityState> = {}): ActivityState => ({
    kind: "PRODUCTIVE",
    shares: [{ kind: "SETUP_CLEANING", minutes: 60 }],
    startTime: d("2026-03-10T08:00:00.000Z"),
    endTime: d("2026-03-10T12:00:00.000Z"),
    breakMinutes: 0,
    ...over,
  });

  it("turns the classified remainder into a share and sets the kind to UNSPECIFIED", () => {
    expect(materializeRemainder(morning())).toEqual({
      kind: "UNSPECIFIED",
      shares: [
        { kind: "SETUP_CLEANING", minutes: 60 },
        { kind: "PRODUCTIVE", minutes: 180 },
      ],
    });
  });

  it("returns null for an UNSPECIFIED entry and for an open entry", () => {
    expect(materializeRemainder(morning({ kind: "UNSPECIFIED" }))).toBeNull();
    expect(materializeRemainder(morning({ endTime: null }))).toBeNull();
  });

  it("floors a fractional remainder to whole minutes", () => {
    // 239.6 working minutes, no shares.
    const r = materializeRemainder(
      morning({
        kind: "SETUP_CLEANING",
        shares: [],
        endTime: d("2026-03-10T11:59:36.000Z"),
      }),
    );
    expect(r).toEqual({ kind: "UNSPECIFIED", shares: [{ kind: "SETUP_CLEANING", minutes: 239 }] });
  });

  it("drops a remainder below one minute but still unclassifies the entry", () => {
    const r = materializeRemainder(morning({ shares: [{ kind: "SETUP_CLEANING", minutes: 240 }] }));
    expect(r).toEqual({ kind: "UNSPECIFIED", shares: [{ kind: "SETUP_CLEANING", minutes: 240 }] });
  });

  it("the result always passes the validator on the closed state", () => {
    for (const state of [
      morning(),
      morning({ shares: [] }),
      morning({ kind: "SETUP_CLEANING", shares: [{ kind: "PRODUCTIVE", minutes: 17 }] }),
    ]) {
      const r = materializeRemainder(state)!;
      expect(
        validateActivityState(
          { ...state, kind: r.kind, shares: r.shares },
          { sharesWritten: true, wasClosed: true },
        ),
      ).toEqual({ ok: true });
    }
  });
});
