// Phase 76-02 — SaldoAnzeige state coverage.
//
// 5 visual states × isLocked × variant matrix. Per D-06, every render wrapped
// in data-theme. The plan's must_haves.truths requires "at least one assertion
// per state" — the suite below exceeds that floor by also asserting:
//   - the rendered text content (formatted with U+2212 minus + zero-padding)
//   - the .saldo--{sign} class on the root testid
//   - the lock badge presence + aria-label when isLocked
//   - the label suppression / customisation when variant changes
// All assertions are independent (no shared mutable state); cleanup() between
// tests is wired by apps/web/src/__tests__/setup.ts (76-01 infrastructure).

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import SaldoAnzeige from "../SaldoAnzeige.svelte";

describe("SaldoAnzeige — sign states", () => {
  it('renders 0h saldo as "0:00" with .saldo--zero class', () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 0 });
    const root = screen.getByTestId("saldo-anzeige");
    expect(root).toHaveClass("saldo--zero");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("0:00");
  });

  it("renders positive saldo with + sign and .saldo--positive class", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 120 });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--positive");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("+2:00");
  });

  it("renders negative saldo with U+2212 minus and .saldo--negative class", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: -90 });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--negative");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("−1:30");
  });

  it('renders null saldo as "Kein Stundenplan" with .saldo--no-schedule class', () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: null });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--no-schedule");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("Kein Stundenplan");
  });
});

describe("SaldoAnzeige — locked state", () => {
  it("adds .saldo--locked class when isLocked=true", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 60, isLocked: true });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--locked");
  });

  it("keeps sign class when isLocked co-occurs (no replacement)", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: -30, isLocked: true });
    const root = screen.getByTestId("saldo-anzeige");
    expect(root).toHaveClass("saldo--negative"); // sign preserved
    expect(root).toHaveClass("saldo--locked"); // modifier added
  });

  it("renders lock badge with aria-label when isLocked=true", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 0, isLocked: true });
    const badge = screen.getByTestId("saldo-locked-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("aria-label", "Monat abgeschlossen");
  });
});

describe("SaldoAnzeige — variant", () => {
  // Code-review fix — compact used to suppress the label entirely (76-02 original
  // behaviour). Deliberately flipped: on dense surfaces (calendar headers, Berichte
  // rows) the label is the ONLY thing telling "Bestätigt" apart from "Laufender Monat
  // (Prognose)" for relabelled callers like the Monat-Saldo tile — see the dedicated
  // "compact label visibility" describe block below for the concrete real-world case.
  it("shows label when variant=compact too (SALDO-DISP-03 — dense surfaces still need Bestätigt/Prognose)", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 60, variant: "compact", label: "Übertrag" });
    expect(screen.getByTestId("saldo-label")).toHaveTextContent("Übertrag");
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--compact");
  });

  it("shows label when variant=expanded (default)", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 60 });
    expect(screen.getByTestId("saldo-label")).toHaveTextContent("Saldo");
  });

  it("renders custom label when label prop provided", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 60, label: "Übertrag" });
    expect(screen.getByTestId("saldo-label")).toHaveTextContent("Übertrag");
  });
});

describe("SaldoAnzeige — formatting", () => {
  it("zero-pads minute portion (e.g., +1:05 not +1:5)", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 65 });
    const value = screen.getByTestId("saldo-value");
    expect(value).toHaveTextContent("+1:05");
    // Cross-check: positive sign class lands on root even for the small +0:65 carry
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--positive");
    // And the value must not pick up any other sign class via co-render
    expect(screen.getByTestId("saldo-anzeige")).not.toHaveClass("saldo--negative");
    expect(screen.getByTestId("saldo-anzeige")).not.toHaveClass("saldo--zero");
  });
});

