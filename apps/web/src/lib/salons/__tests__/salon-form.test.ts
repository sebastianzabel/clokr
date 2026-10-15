// Issue #563 - the pure data rules of the tenant salon form: Bundesland list, validation, create body
// and the changed-keys-only patch, plus the source pins to the two server-side truths they mirror
// (the Prisma `FederalState` enum and the API's default opening-hours week).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { FEDERAL_STATE_OPTIONS, federalStateLabel } from "../federal-states";
import {
  DEFAULT_OPENING_HOURS,
  prefillOpeningHours,
  validateOpeningHours,
  type OpeningHoursDay,
} from "../opening-hours";
import {
  createSalonBody,
  emptySalonForm,
  salonPatch,
  salonToForm,
  validateSalonForm,
  type SalonDto,
} from "../salon-form";

function readRepoFile(relativeFromHere: string, relativeFromCwd: string): string {
  const fromHere = fileURLToPath(new URL(relativeFromHere, import.meta.url));
  const path = existsSync(fromHere) ? fromHere : resolve(process.cwd(), relativeFromCwd);
  // A moved file must fail with a clear message instead of an ENOENT stack.
  expect(existsSync(path), `source file missing: ${relativeFromCwd}`).toBe(true);
  return readFileSync(path, "utf8");
}

const SCHEMA = readRepoFile(
  "../../../../../../packages/db/prisma/schema.prisma",
  "../../packages/db/prisma/schema.prisma",
);
const API_SOURCE = readRepoFile(
  "../../../../../api/src/contexts/platform/facade/salons.ts",
  "../api/src/contexts/platform/facade/salons.ts",
);

function prismaFederalStates(): string[] {
  const match = /enum FederalState \{([^}]*)\}/.exec(SCHEMA);
  expect(match, "enum FederalState not found in schema.prisma").not.toBeNull();
  return (match?.[1] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));
}

function apiDefaultWeek(): OpeningHoursDay[] {
  const match = /DEFAULT_SALON_OPENING_HOURS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(API_SOURCE);
  expect(match, "DEFAULT_SALON_OPENING_HOURS not found in the API facade").not.toBeNull();
  const entries = match?.[1].match(/\{[^{}]*\}/g) ?? [];
  return entries.map((entry) => {
    const day = /day:\s*(\d+)/.exec(entry);
    const open = /open:\s*"([^"]+)"/.exec(entry);
    const close = /close:\s*"([^"]+)"/.exec(entry);
    expect(day && open && close, entry).toBeTruthy();
    return {
      day: Number(day?.[1]),
      open: open?.[1] ?? "",
      close: close?.[1] ?? "",
      closed: /closed:\s*true/.test(entry),
    };
  });
}

const STORED: SalonDto = {
  id: "salon-1",
  name: "Salon Nord",
  street: "Hauptstraße 1",
  postalCode: "30159",
  city: "Hannover",
  federalState: "NIEDERSACHSEN",
  openingHours: DEFAULT_OPENING_HOURS.map((d) => ({ ...d })),
  isActive: true,
  deactivatedAt: null,
};

describe("FEDERAL_STATE_OPTIONS", () => {
  it("[vacuity gate] the Prisma enum is parsed and has sixteen values", () => {
    expect(prismaFederalStates()).toHaveLength(16);
  });

  it("covers exactly the values of the Prisma enum, each once, with a German label", () => {
    const values = FEDERAL_STATE_OPTIONS.map((o) => o.value);
    expect([...values].sort((a, b) => a.localeCompare(b))).toEqual(
      [...prismaFederalStates()].sort((a, b) => a.localeCompare(b)),
    );
    expect(new Set(values).size).toBe(values.length);
    for (const option of FEDERAL_STATE_OPTIONS) {
      expect(option.label.trim().length, option.value).toBeGreaterThan(0);
      expect(option.label, option.value).not.toMatch(/_/);
    }
  });

  it("labels are the German state names", () => {
    expect(federalStateLabel("BADEN_WUERTTEMBERG")).toBe("Baden-Württemberg");
    expect(federalStateLabel("THUERINGEN")).toBe("Thüringen");
    expect(federalStateLabel("NORDRHEIN_WESTFALEN")).toBe("Nordrhein-Westfalen");
    expect(federalStateLabel("NIEDERSACHSEN")).toBe("Niedersachsen");
  });

  it("returns an unknown value as it is and an empty value as a dash", () => {
    expect(federalStateLabel("ATLANTIS")).toBe("ATLANTIS");
    expect(federalStateLabel(null)).toBe("—");
  });

  it("is sorted by German label", () => {
    const labels = FEDERAL_STATE_OPTIONS.map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, "de")));
  });
});

