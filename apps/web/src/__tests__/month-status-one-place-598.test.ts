// Issue #598: a month has the same status name everywhere. `$lib/saldo/month-status` is the ONE source
// of the wording of a closed and an open month; this guard fails when
//   R1  a page that words a month's status (MONTH_STATUS_SITES) does not import the module, or spells
//       a month status itself - the two labels or a former variant ("Bis gestern", "Bestätigt",
//       "Geschlossen", "Gesperrt") as a string literal or as markup text;
//   R2  any other web file spells the closed-month label "Abgeschlossen" itself, unless it is listed in
//       OTHER_MEANINGS with the concept it names instead (a column of saldo minutes, a figure basis).
// A new page that shows a month's status is registered in MONTH_STATUS_SITES and reads the module.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { MONTH_STATUS_LABEL, monthStatusLabel } from "$lib/saldo/month-status";

const MODULE_FILE = "lib/saldo/month-status.ts";
const MODULE_IMPORT = "$lib/saldo/month-status";

/** Every file that words the status of a month (closed or open). */
const MONTH_STATUS_SITES = [
  "lib/me/zeiten-kpis.ts", // Ich › Zeiten, the Status cell
  "lib/me/konto.ts", // Ich › Konto rows (re-exports the label map)
  "routes/(app)/ich/konto/+page.svelte", // Ich › Konto chips
  "lib/components/reports/PersonDrilldown.svelte", // /reports person view, month table
  "routes/(app)/reports/+page.svelte", // /reports own month list and its KPI
  "routes/(app)/admin/month-close/+page.svelte", // Monatsabschluss: closed / open month
] as const;

/** Files whose "Abgeschlossen" names another concept than a month's status. */
const OTHER_MEANINGS: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "lib/components/reports/ExitedFinalSaldoSection.svelte",
    reason: "column header of the confirmed saldo minutes of an exited person, a figure, no status",
  },
  {
    file: "lib/operator/support-labels.ts",
    reason: "basis of the operator's month figures (stored snapshot vs. to-date), no month status",
  },
];

// Built from pieces so the variant list does not itself read as a spelling of a month status.
const LABELS = [MONTH_STATUS_LABEL.CLOSED, MONTH_STATUS_LABEL.OPEN];
const VARIANTS = ["Bis gestern", "Best" + "ätigt", "Geschlo" + "ssen", "Gesper" + "rt"];

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
    if (statSync(abs).isDirectory()) walkSources(abs, out);
    else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(abs);
  }
  return out;
}

const ROOT = srcRoot();
const FILES = walkSources(ROOT).map((f) => ({
  rel: relative(ROOT, f).split("\\").join("/"),
  text: readFileSync(f, "utf8"),
}));

function escape(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The word as a whole string literal, or as the whole text of a markup node / markup line. */
function spellsLabel(text: string, word: string): boolean {
  const w = escape(word);
  const literal = new RegExp(`(["'\`])\\s*${w}\\s*\\1`);
  const markup = new RegExp(`>\\s*${w}\\s*<|^\\s*${w}\\s*$|</span>\\s*${w}\\s*$`, "m");
  return literal.test(text) || markup.test(text);
}

function file(rel: string): string {
  const f = FILES.find((x) => x.rel === rel);
  if (!f) throw new Error(`walked set lacks ${rel}`);
  return f.text;
}

describe("month status has one wording (Issue #598)", () => {
  it("the module names a closed and an open month", () => {
    expect(MONTH_STATUS_LABEL).toEqual({ CLOSED: "Abgeschlossen", OPEN: "Offen" });
    expect(monthStatusLabel(true)).toBe("Abgeschlossen");
    expect(monthStatusLabel(false)).toBe("Offen");
  });

  it("the detector sees a literal and a markup spelling, and not a sentence", () => {
    expect(spellsLabel('label: "Abgeschlossen",', "Abgeschlossen")).toBe(true);
    expect(spellsLabel("<span>Offen</span>", "Offen")).toBe(true);
    expect(spellsLabel('  <span class="dot"></span>\n      Abgeschlossen\n', "Abgeschlossen")).toBe(
      true,
    );
    expect(spellsLabel("Offene Monate sind eine Prognose.", "Offen")).toBe(false); // a sentence
    expect(spellsLabel('"Der Monat ist abgeschlossen"', "Abgeschlossen")).toBe(false);
    expect(spellsLabel("{MONTH_STATUS_LABEL.CLOSED}", "Abgeschlossen")).toBe(false);
  });

  it("R1: every page that words a month's status reads the module and spells none itself", () => {
    expect(FILES.length).toBeGreaterThan(200); // non-vacuous walk
    const offenders: string[] = [];
    for (const rel of MONTH_STATUS_SITES) {
      const text = file(rel);
      if (!text.includes(MODULE_IMPORT)) offenders.push(`${rel}: does not import ${MODULE_IMPORT}`);
      for (const word of [...LABELS, ...VARIANTS]) {
        if (spellsLabel(text, word)) offenders.push(`${rel}: spells "${word}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("R1 also catches the markup form with a leading dot, as on /reports before #598", () => {
    expect(
      spellsLabel('<span class="chip chip-warn"><span class="dot"></span> Offen</span>', "Offen"),
    ).toBe(true);
  });

  it("R2: no other file spells the closed-month label, except where it names another concept", () => {
    const allowed = new Set([MODULE_FILE, ...OTHER_MEANINGS.map((o) => o.file)]);
    const offenders = FILES.filter(
      (f) => !allowed.has(f.rel) && spellsLabel(f.text, MONTH_STATUS_LABEL.CLOSED),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
    // Every listed exception still exists and still says it, so the list cannot rot silently.
    for (const o of OTHER_MEANINGS) {
      expect(o.reason.length).toBeGreaterThan(20);
      expect(spellsLabel(file(o.file), MONTH_STATUS_LABEL.CLOSED)).toBe(true);
    }
  });
});