// Phase 76.7 (D-16, D-24, UI-V19-04) — § 18 ArbZG exempt rendering.
// When `exempt={true}`, the SaldoAnzeige hides the numeric saldo behind
// an em-dash "—" (U+2014) and tags the root with `saldo--exempt` so admin
// pages can later style it distinctly. Sign + locked modifiers are still
// allowed to co-render (exempt is orthogonal to those modifiers); the
// sign-state is collapsed to "exempt" so no misleading colour applies.
describe("SaldoAnzeige — exempt state (Phase 76.7 D-24, UI-V19-04)", () => {
  it('renders "—" (em-dash) when exempt=true regardless of saldoMinutes', () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 120, exempt: true });
    const root = screen.getByTestId("saldo-anzeige");
    expect(root).toHaveClass("saldo--exempt");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("—");
    // Must NOT leak through the numeric or signed render branch
    expect(screen.getByTestId("saldo-value")).not.toHaveTextContent("+2:00");
    expect(screen.getByTestId("saldo-value")).not.toHaveTextContent("0:00");
  });

  it('renders "—" when exempt=true even with saldoMinutes=null', () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: null, exempt: true });
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("—");
    expect(screen.getByTestId("saldo-value")).not.toHaveTextContent("Kein Stundenplan");
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--exempt");
    expect(screen.getByTestId("saldo-anzeige")).not.toHaveClass("saldo--no-schedule");
  });

  it("preserves isLocked badge when exempt=true", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 60, exempt: true, isLocked: true });
    expect(screen.getByTestId("saldo-locked-badge")).toBeInTheDocument();
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--exempt");
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--locked");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("—");
  });

  it("regression: exempt=false (default) renders saldo number as today", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 120 });
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("+2:00");
    expect(screen.getByTestId("saldo-anzeige")).not.toHaveClass("saldo--exempt");
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--positive");
  });
});

