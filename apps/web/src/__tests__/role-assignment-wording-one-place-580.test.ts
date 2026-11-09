// Issue #580 (D-580-02) — the role-assignment wording has one home, lib/roles/assignment-label.ts.
// Every web file is walked (tests excluded); each label constant may occur only there, and the
// role-assignment surfaces must import it. Blind spot: a label assembled from parts is not seen —
// the guard stops copies, it does not prove absence.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  SCOPE_TENANT_LABEL,
  UNKNOWN_PERSON_LABEL,
  UNKNOWN_SALON_LABEL,
} from "$lib/roles/assignment-label";

function webSrcRoot(): string {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    if (existsSync(join(root, "app.html"))) return root;
  } catch {
    // fall through to the cwd-based root
  }
  return resolve(process.cwd(), "src");
}

const WEB_SRC = webSrcRoot();
const HOME = "lib/roles/assignment-label.ts";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : walk(path);
    return /\.(ts|svelte)$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

const FILES = walk(WEB_SRC).map((path) => ({
  rel: relative(WEB_SRC, path).split("\\").join("/"),
  source: readFileSync(path, "utf8"),
}));

/** The labels that may live only in the home module (plans 02/03 add more). */
const ONE_PLACE_LABELS = [SCOPE_TENANT_LABEL, UNKNOWN_SALON_LABEL, UNKNOWN_PERSON_LABEL];

/** Surfaces that show role assignments and must take the wording from the home module. */
const IMPORTERS = [
  "lib/components/admin/roles/AssignmentsTab.svelte",
  "lib/components/admin/roles/AssignmentDialog.svelte",
  "lib/components/admin/roles/PersonRoleAssignments.svelte",
];

describe("Issue #580 — the role-assignment wording lives in one place", () => {
  it("walks the web source (non-vacuity)", () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.some((f) => f.rel === HOME)).toBe(true);
  });

  for (const label of ONE_PLACE_LABELS) {
    it(`„${label}“ occurs only in ${HOME}`, () => {
      expect(FILES.filter((f) => f.source.includes(label)).map((f) => f.rel)).toEqual([HOME]);
    });
  }

  for (const rel of IMPORTERS) {
    it(`${rel} imports the wording`, () => {
      const file = FILES.find((f) => f.rel === rel);
      expect(file, `${rel} not found`).toBeDefined();
      expect(file?.source).toContain('from "$lib/roles/assignment-label"');
    });
  }
});
