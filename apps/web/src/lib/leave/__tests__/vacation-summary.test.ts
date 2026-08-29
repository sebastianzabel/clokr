// Phase 114 (RU-05) — the pinning proof for `apps/web/src/lib/leave/vacation-summary.ts`.
//
// Acceptance criterion RU-05 demands: "**Keine Berechnung wurde geändert.**
// `vacSummaryTotal/CarryOver/Used/Planned/Left` und der Kartenwert liefern exakt dieselben
// Zahlen wie vorher — nachzuweisen z. B. über einen Test, der die Werte gegen die bisherige
// Ableitung pinnt."
//
// That proof is discharged by the LEGACY oracle below: it re-implements the eight pre-Phase-114
// inline `$derived` expressions from `apps/web/src/routes/(app)/leave/+page.svelte` LITERALLY,
// copied character for character, and a table of cases asserts the new pure function deep-equals
// it. The oracle is deliberately NOT written in terms of `deriveVacationSummary` — that would
// make the comparison a tautology. If the oracle and the module ever disagree, the MODULE is
// wrong; never "fix" the oracle to match.
//
// Same convention as its sibling `vacation-balance.test.ts`: plain function calls, no component
// mount (no test in `apps/web` has ever mounted a route page), `describe`/`it`/`expect` imported
// explicitly because `vitest.config.ts` sets `globals: false`.

import { describe, it, expect } from "vitest";

import type { VacationBalance } from "../vacation-balance";
import {
  deriveVacationSummary,
  vacationCardDelta,
  vacationCardLabel,
  VAC_CARD_LABEL,
  VAC_CARD_LABEL_WITH_PENDING,
  type VacationSummary,
} from "../vacation-summary";

/** Build a `VacationBalance` from the four numbers that actually drive the arithmetic.
 *  `provisionalUsed`, `carryOverDeadline` and `section9Movements` play no part in any of the
 *  eight formulas — they are carried only so the fixture is a real `VacationBalance`. */
function balance(total: number, used: number, carryOver: number): VacationBalance {
  return {
    total,
    used,
    provisionalUsed: 0,
    carryOver,
    carryOverDeadline: null,
    section9Movements: [],
  };
}

// ── The LEGACY oracle: the eight formulas exactly as they read before Phase 114 ─────────────
//
// Six from `leave/+page.svelte:992-999`:
//   let vacSummaryTotal = $derived(vacationBalance?.total ?? 0);
//   let vacSummaryCarryOver = $derived(vacationBalance?.carryOver ?? 0);
//   let vacSummaryUsed = $derived(vacationBalance?.used ?? 0);
//   let vacSummaryPlanned = $derived(pendingVacDays);
//   let vacSummaryCarryOverRemaining = $derived(Math.max(0, vacSummaryCarryOver - vacSummaryUsed));
//   let vacSummaryLeft = $derived(
//     vacSummaryTotal + vacSummaryCarryOver - vacSummaryUsed - vacSummaryPlanned,
//   );
// the seventh from `:919-923` — note the `null`, not `0`:
//   let vacRemaining = $derived(
//     vacationBalance
//       ? vacationBalance.total + vacationBalance.carryOver - vacationBalance.used
//       : null,
//   );
// and the eighth inlined in the card's `delta` prop at `:1146-1147`:
//   delta={vacationBalance
//     ? `von ${vacationBalance.total + vacationBalance.carryOver} verfügbar`
//     : undefined}
function LEGACY(vacationBalance: VacationBalance | null, pendingVacDays: number): VacationSummary {
  const vacSummaryTotal = vacationBalance?.total ?? 0;
  const vacSummaryCarryOver = vacationBalance?.carryOver ?? 0;
  const vacSummaryUsed = vacationBalance?.used ?? 0;
  const vacSummaryPlanned = pendingVacDays;
  const vacSummaryCarryOverRemaining = Math.max(0, vacSummaryCarryOver - vacSummaryUsed);
  const vacSummaryLeft = vacSummaryTotal + vacSummaryCarryOver - vacSummaryUsed - vacSummaryPlanned;
  const vacRemaining = vacationBalance
    ? vacationBalance.total + vacationBalance.carryOver - vacationBalance.used
    : null;
  // The card's delta line interpolated `total + carryOver`; the number inside it is what
  // `availableTotal` must reproduce, and it was absent (`undefined` delta) without a balance.
  const cardAvailableTotal = vacationBalance
    ? vacationBalance.total + vacationBalance.carryOver
    : null;
  return {
    total: vacSummaryTotal,
    carryOver: vacSummaryCarryOver,
    used: vacSummaryUsed,
    planned: vacSummaryPlanned,
    carryOverRemaining: vacSummaryCarryOverRemaining,
    left: vacSummaryLeft,
    remaining: vacRemaining,
    availableTotal: cardAvailableTotal,
  };
}

