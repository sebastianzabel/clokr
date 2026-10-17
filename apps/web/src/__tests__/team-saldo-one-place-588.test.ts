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
//   R3  the reports team table (TimesAccountsTable.svelte, Issue #612: it replaced the overview
//       card of the reports page), ExitedFinalSaldoSection.svelte or the dashboard card
//       TeamSaldoCard.svelte does not import $lib/reports/team-saldo
//   R4  the running-month wording ("Laufender Monat (Prognose)" and the caption "inkl. laufendem
//       Monat") appears in ANY non-test web file outside lib/saldo/forecast-label.ts, comments
//       included (Issue #588, orchestrator decision 17.10.2026: AC-588-4 on every surface - the
//       ONE place of the wording is the helper; the API's PDF wording constants are a month-scoped
//       rule of their own and outside this walk by construction)
//   R5  the reports team table (the whole TimesAccountsTable.svelte file, Issue #612) contains a
//       <SaldoAnzeige
//   R6  the average-saldo label of the former KPI appears in any walked file
//   R7  SaldoAnzeige.svelte declares a string default for its forecastLabel prop, or
//       KontoSaldoCard.svelte carries a caption literal instead of the forecastCaption() call
//   R8  a <SaldoAnzeige call site in split mode (it passes confirmedMinutes) or a <KontoSaldoCard
//       call site passes neither unconfirmedMonths= (or its {shorthand}) nor forecastLabel=, i.e.
//       would show a forecast without the data that words it
// The walked set is asserted non-empty and to contain both anchor files (anti-vacuity).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const MODULE_FILE = "lib/reports/team-saldo.ts";
const PAGE_FILE = "routes/(app)/reports/+page.svelte";
const TABLE_FILE = "lib/components/reports/TimesAccountsTable.svelte"; // Issue #612
const EXITED_FILE = "lib/components/reports/ExitedFinalSaldoSection.svelte";
const CARD_FILE = "lib/components/dashboard/TeamSaldoCard.svelte";
const HELPER_FILE = "lib/saldo/forecast-label.ts";
const SALDO_ANZEIGE_FILE = "lib/components/saldo/SaldoAnzeige.svelte";
const KONTO_CARD_FILE = "lib/components/saldo/KontoSaldoCard.svelte";
const FORECAST_LITERAL = "Laufender Monat (Prognose)";
const CAPTION_LITERAL = "inkl. laufendem Monat";
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

