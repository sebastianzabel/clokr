/**
 * Issue #494 (D-11) — audit-saldo-chain-integrity.ts skips a violating link only on the track-only
 * ZEROING signature (track-only contract AND stored carry-over 0), through the shared helper.
 *
 * DB-free source pin: the script's run() is not exported or injectable and walks every employee of
 * the database it is pointed at, so a behavioural run would not be isolated. The decision helper
 * itself is pinned by the pure matrix in track-only-rule-494.test.ts; this file pins that the
 * audit actually USES it (and no longer the wider isTrackOnlySchedule), plus three pure cases on
 * the audit's own link shape.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  walkSaldoChain,
  isTrackOnlyZeroingLink,
} from "../../src/contexts/working-time-account/saldo-chain-integrity";

const SOURCE = readFileSync(new URL("../audit-saldo-chain-integrity.ts", import.meta.url), "utf8");

const MARCH_START = new Date("2026-02-28T23:00:00Z");
const MARCH_END = new Date("2026-03-30T22:00:00Z");

function headLink(carryOver: number) {
  const links = walkSaldoChain([
    {
      id: "r1",
      periodStart: MARCH_START,
      periodEnd: MARCH_END,
      workedMinutes: 300,
      expectedMinutes: 0,
      balanceMinutes: 300,
      carryOver,
    },
  ]);
  return links[0];
}

const TRACK_ONLY = { type: "MONTHLY_HOURS", overtimeMode: "CARRY_FORWARD", monthlyHours: null };
const CARRY_15H = { type: "MONTHLY_HOURS", overtimeMode: "CARRY_FORWARD", monthlyHours: 15 };

describe("audit-saldo-chain-integrity skip (Issue #494, D-11) — source pin", () => {
  it("the source is non-empty (anti-vacuity)", () => {
    expect(SOURCE.length).toBeGreaterThan(1000);
  });

  it("the violation loop decides through isTrackOnlyZeroingLink(l, schedule)", () => {
    expect(SOURCE).toContain("isTrackOnlyZeroingLink(l, schedule)");
    expect(SOURCE).not.toContain("if (isTrackOnlySchedule(");
  });

  it("imports the helper from the saldo-chain-integrity module", () => {
    expect(SOURCE).toMatch(
      /import \{[^}]*\bisTrackOnlyZeroingLink\b[^}]*\} from "\.\.\/src\/contexts\/working-time-account\/saldo-chain-integrity"/s,
    );
  });

  it("prints the widened-rule summary label", () => {
    expect(SOURCE).toContain("Track-only zeroing links skipped");
    expect(SOURCE).not.toContain(["TRACK_ONLY", "links skipped"].join(" "));
  });
});

describe("the helper on the audit's own link shape", () => {
  it("a zeroed track-only link is the expected zeroing (skipped)", () => {
    expect(isTrackOnlyZeroingLink(headLink(0), TRACK_ONLY)).toBe(true);
  });

  it("a non-zero stored carry on a track-only month stays reportable", () => {
    expect(isTrackOnlyZeroingLink(headLink(600), TRACK_ONLY)).toBe(false);
  });

  it("a CARRY_FORWARD 15 h contract is never skipped", () => {
    expect(isTrackOnlyZeroingLink(headLink(0), CARRY_15H)).toBe(false);
  });
});
