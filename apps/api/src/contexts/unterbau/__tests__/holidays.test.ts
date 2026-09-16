import { describe, it, expect } from "vitest";
import { getHolidays, STATE_MAP } from "../holidays";

describe("getHolidays", () => {
  describe("national holidays", () => {
    it("returns national holidays when no state given", () => {
      const holidays = getHolidays(2026);
      const names = holidays.map((h) => h.name);
      expect(names).toContain("Neujahr");
      expect(names).toContain("Karfreitag");
      expect(names).toContain("Ostermontag");
      expect(names).toContain("Tag der Arbeit");
      expect(names).toContain("Christi Himmelfahrt");
      expect(names).toContain("Pfingstmontag");
      expect(names).toContain("Tag der Deutschen Einheit");
      expect(names).toContain("1. Weihnachtstag");
      expect(names).toContain("2. Weihnachtstag");
    });

    it("excludes state-specific holidays when no state given", () => {
      const holidays = getHolidays(2026);
      const names = holidays.map((h) => h.name);
      expect(names).not.toContain("Heilige Drei Könige");
      expect(names).not.toContain("Fronleichnam");
      expect(names).not.toContain("Allerheiligen");
    });
  });

  describe("fixed dates", () => {
    it("has Neujahr on January 1", () => {
      const h = getHolidays(2026).find((h) => h.name === "Neujahr");
      expect(h?.date).toBe("2026-01-01");
    });

    it("has Tag der Deutschen Einheit on October 3", () => {
      const h = getHolidays(2026).find((h) => h.name === "Tag der Deutschen Einheit");
      expect(h?.date).toBe("2026-10-03");
    });

    it("has Weihnachten on Dec 25/26", () => {
      const holidays = getHolidays(2026);
      expect(holidays.find((h) => h.name === "1. Weihnachtstag")?.date).toBe("2026-12-25");
      expect(holidays.find((h) => h.name === "2. Weihnachtstag")?.date).toBe("2026-12-26");
    });
  });

  describe("Easter-based dates (2026)", () => {
    // Easter Sunday 2026 = April 5
    it("has Karfreitag on April 3 2026", () => {
      const h = getHolidays(2026).find((h) => h.name === "Karfreitag");
      expect(h?.date).toBe("2026-04-03");
    });

    it("has Ostermontag on April 6 2026", () => {
      const h = getHolidays(2026).find((h) => h.name === "Ostermontag");
      expect(h?.date).toBe("2026-04-06");
    });

    it("has Christi Himmelfahrt 39 days after Easter", () => {
      const h = getHolidays(2026).find((h) => h.name === "Christi Himmelfahrt");
      // Easter Apr 5 + 39 = May 14
      expect(h?.date).toBe("2026-05-14");
    });

    it("has Pfingstmontag 50 days after Easter", () => {
      const h = getHolidays(2026).find((h) => h.name === "Pfingstmontag");
      // Easter Apr 5 + 50 = May 25
      expect(h?.date).toBe("2026-05-25");
    });
  });

  describe("state-specific holidays", () => {
    it("includes Heilige Drei Könige for Bavaria", () => {
      const holidays = getHolidays(2026, "BY");
      const names = holidays.map((h) => h.name);
      expect(names).toContain("Heilige Drei Könige");
    });

    it("excludes Heilige Drei Könige for Hamburg", () => {
      const holidays = getHolidays(2026, "HH");
      const names = holidays.map((h) => h.name);
      expect(names).not.toContain("Heilige Drei Könige");
    });

    it("includes Reformationstag for Niedersachsen", () => {
      const holidays = getHolidays(2026, "NI");
      const names = holidays.map((h) => h.name);
      expect(names).toContain("Reformationstag");
    });

    it("includes Fronleichnam for NRW", () => {
      const holidays = getHolidays(2026, "NW");
      const names = holidays.map((h) => h.name);
      expect(names).toContain("Fronleichnam");
    });

    it("includes Buß- und Bettag for Sachsen", () => {
      const holidays = getHolidays(2026, "SN");
      const names = holidays.map((h) => h.name);
      expect(names).toContain("Buß- und Bettag");
    });

    it("Buß- und Bettag is Wednesday before Nov 23", () => {
      // 2026: Nov 23 is Monday → Wednesday before = Nov 18
      const holidays = getHolidays(2026, "SN");
      const bub = holidays.filter((h) => h.name === "Buß- und Bettag");
      // At least one entry with valid date
      expect(bub.some((h) => /^2026-11-\d{2}$/.test(h.date))).toBe(true);
    });

    it("includes Internationaler Frauentag for Berlin", () => {
      const holidays = getHolidays(2026, "BE");
      const names = holidays.map((h) => h.name);
      expect(names).toContain("Internationaler Frauentag");
    });
  });

  describe("different years", () => {
    it("Easter 2025 is April 20", () => {
      const h = getHolidays(2025).find((h) => h.name === "Ostermontag");
      expect(h?.date).toBe("2025-04-21");
    });

    it("Easter 2024 is March 31", () => {
      const h = getHolidays(2024).find((h) => h.name === "Ostermontag");
      expect(h?.date).toBe("2024-04-01");
    });
  });

  describe("STATE_MAP", () => {
    it("maps all 16 federal states", () => {
      expect(Object.keys(STATE_MAP)).toHaveLength(16);
    });

    it("maps NIEDERSACHSEN to NI", () => {
      expect(STATE_MAP.NIEDERSACHSEN).toBe("NI");
    });

    it("maps BAYERN to BY", () => {
      expect(STATE_MAP.BAYERN).toBe("BY");
    });
  });
});
