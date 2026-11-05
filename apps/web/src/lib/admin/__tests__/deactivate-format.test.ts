// Issue #615 (D-13) — the pure labels and figure lines of the deactivate dialog. The format module
// computes no date and no figure: it words what the server's preview returned.
import { describe, expect, it } from "vitest";
import type { PreviewAbsence, PreviewVacation } from "$lib/api/deactivate-preview";
import {
  absenceActionText,
  absenceCountsLine,
  absencePeriodText,
  absenceTypeLabel,
  initialExitDay,
  saldoLine,
  skipReasonText,
  vacationLines,
} from "../deactivate-format";

function row(over: Partial<PreviewAbsence> = {}): PreviewAbsence {
  return {
    entity: "LeaveRequest",
    id: "row-1",
    action: "CANCEL",
    reason: "AFTER_EXIT",
    typeCode: "VACATION",
    status: "APPROVED",
    startDate: "2026-11-16",
    endDate: "2026-11-18",
    newEndDate: null,
    days: 3,
    newDays: null,
    ...over,
  };
}

function vacation(over: Partial<PreviewVacation> = {}): PreviewVacation {
  return {
    year: 2026,
    entitlementDays: 30,
    storedEntitlementDays: 30,
    entitlementRecomputed: false,
    carriedOverEffectiveDays: 0,
    availableDays: 30,
    takenDays: 12,
    remainingAtExitDays: 18,
    asOf: "2026-11-05",
    ...over,
  };
}

describe("initialExitDay", () => {
  it("takes the stored exit date when it is today or earlier", () => {
    expect(initialExitDay({ today: "2026-11-05", storedExitDate: "2026-10-31" })).toBe(
      "2026-10-31",
    );
    expect(initialExitDay({ today: "2026-11-05", storedExitDate: "2026-11-05" })).toBe(
      "2026-11-05",
    );
  });
  it("takes today when the stored date is later or missing", () => {
    expect(initialExitDay({ today: "2026-11-05", storedExitDate: "2026-12-31" })).toBe(
      "2026-11-05",
    );
    expect(initialExitDay({ today: "2026-11-05", storedExitDate: null })).toBe("2026-11-05");
  });
});

describe("absence rows", () => {
  it("words the four actions", () => {
    expect(absenceActionText(row({ action: "CANCEL" }))).toBe("wird storniert");
    expect(absenceActionText(row({ action: "DELETE" }))).toBe("entfällt");
    expect(
      absenceActionText(
        row({ action: "SHORTEN", reason: "SPANS_EXIT", newEndDate: "2026-11-17", newDays: 2 }),
      ),
    ).toBe("wird auf den letzten Arbeitstag (17.11.2026) gekürzt");
    expect(absenceActionText(row({ action: "SKIP", reason: "CLOSED_MONTH" }))).toContain(
      "bleibt unverändert",
    );
  });
  it("gives every skip code its own text and an unknown code a neutral one", () => {
    const codes = [
      "CLOSED_MONTH",
      "PARENTAL_REDUCTION_ACTIVE",
      "CORRECTION_REFUSED",
      "SPANNING_ABSENCE",
    ];
    const texts = codes.map(skipReasonText);
    expect(new Set(texts).size).toBe(codes.length);
    for (const t of texts) expect(t).not.toMatch(/[A-Z]+_[A-Z]+/);
    expect(skipReasonText("SOMETHING_NEW")).toBe(
      "Der Eintrag kann nicht automatisch angepasst werden.",
    );
  });
  it("labels types by code and never shows the code for a known one", () => {
    expect(absenceTypeLabel("VACATION")).toBe("Urlaub");
    expect(absenceTypeLabel("SICK")).toBe("Krankmeldung");
    expect(absenceTypeLabel("VOCATIONAL_SCHOOL")).toBe("Berufsschule");
    expect(absenceTypeLabel("MATERNITY")).toBe("Mutterschutz");
    expect(absenceTypeLabel("UNHEARD_OF")).toBe("Abwesenheit");
  });
  it("writes the period as dd.mm.yyyy – dd.mm.yyyy", () => {
    expect(absencePeriodText(row())).toBe("16.11.2026 – 18.11.2026");
  });
});

describe("saldoLine", () => {
  it("shows ±H:MM with Stand gestern", () => {
    expect(
      saldoLine({
        saldo: { balanceMinutes: -12000, asOf: "2026-11-04" },
        saldoUnavailableReason: null,
      }),
    ).toBe("−200:00 h (Stand gestern, 04.11.2026)");
    expect(
      saldoLine({ saldo: { balanceMinutes: 0, asOf: "2026-11-04" }, saldoUnavailableReason: null }),
    ).toBe("±0:00 h (Stand gestern, 04.11.2026)");
  });
  it("shows one calm line and no number per unavailable reason", () => {
    for (const reason of ["NO_PERMISSION", "NOT_TRACKED", "UNAVAILABLE"] as const) {
      const line = saldoLine({ saldo: null, saldoUnavailableReason: reason });
      expect(line).not.toMatch(/\d/);
      expect(line.length).toBeGreaterThan(10);
    }
  });
});

describe("vacationLines", () => {
  it("shows the remaining days of the exit year", () => {
    expect(vacationLines({ vacation: vacation(), vacationUnavailableReason: null })).toEqual([
      "18 Tage Resturlaub im Austrittsjahr 2026",
    ]);
  });
  it("words negative remaining days as days taken beyond the entitlement", () => {
    const lines = vacationLines({
      vacation: vacation({ remainingAtExitDays: -2.5 }),
      vacationUnavailableReason: null,
    });
    expect(lines[0]).toBe("2,5 Tage mehr genommen als der Anspruch im Austrittsjahr 2026");
  });
  it("names the § 5 recompute when the entitlement changes", () => {
    const lines = vacationLines({
      vacation: vacation({ entitlementRecomputed: true, entitlementDays: 25 }),
      vacationUnavailableReason: null,
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("Der Anspruch 2026 wird nach § 5 BUrlG auf 25 Tage neu berechnet.");
  });
  it("shows one calm line per reason, and nothing for a refused day", () => {
    for (const reason of ["NO_PERMISSION", "NO_ENTITLEMENT", "UNAVAILABLE"] as const) {
      const lines = vacationLines({ vacation: null, vacationUnavailableReason: reason });
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toMatch(/\d/);
    }
    // A refused day and a not-yet-hired person (no exit year) show nothing extra.
    for (const reason of ["EXIT_DATE_REFUSED", "HIRE_IN_FUTURE"] as const) {
      expect(vacationLines({ vacation: null, vacationUnavailableReason: reason })).toEqual([]);
    }
  });
});

describe("absenceCountsLine", () => {
  it("words the counts per action without any type or date", () => {
    expect(absenceCountsLine({ CANCEL: 1, SHORTEN: 0, DELETE: 0, SKIP: 0 })).toBe(
      "1 Abwesenheit endet oder wird gekürzt. Einzelheiten siehst du mit deinen Rechten nicht.",
    );
    expect(absenceCountsLine({ CANCEL: 2, SHORTEN: 1, DELETE: 1, SKIP: 2 })).toBe(
      "4 Abwesenheiten enden oder werden gekürzt, 2 Abwesenheiten bleiben unverändert. Einzelheiten siehst du mit deinen Rechten nicht.",
    );
  });
  it("is null for nothing to say", () => {
    expect(absenceCountsLine({ CANCEL: 0, SHORTEN: 0, DELETE: 0, SKIP: 0 })).toBeNull();
    expect(absenceCountsLine(null)).toBeNull();
  });
});
