/**
 * Issue #568 — DB-free unit tests of the pure bulk-apply module: the effective-date window, the
 * classifier (precedence, numeric equality), the merge over the stored defaults, the schedule-row
 * builder and the fingerprint (stable under reordering and Decimal-vs-number, sensitive to every
 * single input).
 */
import { describe, it, expect } from "vitest";
import {
  BulkApplyRejection,
  SCHEMA_WORKING_TIME_DEFAULTS,
  bulkApplyFingerprint,
  bulkScheduleData,
  checkBulkSelection,
  checkEffectiveFrom,
  classifyBulkApplyCandidates,
  effectiveFromWindow,
  mergeProposedDefaults,
  storedWorkingTimeDefaults,
  type BulkEmployeeInput,
  type BulkScheduleRow,
  type WorkingTimeDefaults,
} from "../bulk-apply-defaults";
import { MONTH_FIRST_ERROR } from "../month-first-date";

const utc = (s: string) => new Date(`${s}T00:00:00Z`);

/** A Prisma-Decimal stand-in: serialises as a string, converts through Number(). */
function dec(n: number | string) {
  return {
    toString: () => String(n),
    valueOf: () => Number(n),
    toNumber: () => Number(n),
  };
}

const STORED: WorkingTimeDefaults = { ...SCHEMA_WORKING_TIME_DEFAULTS };
const EFFECTIVE = "2026-11-01";
const TZ = "Europe/Berlin";

function row(over: Partial<BulkScheduleRow> & { id: string }): BulkScheduleRow {
  return {
    type: "FIXED_SCHEDULE",
    validFrom: utc("2024-01-01"),
    weeklyHours: 40,
    mondayHours: 8,
    tuesdayHours: 8,
    wednesdayHours: 8,
    thursdayHours: 8,
    fridayHours: 8,
    saturdayHours: 0,
    sundayHours: 0,
    overtimeThreshold: 60,
    allowOvertimePayout: false,
    workDays: [1, 2, 3, 4, 5],
    overtimeMode: "CARRY_FORWARD",
    maxNegativeBalanceMinutes: null,
    ...over,
  };
}

function individual16(id: string): BulkScheduleRow {
  return row({
    id,
    weeklyHours: 16,
    mondayHours: 4,
    tuesdayHours: 4,
    wednesdayHours: 4,
    thursdayHours: 4,
    fridayHours: 0,
    workDays: [1, 2, 3, 4],
  });
}

function emp(id: string, rows: BulkScheduleRow[], last = id): BulkEmployeeInput {
  return { id, firstName: "F", lastName: last, employeeNumber: `N-${id}`, workSchedules: rows };
}

// The proposal differs from the stored defaults so ALREADY_MATCHES_NEW and MATCHES_DEFAULTS are distinct.
const PROPOSED: WorkingTimeDefaults = {
  ...STORED,
  defaultWeeklyHours: 38,
  defaultFridayHours: 6,
};

function classify(employees: BulkEmployeeInput[], proposed = PROPOSED, stored = STORED) {
  return classifyBulkApplyCandidates({
    employees,
    stored,
    proposed,
    effectiveFrom: EFFECTIVE,
    timeZone: TZ,
  });
}

describe("effectiveFromWindow", () => {
  it("mid-month: earliest is the 1st of next month, 12 allowed months", () => {
    const w = effectiveFromWindow(utc("2026-10-13"));
    expect(w.earliest).toBe("2026-11-01");
    expect(w.latest).toBe("2027-10-01");
    expect(w.allowed).toHaveLength(12);
    expect(w.allowed[0]).toBe("2026-11-01");
    expect(w.allowed[11]).toBe("2027-10-01");
  });

  it("on the 1st: earliest is today, 13 allowed months", () => {
    const w = effectiveFromWindow(utc("2026-11-01"));
    expect(w.earliest).toBe("2026-11-01");
    expect(w.latest).toBe("2027-11-01");
    expect(w.allowed).toHaveLength(13);
  });

  it("year rollover", () => {
    expect(effectiveFromWindow(utc("2026-12-20")).earliest).toBe("2027-01-01");
  });
});

