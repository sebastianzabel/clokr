// Phase 76.3 — SALDO-V19-01 frontend calendar workDays + SHIFT_BASED
// semantics regression guard.
//
// The 2026-06-04 incident reproduction (SHIFT_BASED Mo-non-workday) (test 1) is the architectural enforcement
// for SALDO-V19-01. Without it, a future maintainer can reintroduce
// the `*Hours > 0` pattern in a new calendar surface and ship the
// same 2026-06-04 production regression (phantom -1 h Tagessaldo on
// Mondays for SHIFT_BASED employees with legacy mondayHours drift).
//
// Per CLAUDE.md `feedback_no_test_manipulation`: if any assertion
// in this file ever needs to be relaxed, the helper logic is wrong,
// not the test. Investigate root cause — do not silently weaken.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  isWorkDay,
  getDayExpectedHours,
  countWorkingDaysInMonth,
  monthlyBudgetSollMinutes,
  arbeitstageFieldVariant,
  buildContractWorkDaysPayload,
  type WorkScheduleLike,
} from "../work-schedule";

// Helper to build a minimal WorkScheduleLike — fills in the *Hours
// / workDays / monthlyHours fields with defaults so each test only
// declares what it cares about.
function build(partial: Partial<WorkScheduleLike>): WorkScheduleLike {
  return {
    type: "FIXED_SCHEDULE",
    workDays: undefined,
    monthlyHours: null,
    sundayHours: 0,
    mondayHours: 0,
    tuesdayHours: 0,
    wednesdayHours: 0,
    thursdayHours: 0,
    fridayHours: 0,
    saturdayHours: 0,
    ...partial,
  };
}

describe("work-schedule helper (Phase 76.3 SALDO-V19-01)", () => {
  it("2026-06-04 incident — SHIFT_BASED Mo non-workday: SHIFT_BASED + workDays=[2,3,4,5] + legacy mondayHours=1 → Monday returns 0 (no phantom Soll)", () => {
    const sched = build({
      type: "SHIFT_BASED",
      workDays: [2, 3, 4, 5],
      mondayHours: 1, // legacy drift
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
    });
    const monday = new Date(2026, 5, 1); // June 1 2026 = Monday
    const tuesday = new Date(2026, 5, 2);
    expect(isWorkDay(sched, monday)).toBe(false);
    expect(getDayExpectedHours(sched, monday)).toBe(0);
    expect(isWorkDay(sched, tuesday)).toBe(true);
    // SHIFT_BASED: per CONTEXT D-03 the helper returns 0 even on a
    // workday — Soll comes from the Shift row that the page loads.
    expect(getDayExpectedHours(sched, tuesday)).toBe(0);
  });

  it("FIXED_WEEKLY happy path: workDays=[1,2,3,4,5] + mondayHours=8 → Monday returns 8", () => {
    const sched = build({
      type: "FIXED_SCHEDULE",
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
    });
    const monday = new Date(2026, 5, 1);
    const saturday = new Date(2026, 5, 6);
    expect(isWorkDay(sched, monday)).toBe(true);
    expect(getDayExpectedHours(sched, monday)).toBe(8);
    expect(getDayExpectedHours(sched, saturday)).toBe(0);
  });

  it("MONTHLY_HOURS with monthlyHours=null → all days return 0 (pure time tracking)", () => {
    const sched = build({
      type: "MONTHLY_HOURS",
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 4,
      tuesdayHours: 4,
      wednesdayHours: 4,
      thursdayHours: 4,
      fridayHours: 4,
      monthlyHours: null,
    });
    const monday = new Date(2026, 5, 1);
    const saturday = new Date(2026, 5, 6);
    expect(getDayExpectedHours(sched, monday)).toBe(0);
    expect(getDayExpectedHours(sched, saturday)).toBe(0);
    expect(isWorkDay(sched, monday)).toBe(true);
  });

  it("MONTHLY_HOURS with monthlyHours=60 → days respect workDays; per-day Soll is the *Hours value when workDays match", () => {
    const sched = build({
      type: "MONTHLY_HOURS",
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 4,
      tuesdayHours: 4,
      wednesdayHours: 4,
      thursdayHours: 4,
      fridayHours: 4,
      monthlyHours: 60,
    });
    const monday = new Date(2026, 5, 1);
    const saturday = new Date(2026, 5, 6);
    expect(isWorkDay(sched, monday)).toBe(true);
    expect(getDayExpectedHours(sched, monday)).toBe(4);
    expect(getDayExpectedHours(sched, saturday)).toBe(0);
  });

  it("Legacy fallback: workDays undefined + *Hours>0 → uses *Hours predicate (no regression for unmigrated pre-Phase-61 rows)", () => {
    const sched = build({
      type: "FIXED_SCHEDULE",
      workDays: undefined,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
    });
    const monday = new Date(2026, 5, 1);
    const saturday = new Date(2026, 5, 6);
    expect(isWorkDay(sched, monday)).toBe(true);
    expect(isWorkDay(sched, saturday)).toBe(false);
    expect(getDayExpectedHours(sched, monday)).toBe(8);
  });

  it("countWorkingDaysInMonth: workDays=[1,2,3,4,5] in June 2026 → 22 workdays (no holiday exclusion); 21 with one Thursday excluded", () => {
    const sched = build({
      type: "FIXED_SCHEDULE",
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
    });
    const monthStart = new Date(2026, 5, 1); // June 2026
    expect(countWorkingDaysInMonth(sched, monthStart)).toBe(22);
    // June 4 2026 is a Thursday
    expect(countWorkingDaysInMonth(sched, monthStart, ["2026-06-04"])).toBe(21);
  });
});

