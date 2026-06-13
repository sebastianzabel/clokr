// Phase 82 (UI-V19-07) — bsSourceLabel helper test.
//
// The legacy /vocational-school/upcoming endpoint emitted source values
// "PATTERN" | "MANUAL". The Phase 79 /work-events endpoints add "AUTO"
// (rows created server-side by future automation, e.g. holiday import).
// Both /time-entries pages today render the source via an inline ternary
// that only handles PATTERN/MANUAL — AUTO rows would hit the else branch
// and incorrectly render as "Manuell eingefügt".
//
// This helper is the single source of truth for German UI copy across the
// 3 consumer surfaces, eliminating the two divergent ternaries.
//
// Copy strings are pulled VERBATIM from 82-UI-SPEC.md §Copywriting Contract.
import { describe, it, expect } from "vitest";
import { bsSourceLabel } from "../bsSourceLabel";

describe("bsSourceLabel — German UI mapping for WorkEventSource (UI-V19-07)", () => {
  it('PATTERN → "Automatisch (Muster)"', () => {
    expect(bsSourceLabel("PATTERN")).toBe("Automatisch (Muster)");
  });

  it('AUTO → "Automatisch"', () => {
    expect(bsSourceLabel("AUTO")).toBe("Automatisch");
  });

  it('MANUAL → "Manuell eingefügt"', () => {
    expect(bsSourceLabel("MANUAL")).toBe("Manuell eingefügt");
  });
});