describe("checkEffectiveFrom", () => {
  const today = utc("2026-10-13");

  it("rejects a non-month-first with the month-first message", () => {
    const r = checkEffectiveFrom("2026-11-15", today);
    expect(r).toBeInstanceOf(BulkApplyRejection);
    expect(r?.status).toBe(400);
    expect(r?.code).toBe("BULK_APPLY_NOT_MONTH_FIRST");
    expect(r?.message).toBe(MONTH_FIRST_ERROR);
  });

  it("rejects an impossible calendar day as not-month-first", () => {
    expect(checkEffectiveFrom("2026-13-01", today)?.code).toBe("BULK_APPLY_NOT_MONTH_FIRST");
  });

  it("rejects the 1st of the current month as retroactive", () => {
    const r = checkEffectiveFrom("2026-10-01", today);
    expect(r?.status).toBe(400);
    expect(r?.code).toBe("BULK_APPLY_RETROACTIVE");
    expect(r?.message).toContain("01.11.2026");
  });

  it("rejects one month past the latest as too far", () => {
    const r = checkEffectiveFrom("2027-11-01", today);
    expect(r?.status).toBe(400);
    expect(r?.code).toBe("BULK_APPLY_TOO_FAR");
  });

  it("accepts the earliest and the latest", () => {
    expect(checkEffectiveFrom("2026-11-01", today)).toBeNull();
    expect(checkEffectiveFrom("2027-10-01", today)).toBeNull();
  });

  it("accepts today when today is the 1st", () => {
    expect(checkEffectiveFrom("2026-11-01", utc("2026-11-01"))).toBeNull();
    expect(checkEffectiveFrom("2026-10-01", utc("2026-11-01"))?.code).toBe(
      "BULK_APPLY_RETROACTIVE",
    );
  });
});

describe("mergeProposedDefaults / storedWorkingTimeDefaults", () => {
  it("no config row means the schema defaults", () => {
    expect(storedWorkingTimeDefaults(null)).toEqual({
      defaultWeeklyHours: 40,
      defaultMondayHours: 8,
      defaultTuesdayHours: 8,
      defaultWednesdayHours: 8,
      defaultThursdayHours: 8,
      defaultFridayHours: 8,
      defaultSaturdayHours: 0,
      defaultSundayHours: 0,
      overtimeThreshold: 60,
      allowOvertimePayout: false,
      defaultWorkDays: [1, 2, 3, 4, 5],
    });
  });

  it("converts Decimal-like stored values to plain numbers", () => {
    const stored = storedWorkingTimeDefaults({
      defaultWeeklyHours: dec("38.00"),
      defaultMondayHours: dec("7.60"),
      defaultTuesdayHours: dec("7.60"),
      defaultWednesdayHours: dec("7.60"),
      defaultThursdayHours: dec("7.60"),
      defaultFridayHours: dec("7.60"),
      defaultSaturdayHours: dec("0.00"),
      defaultSundayHours: dec("0.00"),
      overtimeThreshold: dec("60.00"),
      allowOvertimePayout: true,
      defaultWorkDays: [1, 2, 3, 4, 5],
    });
    expect(stored.defaultWeeklyHours).toBe(38);
    expect(stored.defaultMondayHours).toBe(7.6);
    expect(stored.allowOvertimePayout).toBe(true);
  });

  it("an omitted key keeps the STORED value", () => {
    const merged = mergeProposedDefaults(
      { ...STORED, defaultWeeklyHours: 35, allowOvertimePayout: true },
      { defaultMondayHours: 7 },
    );
    expect(merged.defaultWeeklyHours).toBe(35);
    expect(merged.allowOvertimePayout).toBe(true);
    expect(merged.defaultMondayHours).toBe(7);
  });

  it("derives after.workDays from the per-day hours, falling back to the proposed defaultWorkDays", () => {
    const c = classify([emp("e1", [])], { ...STORED, defaultFridayHours: 0 }).candidates[0];
    expect(c.after.workDays).toEqual([1, 2, 3, 4]);
    const allZero = classify([emp("e1", [])], {
      ...STORED,
      defaultMondayHours: 0,
      defaultTuesdayHours: 0,
      defaultWednesdayHours: 0,
      defaultThursdayHours: 0,
      defaultFridayHours: 0,
      defaultWorkDays: [2, 4],
    }).candidates[0];
    expect(allZero.after.workDays).toEqual([2, 4]);
  });
});

