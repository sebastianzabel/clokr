/**
 * Issue #573 (D-01…D-05, D-13) — Zod's default texts are German; a schema's own message wins; no
 * English default fragment survives any issue code; the summary names no field key.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import {
  germanZodMessage,
  registerGermanZodErrors,
  validationSummary,
  GENERIC_INVALID,
} from "../zod-german";
import { englishZodFragmentsIn } from "../../__tests__/english-zod-fragments";

function assertGerman(text: string) {
  expect(text.length).toBeGreaterThan(0);
  expect(englishZodFragmentsIn(text), text).toEqual([]);
}

const ALL_CODES = [
  "invalid_type",
  "too_small",
  "too_big",
  "invalid_format",
  "not_multiple_of",
  "unrecognized_keys",
  "invalid_union",
  "invalid_key",
  "invalid_element",
  "invalid_value",
  "custom",
  "some_future_code",
];

describe("germanZodMessage (Issue #573)", () => {
  it("answers every issue code in German, never empty, never an English default", () => {
    for (const code of ALL_CODES) assertGerman(germanZodMessage({ code }));
    for (const origin of ["string", "number", "int", "array", "set", "date", "file", "bigint"]) {
      assertGerman(germanZodMessage({ code: "too_small", origin, minimum: 3 }));
      assertGerman(germanZodMessage({ code: "too_big", origin, maximum: 3 }));
    }
    for (const format of [
      "email",
      "url",
      "uuid",
      "datetime",
      "date",
      "time",
      "regex",
      "ipv4",
      "jwt",
    ]) {
      assertGerman(germanZodMessage({ code: "invalid_format", format }));
    }
    for (const expected of ["number", "string", "boolean", "array", "date", "object", "weird"]) {
      assertGerman(germanZodMessage({ code: "invalid_type", expected, input: 1 }));
    }
  });

  it("names a missing field as Pflichtfeld and an explicit null as empty", () => {
    expect(germanZodMessage({ code: "invalid_type", expected: "string", input: undefined })).toBe(
      "Pflichtfeld.",
    );
    expect(germanZodMessage({ code: "invalid_type", expected: "string", input: null })).toBe(
      "Dieses Feld darf nicht leer sein.",
    );
  });
});

describe("registered map on real schemas (Issue #573)", () => {
  beforeAll(() => registerGermanZodErrors());

  it("replaces Zod's defaults", () => {
    const schema = z.object({
      email: z.string().email(),
      firstName: z.string().min(1),
      weeklyHours: z.number().min(0).max(60),
      role: z.enum(["ADMIN", "EMPLOYEE"]),
      hireDate: z.string().datetime(),
      workDays: z.array(z.number().int()).min(1),
    });
    const result = schema.safeParse({
      email: "x",
      firstName: "",
      weeklyHours: 99,
      role: "BOSS",
      hireDate: "gestern",
      workDays: [],
    });
    expect(result.success).toBe(false);
    const messages = result.error!.issues.map((i) => i.message);
    messages.forEach(assertGerman);
    expect(messages).toContain("Bitte gib eine gültige E-Mail-Adresse ein.");
    expect(messages).toContain("Pflichtfeld.");
    expect(messages).toContain("Der Wert darf höchstens 60 sein.");
    const missing = schema.safeParse({});
    missing.error!.issues.forEach((i) => expect(i.message).toBe("Pflichtfeld."));
  });

  it("keeps a schema's own message (precedence over the map)", () => {
    const schema = z.object({
      start: z.string().regex(/^\d{2}:\d{2}$/, "Format HH:MM erwartet"),
      name: z.string().min(1, "Name ist erforderlich"),
    });
    const result = schema.safeParse({ start: "8 Uhr", name: "" });
    expect(result.error!.issues.map((i) => i.message)).toEqual([
      "Format HH:MM erwartet",
      "Name ist erforderlich",
    ]);
  });

  it("a refine without a message reads German", () => {
    const schema = z.string().refine(() => false);
    expect(schema.safeParse("x").error!.issues[0].message).toBe(GENERIC_INVALID);
  });
});

describe("validationSummary (Issue #573, D-05)", () => {
  it("uses German labels, never the key, and collapses duplicates", () => {
    const summary = validationSummary([
      { path: ["firstName"], message: "Pflichtfeld." },
      { path: ["lastName"], message: "Pflichtfeld." },
      { path: ["holidayRulesValidFromYear"], message: "Bitte gib eine Zahl ein." },
      { path: ["breaks", 0, "startTime"], message: "Bitte gib eine gültige Uhrzeit an (HH:MM)." },
      { path: ["firstName"], message: "Pflichtfeld." },
    ]);
    expect(summary).toBe(
      "Vorname: Pflichtfeld.; Nachname: Pflichtfeld.; Bitte gib eine Zahl ein.; Beginn: Bitte gib eine gültige Uhrzeit an (HH:MM).",
    );
    expect(summary).not.toMatch(/firstName|lastName|holidayRules|startTime/);
  });
});
