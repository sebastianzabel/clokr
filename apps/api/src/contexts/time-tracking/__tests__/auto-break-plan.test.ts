// Issue #511 (AK-4, D-17, D-20) — the one automatic-break decision. The amount and placement
// functions it combines have their own tests; this file pins the combination and the create rule.

import { describe, it, expect } from "vitest";
import { autoBreakAppliesOnCreate, planAutoBreak } from "../auto-break-plan";
import type { AutoBreakTenantConfig } from "../auto-break-plan";

const TZ = "Europe/Berlin";
const DAY = new Date("2026-05-12T00:00:00.000Z");
const at = (hhmm: string) => new Date(`2026-05-12T${hhmm}:00.000Z`);

const TENANT: AutoBreakTenantConfig = {
  autoBreakEnabled: true,
  defaultBreakStart: null,
  defaultBreakOver6h: 30,
  defaultBreakOver9h: 45,
};
const ADULT = { breakOver6hOverride: null, breakOver9hOverride: null, birthDate: null };
const MINOR = { ...ADULT, birthDate: new Date("2010-03-01T00:00:00.000Z") };

function plan(
  overrides: Partial<Parameters<typeof planAutoBreak>[0]> = {},
): ReturnType<typeof planAutoBreak> {
  return planAutoBreak({
    employee: ADULT,
    tenantConfig: TENANT,
    start: at("08:00"),
    end: at("17:00"),
    entryDate: DAY,
    tz: TZ,
    ...overrides,
  });
}

describe("planAutoBreak", () => {
  it("places the configured amount for an adult; the segments sum to the amount", () => {
    const result = plan()!;
    expect(result.regime).toBe("ARBZG_4");
    expect(result.amountMin).toBe(30);
    const placed = result.segments.reduce(
      (sum, g) => sum + (g.endTime.getTime() - g.startTime.getTime()) / 60000,
      0,
    );
    expect(placed).toBe(30);
  });

  it("is null when the tenant has the feature off, has no config, or the employee is unknown", () => {
    expect(plan({ tenantConfig: { ...TENANT, autoBreakEnabled: false } })).toBeNull();
    expect(plan({ tenantConfig: null })).toBeNull();
    expect(plan({ employee: null })).toBeNull();
  });

  it("is null when the configured amount is zero (an entry up to 6 h) for an adult", () => {
    expect(plan({ end: at("13:00") })).toBeNull();
  });

  it("raises a minor's amount to the § 11 JArbSchG minimum and says so in the regime", () => {
    const result = plan({ employee: MINOR, end: at("13:00") })!;
    expect(result.regime).toBe("JARBSCHG_11");
    expect(result.amountMin).toBe(30);
  });

  it("decides the minor status on the entry's work date, not today", () => {
    const eighteenth = { ...ADULT, birthDate: new Date("2008-05-12T00:00:00.000Z") };
    expect(plan({ employee: eighteenth, end: at("13:00") }), "18th birthday: adult").toBeNull();
    expect(
      plan({
        employee: eighteenth,
        end: at("13:00"),
        entryDate: new Date("2026-05-11T00:00:00.000Z"),
      })?.regime,
      "the day before: still a minor",
    ).toBe("JARBSCHG_11");
  });

  it("uses the employee override before the tenant default", () => {
    expect(plan({ employee: { ...ADULT, breakOver6hOverride: 45 } })!.amountMin).toBe(45);
  });
});

describe("autoBreakAppliesOnCreate", () => {
  it("applies only with neither break slots nor break minutes", () => {
    expect(autoBreakAppliesOnCreate({ slotCount: 0, breakMinutes: 0 })).toBe(true);
    expect(autoBreakAppliesOnCreate({ slotCount: 1, breakMinutes: 0 })).toBe(false);
    expect(autoBreakAppliesOnCreate({ slotCount: 0, breakMinutes: 10 })).toBe(false);
  });
});
