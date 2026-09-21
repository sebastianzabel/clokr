// Issue #291 — the day column of the SHIFT_BASED entry table used to be headed "Gesamtsaldo"
// with the title "Kumulierter Gesamtsaldo bis zu diesem Tag (§615)". Its value is
// `carryOverIn + balanceMinutes(day 1..D of the displayed month)` (month-saldo.ts), and
// `carryOverIn` comes from the most recent CLOSED month's SaldoSnapshot — so months that were
// never closed are not in it. With three unclosed months the column showed +10:26 while the
// account's actual saldo was −70:12 (measured on a production tenant, 2026-09-21): two things
// called "Gesamtsaldo" on one screen, disagreeing by 80 hours.
//
// The column was renamed rather than re-valued — the value is right for what it is, only the
// promise its name made was wrong, and the true lifetime figure already has a home on the same
// screen (the "Konto / Gesamt-Saldo" card). See the PR for the full reasoning.
//
// This reads two EXPLICIT file paths — it does not walk a tree — so it is `not-a-guard` for
// lint-guard-vacuity.ts and needs no input proof. It still fails loudly if either file moves,
// because readFileSync throws.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WEB_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Both pages render the same column from the same `monthSaldoDayMap`. They must not drift.
const PAGES = [
  path.join(WEB_SRC, "routes/(app)/time-entries/+page.svelte"),
  path.join(WEB_SRC, "routes/(app)/team/time-entries/+page.svelte"),
] as const;

describe("SHIFT_BASED day column — name matches what the column actually contains (issue #291)", () => {
  it.each(PAGES)("%s no longer calls the column a Gesamtsaldo", (page) => {
    const source = readFileSync(page, "utf-8");
    expect(source).toContain("Saldo seit Abschluss");
    // The header text and its own tooltip are the two places the old, over-promising name
    // lived. "Gesamt-Saldo" (hyphenated) is the CARD's label and is a different string.
    expect(source).not.toContain(">Gesamtsaldo<");
    expect(source).not.toContain("Kumulierter Gesamtsaldo");
  });

  it.each(PAGES)("%s says in the tooltip which months are missing from it", (page) => {
    const source = readFileSync(page, "utf-8");
    expect(source).toContain("seit dem letzten Monatsabschluss");
    expect(source).toContain("Nicht abgeschlossene Vormonate sind darin nicht enthalten");
  });
});
