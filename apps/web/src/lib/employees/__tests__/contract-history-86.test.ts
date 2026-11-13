// Issue #86 (D-01, AC-86-2) - the contract history rows of the Arbeitszeit tab.
import { describe, expect, it } from "vitest";
import {
  contractHistoryRows,
  contractStatus,
  validityLabel,
  type ContractHistoryInput,
} from "$lib/employees/contract-history";

const rows: ContractHistoryInput[] = [
  { id: "a", type: "FIXED_SCHEDULE", validFrom: "2025-01-01T00:00:00.000Z", weeklyHours: "38.50" },
  {
    id: "c",
    type: "SHIFT_BASED",
    validFrom: "2026-07-01T00:00:00.000Z",
    contractWorkDaysPerWeek: 5,
  },
  { id: "b", type: "MONTHLY_HOURS", validFrom: "2025-10-01T00:00:00.000Z", monthlyHours: "60.00" },
];

describe("contractHistoryRows (Issue #86, D-01)", () => {
  it("lists newest first, the newest as „seit“, older rows as a closed period", () => {
    const out = contractHistoryRows(rows);
    expect(out.map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(out[0].period).toBe("seit 01.07.2026");
    expect(out[1].period).toBe("01.10.2025 – 30.06.2026");
    expect(out[2].period).toBe("01.01.2025 – 30.09.2025");
  });

  it("labels the model in German and formats the extent per type", () => {
    const out = contractHistoryRows(rows);
    expect(out.map((r) => r.model)).toEqual([
      "Nach Schichtplan",
      "Monatsstunden",
      "Feste Arbeitszeit",
    ]);
    expect(out.map((r) => r.extent)).toEqual(["5 Tage/Woche", "60 Std./Monat", "38,5 Std./Woche"]);
  });

  it("covers Gleitzeit and a missing figure", () => {
    const out = contractHistoryRows([
      { id: "x", type: "FLEXTIME", validFrom: "2026-01-01T00:00:00.000Z", weeklyHours: 20 },
      { id: "y", type: "MONTHLY_HOURS", validFrom: "2025-01-01T00:00:00.000Z", monthlyHours: null },
    ]);
    expect(out[0]).toMatchObject({ model: "Gleitzeit", extent: "20 Std./Woche" });
    expect(out[1].extent).toBe("–");
  });

  it("handles the empty input and does not mutate the input", () => {
    expect(contractHistoryRows([])).toEqual([]);
    const copy = rows.map((r) => r.id);
    contractHistoryRows(rows);
    expect(rows.map((r) => r.id)).toEqual(copy);
  });

  it("a single row is only „seit“", () => {
    const out = contractHistoryRows([rows[0]]);
    expect(out).toHaveLength(1);
    expect(out[0].period).toBe("seit 01.01.2025");
  });
});

// Issue #854 (D-854-07) - the timeline wording: validity of each version and where it stands today.
describe("validityLabel and contractStatus (Issue #854)", () => {
  const history: ContractHistoryInput[] = [
    {
      id: "a",
      type: "FIXED_SCHEDULE",
      validFrom: "2026-06-01T00:00:00.000Z",
      weeklyHours: "38.50",
    },
    { id: "b", type: "FLEXTIME", validFrom: "2026-12-01T00:00:00.000Z", weeklyHours: "30" },
    { id: "c", type: "MONTHLY_HOURS", validFrom: "2027-06-01T00:00:00.000Z", monthlyHours: "40" },
  ];

  it("carries the ISO start and end day of every version, newest first", () => {
    const out = contractHistoryRows(history);
    expect(out.map((r) => [r.id, r.startDay, r.endDay])).toEqual([
      ["c", "2027-06-01", null],
      ["b", "2026-12-01", "2027-05-31"],
      ["a", "2026-06-01", "2026-11-30"],
    ]);
  });

  it("words a closed version with its end and the newest one as aktuell", () => {
    const out = contractHistoryRows(history);
    expect(validityLabel(out[0])).toBe("ab 01.06.2027 · aktuell");
    expect(validityLabel(out[1])).toBe("ab 01.12.2026 · bis 31.05.2027");
    expect(validityLabel(out[2])).toBe("ab 01.06.2026 · bis 30.11.2026");
  });

  it("words a newest version that has not started yet as geplant once today is known", () => {
    const out = contractHistoryRows(history);
    expect(validityLabel(out[0], "2027-05-20")).toBe("ab 01.06.2027 · geplant");
    expect(validityLabel(out[0], "2027-06-01")).toBe("ab 01.06.2027 · aktuell");
  });

  it("names ended, running and planned versions against a calendar day", () => {
    const out = contractHistoryRows(history);
    expect(out.map((r) => contractStatus(r, "2026-12-15"))).toEqual([
      "PLANNED",
      "CURRENT",
      "ENDED",
    ]);
    // The last day of a version still counts as running.
    expect(contractStatus(out[2], "2026-11-30")).toBe("CURRENT");
    expect(contractStatus(out[1], "2027-05-31")).toBe("CURRENT");
    expect(contractStatus(out[1], "2027-06-01")).toBe("ENDED");
  });

  it("a single open-ended version is simply aktuell", () => {
    const out = contractHistoryRows([history[0]]);
    expect(validityLabel(out[0])).toBe("ab 01.06.2026 · aktuell");
    expect(contractStatus(out[0], "2026-06-01")).toBe("CURRENT");
  });
});