describe("deriveVacationSummary — the issue #117 scenario, pinned exactly", () => {
  it("reproduces every number the issue tabulates, plus the card's 7 and 38", () => {
    const summary = deriveVacationSummary(balance(24, 31, 14), 3);
    expect(summary).toEqual({
      total: 24,
      carryOver: 14,
      used: 31,
      planned: 3,
      carryOverRemaining: 0, // max(0, 14 - 31)
      left: 4, // 24 + 14 - 31 - 3
      remaining: 7, // 38 - 31 — the card value, beantragte NOT subtracted
      availableTotal: 38, // 24 + 14
    });
  });
});

// ── RU-05: the legacy-oracle table ──────────────────────────────────────────────────────────
describe("deriveVacationSummary vs. the legacy inline derivations", () => {
  const cases: Array<{
    name: string;
    total: number;
    used: number;
    carryOver: number;
    planned: number;
  }> = [
    { name: "issue #117 scenario", total: 24, used: 31, carryOver: 14, planned: 3 },
    { name: "no carry-over at all", total: 30, used: 5, carryOver: 0, planned: 0 },
    {
      name: "carryOver > used, so carryOverRemaining is 9",
      total: 20,
      used: 5,
      carryOver: 14,
      planned: 2,
    },
    { name: "left goes negative (-8)", total: 20, used: 25, carryOver: 0, planned: 3 },
    { name: "all zero", total: 0, used: 0, carryOver: 0, planned: 0 },
    {
      name: "used exactly equals carryOver, so carryOverRemaining is 0",
      total: 24,
      used: 14,
      carryOver: 14,
      planned: 0,
    },
    { name: "half-days", total: 25.5, used: 3.5, carryOver: 2.5, planned: 1 },
  ];

  it.each(cases)(
    "$name: deep-equals the literal re-implementation of the old formulas",
    ({ total, used, carryOver, planned }) => {
      const b = balance(total, used, carryOver);
      expect(deriveVacationSummary(b, planned)).toEqual(LEGACY(b, planned));
    },
  );

  it("does not clamp `left` — it may be negative", () => {
    const b = balance(20, 25, 0);
    expect(deriveVacationSummary(b, 3).left).toBe(-8);
    expect(deriveVacationSummary(b, 3).left).toBe(LEGACY(b, 3).left);
  });

  it("does clamp `carryOverRemaining` at 0", () => {
    const b = balance(24, 31, 14);
    expect(deriveVacationSummary(b, 3).carryOverRemaining).toBe(0);
    // and it is NOT the raw -17 the subtraction would give
    expect(deriveVacationSummary(b, 3).carryOverRemaining).not.toBe(-17);
  });

  it("keeps half-day arithmetic exactly as the old expressions produced it", () => {
    const b = balance(25.5, 3.5, 2.5);
    const summary = deriveVacationSummary(b, 1);
    expect(summary.remaining).toBe(24.5); // 25.5 + 2.5 - 3.5
    expect(summary.availableTotal).toBe(28); // 25.5 + 2.5
    expect(summary.left).toBe(23.5); // 28 - 3.5 - 1
    expect(summary).toEqual(LEGACY(b, 1));
  });
});

// ── The `null` contract — this is what keeps the card rendering "–" ─────────────────────────
describe("deriveVacationSummary with no balance", () => {
  it("returns 0 for the six summary fields (the strip renders zeros, as before)", () => {
    const summary = deriveVacationSummary(null, 0);
    expect(summary.total).toBe(0);
    expect(summary.carryOver).toBe(0);
    expect(summary.used).toBe(0);
    expect(summary.planned).toBe(0);
    expect(summary.carryOverRemaining).toBe(0);
    expect(summary.left).toBe(0);
  });

  it("returns `remaining: null`, NOT 0 — if this became 0 the Urlaubskonto card would show a fake '0' instead of the en-dash placeholder", () => {
    expect(deriveVacationSummary(null, 0).remaining).toBeNull();
    expect(deriveVacationSummary(null, 3).remaining).toBeNull();
  });

  it("returns `availableTotal: null`, NOT 0 — if this became 0 the card would render a breakdown line for a balance it does not have", () => {
    expect(deriveVacationSummary(null, 0).availableTotal).toBeNull();
    expect(deriveVacationSummary(null, 3).availableTotal).toBeNull();
  });

  it("matches the legacy oracle for a null balance too", () => {
    expect(deriveVacationSummary(null, 0)).toEqual(LEGACY(null, 0));
    expect(deriveVacationSummary(null, 2)).toEqual(LEGACY(null, 2));
  });
});

