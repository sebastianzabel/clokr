// Issue #854 (D-854-04, #878) - the pure helpers of the per-section SaveBar.

import { describe, expect, it } from "vitest";

import { countChanges, pickSection, sameSettingValue, sectionErrors } from "../section-state";

describe("sameSettingValue", () => {
  it("compares primitives by value", () => {
    expect(sameSettingValue(5, 5)).toBe(true);
    expect(sameSettingValue(5, 6)).toBe(false);
    expect(sameSettingValue("a", "a")).toBe(true);
    expect(sameSettingValue(true, false)).toBe(false);
    expect(sameSettingValue(NaN, NaN)).toBe(true);
  });

  it("treats null and undefined as equal, but not null and an empty string or 0", () => {
    expect(sameSettingValue(null, undefined)).toBe(true);
    expect(sameSettingValue(undefined, undefined)).toBe(true);
    expect(sameSettingValue(null, "")).toBe(false);
    expect(sameSettingValue(null, 0)).toBe(false);
    expect(sameSettingValue("", undefined)).toBe(false);
  });

  it("compares arrays element-wise and order-sensitively", () => {
    expect(sameSettingValue([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBe(true);
    expect(sameSettingValue([1, 2, 3], [1, 2])).toBe(false);
    expect(sameSettingValue([1, 2], [2, 1])).toBe(false);
    expect(sameSettingValue([], [])).toBe(true);
    expect(sameSettingValue([], null)).toBe(false);
    expect(sameSettingValue([1], "1")).toBe(false);
  });

  it("compares plain objects key-wise, a missing key equals undefined", () => {
    expect(sameSettingValue({ a: 1, b: [1] }, { b: [1], a: 1 })).toBe(true);
    expect(sameSettingValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameSettingValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameSettingValue({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(sameSettingValue({}, [])).toBe(false);
  });
});

describe("countChanges", () => {
  const snapshot = { name: "Clokr", defaultWorkDays: [1, 2, 3, 4, 5], phone: null, other: 1 };

  it("is 0 for an untouched copy", () => {
    const values = { ...snapshot, defaultWorkDays: [...snapshot.defaultWorkDays] };
    expect(countChanges(snapshot, values, ["name", "defaultWorkDays", "phone"])).toBe(0);
  });

  it("counts every differing key once, arrays included", () => {
    const values = { ...snapshot, name: "Neu", defaultWorkDays: [1, 2, 3, 4] };
    expect(countChanges(snapshot, values, ["name", "defaultWorkDays", "phone"])).toBe(2);
  });

  it("separates null from an empty string", () => {
    const values = { ...snapshot, phone: "" as string | null };
    expect(countChanges(snapshot, values, ["phone"])).toBe(1);
  });

  it("ignores keys outside the section", () => {
    const values = { ...snapshot, other: 2 };
    expect(countChanges(snapshot, values, ["name", "phone"])).toBe(0);
  });

  it("is 0 for an empty key list", () => {
    expect(countChanges(snapshot, { ...snapshot, name: "x" }, [])).toBe(0);
  });
});

describe("pickSection", () => {
  const values = { name: "Clokr", defaultWorkDays: [1, 2], phone: null, other: 7 };

  it("carries exactly the listed keys", () => {
    const picked = pickSection(values, ["name", "defaultWorkDays"]);
    expect(Object.keys(picked).sort()).toEqual(["defaultWorkDays", "name"]);
    expect(picked).toEqual({ name: "Clokr", defaultWorkDays: [1, 2] });
  });

  it("never carries a key outside the list", () => {
    const picked = pickSection(values, ["phone"]) as Record<string, unknown>;
    expect("name" in picked).toBe(false);
    expect("other" in picked).toBe(false);
    expect(picked).toEqual({ phone: null });
  });

  it("returns a new object, not the source", () => {
    const picked = pickSection(values, ["name"]);
    expect(picked).not.toBe(values);
    values.name = "Changed";
    expect(picked.name).toBe("Clokr");
  });
});

describe("sectionErrors", () => {
  it("counts non-empty error strings only", () => {
    expect(sectionErrors({ a: "Pflichtfeld", b: "", c: null, d: undefined, e: "Zu lang" })).toBe(2);
  });

  it("is 0 for no errors", () => {
    expect(sectionErrors({})).toBe(0);
  });
});