// Item C (v1.8.24) — MONTHLY_HOURS header SOLL = flat full-month budget (no working-day drift).
describe("monthlyBudgetSollMinutes — MONTHLY_HOURS flat budget (Item C)", () => {
  // Nils: 15h/month Minijobber, Mon–Fri workdays (via *Hours drift or workDays).
  const nils = (): WorkScheduleLike => ({
    type: "MONTHLY_HOURS",
    workDays: [1, 2, 3, 4, 5],
    monthlyHours: 15,
    sundayHours: 0,
    mondayHours: 3,
    tuesdayHours: 3,
    wednesdayHours: 3,
    thursdayHours: 3,
    fridayHours: 3,
    saturdayHours: 0,
  });
  const BUDGET = 900; // 15h × 60 = 900 min

  it("flag OFF (default): SOLL == flat monthlyHours (900 = 15:00), NOT the drifted 897 = 14:57", () => {
    // July 2026 has 23 Mon–Fri workdays → round(900/23)×23 = 39×23 = 897 (the drifted value).
    const july = new Date(2026, 6, 1);
    expect(countWorkingDaysInMonth(nils(), july)).toBe(23);
    // Flat budget must be exactly 900 (no drift), regardless of working-day count.
    expect(monthlyBudgetSollMinutes(nils(), july, BUDGET, false, [])).toBe(900);
  });

  it("flag OFF: SOLL is month-count-invariant — same 900 in a 22-workday and a 23-workday month", () => {
    const june = new Date(2026, 5, 1); // 22 workdays
    const july = new Date(2026, 6, 1); // 23 workdays
    expect(countWorkingDaysInMonth(nils(), june)).toBe(22);
    expect(countWorkingDaysInMonth(nils(), july)).toBe(23);
    expect(monthlyBudgetSollMinutes(nils(), june, BUDGET, false, [])).toBe(900);
    expect(monthlyBudgetSollMinutes(nils(), july, BUDGET, false, [])).toBe(900);
  });

  it("MONAT-SALDO semantic: worked − flat budget (Nils July, IST 6:30) = 390 − 900 = −510 (−8:30)", () => {
    const july = new Date(2026, 6, 1);
    const soll = monthlyBudgetSollMinutes(nils(), july, BUDGET, false, []);
    const worked = 390; // 6:30h
    expect(worked - soll).toBe(-510); // −8:30
  });

  it("flag ON: subtracts holiday workdays at the flat daily rate round(budget/totalWorkdays)", () => {
    // Oct 2026: 3 Oct (Tag der Deutschen Einheit) is a Saturday 2026 → not a workday. Use a holiday
    // that lands on a workday: 2026-07-01 (Wed) as a synthetic holiday in July (23 workdays).
    const july = new Date(2026, 6, 1);
    const dailyRate = Math.round(BUDGET / 23); // 39
    // One holiday on a workday → budget − 39.
    expect(monthlyBudgetSollMinutes(nils(), july, BUDGET, true, ["2026-07-01"])).toBe(
      900 - dailyRate,
    );
    // A holiday on a weekend (2026-07-04 Sat) is NOT a workday → no deduction.
    expect(monthlyBudgetSollMinutes(nils(), july, BUDGET, true, ["2026-07-04"])).toBe(900);
    // No holidays with flag ON → still exactly the flat budget (no drift).
    expect(monthlyBudgetSollMinutes(nils(), july, BUDGET, true, [])).toBe(900);
  });

  it("zero / null budget → 0; null schedule → 0", () => {
    const july = new Date(2026, 6, 1);
    expect(monthlyBudgetSollMinutes(nils(), july, 0, false, [])).toBe(0);
    expect(monthlyBudgetSollMinutes(null, july, BUDGET, false, [])).toBe(0);
  });
});

