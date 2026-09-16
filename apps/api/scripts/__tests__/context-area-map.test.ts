/**
 * Phase 113b — living-assertion completeness proof for context-area-map.ts.
 *
 * "Living assertion" (113B-CONTEXT.md D-13): these are not documentation of a claim, they are the
 * mechanism that turns an unmapped file, a stale RAHMEN_FILES entry, a rahmen-bucketed route or
 * plugin, and a widened coverage scope each into a red test. See the file's own header comment for
 * what the map is and where the assignment comes from.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_AREAS,
  CONTEXT_AREA_BY_FILE,
  CONTEXT_AREA_BY_PREFIX,
  RAHMEN_FILES,
  UnmappedFileError,
  assignContextArea,
  coveredSourceFiles,
} from "../context-area-map";
import vitestConfig from "../../vitest.config";

const API_ROOT = join(__dirname, "..", "..");

describe("context-area-map — fixed spot checks", () => {
  it("dashboard.ts and reports.ts are komposition (D-17, unconditional)", () => {
    expect(assignContextArea("src/composition/dashboard.ts")).toBe("komposition");
    expect(assignContextArea("src/composition/reports.ts")).toBe("komposition");
  });

  it("services/clock/** is zeiterfassung, services/phorest/** is schichtplanung (D-16)", () => {
    expect(assignContextArea("src/services/clock/resolver.ts")).toBe("zeiterfassung");
    expect(assignContextArea("src/services/phorest/sync-shifts.ts")).toBe("schichtplanung");
  });

  it("close-employee-month.ts is arbeitszeitkonto", () => {
    expect(assignContextArea("src/utils/close-employee-month.ts")).toBe("arbeitszeitkonto");
  });

  it("leave.ts is abwesenheiten", () => {
    expect(assignContextArea("src/contexts/abwesenheiten/api/leave.ts")).toBe("abwesenheiten");
  });

  it("time-entries.ts is zeiterfassung", () => {
    expect(assignContextArea("src/contexts/zeiterfassung/api/time-entries.ts")).toBe(
      "zeiterfassung",
    );
  });

  it("app.ts is rahmen and appears in RAHMEN_FILES", () => {
    expect(assignContextArea("src/app.ts")).toBe("rahmen");
    expect(RAHMEN_FILES).toContain("src/app.ts");
  });

  it("throws UnmappedFileError for an unknown path, naming the path and the fix", () => {
    let caught: unknown;
    try {
      assignContextArea("src/routes/does-not-exist.ts");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnmappedFileError);
    const message = (caught as Error).message;
    expect(message).toContain("src/routes/does-not-exist.ts");
    expect(message).toContain("CONTEXT_AREA_BY_FILE");
  });
});

describe("context-area-map — structural invariants", () => {
  it("CONTEXT_AREAS lists exactly the seven buckets", () => {
    expect([...CONTEXT_AREAS].sort()).toEqual(
      [
        "unterbau",
        "zeiterfassung",
        "abwesenheiten",
        "schichtplanung",
        "arbeitszeitkonto",
        "rahmen",
        "komposition",
      ].sort(),
    );
  });

  it("CONTEXT_AREA_BY_PREFIX has exactly the two D-16 prefix rules, no others", () => {
    expect(CONTEXT_AREA_BY_PREFIX).toEqual([
      { prefix: "src/services/clock/", area: "zeiterfassung" },
      { prefix: "src/services/phorest/", area: "schichtplanung" },
    ]);
  });

  it("every RAHMEN_FILES entry exists on disk (a stale allowlist entry goes red)", () => {
    for (const relPath of RAHMEN_FILES) {
      expect(existsSync(join(API_ROOT, relPath)), `${relPath} does not exist on disk`).toBe(true);
    }
  });

  it("every RAHMEN_FILES entry is also mapped to rahmen in CONTEXT_AREA_BY_FILE", () => {
    for (const relPath of RAHMEN_FILES) {
      expect(CONTEXT_AREA_BY_FILE[relPath]).toBe("rahmen");
    }
  });

  it("no path under src/routes/ or src/plugins/ maps to rahmen (#99: keine Restkategorie)", () => {
    const offenders = Object.entries(CONTEXT_AREA_BY_FILE)
      .filter(([, area]) => area === "rahmen")
      .filter(([path]) => path.startsWith("src/routes/") || path.startsWith("src/plugins/"))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("only real bucket names are used as values", () => {
    for (const area of Object.values(CONTEXT_AREA_BY_FILE)) {
      expect(CONTEXT_AREAS).toContain(area);
    }
    for (const { area } of CONTEXT_AREA_BY_PREFIX) {
      expect(CONTEXT_AREAS).toContain(area);
    }
  });
});

describe("context-area-map — exhaustiveness over the real, measured file set", () => {
  // The coverage scope is READ from vitest.config.ts, never restated — if a future change widens
  // or narrows coverage.include/exclude, THIS assertion fails first, before the exhaustiveness
  // walk below can silently drift out of sync with what coverage actually measures.
  it("vitest.config.ts's coverage.include/exclude are unchanged from what this map assumes", () => {
    const coverage = (vitestConfig as unknown as { test: { coverage: unknown } }).test.coverage as {
      include: string[];
      exclude: string[];
    };
    expect(coverage.include).toEqual(["src/**/*.ts"]);
    expect(coverage.exclude).toEqual(["**/*.test.ts", "**/index.ts"]);
  });

  it("every file coveredSourceFiles() walks is assignable — no unmapped file", () => {
    const files = coveredSourceFiles(API_ROOT);
    const unmapped: string[] = [];
    for (const relPath of files) {
      try {
        assignContextArea(relPath);
      } catch {
        unmapped.push(relPath);
      }
    }
    expect(unmapped, `unmapped files:\n${unmapped.join("\n")}`).toEqual([]);
  });

  it("coveredSourceFiles() finds every file CONTEXT_AREA_BY_FILE's explicit keys claim to cover", () => {
    // Sanity check in the other direction: an explicit entry for a file that no longer exists (or
    // that the walk no longer reaches, e.g. because it became a .test.ts) is exactly the kind of
    // stale mapping D-05 warns about.
    const files = new Set(coveredSourceFiles(API_ROOT));
    const staleEntries = Object.keys(CONTEXT_AREA_BY_FILE).filter((relPath) => !files.has(relPath));
    expect(staleEntries, `stale CONTEXT_AREA_BY_FILE entries:\n${staleEntries.join("\n")}`).toEqual(
      [],
    );
  });

  it("coveredSourceFiles() reproduces the measured 124-file set (sanity check, not a hardcoded expectation source)", () => {
    // Cross-checks against the shell command the plan's <action> step names
    // (`find src -name '*.ts' ! -name '*.test.ts' ! -name 'index.ts' | wc -l`), independent of
    // this file's own walk implementation.
    const files: string[] = [];
    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === "node_modules") continue;
          walk(full);
          continue;
        }
        if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && entry !== "index.ts") {
          files.push(full);
        }
      }
    }
    walk(join(API_ROOT, "src"));
    expect(coveredSourceFiles(API_ROOT).length).toBe(files.length);
  });
});
