// Issue #89 (D-07a, D-13) - the create-tenant form model: validation, the exact request body and
// the mapping of a failed response to a field by machine code.
import { describe, expect, it } from "vitest";

import { OperatorApiError } from "../client";
import {
  buildTenantBody,
  createFailureMessage,
  emptyTenantForm,
  serverFieldProblem,
  validateTenantForm,
  type TenantFormValues,
} from "../tenant-form";

function valid(overrides: Partial<TenantFormValues> = {}): TenantFormValues {
  return {
    name: "Beispiel Friseure GmbH",
    slug: "beispiel-friseure",
    federalState: "NIEDERSACHSEN",
    timezone: "",
    adminEmail: "admin@example.invalid",
    adminFirstName: "Vorname",
    adminLastName: "Nachname",
    adminEmployeeNumber: "",
    ...overrides,
  };
}

describe("emptyTenantForm", () => {
  it("starts with no Bundesland chosen", () => {
    expect(emptyTenantForm().federalState).toBe("");
  });
});

describe("validateTenantForm", () => {
  it("has no problem for a complete form", () => {
    expect(validateTenantForm(valid())).toEqual({});
  });

  it("flags every empty required field with its own code", () => {
    const problems = validateTenantForm(emptyTenantForm());
    expect(Object.fromEntries(Object.entries(problems).map(([k, v]) => [k, v.code]))).toEqual({
      name: "NAME_REQUIRED",
      slug: "SLUG_INVALID",
      "federal-state": "FEDERAL_STATE_REQUIRED",
      "admin-email": "EMAIL_INVALID",
      "admin-first-name": "FIRST_NAME_REQUIRED",
      "admin-last-name": "LAST_NAME_REQUIRED",
    });
  });

  it("uses the six texts of the contract", () => {
    const messages = Object.values(validateTenantForm(emptyTenantForm())).map((p) => p.message);
    expect(messages).toEqual([
      "Name ist erforderlich.",
      "Kurzname: 3 bis 63 Zeichen, nur Kleinbuchstaben, Ziffern und Bindestriche.",
      "Bundesland auswählen.",
      "Gültige E-Mail-Adresse eingeben.",
      "Vorname ist erforderlich.",
      "Nachname ist erforderlich.",
    ]);
  });

  it("treats a whitespace-only name or name part as empty", () => {
    const problems = validateTenantForm(
      valid({ name: "   ", adminFirstName: " ", adminLastName: "\t" }),
    );
    expect(Object.keys(problems).sort()).toEqual(["admin-first-name", "admin-last-name", "name"]);
  });

  it("rejects a name over 200 characters", () => {
    expect(validateTenantForm(valid({ name: "N".repeat(201) })).name?.code).toBe("NAME_REQUIRED");
    expect(validateTenantForm(valid({ name: "N".repeat(200) })).name).toBeUndefined();
  });

  it("rejects malformed e-mail addresses", () => {
    for (const bad of ["", "abc", "a@b", "a b@example.invalid", "@example.invalid"]) {
      expect(validateTenantForm(valid({ adminEmail: bad }))["admin-email"]?.code, bad).toBe(
        "EMAIL_INVALID",
      );
    }
  });

  it("rejects an invalid slug", () => {
    for (const bad of ["ab", "Abc", "a b", "-abc"]) {
      expect(validateTenantForm(valid({ slug: bad })).slug?.code, bad).toBe("SLUG_INVALID");
    }
  });

  it("needs no timezone and no employee number", () => {
    const problems = validateTenantForm(valid({ timezone: "", adminEmployeeNumber: "" }));
    expect(problems.timezone).toBeUndefined();
    expect(problems["admin-employee-number"]).toBeUndefined();
  });
});

