// Issue #93 (AC-93-9) - German labels of the support views, keyed by control values. Every value of
// the schema enums has a label; an unknown value is shown raw, never hidden or thrown on.
import { describe, expect, it } from "vitest";

import {
  ABSENCE_SOURCE_LABELS,
  BREAK_STATUS_LABELS,
  EMPLOYEE_STATUS_LABELS,
  ENTRY_SOURCE_LABELS,
  ENTRY_TYPE_LABELS,
  FIGURES_BASIS_LABELS,
  INVALID_REASON_LABELS,
  LEAVE_STATUS_LABELS,
  LEAVE_TYPE_LABELS,
  SCHEDULE_TYPE_LABELS,
  formatSignedMinutes,
  formatMinutes,
  labelFor,
} from "../support-labels";

// Copied from packages/db/prisma/schema.prisma; the comment names the enum each list mirrors. A new
// enum value there must get a label here, which this list then has to be extended for.
const ENUMS: Array<[string, Readonly<Record<string, string>>, string[]]> = [
  // enum ScheduleType
  [
    "ScheduleType",
    SCHEDULE_TYPE_LABELS,
    ["FIXED_SCHEDULE", "FLEXTIME", "MONTHLY_HOURS", "SHIFT_BASED"],
  ],
  // enum TimeEntryType
  ["TimeEntryType", ENTRY_TYPE_LABELS, ["WORK", "OVERTIME", "PUBLIC_HOLIDAY"]],
  // enum TimeEntrySource
  ["TimeEntrySource", ENTRY_SOURCE_LABELS, ["NFC", "MOBILE", "MANUAL", "CORRECTION", "WIFI"]],
  // enum InvalidReasonCode
  [
    "InvalidReasonCode",
    INVALID_REASON_LABELS,
    [
      "MISSING_CLOCK_OUT",
      "LEAVE_CANCELLATION_PENDING",
      "RETRO_APPROVAL_PENDING",
      "LEGACY_UNMAPPED",
    ],
  ],
  // enum BreakStatus
  ["BreakStatus", BREAK_STATUS_LABELS, ["AUTO", "CONFIRMED", "WAIVED"]],
  // enum LeaveRequestStatus
  [
    "LeaveRequestStatus",
    LEAVE_STATUS_LABELS,
    ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "CANCELLATION_REQUESTED"],
  ],
  // enum LeaveTypeCode (also the type of an Absence)
  [
    "LeaveTypeCode",
    LEAVE_TYPE_LABELS,
    [
      "VACATION",
      "OVERTIME_COMP",
      "SPECIAL",
      "UNPAID",
      "SICK",
      "SICK_CHILD",
      "EDUCATION",
      "MATERNITY",
      "PARENTAL",
      "VOCATIONAL_SCHOOL",
      "OTHER",
    ],
  ],
  // enum AbsenceSource
  ["AbsenceSource", ABSENCE_SOURCE_LABELS, ["PATTERN", "MANUAL"]],
  // derived employee status of the support DTOs
  ["employee status", EMPLOYEE_STATUS_LABELS, ["ACTIVE", "EXITED", "ANONYMIZED"]],
  // figures basis of computeMonthReportFigures
  ["figures basis", FIGURES_BASIS_LABELS, ["snapshot", "fullMonth", "toDate", "untracked"]],
];

describe("support labels", () => {
  it.each(ENUMS)(
    "%s: every value has a German label, and the map has no extra keys",
    (_n, map, values) => {
      for (const value of values) {
        expect(map[value], `label of ${value}`).toBeTruthy();
        expect(map[value]).not.toBe(value);
      }
      expect(Object.keys(map).sort((a, b) => a.localeCompare(b))).toEqual(
        [...values].sort((a, b) => a.localeCompare(b)),
      );
    },
  );

  it("names the figures the operator expects", () => {
    expect(SCHEDULE_TYPE_LABELS.FIXED_SCHEDULE).toBe("Feste Arbeitszeiten");
    expect(SCHEDULE_TYPE_LABELS.FLEXTIME).toBe("Gleitzeit");
    expect(SCHEDULE_TYPE_LABELS.MONTHLY_HOURS).toBe("Monatsstunden");
    expect(SCHEDULE_TYPE_LABELS.SHIFT_BASED).toBe("Schichtbasiert");
    expect(BREAK_STATUS_LABELS.AUTO).toBe("Automatisch");
    expect(BREAK_STATUS_LABELS.CONFIRMED).toBe("Bestätigt");
    expect(BREAK_STATUS_LABELS.WAIVED).toBe("Durchgearbeitet");
    expect(FIGURES_BASIS_LABELS.snapshot).toBe("Abgeschlossen");
    expect(FIGURES_BASIS_LABELS.fullMonth).toBe("Ganzer Monat");
    expect(FIGURES_BASIS_LABELS.toDate).toBe("Bis heute");
    expect(FIGURES_BASIS_LABELS.untracked).toBe("Ohne Erfassung");
    expect(EMPLOYEE_STATUS_LABELS.ACTIVE).toBe("Aktiv");
    expect(EMPLOYEE_STATUS_LABELS.EXITED).toBe("Ausgetreten");
    expect(EMPLOYEE_STATUS_LABELS.ANONYMIZED).toBe("Gelöscht");
  });

  it("labelFor falls back to the raw value for an unknown or missing code", () => {
    expect(labelFor(BREAK_STATUS_LABELS, "AUTO")).toBe("Automatisch");
    expect(labelFor(BREAK_STATUS_LABELS, "SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(labelFor(BREAK_STATUS_LABELS, "constructor")).toBe("constructor");
    expect(labelFor(BREAK_STATUS_LABELS, null)).toBe("–");
    expect(labelFor(BREAK_STATUS_LABELS, undefined)).toBe("–");
  });
});

describe("minute formatters", () => {
  it("formats h:mm without a sign", () => {
    expect(formatMinutes(0)).toBe("0:00");
    expect(formatMinutes(65)).toBe("1:05");
    expect(formatMinutes(2400)).toBe("40:00");
  });

  it("formats a saldo h:mm with an explicit sign", () => {
    expect(formatSignedMinutes(90)).toBe("+1:30");
    expect(formatSignedMinutes(-90)).toBe("−1:30");
    expect(formatSignedMinutes(0)).toBe("0:00");
    expect(formatSignedMinutes(-5)).toBe("−0:05");
  });

  it("rounds a fractional minute figure instead of printing it", () => {
    expect(formatMinutes(59.6)).toBe("1:00");
    expect(formatSignedMinutes(-0.4)).toBe("0:00");
  });
});
