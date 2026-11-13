// Issue #854 (plan 854-07) - the pure half of the Arbeitszeit sections: what a section shows from a stored
// configuration, which messages its fields carry and what its save puts on the wire.
import { describe, expect, it } from "vitest";

import {
  breaksFrom,
  breaksMessages,
  breaksWire,
  complianceFrom,
  complianceWire,
  coreHoursFrom,
  coreHoursMessages,
  coreHoursWire,
  defaultHoursComparable,
  defaultHoursFrom,
  defaultHoursMessages,
  defaultHoursWire,
  maxNegativeFrom,
  maxNegativeMessages,
  maxNegativeWire,
  messageCount,
  minutesAsHours,
  openEntriesFrom,
  openEntriesMessages,
  openEntriesWire,
  retroFrom,
  retroMessages,
  retroWire,
  toggleDay,
  vocationalSlotsFrom,
  vocationalSlotsMessages,
  vocationalSlotsWire,
  weeklyHoursOf,
  workDaysFrom,
  workDaysMessages,
  workDaysWire,
  type BreaksValues,
} from "$lib/settings/arbeitszeit";
import { settingsSection } from "$lib/settings/settings-pages";

const STORED: BreaksValues = {
  autoBreakEnabled: true,
  defaultBreakStart: "12:30",
  defaultBreakOver6h: 30,
  defaultBreakOver9h: 45,
  enforceBreakConfirmation: false,
};

describe("Pausen", () => {
  it("reads the stored values and falls back to the ArbZG floor and the switched-off state", () => {
    expect(breaksFrom({})).toEqual({
      autoBreakEnabled: false,
      defaultBreakStart: "12:00",
      defaultBreakOver6h: 30,
      defaultBreakOver9h: 45,
      enforceBreakConfirmation: false,
    });
    expect(
      breaksFrom({
        autoBreakEnabled: true,
        defaultBreakStart: "13:15",
        defaultBreakOver6h: 40,
        defaultBreakOver9h: 60,
        enforceBreakConfirmation: true,
      }),
    ).toEqual({
      autoBreakEnabled: true,
      defaultBreakStart: "13:15",
      defaultBreakOver6h: 40,
      defaultBreakOver9h: 60,
      enforceBreakConfirmation: true,
    });
    // A stored null start (switched off) shows the default again.
    expect(breaksFrom({ defaultBreakStart: null }).defaultBreakStart).toBe("12:00");
  });

  it("a stored configuration has no message", () => {
    expect(messageCount(breaksMessages(STORED))).toBe(0);
  });

  it("flags minutes outside the bounds of the old page (30..120 and 45..180) and empty fields", () => {
    expect(breaksMessages({ ...STORED, defaultBreakOver6h: 29 }).defaultBreakOver6h).toContain(
      "30",
    );
    expect(breaksMessages({ ...STORED, defaultBreakOver6h: 121 }).defaultBreakOver6h).toContain(
      "120",
    );
    expect(breaksMessages({ ...STORED, defaultBreakOver9h: 44 }).defaultBreakOver9h).toContain(
      "45",
    );
    expect(breaksMessages({ ...STORED, defaultBreakOver9h: 181 }).defaultBreakOver9h).toContain(
      "180",
    );
    expect(breaksMessages({ ...STORED, defaultBreakOver6h: null }).defaultBreakOver6h).toBeTruthy();
    expect(breaksMessages({ ...STORED, defaultBreakOver9h: null }).defaultBreakOver9h).toBeTruthy();
    expect(
      messageCount(breaksMessages({ ...STORED, defaultBreakOver6h: 10, defaultBreakOver9h: 10 })),
    ).toBe(2);
  });

  it("checks the start time only while the automatic deduction is on", () => {
    expect(breaksMessages({ ...STORED, defaultBreakStart: "" }).defaultBreakStart).toBeTruthy();
    expect(
      breaksMessages({ ...STORED, autoBreakEnabled: false, defaultBreakStart: "" })
        .defaultBreakStart,
    ).toBeUndefined();
  });

  it("the wire body carries exactly the five keys of the registry section", () => {
    expect(Object.keys(breaksWire(STORED)).sort()).toEqual(
      [...settingsSection("arbeitszeit-pausen").keys].sort(),
    );
  });

  it("switching the deduction off clears the start time; minutes are whole numbers", () => {
    expect(breaksWire({ ...STORED, autoBreakEnabled: false }).defaultBreakStart).toBeNull();
    expect(breaksWire(STORED).defaultBreakStart).toBe("12:30");
    const wire = breaksWire({ ...STORED, defaultBreakOver6h: 40.9, defaultBreakOver9h: 60.2 });
    expect(wire.defaultBreakOver6h).toBe(40);
    expect(wire.defaultBreakOver9h).toBe(60);
  });
});