// Phase 97-01 (TRACER, SALDO-DISP-01/03/05) — split mode: "Bestätigt" (confirmed) vs.
// "Laufender Monat (Prognose)" (forecast) vs. "Voraussichtlich gesamt" (combined). Split
// rendering activates only when `confirmedMinutes` is provided (!== undefined) — the
// regression test at the end proves omitting it still renders the pre-Phase-97 legacy value.
// States named per 97-UI-SPEC.md's State Matrix (A1–A4 confirmed, B1–B3 forecast, D combined).
describe("SaldoAnzeige — split mode (Phase 97-01)", () => {
  it("A1: confirmed positive renders +sign, .saldo--positive/.saldo--split, and 'Guthaben' caption", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 120,
      openMonthMinutes: 30,
      hasClosedMonth: true,
    });
    const root = screen.getByTestId("saldo-anzeige");
    expect(root).toHaveClass("saldo--positive");
    expect(root).toHaveClass("saldo--split");
    expect(screen.getByTestId("saldo-confirmed-value")).toHaveTextContent("+2:00");
    expect(screen.getByTestId("saldo-confirmed-caption")).toHaveTextContent("Guthaben");
  });

  it("A2: confirmed zero + hasClosedMonth=true renders 'ausgeglichen'", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 0,
      openMonthMinutes: 15,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--zero");
    expect(screen.getByTestId("saldo-confirmed-value")).toHaveTextContent("0:00");
    expect(screen.getByTestId("saldo-confirmed-caption")).toHaveTextContent("ausgeglichen");
  });

  it("A3: confirmed zero + hasClosedMonth=false renders 'noch kein Monatsabschluss', NOT 'ausgeglichen'", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 0,
      openMonthMinutes: 15,
      hasClosedMonth: false,
    });
    const caption = screen.getByTestId("saldo-confirmed-caption");
    expect(caption).toHaveTextContent("noch kein Monatsabschluss");
    expect(caption).not.toHaveTextContent("ausgeglichen");
  });

  it("A4: confirmed negative renders U+2212 minus, .saldo--negative, and 'offen' caption", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: -90,
      openMonthMinutes: 0,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--negative");
    expect(screen.getByTestId("saldo-confirmed-value")).toHaveTextContent("−1:30");
    expect(screen.getByTestId("saldo-confirmed-caption")).toHaveTextContent("offen");
  });

  it("B1: positive forecast renders the value without any good/bad/sign class (never colour-coded)", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    const fv = screen.getByTestId("saldo-forecast-value");
    expect(fv).toHaveTextContent("+0:40");
    expect(fv).not.toHaveClass("saldo--good");
    expect(fv).not.toHaveClass("saldo--bad");
    expect(fv).not.toHaveClass("saldo--positive");
    expect(fv).not.toHaveClass("saldo--negative");
  });

  it("B2: zero forecast renders 0:00 without any good/bad/sign class", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 0,
      hasClosedMonth: true,
    });
    const fv = screen.getByTestId("saldo-forecast-value");
    expect(fv).toHaveTextContent("0:00");
    expect(fv).not.toHaveClass("saldo--good");
    expect(fv).not.toHaveClass("saldo--bad");
  });

  it("B3: negative forecast renders U+2212 minus WITHOUT --bad (locked decision: forecast is never colour-coded)", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: -25,
      hasClosedMonth: true,
    });
    const fv = screen.getByTestId("saldo-forecast-value");
    expect(fv).toHaveTextContent("−0:25");
    expect(fv).not.toHaveClass("saldo--bad");
    expect(fv).not.toHaveClass("saldo--negative");
  });

  it("D: combined value equals confirmed + forecast (pure display arithmetic, no new computation path)", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: -25,
      hasClosedMonth: true,
    });
    // 100 + (-25) = 75min = +1:15
    expect(screen.getByTestId("saldo-combined-value")).toHaveTextContent("+1:15");
  });

  it("null-forecast (Task 1 fail-safe shape): renders en-dash and suppresses the combined line entirely", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 194,
      openMonthMinutes: null,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-forecast-value")).toHaveTextContent("—");
    expect(screen.queryByTestId("saldo-combined-value")).toBeNull();
  });

  it("regression: omitting confirmedMinutes still renders the legacy single value (no split)", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 120 });
    const root = screen.getByTestId("saldo-anzeige");
    expect(root).not.toHaveClass("saldo--split");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("+2:00");
    expect(screen.queryByTestId("saldo-confirmed-value")).toBeNull();
  });

  it("compact split mode collapses captions/combined line but keeps confirmed+forecast inline", () => {
    renderWithTheme(SaldoAnzeige, {
      variant: "compact",
      confirmedMinutes: 135,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-confirmed-value")).toHaveTextContent("+2:15");
    expect(screen.getByTestId("saldo-forecast-value")).toHaveTextContent("(+0:40)");
    expect(screen.queryByTestId("saldo-confirmed-caption")).toBeNull();
    expect(screen.queryByTestId("saldo-combined-value")).toBeNull();
    expect(screen.queryByTestId("saldo-forecast-label")).toBeNull();
  });

  it("compact A3 ('noch kein Monatsabschluss') is the ONE caption UI-SPEC keeps even in compact", () => {
    renderWithTheme(SaldoAnzeige, {
      variant: "compact",
      confirmedMinutes: 0,
      openMonthMinutes: 10,
      hasClosedMonth: false,
    });
    expect(screen.getByTestId("saldo-confirmed-caption")).toHaveTextContent(
      "noch kein Monatsabschluss",
    );
  });
});

