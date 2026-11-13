// Issue #854 (D-854-06) - the create flow's model: four steps, per-step validation and the one body
// builder. The body snapshots are the shapes the former single-form handler sent.
import { describe, expect, it } from "vitest";

import {
  CREATE_STEPS,
  EMPTY_CONTEXT,
  emptyDraft,
  employeeCreatePayload,
  firstInvalidStep,
  statutoryMinimum,
  suggestedVacationDays,
  validateStep,
  type CreateContext,
  type CreatePersonDraft,
} from "../create-person";

const TODAY = "2026-11-12";

function draft(overrides: Partial<CreatePersonDraft> = {}): CreatePersonDraft {
  return {
    ...emptyDraft(TODAY),
    firstName: "Mia",
    lastName: "Muster",
    email: "mia.muster@example.invalid",
    employeeNumber: "E-100",
    hireDate: "2026-12-01",
    ...overrides,
  };
}

const CTX: CreateContext = {
  tenantDefaultVacationDays: 30,
  tenantDefaultApprenticeVacationDays: 28,
  homeSalonRequired: false,
};

describe("CREATE_STEPS", () => {
  it("names the four steps in order", () => {
    expect([...CREATE_STEPS]).toEqual(["person", "salon-rolle", "vertrag", "einladung"]);
  });
});

describe("validateStep('person')", () => {
  it("accepts a complete person", () => {
    expect(validateStep("person", draft())).toEqual({});
  });

  it("reports a missing last name and an invalid e-mail in German", () => {
    const errors = validateStep("person", draft({ lastName: "  ", email: "mia@" }));
    expect(errors.lastName).toBe("Gib den Nachnamen ein.");
    expect(errors.email).toBe("Diese E-Mail-Adresse ist nicht gültig.");
    expect(errors.firstName).toBeUndefined();
  });

  it("asks for an e-mail address, the number and the hire date", () => {
    const errors = validateStep("person", draft({ email: "", employeeNumber: "", hireDate: null }));
    expect(errors.email).toBe("Gib eine E-Mail-Adresse ein.");
    expect(errors.employeeNumber).toBe("Gib die Personalnummer ein.");
    expect(errors.hireDate).toBe("Wähle das Eintrittsdatum.");
  });

  it("does not require a birth date", () => {
    expect(validateStep("person", draft({ birthDate: null }))).toEqual({});
  });
});

describe("validateStep('salon-rolle')", () => {
  it("requires a Stammsalon only when the tenant asks for it", () => {
    expect(validateStep("salon-rolle", draft(), EMPTY_CONTEXT)).toEqual({});
    const ctx = { ...CTX, homeSalonRequired: true };
    expect(validateStep("salon-rolle", draft(), ctx).homeSalonId).toBe("Wähle den Stammsalon.");
    expect(validateStep("salon-rolle", draft({ homeSalonId: "s-1" }), ctx)).toEqual({});
  });
});