// Phase 107 (D-22..D-26, issue #94) — Arbeitstage/Woche field decision. Pure,
// standalone specification of which variant the employee form
// (admin/employees/[id]/+page.svelte) renders per ScheduleType. See the
// function's own doc comment for why this is deliberately NOT wired into the
// template's {#if} branches (each variant renders entirely different
// markup, so routing through this function would not reduce duplication).
describe("arbeitstageFieldVariant (Phase 107 D-22..D-26)", () => {
  it("SHIFT_BASED → 'count' (D-23: plain number input writing contractWorkDaysPerWeek)", () => {
    expect(arbeitstageFieldVariant("SHIFT_BASED")).toBe("count");
  });

  it("FIXED_SCHEDULE → 'derived' (D-24: disabled, derived-count display)", () => {
    expect(arbeitstageFieldVariant("FIXED_SCHEDULE")).toBe("derived");
  });

  it("FLEXTIME → 'chips' (D-25: Mo-So weekday selector writing workDays)", () => {
    expect(arbeitstageFieldVariant("FLEXTIME")).toBe("chips");
  });

  it("MONTHLY_HOURS → 'none' (D-26: field absent entirely)", () => {
    expect(arbeitstageFieldVariant("MONTHLY_HOURS")).toBe("none");
  });

  it("undefined type falls back to 'count', matching the template's own {:else} catch-all default", () => {
    expect(arbeitstageFieldVariant(undefined)).toBe("count");
  });
});

// Phase 107 (D-02/D-23) — the workDays/contractWorkDaysPerWeek slice of
// buildSchedulePayload(), extracted and wired back into the component (not a
// parallel copy) so this test exercises the real PUT-body-building code path.
describe("buildContractWorkDaysPayload (Phase 107 D-02/D-23)", () => {
  it("SHIFT_BASED: omits workDays entirely and emits the submitted contractWorkDaysPerWeek", () => {
    const payload = buildContractWorkDaysPayload("SHIFT_BASED", [1, 2, 3, 4, 5], 4);
    expect(payload).not.toHaveProperty("workDays");
    expect(payload.contractWorkDaysPerWeek).toBe(4);
  });

  it("SHIFT_BASED with contractWorkDaysPerWeek=null (not yet hydrated) still omits workDays", () => {
    const payload = buildContractWorkDaysPayload("SHIFT_BASED", [2, 3, 4, 5], null);
    expect(payload).not.toHaveProperty("workDays");
    expect(payload.contractWorkDaysPerWeek).toBeNull();
  });

  it.each(["FIXED_SCHEDULE", "FLEXTIME", "MONTHLY_HOURS"] as const)(
    "%s: sends workDays unchanged and forces contractWorkDaysPerWeek to null",
    (type) => {
      const payload = buildContractWorkDaysPayload(type, [1, 2, 3, 4, 5], 4);
      expect(payload.workDays).toEqual([1, 2, 3, 4, 5]);
      expect(payload.contractWorkDaysPerWeek).toBeNull();
    },
  );
});

// Phase 107 gap closure (G-01/G-02, issue #94 follow-up, 107-UAT.md) — hoisted
// to module scope so this ONE disk read is shared by the AC-FE-01 guard below
// and the new G-01/G-02 blocks appended at the end of this file. Do not add a
// second reader.
const ROUTE_SOURCE = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../routes/(app)/admin/employees/[id]/+page.svelte",
  ),
  "utf-8",
);

// Phase 107 gap closure (G-01/G-02) — assertions are scoped to ONE schedule-type
// branch each, because after this plan BOTH the FLEXTIME and the MONTHLY_HOURS
// branch legitimately carry aria-label="Arbeitstage" (same concept, only one
// branch renders at a time — see 107-09-PLAN.md <terminology_decision>). A
// whole-file indexOf would silently assert against whichever comes first.
const FLEXTIME_BRANCH = ROUTE_SOURCE.slice(
  ROUTE_SOURCE.indexOf('{:else if eType === "FLEXTIME"}'),
  ROUTE_SOURCE.indexOf('{:else if eType === "MONTHLY_HOURS"}'),
);
const MONTHLY_HOURS_BRANCH = ROUTE_SOURCE.slice(
  ROUTE_SOURCE.indexOf('{:else if eType === "MONTHLY_HOURS"}'),
  ROUTE_SOURCE.indexOf("<!-- SHIFT_BASED -->"),
);

