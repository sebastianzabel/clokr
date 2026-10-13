// Issue #89 (D-10) - the opening-hours helpers of the salon form.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DAY_NAMES,
  HOURS_MISSING_MESSAGE,
  HOURS_ORDER_MESSAGE,
  buildCreateSalonBody,
  defaultOpeningHours,
  diffSalonForm,
  emptySalonForm,
  isSalonFormValid,
  isValidPostalCode,
  prefillOpeningHours,
  salonFormFromSalon,
  validateOpeningHours,
  validateSalonForm,
} from "../opening-hours";
import type { OpeningHoursDay, OperatorSalon } from "../types";

describe("DAY_NAMES", () => {
  it("starts on Montag (index 0) and ends on Sonntag", () => {
    expect(DAY_NAMES).toHaveLength(7);
    expect(DAY_NAMES[0]).toBe("Montag");
    expect(DAY_NAMES[6]).toBe("Sonntag");
  });
});

describe("defaultOpeningHours", () => {
  it("is Montag-Samstag 08:00-20:00 open, Sonntag closed, with explicit times", () => {
    const hours = defaultOpeningHours();
    expect(hours.map((d) => d.day)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const entry of hours) {
      expect(entry.open).toBe("08:00");
      expect(entry.close).toBe("20:00");
    }
    expect(hours.slice(0, 6).every((d) => d.closed === false)).toBe(true);
    expect(hours[6]?.closed).toBe(true);
  });

  it("returns a fresh array each call", () => {
    const a = defaultOpeningHours();
    const first = a[0] as OpeningHoursDay;
    first.open = "10:00";
    expect(defaultOpeningHours()[0]?.open).toBe("08:00");
  });
});

// The web tree cannot import API code (`apps/web/Dockerfile` gate), so the API constant is read
// as TEXT, the same pattern as `lib/leave/__tests__/effective-leave-statuses.test.ts`.
function readApiFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const API_SOURCE = readApiFile(
  "../../../../../api/src/contexts/platform/facade/salons.ts",
  "../api/src/contexts/platform/facade/salons.ts",
);

function apiDefaultHours(): OpeningHoursDay[] {
  const match = API_SOURCE.match(/DEFAULT_SALON_OPENING_HOURS[^=]*=\s*\[([\s\S]*?)\n\];/);
  expect(match).not.toBeNull();
  const entries = match![1].match(/\{[^{}]*\}/g) ?? [];
  return entries.map((entry) => {
    const day = /day:\s*(\d+)/.exec(entry);
    const open = /open:\s*"([^"]+)"/.exec(entry);
    const close = /close:\s*"([^"]+)"/.exec(entry);
    expect(day && open && close, entry).toBeTruthy();
    return {
      day: Number(day![1]),
      open: open![1],
      close: close![1],
      closed: /closed:\s*true/.test(entry),
    };
  });
}

describe("defaultOpeningHours mirrors the API constant (Issue #89)", () => {
  it("[vacuity gate] the API source is loaded and declares the constant with seven entries", () => {
    expect(API_SOURCE.length).toBeGreaterThan(0);
    expect(API_SOURCE).toContain("DEFAULT_SALON_OPENING_HOURS");
    expect(apiDefaultHours()).toHaveLength(7);
  });

  it("equals the API's DEFAULT_SALON_OPENING_HOURS day by day (open, close, closed)", () => {
    expect(defaultOpeningHours()).toEqual(apiDefaultHours());
  });
});

