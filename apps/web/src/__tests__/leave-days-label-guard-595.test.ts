// Issue #595 (D-04), Plan 595-04 - source guard: the stored day count of a leave request is
// labelled by ONE helper (`leaveDaysLabel`), and the /leave KPI "Krankheitstage" comes from
// GET /leave/sick-days (calendar days), not from a sum the page derives itself. The pages are not
// mountable (no `$app` alias in `apps/web/vitest.config.ts`), so the pins read the sources.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function srcRoot(): string {
  try {
    return resolve(fileURLToPath(new URL("..", import.meta.url)));
  } catch {
    return resolve(process.cwd(), "src");
  }
}

const SRC_ROOT = srcRoot();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...walk(full));
    } else if (name.endsWith(".svelte") || name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(SRC_ROOT);

function source(relativePath: string): string {
  return readFileSync(join(SRC_ROOT, relativePath), "utf8");
}

describe("Issue #595 Plan 04 - one leaveDaysLabel", () => {
  it("walks a non-empty set of web sources (anti-vacuity)", () => {
    expect(FILES.length).toBeGreaterThan(0);
    expect(FILES.some((f) => f.endsWith("leave-days-label.ts"))).toBe(true);
  });

  it("no non-test source defines a private daysLabel function any more", () => {
    const offenders = FILES.filter((f) =>
      /\bfunction\s+daysLabel\s*\(/.test(readFileSync(f, "utf8")),
    )
      .map((f) => relative(SRC_ROOT, f))
      .sort((a, b) => a.localeCompare(b));
    expect(offenders).toEqual([]);
  });

  it("the five former call sites use the shared helper", () => {
    const sites = [
      "routes/(app)/leave/+page.svelte",
      "routes/(app)/team/leave/+page.svelte",
      "routes/(app)/inbox/+page.svelte",
      "lib/components/leave/LeaveReviewDialog.svelte",
      "lib/components/leave/LeaveRequestForm.svelte",
    ];
    for (const site of sites) {
      const text = source(site);
      expect(text, site).toContain('from "$lib/leave/leave-days-label"');
      expect(text, site).toContain("leaveDaysLabel(");
      expect(text, site).not.toMatch(/\bdaysLabel\(/);
    }
  });
});

describe("Issue #595 Plan 04 - the /leave KPI reads the kernel's figure", () => {
  const PAGE = source("routes/(app)/leave/+page.svelte");

  it("fetches GET /leave/sick-days for the viewed year and names the unit in calendar days", () => {
    expect(PAGE).toContain("/leave/sick-days?year=");
    expect(PAGE).toContain("calendarDaysUnit(");
  });

  it("derives no sick sum of its own from the stored request days", () => {
    expect(PAGE).not.toMatch(/let sickDaysYear = \$derived\(/);
    expect(PAGE).not.toMatch(/SICK_CODES\.includes\(r\.typeCode\)\s*&&\s*r\.status === "APPROVED"/);
  });
});
