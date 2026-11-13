// Issue #854 (AC-7, D-854-22, T-854-71): exactly ONE place in the web starts a DATEV download -
// Daten › Export. The two DATEV routes (`GET /reports/datev` for the whole company and
// `GET /reports/datev/employee` for one person) stay in the API, but no other web file may name
// them: the reports page, its export dialog and the person drill-down only LINK into the export
// page (`exportHref` of `$lib/export/export-centre`). A second caller would let the payroll file
// be made with a different salon rule, month hint or audit text than the one place decides.
//
// The scan walks every non-test `.svelte`/`.ts` file under `apps/web/src` with comments blanked
// (a comment may talk about the route) and looks for the request path. A scan that matches
// nothing reports OK forever, so the file proves its matcher can fail (positive controls),
// does not over-fire (negative controls), and that the walked set is not empty (floor).
import { describe, it, expect } from "vitest";

import { SRC_ROOT, walkFiles } from "./design-source-files";

/** The one file allowed to name a DATEV route. */
const DATEV_EXPORT_FILE = "routes/(app)/admin/export/+page.svelte";

/** The request paths of both DATEV routes (`/reports/datev`, `/reports/datev/employee`). */
const DATEV_PATH = /\/reports\/datev(?![\p{L}\p{N}_-])/u;

/** Blanks `text` but keeps its newlines. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/**
 * Blanks JS/TS comments and keeps string literals. A small scanner instead of a regex, because
 * `//` inside a string ("https://…") is no comment.
 */
function stripScriptComments(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === "/" && next === "/") {
      let j = i;
      while (j < code.length && code[j] !== "\n") j++;
      out += blank(code.slice(i, j));
      i = j;
    } else if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const j = end === -1 ? code.length : end + 2;
      out += blank(code.slice(i, j));
      i = j;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== ch) {
        if (code[j] === "\\") j++;
        j++;
      }
      out += code.slice(i, j + 1);
      i = j + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** The text a path scan looks at: HTML comments, `<style>` blocks and script comments are blanked. */
function scannable(rel: string, text: string): string {
  if (!rel.endsWith(".svelte")) return stripScriptComments(text);
  let out = text.replace(/<style[^>]*>[\s\S]*?<\/style>/g, (m) => blank(m));
  out = out.replace(/<!--[\s\S]*?-->/g, (m) => blank(m));
  out = out.replace(
    /(<script[^>]*>)([\s\S]*?)(<\/script>)/g,
    (_m, open: string, body: string, close: string) => open + stripScriptComments(body) + close,
  );
  return out;
}

/** True when the file names a DATEV request path outside a comment. */
function namesDatevRoute(rel: string, text: string): boolean {
  return DATEV_PATH.test(scannable(rel, text));
}

const FILES = walkFiles(SRC_ROOT, [".svelte", ".ts"], { includeTests: false });

describe("one DATEV path (AC-7)", () => {
  it("[vacuity gate] the walk found the source tree", () => {
    expect(FILES.length).toBeGreaterThan(300);
    expect(FILES.some((f) => f.rel === DATEV_EXPORT_FILE)).toBe(true);
  });

  it("only Daten › Export names a DATEV route, and it really does", () => {
    const holders = FILES.filter((f) => namesDatevRoute(f.rel, f.text)).map((f) => f.rel);
    expect(holders).toEqual([DATEV_EXPORT_FILE]);
  });

  it("the person drill-down links into the export page instead of starting a file", () => {
    const drilldown = FILES.find((f) => f.rel === "lib/components/reports/PersonDrilldown.svelte");
    expect(drilldown, "PersonDrilldown.svelte is in the walked set").toBeDefined();
    expect(drilldown!.text).toContain("exportHref(");
    expect(drilldown!.text).toContain("DATEV für diese Person");
    expect(drilldown!.text).not.toContain("onDownloadDatev");
  });
});

describe("DATEV path matcher - positive controls", () => {
  const flagged: Array<[string, string, string]> = [
    ["a request of the whole-company file", "x.ts", 'api.get("/reports/datev?year=2026&month=1")'],
    ["the person route", "x.ts", "await fetch(`/api/v1/reports/datev/employee?employeeId=${id}`)"],
    ["a path in a Svelte script", "x.svelte", '<script>\n  const p = "/reports/datev";\n</script>'],
    ["a path in markup", "x.svelte", '<a href="/api/v1/reports/datev?year=1">DATEV</a>'],
  ];
  for (const [label, rel, text] of flagged) {
    it(`control: flags ${label}`, () => {
      expect(namesDatevRoute(rel, text)).toBe(true);
    });
  }
});

describe("DATEV path matcher - negative controls", () => {
  const passed: Array<[string, string, string]> = [
    ["a line comment", "x.ts", "// GET /reports/datev is called on the export page\nconst a = 1;"],
    ["a block comment", "x.ts", "/* /reports/datev/employee */\nconst a = 1;"],
    ["an HTML comment", "x.svelte", "<!-- /reports/datev -->\n<p>ok</p>"],
    ["the link into the export page", "x.ts", 'const href = "/verwalten/daten/export?year=2026";'],
    ["another report route", "x.ts", 'api.get("/reports/datev-settings-unrelated")'],
    ["a monthly export route", "x.ts", 'api.get("/reports/monthly-export/pdf")'],
  ];
  for (const [label, rel, text] of passed) {
    it(`control: passes ${label}`, () => {
      expect(namesDatevRoute(rel, text)).toBe(false);
    });
  }
});