describe("classifyBulkApplyCandidates", () => {
  it("an individual 16 h contract is INDIVIDUAL and not selected by default", () => {
    const [c] = classify([emp("a", [individual16("r1")])]).candidates;
    expect(c.category).toBe("INDIVIDUAL");
    expect(c.defaultSelected).toBe(false);
    expect(c.before?.weeklyHours).toBe(16);
    expect(c.before?.workDays).toEqual([1, 2, 3, 4]);
    expect(c.before?.type).toBe("FIXED_SCHEDULE");
    expect(c.after.weeklyHours).toBe(38);
  });

  it("a contract equal to the stored defaults is MATCHES_DEFAULTS and selected", () => {
    const [c] = classify([emp("a", [row({ id: "r1" })])]).candidates;
    expect(c.category).toBe("MATCHES_DEFAULTS");
    expect(c.defaultSelected).toBe(true);
  });

  it("compares numerically with 2 decimals on both sides (Decimal '40.00' vs 40, 7.555 vs 7.56)", () => {
    const decimalRow = row({
      id: "r1",
      weeklyHours: dec("40.00"),
      mondayHours: dec("8.00"),
      tuesdayHours: dec("8.00"),
      wednesdayHours: dec("8.00"),
      thursdayHours: dec("8.00"),
      fridayHours: dec("8.00"),
      saturdayHours: dec("0.00"),
      sundayHours: dec("0.00"),
      overtimeThreshold: dec("60.00"),
    });
    expect(classify([emp("a", [decimalRow])]).candidates[0].category).toBe("MATCHES_DEFAULTS");

    const stored: WorkingTimeDefaults = { ...STORED, defaultMondayHours: 7.555 };
    const matching = row({ id: "r2", mondayHours: dec("7.56") });
    expect(classify([emp("b", [matching])], PROPOSED, stored).candidates[0].category).toBe(
      "MATCHES_DEFAULTS",
    );
  });

  it("a legacy null weeklyHours is INDIVIDUAL, never 0", () => {
    const [c] = classify([emp("a", [row({ id: "r1", weeklyHours: null })])]).candidates;
    expect(c.category).toBe("INDIVIDUAL");
    expect(c.before?.weeklyHours).toBeNull();
  });

  it("an employee without any contract is NO_CONTRACT, selected, before null", () => {
    const [c] = classify([emp("a", [])]).candidates;
    expect(c.category).toBe("NO_CONTRACT");
    expect(c.defaultSelected).toBe(true);
    expect(c.before).toBeNull();
    expect(c.comparedRow).toBeNull();
  });

  it("a later row wins over the valid-at model: FUTURE_CONTRACT even when valid-at is MONTHLY_HOURS", () => {
    const result = classify([
      emp("a", [
        row({ id: "r1", type: "MONTHLY_HOURS", validFrom: utc("2026-01-01") }),
        row({ id: "r2", validFrom: utc("2027-01-01") }),
      ]),
    ]);
    expect(result.candidates).toHaveLength(0);
    expect(result.nonCandidates).toEqual([
      {
        reason: "FUTURE_CONTRACT",
        count: 1,
        employees: [{ employeeId: "a", name: "F a", employeeNumber: "N-a" }],
      },
    ]);
  });

  it("a MONTHLY_HOURS row exactly at effectiveFrom is SAME_MONTH_MODEL_SWITCH", () => {
    const r = classify([
      emp("a", [
        row({ id: "r1" }),
        row({ id: "r2", type: "MONTHLY_HOURS", validFrom: utc(EFFECTIVE) }),
      ]),
    ]);
    expect(r.nonCandidates.map((g) => g.reason)).toEqual(["SAME_MONTH_MODEL_SWITCH"]);
  });

  it("a FIXED row exactly at effectiveFrom is CONTRACT_AT_DATE_EXISTS", () => {
    const r = classify([emp("a", [row({ id: "r1", validFrom: utc(EFFECTIVE) })])]);
    expect(r.nonCandidates.map((g) => g.reason)).toEqual(["CONTRACT_AT_DATE_EXISTS"]);
  });

  it.each(["SHIFT_BASED", "FLEXTIME", "MONTHLY_HOURS"])(
    "a valid-at %s contract is OTHER_SCHEDULE_TYPE",
    (type) => {
      const r = classify([emp("a", [row({ id: "r1", type })])]);
      expect(r.nonCandidates.map((g) => g.reason)).toEqual(["OTHER_SCHEDULE_TYPE"]);
    },
  );

  it("a contract equal to the PROPOSED values is ALREADY_MATCHES_NEW", () => {
    const r = classify([emp("a", [row({ id: "r1", weeklyHours: 38, fridayHours: 6 })])]);
    expect(r.nonCandidates.map((g) => g.reason)).toEqual(["ALREADY_MATCHES_NEW"]);
  });

  it("with several rows the latest row valid at effectiveFrom is the compared row", () => {
    const rows = [
      row({ id: "old", validFrom: utc("2023-01-01") }),
      individual16("mid"),
      row({
        id: "new",
        validFrom: utc("2026-05-01"),
        weeklyHours: 20,
        mondayHours: 4,
        tuesdayHours: 4,
        wednesdayHours: 4,
        thursdayHours: 4,
        fridayHours: 4,
      }),
    ];
    rows[1].validFrom = utc("2025-01-01");
    const [c] = classify([emp("a", rows)]).candidates;
    expect(c.comparedRow?.id).toBe("new");
    expect(c.before?.weeklyHours).toBe(20);
  });

  // Review WR-01: `validFrom` is an instant. A hire contract of 1 Nov (Europe/Berlin) can be stored
  // as 2026-10-31T23:00:00Z; compared by UTC day it would look like an October contract.
  describe("tenant-local calendar day of validFrom (WR-01)", () => {
    const localMidnight = new Date("2026-10-31T23:00:00Z"); // = 2026-11-01 00:00 Europe/Berlin

    it("a FIXED contract at the local midnight of effectiveFrom is CONTRACT_AT_DATE_EXISTS, not a candidate", () => {
      const r = classify([emp("a", [row({ id: "r1", validFrom: localMidnight })])]);
      expect(r.candidates).toHaveLength(0);
      expect(r.nonCandidates.map((g) => g.reason)).toEqual(["CONTRACT_AT_DATE_EXISTS"]);
    });

    it("a MONTHLY_HOURS contract at the local midnight of effectiveFrom is SAME_MONTH_MODEL_SWITCH", () => {
      const r = classify([
        emp("a", [
          row({ id: "r1" }),
          row({ id: "r2", type: "MONTHLY_HOURS", validFrom: localMidnight }),
        ]),
      ]);
      expect(r.nonCandidates.map((g) => g.reason)).toEqual(["SAME_MONTH_MODEL_SWITCH"]);
    });

    it("a contract at the local midnight of the NEXT month is FUTURE_CONTRACT", () => {
      const r = classify([
        emp("a", [row({ id: "r1", validFrom: new Date("2026-11-30T23:00:00Z") })]),
      ]);
      expect(r.nonCandidates.map((g) => g.reason)).toEqual(["FUTURE_CONTRACT"]);
    });

    it("a contract at 2026-11-01T00:00Z (still 1 Nov local) is at the date, not before it", () => {
      const r = classify([emp("a", [row({ id: "r1", validFrom: utc("2026-11-01") })])]);
      expect(r.nonCandidates.map((g) => g.reason)).toEqual(["CONTRACT_AT_DATE_EXISTS"]);
    });

    it("a contract at the local midnight of the previous month-first is valid at effectiveFrom", () => {
      const [c] = classify([
        emp("a", [row({ id: "r1", validFrom: new Date("2026-09-30T22:00:00Z") })]),
      ]).candidates;
      expect(c.comparedRow?.id).toBe("r1");
      expect(c.before?.validFrom).toBe("2026-10-01");
    });

    it("the same instant is a different local day in another timezone", () => {
      const r = classifyBulkApplyCandidates({
        employees: [emp("a", [row({ id: "r1", validFrom: localMidnight })])],
        stored: STORED,
        proposed: PROPOSED,
        effectiveFrom: EFFECTIVE,
        timeZone: "UTC",
      });
      expect(r.candidates).toHaveLength(1);
      expect(r.candidates[0].before?.validFrom).toBe("2026-10-31");
    });
  });

  // Review IN-01: workDays is part of the contract terms (Phase 95b: divergent legacy rows are never
  // silently "corrected").
  describe("workDays are compared as a set (IN-01)", () => {
    const divergentFriday = (id: string) =>
      // day-hours say Mo-Fr 8 h (= the stored defaults) but the legacy workDays dropped Friday
      row({ id, workDays: [1, 2, 3, 4] });

    it("a row with default hours but divergent workDays is INDIVIDUAL, not pre-ticked", () => {
      const [c] = classify([emp("a", [divergentFriday("r1")])]).candidates;
      expect(c.category).toBe("INDIVIDUAL");
      expect(c.defaultSelected).toBe(false);
    });

    it("a row with the proposed hours but divergent workDays is never ALREADY_MATCHES_NEW", () => {
      const r = classify([
        emp("a", [row({ id: "r1", weeklyHours: 38, fridayHours: 6, workDays: [1, 2, 3, 4] })]),
      ]);
      expect(r.nonCandidates).toEqual([]);
      expect(r.candidates).toHaveLength(1);
      expect(r.candidates[0].category).toBe("INDIVIDUAL");
    });

    it("the order and duplicates of workDays do not matter", () => {
      const [c] = classify([
        emp("a", [row({ id: "r1", workDays: [5, 4, 3, 2, 1, 1] })]),
      ]).candidates;
      expect(c.category).toBe("MATCHES_DEFAULTS");
      const r = classify([
        emp("b", [row({ id: "r2", weeklyHours: 38, fridayHours: 6, workDays: [5, 3, 1, 2, 4] })]),
      ]);
      expect(r.nonCandidates.map((g) => g.reason)).toEqual(["ALREADY_MATCHES_NEW"]);
    });

    it("the defaults' workDays are derived from the default day-hours, like the write does", () => {
      const stored: WorkingTimeDefaults = {
        ...STORED,
        defaultFridayHours: 0,
        defaultWeeklyHours: 32,
      };
      const matching = row({
        id: "r1",
        weeklyHours: 32,
        fridayHours: 0,
        workDays: [1, 2, 3, 4],
      });
      expect(classify([emp("a", [matching])], PROPOSED, stored).candidates[0].category).toBe(
        "MATCHES_DEFAULTS",
      );
    });
  });

  it("groups appear in precedence order, sorted candidates by last name", () => {
    const r = classify([
      emp("z", [row({ id: "z1", type: "SHIFT_BASED" })], "Zed"),
      emp("y", [row({ id: "y1", validFrom: utc("2027-01-01") })], "Why"),
      emp("c", [], "Bee"),
      emp("d", [], "Ay"),
    ]);
    expect(r.nonCandidates.map((g) => g.reason)).toEqual([
      "FUTURE_CONTRACT",
      "OTHER_SCHEDULE_TYPE",
    ]);
    expect(r.candidates.map((c) => c.employeeId)).toEqual(["d", "c"]);
  });
});

