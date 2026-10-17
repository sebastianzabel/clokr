// Issue #587 (D-587-4, AC-587-3, P-07) — source pin of the team-week cell links.
//
// Why source-read and not mounted: the dashboard imports `$app/*` and fires roughly twenty API
// calls in `onMount` (same wall as dashboard-team-salon-filter-84.test.ts documents). The href
// builders are unit-tested in `lib/dashboard/__tests__/team-day-links.test.ts`; this file proves
// the page puts EVERY status branch of the cell inside the link and never renders a dead one.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const DASHBOARD = readRouteFile(
  "../routes/(app)/dashboard/+page.svelte",
  "src/routes/(app)/dashboard/+page.svelte",
);

const STATUSES = [
  "present",
  "clocked_in",
  "absent",
  "holiday",
  "missing",
  "scheduled",
  "requested",
] as const;

/** The `{#snippet teamCellContent(...)}` block, up to its closing `{/snippet}`. */
function cellSnippet(): string {
  const start = DASHBOARD.indexOf("{#snippet teamCellContent(");
  expect(start, "teamCellContent snippet not found").toBeGreaterThan(-1);
  const end = DASHBOARD.indexOf("{/snippet}", start);
  expect(end, "end of teamCellContent not found").toBeGreaterThan(start);
  return DASHBOARD.slice(start, end);
}

/** The `{#each member.days as day ...}` block of the grid body (the cell `<td>`). */
function memberDaysBlock(): string {
  const start = DASHBOARD.indexOf("{#each member.days as day");
  expect(start, "member.days loop not found").toBeGreaterThan(-1);
  const end = DASHBOARD.indexOf("</tbody>", start);
  expect(end, "end of the grid body not found").toBeGreaterThan(start);
  return DASHBOARD.slice(start, end);
}

describe("Issue #587 — every team-week cell is a link to person and day", () => {
  it("anchors are present (non-vacuous)", () => {
    expect(DASHBOARD).toContain("team-grid__cell");
    expect(DASHBOARD).toContain("teamDayHref(");
    expect(DASHBOARD).toContain("teamCellAriaLabel(");
  });

  it("the whole status chain lives in ONE snippet that holds every status branch and the else", () => {
    const snippet = cellSnippet();
    for (const status of STATUSES) {
      expect(snippet, `status ${status} must sit inside the snippet`).toContain(
        `day.status === "${status}"`,
      );
    }
    expect(snippet).toContain("{:else}");
    expect(snippet).toContain("cell-badge--none");
  });

  it("no status branch is repeated outside the snippet (one snippet used twice, not a copy)", () => {
    const outside = DASHBOARD.replace(cellSnippet(), "");
    for (const status of STATUSES) {
      expect(outside, `status ${status} must not be copied`).not.toContain(
        `day.status === "${status}"`,
      );
    }
  });

  it("the snippet is rendered inside the link and, unlinked, directly in the cell", () => {
    const block = memberDaysBlock();
    const linkStart = block.indexOf("<a");
    expect(linkStart, "the cell link is missing").toBeGreaterThan(-1);
    const link = block.slice(linkStart, block.indexOf("</a>", linkStart));
    expect(link).toContain("team-grid__link");
    // shorthand attribute `{href}`; its value is teamDayHref(member.id, day.date) (pinned below)
    expect(link).toContain("{href}");
    expect(link).toContain("aria-label={teamCellAriaLabel(");
    expect(link).toContain("{@render teamCellContent(day)}");
    // the unlinked branch renders the very same snippet
    const afterLink = block.slice(block.indexOf("</a>", linkStart));
    expect(afterLink).toContain("{@render teamCellContent(day)}");
  });

  it("the href comes from teamDayHref(member.id, day.date)", () => {
    expect(memberDaysBlock()).toContain("teamDayHref(member.id, day.date)");
  });

  it("the link is rendered only for callers who may open Team-Zeiten, a null href stays unlinked", () => {
    expect(DASHBOARD).toContain('mayOpenTeamPage("/team/time-entries"');
    const block = memberDaysBlock();
    expect(block).toMatch(
      /canOpenTeamDay\s*&&\s*href\s*!==\s*null|href\s*!==\s*null\s*&&\s*canOpenTeamDay/,
    );
  });

  it("the link has no hover style that changes layout and shows a ring on keyboard focus only", () => {
    expect(DASHBOARD).toMatch(/\.team-grid__link\s*\{[^}]*display:\s*block/);
    expect(DASHBOARD).toMatch(/\.team-grid__link:focus-visible\s*\{[^}]*outline/);
    expect(DASHBOARD).not.toMatch(/\.team-grid__link:hover/);
  });
});