describe("messageCount", () => {
  it("counts non-empty messages only", () => {
    expect(messageCount({})).toBe(0);
    expect(messageCount({ a: "x", b: undefined, c: "" })).toBe(1);
  });
});

describe("Rückwirkende Einträge", () => {
  it("defaults to 10 days and accepts 1..90 whole days", () => {
    expect(retroFrom({})).toEqual({ retroEntryWindowDays: 10 });
    expect(retroFrom({ retroEntryWindowDays: 7 })).toEqual({ retroEntryWindowDays: 7 });
    for (const days of [1, 10, 90]) {
      expect(messageCount(retroMessages({ retroEntryWindowDays: days }))).toBe(0);
    }
    for (const days of [0, 91, null]) {
      expect(messageCount(retroMessages({ retroEntryWindowDays: days }))).toBe(1);
    }
  });

  it("sends a whole number under the registry key", () => {
    expect(retroWire({ retroEntryWindowDays: 14.7 })).toEqual({ retroEntryWindowDays: 14 });
    expect(Object.keys(retroWire({ retroEntryWindowDays: 5 }))).toEqual(
      settingsSection("arbeitszeit-rueckwirkend").keys,
    );
  });
});

describe("Arbeitstage", () => {
  it("falls back to Mo-Fr for a missing or empty stored set", () => {
    expect(workDaysFrom({})).toEqual({ defaultWorkDays: [1, 2, 3, 4, 5] });
    expect(workDaysFrom({ defaultWorkDays: [] })).toEqual({ defaultWorkDays: [1, 2, 3, 4, 5] });
    expect(workDaysFrom({ defaultWorkDays: [1, 2, 3, 4, 6] })).toEqual({
      defaultWorkDays: [1, 2, 3, 4, 6],
    });
  });

  it("toggleDay keeps the index array ascending (0 = Sonntag first)", () => {
    expect(toggleDay([1, 2, 3], 0)).toEqual([0, 1, 2, 3]);
    expect(toggleDay([1, 2, 3], 2)).toEqual([1, 3]);
    expect(toggleDay([], 6)).toEqual([6]);
  });

  it("needs at least one day and sends the sorted array", () => {
    expect(workDaysMessages({ defaultWorkDays: [] }).defaultWorkDays).toBeTruthy();
    expect(messageCount(workDaysMessages({ defaultWorkDays: [3] }))).toBe(0);
    expect(workDaysWire({ defaultWorkDays: [5, 1, 0] })).toEqual({ defaultWorkDays: [0, 1, 5] });
    expect(Object.keys(workDaysWire({ defaultWorkDays: [1] }))).toEqual(
      settingsSection("arbeitszeit-arbeitstage").keys,
    );
  });
});

