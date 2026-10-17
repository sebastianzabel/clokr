/**
 * Issue #617 (D-617-3) - the ONE place PDF numbers become German text. Input is always minutes
 * (never rounded hours), output never carries a decimal point between digits and never "1 Tage".
 */
import { describe, it, expect } from "vitest";
import { fmtHM, fmtSignedHM, fmtDecimalDe, fmtDays } from "../pdf-format";

describe("pdf-format (Issue #617)", () => {
  it("fmtHM prints H:MM from minutes", () => {
    expect(fmtHM(9225)).toBe("153:45 h");
    expect(fmtHM(0)).toBe("0:00 h");
    expect(fmtHM(59.6)).toBe("1:00 h");
    expect(fmtHM(-30)).toBe("-0:30 h");
    expect(fmtHM(-125)).toBe("-2:05 h");
  });

  it("fmtSignedHM signs with an ASCII plus or hyphen and leaves zero unsigned", () => {
    expect(fmtSignedHM(750)).toBe("+12:30 h");
    expect(fmtSignedHM(-30)).toBe("-0:30 h");
    expect(fmtSignedHM(0)).toBe("0:00 h");
    expect(fmtSignedHM(0.4)).toBe("0:00 h");
    // the hyphen is ASCII: Helvetica / WinAnsi has no U+2212
    expect(fmtSignedHM(-30)).not.toContain("−");
  });

  it("fmtDecimalDe uses a comma and no trailing zeros", () => {
    expect(fmtDecimalDe(0.5)).toBe("0,5");
    expect(fmtDecimalDe(1)).toBe("1");
    expect(fmtDecimalDe(2.25)).toBe("2,25");
    expect(fmtDecimalDe(2.255, 1)).toBe("2,3");
    expect(fmtDecimalDe(152.5)).toBe("152,5");
    expect(fmtDecimalDe(0)).toBe("0");
    expect(fmtDecimalDe(-1.5)).toBe("-1,5");
    expect(fmtDecimalDe(1.999)).toBe("2");
  });

  it("fmtDays pluralises and uses the decimal comma", () => {
    expect(fmtDays(1)).toBe("1 Tag");
    expect(fmtDays(2)).toBe("2 Tage");
    expect(fmtDays(0.5)).toBe("0,5 Tage");
    expect(fmtDays(0)).toBe("0 Tage");
    expect(fmtDays(1.5)).toBe("1,5 Tage");
  });

  it("no output contains a decimal point between digits or a singular-plural slip", () => {
    const outputs = [
      fmtHM(9225),
      fmtHM(59.6),
      fmtSignedHM(750),
      fmtSignedHM(-30),
      fmtDecimalDe(2.25),
      fmtDecimalDe(0.5),
      fmtDays(1),
      fmtDays(2),
      fmtDays(0.5),
      fmtDays(12.25),
    ];
    expect(outputs.length).toBeGreaterThan(0);
    for (const out of outputs) {
      expect(out).not.toMatch(/\d\.\d/);
      expect(out).not.toContain("1 Tage");
    }
  });
});
