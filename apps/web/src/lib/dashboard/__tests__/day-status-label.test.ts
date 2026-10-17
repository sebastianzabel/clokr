// Issue #587 (P-06) — the ONE web vocabulary for a person's day status. The API decides the
// status; this module only words it. The page sources are read (not mounted) because both pages
// import `$app/*`, which the web test config does not alias (same remedy as
// dashboard-leave-type-code.test.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DAY_STATUS_LABEL, attendanceStatusText, teamMissingTitle } from "../day-status-label";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const REPORTS = readRouteFile(
  "../../../routes/(app)/reports/+page.svelte",
  "src/routes/(app)/reports/+page.svelte",
);
const DASHBOARD = readRouteFile(
  "../../../routes/(app)/dashboard/+page.svelte",
  "src/routes/(app)/dashboard/+page.svelte",
);

describe("DAY_STATUS_LABEL", () => {
  it("words all eight statuses", () => {
    expect(DAY_STATUS_LABEL).toEqual({
      present: "Anwesend",
      clocked_in: "Eingestempelt",
      absent: "Abwesend",
      missing: "Fehlt",
      scheduled: "Geplant",
      requested: "Beantragt",
      holiday: "Feiertag",
      none: "—",
    });
  });
});

describe("attendanceStatusText", () => {
  const row = (status: string, extra: Record<string, unknown> = {}) => ({
    status,
    reason: null,
    ...extra,
  });

  it("names the reason of an absence and of a holiday, the plain word otherwise", () => {
    expect(attendanceStatusText(row("absent", { reason: "Urlaub" }))).toBe("Urlaub");
    expect(attendanceStatusText(row("absent"))).toBe("Abwesend");
    expect(attendanceStatusText(row("holiday", { reason: "Pfingstmontag" }))).toBe("Pfingstmontag");
    expect(attendanceStatusText(row("holiday"))).toBe("Feiertag");
    expect(attendanceStatusText(row("present"))).toBe("Anwesend");
    expect(attendanceStatusText(row("clocked_in"))).toBe("Eingestempelt");
    expect(attendanceStatusText(row("requested"))).toBe("Beantragt");
    expect(attendanceStatusText(row("none"))).toBe("—");
  });

  it("names the expected time and the minutes late of a missing row", () => {
    expect(attendanceStatusText(row("missing", { expectedStart: "09:00", lateMinutes: 180 }))).toBe(
      "Fehlt · erwartet 09:00 · 180 Min. zu spät",
    );
    expect(attendanceStatusText(row("missing", { expectedStart: "09:00", lateMinutes: 0 }))).toBe(
      "Fehlt · erwartet 09:00 · 0 Min. zu spät",
    );
  });

  it("falls back to the plain word without both values", () => {
    expect(attendanceStatusText(row("missing"))).toBe("Fehlt");
    expect(
      attendanceStatusText(row("missing", { expectedStart: "09:00", lateMinutes: null })),
    ).toBe("Fehlt");
    expect(attendanceStatusText(row("missing", { expectedStart: null, lateMinutes: 5 }))).toBe(
      "Fehlt",
    );
  });

  it("names the start of a scheduled row when there is one", () => {
    expect(attendanceStatusText(row("scheduled", { expectedStart: "14:00" }))).toBe(
      "Geplant · ab 14:00",
    );
    expect(attendanceStatusText(row("scheduled"))).toBe("Geplant");
  });

  it("reads an unknown status as a dash", () => {
    expect(attendanceStatusText(row("something-new"))).toBe("—");
  });
});

describe("teamMissingTitle", () => {
  it("names the shift times when the day has a shift", () => {
    expect(
      teamMissingTitle({ shift: { startTime: "09:00", endTime: "17:00" }, expectedHours: 8 }),
    ).toBe("Fehlt – erwartet 09:00–17:00");
  });

  it("names the contract day hours without a shift", () => {
    expect(teamMissingTitle({ shift: null, expectedHours: 8 })).toBe("Fehlt – erwartet 8:00 h");
    expect(teamMissingTitle({ expectedHours: 7.5 })).toBe("Fehlt – erwartet 7:30 h");
  });

  it("falls back to the plain workday wording without shift and hours", () => {
    expect(teamMissingTitle({ shift: null, expectedHours: 0 })).toBe("Fehlt – Arbeitstag");
    expect(teamMissingTitle({})).toBe("Fehlt – Arbeitstag");
  });
});

describe("page sources use the one vocabulary", () => {
  it("[vacuity gate] both page sources are loaded and contain their anchors", () => {
    expect(REPORTS.length).toBeGreaterThan(0);
    expect(DASHBOARD.length).toBeGreaterThan(0);
    expect(REPORTS).toContain("attendance-table");
    expect(DASHBOARD).toContain("team-grid__cell");
  });

  it("the reports page imports the module, keeps no local status-label switch and no „Fehlend“", () => {
    expect(REPORTS).toContain("day-status-label");
    expect(REPORTS).not.toContain("function statusLabel(");
    expect(REPORTS).not.toContain("Fehlend");
  });

  it("the dashboard „Fehlt“ cell title comes from teamMissingTitle", () => {
    expect(DASHBOARD).toContain("day-status-label");
    expect(DASHBOARD).toContain("teamMissingTitle(");
    expect(DASHBOARD).not.toContain('title="Fehlt! ');
  });
});