describe("Gleitzeit", () => {
  it("reads empty times as empty strings and copies the days", () => {
    expect(coreHoursFrom({})).toEqual({
      defaultCoreStart: "",
      defaultCoreEnd: "",
      defaultCoreDays: [],
    });
    expect(
      coreHoursFrom({
        defaultCoreStart: "09:00",
        defaultCoreEnd: "15:00",
        defaultCoreDays: [1, 2],
      }),
    ).toEqual({ defaultCoreStart: "09:00", defaultCoreEnd: "15:00", defaultCoreDays: [1, 2] });
  });

  it("mirrors the server rules: both times or none, the end after the begin", () => {
    const base = { defaultCoreDays: [] };
    expect(
      messageCount(coreHoursMessages({ ...base, defaultCoreStart: "", defaultCoreEnd: "" })),
    ).toBe(0);
    expect(
      messageCount(
        coreHoursMessages({ ...base, defaultCoreStart: "09:00", defaultCoreEnd: "15:00" }),
      ),
    ).toBe(0);
    expect(
      coreHoursMessages({ ...base, defaultCoreStart: "09:00", defaultCoreEnd: "" }).defaultCoreEnd,
    ).toBeTruthy();
    expect(
      coreHoursMessages({ ...base, defaultCoreStart: "", defaultCoreEnd: "15:00" })
        .defaultCoreStart,
    ).toBeTruthy();
    expect(
      coreHoursMessages({ ...base, defaultCoreStart: "15:00", defaultCoreEnd: "15:00" })
        .defaultCoreEnd,
    ).toBeTruthy();
  });

  it("sends null for an empty time", () => {
    const wire = coreHoursWire({
      defaultCoreStart: "",
      defaultCoreEnd: "",
      defaultCoreDays: [3, 1],
    });
    expect(wire).toEqual({ defaultCoreStart: null, defaultCoreEnd: null, defaultCoreDays: [1, 3] });
    expect(Object.keys(wire).sort()).toEqual(
      [...settingsSection("arbeitszeit-gleitzeit").keys].sort(),
    );
  });
});

describe("Berufsschule", () => {
  const EMPTY = vocationalSlotsFrom({});

  it("an unset company value is null (inherited)", () => {
    expect(EMPTY).toEqual({
      bsSlotFirstLongDayMinutes: null,
      bsSlotSecondLongDayMinutes: null,
      bsSlotShortDayMinutes: null,
      bsSlotBlockWeekMinutes: null,
    });
    expect(vocationalSlotsFrom({ bsSlotShortDayMinutes: 300 }).bsSlotShortDayMinutes).toBe(300);
  });

  it("empty fields are valid; filled ones must be whole numbers inside 240..600 (week 1200..3000)", () => {
    expect(messageCount(vocationalSlotsMessages(EMPTY))).toBe(0);
    expect(
      messageCount(
        vocationalSlotsMessages({
          bsSlotFirstLongDayMinutes: 240,
          bsSlotSecondLongDayMinutes: 600,
          bsSlotShortDayMinutes: 360,
          bsSlotBlockWeekMinutes: 3000,
        }),
      ),
    ).toBe(0);
    const bad = vocationalSlotsMessages({
      bsSlotFirstLongDayMinutes: 239,
      bsSlotSecondLongDayMinutes: 601,
      bsSlotShortDayMinutes: 300.5,
      bsSlotBlockWeekMinutes: 1199,
    });
    expect(messageCount(bad)).toBe(4);
    expect(bad.bsSlotShortDayMinutes).toContain("ganze Zahl");
    expect(bad.bsSlotBlockWeekMinutes).toContain("1200");
  });

  it("an empty field sends an explicit null that clears the company value", () => {
    const wire = vocationalSlotsWire({ ...EMPTY, bsSlotShortDayMinutes: 300 });
    expect(wire).toEqual({
      bsSlotFirstLongDayMinutes: null,
      bsSlotSecondLongDayMinutes: null,
      bsSlotShortDayMinutes: 300,
      bsSlotBlockWeekMinutes: null,
    });
    expect(Object.keys(wire).sort()).toEqual(
      [...settingsSection("arbeitszeit-berufsschule").keys].sort(),
    );
  });

  it("shows minutes as German hours", () => {
    expect(minutesAsHours(480)).toBe("= 8 h");
    expect(minutesAsHours(450)).toBe("= 7,5 h");
    expect(minutesAsHours(null)).toBe("");
  });
});

