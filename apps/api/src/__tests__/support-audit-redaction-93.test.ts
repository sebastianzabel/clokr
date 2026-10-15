/**
 * Issue #93 (Phase 93b-05, Task 1, D-17) — pure unit proofs of the type allow-list that decides what of a
 * stored audit value an operator may see. No database, no app: `redactSupportAuditValue` is a leaf function.
 *
 * The rule is by TYPE, never by key name, so each free-text case below is spelled with the key the real
 * writers use (`note`, `reviewNote`, `breakWaivedReason`, `documentPath`) and one future key that no code
 * knows yet (`freeTextComment`) must be redacted as well.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  SUPPORT_AUDIT_REDACTED,
  redactSupportAuditValue,
} from "../contexts/platform/support-audit-redaction";

describe("redactSupportAuditValue (D-17)", () => {
  it("uses the constant [ausgeblendet]", () => {
    expect(SUPPORT_AUDIT_REDACTED).toBe("[ausgeblendet]");
  });

  describe("values that stay", () => {
    const uuid = randomUUID();
    it.each([
      ["integer", 8],
      ["negative decimal", -1.5],
      ["zero", 0],
      ["true", true],
      ["false", false],
      ["null", null],
      ["numeric string", "8"],
      ["decimal string (Prisma Decimal)", "40.00"],
      ["negative decimal string", "-1.5"],
      ["ISO date", "2026-10-15"],
      ["ISO timestamp Z", "2026-10-15T08:00:00.000Z"],
      ["ISO timestamp without seconds", "2026-10-15T08:00Z"],
      ["ISO timestamp with offset", "2026-10-15T08:00:00+02:00"],
      ["UUID", uuid],
      ["enum APPROVED", "APPROVED"],
      ["enum SICK", "SICK"],
      ["UPPER_SNAKE action", "SUPPORT_DATA_READ"],
      ["role MANAGER", "MANAGER"],
      ["enum with digit", "TYPE_2"],
    ])("keeps %s", (_label, value) => {
      expect(redactSupportAuditValue(value)).toBe(value);
    });
  });

  describe("strings that are redacted", () => {
    it.each([
      ["note", "Arzttermin"],
      ["reviewNote", "abgelehnt wegen Personalmangel"],
      ["breakWaivedReason", "Kundin war im Stuhl"],
      ["documentPath", "absences/x/y.pdf"],
      ["e-mail", "someone@example.invalid"],
      ["anonymised first name", "Gelöscht"],
      ["anonymised last name", "GELÖSCHT-12"],
      ["time of day", "08:00"],
      ["German word", "Urlaub"],
      ["mixed case with underscore", "Abc_DEF"],
      ["lower snake", "some_value"],
      ["empty string", ""],
      ["whitespace", " "],
      ["date with trailing text", "2026-10-15 krank"],
      ["number with trailing text", "8 Stunden"],
      ["UPPER with space", "NICHT OK"],
      ["trailing underscore", "ABC_"],
    ])("redacts %s", (_label, value) => {
      expect(redactSupportAuditValue(value)).toBe(SUPPORT_AUDIT_REDACTED);
    });
  });

  it("redacts the text under the keys the real writers use and keeps structure", () => {
    const stored = {
      id: randomUUID(),
      status: "REJECTED",
      note: "Arzttermin",
      reviewNote: "abgelehnt wegen Personalmangel",
      breakWaivedReason: "Kundin war im Stuhl",
      documentPath: "absences/x/y.pdf",
      days: "2.5",
      halfDay: false,
      startDate: "2026-10-15",
      reviewedAt: null,
    };
    expect(redactSupportAuditValue(stored)).toEqual({
      id: stored.id,
      status: "REJECTED",
      note: SUPPORT_AUDIT_REDACTED,
      reviewNote: SUPPORT_AUDIT_REDACTED,
      breakWaivedReason: SUPPORT_AUDIT_REDACTED,
      documentPath: SUPPORT_AUDIT_REDACTED,
      days: "2.5",
      halfDay: false,
      startDate: "2026-10-15",
      reviewedAt: null,
    });
  });

  it("redacts a future unknown text key by type, not by key name", () => {
    expect(redactSupportAuditValue({ freeTextComment: "etwas Freies", count: 3 })).toEqual({
      freeTextComment: SUPPORT_AUDIT_REDACTED,
      count: 3,
    });
  });

  it("keeps nested keys and array length, redacting only the leaf strings", () => {
    const stored = {
      breaks: [
        { startTime: "2026-10-15T10:00:00.000Z", endTime: "2026-10-15T10:30:00.000Z" },
        { startTime: "2026-10-15T12:00:00.000Z", reason: "Zahnarzt" },
      ],
      tags: ["APPROVED", "frei formuliert", 4],
      nested: { deeper: { note: "geheim", code: "A_B" } },
    };
    expect(redactSupportAuditValue(stored)).toEqual({
      breaks: [
        { startTime: "2026-10-15T10:00:00.000Z", endTime: "2026-10-15T10:30:00.000Z" },
        { startTime: "2026-10-15T12:00:00.000Z", reason: SUPPORT_AUDIT_REDACTED },
      ],
      tags: ["APPROVED", SUPPORT_AUDIT_REDACTED, 4],
      nested: { deeper: { note: SUPPORT_AUDIT_REDACTED, code: "A_B" } },
    });
  });

  it("returns a top-level actor object exactly as stored (operator shape)", () => {
    const actor = { type: "OPERATOR", operatorId: randomUUID(), tenantId: randomUUID() };
    const out = redactSupportAuditValue({ actor, note: "Text" }) as { actor: unknown };
    expect(out.actor).toEqual(actor);
    expect(out).toEqual({ actor, note: SUPPORT_AUDIT_REDACTED });
  });

  it("returns a top-level actor object exactly as stored (script shape with free-looking strings)", () => {
    const actor = { type: "SCRIPT", user: "ops.person", host: "host-1.example.invalid" };
    expect(redactSupportAuditValue({ actor })).toEqual({ actor });
  });

  it("applies the actor exemption only to the top level of the passed value", () => {
    expect(
      redactSupportAuditValue({ inner: { actor: { type: "Operator", name: "Text" } } }),
    ).toEqual({
      inner: { actor: { type: SUPPORT_AUDIT_REDACTED, name: SUPPORT_AUDIT_REDACTED } },
    });
  });

  it("passes undefined through and keeps null", () => {
    expect(redactSupportAuditValue(undefined)).toBeUndefined();
    expect(redactSupportAuditValue(null)).toBeNull();
  });

  it("never mutates its input", () => {
    const input = {
      note: "Arzttermin",
      list: [{ text: "frei" }, "frei"],
      actor: { type: "OPERATOR", label: "Text" },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = redactSupportAuditValue(input);
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
  });

  it("redacts a bare top-level array of strings", () => {
    expect(redactSupportAuditValue(["APPROVED", "frei"])).toEqual([
      "APPROVED",
      SUPPORT_AUDIT_REDACTED,
    ]);
  });
});
