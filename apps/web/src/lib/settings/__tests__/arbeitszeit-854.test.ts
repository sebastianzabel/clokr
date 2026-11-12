// Issue #854 (plan 854-07) - the pure half of the Arbeitszeit sections: what a section shows from a stored
// configuration, which messages its fields carry and what its save puts on the wire.
import { describe, expect, it } from "vitest";

import {
  breaksFrom,
  breaksMessages,
  breaksWire,
  messageCount,
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