// Phase 97-03 — completes the 97-UI-SPEC state matrix: toggletip, state C ("Restmonat
// unverplant"), loading/error, and the two remaining collapse states (noSchedule explicit,
// noSollTarget). Split props used below (confirmedMinutes/openMonthMinutes/hasClosedMonth)
// are the same fixture shape as the 97-01 suite above; only the NEW props under test vary.
describe("SaldoAnzeige — toggletip (Phase 97-03)", () => {
  it("renders a real button trigger whose aria-describedby matches the panel's own id", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    const trigger = screen.getByTestId("saldo-info-trigger");
    const panel = screen.getByTestId("saldo-tooltip");
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveAttribute("type", "button");
    expect(trigger).toHaveAttribute("aria-describedby", panel.id);
  });

  it("panel is present in the DOM before any interaction (never conditionally rendered)", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-tooltip")).toBeInTheDocument();
  });

  // Three assertions, one per approved sentence, each on a fragment distinctive enough
  // that a reworded sentence fails the test (per this plan's <critical_constraints>).
  it("sentence 1: states the confirmed figure cannot fall because of the open month", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-tooltip")).toHaveTextContent("kann diesen Wert nicht senken");
  });

  it("sentence 2: names the under-rostering (erosion) direction", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-tooltip")).toHaveTextContent(
      "sinkt die Prognose an gearbeiteten Tagen",
    );
  });

  it("sentence 3: names the unfinished-roster (suppress-then-jump) direction", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-tooltip")).toHaveTextContent(
      "bleibt die Prognose zunächst niedrig und springt",
    );
  });

  it("contains NO §615/Annahmeverzug legal reasoning (that stays on the detail page only)", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    const text = screen.getByTestId("saldo-tooltip").textContent ?? "";
    expect(text).not.toMatch(/615|Annahmeverzug/i);
  });

  it("the SAME tooltip body serves state C too — exactly one panel, never two strings", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
      rosterIncomplete: true,
    });
    expect(screen.getAllByTestId("saldo-tooltip")).toHaveLength(1);
    expect(screen.getByTestId("saldo-tooltip")).toHaveTextContent(
      "bleibt die Prognose zunächst niedrig und springt",
    );
  });

  it("trigger still renders in compact, shrunk but reachable", () => {
    renderWithTheme(SaldoAnzeige, {
      variant: "compact",
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-info-trigger")).toBeInTheDocument();
  });

  it("trigger/panel never render on the confirmed block, only inside the forecast block", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    // Exactly one trigger/panel pair exists — proves it isn't duplicated onto the
    // confirmed block as well as the forecast block.
    expect(screen.getAllByTestId("saldo-info-trigger")).toHaveLength(1);
    expect(screen.getAllByTestId("saldo-tooltip")).toHaveLength(1);
  });
});

describe("SaldoAnzeige — state C 'Restmonat unverplant' (Phase 97-03)", () => {
  it("expanded: rosterIncomplete=true renders the always-visible badge with the approved text", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
      rosterIncomplete: true,
    });
    expect(screen.getByTestId("saldo-roster-badge")).toHaveTextContent("Restmonat unverplant");
  });

  it("compact: rosterIncomplete=true renders a titled dot carrying the full sentence for screen readers", () => {
    renderWithTheme(SaldoAnzeige, {
      variant: "compact",
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
      rosterIncomplete: true,
    });
    expect(screen.getByTestId("saldo-roster-badge")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Restmonat noch nicht vollständig verplant" }),
    ).toBeInTheDocument();
  });

  it("badge absent when rosterIncomplete=false", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
      rosterIncomplete: false,
    });
    expect(screen.queryByTestId("saldo-roster-badge")).toBeNull();
  });

  it("badge absent when rosterIncomplete is omitted (undefined)", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    expect(screen.queryByTestId("saldo-roster-badge")).toBeNull();
  });

  it("badge never duplicated — exactly one instance, living on the forecast block only", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
      rosterIncomplete: true,
    });
    expect(screen.getAllByTestId("saldo-roster-badge")).toHaveLength(1);
  });
});

