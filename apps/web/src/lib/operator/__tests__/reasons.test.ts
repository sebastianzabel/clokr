// Issue #89 (D-13, D-14a) - reason texts are chosen by the machine-readable code, never by a
// German string, and a known reason never carries a number.
import { describe, expect, it } from "vitest";

import {
  CONNECTION_TEXT,
  GENERIC_TEXT,
  RATE_LIMIT_TEXT,
  REASON_TEXTS,
  RESEND_REASON_TEXTS,
  SERVER_FAULT_TEXT,
  failureText,
  reasonText,
} from "../reasons";

const TENANT_CODES = [
  "TENANT_DEACTIVATED",
  "TENANT_IN_USE",
  "NO_PENDING_INVITATION",
  "ALREADY_DEACTIVATED",
  "NOT_DEACTIVATED",
  "SLUG_TAKEN",
  "EMAIL_TAKEN",
  "TENANT_NOT_FOUND",
];

describe("REASON_TEXTS", () => {
  it("covers every tenant lifecycle code", () => {
    expect(Object.keys(REASON_TEXTS)).toEqual(expect.arrayContaining(TENANT_CODES));
  });

  it("is count-free: no known reason contains a digit", () => {
    const texts = [
      ...Object.values(REASON_TEXTS),
      ...Object.values(RESEND_REASON_TEXTS),
      CONNECTION_TEXT,
      RATE_LIMIT_TEXT,
      SERVER_FAULT_TEXT,
      GENERIC_TEXT,
    ];
    expect(texts.length).toBeGreaterThan(TENANT_CODES.length);
    for (const text of texts) expect(text).not.toMatch(/\d/);
  });
});

describe("reasonText", () => {
  it("renders the console's sentence for a known code, whatever the server said", () => {
    expect(reasonText("TENANT_IN_USE", "x")).toBe(
      "Der Mandant ist bereits in Benutzung. Eine neue Einladung ist nicht nötig.",
    );
    expect(reasonText("NO_PENDING_INVITATION", "Irgendein anderer Text")).toBe(
      "Es gibt keine offene Einladung.",
    );
  });

  it("renders the server's error string for an unknown code", () => {
    expect(reasonText("SOMETHING_NEW", "Server sagt X")).toBe("Server sagt X");
  });

  it("chooses by code: the same server text under a known code does not leak through", () => {
    expect(reasonText("ALREADY_DEACTIVATED", "Server sagt X")).not.toBe("Server sagt X");
  });

  it("uses the status sentences when the answer has no code", () => {
    expect(reasonText(undefined, undefined, 0)).toBe(CONNECTION_TEXT);
    expect(reasonText(undefined, undefined, 429)).toBe(RATE_LIMIT_TEXT);
    expect(reasonText(undefined, undefined, 503)).toBe(SERVER_FAULT_TEXT);
    expect(reasonText(undefined, "Technische Meldung", 500)).toBe(SERVER_FAULT_TEXT);
  });

  it("falls back to the server string of a code-less answer, then to a generic sentence", () => {
    expect(reasonText(undefined, "Validierungsfehler", 400)).toBe("Validierungsfehler");
    expect(reasonText(undefined, undefined, 400)).toBe(GENERIC_TEXT);
    expect(reasonText(undefined, "   ", undefined)).toBe(GENERIC_TEXT);
  });

  it("lets an override win for the same code (the resend dialog)", () => {
    expect(
      reasonText("TENANT_DEACTIVATED", undefined, 409, { overrides: RESEND_REASON_TEXTS }),
    ).toBe("Der Mandant ist deaktiviert.");
    expect(reasonText("TENANT_DEACTIVATED", undefined, 409)).toBe(
      REASON_TEXTS["TENANT_DEACTIVATED"],
    );
  });
});

describe("failureText", () => {
  it("reads code, message and status of an API error structurally", () => {
    expect(failureText({ status: 409, code: "NOT_DEACTIVATED", message: "x" })).toBe(
      "Der Mandant ist nicht deaktiviert.",
    );
    expect(failureText({ status: 400, message: "Keine Änderungen" })).toBe("Keine Änderungen");
  });

  it("maps a failed fetch to the connection sentence", () => {
    expect(failureText(new TypeError("Failed to fetch"))).toBe(CONNECTION_TEXT);
  });

  it("maps a bare 404 to the tenant-not-found sentence", () => {
    expect(failureText({ status: 404, message: "Mandant nicht gefunden" })).toBe(
      "Mandant nicht gefunden.",
    );
  });

  it("is generic for anything unrecognisable", () => {
    expect(failureText(null)).toBe(GENERIC_TEXT);
    expect(failureText(new Error("boom"))).toBe(GENERIC_TEXT);
  });
});
