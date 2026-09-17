/**
 * D-05 (Phase 243) — characterization test proving the registered route surface survives every
 * file move the phase makes. There is no other route-table snapshot in the repo; this test
 * builds the instrument and freezes it against the pre-move tree, so every later wave is
 * measured against what was registered before any file moved.
 *
 * Regenerating `apps/api/baselines/route-surface.txt` to make a wave green is FORBIDDEN, on the
 * same terms as `apps/api/baselines/saldo-path-parity-baseline.json` (see that file's own
 * README.md "Rules for this file"): if the surface differs, the diff IS the finding, not a
 * baseline to update.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getTestApp, closeTestApp } from "./setup";
import type { FastifyInstance, HTTPMethods } from "fastify";

const BASELINE_PATH = join(__dirname, "../../baselines/route-surface.txt");

// D-01: the eleven routes this phase touches, by method and path — the "specificity" leg of the
// proof. Immune to any printRoutes formatting change, unlike the completeness leg below.
const PHASE_ROUTES: { method: HTTPMethods; url: string }[] = [
  { method: "GET", url: "/api/v1/activity" },
  { method: "GET", url: "/api/v1/settings/vacation/:employeeId" },
  { method: "PUT", url: "/api/v1/settings/vacation/:employeeId" },
  { method: "GET", url: "/api/v1/settings/leave-types" },
  { method: "PUT", url: "/api/v1/settings/leave-types/:id" },
  { method: "GET", url: "/api/v1/employees/me/wifi" },
  { method: "PATCH", url: "/api/v1/employees/me/wifi" },
  { method: "POST", url: "/api/v1/employees/me/wifi/devices" },
  { method: "DELETE", url: "/api/v1/employees/me/wifi/devices/:id" },
  { method: "GET", url: "/api/v1/me/availability" },
  { method: "PUT", url: "/api/v1/me/availability" },
];

// Trim, drop empty lines, sort ascending — removes any dependence on plugin registration order,
// which waves 2 and 3 of this phase change.
function normalizeRouteSurface(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort()
    .join("\n");
}

describe("route surface (D-05)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it("the registered route surface matches the frozen baseline", () => {
    const current = normalizeRouteSurface(app.printRoutes({ commonPrefix: false }));

    // Escape hatch used exactly once, to generate the baseline from the pre-move tree — never
    // used again afterward. See this file's header comment.
    if (process.env.UPDATE_ROUTE_SURFACE === "1") {
      writeFileSync(BASELINE_PATH, current + "\n", "utf-8");
      return;
    }

    const frozen = normalizeRouteSurface(readFileSync(BASELINE_PATH, "utf-8"));
    expect(current).toBe(frozen);
  });

  it("every route this phase moves is still registered, by method and path", () => {
    for (const { method, url } of PHASE_ROUTES) {
      expect(app.hasRoute({ method, url }), `${method} ${url} is gone`).toBe(true);
    }
  });

  it("the baseline is not empty and covers the whole app", () => {
    const frozen = readFileSync(BASELINE_PATH, "utf-8");
    const lineCount = frozen.split("\n").filter((line) => line.trim().length > 0).length;
    expect(lineCount).toBeGreaterThan(100);
    expect(frozen).toContain("/api/v1/activity");
  });
});
