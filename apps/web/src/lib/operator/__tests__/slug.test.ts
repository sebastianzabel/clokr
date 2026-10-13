import { describe, expect, it } from "vitest";

import { isValidSlug, suggestSlug } from "../slug";

describe("suggestSlug", () => {
  it("lower-cases and hyphenates a plain name", () => {
    expect(suggestSlug("Beispiel Friseure GmbH")).toBe("beispiel-friseure-gmbh");
  });

  it("transliterates German umlauts and sharp s", () => {
    expect(suggestSlug("Müller Größe Äpfel Öl")).toBe("mueller-groesse-aepfel-oel");
    expect(suggestSlug("Maßstab")).toBe("massstab");
  });

  it("turns every other run of characters into one hyphen", () => {
    expect(suggestSlug("A & B -- Salon!!")).toBe("a-b-salon");
    expect(suggestSlug("  foo   bar  ")).toBe("foo-bar");
  });

  it("leaves no leading or trailing hyphen", () => {
    expect(suggestSlug("--abc--")).toBe("abc");
    expect(suggestSlug("(Haarwerk)")).toBe("haarwerk");
  });

  it("keeps digits and strips other diacritics", () => {
    expect(suggestSlug("Café 24")).toBe("cafe-24");
  });

  it("caps at 63 characters without a trailing hyphen", () => {
    const long = suggestSlug(`${"a".repeat(62)} bbbb`);
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long.endsWith("-")).toBe(false);
    expect(long).toBe("a".repeat(62));
    expect(suggestSlug("x".repeat(200))).toHaveLength(63);
  });

  it("returns an empty string when nothing usable is left", () => {
    expect(suggestSlug("")).toBe("");
    expect(suggestSlug("!!!")).toBe("");
  });

  it("only ever produces strings that match the slug pattern (when long enough)", () => {
    for (const name of ["Salon Süd-West", "Bäckerei  Nr. 1", "ÄÖÜ", "a b c d"]) {
      const slug = suggestSlug(name);
      if (slug.length >= 3) expect(isValidSlug(slug), name).toBe(true);
    }
  });
});

describe("isValidSlug", () => {
  it("accepts lower case, digits and single inner hyphens", () => {
    for (const ok of ["abc", "a-b", "salon-24", "a1b", "x".repeat(63)]) {
      expect(isValidSlug(ok), ok).toBe(true);
    }
  });

  it("rejects too short and too long", () => {
    expect(isValidSlug("ab")).toBe(false);
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("x".repeat(64))).toBe(false);
  });

  it("rejects upper case, spaces, underscores, umlauts and stray hyphens", () => {
    for (const bad of ["Abc", "a b", "a_b", "äbc", "-abc", "abc-", "a--b", "a.b"]) {
      expect(isValidSlug(bad), bad).toBe(false);
    }
  });
});