describe("deriveVacationSummary — `planned` passes straight through", () => {
  it("is neither clamped nor rounded nor year-filtered (the fetch is already year-scoped)", () => {
    expect(deriveVacationSummary(balance(24, 0, 0), 0.5).planned).toBe(0.5);
    expect(deriveVacationSummary(balance(24, 0, 0), 99).planned).toBe(99);
    // Negative input is nonsense but must not be silently swallowed — the old
    // `$derived(pendingVacDays)` did nothing to it either.
    expect(deriveVacationSummary(balance(24, 0, 0), -1).planned).toBe(-1);
  });
});

describe("deriveVacationSummary — purity", () => {
  it("does not mutate its input balance object", () => {
    const b = balance(24, 31, 14);
    const before: VacationBalance = JSON.parse(JSON.stringify(b));
    deriveVacationSummary(b, 3);
    expect(b).toEqual(before);
  });
});

// ── Urlaubskonto-Karte: deutsche Beschriftung ──────────────────────────────────────────────
// Exact-string assertions on purpose. These four strings ARE the fix for issue #117 — a
// `toContain` would let a future edit reintroduce the ambiguity the phase removed.

describe("vacationCardLabel", () => {
  it("is plain `Resturlaub` when nothing is beantragt", () => {
    // At planned === 0 the card's number and the strip's `Verbleibend` are the SAME number,
    // so a qualifier would advertise a difference that does not exist (Phase 107 G-03's rule).
    expect(vacationCardLabel(0)).toBe("Resturlaub");
    expect(vacationCardLabel(0)).toBe(VAC_CARD_LABEL);
  });

  it("adds `(ohne beantragte)` as soon as there IS a pending request", () => {
    expect(vacationCardLabel(3)).toBe("Resturlaub (ohne beantragte)");
    expect(vacationCardLabel(3)).toBe(VAC_CARD_LABEL_WITH_PENDING);
  });

  it("treats half a beantragten Tag as beantragt too", () => {
    expect(vacationCardLabel(0.5)).toBe("Resturlaub (ohne beantragte)");
  });

  it("NEVER names the Übertrag — the card's label means the balance and nothing else", () => {
    // This is the assertion that catches a future edit re-merging the two meanings that
    // issue #117 reported as colliding under one heading.
    for (const planned of [0, 0.5, 3, 99]) {
      expect(vacationCardLabel(planned)).not.toContain("Übertrag");
    }
  });
});

describe("vacationCardDelta", () => {
  it("breaks the sum down when there is a Vorjahresübertrag (RU-04)", () => {
    expect(vacationCardDelta(24, 14)).toBe("von 38 gesamt (24 Anspruch + 14 Übertrag Vorjahr)");
  });

  it("stays a plain total when there is no Übertrag — nothing to break down", () => {
    expect(vacationCardDelta(24, 0)).toBe("von 24 gesamt");
  });

  it("renders half-days as plain JS numbers (no formatter is introduced)", () => {
    expect(vacationCardDelta(25.5, 2.5)).toBe(
      "von 28 gesamt (25.5 Anspruch + 2.5 Übertrag Vorjahr)",
    );
  });

  it("NEVER says `verfügbar` — that word labelled the 38 while the card's own value was 7", () => {
    expect(vacationCardDelta(24, 14)).not.toContain("verfügbar");
    expect(vacationCardDelta(24, 0)).not.toContain("verfügbar");
    expect(vacationCardDelta(25.5, 2.5)).not.toContain("verfügbar");
  });

  it("shows Anspruch and Übertrag as SEPARATE numbers whenever the Übertrag is > 0 (RU-03)", () => {
    // „Genommen 31 bei Anspruch 24" must resolve without the reader doing arithmetic.
    const delta = vacationCardDelta(24, 14);
    expect(delta).toContain(String(24));
    expect(delta).toContain(String(14));
    expect(delta).toContain("Übertrag Vorjahr");
  });
});
