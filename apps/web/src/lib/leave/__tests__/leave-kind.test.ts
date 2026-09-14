// Phase 97 (D-04): teamcal/+page.svelte used to hold the fourth independent copy of the German
// sick-type names, matched against leaveType.name (SICK_TYPE_NAMES = new Set(["Krankmeldung",
// "Kinderkrank"])). Pulled into its own module because it is pure logic, and unit-tested here
// rather than via a mounted +page.svelte test (no such harness exists in this codebase yet —
// see CLAUDE.md's note that lib/leave/ components are outside lint:ui-classes' scanned scope
// and need their own tests).

import { describe, it, expect } from "vitest";
import { leaveKind, SICK_TYPE_CODES } from "../leave-kind";

describe("leaveKind", () => {
  it("classifies typeCode SICK as a sick cell", () => {
    expect(leaveKind("SICK")).toBe("sick");
  });

  it("classifies typeCode SICK_CHILD as a sick cell", () => {
    expect(leaveKind("SICK_CHILD")).toBe("sick");
  });

  it("classifies typeCode VACATION as a vacation cell", () => {
    expect(leaveKind("VACATION")).toBe("vacation");
  });

  it("classifies typeCode null as a vacation cell — deliberate parity with the old name-based fallback (Phase 97, D-04/T-97-37)", () => {
    expect(leaveKind(null)).toBe("vacation");
  });

  it("classifies typeCode undefined as a vacation cell (same fallback path as null)", () => {
    expect(leaveKind(undefined)).toBe("vacation");
  });

  it("classifies every other canonical LeaveTypeCode as a vacation cell (SPECIAL, UNPAID, EDUCATION, OVERTIME_COMP, MATERNITY, PARENTAL)", () => {
    for (const code of [
      "SPECIAL",
      "UNPAID",
      "EDUCATION",
      "OVERTIME_COMP",
      "MATERNITY",
      "PARENTAL",
    ]) {
      expect(leaveKind(code)).toBe("vacation");
    }
  });

  it("a display-name rename of the SICK type does not change classification (rename resilience)", () => {
    // The whole point of switching to code: the old resolver kept a copy of the German display
    // name. Since leaveKind never looks at a name at all, there is nothing to rename here —
    // this test documents that invariant rather than exercising a name path.
    expect(leaveKind("SICK")).toBe("sick");
  });
});

describe("SICK_TYPE_CODES", () => {
  it("contains exactly SICK and SICK_CHILD", () => {
    expect([...SICK_TYPE_CODES].sort()).toEqual(["SICK", "SICK_CHILD"]);
  });
});
