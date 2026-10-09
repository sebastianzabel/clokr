// Quick 261009-bsb (Issue #80) — source pin for the calendar month anchor on both
// `/team/time-entries` and `/time-entries`.
//
// Why a source pin and not a mounted-component test: `apps/web/vitest.config.ts` has no `$app`
// alias, so these ~3000-line route pages cannot be mounted (see `monthly-hours-calendar-433.test.ts`
// and `admin-system-save-wiring.test.ts` for the established precedent of reading route source
// with `readFileSync`). The behaviour of the helper itself is covered by
// `lib/breaks/__tests__/deep-link.test.ts`; this file only pins the SHAPE of both pages so that
// a `?date=` deep link can never again anchor the calendar on the linked DAY.
//
// Measured symptom this guards against: with `?date=2026-09-29` the grid had 7 cells and the
// summed Soll was 16 h instead of 136 h, because `buildCalendarDays` treats its first argument as
// the 1st of the month.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

// fileURLToPath decodes the %28/%29 that the "(app)" route group produces in import.meta.url.
function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGES: Array<{ name: string; source: string }> = [
  {
    name: "/team/time-entries",
    source: readRouteFile(
      "../routes/(app)/team/time-entries/+page.svelte",
      "src/routes/(app)/team/time-entries/+page.svelte",
    ),
  },
  {
    name: "/time-entries",
    source: readRouteFile(
      "../routes/(app)/time-entries/+page.svelte",
      "src/routes/(app)/time-entries/+page.svelte",
    ),
  },
];

// Strips /* */ blocks and // line comments (not preceded by ":" so URLs survive) and collapses
// whitespace, so the matchers below see code only.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ");
}

// Every assignment to `calMonth` (declaration and plain re-assignment, never == / ===), returned
// as its right-hand side with a `$state(...)` wrapper unwrapped.
function calMonthAssignments(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  const re = /\bcalMonth\s*=(?![=>])\s*([^;]*);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    let rhs = m[1].trim();
    const wrapped = /^\$state\((.*)\)$/.exec(rhs);
    if (wrapped) rhs = wrapped[1].trim();
    out.push(rhs);
  }
  return out;
}

const NAV_CALL = /(?:addMonths|subMonths)\(calMonth, ?\d+\)/g;

function isAnchored(rhs: string): boolean {
  if (/^monthAnchorFromDay\(\w+\)$/.test(rhs)) return true;
  if (/^new Date\(.+, ?1\)$/.test(rhs) && !rhs.includes("T12:00:00")) return true;
  if (/^startOfMonth\(.*\)$/.test(rhs)) return true;
  // addMonths/subMonths of calMonth itself, optionally selected by `<ident> === <n> ? a : b`.
  if (NAV_CALL.test(rhs)) {
    NAV_CALL.lastIndex = 0;
    const rest = rhs.replace(NAV_CALL, "").replace(/\s+/g, " ").trim();
    return rest === "" || /^[\w.]+ === -?\d+ \? :$/.test(rest);
  }
  NAV_CALL.lastIndex = 0;
  return false;
}

describe("calMonth is always anchored on the 1st of a month (quick 261009-bsb, Issue #80)", () => {
  for (const { name, source } of PAGES) {
    describe(name, () => {
      it("imports monthAnchorFromDay from the deep-link module", () => {
        expect(source).toMatch(
          /import\s*\{[^}]*\bmonthAnchorFromDay\b[^}]*\}\s*from\s*"\$lib\/breaks\/deep-link"/,
        );
      });

      it("finds the calMonth assignments (anti-vacuity) and exactly one comes from the deep link", () => {
        const rhs = calMonthAssignments(source);
        expect(rhs.length).toBeGreaterThanOrEqual(5);
        expect(rhs.filter((r) => r.startsWith("monthAnchorFromDay("))).toHaveLength(1);
      });

      it("every calMonth right-hand side is anchored on the 1st", () => {
        for (const rhs of calMonthAssignments(source)) {
          expect(isAnchored(rhs), `${name}: calMonth = ${rhs}`).toBe(true);
        }
      });

      it("no calMonth right-hand side builds a Date from a day string at noon", () => {
        for (const rhs of calMonthAssignments(source)) {
          expect(rhs, `${name}: calMonth = ${rhs}`).not.toContain("T12:00:00");
        }
      });
    });
  }
});
