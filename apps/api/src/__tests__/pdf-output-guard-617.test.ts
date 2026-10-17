/**
 * Issue #617 (D-617-3/5, AC-617-3, T-617-19) - no PDF module can fall back to a decimal point from
 * `.toFixed`, a locale formatter or the former indigo, and the brand colour of the documents is the
 * app's own.
 *
 * The guard walks the files named `pdf*.ts` under `apps/api/src/composition` (non-test; today
 * `pdf.ts` and `pdf-format.ts`), skips comment lines and trailing comments, and fails on a
 * statement that contains `.toFixed(`, `toLocaleDateString(`, `toLocaleString(` or one of the two
 * indigo values the documents used before #617. It also fails when `BRAND_COLOR` in `pdf.ts` differs
 * from the first `--brand:` value of `apps/web/src/tokens.css` (the default theme).
 *
 * The walked set is asserted non-empty first (at least the two modules above), and each rule is shown
 * red by a mutation of the REAL source text in this file (`.toFixed(2)` inserted into `pdf.ts`'s
 * source, `BRAND_COLOR` changed); the 617-05 SUMMARY additionally records the same two mutations
 * applied to the files on disk with the guard run against them.
 *
 * Named blind spots: a number formatted through a helper of another module is not seen (the
 * recording-stub tests of `monthly-export-render-617` and `stundennachweis-render-617` cover the
 * rendered text), and a decimal point built by string concatenation is not a pattern this guard
 * knows. It is a tripwire against the former shapes, not a proof of absence.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const COMPOSITION_DIR = resolve(__dirname, "..", "composition");
const TOKENS_CSS = resolve(__dirname, "..", "..", "..", "web", "src", "tokens.css");

const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: ".toFixed(", pattern: /\.toFixed\s*\(/ },
  { name: "toLocaleDateString(", pattern: /toLocaleDateString\s*\(/ },
  { name: "toLocaleString(", pattern: /toLocaleString\s*\(/ },
  { name: "indigo #4f46e5", pattern: /#4f46e5/i },
  { name: "indigo tint #d4d4f7", pattern: /#d4d4f7/i },
];

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** The code of a line without a trailing `// comment`. */
function codeOf(line: string): string {
  const idx = line.indexOf(" //");
  return idx === -1 ? line : line.slice(0, idx);
}

function walkPdfModules(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) continue; // __tests__ and any other subfolder are not PDF modules
    if (/^pdf.*\.ts$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out.sort();
}

/** The forbidden constructs found in one source text: `name:line` per hit. */
export function pdfOutputViolations(source: string): string[] {
  const hits: string[] = [];
  source.split("\n").forEach((line, i) => {
    if (isCommentLine(line)) return;
    const code = codeOf(line);
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(code)) hits.push(`${rule.name}:${i + 1}`);
    }
  });
  return hits;
}

/** The hex value `BRAND_COLOR` is declared with in a `pdf.ts` source text, or null. */
export function declaredBrandColor(source: string): string | null {
  const m = source.match(/const\s+BRAND_COLOR\s*=\s*"(#[0-9a-fA-F]{6})"/);
  return m ? m[1].toLowerCase() : null;
}

/** The first `--brand:` value of a stylesheet (the default theme), or null. */
export function firstBrandToken(css: string): string | null {
  const m = css.match(/--brand:\s*(#[0-9a-fA-F]{6})/);
  return m ? m[1].toLowerCase() : null;
}

describe("PDF output guard (Issue #617)", () => {
  const files = walkPdfModules(COMPOSITION_DIR);

  it("walks at least the two PDF modules", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.map((f) => f.slice(COMPOSITION_DIR.length + 1))).toEqual(
      expect.arrayContaining(["pdf.ts", "pdf-format.ts"]),
    );
  });

  it("no PDF module formats a number with .toFixed or a locale function, or names an indigo value", () => {
    for (const file of files) {
      expect(pdfOutputViolations(readFileSync(file, "utf8")), file).toEqual([]);
    }
  });

  it("BRAND_COLOR is the app's default brand token", () => {
    const pdfSource = readFileSync(join(COMPOSITION_DIR, "pdf.ts"), "utf8");
    const brand = declaredBrandColor(pdfSource);
    const token = firstBrandToken(readFileSync(TOKENS_CSS, "utf8"));
    expect(brand).not.toBeNull();
    expect(token).not.toBeNull();
    expect(brand).toBe(token);
  });

  describe("mutations of the real source turn each rule red", () => {
    const pdfSource = readFileSync(join(COMPOSITION_DIR, "pdf.ts"), "utf8");

    it("mutation 1: a .toFixed(2) inserted into pdf.ts is a violation", () => {
      expect(pdfOutputViolations(pdfSource)).toEqual([]);
      const mutated = pdfSource.replace(
        "export function pageFooterText",
        "const mutated = (1.5).toFixed(2);\nexport function pageFooterText",
      );
      expect(mutated).not.toBe(pdfSource);
      expect(pdfOutputViolations(mutated).some((h) => h.startsWith(".toFixed("))).toBe(true);
    });

    it("mutation 2: another BRAND_COLOR differs from the token", () => {
      const token = firstBrandToken(readFileSync(TOKENS_CSS, "utf8"));
      const mutated = pdfSource.replace(
        /(const\s+BRAND_COLOR\s*=\s*)"#[0-9a-fA-F]{6}"/,
        '$1"#4f46e5"',
      );
      expect(mutated).not.toBe(pdfSource);
      expect(declaredBrandColor(mutated)).not.toBe(token);
      expect(pdfOutputViolations(mutated).some((h) => h.startsWith("indigo #4f46e5"))).toBe(true);
    });

    it("a comment that names a forbidden construct is not a violation", () => {
      expect(pdfOutputViolations("// uses .toFixed( no more\n * toLocaleString(\n")).toEqual([]);
      expect(pdfOutputViolations("const a = 1; // not .toFixed(\n")).toEqual([]);
    });
  });
});
