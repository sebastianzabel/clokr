// Issue #438 — the non-SHIFT_BASED month card ("Soll (bisher)" / Ist / Monat-Saldo / "N
// Arbeitstage bisher") and the FLEXTIME "Woche ± h" note on /time-entries and /team/time-entries
// have no server-side aggregate route (SHIFT_BASED reads GET /overtime/month-saldo instead), so
// both pages compute them client-side in `$derived` blocks that mirror the server's "live saldo
// cutoff" rule.
//
// Both pages used to carry a `hasTodayEntries` flag that PROMOTED the cutoff from yesterday to
// today whenever a closed, valid WORK entry existed for today. That was a correct proxy for
// "today is over" before commit 446d4bb6 (Phase 76.19.1 / v1.8.1, "Unified Clock-Trigger
// Resolver") added the REOPEN branch: clocking out for a lunch break closes today's entry
// exactly like an end-of-day clock-out, and the later clock-in reopens it. Between those two
// taps, "a closed entry exists for today" was true while the day was not over — the live saldo
// then charged the full day's Soll against only the morning's Ist.
//
// The fix (D-01): the cutoff is always "yesterday", full stop — never promoted to "today",
// whether today has no entry, an open entry, or a closed-but-reopenable one. D-03 additionally
// suppresses the non-SHIFT_BASED Soll-delta badge on today's calendar cell for the same reason.
//
// This reads EXPLICIT file paths — it does not walk a tree — so it is `not-a-guard` for
// lint-guard-vacuity.ts and needs no input-non-empty proof. It still fails loudly if either file
// moves, because readFileSync throws. It is a STRUCTURAL guard: no mount seam exists for these
// route pages (src/routes/** is outside the web vitest coverage scope, and the pages are ~3,300
// and ~2,700 lines with onMount API calls), so this test scans the source text in explicitly
// bounded regions instead of mounting the component. The behavioral, fixed-fake-clock proof of
// the same rule lives in `apps/api/src/__tests__/live-saldo-today-cutoff-438.test.ts` (plan
// 438-01).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WEB_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Both calendar pages must carry the identical cutoff and badge guard so they cannot drift
// (planner finding F-2; mirrors the #291 no-drift rule already pinned by
// gesamtsaldo-column-label.test.ts in this same directory).
const PAGES = [
  path.join(WEB_SRC, "routes/(app)/time-entries/+page.svelte"),
  path.join(WEB_SRC, "routes/(app)/team/time-entries/+page.svelte"),
] as const;

/**
 * Extracts the source text between two markers, failing loudly rather than silently returning
 * an empty region. A missing or duplicated marker must turn the calling test red, never shrink
 * the region to "" and let an `expect(region).not.toContain(...)` pass vacuously.
 */
function region(source: string, start: string, end: string): string {
  const startIdx = source.indexOf(start);
  expect(startIdx, `start marker ${JSON.stringify(start)} not found`).not.toBe(-1);
  expect(source.indexOf(start), `start marker ${JSON.stringify(start)} occurs more than once`).toBe(
    source.lastIndexOf(start),
  );

  const endIdx = source.indexOf(end, startIdx + start.length);
  expect(endIdx, `end marker ${JSON.stringify(end)} not found after start marker`).not.toBe(-1);

  return source.slice(startIdx, endIdx);
}

describe("live saldo cutoff — today never promotes the client-side to-date window (issue #438)", () => {
  it.each(PAGES)("%s no longer carries the today-promotion flag", (page) => {
    const source = readFileSync(page, "utf-8");
    // G1: the removed flag's identifier must be entirely gone — no leftover reference, no
    // leftover comment mentioning it.
    expect(source).not.toContain("hasTodayEntries");
  });

  it.each(PAGES)("%s — entriesToDate stops at yesterday, never promoted to today", (page) => {
    const source = readFileSync(page, "utf-8");
    const r = region(source, "let entriesToDate = $derived(", "let totalWorked = $derived(");
    // G2: the filter must still exclude today's/future rows and must NOT short-circuit to
    // "include everything" when a (closed) entry exists for today.
    expect(r).toContain("return d < todayStr;");
    expect(r).not.toContain("return true;");
  });

  it.each(PAGES)("%s — totalExpected stops at yesterday, never promoted to today", (page) => {
    const source = readFileSync(page, "utf-8");
    const r = region(
      source,
      "let totalExpected = $derived(",
      ".reduce((s, d) => s + d.expectedMin, 0)",
    );
    // G3: same rule for the expected-minutes side of the month card.
    expect(r).toContain("return !d.isToday;");
    expect(r).not.toContain("return true;");
  });

  it.each(PAGES)("%s — today's calendar cell never shows the Soll-delta badge", (page) => {
    const source = readFileSync(page, "utf-8");
    // G4: the non-SHIFT_BASED day-cell badge branch must carry the `!day.isToday` guard (D-03);
    // the old, unguarded branch must be entirely gone (not just shadowed by the new one).
    expect(source).toContain("{:else if day.expectedMin > 0 && !isNoDailyTarget && !day.isToday}");
    expect(source).not.toContain("{:else if day.expectedMin > 0 && !isNoDailyTarget}");
  });

  it("/time-entries — the FLEXTIME week note (Woche ± h) stops at yesterday (planner finding F-3)", () => {
    const page = path.join(WEB_SRC, "routes/(app)/time-entries/+page.svelte");
    const source = readFileSync(page, "utf-8");
    const r = region(source, "let weekWorkedMin = $derived.by(", "let isShiftBased = $derived(");
    // G5: weekWorkedMin (closed entries only) and weekExpectedMin (expected minutes) must both
    // cut off before today — before this fix weekExpectedMin counted today's full Soll via
    // `!d.isFuture`, which includes today, while weekWorkedMin only ever counted CLOSED entries.
    // That asymmetry is the literal #438 symptom for FLEXTIME on the widget's week note.
    expect(r).toContain("&& d < todayStr;");
    expect(r).toContain("&& d.dateStr < todayStr)");
    expect(r).not.toContain("!d.isFuture");
  });
});
