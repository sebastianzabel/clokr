// Issue #588 (D-588-1) - the one-module guard for team saldo figures.
//
// `lib/reports/team-saldo.ts` is the ONLY web file that derives a team saldo figure: the median, the
// Top lists, the outlier rule and the saldo cells. A second median, a page-local mean over the
// overview rows, the fixed forecast literal in a table head or a compact `SaldoAnzeige` in the team
// overview would let two surfaces of the same app answer "how is the team doing?" differently.
//
// Rules (all scan non-test `.ts`/`.svelte` files under `apps/web/src`; comments are NOT excluded for
// R2/R4/R6 on purpose - a commented-out copy is still a copy):
//   R1  a file other than team-saldo.ts declares a function or arrow constant named like /median/i
//   R2  a file other than team-saldo.ts reduces over rows reading balanceHours, confirmedMinutes or
//       openMonthMinutes (register `R2_REGISTER` below: file + reason + owning issue, must resolve)
//   R3  the reports page or ExitedFinalSaldoSection.svelte does not import $lib/reports/team-saldo
//   R4  the fixed forecast literal appears in the reports page or ExitedFinalSaldoSection.svelte
//       (588-03 widens this to every web file outside lib/saldo/forecast-label.ts)
//   R5  the overview card region of the reports page contains a <SaldoAnzeige
//   R6  the average-saldo label of the former KPI appears in any walked file
// The walked set is asserted non-empty and to contain both anchor files (anti-vacuity).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const MODULE_FILE = "lib/reports/team-saldo.ts";
const PAGE_FILE = "routes/(app)/reports/+page.svelte";
const EXITED_FILE = "lib/components/reports/ExitedFinalSaldoSection.svelte";
const FORECAST_LITERAL = "Laufender Monat (Prognose)";
// Built from code points so this file does not itself contain the label it forbids.
const AVERAGE_LABEL = `${String.fromCharCode(0xd8)} Saldo`;

/** Legitimate exceptions of R2. Empty: no web file sums or averages overview-row saldo fields. */
const R2_REGISTER: ReadonlyArray<{ file: string; reason: string; issue: string }> = [];

function srcRoot(): string {
  try {
    const fromHere = fileURLToPath(new URL("..", import.meta.url));
    if (statSync(join(fromHere, MODULE_FILE)).isFile()) return fromHere;
  } catch {
    // vitest may serve this file from a non-file URL: use the package root instead
  }
  return resolve(process.cwd(), "src");
}

function walkSources(absDir: string, out: string[] = []): string[] {
  for (const name of readdirSync(absDir)) {
    if (name === "__tests__" || name === "node_modules" || name === ".svelte-kit") continue;
    const abs = join(absDir, name);
    if (statSync(abs).isDirectory()) {
      walkSources(abs, out);
    } else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(abs);
    }
  }
  return out;
}

const ROOT = srcRoot();
const WALKED = walkSources(ROOT);
const FILES: Array<{ rel: string; text: string }> = WALKED.map((f) => ({
  rel: relative(ROOT, f).split("\\").join("/"),
  text: readFileSync(f, "utf8"),
}));

const MEDIAN_FUNCTION = /function\s+\w*median\w*\s*\(/i;
const MEDIAN_ARROW =
  /(?:const|let|var)\s+\w*median\w*\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+)?=>|\w+\s*=>)/i;

/** R1: true when the source declares a median function or arrow constant. */
function declaresMedianFunction(source: string): boolean {
  return MEDIAN_FUNCTION.test(source) || MEDIAN_ARROW.test(source);
}

/** R2: true when a `.reduce(` callback reads one of the overview saldo fields. */
function reducesOverSaldoFields(source: string): boolean {
  const needle = ".reduce(";
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return false;
    let depth = 1;
    let i = at + needle.length;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    const call = source.slice(at, i);
    if (/\b(balanceHours|confirmedMinutes|openMonthMinutes)\b/.test(call)) return true;
    from = at + needle.length;
  }
}

function fileText(rel: string): string {
  const hit = FILES.find((f) => f.rel === rel);
  expect(hit, `walked set does not contain ${rel}`).toBeDefined();
  return hit!.text;
}

describe("team saldo figures live in one module (Issue #588, D-588-1)", () => {
  it("walks a real source tree (vacuity)", () => {
    // The literal is the floor (the vacuity gate only reads a numeric literal as proof).
    expect(WALKED.length).toBeGreaterThanOrEqual(150);
    const rels = FILES.map((f) => f.rel);
    expect(rels).toContain(MODULE_FILE);
    expect(rels).toContain(PAGE_FILE);
    expect(rels).toContain(EXITED_FILE);
    expect(rels.some((r) => r.includes("__tests__"))).toBe(false);
  });

  it("the scanners see what they must (self-test on synthetic sources)", () => {
    expect(declaresMedianFunction("function medianOf(v) { return 0; }")).toBe(true);
    expect(declaresMedianFunction("const teamMedian = (rows) => 0;")).toBe(true);
    expect(declaresMedianFunction("let median: number = compute()")).toBe(false);
    expect(declaresMedianFunction("value = teamSaldo.medianMinutes")).toBe(false);
    expect(reducesOverSaldoFields("rows.reduce((acc, r) => acc + r.balanceHours, 0)")).toBe(true);
    expect(
      reducesOverSaldoFields("xs.reduce((a, r) => a + Math.max(0, r.openMonthMinutes ?? 0), 0)"),
    ).toBe(true);
    expect(reducesOverSaldoFields("rows.reduce((acc, r) => acc + r.usedDays, 0)")).toBe(false);
  });

  it("R1: no file other than the module declares a median function", () => {
    const offenders = FILES.filter((f) => f.rel !== MODULE_FILE && declaresMedianFunction(f.text));
    expect(offenders.map((f) => f.rel)).toEqual([]);
    expect(declaresMedianFunction(fileText(MODULE_FILE))).toBe(true);
  });

  it("R2: no file other than the module reduces over overview saldo fields", () => {
    const registered = new Set(R2_REGISTER.map((e) => e.file));
    const offenders = FILES.filter(
      (f) => f.rel !== MODULE_FILE && !registered.has(f.rel) && reducesOverSaldoFields(f.text),
    );
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });

  it("R2 register: every entry still resolves to a file with a hit and carries a reason and an issue", () => {
    for (const entry of R2_REGISTER) {
      expect(entry.reason.length).toBeGreaterThan(10);
      expect(entry.issue).toMatch(/^#\d+$/);
      expect(reducesOverSaldoFields(fileText(entry.file))).toBe(true);
    }
  });

  it("R3: the reports page and the exited section read the module", () => {
    for (const rel of [PAGE_FILE, EXITED_FILE]) {
      expect(fileText(rel), rel).toMatch(/from "\$lib\/reports\/team-saldo"/);
    }
  });

  it("R4: the fixed forecast literal is in neither the reports page nor the exited section", () => {
    for (const rel of [PAGE_FILE, EXITED_FILE]) {
      expect(fileText(rel).includes(FORECAST_LITERAL), rel).toBe(false);
    }
  });

  it("R5: the overview card of the reports page renders no SaldoAnzeige", () => {
    const page = fileText(PAGE_FILE);
    const start = page.indexOf('<CardHeader title="Überstunden-Übersicht"');
    const end = page.indexOf("<ExitedFinalSaldoSection", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(page.slice(start, end).includes("<SaldoAnzeige")).toBe(false);
  });

  it("R6: the average-saldo label of the former KPI is gone from every walked file", () => {
    const offenders = FILES.filter((f) => f.text.includes(AVERAGE_LABEL));
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });
});