describe("prefillOpeningHours", () => {
  const stored: OpeningHoursDay[] = [
    { day: 0, open: "08:00", close: "20:00" },
    { day: 1, open: "08:00", close: "20:00" },
    { day: 2, open: "08:00", close: "20:00" },
    { day: 3, open: "08:00", close: "20:00" },
    { day: 4, open: "08:00", close: "20:00" },
    { day: 5, open: "10:00", close: "16:00" },
    { day: 6, open: "08:00", close: "20:00", closed: true },
  ];

  it("copies the default salon's hours and normalises closed", () => {
    const copy = prefillOpeningHours({ openingHours: stored });
    expect(copy).toHaveLength(7);
    expect(copy[0]).toEqual({ day: 0, open: "08:00", close: "20:00", closed: false });
    expect(copy[5]).toEqual({ day: 5, open: "10:00", close: "16:00", closed: false });
    expect(copy[6]).toEqual({ day: 6, open: "08:00", close: "20:00", closed: true });
  });

  it("is a deep copy: mutating it leaves the source unchanged", () => {
    const source = structuredClone(stored);
    const copy = prefillOpeningHours({ openingHours: source });
    const monday = copy[0] as OpeningHoursDay;
    monday.open = "07:00";
    monday.closed = true;
    expect(source).toEqual(stored);
  });

  it("copies only the four wire fields", () => {
    const withExtra = stored.map((d) => ({ ...d, note: "x" }));
    const copy = prefillOpeningHours({ openingHours: withExtra });
    for (const entry of copy)
      expect(Object.keys(entry).sort()).toEqual(["close", "closed", "day", "open"]);
  });

  it("orders the copy by day even when the source is shuffled", () => {
    const shuffled = [...stored].reverse();
    expect(prefillOpeningHours({ openingHours: shuffled }).map((d) => d.day)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it("falls back to the default without a salon or without seven valid entries", () => {
    expect(prefillOpeningHours(null)).toEqual(defaultOpeningHours());
    expect(prefillOpeningHours(undefined)).toEqual(defaultOpeningHours());
    expect(prefillOpeningHours({ openingHours: [] })).toEqual(defaultOpeningHours());
    expect(prefillOpeningHours({ openingHours: stored.slice(0, 6) })).toEqual(
      defaultOpeningHours(),
    );
    const duplicated = stored.map((d) => ({ ...d, day: 0 }));
    expect(prefillOpeningHours({ openingHours: duplicated })).toEqual(defaultOpeningHours());
    const badTime = stored.map((d, i) => (i === 2 ? { ...d, open: "8:00" } : d));
    expect(prefillOpeningHours({ openingHours: badTime })).toEqual(defaultOpeningHours());
  });
});

describe("validateOpeningHours", () => {
  it("accepts the default", () => {
    expect(validateOpeningHours(defaultOpeningHours())).toEqual({});
  });

  it("reports an open day whose opening is not before its closing", () => {
    const days = defaultOpeningHours();
    (days[1] as OpeningHoursDay).open = "20:00";
    (days[3] as OpeningHoursDay).open = "21:00";
    expect(validateOpeningHours(days)).toEqual({
      1: HOURS_ORDER_MESSAGE,
      3: HOURS_ORDER_MESSAGE,
    });
    expect(HOURS_ORDER_MESSAGE).toBe("Die Öffnungszeit muss vor der Schließzeit liegen.");
  });

  it("ignores a closed day whatever its times are", () => {
    const days = defaultOpeningHours();
    Object.assign(days[5] as OpeningHoursDay, { open: "20:00", close: "08:00", closed: true });
    expect(validateOpeningHours(days)).toEqual({});
  });

  it("reports an open day with a cleared time", () => {
    const days = defaultOpeningHours();
    (days[2] as OpeningHoursDay).close = "";
    expect(validateOpeningHours(days)).toEqual({ 2: HOURS_MISSING_MESSAGE });
  });
});

describe("isValidPostalCode", () => {
  it("accepts empty and five digits", () => {
    expect(isValidPostalCode("")).toBe(true);
    expect(isValidPostalCode("12345")).toBe(true);
    expect(isValidPostalCode("01067")).toBe(true);
  });

  it("rejects everything else", () => {
    for (const bad of ["1234", "123456", "12a45", " 12345", "12 45"]) {
      expect(isValidPostalCode(bad), bad).toBe(false);
    }
  });
});

function loadedSalon(overrides: Partial<OperatorSalon> = {}): OperatorSalon {
  return {
    id: "s1",
    name: "Salon Beispiel",
    street: "Beispielweg 1",
    postalCode: "12345",
    city: "Beispielstadt",
    openingHours: defaultOpeningHours(),
    federalState: "NIEDERSACHSEN",
    isActive: true,
    deactivatedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    isDefault: false,
    coupling: null,
    ...overrides,
  };
}

describe("diffSalonForm", () => {
  const phorest = { provider: "PHOREST", externalBranchId: "branch-1" };

  it("is empty for an unchanged form", () => {
    const original = salonFormFromSalon(loadedSalon());
    expect(diffSalonForm(original, structuredClone(original))).toEqual({});
    const coupled = salonFormFromSalon(loadedSalon({ coupling: phorest }));
    expect(diffSalonForm(coupled, structuredClone(coupled))).toEqual({});
  });

  it("ignores surrounding whitespace and an address part that stays empty", () => {
    const original = salonFormFromSalon(loadedSalon({ street: null }));
    const form = { ...structuredClone(original), name: " Salon Beispiel ", street: "  " };
    expect(diffSalonForm(original, form)).toEqual({});
  });

  it("sends only the name for a name-only change", () => {
    const original = salonFormFromSalon(loadedSalon());
    expect(diffSalonForm(original, { ...structuredClone(original), name: " Neu " })).toEqual({
      name: "Neu",
    });
  });

  it("sends null for a cleared address field and the value for a changed one", () => {
    const original = salonFormFromSalon(loadedSalon());
    const form = { ...structuredClone(original), street: "", city: "Anderswo" };
    expect(diffSalonForm(original, form)).toEqual({ street: null, city: "Anderswo" });
  });

  it("sends the Bundesland only when it changed", () => {
    const original = salonFormFromSalon(loadedSalon());
    expect(
      diffSalonForm(original, { ...structuredClone(original), federalState: "BAYERN" }),
    ).toEqual({ federalState: "BAYERN" });
  });

  it("sends all seven explicit days when any day changed", () => {
    const original = salonFormFromSalon(loadedSalon());
    const form = structuredClone(original);
    (form.openingHours[2] as OpeningHoursDay).close = "19:00";
    const patch = diffSalonForm(original, form);
    expect(Object.keys(patch)).toEqual(["openingHours"]);
    expect(patch.openingHours).toHaveLength(7);
    expect(patch.openingHours?.[2]).toEqual({
      day: 2,
      open: "08:00",
      close: "19:00",
      closed: false,
    });
    for (const entry of patch.openingHours ?? []) {
      expect(Object.keys(entry).sort()).toEqual(["close", "closed", "day", "open"]);
    }
  });

  it("sends no hours for a day that was closed and reopened to the same times", () => {
    const original = salonFormFromSalon(loadedSalon());
    const form = structuredClone(original);
    (form.openingHours[1] as OpeningHoursDay).closed = true;
    (form.openingHours[1] as OpeningHoursDay).closed = false;
    expect(diffSalonForm(original, form)).toEqual({});
  });

  it("sets a coupling from Keine and replaces it with another branch, trimmed", () => {
    const none = salonFormFromSalon(loadedSalon());
    expect(
      diffSalonForm(none, {
        ...structuredClone(none),
        provider: "PHOREST",
        externalBranchId: " b-9 ",
      }),
    ).toEqual({ coupling: { externalBranchId: "b-9" } });

    const coupled = salonFormFromSalon(loadedSalon({ coupling: phorest }));
    expect(
      diffSalonForm(coupled, { ...structuredClone(coupled), externalBranchId: "branch-2" }),
    ).toEqual({ coupling: { externalBranchId: "branch-2" } });
  });

  it("removes a coupling with null and leaves the key out when it did not change", () => {
    const coupled = salonFormFromSalon(loadedSalon({ coupling: phorest }));
    expect(diffSalonForm(coupled, { ...structuredClone(coupled), provider: "NONE" })).toEqual({
      coupling: null,
    });
    expect("coupling" in diffSalonForm(coupled, { ...structuredClone(coupled), name: "X" })).toBe(
      false,
    );
  });
});

describe("salon form validity", () => {
  it("a new form starts invalid: no Bundesland and no name", () => {
    const form = emptySalonForm(null);
    expect(form.federalState).toBe("");
    expect(validateSalonForm(form)).toEqual({
      name: "Name ist erforderlich.",
      "federal-state": "Bundesland auswählen.",
    });
    expect(isSalonFormValid(form)).toBe(false);
  });

  it("is valid with a name and a Bundesland, and checks PLZ, hours and the Filialkennung", () => {
    const form = { ...emptySalonForm(null), name: "Salon", federalState: "BAYERN" as const };
    expect(isSalonFormValid(form)).toBe(true);
    expect(isSalonFormValid({ ...form, postalCode: "123" })).toBe(false);
    expect(validateSalonForm({ ...form, postalCode: "123" })["postal-code"]).toBe(
      "PLZ: 5 Ziffern.",
    );
    expect(isSalonFormValid({ ...form, provider: "PHOREST", externalBranchId: " " })).toBe(false);
    expect(isSalonFormValid({ ...form, provider: "PHOREST", externalBranchId: "b" })).toBe(true);
    const badHours = structuredClone(form);
    (badHours.openingHours[0] as OpeningHoursDay).open = "21:00";
    expect(isSalonFormValid(badHours)).toBe(false);
  });

  it("prefills the hours from the Standardsalon copy, not by reference", () => {
    const standard = loadedSalon({
      openingHours: defaultOpeningHours().map((d) => ({ ...d, open: "10:00" })),
    });
    const form = emptySalonForm(standard);
    expect(form.openingHours[0]?.open).toBe("10:00");
    (form.openingHours[0] as OpeningHoursDay).open = "11:00";
    expect(standard.openingHours[0]?.open).toBe("10:00");
  });
});

describe("buildCreateSalonBody", () => {
  it("sends all seven explicit days, the Bundesland and no coupling key for Keine", () => {
    const form = {
      ...emptySalonForm(null),
      name: " Salon ",
      federalState: "BAYERN" as const,
    };
    const body = buildCreateSalonBody(form);
    expect(body).toEqual({
      name: "Salon",
      openingHours: defaultOpeningHours(),
      federalState: "BAYERN",
    });
    expect("coupling" in body).toBe(false);
    expect(body.openingHours).toHaveLength(7);
  });

  it("includes filled address parts and a trimmed Phorest coupling", () => {
    const form = {
      ...emptySalonForm(null),
      name: "Salon",
      street: " Weg 1 ",
      postalCode: "12345",
      city: "Ort",
      federalState: "BAYERN" as const,
      provider: "PHOREST" as const,
      externalBranchId: " b-1 ",
    };
    expect(buildCreateSalonBody(form)).toMatchObject({
      street: "Weg 1",
      postalCode: "12345",
      city: "Ort",
      coupling: { externalBranchId: "b-1" },
    });
  });
});
