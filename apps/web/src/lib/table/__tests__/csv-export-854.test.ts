// Issue #854 (D-854-09, T-854-43) - rowsToCsv: format of the file and the formula guard, pinned to
// the rule of the API's csv-cell (same leading characters, same quoting).
import { afterEach, describe, expect, it, vi } from "vitest";
import { csvCell, CSV_BOM, downloadCsv, rowsToCsv } from "../csv-export";

afterEach(() => vi.restoreAllMocks());

const columns = [
  { key: "name", label: "Name" },
  { key: "email", label: "E-Mail" },
];

describe("rowsToCsv", () => {
  it("starts with the BOM, separates with ; and ends every line with CRLF", () => {
    const text = rowsToCsv(columns, [{ name: "Muster, Max", email: "max@beispiel.test" }]);
    expect(text.startsWith(CSV_BOM)).toBe(true);
    expect(text).toBe(`${CSV_BOM}Name;E-Mail\r\nMuster, Max;max@beispiel.test\r\n`);
  });

  it("exports `=SUM(1)` as `'=SUM(1)`", () => {
    expect(csvCell("=SUM(1)")).toBe("'=SUM(1)");
    const text = rowsToCsv(columns, [{ name: "=SUM(1)", email: "x@beispiel.test" }]);
    expect(text).toContain("\r\n'=SUM(1);x@beispiel.test\r\n");
  });

  it("guards every formula start character, in the head too", () => {
    for (const start of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(csvCell(`${start}x`).replace(/^"|"$/g, "").startsWith(`'${start}`)).toBe(true);
    }
    expect(rowsToCsv([{ key: "a", label: "=HEAD" }], [])).toContain("'=HEAD");
    expect(csvCell("harmlos-=")).toBe("harmlos-=");
  });

  it("quotes a cell with a separator, a quote or a line break and doubles the quote", () => {
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('sagt "hi"')).toBe('"sagt ""hi"""');
    expect(csvCell("zwei\nZeilen")).toBe('"zwei\nZeilen"');
    // Guard first, then quoting: a quoted formula keeps its apostrophe inside the quotes.
    expect(csvCell('=A1;"x"')).toBe('"\'=A1;""x"""');
  });

  it("writes null and undefined as an empty cell and exports only the given columns", () => {
    const text = rowsToCsv(columns, [{ name: "A", email: null, saldo: "+1:00" }]);
    expect(text).toBe(`${CSV_BOM}Name;E-Mail\r\nA;\r\n`);
    expect(text).not.toContain("saldo");
  });
});

describe("downloadCsv", () => {
  it("hands the text over as a named csv download and releases the object URL", () => {
    const create = vi.fn(() => "blob:test");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    downloadCsv("personen-2026-11-12.csv", "x");
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:test");
    vi.unstubAllGlobals();
  });
});