describe("bulkScheduleData", () => {
  it("carries overtimeMode and maxNegativeBalanceMinutes over from the compared row", () => {
    const data = bulkScheduleData(
      PROPOSED,
      EFFECTIVE,
      row({ id: "r1", overtimeMode: "TRACK_ONLY", maxNegativeBalanceMinutes: 600 }),
    );
    expect(data.type).toBe("FIXED_SCHEDULE");
    expect(data.overtimeMode).toBe("TRACK_ONLY");
    expect(data.maxNegativeBalanceMinutes).toBe(600);
    expect(data.weeklyHours).toBe(38);
    expect(data.fridayHours).toBe(6);
    expect(data.validFrom.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("leaves the column defaults when there is no compared row", () => {
    const data = bulkScheduleData(PROPOSED, EFFECTIVE, null);
    expect("overtimeMode" in data).toBe(false);
    expect("maxNegativeBalanceMinutes" in data).toBe(false);
  });
});

describe("bulkApplyFingerprint", () => {
  const base = () => [emp("a", [individual16("ra")]), emp("b", [row({ id: "rb" })]), emp("c", [])];
  function fp(
    employees: BulkEmployeeInput[],
    over: {
      tenantId?: string;
      effectiveFrom?: string;
      stored?: WorkingTimeDefaults;
      proposed?: WorkingTimeDefaults;
    } = {},
  ) {
    const stored = over.stored ?? STORED;
    const proposed = over.proposed ?? PROPOSED;
    const effectiveFrom = over.effectiveFrom ?? EFFECTIVE;
    const classification = classifyBulkApplyCandidates({
      employees,
      stored,
      proposed,
      effectiveFrom,
      timeZone: TZ,
    });
    return bulkApplyFingerprint({
      tenantId: over.tenantId ?? "tenant-1",
      effectiveFrom,
      stored,
      proposed,
      classification,
    });
  }

  it("is 64 lowercase hex", () => {
    expect(fp(base())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for shuffled employee order", () => {
    expect(fp([...base()].reverse())).toBe(fp(base()));
  });

  it("is stable for Decimal-string vs number inputs", () => {
    const asDecimal = base();
    asDecimal[1].workSchedules[0] = row({
      id: "rb",
      weeklyHours: dec("40.00"),
      mondayHours: dec("8.00"),
      overtimeThreshold: dec("60.00"),
    });
    expect(fp(asDecimal)).toBe(fp(base()));
  });

  it("changes when any single input changes", () => {
    const reference = fp(base());
    const variants: Record<string, string> = {
      tenantId: fp(base(), { tenantId: "tenant-2" }),
      effectiveFrom: fp(base(), { effectiveFrom: "2026-12-01" }),
      storedDefault: fp(base(), { stored: { ...STORED, overtimeThreshold: 61 } }),
      proposedValue: fp(base(), { proposed: { ...PROPOSED, defaultMondayHours: 7 } }),
      addedEmployee: fp([...base(), emp("d", [])]),
      category: fp([emp("a", [row({ id: "ra" })]), emp("b", [row({ id: "rb" })]), emp("c", [])]),
      comparedRowId: fp([
        emp("a", [individual16("ra-other")]),
        emp("b", [row({ id: "rb" })]),
        emp("c", []),
      ]),
      comparedRowValues: fp([
        emp("a", [{ ...individual16("ra"), overtimeThreshold: 55 }]),
        emp("b", [row({ id: "rb" })]),
        emp("c", []),
      ]),
    };
    for (const [name, value] of Object.entries(variants)) {
      expect(value, name).not.toBe(reference);
    }
    expect(new Set(Object.values(variants)).size).toBe(Object.keys(variants).length);
  });
});

describe("checkBulkSelection", () => {
  it("accepts ids inside the candidate set", () => {
    expect(checkBulkSelection([{ employeeId: "a" }, { employeeId: "b" }], ["a"])).toBeNull();
  });

  it("refuses an id outside the set with 409 BULK_APPLY_PREVIEW_STALE", () => {
    const r = checkBulkSelection([{ employeeId: "a" }], ["a", "x"]);
    expect(r?.status).toBe(409);
    expect(r?.code).toBe("BULK_APPLY_PREVIEW_STALE");
    expect(r?.message).toContain("Vorschau");
  });
});
