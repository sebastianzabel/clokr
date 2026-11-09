// Issue #843, AC-5 (D-843-09, plan 843-32): the completeness register of the all-routes overflow
// test. apps/e2e/tests/all-routes-overflow-843.spec.ts visits every route of
// apps/e2e/fixtures/route-register-843.json at 360/390/1024/1440 px; this test makes sure the
// register cannot drift from the route tree: every +page.svelte has exactly one entry, no entry
// names a page that is gone, a skip carries a real reason, the operator console is never skipped,
// and a path fills exactly the placeholders of its fill. A walker that finds nothing proves
// nothing, so the route walk has a floor and the checker is shown to fail (controls below).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { E2E_ROOT, SRC_ROOT, walkFiles } from "./design-source-files";

interface RouteEntry {
  page: string;
  path: string;
  auth: string;
  fill?: string;
  anchor?: string;
  sessionStorage?: Record<string, string>;
  skip?: string;
}

interface Register {
  defaultAnchor: string;
  fills: Record<string, string[]>;
  routes: RouteEntry[];
}

const AUTH_KINDS = ["tenant-admin", "operator", "operator-anonymous", "none"];
const MIN_SKIP_REASON = 20;

function loadRegister(): Register {
  return JSON.parse(
    readFileSync(join(E2E_ROOT, "fixtures", "route-register-843.json"), "utf8"),
  ) as Register;
}

function pageFiles(): string[] {
  return walkFiles(join(SRC_ROOT, "routes"), [".svelte"], { includeTests: false })
    .map((f) => f.rel)
    .filter((rel) => rel === "+page.svelte" || rel.endsWith("/+page.svelte"));
}

/** The URL segments a page file serves: route groups vanish, `[param]` becomes a wildcard. */
function urlSegments(page: string): string[] {
  const dir = page.split("/").slice(0, -1);
  return dir
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
    .map((s) => (s.startsWith("[") && s.endsWith("]") ? ":" : s));
}

/** Every problem of `register` against the page files; empty when the register is sound. */
export function registerProblems(files: string[], register: Register): string[] {
  const problems: string[] = [];
  const byPage = new Map<string, RouteEntry[]>();
  for (const entry of register.routes) {
    byPage.set(entry.page, [...(byPage.get(entry.page) ?? []), entry]);
  }
  for (const file of files) {
    const n = byPage.get(file)?.length ?? 0;
    if (n === 0) problems.push(`${file}: no register entry`);
    if (n > 1) problems.push(`${file}: ${n} register entries`);
  }
  const known = new Set(files);
  for (const entry of register.routes) {
    if (!known.has(entry.page)) problems.push(`${entry.page}: entry without a page file`);
    if (!AUTH_KINDS.includes(entry.auth))
      problems.push(`${entry.page}: unknown auth ${entry.auth}`);
    if (!entry.path.startsWith("/")) problems.push(`${entry.page}: path must start with /`);
    if (entry.skip !== undefined) {
      if (entry.skip.trim().length < MIN_SKIP_REASON) {
        problems.push(`${entry.page}: skip reason shorter than ${MIN_SKIP_REASON} characters`);
      }
      if (entry.page.startsWith("(operator)")) {
        problems.push(`${entry.page}: operator routes are measured through the operator mock`);
      }
      continue;
    }
    // A measured entry: placeholders match its fill, the path matches the page file's URL.
    const pathOnly = entry.path.split("?")[0];
    const placeholders = pathOnly.split("/").filter((s) => s.startsWith(":"));
    const expected = entry.fill === undefined ? [] : (register.fills[entry.fill] ?? null);
    if (expected === null) {
      problems.push(`${entry.page}: unknown fill ${entry.fill}`);
    } else if (
      [...placeholders].sort().join(",") !== [...expected].sort().join(",") ||
      new Set(placeholders).size !== placeholders.length
    ) {
      problems.push(
        `${entry.page}: path placeholders [${placeholders.join(", ")}] do not match the fill [${expected.join(", ")}]`,
      );
    }
    const want = urlSegments(entry.page);
    const have = pathOnly.split("/").filter(Boolean);
    const sameUrl =
      want.length === have.length &&
      want.every((seg, i) => (seg === ":" ? have[i].startsWith(":") : seg === have[i]));
    if (!sameUrl) problems.push(`${entry.page}: path ${entry.path} is not the URL of the page`);
    if (entry.anchor !== undefined && entry.anchor.trim() === "") {
      problems.push(`${entry.page}: empty anchor`);
    }
  }
  return problems;
}

describe("route register for the all-routes overflow test (#843, D-843-09)", () => {
  const files = pageFiles();
  const register = loadRegister();

  it("walks a real route tree (anti-vacuity floor)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("(app)/dashboard/+page.svelte");
    expect(files).toContain("(operator)/betreiber/anmelden/+page.svelte");
    expect(register.routes.length).toBeGreaterThan(50);
  });

  it("has exactly one sound entry per page file", () => {
    expect(registerProblems(files, register)).toEqual([]);
  });

  it("measures at least 45 routes and every operator console route", () => {
    const measured = register.routes.filter((e) => e.skip === undefined);
    expect(measured.length).toBeGreaterThanOrEqual(45);
    const operator = register.routes.filter((e) => e.page.startsWith("(operator)"));
    expect(operator.length).toBe(7);
    expect(operator.every((e) => e.skip === undefined)).toBe(true);
  });

  it("every skip names its blocker and where the route is covered instead", () => {
    const skipped = register.routes.filter((e) => e.skip !== undefined);
    expect(skipped.length).toBeGreaterThan(0);
    for (const entry of skipped) {
      expect(entry.skip, entry.page).toMatch(/measured|covered|redirect/i);
    }
  });

  describe("the checker can fail (controls)", () => {
    const base = (): Register => structuredClone(register);

    it("reports a page file without an entry", () => {
      const broken = base();
      broken.routes = broken.routes.filter((e) => e.page !== "(app)/dashboard/+page.svelte");
      expect(registerProblems(files, broken)).toContain(
        "(app)/dashboard/+page.svelte: no register entry",
      );
    });

    it("reports an entry without a page file", () => {
      const broken = base();
      broken.routes.push({ page: "(app)/gone/+page.svelte", path: "/gone", auth: "none" });
      expect(registerProblems(files, broken)).toContain(
        "(app)/gone/+page.svelte: entry without a page file",
      );
    });

    it("reports a skip without a reason", () => {
      const broken = base();
      const entry = broken.routes.find((e) => e.page === "(app)/dashboard/+page.svelte");
      if (!entry) throw new Error("dashboard entry missing");
      entry.skip = "todo";
      expect(registerProblems(files, broken).some((p) => p.includes("skip reason shorter"))).toBe(
        true,
      );
    });

    it("reports a skipped operator route", () => {
      const broken = base();
      const entry = broken.routes.find((e) => e.page.startsWith("(operator)"));
      if (!entry) throw new Error("operator entry missing");
      entry.skip = "x".repeat(MIN_SKIP_REASON);
      expect(registerProblems(files, broken).some((p) => p.includes("operator routes"))).toBe(true);
    });

    it("reports a placeholder that no fill supplies and a wrong URL", () => {
      const broken = base();
      const entry = broken.routes.find((e) => e.fill === "salon");
      if (!entry) throw new Error("salon entry missing");
      entry.path = "/admin/salons/:employeeId";
      expect(registerProblems(files, broken).some((p) => p.includes("do not match the fill"))).toBe(
        true,
      );
      entry.path = "/admin/other/:salonId";
      expect(registerProblems(files, broken).some((p) => p.includes("not the URL"))).toBe(true);
    });
  });
});