describe("Standard-Arbeitszeit", () => {
  const STORED = {
    defaultMondayHours: "8.00",
    defaultTuesdayHours: "8.00",
    defaultWednesdayHours: "8.00",
    defaultThursdayHours: "8.00",
    defaultFridayHours: "8.00",
    defaultSaturdayHours: "0.00",
    defaultSundayHours: "0.00",
    overtimeThreshold: "60.00",
    allowOvertimePayout: true,
  };

  it("reads the string decimals of the API as numbers and falls back to Mo-Fr 8 h", () => {
    const values = defaultHoursFrom(STORED);
    expect(values.days).toEqual({ mon: 8, tue: 8, wed: 8, thu: 8, fri: 8, sat: 0, sun: 0 });
    expect(values.overtimeThreshold).toBe(60);
    expect(values.allowOvertimePayout).toBe(true);
    expect(defaultHoursFrom({}).days.fri).toBe(8);
    expect(defaultHoursFrom({}).days.sat).toBe(0);
    expect(defaultHoursFrom({}).overtimeThreshold).toBe(60);
  });

  it("the weekly total is the sum of the valid days, rounded to hundredths", () => {
    expect(weeklyHoursOf(defaultHoursFrom(STORED).days)).toBe(40);
    expect(weeklyHoursOf({ mon: 7.1, tue: 7.2, wed: null, thu: 0, fri: 0, sat: 0, sun: 0 })).toBe(
      14.3,
    );
  });

  it("a stored configuration has no message; each bad field names itself", () => {
    const ok = defaultHoursFrom(STORED);
    expect(messageCount(defaultHoursMessages(ok))).toBe(0);
    expect(
      defaultHoursMessages({ ...ok, days: { ...ok.days, mon: 25 } }).defaultMondayHours,
    ).toBeTruthy();
    expect(
      defaultHoursMessages({ ...ok, days: { ...ok.days, tue: null } }).defaultTuesdayHours,
    ).toBeTruthy();
    expect(defaultHoursMessages({ ...ok, overtimeThreshold: 0 }).overtimeThreshold).toBeTruthy();
    expect(defaultHoursMessages({ ...ok, overtimeThreshold: 501 }).overtimeThreshold).toBeTruthy();
    expect(defaultHoursMessages({ ...ok, overtimeThreshold: null }).overtimeThreshold).toBeTruthy();
    const zero = { ...ok, days: { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 } };
    expect(defaultHoursMessages(zero).defaultWeeklyHours).toContain("1 und 60");
    const heavy = { ...ok, days: { mon: 20, tue: 20, wed: 20, thu: 1, fri: 0, sat: 0, sun: 0 } };
    expect(defaultHoursMessages(heavy).defaultWeeklyHours).toContain("1 und 60");
  });

  it("the plain save carries the defaults and applyToExisting false, no selection", () => {
    const wire = defaultHoursWire(defaultHoursFrom(STORED), null);
    expect(wire).toMatchObject({
      defaultWeeklyHours: 40,
      defaultMondayHours: 8,
      defaultSaturdayHours: 0,
      overtimeThreshold: 60,
      allowOvertimePayout: true,
      applyToExisting: false,
    });
    expect(wire.applyEmployeeIds).toBeUndefined();
    expect(wire.previewFingerprint).toBeUndefined();
    expect(wire.effectiveFrom).toBeUndefined();
    expect(Object.keys(wire).sort()).toEqual(
      [...settingsSection("arbeitszeit-standard").keys].sort(),
    );
  });

  it("a confirmed bulk apply adds the server's selection unchanged", () => {
    const wire = defaultHoursWire(defaultHoursFrom(STORED), {
      applyEmployeeIds: ["a", "b"],
      previewFingerprint: "fp",
      effectiveFrom: "2026-12-01",
    });
    expect(wire).toMatchObject({
      applyToExisting: true,
      applyEmployeeIds: ["a", "b"],
      previewFingerprint: "fp",
      effectiveFrom: "2026-12-01",
    });
  });

  it("the comparable record has one field per weekday plus threshold and payout (no derived total)", () => {
    const comparable = defaultHoursComparable(defaultHoursFrom(STORED));
    expect(Object.keys(comparable).sort()).toEqual(
      [
        "allowOvertimePayout",
        "defaultFridayHours",
        "defaultMondayHours",
        "defaultSaturdayHours",
        "defaultSundayHours",
        "defaultThursdayHours",
        "defaultTuesdayHours",
        "defaultWednesdayHours",
        "overtimeThreshold",
      ].sort(),
    );
  });
});

