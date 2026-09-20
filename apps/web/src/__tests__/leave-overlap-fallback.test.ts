// Phase 262 (GitHub issue #262), Plan 03 — the three /leave/overlap consumers, pinned at source.
//
// Why source-read and not mounted: apps/web/vitest.config.ts registers no `$app/*` alias, and all
// three pages import `$app/stores` or `$app/navigation`, so none of them can be mounted here —
// the same wall team-leave-type-visibility.test.ts (Phase 257) documents.
//
// `lint:ui-classes` does not scan `routes/**`. This file is the only automated net for these three
// call sites. It pins that each page reads `NEUTRAL_CHIP_LABEL` from the shared module (D-13)
// instead of retyping the word, that the fallback branches on the NULL-ness of `typeName` and
// never on the string itself (D-12, CLAUDE.md § Context Boundaries — "Never use a new display
// string as a control value"), and that no fourth stray literal of the word slips in unnoticed.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { NEUTRAL_CHIP_LABEL } from "$lib/leave/team-calendar-visibility";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const LEAVE_PAGE = readRouteFile(
  "../routes/(app)/leave/+page.svelte",
  "src/routes/(app)/leave/+page.svelte",
);
const INBOX_PAGE = readRouteFile(
  "../routes/(app)/inbox/+page.svelte",
  "src/routes/(app)/inbox/+page.svelte",
);
const TEAM_LEAVE_PAGE = readRouteFile(
  "../routes/(app)/team/leave/+page.svelte",
  "src/routes/(app)/team/leave/+page.svelte",
);
// Phase 255 (GitHub issue #255), Plan 03 — /team/leave's review dialog, including its overlap
// panel, moved into this shared component; the two positive assertions that used to live in the
// "team/leave" describe group below now live in the "LeaveReviewDialog.svelte" group instead.
const COMPONENT = readRouteFile(
  "../lib/components/leave/LeaveReviewDialog.svelte",
  "src/lib/components/leave/LeaveReviewDialog.svelte",
);
// The shared data shapes both /team/leave and /inbox rely on for the review dialog. The
// `interface OverlapEntry` assertion that used to run against team/leave's own (now-deleted)
// copy targets `LeaveOverlapEntry` here instead — its single, stable home (Phase 255).
const CONTRACT = readRouteFile("../lib/leave/leave-review.ts", "src/lib/leave/leave-review.ts");

/** Occurrences of the bare word "abwesend" in the raw source. `NEUTRAL_CHIP_LABEL` as an
 *  identifier does not itself contain the substring, so this counts literal German text only. */
function abwesendCount(src: string): number {
  return (src.match(/abwesend/g) ?? []).length;
}

describe("leave/+page.svelte — request form's overlap panel (D-10)", () => {
  it("Test 0: the page source actually loaded", () => {
    expect(LEAVE_PAGE.length).toBeGreaterThan(100_000); // ~107 KB as of Phase 262 Plan 03
    expect(LEAVE_PAGE).toContain("overlap-title");
    expect(LEAVE_PAGE).toContain("Kolleg:innen im gleichen Zeitraum");
  });

  it("imports NEUTRAL_CHIP_LABEL from the shared module (D-13)", () => {
    expect(LEAVE_PAGE).toContain('from "$lib/leave/team-calendar-visibility"');
    expect(LEAVE_PAGE).toContain("NEUTRAL_CHIP_LABEL");
  });

  it("the overlap row falls back on the null-ness of typeName, not on the string (D-12)", () => {
    expect(LEAVE_PAGE).toContain("{o.typeName ?? NEUTRAL_CHIP_LABEL}");
  });

  it("OverlapEntry declares typeName and typeCode as nullable", () => {
    const start = LEAVE_PAGE.indexOf("interface OverlapEntry");
    const end = LEAVE_PAGE.indexOf("}", start);
    const iface = LEAVE_PAGE.slice(start, end);
    expect(iface).toContain("typeName: string | null");
    expect(iface).toContain("typeCode: string | null");
  });

  it('"abwesend" survives exactly twice: the empty-state sentence and the out-of-scope calendar chip', () => {
    // 1. ":1628" (line numbers pre-edit) "Niemand sonst abwesend ✓" — explicitly kept verbatim,
    //    see <scope_boundary>, not a chip label.
    // 2. ":1919" "cal-chip-type" — the personal calendar chip fed by GET /leave/calendar's own
    //    isOwn branch, deliberately out of scope for this plan (262-CONTEXT.md D-11b note).
    // A third occurrence would mean a fourth hand-typed literal slipped back into the overlap
    // panel this plan just fixed.
    expect(abwesendCount(LEAVE_PAGE)).toBe(2);
  });
});