describe("validateStep('vertrag')", () => {
  it("accepts the defaults", () => {
    expect(validateStep("vertrag", draft(), CTX)).toEqual({});
  });

  it("needs weekly hours for a fixed schedule", () => {
    for (const weeklyHours of [null, 0, -1, 61]) {
      expect(validateStep("vertrag", draft({ weeklyHours }), CTX).weeklyHours).toBeDefined();
    }
  });

  it("lets monthly hours stay empty (pure time tracking) but bounds a typed value", () => {
    const monthly = draft({ scheduleType: "MONTHLY_HOURS", weeklyHours: null });
    expect(validateStep("vertrag", { ...monthly, monthlyHours: null }, CTX)).toEqual({});
    expect(
      validateStep("vertrag", { ...monthly, monthlyHours: 1000 }, CTX).monthlyHours,
    ).toBeDefined();
  });

  it("rejects a shift-based contract whose usual workdays are shorter than the contract days (Issue #481)", () => {
    const shift = draft({ scheduleType: "SHIFT_BASED", contractWorkDays: 4 });
    expect(validateStep("vertrag", { ...shift, usualWorkDays: [] }, CTX).usualWorkDays).toContain(
      "bei Schichtbetrieb Pflicht",
    );
    expect(
      validateStep("vertrag", { ...shift, usualWorkDays: [1, 2, 3] }, CTX).usualWorkDays,
    ).toContain("mindestens 4 Tage");
    expect(validateStep("vertrag", { ...shift, usualWorkDays: [1, 2, 3, 4] }, CTX)).toEqual({});
  });

  it("flags vacation days below the statutory minimum of the age", () => {
    const adult = draft({ annualVacationDays: 15 });
    expect(validateStep("vertrag", adult, CTX).annualVacationDays).toContain("§ 3 BUrlG");
    const minor = draft({ birthDate: "2010-05-01", annualVacationDays: 22 });
    expect(validateStep("vertrag", minor, CTX).annualVacationDays).toContain("§ 19 JArbSchG");
    expect(validateStep("vertrag", draft({ annualVacationDays: 24 }), CTX)).toEqual({});
  });
});

describe("validateStep('einladung')", () => {
  it("needs a password of 8 characters only when it is set directly", () => {
    expect(validateStep("einladung", draft({ usePassword: false }))).toEqual({});
    expect(validateStep("einladung", draft({ usePassword: true, password: "kurz" })).password).toBe(
      "Das Passwort braucht mindestens 8 Zeichen.",
    );
    expect(validateStep("einladung", draft({ usePassword: true, password: "lang-genug" }))).toEqual(
      {},
    );
  });
});

describe("firstInvalidStep", () => {
  it("returns the first step with a message, or null", () => {
    expect(firstInvalidStep(draft(), CTX)).toBeNull();
    expect(firstInvalidStep(draft({ lastName: "" }), CTX)).toBe("person");
    expect(firstInvalidStep(draft(), { ...CTX, homeSalonRequired: true })).toBe("salon-rolle");
    expect(firstInvalidStep(draft({ weeklyHours: 0 }), CTX)).toBe("vertrag");
    expect(firstInvalidStep(draft({ usePassword: true, password: "x" }), CTX)).toBe("einladung");
  });
});

