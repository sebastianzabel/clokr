// Quick task 260820-elk — format-minutes.ts coverage. Semantics must match the page's own
// fmtMin/fmtSigned (routes/(app)/time-entries/+page.svelte:779-812) verbatim.

import { describe, it, expect } from "vitest";
import { fmtMin, fmtSigned } from "../format-minutes";

describe("fmtMin", () => {
  it('formats 0 as "0:00"', () => {
    expect(fmtMin(0)).toBe("0:00");
  });

  it('formats 90 as "1:30"', () => {
    expect(fmtMin(90)).toBe("1:30");
  });

  it('formats 485 as "8:05" (zero-padded minutes)', () => {
    expect(fmtMin(485)).toBe("8:05");
  });
});

describe("fmtSigned", () => {
  it('formats 0 as "0:00" — no sign prefix', () => {
    expect(fmtSigned(0)).toBe("0:00");
  });

  it('formats 90 as "+1:30"', () => {
    expect(fmtSigned(90)).toBe("+1:30");
  });

  it("formats -90 with U+2212 MINUS SIGN, not ASCII hyphen", () => {
    const result = fmtSigned(-90);
    expect(result).toBe("−1:30");
    expect(result).not.toContain("-1:30"); // ASCII hyphen must not appear
  });
});
