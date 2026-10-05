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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  isWorkDay,
  getDayExpectedHours,
  getDayExpectedMinutes,
  countWorkingDaysInMonth,
  monthlyHoursWorkDays,
  monthlyHoursDailyRateMinutes,
  arbeitstageFieldVariant,
  buildContractWorkDaysPayload,
  buildUsualWorkDaysPayload,
  usualWorkDaysShortfall,
  usualWorkDaysMissing,
  shiftContractsMissingUsualWorkDays,
  buildUsualWorkDaysBackfillPayload,
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

// MONTHLY_HOURS day rate — display mirror of the server (Issue #433, D-05/D-06).
//
// The former Item C guarantee (a reduction-free month shows exactly the flat
// budget, e.g. 15h/month -> 900) is now asserted SERVER-SIDE (plan 05's
// monthly-hours-soll-parity-433.test.ts, Employee C: drift-free full month,
// 900 min exactly) because the calendar header's month Soll comes from the
// server's monthSollMinutes, not from a client formula any more — the
// guarantee moved, it was not weakened or dropped.
describe("MONTHLY_HOURS day rate — display mirror of the server (Issue #433, D-05/D-06)", () => {
  it("monthlyHoursWorkDays: non-empty schedule.workDays wins over defaultWorkDays (D-05)", () => {
    expect(monthlyHoursWorkDays({ workDays: [2, 3, 4] }, [1, 2, 3, 4, 5])).toEqual([2, 3, 4]);
  });

  it("monthlyHoursWorkDays: empty schedule.workDays falls back to a non-empty defaultWorkDays", () => {
    expect(monthlyHoursWorkDays({ workDays: [] }, [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
  });

  it("monthlyHoursWorkDays: empty schedule.workDays + null defaultWorkDays falls back to Mo-Fr", () => {
    expect(monthlyHoursWorkDays({ workDays: [] }, null)).toEqual([1, 2, 3, 4, 5]);
  });

  it("monthlyHoursWorkDays: schedule without workDays and *Hours=4 on Mo-Fr, defaults null -> Mo-Fr fallback, NEVER derived from *Hours", () => {
    const sched = build({
      type: "MONTHLY_HOURS",
      workDays: undefined,
      mondayHours: 4,
      tuesdayHours: 4,
      wednesdayHours: 4,
      thursdayHours: 4,
      fridayHours: 4,
    });
    expect(monthlyHoursWorkDays(sched, null)).toEqual([1, 2, 3, 4, 5]);
  });

  it("monthlyHoursDailyRateMinutes: Mo-Fr schedule, June 2026, 2640 budget -> 120 (22 workdays)", () => {
    const june = new Date(2026, 5, 1);
    expect(monthlyHoursDailyRateMinutes({ workDays: [1, 2, 3, 4, 5] }, june, 2640)).toBe(120);
  });

  it("monthlyHoursDailyRateMinutes: a holiday on a workday does NOT change the rate — there is no holiday parameter any more; holidays stay in the denominator (D-06)", () => {
    const june = new Date(2026, 5, 1);
    expect(monthlyHoursDailyRateMinutes({ workDays: [1, 2, 3, 4, 5] }, june, 2640)).toBe(120);
  });

  it("monthlyHoursDailyRateMinutes: workDays [2,3,4] in June 2026 -> round(2640/13) = 203", () => {
    const june = new Date(2026, 5, 1);
    expect(monthlyHoursDailyRateMinutes({ workDays: [2, 3, 4] }, june, 2640)).toBe(203);
  });

  it("monthlyHoursDailyRateMinutes: empty workDays falls back to defaults [1,2,3,4] in June 2026 -> round(2640/18) = 147", () => {
    const june = new Date(2026, 5, 1);
    expect(monthlyHoursDailyRateMinutes({ workDays: [] }, june, 2640, [1, 2, 3, 4])).toBe(147);
  });

  it("monthlyHoursDailyRateMinutes: null schedule -> 0", () => {
    const june = new Date(2026, 5, 1);
    expect(monthlyHoursDailyRateMinutes(null, june, 2640)).toBe(0);
  });

  it("monthlyHoursDailyRateMinutes: budget 0 -> 0", () => {
    const june = new Date(2026, 5, 1);
    expect(monthlyHoursDailyRateMinutes({ workDays: [1, 2, 3, 4, 5] }, june, 0)).toBe(0);
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

describe("buildUsualWorkDaysPayload (Phase 436 Plan 02 D-06)", () => {
  it("SHIFT_BASED: sorts and de-duplicates", () => {
    expect(buildUsualWorkDaysPayload("SHIFT_BASED", [5, 2, 3, 2])).toEqual({
      usualWorkDays: [2, 3, 5],
    });
  });

  it("non-SHIFT_BASED: always emits []", () => {
    expect(buildUsualWorkDaysPayload("FIXED_SCHEDULE", [1, 2])).toEqual({ usualWorkDays: [] });
  });

  it("undefined type: emits []", () => {
    expect(buildUsualWorkDaysPayload(undefined, [1, 2])).toEqual({ usualWorkDays: [] });
  });
});

describe("usualWorkDaysShortfall (Phase 436 Plan 02 D-06)", () => {
  it("empty list is always valid (keine Angabe)", () => {
    expect(usualWorkDaysShortfall([], 4)).toBe(0);
  });

  it("fewer ticked days than the contract count reports the missing count", () => {
    expect(usualWorkDaysShortfall([2, 3, 4], 4)).toBe(1);
  });

  it("exactly the contract count reports 0", () => {
    expect(usualWorkDaysShortfall([2, 3, 4, 5], 4)).toBe(0);
  });

  it("null contract count (not yet known) reports 0", () => {
    expect(usualWorkDaysShortfall([1, 2], null)).toBe(0);
  });
});

describe("usualWorkDaysMissing (Issue #481 R5)", () => {
  it("SHIFT_BASED without any day is missing", () => {
    expect(usualWorkDaysMissing("SHIFT_BASED", [])).toBe(true);
  });
  it("SHIFT_BASED with a day is not missing (the shortfall helper handles too few)", () => {
    expect(usualWorkDaysMissing("SHIFT_BASED", [2])).toBe(false);
  });
  it("other or unknown types never miss an Angabe", () => {
    expect(usualWorkDaysMissing("FIXED_SCHEDULE", [])).toBe(false);
    expect(usualWorkDaysMissing("FLEXTIME", [])).toBe(false);
    expect(usualWorkDaysMissing(undefined, [])).toBe(false);
  });
});

describe("shiftContractsMissingUsualWorkDays (Issue #481 R7)", () => {
  it("keeps only SHIFT_BASED rows without an Angabe, oldest first", () => {
    const rows = [
      { id: "c", type: "SHIFT_BASED", validFrom: "2026-10-01", usualWorkDays: [] },
      { id: "f", type: "FIXED_SCHEDULE", validFrom: "2026-01-01", usualWorkDays: [] },
      { id: "s", type: "SHIFT_BASED", validFrom: "2026-08-01", usualWorkDays: [2, 3, 4, 5] },
      { id: "a", type: "SHIFT_BASED", validFrom: "2026-05-18", usualWorkDays: null },
    ];
    expect(shiftContractsMissingUsualWorkDays(rows).map((r) => r.id)).toEqual(["a", "c"]);
  });
  it("empty input stays empty", () => {
    expect(shiftContractsMissingUsualWorkDays([])).toEqual([]);
  });
});

describe("buildUsualWorkDaysBackfillPayload (Issue #481 R6)", () => {
  it("sorts and de-duplicates the Angabe", () => {
    expect(buildUsualWorkDaysBackfillPayload("id-1", [5, 2, 2, 3, 4])).toEqual({
      workScheduleId: "id-1",
      usualWorkDays: [2, 3, 4, 5],
    });
  });
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
// workDays from exactly those via normalizeWorkDays()
// (apps/api/src/contexts/platform/api/settings.ts:1034). Changing the write path here
// would silently rewrite every existing MONTHLY_HOURS employee's workDays — their
// Urlaubsverbrauch (calculateWorkDays) and their Pro-Rata-Anspruch (countWorkDaysPerWeek).
// These assertions are the guard. If one of them ever fails, the change is wrong; do
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

// Issue #142 — the divergence warning must fire only for FIXED_SCHEDULE, since
// {day}Hours is authoritative only for that type (CLAUDE.md). FLEXTIME's seven
// {day}Hours columns are just as much a placeholder as SHIFT_BASED's and
// MONTHLY_HOURS's, so comparing them against workDays produces a guaranteed
// false alarm on every FLEXTIME schedule whose workDays is a proper subset of
// the placeholder weekdays (the one prod FLEXTIME row: workDays=[Di..Fr]
// against filler hours on all five weekdays).
describe("maybeWarnDivergence — divergence warning fires only for FIXED_SCHEDULE (issue #142)", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prod FLEXTIME row repro — type: FLEXTIME, workDays: [Di..Fr], placeholder Mo..Fr hours=1 → no warning", () => {
    const sched = build({
      type: "FLEXTIME",
      workDays: [2, 3, 4, 5],
      mondayHours: 1,
      tuesdayHours: 1,
      wednesdayHours: 1,
      thursdayHours: 1,
      fridayHours: 1,
    });
    isWorkDay(sched, new Date(2026, 5, 1)); // any date; only workDays presence matters here
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it("FIXED_SCHEDULE with divergent workDays/*Hours still warns exactly once", () => {
    const sched = build({
      type: "FIXED_SCHEDULE",
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 0,
    });
    isWorkDay(sched, new Date(2026, 5, 1));
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
  });

  it("FIXED_SCHEDULE with agreeing workDays/*Hours does not warn", () => {
    const sched = build({
      type: "FIXED_SCHEDULE",
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
    });
    isWorkDay(sched, new Date(2026, 5, 1));
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it("undefined type does not warn even with divergent workDays/*Hours — deliberate (D-Q2), not incidental", () => {
    const sched = build({
      type: undefined,
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 0,
    });
    isWorkDay(sched, new Date(2026, 5, 1));
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it.each(["SHIFT_BASED", "MONTHLY_HOURS"] as const)(
    "%s with divergent workDays/placeholder hours still does not warn (regression guard)",
    (type) => {
      const sched = build({
        type,
        workDays: [2, 3, 4, 5],
        mondayHours: 1,
        tuesdayHours: 1,
        wednesdayHours: 1,
        thursdayHours: 1,
        fridayHours: 1,
      });
      isWorkDay(sched, new Date(2026, 5, 1));
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    },
  );

  it("one-shot behaviour survives the guard change — same divergent FIXED_SCHEDULE object warns exactly once across repeated calls", () => {
    const sched = build({
      type: "FIXED_SCHEDULE",
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 0,
    });
    isWorkDay(sched, new Date(2026, 5, 1));
    isWorkDay(sched, new Date(2026, 5, 2));
    isWorkDay(sched, new Date(2026, 5, 3));
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
  });
});

// Issue #164 — FLEXTIME's daily Soll must be the server's Ø-Methode day rate
// (weeklyHours / contractWorkDaysPerWeek), mirroring
// apps/api/src/contexts/working-time-account/timezone.ts:215-286 (avgWorkMinutesCore), not the legacy
// {day}Hours 1/0 placeholder. Prod-row repro from the issue.
describe("getDayExpectedHours / getDayExpectedMinutes — FLEXTIME Ø-Methode (issue #164)", () => {
  it("prod-row repro: workDays=[Di..Fr], placeholder *Hours=1, weeklyHours=30 → Tuesday = 7.5h / 450min (NOT 1h / 60min)", () => {
    const sched = build({
      type: "FLEXTIME",
      workDays: [2, 3, 4, 5],
      mondayHours: 1,
      tuesdayHours: 1,
      wednesdayHours: 1,
      thursdayHours: 1,
      fridayHours: 1,
      weeklyHours: 30,
    });
    const tuesday = new Date(2026, 5, 2); // June 2 2026 = Tuesday
    expect(getDayExpectedHours(sched, tuesday)).toBe(7.5);
    expect(getDayExpectedMinutes(sched, tuesday)).toBe(450);
  });

  it("same schedule, Monday (not in workDays) → 0h / 0min", () => {
    const sched = build({
      type: "FLEXTIME",
      workDays: [2, 3, 4, 5],
      mondayHours: 1,
      tuesdayHours: 1,
      wednesdayHours: 1,
      thursdayHours: 1,
      fridayHours: 1,
      weeklyHours: 30,
    });
    const monday = new Date(2026, 5, 1);
    expect(getDayExpectedHours(sched, monday)).toBe(0);
    expect(getDayExpectedMinutes(sched, monday)).toBe(0);
  });

  it("same schedule, Saturday → 0h / 0min", () => {
    const sched = build({
      type: "FLEXTIME",
      workDays: [2, 3, 4, 5],
      mondayHours: 1,
      tuesdayHours: 1,
      wednesdayHours: 1,
      thursdayHours: 1,
      fridayHours: 1,
      weeklyHours: 30,
    });
    const saturday = new Date(2026, 5, 6);
    expect(getDayExpectedHours(sched, saturday)).toBe(0);
    expect(getDayExpectedMinutes(sched, saturday)).toBe(0);
  });

  it("rounding: weeklyHours=38.5, workDays=[Di..Fr] → getDayExpectedMinutes = 578 (Math.round(577.5)), always an integer", () => {
    const sched = build({
      type: "FLEXTIME",
      workDays: [2, 3, 4, 5],
      mondayHours: 1,
      tuesdayHours: 1,
      wednesdayHours: 1,
      thursdayHours: 1,
      fridayHours: 1,
      weeklyHours: 38.5,
    });
    const tuesday = new Date(2026, 5, 2);
    const minutes = getDayExpectedMinutes(sched, tuesday);
    expect(minutes).toBe(578);
    expect(Number.isInteger(minutes)).toBe(true);
  });

  it("weeklyHours=null (legacy FLEXTIME row) → 0 on a workday, mirroring avgWorkMinutesCore's wh <= 0 guard", () => {
    const sched = build({
      type: "FLEXTIME",
      workDays: [2, 3, 4, 5],
      mondayHours: 1,
      tuesdayHours: 1,
      wednesdayHours: 1,
      thursdayHours: 1,
      fridayHours: 1,
      weeklyHours: null,
    });
    const tuesday = new Date(2026, 5, 2);
    expect(getDayExpectedHours(sched, tuesday)).toBe(0);
    expect(getDayExpectedMinutes(sched, tuesday)).toBe(0);
  });

  it("legacy divisor fallback: workDays=[] + *Hours=1 on Mo-Fr + weeklyHours=40 → Monday = 8h / 480min (divisor 5 from count(*Hours>0)), same membership source as isWorkDay", () => {
    const sched = build({
      type: "FLEXTIME",
      workDays: [],
      mondayHours: 1,
      tuesdayHours: 1,
      wednesdayHours: 1,
      thursdayHours: 1,
      fridayHours: 1,
      weeklyHours: 40,
    });
    const monday = new Date(2026, 5, 1);
    expect(getDayExpectedHours(sched, monday)).toBe(8);
    expect(getDayExpectedMinutes(sched, monday)).toBe(480);
  });

  it("FIXED_SCHEDULE regression: getDayExpectedMinutes on the existing 8h Monday case = 480, getDayExpectedHours still 8 (AC-164-04)", () => {
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
    expect(getDayExpectedHours(sched, monday)).toBe(8);
    expect(getDayExpectedMinutes(sched, monday)).toBe(480);
  });

  it("SHIFT_BASED and MONTHLY_HOURS(monthlyHours=null) → getDayExpectedMinutes = 0", () => {
    const shiftBased = build({
      type: "SHIFT_BASED",
      workDays: [2, 3, 4, 5],
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
    });
    const monthlyNoBudget = build({
      type: "MONTHLY_HOURS",
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 4,
      monthlyHours: null,
    });
    const tuesday = new Date(2026, 5, 2);
    const monday = new Date(2026, 5, 1);
    expect(getDayExpectedMinutes(shiftBased, tuesday)).toBe(0);
    expect(getDayExpectedMinutes(monthlyNoBudget, monday)).toBe(0);
  });

  it("MONTHLY_HOURS(monthlyHours=60, mondayHours=4) → getDayExpectedMinutes = 240 (unchanged {day}Hours path)", () => {
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
    expect(getDayExpectedMinutes(sched, monday)).toBe(240);
  });

  it("getDayExpectedMinutes(null, date) → 0", () => {
    expect(getDayExpectedMinutes(null, new Date(2026, 5, 1))).toBe(0);
  });
});