describe("employeeCreatePayload - the body of the former handler", () => {
  it("FIXED_SCHEDULE: weekly hours, no core times, no usual workdays, vacation = Standard sent as null", () => {
    expect(employeeCreatePayload(draft({ annualVacationDays: 30 }), CTX)).toEqual({
      email: "mia.muster@example.invalid",
      firstName: "Mia",
      lastName: "Muster",
      employeeNumber: "E-100",
      hireDate: "2026-12-01T00:00:00.000Z",
      scheduleType: "FIXED_SCHEDULE",
      weeklyHours: 40,
      monthlyHours: null,
      coreStart: null,
      coreEnd: null,
      coreDays: [],
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      classification: "VOLLZEIT",
      coverageWeight: 1,
      requiresSupervision: false,
      birthDate: null,
      annualVacationDays: null,
    });
  });

  it("MONTHLY_HOURS: weekly hours 0 and the typed monthly hours", () => {
    const body = employeeCreatePayload(
      draft({ scheduleType: "MONTHLY_HOURS", weeklyHours: 40, monthlyHours: 15 }),
      CTX,
    );
    expect(body).toMatchObject({
      scheduleType: "MONTHLY_HOURS",
      weeklyHours: 0,
      monthlyHours: 15,
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      coreStart: null,
      coreDays: [],
    });
  });

  it("SHIFT_BASED: contract day count and sorted usual workdays, weekly hours kept", () => {
    const body = employeeCreatePayload(
      draft({
        scheduleType: "SHIFT_BASED",
        weeklyHours: 32,
        contractWorkDays: 4,
        usualWorkDays: [5, 1, 3, 1, 2],
        monthlyHours: 99,
      }),
      CTX,
    );
    expect(body).toMatchObject({
      scheduleType: "SHIFT_BASED",
      weeklyHours: 32,
      monthlyHours: null,
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [1, 2, 3, 5],
    });
  });

  it("FLEXTIME: core times and days travel, empty times become null", () => {
    const withCore = employeeCreatePayload(
      draft({ scheduleType: "FLEXTIME", coreStart: "09:00", coreEnd: "15:00", coreDays: [1, 2] }),
      CTX,
    );
    expect(withCore).toMatchObject({ coreStart: "09:00", coreEnd: "15:00", coreDays: [1, 2] });
    const without = employeeCreatePayload(draft({ scheduleType: "FLEXTIME" }), CTX);
    expect(without).toMatchObject({ coreStart: null, coreEnd: null, coreDays: [] });
  });

  it("carries the Stammsalon, the birth date and the password only when set", () => {
    const plain = employeeCreatePayload(draft(), CTX);
    expect(plain).not.toHaveProperty("homeSalonId");
    expect(plain).not.toHaveProperty("password");
    const full = employeeCreatePayload(
      draft({
        homeSalonId: "s-1",
        birthDate: "2000-02-29",
        usePassword: true,
        password: "geheim-123",
      }),
      CTX,
    );
    expect(full).toMatchObject({
      homeSalonId: "s-1",
      birthDate: "2000-02-29T00:00:00.000Z",
      password: "geheim-123",
    });
    // The password switch off drops a typed password.
    expect(
      employeeCreatePayload(draft({ usePassword: false, password: "geheim-123" }), CTX),
    ).not.toHaveProperty("password");
  });

  it("never sends a role or day hours (Issues #580, #848)", () => {
    for (const scheduleType of [
      "FIXED_SCHEDULE",
      "FLEXTIME",
      "MONTHLY_HOURS",
      "SHIFT_BASED",
    ] as const) {
      const keys = Object.keys(
        employeeCreatePayload(draft({ scheduleType, usualWorkDays: [1] }), CTX),
      );
      expect(keys).not.toContain("role");
      expect(
        keys.filter((k) => /Hours$/.test(k) && k !== "weeklyHours" && k !== "monthlyHours"),
      ).toEqual([]);
    }
  });

  it("builds the hire date from the picked day, whatever the time zone", () => {
    expect(employeeCreatePayload(draft({ hireDate: "2026-03-29" }), CTX).hireDate).toBe(
      "2026-03-29T00:00:00.000Z",
    );
  });

  it("trims the text fields", () => {
    const body = employeeCreatePayload(
      draft({ firstName: " Mia ", email: " mia@example.invalid ", employeeNumber: " E-1 " }),
      CTX,
    );
    expect(body).toMatchObject({
      firstName: "Mia",
      email: "mia@example.invalid",
      employeeNumber: "E-1",
    });
  });
});

describe("suggestedVacationDays and statutoryMinimum", () => {
  it("proposes the Standard of the classification, raised to the minimum of the age", () => {
    expect(suggestedVacationDays(draft(), CTX)).toBe(30);
    expect(suggestedVacationDays(draft({ classification: "AZUBI" }), CTX)).toBe(28);
    // A 15-year-old hired in 2026: 30 Werktage = 25 days in a five-day week, below both Standards.
    expect(suggestedVacationDays(draft({ birthDate: "2011-06-01" }), CTX)).toBe(30);
  });

  it("is null while the Standard is unknown", () => {
    expect(suggestedVacationDays(draft(), EMPTY_CONTEXT)).toBeNull();
  });

  it("falls back to the adult minimum without a birth date", () => {
    expect(statutoryMinimum(draft()).law).toBe("§ 3 BUrlG");
    expect(statutoryMinimum(draft({ birthDate: "2011-06-01" })).law).toBe("§ 19 JArbSchG");
  });
});
