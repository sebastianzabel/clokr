// Issue #583 (Phase 854, D-854-10) - the before/after rows of a Protokoll entry. Labels come from the
// shared vocabulary; a value is always text.
import { describe, expect, it } from "vitest";

import { auditEntryTitle, auditFieldRows, auditValueText } from "../field-diff";
import { AUDIT_FIELD_FALLBACK_LABEL, fieldLabel } from "../labels";

describe("auditFieldRows", () => {
  it("labels the fields from the vocabulary and marks the changed ones", () => {
    const rows = auditFieldRows(
      "TimeEntry",
      { startTime: "08:00" },
      { startTime: "09:00", note: "x" },
    );
    expect(rows).toHaveLength(2);
    const start = rows.find((r) => r.key === "startTime")!;
    expect(start.label).toBe(fieldLabel("TimeEntry", "startTime"));
    expect(start.label).not.toBe("startTime");
    expect(start).toMatchObject({ before: "08:00", after: "09:00", changed: true });
    const note = rows.find((r) => r.key === "note")!;
    expect(note).toMatchObject({ before: "—", after: "x", changed: true });
  });

  it("an unchanged field is listed but not marked", () => {
    const rows = auditFieldRows("TimeEntry", { note: "a", x: 1 }, { note: "a", x: 2 });
    expect(rows.find((r) => r.key === "note")!.changed).toBe(false);
    expect(rows.find((r) => r.key === "x")!.changed).toBe(true);
  });

  it("an unknown field reads the neutral fallback, never its key", () => {
    const [row] = auditFieldRows("TimeEntry", null, { someBrandNewColumn: 1 });
    expect(row.label).toBe(AUDIT_FIELD_FALLBACK_LABEL);
    expect(row.label).toBe("Weiteres Feld");
    expect(row.key).toBe("someBrandNewColumn");
  });

  it("omits the actor stamp of operator and system rows", () => {
    const rows = auditFieldRows("Salon", null, {
      name: "A",
      actor: { type: "OPERATOR", operatorId: "x" },
    });
    expect(rows.map((r) => r.key)).toEqual(["name"]);
  });

  it("a side that is not an object contributes no fields", () => {
    expect(auditFieldRows("TimeEntry", null, null)).toEqual([]);
    expect(auditFieldRows("TimeEntry", "text", [1, 2])).toEqual([]);
    expect(auditFieldRows("TimeEntry", undefined, { a: 1 })).toHaveLength(1);
  });

  it("lists a key only the old value had (a removed field)", () => {
    const rows = auditFieldRows("TimeEntry", { gone: "x", kept: 1 }, { kept: 1 });
    expect(rows.map((r) => r.key)).toEqual(["kept", "gone"]);
    expect(rows.find((r) => r.key === "gone")).toMatchObject({
      before: "x",
      after: "—",
      changed: true,
    });
  });

  it("compares nested values structurally", () => {
    const rows = auditFieldRows("Employee", { a: { x: [1, 2] } }, { a: { x: [1, 2] } });
    expect(rows[0].changed).toBe(false);
  });
});

describe("auditValueText", () => {
  it("renders booleans as Ja / Nein", () => {
    expect(auditValueText(true)).toBe("Ja");
    expect(auditValueText(false)).toBe("Nein");
  });

  it("renders null and undefined as a dash", () => {
    expect(auditValueText(null)).toBe("—");
    expect(auditValueText(undefined)).toBe("—");
  });

  it("renders an ISO timestamp as German date and time, and a day as a German date", () => {
    // 12:00 UTC is the same calendar day in every zone from -11 to +11.
    expect(auditValueText("2026-03-05T12:00:00.000Z")).toMatch(/^05\.03\.2026, \d{2}:\d{2}$/);
    expect(auditValueText("2026-03-05")).toBe("05.03.2026");
  });

  it("keeps a time of day, plain strings and numbers as stored", () => {
    expect(auditValueText("08:00")).toBe("08:00");
    expect(auditValueText("Frühschicht")).toBe("Frühschicht");
    expect(auditValueText(0)).toBe("0");
    expect(auditValueText(7.5)).toBe("7.5");
  });

  it("renders a nested object or array as one compact line", () => {
    expect(auditValueText({ a: 1, b: [2] })).toBe('{"a":1,"b":[2]}');
    expect(auditValueText([1, 2])).toBe("[1,2]");
  });

  it("never interprets markup: it stays text", () => {
    expect(auditValueText("<b>x</b>")).toBe("<b>x</b>");
  });
});

describe("auditEntryTitle", () => {
  it("composes the object and the action label", () => {
    expect(auditEntryTitle("UPDATE", "TimeEntry")).toBe("Zeiteintrag geändert");
    expect(auditEntryTitle("CREATE", "Employee")).toBe("Person angelegt");
  });

  it("an action label that already names the object stands alone", () => {
    expect(auditEntryTitle("LEAVE_CORRECTED", "Absence")).toBe("Abwesenheit korrigiert");
  });

  it("a several-word action label that does not name the object reads „Objekt: Aktion“", () => {
    expect(auditEntryTitle("LEAVE_CORRECTED", "LeaveRequest")).toBe(
      "Abwesenheitsantrag: Abwesenheit korrigiert",
    );
  });

  it("never shows a raw code, not even for an unknown pair", () => {
    const title = auditEntryTitle("SOME_NEW_ACTION", "SomeNewModel");
    expect(title).not.toMatch(/SOME_NEW|SomeNewModel/);
    expect(title.length).toBeGreaterThan(0);
  });
});