// Code-review WR-02 fix — rosterIncomplete was only ever read inside the isSplit
// branch, so callers that stay in legacy single-value mode on purpose (e.g. the
// Monat-Saldo tile, which is a relabel per 97-CONTEXT, not a split) could never show
// the "Restmonat unverplant" badge at all. These tests pin that the badge/dot now
// render in legacy (non-split) mode too, in both variants.
describe("SaldoAnzeige — WR-02 fix: rosterIncomplete renders in legacy single-value mode", () => {
  it("expanded legacy mode: rosterIncomplete=true renders the badge even without confirmedMinutes", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 120, rosterIncomplete: true });
    const root = screen.getByTestId("saldo-anzeige");
    expect(root).not.toHaveClass("saldo--split");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("+2:00");
    expect(screen.getByTestId("saldo-roster-badge")).toHaveTextContent("Restmonat unverplant");
  });

  it("compact legacy mode: rosterIncomplete=true renders a titled dot (matches the real Monat-Saldo tile usage)", () => {
    renderWithTheme(SaldoAnzeige, {
      variant: "compact",
      label: "Monat-Saldo (Prognose)",
      saldoMinutes: 60,
      rosterIncomplete: true,
    });
    expect(screen.getByTestId("saldo-roster-badge")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Restmonat noch nicht vollständig verplant" }),
    ).toBeInTheDocument();
  });

  it("legacy mode: badge absent when rosterIncomplete=false", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 120, rosterIncomplete: false });
    expect(screen.queryByTestId("saldo-roster-badge")).toBeNull();
  });

  it("legacy mode: badge absent when rosterIncomplete is omitted (undefined) — no regression on the many pre-97 callers", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 120 });
    expect(screen.queryByTestId("saldo-roster-badge")).toBeNull();
  });

  it("null-saldo legacy mode ('Kein Stundenplan'): badge never renders even if rosterIncomplete=true (no figure to qualify)", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: null, rosterIncomplete: true });
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("Kein Stundenplan");
    expect(screen.queryByTestId("saldo-roster-badge")).toBeNull();
  });
});

