// Issue #588 (P-14) - source pins: every personal saldo view hands the data to the label helper.
//
// The forecast of a personal saldo is worded by `lib/saldo/forecast-label.ts` from the server's
// `unconfirmedMonths` (and `hasClosedMonth`); a view that forgets to pass the number would fall back
// to the "unknown" wording and quietly read "Seit Monatsabschluss" for a genuine running month. These
// pins read the five consumers (dashboard tile, /leave KPI, the leave form, both Konto cards) and
// fail when the value stops flowing from the endpoint to the primitive. The behaviour of the
// primitives themselves is pinned by their mounted tests; the ban on a hard-coded wording is the
// guard `team-saldo-one-place-588.test.ts`.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

function srcRoot(): string {
  try {
    const fromHere = fileURLToPath(new URL("..", import.meta.url));
    readFileSync(join(fromHere, "lib/saldo/forecast-label.ts"), "utf8");
    return fromHere;
  } catch {
    // vitest may serve this file from a non-file URL: use the package root instead
    return resolve(process.cwd(), "src");
  }
}

const ROOT = srcRoot();
function read(rel: string): string {
  const text = readFileSync(join(ROOT, rel), "utf8");
  expect(text.length, `${rel} is empty`).toBeGreaterThan(1000);
  return text;
}

const DASHBOARD = "routes/(app)/dashboard/+page.svelte";
const LEAVE = "routes/(app)/leave/+page.svelte";
const FORM = "lib/components/leave/LeaveRequestForm.svelte";
const TIME_ENTRIES = "routes/(app)/time-entries/+page.svelte";
const TEAM_TIME_ENTRIES = "routes/(app)/team/time-entries/+page.svelte";
const KONTO = "routes/(app)/ich/konto/+page.svelte";

/** The markup of the first element opened by `open` up to its self-closing `/>`. */
function elementAfter(text: string, open: string, from = 0): string {
  const start = text.indexOf(open, from);
  expect(start, `${open} not found`).toBeGreaterThan(-1);
  const end = text.indexOf("/>", start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("personal saldo views pass the data to the forecast label (Issue #588, P-14)", () => {
  it("dashboard: the response type declares the count and the split tile passes it", () => {
    const text = read(DASHBOARD);
    expect(text).toMatch(/unconfirmedMonths\?: number \| null;/);
    const tile = elementAfter(
      text,
      "<SaldoAnzeige",
      text.indexOf("confirmedMinutes !== undefined"),
    );
    expect(tile).toContain("confirmedMinutes={stats.overtime.confirmedMinutes}");
    expect(tile).toMatch(/unconfirmedMonths=\{stats\.overtime\.unconfirmedMonths/);
    expect(tile).toContain("hasClosedMonth={stats.overtime.hasClosedMonth");
  });

  it("/leave shows no saldo; Ich › Konto words its forecast from forecastLabel (#851)", () => {
    // Phase 851 (prototype): the hours account moved to Ich › Konto (#594); /leave keeps no saldo
    // view, so it cannot word a forecast differently.
    const text = read(LEAVE);
    expect(text).not.toContain("<SaldoAnzeige");
    expect(text).not.toContain("/leave/overtime-balance");
    const konto = read("routes/(app)/ich/konto/+page.svelte");
    expect(konto).toContain("forecastLabel(overtime.unconfirmedMonths, overtime.hasClosedMonth)");
    expect(konto).toMatch(/unconfirmedMonths\?: number \| null;/);
  });

  it("leave form: the forecast row label comes from forecastLabel() and the masked branch clears the count", () => {
    const text = read(FORM);
    expect(text).toMatch(/from "\$lib\/saldo\/forecast-label"/);
    expect(text).toMatch(/\{forecastLabel\(unconfirmedMonths, hasClosedMonth\)\}/);
    expect(text).toMatch(/unconfirmedMonths\?: number \| null;/);
    expect(text).toMatch(/unconfirmedMonths = r\.unconfirmedMonths/);
    // The masked handling: the count is cleared next to the other split fields.
    const masked = text.slice(
      text.indexOf("if (r.balanceVisible === false) {"),
      text.indexOf("} else {", text.indexOf("if (r.balanceVisible === false) {")),
    );
    expect(masked).toContain("openMonthMinutes = undefined;");
    expect(masked).toContain("unconfirmedMonths = undefined;");
    // The compact confirmed-only primitive of the same box passes the count as well.
    const compact = elementAfter(text, "<SaldoAnzeige");
    expect(compact).toContain("{unconfirmedMonths}");
  });

  it("team/time-entries: the Konto card gets the count of /overtime/:id", () => {
    const text = read(TEAM_TIME_ENTRIES);
    expect(text).toMatch(/unconfirmedMonths\?: number \| null;/);
    expect(text).toContain("overtimeUnconfirmedMonths = overtimeValue?.unconfirmedMonths");
    const card = elementAfter(text, "<KontoSaldoCard");
    expect(card).toContain("unconfirmedMonths={overtimeUnconfirmedMonths}");
    expect(card).toContain("hasClosedMonth={overtimeHasClosedMonth}");
  });

  // Issue #851: the own account total left /time-entries for /ich/konto, which words its forecast
  // from the same two fields of /overtime/:id; /time-entries shows the month only.
  it("the own account total is worded on /ich/konto, and /time-entries shows none", () => {
    const konto = read(KONTO);
    expect(konto).toMatch(/unconfirmedMonths\?: number \| null;/);
    expect(konto).toContain("forecastLabel(overtime.unconfirmedMonths, overtime.hasClosedMonth)");
    const zeiten = read(TIME_ENTRIES);
    expect(zeiten.length).toBeGreaterThan(0);
    expect(zeiten).not.toContain("<KontoSaldoCard");
    expect(zeiten).not.toContain("/overtime/${activeEmpId}`");
  });

  it("team/time-entries resets the count together with the other split fields", () => {
    const text = read(TEAM_TIME_ENTRIES);
    expect(text).toMatch(
      /overtimeHasClosedMonth = undefined;\s+overtimeUnconfirmedMonths = undefined;/,
    );
  });
});