describe("Überstunden-Limit", () => {
  it("no stored limit is off; a stored one shows as hours", () => {
    expect(maxNegativeFrom({})).toEqual({ enabled: false, hours: 20 });
    expect(maxNegativeFrom({ maxNegativeBalanceMinutes: null }).enabled).toBe(false);
    expect(maxNegativeFrom({ maxNegativeBalanceMinutes: 90 })).toEqual({
      enabled: true,
      hours: 1.5,
    });
    expect(maxNegativeFrom({ maxNegativeBalanceMinutes: 0 }).enabled).toBe(true);
  });

  it("checks the hours only while the limit is on (1..999)", () => {
    expect(messageCount(maxNegativeMessages({ enabled: false, hours: null }))).toBe(0);
    expect(messageCount(maxNegativeMessages({ enabled: true, hours: 1 }))).toBe(0);
    expect(messageCount(maxNegativeMessages({ enabled: true, hours: 999 }))).toBe(0);
    for (const hours of [0.5, 1000, null]) {
      expect(messageCount(maxNegativeMessages({ enabled: true, hours }))).toBe(1);
    }
  });

  it("sends whole minutes while on and null while off, under the registry key", () => {
    expect(maxNegativeWire({ enabled: true, hours: 12.5 })).toEqual({
      maxNegativeBalanceMinutes: 750,
    });
    expect(maxNegativeWire({ enabled: false, hours: 12.5 })).toEqual({
      maxNegativeBalanceMinutes: null,
    });
    expect(Object.keys(maxNegativeWire({ enabled: true, hours: 1 }))).toEqual(
      settingsSection("arbeitszeit-ueberstunden").keys,
    );
  });
});

describe("ArbZG-Prüfung and Offene Einträge", () => {
  it("the ArbZG check is on unless stored off", () => {
    expect(complianceFrom({})).toEqual({ arbzgEnabled: true });
    expect(complianceFrom({ arbzgEnabled: false })).toEqual({ arbzgEnabled: false });
    expect(Object.keys(complianceWire({ arbzgEnabled: true }))).toEqual(
      settingsSection("arbeitszeit-compliance").keys,
    );
  });

  it("open entries default to 14 hours; 0 (off) .. 168 are valid", () => {
    expect(openEntriesFrom({})).toEqual({ autoDeleteOpenHours: 14 });
    for (const hours of [0, 14, 168]) {
      expect(messageCount(openEntriesMessages({ autoDeleteOpenHours: hours }))).toBe(0);
    }
    for (const hours of [-1, 169, null]) {
      expect(messageCount(openEntriesMessages({ autoDeleteOpenHours: hours }))).toBe(1);
    }
    expect(openEntriesWire({ autoDeleteOpenHours: 24.9 })).toEqual({ autoDeleteOpenHours: 24 });
    expect(Object.keys(openEntriesWire({ autoDeleteOpenHours: 1 }))).toEqual(
      settingsSection("arbeitszeit-offene-eintraege").keys,
    );
  });
});