describe("DEFAULT_OPENING_HOURS mirrors the API constant", () => {
  it("[vacuity gate] the API source declares the constant with seven entries", () => {
    expect(apiDefaultWeek()).toHaveLength(7);
  });

  it("equals the API's DEFAULT_SALON_OPENING_HOURS day by day (open, close, closed)", () => {
    expect([...DEFAULT_OPENING_HOURS]).toEqual(apiDefaultWeek());
  });
});

describe("prefillOpeningHours", () => {
  it("returns a stored valid week sorted by day with an explicit closed flag", () => {
    const stored = [
      { day: 6, open: "10:00", close: "14:00" },
      { day: 0, open: "08:00", close: "20:00", closed: false },
      { day: 1, open: "08:00", close: "20:00" },
      { day: 2, open: "08:00", close: "20:00", closed: true },
      { day: 3, open: "08:00", close: "20:00" },
      { day: 4, open: "08:00", close: "20:00" },
      { day: 5, open: "08:00", close: "20:00" },
    ];
    const week = prefillOpeningHours(stored);
    expect(week.map((d) => d.day)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(week.every((d) => typeof d.closed === "boolean")).toBe(true);
    expect(week[2].closed).toBe(true);
    expect(week[6]).toEqual({ day: 6, open: "10:00", close: "14:00", closed: false });
  });

  it("falls back to the default week for six entries, a duplicate day or a non-array", () => {
    const six = DEFAULT_OPENING_HOURS.slice(0, 6).map((d) => ({ ...d }));
    const duplicate = DEFAULT_OPENING_HOURS.map((d, i) => ({ ...d, day: i === 6 ? 5 : d.day }));
    for (const raw of [six, duplicate, null, undefined, "x", {}]) {
      expect(prefillOpeningHours(raw)).toEqual([...DEFAULT_OPENING_HOURS]);
    }
  });

  it("returns a fresh copy of the default: mutating it never changes the constant", () => {
    const first = prefillOpeningHours(null);
    first[0].open = "01:00";
    first[0].closed = true;
    expect(DEFAULT_OPENING_HOURS[0].open).toBe("08:00");
    expect(DEFAULT_OPENING_HOURS[0].closed).toBe(false);
    expect(prefillOpeningHours(null)[0].open).toBe("08:00");
  });
});

describe("validateOpeningHours", () => {
  it("reports open >= close on an open day, on that day only", () => {
    const week = prefillOpeningHours(null);
    week[1].open = "20:00";
    week[1].close = "08:00";
    const errors = validateOpeningHours(week);
    expect(Object.keys(errors)).toEqual(["1"]);
    expect(errors[1]).toBe("Öffnung muss vor der Schließung liegen.");
  });

  it("never reports a closed day", () => {
    const week = prefillOpeningHours(null);
    week[1].open = "20:00";
    week[1].close = "08:00";
    week[1].closed = true;
    expect(validateOpeningHours(week)).toEqual({});
  });

  it("reports a malformed time", () => {
    const week = prefillOpeningHours(null);
    week[3].open = "25:99";
    expect(validateOpeningHours(week)[3]).toBe("Bitte eine gültige Uhrzeit angeben.");
  });

  it("is empty for the default week", () => {
    expect(validateOpeningHours(prefillOpeningHours(null))).toEqual({});
  });
});

describe("emptySalonForm / salonToForm", () => {
  it("starts a new salon with no Bundesland chosen and the default week", () => {
    const form = emptySalonForm();
    expect(form).toMatchObject({ name: "", street: "", postalCode: "", city: "" });
    expect(form.federalState).toBe("");
    expect(form.openingHours).toEqual([...DEFAULT_OPENING_HOURS]);
  });

  it("two empty forms never share their week", () => {
    const a = emptySalonForm();
    const b = emptySalonForm();
    a.openingHours[0].open = "09:00";
    expect(b.openingHours[0].open).toBe("08:00");
  });

  it("maps a stored salon to strings, a null address part to the empty string", () => {
    const form = salonToForm({ ...STORED, street: null, postalCode: null, city: null });
    expect(form).toMatchObject({
      name: "Salon Nord",
      street: "",
      postalCode: "",
      city: "",
      federalState: "NIEDERSACHSEN",
    });
  });
});

describe("validateSalonForm", () => {
  const valid = () => ({
    ...emptySalonForm(),
    name: "Neuer Salon",
    federalState: "BAYERN" as const,
  });

  it("accepts a complete create form", () => {
    expect(validateSalonForm(valid(), "create")).toEqual({});
  });

  it("requires a name", () => {
    expect(validateSalonForm({ ...valid(), name: "   " }, "create").name).toBe(
      "Bitte einen Namen angeben.",
    );
  });

  it("limits name, street, postal code and city to the server's lengths", () => {
    const errors = validateSalonForm(
      {
        ...valid(),
        name: "n".repeat(101),
        street: "s".repeat(201),
        postalCode: "p".repeat(21),
        city: "c".repeat(101),
      },
      "create",
    );
    expect(errors.name).toBe("Der Name darf höchstens 100 Zeichen lang sein.");
    expect(errors.street).toBe("Die Straße darf höchstens 200 Zeichen lang sein.");
    expect(errors.postalCode).toBe("Die Postleitzahl darf höchstens 20 Zeichen lang sein.");
    expect(errors.city).toBe("Der Ort darf höchstens 100 Zeichen lang sein.");
  });

  it("create mode requires an explicit Bundesland, edit mode does not re-require it", () => {
    const noState = { ...valid(), federalState: "" as const };
    expect(validateSalonForm(noState, "create").federalState).toBe("Bitte ein Bundesland wählen.");
    expect(validateSalonForm(noState, "edit").federalState).toBeUndefined();
  });

  it("flags a bad opening-hours row under openingHours", () => {
    const form = valid();
    form.openingHours[0].open = "21:00";
    expect(validateSalonForm(form, "create").openingHours).toBe(
      "Bitte prüfen Sie die markierten Tage.",
    );
  });
});

describe("createSalonBody", () => {
  it("trims, nulls empty address parts, carries the Bundesland and the week, never isActive", () => {
    const body = createSalonBody({
      ...emptySalonForm(),
      name: "  Neuer Salon  ",
      street: "",
      postalCode: " 30159 ",
      city: "   ",
      federalState: "SACHSEN",
    });
    expect(body).toEqual({
      name: "Neuer Salon",
      street: null,
      postalCode: "30159",
      city: null,
      federalState: "SACHSEN",
      openingHours: [...DEFAULT_OPENING_HOURS],
    });
    expect(Object.keys(body)).not.toContain("isActive");
  });

  it("refuses to build a body without a Bundesland", () => {
    expect(() => createSalonBody({ ...emptySalonForm(), name: "X" })).toThrow();
  });
});

describe("salonPatch", () => {
  it("is null when nothing changed - never an empty object", () => {
    expect(salonPatch(STORED, salonToForm(STORED))).toBeNull();
  });

  it("an address part that is empty in the form and null in the store is unchanged", () => {
    const stored = { ...STORED, street: null };
    expect(salonPatch(stored, salonToForm(stored))).toBeNull();
  });

  it("carries only the changed keys", () => {
    const form = salonToForm(STORED);
    form.name = "  Salon Süd ";
    form.city = "Celle";
    expect(salonPatch(STORED, form)).toEqual({ name: "Salon Süd", city: "Celle" });
  });

  it("clearing a stored address part sends null", () => {
    const form = { ...salonToForm(STORED), street: "  " };
    expect(salonPatch(STORED, form)).toEqual({ street: null });
  });

  it("sends federalState only when it differs from the stored one", () => {
    const same = salonToForm(STORED);
    expect(salonPatch(STORED, same)).toBeNull();
    expect(salonPatch(STORED, { ...same, federalState: "BAYERN" })).toEqual({
      federalState: "BAYERN",
    });
  });

  it("sends openingHours only when the week differs", () => {
    const form = salonToForm(STORED);
    form.openingHours[2].closed = true;
    const patch = salonPatch(STORED, form);
    expect(Object.keys(patch ?? {})).toEqual(["openingHours"]);
  });

  it("a stored week in another key order or without closed flags compares equal", () => {
    const stored: SalonDto = {
      ...STORED,
      openingHours: DEFAULT_OPENING_HOURS.map(({ day, open, close, closed }) =>
        closed ? { day, open, close, closed } : { day, open, close },
      ),
    };
    expect(salonPatch(stored, salonToForm(stored))).toBeNull();
  });
});
