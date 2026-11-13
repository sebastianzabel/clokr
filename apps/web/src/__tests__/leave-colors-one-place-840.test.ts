// Issue #840 (D-840-12, AC-7), threat T-840-22 — a leave-type colour has ONE source. Only
// `$lib/leave/leave-colors.ts` names the `--leave-type-*` tokens; `tokens.css` declares them and
// `app.css` holds the `.cal-abs-*` recipes of the Zeiterfassung cells (CSS cannot import a module,
// the one named exception). Every other web source asks `leaveTypeColor()`, so Urlaub cannot be
// green on one page and another colour on the next again.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function srcRoot(): string {
  try {
    return resolve(fileURLToPath(new URL("..", import.meta.url)));
  } catch {
    // jsdom gives `import.meta.url` a non-file scheme; vitest runs from the package directory.
    return resolve(process.cwd(), "src");
  }
}

const SRC_ROOT = srcRoot();
const EXTENSIONS = [".svelte", ".ts", ".css"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...walk(full));
    } else if (EXTENSIONS.some((ext) => name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(SRC_ROOT);
const relPath = (file: string) => relative(SRC_ROOT, file).split("\\").join("/");

/** Where the token name may appear: the declaration, the one mapping, the cell recipes. */
const ALLOWED = ["tokens.css", "lib/leave/leave-colors.ts", "app.css"];

describe("Issue #840 AC-7 - one leave-colour source", () => {
  it("walks a real source tree (anti-vacuity)", () => {
    expect(FILES.length).toBeGreaterThan(50);
    const paths = FILES.map(relPath);
    expect(paths).toContain("lib/leave/leave-colors.ts");
    for (const allowed of ALLOWED) expect(paths, allowed).toContain(allowed);
    // No test directory leaked into the walked set.
    expect(paths.some((p) => p.includes("__tests__"))).toBe(false);
  });

  it("the matcher sees the allowed files (positive control)", () => {
    for (const allowed of ALLOWED) {
      const text = readFileSync(join(SRC_ROOT, allowed), "utf8");
      expect(text, allowed).toContain("--leave-type-");
    }
  });

  it("no other web source names a --leave-type-* token", () => {
    const offenders = FILES.filter((file) => !ALLOWED.includes(relPath(file)))
      .filter((file) => readFileSync(file, "utf8").includes("--leave-type-"))
      .map(relPath)
      .sort((a, b) => a.localeCompare(b));
    expect(offenders).toEqual([]);
  });

  it("the Zeiterfassung pages and the planner timeline read the mapping", () => {
    const readers = [
      "routes/(app)/time-entries/+page.svelte",
      "routes/(app)/team/time-entries/+page.svelte",
      // #840 (D-840-07, AC-6): the planner draws on the one timeline; LeavePlanTimeline is gone.
      "lib/components/leave/timeline/AbsenceTimeline.svelte",
      "lib/components/leave/LeaveLegend.svelte",
      "lib/components/reports/VacationAbsenceTab.svelte",
      "lib/leave/team-calendar-visibility.ts",
      "lib/utils/chart-theme.ts",
    ];
    for (const reader of readers) {
      const text = readFileSync(join(SRC_ROOT, reader), "utf8");
      expect(text, reader).toMatch(/from "[^"]*leave-colors"/);
    }
  });
});