describe("buildTenantBody", () => {
  it("builds exactly the documented keys and omits the empty optional ones", () => {
    expect(buildTenantBody(valid())).toEqual({
      name: "Beispiel Friseure GmbH",
      slug: "beispiel-friseure",
      federalState: "NIEDERSACHSEN",
      admin: {
        email: "admin@example.invalid",
        firstName: "Vorname",
        lastName: "Nachname",
      },
    });
    const body = buildTenantBody(valid());
    expect("timezone" in body).toBe(false);
    expect("employeeNumber" in body.admin).toBe(false);
  });

  it("trims text, lower-cases the e-mail and includes filled optional fields", () => {
    const body = buildTenantBody(
      valid({
        name: "  Salon  ",
        adminEmail: "  Admin@Example.INVALID ",
        adminFirstName: " Vorname ",
        adminLastName: " Nachname ",
        timezone: " Europe/Vienna ",
        adminEmployeeNumber: " P-1 ",
      }),
    );
    expect(body).toEqual({
      name: "Salon",
      slug: "beispiel-friseure",
      federalState: "NIEDERSACHSEN",
      timezone: "Europe/Vienna",
      admin: {
        email: "admin@example.invalid",
        firstName: "Vorname",
        lastName: "Nachname",
        employeeNumber: "P-1",
      },
    });
  });

  it("refuses to build without a Bundesland", () => {
    expect(() => buildTenantBody(valid({ federalState: "" }))).toThrow();
  });
});

describe("serverFieldProblem", () => {
  it("maps 409 SLUG_TAKEN to the slug field", () => {
    const err = new OperatorApiError(409, "SLUG_TAKEN", "Dieser Kurzname ist bereits vergeben.");
    expect(serverFieldProblem(err)).toEqual({
      field: "slug",
      problem: { code: "SLUG_TAKEN", message: "Dieser Kurzname ist bereits vergeben." },
    });
  });

  it("maps 409 EMAIL_TAKEN to the admin e-mail field", () => {
    const err = new OperatorApiError(409, "EMAIL_TAKEN", "x");
    expect(serverFieldProblem(err)).toEqual({
      field: "admin-email",
      problem: { code: "EMAIL_TAKEN", message: "Diese E-Mail-Adresse wird bereits verwendet." },
    });
  });

  it("keys on the code, not the German text", () => {
    const sameTextOtherCode = new OperatorApiError(
      409,
      "OTHER",
      "Dieser Kurzname ist bereits vergeben.",
    );
    expect(serverFieldProblem(sameTextOtherCode)).toBeNull();
    const otherTextRightCode = new OperatorApiError(409, "SLUG_TAKEN", "irgendwas");
    expect(serverFieldProblem(otherTextRightCode)?.field).toBe("slug");
  });

  it("maps a 400 whose details name the timezone", () => {
    const err = new OperatorApiError(400, undefined, "Validierungsfehler", {
      error: "Validierungsfehler",
      details: [{ path: ["timezone"], message: "Ungültige Zeitzone" }],
    });
    expect(serverFieldProblem(err)).toEqual({
      field: "timezone",
      problem: { code: "TIMEZONE_INVALID", message: "Ungültige Zeitzone." },
    });
  });

  it("does not map a 400 that names another field, or a message that merely says timezone", () => {
    const other = new OperatorApiError(400, undefined, "x", {
      details: [{ path: ["admin", "email"], message: "Invalid" }],
    });
    expect(serverFieldProblem(other)).toBeNull();
    const textOnly = new OperatorApiError(400, undefined, "timezone", {
      error: "timezone",
      message: "timezone: bad",
    });
    expect(serverFieldProblem(textOnly)).toBeNull();
  });

  it("ignores anything that is not an operator API error", () => {
    expect(serverFieldProblem(new TypeError("Failed to fetch"))).toBeNull();
    expect(serverFieldProblem(null)).toBeNull();
  });
});

describe("createFailureMessage", () => {
  it("names a lost connection, a rate limit and a server fault", () => {
    expect(createFailureMessage(new TypeError("Failed to fetch"))).toBe(
      "Keine Verbindung zum Server. Bitte erneut versuchen.",
    );
    expect(createFailureMessage(new OperatorApiError(429, undefined, "x"))).toBe(
      "Zu viele Anfragen. Bitte einen Moment warten und erneut versuchen.",
    );
    expect(createFailureMessage(new OperatorApiError(503, undefined, "x"))).toBe(
      "Der Server hat einen Fehler gemeldet. Bitte erneut versuchen.",
    );
  });

  it("falls back to a generic sentence otherwise", () => {
    expect(createFailureMessage(new OperatorApiError(400, undefined, "x"))).toContain(
      "konnte nicht angelegt werden",
    );
    expect(createFailureMessage(new Error("boom"))).toContain("konnte nicht angelegt werden");
  });
});
