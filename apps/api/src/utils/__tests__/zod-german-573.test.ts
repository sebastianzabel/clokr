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

  it("an integer field given a fraction asks for a whole number", () => {
    expect(z.number().int().safeParse(1.5).error!.issues[0].message).toBe(
      "Bitte gib eine ganze Zahl ein.",
    );
  });

  it("keeps own messages in every form the repo uses", () => {
    const viaError = z.string().min(3, { error: "Mindestens drei Zeichen, bitte" });
    const viaRefine = z.string().refine(() => false, { message: "Eigene Prüfung" });
    const viaSuper = z.string().superRefine((_v, ctx) => {
      ctx.addIssue({ code: "custom", message: "Eigene Super-Prüfung" });
    });
    expect(viaError.safeParse("a").error!.issues[0].message).toBe("Mindestens drei Zeichen, bitte");
    expect(viaRefine.safeParse("a").error!.issues[0].message).toBe("Eigene Prüfung");
    expect(viaSuper.safeParse("a").error!.issues[0].message).toBe("Eigene Super-Prüfung");
  });

  it("an unknown key is named as such, not as a missing field", () => {
    const result = z.object({ a: z.string() }).strict().safeParse({ a: "x", b: 1 });
    expect(result.error!.issues[0].message).toBe("Unbekanntes Feld.");
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
      "Vorname: Pflichtfeld.; Nachname: Pflichtfeld.; Beginn: Bitte gib eine gültige Uhrzeit an (HH:MM).; Bitte gib eine Zahl ein.",
    );
    expect(summary).not.toMatch(/firstName|lastName|holidayRules|startTime/);
  });

  it("counts unlabelled fields with the same text instead of collapsing them", () => {
    expect(
      validationSummary([
        { path: ["a1"], message: "Pflichtfeld." },
        { path: ["a2"], message: "Pflichtfeld." },
        { path: ["a3"], message: "Pflichtfeld." },
      ]),
    ).toBe("Pflichtfeld. (3 Felder)");
  });

  it("a short label inside another word is no reason to drop it", () => {
    expect(validationSummary([{ path: ["endDate"], message: "Bitte ein Datum wählen." }])).toBe(
      "Bis: Bitte ein Datum wählen.",
    );
  });

  it("a prototype key in a path never breaks the summary", () => {
    expect(validationSummary([{ path: ["constructor"], message: "Pflichtfeld." }])).toBe(
      "Pflichtfeld.",
    );
  });

  it("does not repeat a label the message already names", () => {
    expect(validationSummary([{ path: ["reason"], message: "Begründung ist erforderlich" }])).toBe(
      "Begründung ist erforderlich",
    );
  });
});
