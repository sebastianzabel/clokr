// Phase 258 (Issue #258), Task 2 — source-level pin: both avatar fetch call sites go
// through fetchAvatarObjectUrl() and neither keeps the raw `r.ok ? r.blob() : null`
// chain that mishandles 204 No Content (see apps/web/src/lib/api/avatar.ts).
//
// Why source reads, not mounts: there is no `$app` alias in apps/web/vitest.config.ts,
// and Topbar.svelte imports `$app/navigation`, so it is not mountable in this
// workspace; settings/+page.svelte is a route and routes are not mountable either —
// same reasoning layout-boundaries.test.ts gives for reading route source directly.

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

const TOPBAR = readRouteFile(
  "../lib/components/layout/Topbar.svelte",
  "src/lib/components/layout/Topbar.svelte",
);
const SETTINGS_PAGE = readRouteFile(
  "../routes/(app)/settings/+page.svelte",
  "src/routes/(app)/settings/+page.svelte",
);

describe("avatar fetch call sites use the shared helper", () => {
  describe.each([
    ["Topbar.svelte", TOPBAR],
    ["settings/+page.svelte", SETTINGS_PAGE],
  ])("%s", (_name, src) => {
    // Non-vacuity first: a moved or emptied file would make every `.not.toContain`
    // assertion below pass while checking nothing. Anchoring on content that must be
    // present makes the file's identity load-bearing before any negative assertion runs.
    it("was actually read (non-empty, contains a known anchor)", () => {
      expect(src.length).toBeGreaterThan(0);
      expect(src).toContain("$avatarVersion");
    });

    it("calls fetchAvatarObjectUrl(", () => {
      expect(src).toContain("fetchAvatarObjectUrl(");
    });

    it('imports it from "$api/avatar"', () => {
      expect(src).toContain('from "$api/avatar"');
    });

    it("does not keep the raw r.ok ? r.blob() : null chain", () => {
      expect(src).not.toContain("r.ok ? r.blob() : null");
    });

    it("never calls URL.createObjectURL directly (only the helper does)", () => {
      expect(src).not.toContain("URL.createObjectURL(");
    });
  });
});
