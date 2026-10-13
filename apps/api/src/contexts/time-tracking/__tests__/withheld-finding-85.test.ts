// Issue #85 (D-07, D-12) - the neutral wording a withheld finding is replaced with. DB-free: the
// builder and the constants are pure. The text carries no digit, no provision, no category and no
// unit token on purpose - any of them would reveal time worked outside the reader's reach.

import { describe, it, expect } from "vitest";
import { withheldFindingWarning } from "../arbzg";
import {
  WITHHELD_FINDING_CODE,
  WITHHELD_FINDING_TEXT,
  WITHHELD_NOTICE_TITLE,
} from "../withheld-finding";

describe("Issue #85 D-07 - the neutral withheld-finding hint", () => {
  it("withheldFindingWarning() is exactly the neutral hint item", () => {
    expect(withheldFindingWarning()).toEqual({
      code: "FINDING_WITHHELD",
      severity: "warning",
      message: WITHHELD_FINDING_TEXT,
      hint: true,
    });
    expect(WITHHELD_FINDING_CODE).toBe("FINDING_WITHHELD");
  });

  it.each([
    ["WITHHELD_FINDING_TEXT", WITHHELD_FINDING_TEXT],
    ["WITHHELD_NOTICE_TITLE", WITHHELD_NOTICE_TITLE],
  ])("%s names no number, provision, category or unit", (_name, text) => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/\d/);
    expect(text).not.toContain("§");
    expect(text).not.toContain("Pause");
    expect(text).not.toContain("Höchstarbeitszeit");
    expect(text).not.toMatch(/\b(h|Std|Stunden?|Min|Minuten?)\b/);
  });

  it("two calls return equal but distinct objects (no shared mutable instance)", () => {
    const a = withheldFindingWarning();
    const b = withheldFindingWarning();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.message = "changed";
    expect(withheldFindingWarning().message).toBe(WITHHELD_FINDING_TEXT);
  });
});