// Code-review fix — compact previously suppressed the outer `label` prop entirely, so
// two real production surfaces lost the ONLY textual cue distinguishing "Bestätigt"
// from "Laufender Monat (Prognose)" (SALDO-DISP-03): the Monat-Saldo tile (legacy
// single-value compact, label = "Monat-Saldo (Bestätigt)"/"Monat-Saldo (Prognose)" —
// time-entries/+page.svelte's monatSaldoStat snippet) and the Gesamt-Saldo tile
// (split compact, label = "Gesamt-Saldo" — the same page's gesamtSaldoStat snippet).
// These tests pin the exact real-world prop shapes, not just a synthetic case.
describe("SaldoAnzeige — compact label visibility (code review fix)", () => {
  it("legacy compact Monat-Saldo tile shows the Bestätigt/Prognose distinction via the label", () => {
    renderWithTheme(SaldoAnzeige, {
      variant: "compact",
      label: "Monat-Saldo (Bestätigt)",
      saldoMinutes: 90,
      isLocked: true,
    });
    expect(screen.getByTestId("saldo-label")).toHaveTextContent("Monat-Saldo (Bestätigt)");
  });

  it("legacy compact Monat-Saldo tile (open month) shows the Prognose label", () => {
    renderWithTheme(SaldoAnzeige, {
      variant: "compact",
      label: "Monat-Saldo (Prognose)",
      saldoMinutes: 45,
    });
    expect(screen.getByTestId("saldo-label")).toHaveTextContent("Monat-Saldo (Prognose)");
  });

  it("split compact Gesamt-Saldo tile still shows its outer label alongside the confirmed/forecast pair", () => {
    renderWithTheme(SaldoAnzeige, {
      variant: "compact",
      label: "Gesamt-Saldo",
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-label")).toHaveTextContent("Gesamt-Saldo");
    expect(screen.getByTestId("saldo-confirmed-value")).toHaveTextContent("+1:40");
    expect(screen.getByTestId("saldo-forecast-value")).toHaveTextContent("(+0:40)");
  });
});

describe("SaldoAnzeige — collapse states E2-E4 (Phase 97-03)", () => {
  it("E2: exempt still renders the em-dash through the extended precedence chain", () => {
    renderWithTheme(SaldoAnzeige, { exempt: true });
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("—");
  });

  it("E3: explicit noSchedule=true renders 'Kein Stundenplan'", () => {
    renderWithTheme(SaldoAnzeige, { noSchedule: true });
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("Kein Stundenplan");
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--no-schedule");
  });

  it("E4: noSollTarget=true renders 'Keine Soll-Vorgabe', NOT 'Kein Stundenplan'", () => {
    renderWithTheme(SaldoAnzeige, { noSollTarget: true });
    const value = screen.getByTestId("saldo-value");
    expect(value).toHaveTextContent("Keine Soll-Vorgabe");
    expect(value).not.toHaveTextContent("Kein Stundenplan");
  });

  it("E4: expanded shows the 'Zeiterfassung ohne Sollvergleich' subline", () => {
    renderWithTheme(SaldoAnzeige, { noSollTarget: true });
    expect(screen.getByTestId("saldo-no-soll-subline")).toHaveTextContent(
      "Zeiterfassung ohne Sollvergleich",
    );
  });

  it("E4: compact suppresses the subline (expanded-only per UI-SPEC)", () => {
    renderWithTheme(SaldoAnzeige, { variant: "compact", noSollTarget: true });
    expect(screen.queryByTestId("saldo-no-soll-subline")).toBeNull();
  });
});

describe("SaldoAnzeige — loading & error states F1-F2 (Phase 97-03)", () => {
  it("F1: loading renders the skeleton and no value", () => {
    renderWithTheme(SaldoAnzeige, { loading: true });
    expect(screen.getByTestId("saldo-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("saldo-value")).toBeNull();
    expect(screen.queryByTestId("saldo-confirmed-value")).toBeNull();
  });

  it("F2: error renders the approved German error sentence", () => {
    renderWithTheme(SaldoAnzeige, { error: true });
    expect(screen.getByTestId("saldo-error")).toHaveTextContent(
      "Fehler beim Laden des Saldos. Bitte Seite neu laden.",
    );
  });
});

describe("SaldoAnzeige — precedence chain proven by test (Phase 97-03)", () => {
  it("loading short-circuits split rendering even when split props are also passed", () => {
    renderWithTheme(SaldoAnzeige, {
      loading: true,
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("saldo-confirmed-value")).toBeNull();
    expect(screen.queryByTestId("saldo-forecast-value")).toBeNull();
  });

  it("noSollTarget short-circuits split rendering even when split props are also passed", () => {
    renderWithTheme(SaldoAnzeige, {
      noSollTarget: true,
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("Keine Soll-Vorgabe");
    expect(screen.queryByTestId("saldo-confirmed-value")).toBeNull();
    expect(screen.queryByTestId("saldo-forecast-value")).toBeNull();
  });
});

describe("SaldoAnzeige — compact vs expanded combined line (Phase 97-03)", () => {
  it("combined-total testid is present in expanded", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-combined-value")).toBeInTheDocument();
  });

  it("combined-total testid is absent in compact", () => {
    renderWithTheme(SaldoAnzeige, {
      variant: "compact",
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    expect(screen.queryByTestId("saldo-combined-value")).toBeNull();
  });
});

// 97-UI-SPEC → Assumptions log #3: locked badge migrated from the literal 🔒 emoji to the
// SVG Icon grammar. testid/aria-label unchanged (the three pre-97-03 lock tests above stay
// green unmodified) — this describes the migration itself plus the loading/error suppression.
describe("SaldoAnzeige — locked badge SVG migration (Phase 97-03)", () => {
  it("renders an SVG icon inside the locked badge instead of the legacy emoji", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 60, isLocked: true });
    const badge = screen.getByTestId("saldo-locked-badge");
    expect(badge.querySelector("svg")).not.toBeNull();
    expect(badge).not.toHaveTextContent("🔒");
    expect(badge).toHaveAttribute("aria-label", "Monat abgeschlossen");
  });

  it("suppresses the locked badge during loading/error even when isLocked=true", () => {
    renderWithTheme(SaldoAnzeige, { isLocked: true, loading: true });
    expect(screen.queryByTestId("saldo-locked-badge")).toBeNull();
  });
});