describe("inbox/+page.svelte — review dialog's overlap chip (D-11)", () => {
  it("Test 0: the page source actually loaded", () => {
    expect(INBOX_PAGE.length).toBeGreaterThan(30_000); // ~38 KB as of Phase 262 Plan 03
    expect(INBOX_PAGE).toContain("overlap-title");
    expect(INBOX_PAGE).toContain("Kolleg:innen im gleichen Zeitraum");
  });

  it("imports NEUTRAL_CHIP_LABEL from the shared module (D-13)", () => {
    expect(INBOX_PAGE).toContain('from "$lib/leave/team-calendar-visibility"');
    expect(INBOX_PAGE).toContain("NEUTRAL_CHIP_LABEL");
  });

  it("the chip falls back on the null-ness of typeName, not on the string (D-12)", () => {
    expect(INBOX_PAGE).toContain("{o.typeName ?? NEUTRAL_CHIP_LABEL}");
  });

  it("OverlapEntry declares typeName and typeCode as nullable", () => {
    const start = INBOX_PAGE.indexOf("interface OverlapEntry");
    const end = INBOX_PAGE.indexOf("}", start);
    const iface = INBOX_PAGE.slice(start, end);
    expect(iface).toContain("typeName: string | null");
    expect(iface).toContain("typeCode: string | null");
  });

  it('"abwesend" survives exactly once: the empty-state sentence', () => {
    // ":872" "Niemand sonst abwesend ✓" — kept verbatim, see <scope_boundary>. This page has no
    // second calendar-chip use of the word, unlike leave/+page.svelte.
    expect(abwesendCount(INBOX_PAGE)).toBe(1);
  });
});

describe("team/leave/+page.svelte — manager review modal's overlap panel (D-11b)", () => {
  it("Test 0: the page source actually loaded", () => {
    // Phase 255 Plan 03: the review dialog markup and mutation moved into
    // LeaveReviewDialog.svelte, shrinking the page from ~97 KB to ~83.5 KB. The floor sits at
    // least 10 KB below the measured value (85_460 bytes on 2026-09-20) so it does not become a
    // time bomb on ordinary future edits.
    expect(TEAM_LEAVE_PAGE.length).toBeGreaterThan(75_000); // ~83.5 KB as of Phase 255 Plan 03
  });

  it("delegates the review dialog to the shared component and keeps no stray literal", () => {
    // A bare `expect(abwesendCount(TEAM_LEAVE_PAGE)).toBe(0)` would also be true if the page
    // rendered nothing at all — pairing it with the positive assertion that the shared component
    // IS wired in closes that vacuity hole (CONTEXT.md D-12, same class as #203/#235 and the
    // Phase 96 discriminator-swap trap).
    expect(TEAM_LEAVE_PAGE).toContain("<LeaveReviewDialog");
    expect(abwesendCount(TEAM_LEAVE_PAGE)).toBe(0);
  });
});

describe("LeaveReviewDialog.svelte — the shared review dialog's overlap panel (Phase 255)", () => {
  it("Test 0: the component source actually loaded", () => {
    expect(COMPONENT.length).toBeGreaterThan(6_000); // ~18.6 KB as of Phase 255 Plan 03
    expect(COMPONENT).toContain("overlap-title");
    expect(COMPONENT).toContain("Kolleg:innen im gleichen Zeitraum");
  });

  it("imports NEUTRAL_CHIP_LABEL from the shared module (D-13)", () => {
    expect(COMPONENT).toContain('from "$lib/leave/team-calendar-visibility"');
    expect(COMPONENT).toContain("NEUTRAL_CHIP_LABEL");
  });

  it("the overlap row falls back on the null-ness of typeName, not on the string (D-12)", () => {
    expect(COMPONENT).toContain("{o.typeName ?? NEUTRAL_CHIP_LABEL}");
  });

  it("LeaveOverlapEntry declares typeName and typeCode as nullable", () => {
    // Phase 255: this assertion used to run against team/leave's own `interface OverlapEntry`,
    // deleted in Plan 03 Task 1. The shape now has one stable home in leave-review.ts.
    const start = CONTRACT.indexOf("interface LeaveOverlapEntry");
    const end = CONTRACT.indexOf("}", start);
    const iface = CONTRACT.slice(start, end);
    expect(iface).toContain("typeName: string | null");
    expect(iface).toContain("typeCode: string | null");
  });

  it('"abwesend" survives exactly once: the empty-state sentence', () => {
    expect(abwesendCount(COMPONENT)).toBe(1);
  });
});

describe("cross-cutting — the display string never becomes a control value (D-12)", () => {
  const PAGES: Array<[string, string]> = [
    ["leave/+page.svelte", LEAVE_PAGE],
    ["inbox/+page.svelte", INBOX_PAGE],
    ["team/leave/+page.svelte", TEAM_LEAVE_PAGE],
    // Phase 255: the overlap panel's markup lives here now — without this entry, the "never a
    // control value" direction would stop checking the file the code actually moved to.
    ["lib/components/leave/LeaveReviewDialog.svelte", COMPONENT],
  ];

  it.each(PAGES)('%s never compares against the string "abwesend"', (_name, src) => {
    expect(src).not.toContain('=== "abwesend"');
    expect(src).not.toContain('!== "abwesend"');
    expect(src).not.toContain('includes("abwesend")');
  });

  it("the fixture set is not empty (anti-vacuity, CLAUDE.md § Anti-vacuity gate)", () => {
    expect(PAGES.length).toBe(4);
  });
});

describe("the constant this test pins against", () => {
  it("NEUTRAL_CHIP_LABEL is the German word 'abwesend', unchanged by this plan (D-13)", () => {
    expect(NEUTRAL_CHIP_LABEL).toBe("abwesend");
  });
});