// Phase 107 (AC-FE-01, issue #94) — the 2026-06-04-style regression guard for
// THIS bug: reads the route file's actual source off disk (precedent:
// KontoSaldoCard.test.ts's COMPONENT_SOURCE) so a reintroduction of the
// canonical-order weekday guess fails this suite even though it lives in
// markup, not in a unit under test elsewhere in this file.
describe("employee form source — canonical.slice absence (Phase 107 AC-FE-01)", () => {
  it("the employee form no longer derives a weekday set from a number via canonical.slice", () => {
    expect(ROUTE_SOURCE).not.toContain("canonical.slice");
  });

  it("the old shared 'Arbeitstage/Woche' field id is gone; the SHIFT_BASED variant writes eContractWorkDays", () => {
    expect(ROUTE_SOURCE).not.toContain('id="e-workdays"');
    expect(ROUTE_SOURCE).toContain("eContractWorkDays");
  });
});

describe("employee form — FLEXTIME Arbeitstage vs. Kerntage (Phase 107 gap G-01)", () => {
  it("branch slice is non-empty (sanity — a renamed branch marker must fail loudly, not silently assert against an empty string)", () => {
    expect(FLEXTIME_BRANCH.length).toBeGreaterThan(0);
  });

  it('carries exactly one aria-label="Arbeitstage" group', () => {
    const matches = FLEXTIME_BRANCH.match(/aria-label="Arbeitstage"/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("Arbeitstage renders BEFORE the Kernarbeitszeit (optional) heading — the authoritative control is no longer nested inside it", () => {
    expect(FLEXTIME_BRANCH.indexOf('aria-label="Arbeitstage"')).toBeLessThan(
      FLEXTIME_BRANCH.indexOf("Kernarbeitszeit (optional)"),
    );
  });

  it("Kerntage stays inside the Kernarbeitszeit (optional) section", () => {
    expect(FLEXTIME_BRANCH.indexOf("Kernarbeitszeit (optional)")).toBeLessThan(
      FLEXTIME_BRANCH.indexOf('aria-label="Kerntage"'),
    );
  });

  it("Arbeitstage carries a hint naming its two consequences", () => {
    expect(FLEXTIME_BRANCH).toContain(
      "Vertraglich festgelegte Arbeitstage. Steuern Urlaubsverbrauch und Soll-Verteilung.",
    );
  });

  it("Kerntage carries a hint stating it affects neither Soll nor Urlaub, placed after the Kerntage chips", () => {
    const hint = "Nur zur Information — wirkt sich weder auf das Soll noch auf den Urlaub aus.";
    expect(FLEXTIME_BRANCH).toContain(hint);
    expect(FLEXTIME_BRANCH.indexOf(hint)).toBeGreaterThan(
      FLEXTIME_BRANCH.indexOf('aria-label="Kerntage"'),
    );
  });

  it("the old do-what-not-why hint is gone", () => {
    expect(FLEXTIME_BRANCH).not.toContain(
      "Wählen Sie die vertraglich festgelegten Arbeitstage aus.",
    );
  });
});

describe("employee form — MONTHLY_HOURS Arbeitstage (Phase 107 gap G-02)", () => {
  it("branch slice is non-empty (sanity — a renamed branch marker must fail loudly, not silently assert against an empty string)", () => {
    expect(MONTHLY_HOURS_BRANCH.length).toBeGreaterThan(0);
  });

  it("the string 'Feste Arbeitstage' no longer exists anywhere in the route source", () => {
    expect(ROUTE_SOURCE).not.toContain("Feste Arbeitstage");
  });

  it("the chip row is labelled Arbeitstage (not Feste Arbeitstage)", () => {
    expect(MONTHLY_HOURS_BRANCH).toContain('<span class="form-label">Arbeitstage</span>');
  });

  it("the chip group is a labelled role=group, structurally identical to the FLEXTIME one", () => {
    expect(MONTHLY_HOURS_BRANCH).toContain('aria-label="Arbeitstage"');
    expect(MONTHLY_HOURS_BRANCH).toContain('role="group"');
  });

  it("carries a hint naming Urlaubsverbrauch and Urlaubsanspruch as its consequences (closes D-27 for the fourth type)", () => {
    expect(MONTHLY_HOURS_BRANCH).toContain(
      "Vertraglich festgelegte Arbeitstage. Steuern Urlaubsverbrauch und Urlaubsanspruch.",
    );
  });

  it("the Stunden/Monat hint no longer claims 'Keine festen Wochentage', which the chip row below it contradicts", () => {
    expect(MONTHLY_HOURS_BRANCH).not.toContain("Keine festen Wochentage");
  });

  it("the Stunden/Monat hint keeps only the true half: no daily targets", () => {
    expect(MONTHLY_HOURS_BRANCH).toContain(
      "Soll wird monatlich berechnet — es gibt keine Tagesziele.",
    );
  });
});

// G-01/G-02 are presentation-only. The MONTHLY_HOURS chips write workDays
// INDIRECTLY: they set mondayHours…sundayHours to 1/0, and the server derives
// workDays from exactly those via normalizeWorkDays() (apps/api/src/routes/
// settings.ts:1034). Changing the write path here would silently rewrite every
// existing MONTHLY_HOURS employee's workDays — their Urlaubsverbrauch
// (calculateWorkDays) and their Pro-Rata-Anspruch (countWorkDaysPerWeek). These
// assertions are the guard. If one of them ever fails, the change is wrong; do
// not relax the assertion.
describe("employee form — schedule payload is unchanged by the G-01/G-02 presentation fix", () => {
  it("all seven day-hours ternaries in buildSchedulePayload() are byte-identical", () => {
    expect(ROUTE_SOURCE).toContain(
      'mondayHours: eType === "FIXED_SCHEDULE" ? eMon : eMonWd ? 1 : 0,',
    );
    expect(ROUTE_SOURCE).toContain(
      'tuesdayHours: eType === "FIXED_SCHEDULE" ? eTue : eTueWd ? 1 : 0,',
    );
    expect(ROUTE_SOURCE).toContain(
      'wednesdayHours: eType === "FIXED_SCHEDULE" ? eWed : eWedWd ? 1 : 0,',
    );
    expect(ROUTE_SOURCE).toContain(
      'thursdayHours: eType === "FIXED_SCHEDULE" ? eThu : eThuWd ? 1 : 0,',
    );
    expect(ROUTE_SOURCE).toContain(
      'fridayHours: eType === "FIXED_SCHEDULE" ? eFri : eFriWd ? 1 : 0,',
    );
    expect(ROUTE_SOURCE).toContain(
      'saturdayHours: eType === "FIXED_SCHEDULE" ? eSat : eSatWd ? 1 : 0,',
    );
    expect(ROUTE_SOURCE).toContain(
      'sundayHours: eType === "FIXED_SCHEDULE" ? eSun : eSunWd ? 1 : 0,',
    );
  });

  it("the buildContractWorkDaysPayload spread is unchanged", () => {
    expect(ROUTE_SOURCE).toContain(
      "...buildContractWorkDaysPayload(eType, eWorkDays, eContractWorkDays),",
    );
  });

  it("the relabelled MONTHLY_HOURS chips still write the same seven booleans", () => {
    expect(MONTHLY_HOURS_BRANCH).toContain("(eMonWd = !eMonWd)");
    expect(MONTHLY_HOURS_BRANCH).toContain("(eTueWd = !eTueWd)");
    expect(MONTHLY_HOURS_BRANCH).toContain("(eWedWd = !eWedWd)");
    expect(MONTHLY_HOURS_BRANCH).toContain("(eThuWd = !eThuWd)");
    expect(MONTHLY_HOURS_BRANCH).toContain("(eFriWd = !eFriWd)");
    expect(MONTHLY_HOURS_BRANCH).toContain("(eSatWd = !eSatWd)");
    expect(MONTHLY_HOURS_BRANCH).toContain("(eSunWd = !eSunWd)");
  });
});

// Phase 107 Plan 10 (deferred-items.md item 2) — all five chip/segment groups
// on this tab (Arbeitszeitmodell, FLEXTIME Arbeitstage, FLEXTIME Kerntage,
// MONTHLY_HOURS Arbeitstage, BS-Modus) now share one markup shape.
describe("employee form — group controls carry no orphan <label> (deferred-items item 2)", () => {
  it('no bare <label class="form-label"> (without a for attribute) remains in the route', () => {
    // A <label> may only reference a form control. Every chip/segment group on
    // this tab is a set of <button>s inside a role-carrying container, so the
    // accessible name lives on the container's aria-label and the visible text
    // is a <span>. Re-adding a bare <label class="form-label"> here reintroduces
    // the a11y_label_has_associated_control finding recorded in deferred-items.md
    // item 2.
    expect(ROUTE_SOURCE).not.toContain('<label class="form-label">');
  });
});