/** R8: the opening tags (up to the self-closing `/>`) of every `<component` call site in a source. */
function callSites(source: string, component: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(`<${component}`, from);
    if (at === -1) return out;
    const lineStart = source.lastIndexOf("\n", at) + 1;
    const before = source.slice(lineStart, at);
    const end = source.indexOf("/>", at);
    if (end === -1) return out;
    // A mention inside a comment or a template string is not a call site.
    if (!/\/\/|\*|`|<!--/.test(before)) out.push(source.slice(at, end));
    from = at + component.length + 1;
  }
}

/** R8: true when a call site hands the forecast its data (or names the wording explicitly). */
function passesForecastData(tag: string): boolean {
  return /\bunconfirmedMonths\b/.test(tag) || /\bforecastLabel=/.test(tag);
}

/** R7: a string default for the forecastLabel prop of SaldoAnzeige. */
function hasForecastLabelStringDefault(source: string): boolean {
  return /\bforecastLabel\s*=\s*["'`]/.test(source);
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
    expect(rels).toContain(TABLE_FILE);
    expect(rels).toContain(EXITED_FILE);
    expect(rels).toContain(CARD_FILE);
    expect(rels).toContain(HELPER_FILE);
    expect(rels).toContain(SALDO_ANZEIGE_FILE);
    expect(rels).toContain(KONTO_CARD_FILE);
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

  it("R3: the reports team table, the exited section and the dashboard card read the module", () => {
    for (const rel of [TABLE_FILE, EXITED_FILE, CARD_FILE]) {
      expect(fileText(rel), rel).toMatch(/from "\$lib\/reports\/team-saldo"/);
    }
  });

  it("R4: the running-month wording lives only in lib/saldo/forecast-label.ts", () => {
    const offenders = FILES.filter(
      (f) =>
        f.rel !== HELPER_FILE &&
        (f.text.includes(FORECAST_LITERAL) || f.text.includes(CAPTION_LITERAL)),
    );
    expect(offenders.map((f) => f.rel)).toEqual([]);
    // The helper is where the wording is: the walk would otherwise pass over a vanished literal.
    expect(fileText(HELPER_FILE)).toContain(FORECAST_LITERAL);
    expect(fileText(HELPER_FILE)).toContain(CAPTION_LITERAL);
  });

  it("R7: the two saldo primitives hold no forecast wording of their own", () => {
    const anzeige = fileText(SALDO_ANZEIGE_FILE);
    expect(hasForecastLabelStringDefault(anzeige)).toBe(false);
    expect(anzeige).toMatch(/from "\$lib\/saldo\/forecast-label"/);
    const card = fileText(KONTO_CARD_FILE);
    expect(card).toMatch(/from "\$lib\/saldo\/forecast-label"/);
    expect(card).toContain("forecastCaption(");
    expect(card.includes("inkl.")).toBe(false);
  });

  it("R7/R8 scanners see what they must (self-test on synthetic sources)", () => {
    expect(hasForecastLabelStringDefault('forecastLabel = "Laufender Monat (Prognose)",')).toBe(
      true,
    );
    expect(hasForecastLabelStringDefault("forecastLabel = undefined,")).toBe(false);
    expect(hasForecastLabelStringDefault("const effectiveForecastLabel = $derived(x)")).toBe(false);
    const sites = callSites(
      '<SaldoAnzeige a="1" confirmedMinutes={1} />\n<SaldoAnzeige b />',
      "SaldoAnzeige",
    );
    expect(sites).toHaveLength(2);
    expect(passesForecastData(sites[0])).toBe(false);
    expect(passesForecastData("<SaldoAnzeige confirmedMinutes={1} {unconfirmedMonths} ")).toBe(
      true,
    );
    expect(passesForecastData('<SaldoAnzeige confirmedMinutes={1} forecastLabel="x" ')).toBe(true);
    expect(passesForecastData("<KontoSaldoCard unconfirmedMonths={n} ")).toBe(true);
    expect(
      callSites("  // wraps `<SaldoAnzeige variant=x>` once\n  <SaldoAnzeige a />", "SaldoAnzeige"),
    ).toHaveLength(1);
  });

  it("R8: every forecast-showing call site passes the data that words it", () => {
    let splitSites = 0;
    let cardSites = 0;
    const offenders: string[] = [];
    for (const f of FILES) {
      if (!f.rel.endsWith(".svelte")) continue;
      for (const tag of callSites(f.text, "SaldoAnzeige")) {
        if (!/\bconfirmedMinutes\b/.test(tag)) continue; // single-value mode shows no forecast
        splitSites++;
        if (!passesForecastData(tag)) offenders.push(`${f.rel}: <SaldoAnzeige`);
      }
      for (const tag of callSites(f.text, "KontoSaldoCard")) {
        cardSites++;
        if (!passesForecastData(tag)) offenders.push(`${f.rel}: <KontoSaldoCard`);
      }
    }
    expect(offenders).toEqual([]);
    // Non-vacuity: dashboard tile, /leave KPI and the leave form's box (split SaldoAnzeige);
    // /time-entries and /team/time-entries (KontoSaldoCard), as found by Plan 588-03.
    expect(splitSites).toBeGreaterThanOrEqual(3);
    expect(cardSites).toBeGreaterThanOrEqual(2);
  });

  it("R5: the reports team table renders no SaldoAnzeige, and the page's overview card is gone", () => {
    expect(fileText(TABLE_FILE).length).toBeGreaterThan(2000);
    expect(fileText(TABLE_FILE).includes("<SaldoAnzeige")).toBe(false);
    // The former overview card region no longer exists on the page (Issue #612).
    expect(fileText(PAGE_FILE).includes('<CardHeader title="Überstunden-Übersicht"')).toBe(false);
  });

  it("R6: the average-saldo label of the former KPI is gone from every walked file", () => {
    const offenders = FILES.filter((f) => f.text.includes(AVERAGE_LABEL));
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });
});
