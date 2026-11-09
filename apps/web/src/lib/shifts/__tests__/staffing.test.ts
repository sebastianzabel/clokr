// Issue #850 — the Besetzung of a day reads "x / y", never a decimal such as "1.00".
import { describe, it, expect } from "vitest";
import {
  formatStaff,
  staffingFigure,
  staffingStatusText,
  staffingTooltip,
  type StaffingDay,
} from "../staffing";

const day = (over: Partial<StaffingDay> = {}): StaffingDay => ({
  effectiveStaff: 2,
  minStaff: 3,
  hasSupervisor: true,
  unsupervisedAzubis: 0,
  coverageStatus: "under",
  ...over,
});

describe("staffing display (Issue #850)", () => {
  it("shows whole numbers without decimals", () => {
    expect(staffingFigure(day())).toBe("2 / 3");
    expect(staffingFigure(day({ effectiveStaff: 1, minStaff: 2 }))).toBe("1 / 2");
    expect(staffingFigure(day({ effectiveStaff: 0, minStaff: 2 }))).toBe("0 / 2");
  });

  it("keeps a real fraction with a German comma, never a dot", () => {
    expect(staffingFigure(day({ effectiveStaff: 1.5, minStaff: 2 }))).toBe("1,5 / 2");
    expect(formatStaff(0.75)).toBe("0,75");
  });

  it("never prints a decimal-dot value such as 1.00", () => {
    for (const v of [0, 1, 1.5, 2, 2.25, 10]) {
      expect(formatStaff(v)).not.toMatch(/\./);
      expect(formatStaff(v)).not.toMatch(/,0+$/);
    }
  });

  it("words the status and the hover text", () => {
    expect(staffingStatusText("ok")).toBe("besetzt");
    expect(staffingStatusText("under")).toBe("zu wenig");
    expect(staffingStatusText("supervision-missing")).toBe("Aufsicht fehlt");
    expect(staffingTooltip(day())).toContain("2 von 3 besetzt");
    expect(staffingTooltip(undefined)).toBe("");
    expect(
      staffingTooltip(
        day({ coverageStatus: "supervision-missing", unsupervisedAzubis: 1, hasSupervisor: false }),
      ),
    ).toContain("ohne Aufsicht");
  });
});
