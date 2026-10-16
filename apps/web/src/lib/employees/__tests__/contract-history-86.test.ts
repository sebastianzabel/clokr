// Issue #86 (D-01, AC-86-2) - the contract history rows of the Arbeitszeit tab.
import { describe, expect, it } from "vitest";
import { contractHistoryRows, type ContractHistoryInput } from "$lib/employees/contract-history";

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
    expect(out.map((r) => r.model)).toEqual(["Schichtplan", "Monatsstunden", "Fester Stundenplan"]);
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
