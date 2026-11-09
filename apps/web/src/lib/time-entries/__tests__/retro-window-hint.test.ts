// Issue #849 (5) — the form states the self-service retro window before a save is refused.
import { describe, it, expect } from "vitest";
import { earliestRetroDay, retroWindowHint } from "../retro-window-hint";

describe("retro window hint (Issue #849)", () => {
  it("names the window and the earliest day (today − n, as the API computes it)", () => {
    expect(earliestRetroDay("2026-11-09", 10)).toBe("2026-10-30");
    expect(retroWindowHint(10, "2026-11-09")).toBe(
      "Nachträge sind bis zu 10 Tage rückwirkend ohne Genehmigung möglich (ab 30.10.2026). Für frühere Tage stellst du einen Antrag.",
    );
    expect(retroWindowHint(1, "2026-03-01")).toContain("bis zu 1 Tag rückwirkend");
    expect(retroWindowHint(1, "2026-03-01")).toContain("(ab 28.02.2026)");
  });

  it("a zero window allows only today", () => {
    expect(retroWindowHint(0, "2026-11-09")).toMatch(/nur für heute/);
  });

  it("says nothing while the setting is unknown", () => {
    expect(retroWindowHint(undefined, "2026-11-09")).toBeNull();
    expect(retroWindowHint(null, "2026-11-09")).toBeNull();
  });
});
